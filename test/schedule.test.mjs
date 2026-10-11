/**
 * Scheduled messages and reminders: a draft with send_at is scheduled by its
 * confirm and sent at its time, once, through every check a send passes then
 * (the record on disk, read-only, the send rules, the link, the rate limit);
 * missed when wazap could not send it within the grace window, never sent
 * late in a burst; settled from its send row after a crash. Reminders fire to
 * the webhook when due, and one waiting for no reply is skipped once someone
 * wrote. Both survive a restart, and the tools gate them like every write.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveFutureTime, resolveTime, SCHEDULE_MAX_AHEAD_MS } from "../dist/schedule-time.js";
import { SCHEDULE_GRACE_MS } from "../dist/service/schedule.js";
import { WazapError } from "../dist/errors.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools, storageRows, textError } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const OTHER = "40700000003@s.whatsapp.net";
const OWNER = "session_a";
const MINUTE = 60_000;
const WEBHOOK_KEYS = ["WAZAP_WEBHOOK", "WAZAP_WEBHOOK_URL", "WAZAP_WEBHOOK_SECRET", "WAZAP_WEBHOOK_EVENTS"];
const RECORD = Object.freeze({ id: "default", name: "default", enabled: true, owner: null });

function dataDirFor(t) {
  const dir = mkdtempSync(join(tmpdir(), "wazap-schedule-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A connected service over `dataDir` whose scheduler runs on `clock` and checks
 * each send against `record()`. The same directory again is a restart.
 */
function serviceOn(t, dataDir, { config = {}, record = () => ({ ...RECORD }), enable = true } = {}) {
  const connected = connectedService(WhatsAppService, {
    prefix: "wazap-schedule-",
    id: ME,
    name: "Răzvan",
    config: { dataDir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0, ...config },
  });
  t.after(() => connected.svc.stop());
  const { svc, sock } = connected;
  sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
  connected.sent = [];
  sock.waUploadToServer = async () => ({ mediaUrl: "https://mmg.whatsapp.net/synthetic", directPath: "/synthetic" });
  sock.relayMessage = async (jid, message, options) => {
    connected.sent.push({ jid, message, options });
    return options.messageId;
  };
  connected.clock = { now: Date.now() };
  svc.schedule.now = () => connected.clock.now;
  if (enable) svc.enableSchedule(record);
  return connected;
}

/** A text draft for `inMs` from now, confirmed: the scheduled view. */
async function scheduleText(svc, text, inMs = 5 * MINUTE, chatId = PEER) {
  const draft = await svc.draft({ kind: "text", chatId, text }, OWNER, { at: Date.now() + inMs, zone: "Europe/Bucharest" });
  return { draft, scheduled: await svc.confirmSchedule(draft.draft_id, OWNER) };
}

function scheduledRow(svc, id) {
  return storageRows(svc, "SELECT * FROM scheduled WHERE id = ?", id)[0];
}

