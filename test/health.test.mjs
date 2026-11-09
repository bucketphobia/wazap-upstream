/**
 * What WhatsApp says about the account itself (src/service/health.ts): a close
 * that is a ban, a temporary ban, a session taken over or a client too old
 * stops the reconnect loop and every write with ACCOUNT_RESTRICTED; a
 * reachout timelock refuses a first message to someone never written to,
 * before it leaves, while existing chats go on; a send WhatsApp refuses with
 * 463 is kept and makes wazap ask about the timelock. get_status says all of
 * it under `health`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountHealth, classifyClose } from "../dist/service/health.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, fakeSocket } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const STRANGER = "40700000099@s.whatsapp.net";

/** The Boom error Baileys closes with. */
function closed(statusCode, data) {
  return { message: "Connection Failure", output: { statusCode }, ...(data === undefined ? {} : { data }) };
}

function serviceOn(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-health-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const connected = connectedService(WhatsAppService, {
    prefix: "wazap-health-",
    id: ME,
    name: "Ana",
    config: { dataDir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0 },
  });
  t.after(() => connected.svc.stop());
  connected.sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
  connected.sock.relayMessage = async (_jid, _message, options) => options.messageId;
  // A direct send answers the message as Baileys does, and the service stores it the moment it leaves.
  let sent = 0;
  connected.sock.sendMessage = async (jid, content) => ({
    key: { remoteJid: jid, fromMe: true, id: `OUT${++sent}` },
    message: { conversation: content.text },
    messageTimestamp: Math.floor(Date.now() / 1000),
  });
  return connected;
}

function close(sock, error) {
  sock.ev.emit("connection.update", { connection: "close", lastDisconnect: { error } });
}

async function refusalOf(work) {
  try {
    await work();
  } catch (err) {
    return err.code;
  }
  return "no refusal";
}

test("a close is read the way WhatsApp's own clients read it", () => {
  const now = 1_000_000;
  assert.deepEqual(classifyClose(closed(401), now), { kind: "logged_out" });
  assert.deepEqual(classifyClose(closed(402, { code: "101", expire: "3600" }), now), {
    kind: "temporarily_banned",
    until: now + 3_600_000,
    reason: "101",
    code: 402,
  });
  assert.deepEqual(
    classifyClose(closed(403, { reason: "403", logout_message_header: "You have been logged out for using an unofficial app." }), now),
    { kind: "banned", detail: "You have been logged out for using an unofficial app.", code: 403 }
  );
  assert.deepEqual(classifyClose(closed(406), now), { kind: "banned", detail: null, code: 406 });
  assert.deepEqual(classifyClose(closed(440, { tag: "conflict", attrs: { type: "replaced" } }), now), {
    kind: "session_replaced",
    detail: null,
    code: 440,
  });
  assert.equal(classifyClose(closed(405), now).kind, "client_outdated");
  assert.equal(classifyClose(closed(409), now).kind, "client_outdated");
  for (const code of [408, 411, 428, 500, 503, 515]) assert.equal(classifyClose(closed(code), now).kind, "transient", `${code}`);
  assert.equal(classifyClose(undefined, now).kind, "transient");
  // A proxy or firewall that refuses the WebSocket with the same status is not WhatsApp speaking.
  const refusedByProxy = { message: "WebSocket Error (Unexpected server response: 403)", output: { statusCode: 403 }, data: new Error("x") };
  assert.equal(classifyClose(refusedByProxy, now).kind, "transient");
  assert.equal(classifyClose({ message: "Stream Errored (conflict)", output: { statusCode: 440 }, data: { tag: "conflict", attrs: { type: "replaced" } } }, now).kind, "session_replaced");
});

test("a ban stops the reconnect loop and every write with ACCOUNT_RESTRICTED, in WhatsApp's words", async (t) => {
  const { svc, sock } = serviceOn(t);
  let gaveUp = false;
  svc.onGiveUp = () => (gaveUp = true);
  close(sock, closed(403, { logout_message_header: "You have been logged out for using an unofficial app." }));

  const status = svc.getStatus();
  assert.equal(status.status, "auth_failure");
  assert.equal(status.health.state, "banned");
  assert.equal(status.health.detail, "You have been logged out for using an unofficial app.");
  assert.match(status.hint, /banned or locked/);
  assert.equal(svc.reconnectTimer, null, "no reconnect is scheduled");
  assert.equal(gaveUp, false, "a restart cannot lift a ban, so the process is not asked to exit");
  assert.equal(await refusalOf(() => svc.sendMessage(PEER, "salut")), "ACCOUNT_RESTRICTED");
  const read = await svc.listChats("all", 10).catch((err) => err);
  assert.equal(read.code, "ACCOUNT_RESTRICTED", "reads say why too, not only NOT_CONNECTED");
  assert.doesNotMatch(read.message, /nothing was sent/, "a read sent nothing to begin with");
});

