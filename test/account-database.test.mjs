/**
 * The service over its account database: the boot that imports an upgraded
 * account's legacy files once (and says it is preparing meanwhile), resumes an
 * import a stop cut off, serves an import whose verification found
 * differences and flags it, and never touches a legacy file again; what a
 * restart keeps, for every message and not only a chat's newest; a lid learned
 * in the middle of a conversation; a different number linking; and memory that
 * does not grow with the history.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proto } from "baileys";

import { AccountDb } from "../dist/db/index.js";
import { accountPaths } from "../dist/config.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { ANA, BOGDAN, GROUP, ME, buildLegacyAccount, roles } from "./legacy-fixtures.mjs";
import { socketFactory } from "../dist/pairing.js";
import { BINARY, connectedService, fakeSocket, offlineConfig, openService, storedIds, stubSockets } from "./helpers.mjs";

const r = roles();
const PEER = "40700000009@s.whatsapp.net";
const PEER_LID = "909090909090909@lid";

/** A connected service over a data dir, keeping history, as `serve` builds it. */
function serviceOn(dataDir, config = {}) {
  return connectedService(WhatsAppService, {
    prefix: "wazap-accountdb-",
    id: ME,
    name: "Răzvan",
    config: { dataDir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0, ...config },
  });
}

const text = (chat, id, body, seconds, extra = {}) => ({
  key: { remoteJid: chat, fromMe: false, id, ...(extra.key ?? {}) },
  message: { conversation: body },
  messageTimestamp: seconds,
  ...(extra.raw ?? {}),
});

test("an upgraded account prepares its database at boot, answers NOT_CONNECTED meanwhile, then serves what the legacy files held", async (t) => {
  const fx = await buildLegacyAccount();
  t.mock.method(Date, "now", () => fx.now);
  const { svc } = serviceOn(fx.dataDir);
  t.after(() => svc.stop());

  const status = svc.getStatus();
  assert.match(status.hint, /preparing its database/);
  await assert.rejects(svc.listChats("all", 10), (err) => err.code === "NOT_CONNECTED" && /preparing its database/.test(err.message));
  await assert.rejects(svc.setContactNote(ANA, "x"), (err) => err.code === "NOT_CONNECTED");
  assert.equal(svc.hasMessage(r.a1), false, "routing sees nothing until the import is done");

  await svc.bootStorage();
  assert.equal(svc.db.getMeta("import_state"), "done");
  assert.equal(svc.db.getMeta("import_unverified"), null);
  assert.doesNotMatch(svc.getStatus().hint ?? "", /preparing/);
  assert.equal((await svc.getMessage(r.a1)).text, "Salut, ce mai faci azi?");
  assert.equal((await svc.getMessage(r.a2)).text, "Bine, mulțumesc frumos, tu?", "the edit came with it");
  await assert.rejects(svc.getMessage(r.a3), { code: "MESSAGE_NOT_FOUND" }, "and the delete for me");
  assert.ok((await svc.listChats("all", 50)).data.some((chat) => chat.chat_id === BOGDAN && chat.note === "Bogdan de la depozit"));
  assert.ok((await svc.getUnanswered(0, 24 * 30, 10)).data.every((chat) => chat.chat_id !== ANA), "the handled mark came too");
});