function withWebhook(t, events = "all") {
  const saved = WEBHOOK_KEYS.map((key) => [key, process.env[key]]);
  Object.assign(process.env, {
    WAZAP_WEBHOOK: "on",
    // Nothing listens there: the events wait in the outbox, which is what is checked.
    WAZAP_WEBHOOK_URL: "http://127.0.0.1:9/hook",
    WAZAP_WEBHOOK_SECRET: "schedule-test-secret",
    WAZAP_WEBHOOK_EVENTS: events,
  });
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function inbound(id, body, chat = PEER, ts = Date.now()) {
  return { key: { remoteJid: chat, fromMe: false, id }, messageTimestamp: Math.floor(ts / 1000), message: { conversation: body } };
}

// ------------------------------------------------------------------ the time

test("a wall-clock time is read in its zone, an offset is kept, and the label says both", () => {
  const now = Date.UTC(2026, 9, 11, 12, 0);
  const local = resolveTime("2026-10-12T09:00", "Europe/Bucharest", now);
  assert.equal(local.at, Date.UTC(2026, 9, 12, 6, 0), "09:00 in Bucharest in October is 06:00 UTC (EEST, +03:00)");
  assert.equal(local.iso, "2026-10-12T09:00:00+03:00");
  assert.match(local.label, /Mon 12 Oct 2026, 09:00 \(Europe\/Bucharest, UTC\+03:00\)/);
  const winter = resolveTime("2026-12-12 09:00", "Europe/Bucharest", now);
  assert.equal(winter.iso, "2026-12-12T09:00:00+02:00", "the zone's own offset on that day");
  const offset = resolveTime("2026-10-12T09:00:00-04:00", "Europe/Bucharest", now);
  assert.equal(offset.at, Date.UTC(2026, 9, 12, 13, 0), "an explicit offset wins");
  assert.equal(offset.iso, "2026-10-12T16:00:00+03:00", "and is shown in the zone");
  const utc = resolveTime("2026-10-12T09:00:00Z", "America/New_York", now);
  assert.equal(utc.iso, "2026-10-12T05:00:00-04:00");
});

test("a time the clocks skip is refused, one they repeat is the first and flagged, and bad input is INVALID_TIME", () => {
  const now = Date.UTC(2026, 0, 1);
  // Europe/Bucharest springs forward at 03:00 on 29 March 2026: 03:30 never happens.
  assert.throws(() => resolveTime("2026-03-29T03:30", "Europe/Bucharest", now), { code: "INVALID_TIME", message: /does not exist/ });
  // It falls back at 04:00 on 25 October 2026: 03:30 happens twice.
  const twice = resolveTime("2026-10-25T03:30", "Europe/Bucharest", now);
  assert.equal(twice.ambiguous, true);
  assert.equal(twice.iso, "2026-10-25T03:30:00+03:00", "the first of the two");
  for (const bad of ["tomorrow at 9", "2026-02-30T09:00", "2026-10-12T25:00", "12/10/2026 09:00", "2026-10-12"]) {
    assert.throws(() => resolveTime(bad, "Europe/Bucharest", now), { code: "INVALID_TIME" }, bad);
  }
  assert.throws(() => resolveTime("2026-10-12T09:00", "Mars/Olympus", now), { code: "INVALID_TIME", message: /not a time zone/ });
});

test("a time in the past, too soon or too far ahead is refused with the current time in the fix", () => {
  const now = Date.UTC(2026, 9, 11, 12, 0);
  const opts = { now, minAheadMs: MINUTE, maxAheadMs: SCHEDULE_MAX_AHEAD_MS, field: "send_at" };
  assert.throws(() => resolveFutureTime("2026-10-11T11:00:00Z", "UTC", opts), (err) => {
    assert.equal(err.code, "INVALID_TIME");
    assert.match(err.message, /in the past: it is now 2026-10-11T12:00:00\+00:00/);
    return true;
  });
  assert.throws(() => resolveFutureTime("2026-10-11T12:00:30Z", "UTC", opts), { code: "INVALID_TIME", message: /too soon/ });
  assert.throws(() => resolveFutureTime("2028-10-11T12:00:00Z", "UTC", opts), { code: "INVALID_TIME", message: /too far ahead/ });
  assert.equal(resolveFutureTime("2026-10-11T12:05:00Z", "UTC", opts).at, now + 5 * MINUTE);
});

// ------------------------------------------------------- scheduling a draft

test("a scheduled draft is never sent by a confirm; its yes schedules it once, for its owner only", async (t) => {
  const { svc, sent } = serviceOn(t, dataDirFor(t));
  const at = Date.now() + 10 * MINUTE;
  const draft = await svc.draft({ kind: "text", chatId: PEER, text: "La mulți ani!" }, OWNER, { at, zone: "Europe/Bucharest" });
  assert.match(draft.preview, /^To: .*\nScheduled: .*\(Europe\/Bucharest, UTC\+0[23]:00\)\n"La mulți ani!"$/);
  assert.equal(draft.time_zone, "Europe/Bucharest");
  assert.equal(Date.parse(draft.send_at), Math.floor(at / 1000) * 1000);

  await assert.rejects(svc.confirm(draft.draft_id, OWNER), { code: "INVALID_ID", message: /scheduled for later; nothing was sent/ });
  await assert.rejects(svc.confirmSchedule(draft.draft_id, "session_b"), { code: "DRAFT_NOT_FOUND" }, "another identity learns nothing");
  const scheduled = await svc.confirmSchedule(draft.draft_id, OWNER);
  assert.equal(scheduled.state, "pending");
  assert.match(scheduled.schedule_id, /^s_[0-9a-f]{16}$/);
  assert.equal(scheduled.to.chat_id, PEER);
  assert.equal(scheduled.already_scheduled, undefined);
  const again = await svc.confirmSchedule(draft.draft_id, OWNER);
  assert.equal(again.schedule_id, scheduled.schedule_id);
  assert.equal(again.already_scheduled, true, "a repeated yes schedules nothing new");
  await assert.rejects(svc.confirmSchedule(draft.draft_id, "session_b"), { code: "DRAFT_NOT_FOUND" });
  await assert.rejects(svc.confirm(draft.draft_id, OWNER), { code: "DRAFT_NOT_FOUND" }, "the draft itself is gone");
  assert.equal(storageRows(svc, "SELECT count(*) AS n FROM sends")[0].n, 0, "no send row until it is due");

  await svc.scheduleIdle();
  assert.equal(sent.length, 0, "nothing goes before its time");
  assert.equal((await svc.listScheduled(true, 10)).length, 1);
});

test("a plain draft is not scheduled, and a time that passed while waiting for the yes is refused, not sent", async (t) => {
  const { svc, sent } = serviceOn(t, dataDirFor(t));
  const plain = await svc.draft({ kind: "text", chatId: PEER, text: "acum" }, OWNER);
  await assert.rejects(svc.confirmSchedule(plain.draft_id, OWNER), { code: "INVALID_ID", message: /carries no send_at/ });
  const soon = await svc.draft({ kind: "text", chatId: PEER, text: "curând" }, OWNER, { at: Date.now() + 30_000, zone: "UTC" });
  await assert.rejects(svc.confirmSchedule(soon.draft_id, OWNER), { code: "INVALID_TIME", message: /has come or passed/ });
  assert.equal(sent.length, 0);
});

test("at its time it is sent once, under the key it was drafted with, and its words are not kept", async (t) => {
  const { svc, sent, clock } = serviceOn(t, dataDirFor(t));
  const { draft, scheduled } = await scheduleText(svc, "Joi la 10.");
  const keyId = storageRows(svc, "SELECT key_id FROM scheduled WHERE id = ?", scheduled.schedule_id)[0].key_id;
  clock.now = Date.parse(scheduled.send_at) + 1_000;
  await svc.scheduleIdle();
  await svc.scheduleIdle();
  assert.equal(sent.length, 1, "sent once, however many passes look");
  assert.equal(sent[0].jid, PEER);
  assert.equal(sent[0].options.messageId, keyId);
  assert.notEqual(keyId, draft.draft_id);
  const row = scheduledRow(svc, scheduled.schedule_id);
  assert.equal(row.state, "sent");
  assert.equal(row.message_id, `true_${PEER}_${keyId}`);
  assert.equal(row.payload, "{}", "the message is in the chat; the row keeps no words");
  const [view] = await svc.listScheduled(true, 10);
  assert.equal(view.state, "sent");
  assert.equal(view.preview, "");
  assert.equal(storageRows(svc, "SELECT state FROM sends WHERE key_id = ?", keyId)[0].state, "sent");
});

test("a service the hub did not enable never sends a scheduled message", async (t) => {
  const { svc, sent, clock } = serviceOn(t, dataDirFor(t), { enable: false });
  const { scheduled } = await scheduleText(svc, "nimic");
  clock.now = Date.parse(scheduled.send_at) + 1_000;
  await svc.scheduleIdle();
  assert.equal(sent.length, 0);
  assert.equal(scheduledRow(svc, scheduled.schedule_id).state, "pending");
});

test("a cancelled message is not sent, and one already sent cannot be cancelled", async (t) => {
  const { svc, sent, clock } = serviceOn(t, dataDirFor(t));
  const first = await scheduleText(svc, "anulat");
  const second = await scheduleText(svc, "trimis", 6 * MINUTE);
  const result = await svc.cancelScheduled(first.scheduled.schedule_id);
  assert.equal(result.cancelled, true);
  assert.equal(result.scheduled.state, "cancelled");
  clock.now = Date.parse(second.scheduled.send_at) + 1_000;
  await svc.scheduleIdle();
  assert.equal(sent.length, 1);
  const late = await svc.cancelScheduled(second.scheduled.schedule_id);
  assert.equal(late.cancelled, false);
  assert.equal(late.scheduled.state, "sent");
  await assert.rejects(svc.cancelScheduled("s_0000000000000000"), { code: "SCHEDULE_NOT_FOUND" });
});

// ------------------------------------------------- every check, at send time

test("send rules written after scheduling refuse it at send time: failed SEND_BLOCKED, nothing sent", async (t) => {
  let record = { ...RECORD };
  const { svc, sent, clock } = serviceOn(t, dataDirFor(t), { record: () => record });
  const { scheduled } = await scheduleText(svc, "Nu pleca.");
  record = { ...RECORD, send_deny: ["40700000002"] };
  clock.now = Date.parse(scheduled.send_at) + 1_000;
  await svc.scheduleIdle();
  assert.equal(sent.length, 0);
  const row = scheduledRow(svc, scheduled.schedule_id);
  assert.equal(row.state, "failed");
  assert.equal(row.error_code, "SEND_BLOCKED");
  assert.equal(storageRows(svc, "SELECT count(*) AS n FROM sends")[0].n, 0, "no send was even drafted");
});

test("an allowlist that no longer names the recipient refuses it too", async (t) => {
  let record = { ...RECORD };
  const { svc, sent, clock } = serviceOn(t, dataDirFor(t), { record: () => record });
  const { scheduled } = await scheduleText(svc, "Pe mâine.");
  record = { ...RECORD, send_allow: ["40700000003"] };
  clock.now = Date.parse(scheduled.send_at) + 1_000;
  await svc.scheduleIdle();
  assert.equal(sent.length, 0);
  assert.equal(scheduledRow(svc, scheduled.schedule_id).error_code, "SEND_BLOCKED");
});

test("writes turned off, the account disabled or removed, or a read-only run: failed READ_ONLY, nothing sent", async (t) => {
  for (const [label, record, config] of [
    ["writes off", () => ({ ...RECORD, writes: false }), {}],
    ["disabled", () => ({ ...RECORD, enabled: false }), {}],
    ["removed", () => undefined, {}],
  ]) {
    const { svc, sent, clock } = serviceOn(t, dataDirFor(t), { record, config });
    const { scheduled } = await scheduleText(svc, label);
    clock.now = Date.parse(scheduled.send_at) + 1_000;
    await svc.scheduleIdle();
    assert.equal(sent.length, 0, label);
    const row = scheduledRow(svc, scheduled.schedule_id);
    assert.deepEqual([row.state, row.error_code], ["failed", "READ_ONLY"], label);
  }
});

test("a server restarted read-only does not send what a writable run scheduled", async (t) => {
  const dataDir = dataDirFor(t);
  const first = serviceOn(t, dataDir);
  const { scheduled } = await scheduleText(first.svc, "Mâine.");
  await first.svc.stop();
  const second = serviceOn(t, dataDir, { config: { readOnly: true } });
  second.clock.now = Date.parse(scheduled.send_at) + 1_000;
  await second.svc.scheduleIdle();
  assert.equal(second.sent.length, 0);
  assert.equal(scheduledRow(second.svc, scheduled.schedule_id).error_code, "READ_ONLY");
});

test("the write rate limit holds at send time: what is over it waits and goes later, within the window", async (t) => {
  const { svc, sent, clock } = serviceOn(t, dataDirFor(t), { config: { rateLimitPerMinute: 1 } });
  const a = await scheduleText(svc, "unu");
  const b = await scheduleText(svc, "doi");
  clock.now = Math.max(Date.parse(a.scheduled.send_at), Date.parse(b.scheduled.send_at)) + 1_000;
  await svc.scheduleIdle();
  assert.equal(sent.length, 1, "one write a minute");
  const waiting = [a, b].map(({ scheduled }) => scheduledRow(svc, scheduled.schedule_id)).find((row) => row.state === "pending");
  assert.equal(waiting.error_code, "RATE_LIMITED");
  assert.ok(waiting.next_attempt_at > clock.now, "it waits");
  assert.equal(storageRows(svc, "SELECT count(*) AS n FROM sends WHERE state = 'draft'")[0].n, 0, "its attempt's draft is gone, the key free");
});

test("while the link is down it waits; past the grace window it is missed with the reason, never sent late", async (t) => {
  const { svc, sent, clock } = serviceOn(t, dataDirFor(t));
  const { scheduled } = await scheduleText(svc, "Ajung la 8.");
  svc.status = "disconnected";
  clock.now = Date.parse(scheduled.send_at) + 1_000;
  await svc.scheduleIdle();
  let row = scheduledRow(svc, scheduled.schedule_id);
  assert.deepEqual([row.state, row.error_code], ["pending", "NOT_CONNECTED"]);
  clock.now = Date.parse(scheduled.send_at) + SCHEDULE_GRACE_MS + 1_000;
  svc.status = "connected";
  await svc.scheduleIdle();
  assert.equal(sent.length, 0, "too late now: not sent");
  row = scheduledRow(svc, scheduled.schedule_id);
  assert.deepEqual([row.state, row.error_code], ["missed", "NOT_CONNECTED"]);
  assert.match(row.error, /not connected/);
  assert.match(svc.getStatus().hint, /1 scheduled message was not sent as planned/);
});

// ------------------------------------------------------------ restarts

test("a restart within the window sends what came due while wazap was down; past it, they are missed, not blasted", async (t) => {
  const dataDir = dataDirFor(t);
  const first = serviceOn(t, dataDir);
  const soon = await scheduleText(first.svc, "în fereastră");
  const old = [];
  for (const text of ["vechi 1", "vechi 2", "vechi 3"]) old.push((await scheduleText(first.svc, text, 2 * MINUTE)).scheduled);
  await first.svc.stop();

  const second = serviceOn(t, dataDir);
  // Down until the old ones' window closed; the soon one's is still open.
  const lastOld = Math.max(...old.map((row) => Date.parse(row.send_at)));
  second.clock.now = lastOld + SCHEDULE_GRACE_MS + 1_000;
  assert.ok(second.clock.now <= Date.parse(soon.scheduled.send_at) + SCHEDULE_GRACE_MS, "and the soon one too");
  await second.svc.scheduleIdle();
  assert.deepEqual(
    second.sent.map((entry) => entry.message.conversation ?? entry.message.extendedTextMessage?.text),
    ["în fereastră"],
    "only the one still inside its window goes"
  );
  for (const row of old) {
    const stored = scheduledRow(second.svc, row.schedule_id);
    assert.deepEqual([stored.state, stored.error_code], ["missed", "NOT_RUNNING"]);
    assert.match(stored.error, /not running/);
  }
});

test("a send a crash left before its key reached WhatsApp goes again; one that may have reached it never does", async (t) => {
  const dataDir = dataDirFor(t);
  const first = serviceOn(t, dataDir, { enable: false });
  const before = await scheduleText(first.svc, "înainte");
  const after = await scheduleText(first.svc, "după");
  const db = first.svc.db;
  // What a crash leaves: the scheduled row sending, its send row a draft (key never left) or sending (it may have).
  const now = Date.now();
  assert.equal(db.schedule.begin(before.scheduled.schedule_id, { draftId: "d_crashbefore0000", owner: `schedule:${before.scheduled.schedule_id}`, expiresAt: now + 15 * MINUTE }, now), true);
  assert.equal(db.schedule.begin(after.scheduled.schedule_id, { draftId: "d_crashafter00000", owner: `schedule:${after.scheduled.schedule_id}`, expiresAt: now + 15 * MINUTE }, now), true);
  assert.equal(db.sends.claim("d_crashafter00000", `schedule:${after.scheduled.schedule_id}`, now), true);
  await first.svc.stop();

  const second = serviceOn(t, dataDir);
  second.clock.now = Math.max(Date.parse(before.scheduled.send_at), Date.parse(after.scheduled.send_at)) + 1_000;
  await second.svc.scheduleIdle();
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0].message.conversation ?? second.sent[0].message.extendedTextMessage?.text, "înainte");
  assert.equal(scheduledRow(second.svc, before.scheduled.schedule_id).state, "sent");
  const unknown = scheduledRow(second.svc, after.scheduled.schedule_id);
  assert.deepEqual([unknown.state, unknown.error_code], ["unknown", "INTERRUPTED"]);
  await second.svc.scheduleIdle();
  assert.equal(second.sent.length, 1, "an unknown send is never retried");
});