test("an undated temporary ban promises no retry it will not make", async (t) => {
  const { svc, sock } = serviceOn(t);
  close(sock, closed(402, { code: "101" }));
  assert.equal(svc.reconnectTimer, null);
  const refused = await svc.sendMessage(PEER, "salut").catch((err) => err);
  assert.equal(refused.code, "ACCOUNT_RESTRICTED");
  assert.match(refused.fix, /restart wazap once WhatsApp has lifted the ban/);
});

test("link_account does not throw away a session that comes back on its own", async (t) => {
  const { svc, sock } = serviceOn(t);
  close(sock, closed(402, { expire: "3600" }));
  assert.equal(await refusalOf(() => svc.link("+40700000001")), "ACCOUNT_RESTRICTED");
});

test("a session another client took over, and a client WhatsApp no longer takes, stop the loop too", async (t) => {
  for (const [error, state] of [
    [closed(440, { tag: "conflict", attrs: { type: "replaced" } }), "session_replaced"],
    [closed(405), "client_outdated"],
  ]) {
    const { svc, sock } = serviceOn(t);
    close(sock, error);
    assert.equal(svc.getStatus().health.state, state);
    assert.equal(svc.reconnectTimer, null);
    assert.equal(await refusalOf(() => svc.sendMessage(PEER, "salut")), "ACCOUNT_RESTRICTED");
  }
});

test("a temporary ban says until when, and gets one try at the link a minute after it ends", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { svc, sock } = serviceOn(t);
  let starts = 0;
  svc.start = async () => {
    starts++;
  };
  close(sock, closed(402, { code: "102", expire: "3600" }));

  const health = svc.getStatus().health;
  assert.equal(health.state, "temporarily_banned");
  assert.equal(health.reason, "102");
  assert.equal(Date.parse(health.until), 1_000_000 + 3_600_000);
  t.mock.timers.tick(3_600_000 + 59_999);
  assert.equal(starts, 0);
  t.mock.timers.tick(1);
  assert.equal(starts, 1, "one try, when the ban has ended");
});

test("a reachout timelock refuses a first message to a stranger before it leaves, and existing chats go on", async (t) => {
  const { svc, sock } = serviceOn(t);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: PEER, fromMe: false, id: "IN1" }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: "Bună" } }],
  });
  const ends = new Date(Math.ceil((Date.now() + 3_600_000) / 1000) * 1000);
  sock.ev.emit("connection.update", { reachoutTimeLock: { isActive: true, timeEnforcementEnds: ends, enforcementType: "DEFAULT" } });

  const health = svc.getStatus().health;
  assert.equal(health.state, "reachout_restricted");
  assert.equal(Date.parse(health.until), ends.getTime());
  assert.equal(await refusalOf(() => svc.draft({ kind: "text", chatId: STRANGER, text: "Bună ziua" })), "ACCOUNT_RESTRICTED");
  assert.equal(await refusalOf(() => svc.sendMessage(STRANGER, "Bună ziua")), "ACCOUNT_RESTRICTED");
  const draft = await svc.draft({ kind: "text", chatId: PEER, text: "Da, avem." });
  assert.ok(draft.draft_id, "a chat that already has messages is still open");

  sock.ev.emit("connection.update", { reachoutTimeLock: { isActive: false } });
  assert.equal(svc.getStatus().health.state, "ok");
  assert.ok((await svc.draft({ kind: "text", chatId: STRANGER, text: "Bună ziua" })).draft_id, "lifted, the stranger can be written to");
});