test("an import a stop cut off resumes at the next boot and finishes", async (t) => {
  const fx = await buildLegacyAccount();
  t.mock.method(Date, "now", () => fx.now);
  const first = serviceOn(fx.dataDir).svc;
  const booting = first.bootStorage().catch(() => {});
  // The import yields to the event loop between chunks: catch it there, mid-way.
  for (let turns = 0; first.storage.accountDb.getMeta("import_state") !== "running"; turns++) {
    assert.ok(turns < 10_000, "the import started");
    await new Promise((resolve) => setImmediate(resolve));
  }
  await first.stop();
  await booting;
  const cut = AccountDb.open(join(fx.paths.root, "wazap.sqlite"));
  assert.equal(cut.getMeta("import_state"), "running", "the stop left it mid-way");
  cut.close();

  const { svc } = serviceOn(fx.dataDir);
  t.after(() => svc.stop());
  assert.match(svc.getStatus().hint, /preparing/, "an interrupted import still counts as preparing");
  await svc.bootStorage();
  assert.equal(svc.db.getMeta("import_state"), "done");
  const report = JSON.parse(svc.db.getMeta("import_report"));
  assert.ok(report.runs >= 2, `resumed, in ${report.runs} runs`);
  assert.equal((await svc.getMessage(r.g1)).text, "Ședința e la ora zece");
});