test("an unknown scheduled send becomes sent when WhatsApp echoes its key", async (t) => {
  const { svc, sock, clock } = serviceOn(t, dataDirFor(t));
  const { scheduled } = await scheduleText(svc, "ecou");
  const keys = [];
  sock.relayMessage = async (_jid, _message, options) => {
    keys.push(options.messageId);
    throw new Error("Timed Out");
  };
  clock.now = Date.parse(scheduled.send_at) + 1_000;
  await svc.scheduleIdle();
  assert.equal(scheduledRow(svc, scheduled.schedule_id).state, "unknown");
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: PEER, fromMe: true, id: keys[0] }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: "ecou" } }],
  });
  await svc.storageIdle();
  await svc.scheduleIdle();
  const row = scheduledRow(svc, scheduled.schedule_id);
  assert.equal(row.state, "sent");
  assert.equal(row.message_id, `true_${PEER}_${keys[0]}`);
  assert.equal(keys.length, 1);
});

test("a pending scheduled message survives a restart and an account that keeps no history; closed ones lose their words", async (t) => {
  const dataDir = dataDirFor(t);
  const first = serviceOn(t, dataDir, { config: { persistHistory: false } });
  await first.svc.bootStorage();
  const keep = await scheduleText(first.svc, "păstrat");
  const drop = await scheduleText(first.svc, "anulat");
  await first.svc.cancelScheduled(drop.scheduled.schedule_id);
  await first.svc.stop();
  const second = serviceOn(t, dataDir, { config: { persistHistory: false } });
  await second.svc.bootStorage();
  assert.match(scheduledRow(second.svc, keep.scheduled.schedule_id).payload, /păstrat/);
  assert.equal(scheduledRow(second.svc, drop.scheduled.schedule_id).payload, "{}");
  second.clock.now = Date.parse(keep.scheduled.send_at) + 1_000;
  await second.svc.scheduleIdle();
  assert.equal(second.sent.length, 1);
});