test("a stranger who refused the first message stays a stranger: the account's own message opens nothing", async (t) => {
  const { svc, sock } = serviceOn(t);
  sock.fetchAccountReachoutTimelock = async () => ({ isActive: true, enforcementType: "DEFAULT" });
  const first = await svc.sendMessage(STRANGER, "Bună ziua");
  assert.ok(first.message_id, "no timelock yet: it leaves");
  sock.ev.emit("messages.update", [
    { key: { remoteJid: STRANGER, fromMe: true, id: first.message_id.split("_").at(-1) }, update: { status: 0, messageStubParameters: ["463", "Your account has been restricted"] } },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(svc.getStatus().health.state, "reachout_restricted");
  assert.equal(await refusalOf(() => svc.sendMessage(STRANGER, "Mai sunteți acolo?")), "ACCOUNT_RESTRICTED", "the second attempt is the one not to make");
});

test("a contact the account holds a live privacy token for is not a stranger", async (t) => {
  const { svc, sock } = serviceOn(t);
  const now = Math.floor(Date.now() / 1000);
  sock.authState = { keys: { get: async (_type, ids) => Object.fromEntries(ids.map((id) => [id, id === STRANGER ? { token: Buffer.from("tc"), timestamp: now } : undefined])) } };
  sock.ev.emit("connection.update", { reachoutTimeLock: { isActive: true, enforcementType: "DEFAULT" } });
  assert.ok((await svc.draft({ kind: "text", chatId: STRANGER, text: "Bună ziua" })).draft_id, "WhatsApp would take it: the token is there");
  sock.authState = { keys: { get: async (_type, ids) => Object.fromEntries(ids.map((id) => [id, { token: Buffer.from("tc"), timestamp: now - 40 * 86_400 }])) } };
  assert.equal(await refusalOf(() => svc.draft({ kind: "text", chatId: STRANGER, text: "Bună ziua" })), "ACCOUNT_RESTRICTED", "a token past its window is no token");
});

test("a timelock whose end has passed is over, whoever asks first", () => {
  let now = 0;
  const health = new AccountHealth(() => now);
  health.noteReachout({ isActive: true, timeEnforcementEnds: 1000 });
  assert.equal(health.blocksNewChats(), true);
  now = 1000;
  assert.equal(health.info().state, "ok");
  assert.equal(health.blocksNewChats(), false);
});

test("the timelock is asked for at every open, and after a first message is refused with 463", async (t) => {
  const { svc, sock } = serviceOn(t);
  let asked = 0;
  sock.fetchAccountReachoutTimelock = async () => {
    asked++;
    return { isActive: true, enforcementType: "DEFAULT" };
  };
  sock.ev.emit("connection.update", { connection: "open" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked, 1);
  assert.equal(svc.getStatus().health.state, "reachout_restricted");

  sock.ev.emit("messages.update", [
    { key: { remoteJid: STRANGER, fromMe: true, id: "OUT1" }, update: { status: 0, messageStubParameters: ["463", "Your account has been restricted"] } },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked, 2);
  const health = svc.getStatus().health;
  assert.equal(health.last_send_error.code, "463");
  assert.ok(Date.parse(health.last_send_error.at) > 0);
});

test("an open after a ban clears it; a Baileys without the timelock call costs nothing", (t) => {
  const { svc, sock } = serviceOn(t);
  close(sock, closed(406));
  assert.equal(svc.getStatus().health.state, "banned");
  // The next socket that comes up: the account is let in again.
  const next = fakeSocket({ user: { id: ME } });
  svc.sockClient = next;
  svc.wireEvents(next, ++svc.generation);
  next.ev.emit("connection.update", { connection: "open" });
  assert.equal(svc.getStatus().health.state, "ok");
});

test("WhatsApp's warnings about first messages show in health and the hint, and block nothing", () => {
  const health = new AccountHealth(() => 0);
  health.noteNewChatCap({ capping_status: "FIRST_WARNING", used_quota: 40, total_quota: 50, cycle_end_timestamp: "86400" });
  assert.equal(health.info().state, "ok");
  const { cycle_ends, ...cap } = health.info().new_chat_cap;
  assert.deepEqual(cap, { status: "first_warning", used: 40, total: 50 });
  assert.equal(Date.parse(cycle_ends), 86_400_000, "seconds from WhatsApp, as an instant");
  assert.match(health.hint(), /a first warning .*40 of 50 used this cycle/);
  assert.equal(health.blocksNewChats(), false);
  health.noteNewChatCap({ capping_status: "SOMETHING_NEW" });
  assert.equal(health.info().new_chat_cap.status, "first_warning", "a status wazap does not know changes nothing");
});

test("a capped cycle stops first messages until it ends, and says so to the webhook both ways", () => {
  let now = 0;
  let told = 0;
  const health = new AccountHealth(() => now, () => told++);
  health.noteNewChatCap({ capping_status: "CAPPED", used_quota: 50, total_quota: 50, cycle_end_timestamp: 1000 });
  assert.equal(health.info().state, "new_chats_capped");
  assert.equal(health.blocksNewChats(), true);
  assert.match(health.refusal("new_chat").message, /used up for this cycle \(50 of 50 used\)/);
  assert.equal(told, 1);
  now = 1_000_000;
  assert.equal(health.info().state, "ok", "the cycle ended");
  assert.equal(health.blocksNewChats(), false);
  assert.equal(told, 2);
});

test("WhatsApp's cap is asked for at every open and taken from its own updates; capped, a stranger is refused", async (t) => {
  const { svc, sock } = serviceOn(t);
  let asked = 0;
  sock.fetchNewChatMessageCap = async () => {
    asked++;
    return { capping_status: "NONE", used_quota: 1, total_quota: 50 };
  };
  sock.ev.emit("connection.update", { connection: "open" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked, 1);
  assert.equal(svc.getStatus().health.new_chat_cap.status, "none");

  sock.ev.emit("message-capping.update", { capping_status: "CAPPED", used_quota: 50, total_quota: 50, cycle_end_timestamp: String(Math.floor(Date.now() / 1000) + 86_400) });
  assert.equal(svc.getStatus().health.state, "new_chats_capped");
  const refused = await svc.draft({ kind: "text", chatId: STRANGER, text: "Bună ziua" }).catch((err) => err);
  assert.equal(refused.code, "ACCOUNT_RESTRICTED");
  assert.match(refused.message, /cap on first messages/);
});


test("an update that leaves fields out keeps what the last one said, so a capped cycle still ends", (t) => {
  let now = 0;
  const health = new AccountHealth(() => now);
  t.after(() => health.dispose());
  health.noteNewChatCap({ capping_status: "SECOND_WARNING", used_quota: 45, total_quota: 50, cycle_end_timestamp: 1000 });
  health.noteNewChatCap({ capping_status: "CAPPED" });
  assert.deepEqual({ ...health.info().new_chat_cap, cycle_ends: Date.parse(health.info().new_chat_cap.cycle_ends) }, { status: "capped", used: 45, total: 50, cycle_ends: 1_000_000 });
  assert.equal(Date.parse(health.info().until), 1_000_000, "get_status says until when, as the webhook does");
  now = 1_000_000;
  assert.equal(health.info().state, "ok");
});

test("warnings end with their cycle, a new cycle starts clean, and a new link forgets the old session's cap and timelock", (t) => {
  let now = 0;
  const health = new AccountHealth(() => now);
  t.after(() => health.dispose());
  health.noteNewChatCap({ capping_status: "SECOND_WARNING", used_quota: 45, total_quota: 50, cycle_end_timestamp: 1000 });
  assert.match(health.hint(), /second warning/);
  now = 1_000_000;
  assert.equal(health.hint(), null);
  assert.equal(health.info().new_chat_cap.status, "none");
  // A cycle that ended lends nothing to the next one: an undated CAPPED is capped, not over at once.
  health.noteNewChatCap({ capping_status: "CAPPED" });
  assert.equal(health.info().new_chat_cap.cycle_ends, null);
  assert.equal(health.blocksNewChats(), true);
  health.noteNewChatCap({ capping_status: "NONE" });
  assert.deepEqual(health.info().new_chat_cap, { status: "none", used: null, total: null, cycle_ends: null }, "a NONE keeps no counts");
  health.noteNewChatCap({ capping_status: "CAPPED", cycle_end_timestamp: 5000 });
  health.noteReachout({ isActive: true });
  health.forgetSession();
  assert.equal(health.info().new_chat_cap, null);
  assert.equal(health.info().state, "ok", "the timelock was the old session's too");
  assert.equal(health.blocksNewChats(), false);
});

test("a restriction that ends on its own clock is told when it ends, without anyone asking", async (t) => {
  const told = [];
  const timelock = new AccountHealth(Date.now, () => told.push("timelock"));
  const capped = new AccountHealth(Date.now, () => told.push("cap"));
  t.after(() => [timelock, capped].forEach((health) => health.dispose()));
  timelock.noteReachout({ isActive: true, timeEnforcementEnds: Date.now() + 40 });
  capped.noteNewChatCap({ capping_status: "CAPPED", cycle_end_timestamp: String((Date.now() + 40) / 1000) });
  assert.deepEqual(told, ["timelock", "cap"]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Two accounts, two timers: which runs out first is not a promise. Each reads the clock for
  // itself, so a millisecond turning between the two reads leaves one a millisecond shorter.
  assert.deepEqual(told.slice(2).sort(), ["cap", "timelock"], "each lift reached onChange by itself");
});

test("a change in health is a connection event only while linked", async (t) => {
  const { svc, sock } = serviceOn(t);
  const told = [];
  svc.webhooks.queueConnectionWebhook = (status) => told.push(status);
  sock.ev.emit("message-capping.update", { capping_status: "CAPPED", cycle_end_timestamp: String(Math.floor(Date.now() / 1000) + 86_400) });
  assert.deepEqual(told, ["connected"]);
  svc.status = "disconnected";
  sock.ev.emit("message-capping.update", { capping_status: "NONE" });
  assert.deepEqual(told, ["connected"], "the status that brings the link back carries it");
});