/** Polls on real timers, since these tests freeze Date.now at the fixture's clock. */
async function until(predicate, label) {
  for (let polls = 0; !predicate(); polls++) {
    assert.ok(polls < 1_000, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Waits, a turn of the event loop at a time, until the boot import is under way. */
async function importRunning(svc) {
  for (let turns = 0; svc.storage.accountDb.getMeta("import_state") !== "running"; turns++) {
    assert.ok(turns < 10_000, "the import started");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a stop while start() waits on the import opens no socket afterwards, and leaves the credentials folder alone", async (t) => {
  const fx = await buildLegacyAccount();
  t.mock.method(Date, "now", () => fx.now);
  const sockets = stubSockets(socketFactory, [fakeSocket()]);
  t.after(() => sockets.restore());
  const svc = openService(WhatsAppService, offlineConfig("wazap-accountdb-", { dataDir: fx.dataDir, persistHistory: true }));
  const starting = svc.start();
  await importRunning(svc);
  await svc.stop();
  // What a logout does next: the credentials go.
  fs.rmSync(fx.paths.authDir, { recursive: true, force: true });
  await starting;
  assert.equal(sockets.opened.length, 0, "a stopped service opens no WhatsApp socket");
  assert.equal(svc.sockClient, null);
  assert.equal(existsSync(fx.paths.authDir), false, "the removed credentials are not recreated");
});

test("a link completed while the import runs opens the account's socket once the database is ready", async (t) => {
  const fx = await buildLegacyAccount({ linked: false });
  t.mock.method(Date, "now", () => fx.now);
  const phoneSide = fakeSocket({ pairingCode: "K7PX3MQZ", user: { id: "40700000001:12@s.whatsapp.net", name: "Răzvan" } });
  const serviceSide = fakeSocket();
  const sockets = stubSockets(socketFactory, [phoneSide, serviceSide]);
  t.after(() => sockets.restore());
  const svc = openService(WhatsAppService, offlineConfig("wazap-accountdb-", { dataDir: fx.dataDir, persistHistory: true, readOnly: false }));
  t.after(() => svc.stop());

  // A long import, held open until the phone has accepted the code.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const resume = svc.storage.accountDb.resume.bind(svc.storage.accountDb);
  t.mock.method(svc.storage.accountDb, "resume", async () => {
    await held;
    return resume();
  });
  const starting = svc.start();
  const code = svc.link("+40700000001");
  await until(() => sockets.opened.length > 0, "the pairing socket to open");
  phoneSide.ev.emit("connection.update", { qr: "pairing-qr" });
  assert.equal((await code).code, "K7PX-3MQZ");
  // What saveCreds leaves behind once the phone accepts the code.
  mkdirSync(fx.paths.authDir, { recursive: true });
  writeFileSync(join(fx.paths.authDir, "creds.json"), JSON.stringify({ me: { id: "40700000001:12@s.whatsapp.net", name: "Răzvan" } }));
  phoneSide.ev.emit("connection.update", { connection: "open" });
  await until(() => svc.linking === null, "the link to be adopted");
  assert.match(svc.getStatus().hint ?? "", /preparing/, "the import is still running");
  release();
  await starting;
  await until(() => sockets.opened.length === 2, "the service socket to open");
  assert.equal(svc.sockClient, serviceSide);
  assert.equal(svc.getStatus().status, "connecting");
  assert.equal(svc.db.getMeta("import_state"), "done");
  assert.equal(svc.db.getMeta("owner"), ME);
});

test("an import whose verification finds a difference it cannot explain still serves, and says so for doctor", async (t) => {
  const fx = await buildLegacyAccount();
  t.mock.method(Date, "now", () => fx.now);
  const { svc } = serviceOn(fx.dataDir);
  t.after(() => svc.stop());
  // A row no legacy file explains, written before the import runs.
  svc.storage.accountDb.messages.upsert({ chatJid: ANA, keyId: "STRAY", fromMe: false, ts: fx.T * 1000, type: "text", text: "stray" });
  const logged = [];
  t.mock.method(process.stderr, "write", (chunk) => {
    logged.push(String(chunk));
    return true;
  });
  await svc.bootStorage();
  t.mock.restoreAll();
  t.mock.method(Date, "now", () => fx.now);

  assert.equal(svc.db.getMeta("import_state"), "imported");
  const flag = JSON.parse(svc.db.getMeta("import_unverified"));
  assert.equal(flag.unexpected.extraInDb, 1);
  assert.ok(logged.some((line) => /could not explain \(extraInDb 1\); serving from the database/.test(line)), logged.join(""));
  assert.equal(logged.join("").includes("stray"), false, "counts and categories, never words");
  assert.equal((await svc.getMessage(r.a1)).text, "Salut, ce mai faci azi?", "it serves anyway");
});

test("after the import the service never reads or writes a legacy file, whatever it is asked", async (t) => {
  const fx = await buildLegacyAccount();
  const first = serviceOn(fx.dataDir).svc;
  await first.bootStorage();
  await first.stop();
  assert.equal(existsSync(join(fx.paths.root, "legacy", "store.json")), true, "the boot moved them aside");

  // Their old places and legacy/, however looked at; the beta archive may be listed and dated, its bytes are read only by SQLite.
  const legacy = [fx.paths.storeFile, fx.paths.historyDir, fx.paths.notesFile, join(fx.paths.root, "retention.json"), join(fx.paths.root, "recall"), join(fx.paths.root, "legacy")];
  const archive = [join(fx.dataDir, "archive.sqlite"), join(fx.dataDir, "legacy")];
  const metadataOnly = new Set(["existsSync", "statSync", "lstatSync", "stat", "readdirSync"]);
  const touched = [];
  const watch = (target, name) => {
    const original = target[name];
    if (typeof original !== "function") return;
    t.mock.method(target, name, function (path, ...rest) {
      const hit = (prefixes) => typeof path === "string" && prefixes.some((prefix) => path.startsWith(prefix));
      if (hit(legacy) || (hit(archive) && !metadataOnly.has(name))) touched.push(`${name} ${path}`);
      return original.call(this, path, ...rest);
    });
  };
  for (const name of ["readFileSync", "writeFileSync", "appendFileSync", "readdirSync", "existsSync", "statSync", "lstatSync", "openSync", "renameSync", "rmSync", "utimesSync", "createReadStream", "createWriteStream"]) watch(fs, name);
  for (const name of ["readFile", "writeFile", "appendFile", "readdir", "stat", "open", "rename", "rm"]) watch(fsPromises, name);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  // The watch sees a module's named imports too: the importer's own reader trips it.
  const { readSnapshot } = await import("../dist/legacy-import/sources.js");
  readSnapshot(fx.paths.storeFile);
  assert.deepEqual(touched, [`readFileSync ${fx.paths.storeFile}`], "the watch works");
  touched.length = 0;

  const { svc, sock } = serviceOn(fx.dataDir);
  sock.chatModify = async () => {};
  await svc.bootStorage();
  const now = Math.floor(Date.now() / 1000);
  sock.ev.emit("messages.upsert", { type: "notify", messages: [text(ANA, "LIVE1", "mesaj nou", now), text(GROUP, "LIVE2", "în grup", now, { key: { participant: BOGDAN } })] });
  sock.ev.emit("messages.update", [{ key: { remoteJid: ANA, fromMe: false, id: "LIVE1" }, update: { message: { editedMessage: { message: { conversation: "mesaj editat" } } } } }]);
  sock.ev.emit("messages.reaction", [{ key: { remoteJid: ANA, fromMe: false, id: "LIVE1" }, reaction: { key: { remoteJid: ANA, fromMe: true }, text: "👍" } }]);
  sock.ev.emit("contacts.upsert", [{ id: PEER, name: "Nou" }]);
  sock.ev.emit("chats.update", [{ id: ANA, unreadCount: 3 }]);
  await svc.listChats("all", 50);
  await svc.readMessages(ANA, 50);
  await svc.getRecentMessages(24 * 365, "all");
  await svc.searchMessages("mesaj", undefined, 20);
  await svc.getUnanswered(0, 24 * 365, 20);
  await svc.searchContacts("", 20);
  await svc.setContactNote(PEER, "notă nouă");
  await svc.updateContactDetails(PEER, { addTags: ["client"] });
  await svc.markHandled(ANA);
  await svc.getStories(24);
  await svc.deleteMessage(`false_${ANA}_LIVE1`, false);
  await svc.manageChat(GROUP, "clear");
  await svc.storageIdle();
  await svc.stop();

  assert.deepEqual(touched, [], "no legacy file was opened, listed, written or removed");
});

test("edits, reactions, votes and receipts on a chat's oldest messages survive a restart, beyond the old 120 kept per chat", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-accountdb-"));
  const first = serviceOn(dataDir);
  const base = Math.floor(Date.now() / 1000) - 10 * 86_400;
  const mine = { key: { remoteJid: GROUP, fromMe: true, id: "OLDEST" }, message: { conversation: "primul mesaj" }, messageTimestamp: base };
  first.sock.ev.emit("messages.upsert", { type: "notify", messages: [mine] });
  const rest = Array.from({ length: 200 }, (_, i) => text(GROUP, `N${i}`, `mesajul ${i}`, base + 60 + i, { key: { participant: PEER } }));
  first.sock.ev.emit("messaging-history.set", { chats: [], contacts: [], messages: rest, isLatest: true });
  const sid = `true_${GROUP}_OLDEST`;
  first.sock.ev.emit("messages.update", [{ key: mine.key, update: { message: { editedMessage: { message: { conversation: "primul mesaj, editat" } } }, messageTimestamp: base + 30 } }]);
  first.sock.ev.emit("messages.reaction", [{ key: mine.key, reaction: { key: { remoteJid: GROUP, fromMe: false, participant: PEER }, text: "❤️", senderTimestampMs: (base + 40) * 1000 } }]);
  first.sock.ev.emit("message-receipt.update", [{ key: mine.key, receipt: { userJid: PEER, readTimestamp: base + 50, receiptTimestamp: base + 45 } }]);
  first.svc.db.messages.vote(sid, PEER, JSON.stringify(["da"]), (base + 55) * 1000);
  await first.svc.stop();

  const { svc } = serviceOn(dataDir);
  t.after(() => svc.stop());
  assert.equal(storedIds(svc, GROUP).length, 201);
  const view = await svc.getMessage(sid);
  assert.equal(view.text, "primul mesaj, editat");
  assert.equal(view.edited, true);
  assert.deepEqual(view.reactions.map((reaction) => [reaction.emoji, reaction.sender]), [["❤️", PEER]]);
  assert.deepEqual(view.delivery.read_by.map((reader) => reader.id), [PEER]);
  assert.deepEqual(svc.db.messages.votes(sid).map((vote) => [vote.jid, vote.choice]), [[PEER, '["da"]']]);
});

test("a lid learned in the middle of a conversation joins the chat, and a restart keeps one conversation", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-accountdb-"));
  const first = serviceOn(dataDir);
  const now = Math.floor(Date.now() / 1000);
  const say = (chat, id, body, at) => first.sock.ev.emit("messages.upsert", { type: "notify", messages: [text(chat, id, body, at)] });
  say(PEER_LID, "L1", "salut de pe lid", now - 300);
  say(PEER_LID, "L2", "mai ești?", now - 240);
  first.sock.ev.emit("lid-mapping.update", { lid: PEER_LID, pn: PEER });
  say(PEER, "P1", "acum de pe număr", now - 180);
  say(PEER_LID, "L3", "și iar de pe lid", now - 120);
  await first.svc.storageIdle();
  const read = (await first.svc.readMessages(PEER, 10)).data;
  assert.deepEqual(
    read.map((m) => [m.message_id, m.text]),
    [
      [`false_${PEER}_L1`, "salut de pe lid"],
      [`false_${PEER}_L2`, "mai ești?"],
      [`false_${PEER}_P1`, "acum de pe număr"],
      [`false_${PEER}_L3`, "și iar de pe lid"],
    ]
  );
  assert.deepEqual((await first.svc.searchMessages("lid", undefined, 10, { from: PEER })).data.map((m) => m.message_id).sort(), [`false_${PEER}_L1`, `false_${PEER}_L3`].sort());
  await first.svc.stop();

  const { svc } = serviceOn(dataDir);
  t.after(() => svc.stop());
  assert.deepEqual((await svc.listChats("all", 10)).data.map((chat) => chat.chat_id), [PEER]);
  assert.equal(svc.identity.lidToPn.get(PEER_LID), PEER);
  assert.equal((await svc.getMessage(`false_${PEER_LID}_L2`)).message_id, `false_${PEER}_L2`, "the lid spelling of an id still answers");
});

test("a different number linking sets the previous owner's database aside instead of showing its history", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-accountdb-"));
  const storage = accountPaths(dataDir, "default");
  const link = (jid) => {
    mkdirSync(storage.authDir, { recursive: true });
    writeFileSync(join(storage.authDir, "creds.json"), JSON.stringify({ me: { id: jid.replace("@", ":3@"), name: "Owner" } }));
  };
  link(ME);
  const first = openService(WhatsAppService, offlineConfig("x", { dataDir, persistHistory: true }));
  await first.storage.claimDatabase(ME);
  first.db.messages.upsert({ chatJid: PEER, keyId: "OLD", fromMe: false, ts: Date.now() - 60_000, type: "text", text: "istoria altui număr" });
  await first.stop();

  const other = "40700000077@s.whatsapp.net";
  link(other);
  const { svc } = serviceOn(dataDir);
  t.after(() => svc.stop());
  await svc.storage.claimDatabase(other);
  assert.equal(svc.db.getMeta("owner"), other);
  assert.equal(svc.hasMessage(`false_${PEER}_OLD`), false, "the new number starts empty");
  const aside = fs.readdirSync(storage.root).filter((name) => /^wazap\.\d+\.previous-owner\.sqlite$/.test(name));
  assert.equal(aside.length, 1, "the old file is kept beside it");
  const old = AccountDb.open(join(storage.root, aside[0]), { readOnly: true });
  assert.equal(old.getMeta("owner"), ME);
  assert.equal(old.messages.get(`false_${PEER}_OLD`).text, "istoria altui număr");
  old.close();
});