test("an outcome is posted once as a scheduled event, with no words, when the webhook asks for it", async (t) => {
  withWebhook(t, "message_received,scheduled");
  const { svc, clock } = serviceOn(t, dataDirFor(t));
  const { scheduled } = await scheduleText(svc, "Secret de stat");
  clock.now = Date.parse(scheduled.send_at) + SCHEDULE_GRACE_MS + 1_000;
  svc.status = "disconnected";
  await svc.scheduleIdle();
  await svc.scheduleIdle();
  const events = storageRows(svc, "SELECT kind, lane, payload FROM events WHERE kind = 'scheduled'");
  assert.equal(events.length, 1, "told once");
  const body = JSON.parse(events[0].payload);
  assert.deepEqual(Object.keys(body).sort(), ["account_id", "account_name", "chat_id", "chat_name", "error", "error_code", "event", "message_id", "schedule_id", "send_at", "state", "timestamp"]);
  assert.equal(body.account_name, "default");
  assert.equal(typeof body.chat_name, "string");
  assert.equal(body.message_id, null);
  assert.equal(body.error_code, "NOT_RUNNING");
  assert.match(body.error, /not running/);
  assert.ok(Math.abs(Date.parse(body.send_at) - Date.parse(scheduled.send_at)) < 1_000, "the instant it was to go");
  assert.ok(Date.parse(body.timestamp) > 0);
  assert.equal(body.event, "scheduled");
  assert.equal(body.state, "missed");
  assert.equal(body.schedule_id, scheduled.schedule_id);
  assert.equal(body.chat_id, PEER);
  assert.doesNotMatch(events[0].payload, /Secret de stat/, "a scheduled event never carries the message");
});

// ------------------------------------------------------------ reminders

test("a due reminder is posted as a reminder event in the transaction that fires it, once", async (t) => {
  withWebhook(t, "reminder");
  const { svc, clock } = serviceOn(t, dataDirFor(t));
  const reminder = await svc.addReminder({ chatId: PEER, note: "Sună-l pe Andrei", condition: "always", dueAt: Date.now() + 2 * MINUTE, timeZone: "UTC" }, OWNER);
  assert.equal(reminder.state, "pending");
  assert.match(reminder.reminder_id, /^r_[0-9a-f]{16}$/);
  await svc.scheduleIdle();
  assert.equal(storageRows(svc, "SELECT count(*) AS n FROM events WHERE kind = 'reminder'")[0].n, 0, "not before its time");
  clock.now = Date.now() + 3 * MINUTE;
  await svc.scheduleIdle();
  await svc.scheduleIdle();
  const events = storageRows(svc, "SELECT payload, lane FROM events WHERE kind = 'reminder'");
  assert.equal(events.length, 1);
  assert.equal(events[0].lane, "reminders");
  const body = JSON.parse(events[0].payload);
  assert.deepEqual([body.event, body.reminder_id, body.chat_id, body.note, body.condition], ["reminder", reminder.reminder_id, PEER, "Sună-l pe Andrei", "always"]);
  assert.deepEqual(Object.keys(body).sort(), ["account_id", "account_name", "chat_id", "chat_name", "condition", "created_at", "due_at", "event", "note", "reminder_id", "timestamp"]);
  assert.equal(body.account_id, "default");
  assert.equal(typeof body.chat_name, "string");
  assert.ok(Date.parse(body.due_at) < Date.parse(body.timestamp));
  assert.ok(Date.parse(body.created_at) <= Date.parse(body.due_at));
  const [listed] = await svc.listReminders(true, 10);
  assert.deepEqual([listed.state, listed.outcome], ["fired", "posted"]);
});

test("a no-reply reminder is skipped once someone wrote in the chat, and fires when only the user did", async (t) => {
  const { svc, sock, clock } = serviceOn(t, dataDirFor(t));
  const answered = await svc.addReminder({ chatId: PEER, note: "a răspuns?", condition: "no_reply", dueAt: Date.now() + 2 * MINUTE, timeZone: "UTC" });
  const silent = await svc.addReminder({ chatId: OTHER, note: "tăcere", condition: "no_reply", dueAt: Date.now() + 2 * MINUTE, timeZone: "UTC" });
  sock.ev.emit("messages.upsert", { type: "notify", messages: [inbound("IN1", "Da, vin.", PEER)] });
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: OTHER, fromMe: true, id: "OWN1" }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: "Ai primit?" } }],
  });
  await svc.storageIdle();
  clock.now = Date.now() + 3 * MINUTE;
  await svc.scheduleIdle();
  const byId = new Map((await svc.listReminders(true, 10)).map((row) => [row.reminder_id, row]));
  assert.deepEqual([byId.get(answered.reminder_id).state, byId.get(answered.reminder_id).outcome], ["skipped", "replied"]);
  assert.deepEqual([byId.get(silent.reminder_id).state, byId.get(silent.reminder_id).outcome], ["fired", "webhook_off"]);
});

test("an old message filed late does not count as a reply", async (t) => {
  const { svc, sock, clock } = serviceOn(t, dataDirFor(t));
  const reminder = await svc.addReminder({ chatId: PEER, note: "vechi", condition: "no_reply", dueAt: Date.now() + 2 * MINUTE, timeZone: "UTC" });
  // A history batch delivers a message from yesterday after the reminder was set.
  sock.ev.emit("messages.upsert", { type: "append", messages: [inbound("OLD1", "ieri", PEER, Date.now() - 86_400_000)] });
  await svc.storageIdle();
  clock.now = Date.now() + 3 * MINUTE;
  await svc.scheduleIdle();
  const [row] = await svc.listReminders(true, 10);
  assert.equal(row.reminder_id, reminder.reminder_id);
  assert.equal(row.state, "fired");
});

test("a no-reply reminder waits while the link is down, so a reply on its way is not missed", async (t) => {
  const { svc, clock } = serviceOn(t, dataDirFor(t));
  await svc.addReminder({ chatId: PEER, note: "așteaptă", condition: "no_reply", dueAt: Date.now() + 2 * MINUTE, timeZone: "UTC" });
  svc.status = "disconnected";
  clock.now = Date.now() + 3 * MINUTE;
  await svc.scheduleIdle();
  assert.equal((await svc.listReminders(true, 10))[0].state, "pending");
});