test("a large history batch is stored in bounded transactions: the event loop runs between them, and a revoke or a delete landing meanwhile holds", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-accountdb-"));
  const { svc, sock } = serviceOn(dataDir);
  t.after(() => svc.stop());
  await svc.bootStorage();
  const base = Math.floor(Date.now() / 1000) - 7 * 86_400;
  const messages = Array.from({ length: 6_000 }, (_, i) => text(i % 2 === 0 ? PEER : ANA, `H${i}`, `istoric ${i}`, base + i));
  let midway = null;
  sock.ev.emit("messaging-history.set", { chats: [], contacts: [], messages, isLatest: true, progress: 100 });
  setImmediate(() => {
    midway = { newest: svc.hasMessage(`false_${PEER}_H5998`), history: svc.hasHistory() };
    // The other side revokes a message the batch has not stored yet, and the phone deletes the other chat.
    sock.ev.emit("messages.delete", { keys: [{ remoteJid: PEER, fromMe: false, id: "H5996" }] });
    sock.ev.emit("chats.delete", [ANA]);
  });
  await new Promise((resolve) => setImmediate(resolve));
  await svc.storageIdle();
  assert.deepEqual(midway, { newest: false, history: false }, "the batch was still being stored when a timer ran");
  assert.equal(svc.hasMessage(`false_${PEER}_H5998`), true);
  assert.equal(svc.hasMessage(`false_${PEER}_H5996`), false, "the revoke that landed first holds");
  assert.deepEqual(storedIds(svc, ANA), [], "the delete that landed first holds");
  assert.equal(svc.db.search.coverage({ chat: PEER }).messages, 2_999);
  assert.equal(svc.hasHistory(), true, "history counts as received once the batch is stored");
});