test("reminders survive a restart and can be cancelled", async (t) => {
  const dataDir = dataDirFor(t);
  const first = serviceOn(t, dataDir);
  const keep = await first.svc.addReminder({ chatId: PEER, note: "rămâne", condition: "always", dueAt: Date.now() + 5 * MINUTE, timeZone: "UTC" });
  const drop = await first.svc.addReminder({ chatId: PEER, note: "pleacă", condition: "always", dueAt: Date.now() + 5 * MINUTE, timeZone: "UTC" });
  await first.svc.stop();
  const second = serviceOn(t, dataDir);
  assert.equal((await second.svc.cancelReminder(drop.reminder_id)).cancelled, true);
  assert.equal((await second.svc.cancelReminder(drop.reminder_id)).cancelled, false);
  await assert.rejects(second.svc.cancelReminder("r_missing"), { code: "SCHEDULE_NOT_FOUND" });
  second.clock.now = Date.now() + 6 * MINUTE;
  await second.svc.scheduleIdle();
  const states = new Map((await second.svc.listReminders(true, 10)).map((row) => [row.reminder_id, row.state]));
  assert.equal(states.get(keep.reminder_id), "fired");
  assert.equal(states.get(drop.reminder_id), "cancelled");
});

// ------------------------------------------------------------ the tools

test("send_message with send_at drafts for later; confirm_send schedules it and says so", async (t) => {
  const { svc, sent } = serviceOn(t, dataDirFor(t));
  const { call } = schemaCheckedTools(svc);
  const at = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16);
  const draft = await call("send_message", { chat_id: PEER, text: "Bună dimineața", send_at: at, time_zone: "UTC" });
  assert.equal(draft.isError, undefined, draft.content[0].text);
  assert.equal(draft.structuredContent.time_zone, "UTC");
  assert.equal(draft.structuredContent.send_at, `${at}:00+00:00`);
  assert.match(draft.content[0].text, /Scheduled: .* \(UTC, UTC\+00:00\)/);
  assert.match(draft.structuredContent.next, /this time/);
  const confirmed = await call("confirm_send", { draft_id: draft.structuredContent.draft_id });
  assert.equal(confirmed.isError, undefined, confirmed.content[0].text);
  assert.equal(confirmed.structuredContent.status, "scheduled");
  assert.match(confirmed.content[0].text, /Nothing was sent yet/);
  assert.equal(sent.length, 0);
  const again = await call("confirm_send", { draft_id: draft.structuredContent.draft_id });
  assert.equal(again.structuredContent.already_scheduled, true);

  const list = await call("scheduled_messages", {});
  assert.equal(list.structuredContent.count, 1);
  const cancel = await call("scheduled_messages", { action: "cancel", schedule_id: confirmed.structuredContent.schedule_id });
  assert.equal(cancel.structuredContent.cancelled, true);
});

test("send_at in the past, a bad zone, or time_zone alone is refused before anything is drafted", async (t) => {
  const { svc } = serviceOn(t, dataDirFor(t));
  const { call } = schemaCheckedTools(svc);
  for (const args of [
    { send_at: "2020-01-01T09:00", time_zone: "UTC" },
    { send_at: "2030-01-01T09:00", time_zone: "Nowhere/City" },
    { time_zone: "UTC" },
  ]) {
    const result = await call("send_message", { chat_id: PEER, text: "x", ...args });
    assert.equal(JSON.parse(result.content[0].text).error, "INVALID_TIME", JSON.stringify(args));
  }
  assert.equal(storageRows(svc, "SELECT count(*) AS n FROM sends")[0].n, 0);
});

test("a session without writes has no scheduling tools; reminders follow remember's rule", async (t) => {
  const { svc } = serviceOn(t, dataDirFor(t));
  const reader = schemaCheckedTools(svc, { allowWrite: false, allowLocalEdits: false });
  assert.equal(reader.tools.has("scheduled_messages"), false);
  assert.equal(reader.tools.has("send_message"), false);
  assert.equal(reader.tools.has("confirm_send"), false);
  assert.equal(reader.tools.has("reminder"), true);
  const refused = await reader.call("reminder", { action: "create", chat_id: PEER, note: "x", after_hours: 1 });
  assert.equal(textError(refused).error, "READ_ONLY");
  const listed = await reader.call("reminder", { action: "list" });
  assert.equal(listed.isError, undefined);

  const writer = schemaCheckedTools(svc, { allowWrite: false, allowLocalEdits: true });
  const made = await writer.call("reminder", { action: "create", chat_id: PEER, note: "Întreabă de factură", after_hours: 48, condition: "no_reply" });
  assert.equal(made.isError, undefined, made.content[0].text);
  assert.equal(made.structuredContent.reminders[0].condition, "no_reply");
  assert.match(made.structuredContent.notes[0], /No webhook/);
  const due = Date.parse(made.structuredContent.reminders[0].due_at);
  assert.ok(Math.abs(due - (Date.now() + 48 * 3_600_000)) < 5_000);
  for (const args of [{ action: "create", chat_id: PEER, note: "x" }, { action: "create", chat_id: PEER, note: "x", after_hours: 1, due_at: "2030-01-01T09:00" }]) {
    assert.equal(textError(await writer.call("reminder", args)).error, "INVALID_TIME");
  }
});

test("a read-only account refuses scheduled_messages like every write", async (t) => {
  const { svc } = serviceOn(t, dataDirFor(t), { config: { readOnly: true } });
  const { call } = schemaCheckedTools(svc);
  const result = await call("scheduled_messages", {});
  assert.equal(textError(result).error, "READ_ONLY");
});

// ------------------------------------------------- what the review found

test("an offset time names a real day: no 31 February, no 24:00, no rolling over", () => {
  const now = Date.UTC(2026, 0, 1);
  for (const bad of ["2026-02-31T09:00Z", "2026-02-30T09:00:00+02:00", "2026-10-12T24:00Z", "2026-10-12T09:60:00+03:00", "2026-10-12T09:00+15:00"]) {
    assert.throws(() => resolveTime(bad, "UTC", now), { code: "INVALID_TIME" }, bad);
  }
  assert.equal(resolveTime("2026-10-12T09:00:00.750+03:00", "UTC", now).iso, "2026-10-12T06:00:00+00:00", "whole seconds, as the preview shows");
  assert.equal(resolveTime("2026-10-12T09:00+0300", "UTC", now).at, Date.UTC(2026, 9, 12, 6, 0));
});

test("media for later must be a file, pinned by its hash: a URL is refused, a changed file is not sent", async (t) => {
  const { svc, sent, clock } = serviceOn(t, dataDirFor(t));
  const dir = dataDirFor(t);
  const same = join(dir, "same.txt");
  const changed = join(dir, "changed.txt");
  writeFileSync(same, "factura 1");
  writeFileSync(changed, "factura 2");
  const at = Date.now() + 5 * MINUTE;
  const media = (source) => ({ kind: "media", chatId: PEER, source, asDocument: true, asVoice: false, asGif: false });
  await assert.rejects(svc.draft(media({ url: "https://example.com/a.pdf" }), OWNER, { at, zone: "UTC" }), { code: "INVALID_TIME", message: /URL/ });
  const keep = await svc.confirmSchedule((await svc.draft(media({ file_path: same }), OWNER, { at, zone: "UTC" })).draft_id, OWNER);
  const swap = await svc.confirmSchedule((await svc.draft(media({ file_path: changed }), OWNER, { at, zone: "UTC" })).draft_id, OWNER);
  writeFileSync(changed, "altceva");
  clock.now = at + 1_000;
  await svc.scheduleIdle();
  assert.equal(sent.length, 1, "only the file that is still what was approved goes");
  assert.equal(scheduledRow(svc, keep.schedule_id).state, "sent");
  const refused = scheduledRow(svc, swap.schedule_id);
  assert.deepEqual([refused.state, refused.error_code], ["failed", "FILE_NOT_FOUND"]);
  assert.match(refused.error, /changed since/);
});

test("an account that keeps no history refuses a reply or a forward for later", async (t) => {
  const { svc, sock } = serviceOn(t, dataDirFor(t), { config: { persistHistory: false } });
  sock.ev.emit("messages.upsert", { type: "notify", messages: [inbound("Q1", "Vii?")] });
  await svc.storageIdle();
  const at = Date.now() + 5 * MINUTE;
  const original = `false_${PEER}_Q1`;
  await assert.rejects(svc.draft({ kind: "text", chatId: PEER, text: "Da", replyTo: original }, OWNER, { at, zone: "UTC" }), { code: "INVALID_TIME", message: /keeps no history/ });
  await assert.rejects(svc.draft({ kind: "forward", chatId: OTHER, messageId: original }, OWNER, { at, zone: "UTC" }), { code: "INVALID_TIME" });
  assert.equal((await svc.draft({ kind: "text", chatId: PEER, text: "Da", replyTo: original }, OWNER)).kind, "text", "now is fine");
});

test("waiting on the rate limit does not use up attempts: it waits for the limiter, inside the window", async (t) => {
  const { svc, sent, clock } = serviceOn(t, dataDirFor(t), { config: { rateLimitPerMinute: 1 } });
  const first = await scheduleText(svc, "primul");
  const second = await scheduleText(svc, "al doilea");
  // As if it had already been tried and refused many times.
  const db = svc.db;
  for (let i = 0; i < 12; i++) {
    assert.equal(db.schedule.begin(second.scheduled.schedule_id, { draftId: `d_bump${i}`, owner: "x", expiresAt: Date.now() + MINUTE }, Date.now()), true);
    assert.equal(db.schedule.retry(second.scheduled.schedule_id, `d_bump${i}`, 0, "TIMEOUT", "x", Date.now()), true);
  }
  clock.now = Math.max(Date.parse(first.scheduled.send_at), Date.parse(second.scheduled.send_at)) + 1_000;
  await svc.scheduleIdle();
  assert.equal(sent.length, 1);
  const waiting = [first, second].map(({ scheduled }) => scheduledRow(svc, scheduled.schedule_id)).find((row) => row.state !== "sent");
  assert.deepEqual([waiting.state, waiting.error_code], ["pending", "RATE_LIMITED"], "still waiting, not missed or failed");
  assert.equal(waiting.attempts, waiting.id === second.scheduled.schedule_id ? 12 : 0, "a wait is not an attempt");
  assert.ok(waiting.next_attempt_at - clock.now >= 30_000, "after the wait the limiter named");
});

test("a late answer from an attempt that was taken over changes nothing", async (t) => {
  const { svc } = serviceOn(t, dataDirFor(t), { enable: false });
  const { scheduled } = await scheduleText(svc, "preluat");
  const db = svc.db;
  const now = Date.now();
  assert.equal(db.schedule.begin(scheduled.schedule_id, { draftId: "d_first00000000000", owner: "x", expiresAt: now + MINUTE }, now), true);
  assert.equal(db.schedule.retry(scheduled.schedule_id, "d_first00000000000", now, "INTERRUPTED", "x", now), true);
  assert.equal(db.schedule.begin(scheduled.schedule_id, { draftId: "d_second0000000000", owner: "x", expiresAt: now + MINUTE }, now), true);
  assert.equal(db.schedule.finish(scheduled.schedule_id, "d_first00000000000", "failed", { errorCode: "X" }, now), false);
  assert.equal(db.schedule.retry(scheduled.schedule_id, "d_first00000000000", now, "X", "x", now), false);
  assert.equal(storageRows(svc, "SELECT count(*) AS n FROM sends WHERE draft_id = 'd_second0000000000'")[0].n, 1, "the live attempt's draft stays");
  assert.equal(scheduledRow(svc, scheduled.schedule_id).send_id, "d_second0000000000");
});

test("a row the database refuses closes as failed and does not hold up the others", async (t) => {
  const { svc, sent, clock } = serviceOn(t, dataDirFor(t));
  const bad = await scheduleText(svc, "stricat");
  const good = await scheduleText(svc, "bun", 6 * MINUTE);
  const db = svc.db;
  const begin = db.schedule.begin.bind(db.schedule);
  db.schedule.begin = (id, ...rest) => {
    if (id === bad.scheduled.schedule_id) throw new Error("SQLITE_BUSY");
    return begin(id, ...rest);
  };
  clock.now = Date.parse(good.scheduled.send_at) + 1_000;
  await svc.scheduleIdle();
  assert.equal(sent.length, 1);
  assert.equal(scheduledRow(svc, good.scheduled.schedule_id).state, "sent");
  assert.deepEqual([scheduledRow(svc, bad.scheduled.schedule_id).state, scheduledRow(svc, bad.scheduled.schedule_id).error_code], ["failed", "SERVICE_ERROR"]);
});