test("a history batch arriving once a stop began is refused, as every other event is", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-accountdb-"));
  const { svc, sock } = serviceOn(dataDir);
  await svc.bootStorage();
  const stopping = svc.stop();
  const base = Math.floor(Date.now() / 1000) - 3600;
  sock.ev.emit("messaging-history.set", { chats: [], contacts: [], messages: Array.from({ length: 10 }, (_, i) => text(PEER, `LATE${i}`, `după oprire ${i}`, base + i)), isLatest: true });
  await stopping;
  const db = AccountDb.open(join(accountPaths(dataDir, "default").root, "wazap.sqlite"), { readOnly: true });
  assert.equal(db.counts().messages, 0, "nothing was stored after the stop began");
  db.close();
});

test("edits, reactions, statuses and receipts arriving while a history batch is still being stored land on its messages", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-accountdb-"));
  const { svc, sock } = serviceOn(dataDir);
  t.after(() => svc.stop());
  await svc.bootStorage();
  const base = Math.floor(Date.now() / 1000) - 3600;
  const messages = Array.from({ length: 6_000 }, (_, i) =>
    text(i % 3 === 0 ? GROUP : PEER, `H${i}`, `istoric ${i}`, base + Math.floor(i / 10), { key: { fromMe: i % 2 === 0, ...(i % 3 === 0 && i % 2 !== 0 ? { participant: ANA } : {}) }, raw: i % 2 === 0 ? { status: 2 } : {} })
  );
  const mine = `true_${PEER}_H5998`;
  const liked = `true_${PEER}_H5996`;
  const inGroup = `true_${GROUP}_H5994`;
  sock.ev.emit("messaging-history.set", { chats: [], contacts: [], messages, isLatest: true, progress: 100 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(svc.hasMessage(mine), false, "the batch is still being stored");
  const now = Math.floor(Date.now() / 1000);
  sock.ev.emit("messages.reaction", [{ key: { remoteJid: PEER, fromMe: true, id: "H5998" }, reaction: { key: { remoteJid: PEER, fromMe: false, id: "RX1" }, text: "👍", senderTimestampMs: Date.now() } }]);
  sock.ev.emit("messages.update", [{ key: { remoteJid: PEER, fromMe: true, id: "H5998" }, update: { message: { editedMessage: { message: { conversation: "istoric EDITAT" } } }, messageTimestamp: now } }]);
  sock.ev.emit("messages.update", [{ key: { remoteJid: PEER, fromMe: true, id: "H5998" }, update: { status: 4 } }]);
  sock.ev.emit("message-receipt.update", [{ key: { remoteJid: GROUP, fromMe: true, id: "H5994" }, receipt: { userJid: ANA, readTimestamp: now } }]);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      { key: { remoteJid: PEER, fromMe: false, id: "HEART" }, messageTimestamp: now, message: { reactionMessage: { key: { remoteJid: PEER, fromMe: true, id: "H5996" }, text: "❤️", senderTimestampMs: Date.now() } } },
      { key: { remoteJid: PEER, fromMe: false, id: "LIVE1" }, messageTimestamp: now, message: { conversation: "scriu chiar acum" } },
    ],
  });
  assert.equal(svc.hasMessage(`false_${PEER}_LIVE1`), true, "a live message is stored at once, history or not");
  await svc.storageIdle();

  const edited = await svc.getMessage(mine);
  assert.deepEqual([edited.text, edited.edited], ["istoric EDITAT", true]);
  assert.deepEqual(edited.reactions.map((r) => r.emoji), ["👍"]);
  assert.equal(edited.delivery.status, "read");
  assert.deepEqual((await svc.getMessage(liked)).reactions.map((r) => r.emoji), ["❤️"]);
  assert.deepEqual((await svc.getMessage(inGroup)).delivery.read_by.map((reader) => reader.id), [ANA]);
});

test("a catch-up over a busy week reads each message's reactions, votes and receipts in a few queries, not a few per message", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-accountdb-"));
  const { svc, sock } = serviceOn(dataDir);
  t.after(() => svc.stop());
  await svc.bootStorage();
  const base = Math.floor(Date.now() / 1000) - 3 * 86_400;
  const messages = Array.from({ length: 600 }, (_, i) => text(i % 3 === 0 ? PEER : GROUP, `W${i}`, `săptămâna ${i}`, base + i * 60, i % 3 === 0 ? {} : { key: { participant: PEER } }));
  messages.push({ key: { remoteJid: PEER, fromMe: true, id: "MINE" }, message: { conversation: "al meu" }, messageTimestamp: base + 40_000 });
  sock.ev.emit("messaging-history.set", { chats: [], contacts: [], messages, isLatest: true });
  await svc.storageIdle();
  sock.ev.emit("messages.reaction", [{ key: { remoteJid: GROUP, fromMe: false, id: "W1", participant: PEER }, reaction: { key: { remoteJid: GROUP, fromMe: false, participant: ANA }, text: "👍", senderTimestampMs: (base + 100) * 1000 } }]);
  sock.ev.emit("message-receipt.update", [{ key: { remoteJid: PEER, fromMe: true, id: "MINE" }, receipt: { userJid: PEER, readTimestamp: base + 40_100 } }]);

  const lookups = ["reactions", "votes", "receipts"].map((name) => t.mock.method(svc.db.messages, name));
  const recent = await svc.getRecentMessages(168, "all");
  assert.equal(recent.data.reduce((n, chat) => n + chat.messages.length, 0), 601);
  assert.deepEqual(lookups.map((lookup) => lookup.mock.callCount()), [0, 0, 0], "no lookup per message");
  const all = recent.data.flatMap((chat) => chat.messages);
  assert.deepEqual(all.find((m) => m.message_id === `false_${GROUP}_W1`).reactions.map((r) => [r.emoji, r.sender]), [["👍", ANA]]);
  assert.deepEqual(all.find((m) => m.message_id === `true_${PEER}_MINE`).delivery, (await svc.getMessage(`true_${PEER}_MINE`)).delivery);
  assert.equal(all.find((m) => m.message_id === `true_${PEER}_MINE`).delivery.status, "read");
});