test("on an account that keeps no history, a reply that arrived before a restart still skips a no-reply reminder", async (t) => {
  const dataDir = dataDirFor(t);
  const first = serviceOn(t, dataDir, { config: { persistHistory: false } });
  await first.svc.bootStorage();
  const reminder = await first.svc.addReminder({ chatId: PEER, note: "a răspuns?", condition: "no_reply", dueAt: Date.now() + 2 * MINUTE, timeZone: "UTC" });
  first.sock.ev.emit("messages.upsert", { type: "notify", messages: [inbound("R1", "Da.")] });
  await first.svc.storageIdle();
  await first.svc.stop();
  const second = serviceOn(t, dataDir, { config: { persistHistory: false } });
  await second.svc.bootStorage();
  assert.equal(storageRows(second.svc, "SELECT count(*) AS n FROM messages")[0].n, 0, "the reply itself is gone");
  second.clock.now = Date.now() + 3 * MINUTE;
  await second.svc.scheduleIdle();
  const [row] = await second.svc.listReminders(true, 10);
  assert.equal(row.reminder_id, reminder.reminder_id);
  assert.deepEqual([row.state, row.outcome], ["skipped", "replied"]);
});

test("a send that keeps failing is given up as failed after ten attempts, saying so", async (t) => {
  const { svc, clock } = serviceOn(t, dataDirFor(t));
  const { scheduled } = await scheduleText(svc, "insistent");
  const db = svc.db;
  for (let i = 0; i < 9; i++) {
    assert.equal(db.schedule.begin(scheduled.schedule_id, { draftId: `d_try${i}`, owner: "x", expiresAt: Date.now() + MINUTE }, Date.now()), true);
    assert.equal(db.schedule.retry(scheduled.schedule_id, `d_try${i}`, 0, "TIMEOUT", "x", Date.now()), true);
  }
  // Fails before the key leaves, with a refusal that may pass but is not a wait.
  svc.schedule.host.confirm = async () => {
    throw new WazapError("TIMEOUT", "WhatsApp did not answer.");
  };
  clock.now = Date.parse(scheduled.send_at) + 1_000;
  await svc.scheduleIdle();
  const row = scheduledRow(svc, scheduled.schedule_id);
  assert.equal(row.attempts, 10);
  assert.equal(row.state, "failed");
  assert.match(row.error, /Gave up after 10 attempts/);
});

test("nothing leaves once its window closed while it was being built, and the draft is given back", async (t) => {
  const { svc, sent } = serviceOn(t, dataDirFor(t), { enable: false });
  const draft = await svc.draft({ kind: "text", chatId: PEER, text: "prea târziu" }, OWNER, { at: Date.now() + 5 * MINUTE, zone: "UTC" });
  await assert.rejects(svc.sends.confirm(draft.draft_id, OWNER, { scheduled: true, notAfter: Date.now() - 1 }), { code: "TIMEOUT" });
  assert.equal(sent.length, 0);
  assert.equal(storageRows(svc, "SELECT state FROM sends WHERE draft_id = ?", draft.draft_id)[0].state, "draft", "not dispatched: given back");
});

test("an account that keeps no history keeps a scheduled message's attempt draft, so a crash before its claim retries it", async (t) => {
  const { svc } = serviceOn(t, dataDirFor(t), { enable: false });
  const { scheduled } = await scheduleText(svc, "încercare");
  const db = svc.db;
  const now = Date.now();
  assert.equal(db.schedule.begin(scheduled.schedule_id, { draftId: "d_attempt000000000", owner: `schedule:${scheduled.schedule_id}`, expiresAt: now + MINUTE }, now), true);
  const plain = await svc.draft({ kind: "text", chatId: PEER, text: "ciornă" }, OWNER);
  db.sends.forgetWords();
  assert.equal(db.sends.get(plain.draft_id), null, "an ordinary draft goes");
  assert.equal(db.sends.get("d_attempt000000000")?.state, "draft", "the attempt stays, so recovery knows its key never left");
});

test("an attempt whose send row is gone within the window never left: it goes again, whatever an earlier claim recorded", async (t) => {
  const dataDir = dataDirFor(t);
  const first = serviceOn(t, dataDir, { enable: false });
  const { scheduled } = await scheduleText(first.svc, "din nou");
  const db = first.svc.db;
  const owner = `schedule:${scheduled.schedule_id}`;
  const now = Date.now();
  // An earlier attempt claimed and gave back (its key is in sent_keys), then a later one whose draft vanished.
  assert.equal(db.schedule.begin(scheduled.schedule_id, { draftId: "d_earlier00000000", owner, expiresAt: now + MINUTE }, now), true);
  assert.equal(db.sends.claim("d_earlier00000000", owner, now), true);
  assert.equal(db.sends.release("d_earlier00000000", now), true);
  assert.equal(db.schedule.retry(scheduled.schedule_id, "d_earlier00000000", now, "RATE_LIMITED", "x", now, false), true);
  assert.equal(db.schedule.begin(scheduled.schedule_id, { draftId: "d_vanished0000000", owner, expiresAt: now + MINUTE }, now), true);
  db.sends.removeDraft("d_vanished0000000");
  assert.equal(db.sends.wasSent(scheduledRow(first.svc, scheduled.schedule_id).key_id), true);
  await first.svc.stop();

  const second = serviceOn(t, dataDir);
  second.clock.now = Date.parse(scheduled.send_at) + 1_000;
  await second.svc.scheduleIdle();
  assert.equal(second.sent.length, 1);
  assert.equal(scheduledRow(second.svc, scheduled.schedule_id).state, "sent");
});