test("a catch-up reads each active chat's newest 2,000 in its window, as main's per-chat ring held, and walks no other chat", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-accountdb-"));
  const { svc } = serviceOn(dataDir);
  t.after(() => svc.stop());
  await svc.bootStorage();
  const now = Date.now();
  svc.db.messages.upsertMany(Array.from({ length: 2_100 }, (_, i) => ({ chatJid: PEER, keyId: `B${i}`, fromMe: false, ts: now - 3_600_000 + i * 1000, type: "text", text: `rafală ${i}` })));
  svc.db.messages.upsertMany(Array.from({ length: 300 }, (_, i) => ({ chatJid: ANA, keyId: `Q${i}`, fromMe: false, ts: now - 30 * 86_400_000 + i * 1000, type: "text", text: `vechi ${i}` })));
  const recent = t.mock.method(svc.db.messages, "recent");
  const result = await svc.getRecentMessages(24, "all");
  assert.deepEqual(result.data.map((chat) => chat.chat_id), [PEER], "a quiet chat is not in the window");
  const messages = result.data[0].messages;
  assert.equal(messages.length, 2_000);
  assert.equal(messages[0].message_id, `false_${PEER}_B100`, "the newest 2,000, oldest first");
  assert.equal(messages.at(-1).message_id, `false_${PEER}_B2099`);
  assert.equal(recent.mock.callCount(), 0, "the window is read chat by chat, not across the account");
});

test("an account of 20,000 messages boots without holding its history in memory", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-accountdb-rss-"));
  const db = AccountDb.open(join(accountPaths(dataDir, "default").root, "wazap.sqlite"));
  const base = Date.now() - 20 * 86_400_000;
  const chats = Array.from({ length: 50 }, (_, i) => `4070000${String(1000 + i)}@s.whatsapp.net`);
  for (let batch = 0; batch < 20; batch++) {
    db.messages.upsertMany(
      Array.from({ length: 1_000 }, (_, i) => {
        const n = batch * 1_000 + i;
        const chat = chats[n % chats.length];
        const raw = proto.WebMessageInfo.encode({ key: { remoteJid: chat, fromMe: n % 3 === 0, id: `M${n}` }, message: { conversation: `mesajul numărul ${n} ${"x".repeat(200)}` }, messageTimestamp: Math.floor((base + n * 60_000) / 1000) }).finish();
        return { chatJid: chat, keyId: `M${n}`, fromMe: n % 3 === 0, ts: base + n * 60_000, type: "text", text: `mesajul numărul ${n}`, raw };
      })
    );
  }
  db.close();

  const script = `
    const { WhatsAppService } = await import(${JSON.stringify(new URL("../dist/whatsapp.js", import.meta.url).href)});
    const { connectedService } = await import(${JSON.stringify(new URL("./helpers.mjs", import.meta.url).href)});
    global.gc(); const before = process.memoryUsage();
    const started = performance.now();
    const { svc } = connectedService(WhatsAppService, { prefix: "x", id: "40700000001@s.whatsapp.net", name: "R", config: { dataDir: ${JSON.stringify(dataDir)}, persistHistory: true } });
    await svc.bootStorage();
    const bootMs = performance.now() - started;
    const chats = (await svc.listChats("all", 100)).data.length;
    const recent = (await svc.getRecentMessages(24, "all")).data.length;
    global.gc(); const after = process.memoryUsage();
    let largest = 0;
    for (const value of Object.values(svc)) {
      const size = value instanceof Map || value instanceof Set ? value.size : Array.isArray(value) ? value.length : 0;
      largest = Math.max(largest, size);
    }
    await svc.stop();
    process.stdout.write(JSON.stringify({ bootMs, chats, recent, heapDelta: after.heapUsed - before.heapUsed, rss: after.rss, largest }));
  `;
  const child = spawn(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, err);
  const result = JSON.parse(out);
  assert.equal(result.chats, 50);
  assert.ok(result.largest < 1_000, `no collection on the service grows with the history (largest ${result.largest})`);
  assert.ok(result.heapDelta < 40_000_000, `the heap holds no copy of the history (grew ${Math.round(result.heapDelta / 1e6)} MB)`);
  assert.ok(result.rss < 400_000_000, `rss stays bounded (${Math.round(result.rss / 1e6)} MB)`);
  assert.ok(existsSync(BINARY));
});
