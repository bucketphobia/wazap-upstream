/**
 * read_messages over a time window (since, until), read the way search reads
 * them: one call for "what did Ana send yesterday", the window's own paging
 * with before, and an answer that says when the stored history starts inside
 * the window instead of reading as the chat's start.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { WhatsAppService } from "../dist/whatsapp.js";
import { clockAtHour, connectedService, schemaCheckedTools, textError } from "./helpers.mjs";

clockAtHour(12);

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAY = 86_400_000;

/** A local day's date, YYYY-MM-DD, `days` from today. */
function dayOf(days) {
  const at = new Date(Date.now() + days * DAY);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

function setup(t) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-window-", id: ME, name: "Răzvan" });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Ana" }]);
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  let seq = 0;
  const arrive = (text, at, content) => {
    const id = `M${++seq}`;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{ key: { remoteJid: ANA, fromMe: false, id }, message: content ?? { conversation: text }, messageTimestamp: Math.floor(at / 1000) }],
    });
    return `false_${ANA}_${id}`;
  };
  return { svc, sock, call, arrive };
}

test("since and until read one window, oldest to newest, a bare date meaning its whole day", async (t) => {
  const { call, arrive } = setup(t);
  const today = new Date(`${dayOf(0)}T12:00:00`).getTime();
  arrive("acum trei zile", today - 3 * DAY);
  arrive("ieri dimineață", today - DAY - 3 * 3_600_000);
  arrive("ieri seară", today - DAY + 9 * 3_600_000);
  arrive("azi", today - 3_600_000);
  const yesterday = dayOf(-1);
  const result = await call("read_messages", { chat_id: ANA, since: yesterday, until: yesterday });
  const out = result.structuredContent;
  assert.deepEqual(out.messages.map((m) => m.text), ["ieri dimineață", "ieri seară"]);
  assert.equal(Date.parse(out.since), new Date(`${yesterday}T00:00:00`).getTime());
  assert.equal(Date.parse(out.until), new Date(`${yesterday}T23:59:59`).getTime(), "the whole day, to the second");
  assert.equal(out.more_in_window, undefined);
  assert.match(result.content[0].text, new RegExp(`\\(since ${yesterday}, until ${yesterday}\\)`));

  const fromYesterday = await call("read_messages", { chat_id: ANA, since: `${yesterday}T12:00` });
  assert.deepEqual(fromYesterday.structuredContent.messages.map((m) => m.text), ["ieri seară", "azi"]);
  const untilYesterday = await call("read_messages", { chat_id: ANA, until: yesterday, limit: 5 });
  assert.deepEqual(untilYesterday.structuredContent.messages.map((m) => m.text), ["acum trei zile", "ieri dimineață", "ieri seară"]);
  assert.equal(untilYesterday.structuredContent.unconfirmed_sends, undefined);
});

test("hours reads the last hours of a chat as a window, and is refused beside since", async (t) => {
  const { call, arrive } = setup(t);
  arrive("ieri", Date.now() - 26 * 3_600_000);
  arrive("acum trei ore", Date.now() - 3 * 3_600_000);
  arrive("acum o oră", Date.now() - 3_600_000);
  const result = await call("read_messages", { chat_id: ANA, hours: 2 });
  assert.deepEqual(result.structuredContent.messages.map((m) => m.text), ["acum o oră"]);
  assert.ok(Math.abs(Date.parse(result.structuredContent.since) - (Date.now() - 2 * 3_600_000)) < 5000, "echoed as the window it is");
  assert.match(result.content[0].text, /\(last 2h\)/);
  const day = await call("read_messages", { chat_id: ANA, hours: 24 });
  assert.deepEqual(day.structuredContent.messages.map((m) => m.text), ["acum trei ore", "acum o oră"]);

  const both = await call("read_messages", { chat_id: ANA, hours: 2, since: dayOf(-1) });
  assert.equal(textError(both).error, "INVALID_ID");
  assert.match(textError(both).message, /hours and since/);
});

test("a window holding more than limit says so, and before pages on inside it without asking the phone", async (t) => {
  const { call, arrive, sock } = setup(t);
  let asked = 0;
  sock.fetchMessageHistory = async () => {
    asked++;
    return "history";
  };
  const start = Date.now() - 2 * DAY;
  arrive("înainte de fereastră", start - DAY);
  for (let i = 0; i < 5; i++) arrive(`în fereastră ${i}`, start + i * 60_000);
  const since = new Date(start - 1000).toISOString();
  const first = await call("read_messages", { chat_id: ANA, since, limit: 3 });
  assert.deepEqual(first.structuredContent.messages.map((m) => m.text), ["în fereastră 2", "în fereastră 3", "în fereastră 4"]);
  assert.equal(first.structuredContent.more_in_window, true);
  assert.ok(first.structuredContent.notes.some((note) => /holds older messages than these: read_messages again with before/.test(note)));

  const second = await call("read_messages", { chat_id: ANA, since, limit: 3, before: first.structuredContent.messages[0].message_id });
  assert.deepEqual(second.structuredContent.messages.map((m) => m.text), ["în fereastră 0", "în fereastră 1"]);
  assert.equal(second.structuredContent.more_in_window, undefined);
  const past = await call("read_messages", { chat_id: ANA, since, before: second.structuredContent.messages[0].message_id });
  assert.equal(past.structuredContent.count, 0);
  assert.equal(past.structuredContent.older, undefined, "the window's start is stored: nothing to ask the phone");
  assert.equal(asked, 0);
});

test("a window that reaches before the stored history says where it starts, and before then asks the phone", async (t) => {
  const { call, arrive, sock } = setup(t);
  const asked = [];
  sock.fetchMessageHistory = async (count, key) => {
    asked.push(key.id);
    setImmediate(() => sock.ev.emit("messaging-history.set", { chats: [], contacts: [], messages: [], isLatest: false }));
    return "history";
  };
  const first = arrive("primul mesaj stocat", Date.now() - DAY);
  arrive("al doilea", Date.now() - DAY + 60_000);
  const result = await call("read_messages", { chat_id: ANA, since: dayOf(-10) });
  assert.equal(result.structuredContent.count, 2);
  assert.ok(result.structuredContent.notes.some((note) => /stored history of this chat starts at .* inside the window: read_messages again with before "false_.*_M1"/.test(note)));
  const before = await call("read_messages", { chat_id: ANA, since: dayOf(-10), until: dayOf(-5) });
  assert.equal(before.structuredContent.count, 0);
  assert.ok(before.structuredContent.notes.some((note) => /No message of this chat is stored in this window .*starts after it.*do not say there are none\. read_messages again with before "false_.*_M1"/.test(note)));
  const older = await call("read_messages", { chat_id: ANA, since: dayOf(-10), before: first });
  assert.deepEqual(asked, ["M1"], "nothing older is stored, so the phone is asked");
  assert.deepEqual(older.structuredContent.older, { asked_phone: true, received: 0 });
  assert.equal(older.structuredContent.notes.some((note) => /read_messages again with before/.test(note)), false, "the phone was just asked from there: no hint to ask it again");
});

test("before inside a window asks the phone from the chat's oldest stored message, whatever id it names", async (t) => {
  const { call, arrive, sock } = setup(t);
  const asked = [];
  sock.fetchMessageHistory = async (count, key) => {
    asked.push(key.id);
    setImmediate(() => sock.ev.emit("messaging-history.set", { chats: [], contacts: [], messages: [], isLatest: false }));
    return "history";
  };
  const firstAt = Date.now() - DAY;
  arrive("primul mesaj stocat", firstAt);
  const photo = arrive("", firstAt + 60_000, { imageMessage: { mimetype: "image/jpeg", caption: "bonul" } });
  const today = arrive("de azi", Date.now() - 60_000);

  // With types, the oldest photo is not where the stored history starts: the note names the message that is.
  const photos = await call("read_messages", { chat_id: ANA, since: dayOf(-10), types: ["image"] });
  assert.deepEqual(photos.structuredContent.messages.map((m) => m.message_id), [photo]);
  const note = photos.structuredContent.notes.find((n) => /starts at \S+, inside the window/.test(n));
  assert.ok(note?.includes(`before "false_${ANA}_M1"`), JSON.stringify(photos.structuredContent.notes));
  assert.equal(Date.parse(/starts at (\S+), inside/.exec(note)[1]), Math.floor(firstAt / 1000) * 1000, "the first stored message's time, not the photo's");
  const fromPhoto = await call("read_messages", { chat_id: ANA, since: dayOf(-10), types: ["image"], before: photo });
  assert.deepEqual(asked, ["M1"], "the photo's id, followed as the window note says, asks the phone");
  assert.deepEqual(fromPhoto.structuredContent.older, { asked_phone: true, received: 0 });

  // An id newer than the window (this morning's), the only one an agent may hold: the phone is still asked, from the stored start.
  const window = { since: dayOf(-10), until: dayOf(-5) };
  const fromToday = await call("read_messages", { chat_id: ANA, ...window, before: today });
  assert.deepEqual(asked, ["M1", "M1"]);
  assert.equal(fromToday.structuredContent.count, 0);
  assert.ok(fromToday.structuredContent.notes.some((note) => /The phone was asked for older messages and sent none/.test(note)));

  // A window whose start is stored still ends where it does: nothing outside it is asked for.
  const inside = await call("read_messages", { chat_id: ANA, since: new Date(Date.now() - DAY + 30_000).toISOString(), types: ["image"], before: photo });
  assert.equal(inside.structuredContent.count, 0);
  assert.equal(inside.structuredContent.older, undefined);
  assert.deepEqual(asked, ["M1", "M1"]);
});

test("a window with only until reaches back to the chat's start: before the stored history it says so, and how to ask the phone", async (t) => {
  const { call, arrive } = setup(t);
  arrive("primul mesaj stocat", Date.now() - DAY);
  const empty = await call("read_messages", { chat_id: ANA, until: dayOf(-10) });
  assert.equal(empty.structuredContent.count, 0);
  const note = empty.structuredContent.notes.find((n) => /No message of this chat is stored in this window \(until /.test(n));
  assert.ok(note, JSON.stringify(empty.structuredContent.notes));
  assert.match(note, /starts after it, .* do not say there are none\. read_messages again with before "false_40700000002@s\.whatsapp\.net_M1"/);
  // The note is in the text word for word, on the line after the title.
  assert.match(empty.content[0].text, /no messages found\.\nNo message of this chat is stored/);
  assert.ok(empty.content[0].text.includes(note));
  const whole = await call("read_messages", { chat_id: ANA, until: dayOf(0) });
  assert.equal(whole.structuredContent.count, 1);
  assert.ok(whole.structuredContent.notes.some((n) => /stored history of this chat starts at .*, inside the window: read_messages again with before/.test(n)));
});

test("since before 1970 reads from 1970, and one past what can be stored is refused as a bad argument", async (t) => {
  const { call, arrive } = setup(t);
  arrive("salut", Date.now() - DAY);
  for (const since of ["1969-12-31", "1970-01-01", "1970-01-01T00:00:00Z"]) {
    const read = await call("read_messages", { chat_id: ANA, since });
    assert.equal(read.isError, undefined, read.content[0].text);
    assert.equal(read.structuredContent.count, 1, since);
  }
  const refused = textError(await call("read_messages", { chat_id: ANA, since: "2300-01-01" }));
  assert.equal(refused.error, "INVALID_ID");
  assert.match(refused.message, /past 2242/);
});

test("a window is refused where it cannot apply, and read the way search reads it", async (t) => {
  const { call } = setup(t);
  for (const [args, code, pattern] of [
    [{ chat_id: ANA, since: dayOf(0), until: dayOf(-1) }, "INVALID_ID", /is after until/],
    [{ chat_id: ANA, since: "yesterday" }, "INVALID_ID", /since is not a date/],
    [{ chat_id: "status", since: dayOf(-1) }, "INVALID_ID", /Stories are read by hours/],
  ]) {
    const refused = textError(await call("read_messages", args));
    assert.equal(refused.error, code);
    assert.match(refused.message, pattern);
  }
});

test("a window and types together: what Ana sent as photos and documents yesterday, in one call", async (t) => {
  const { call, arrive } = setup(t);
  const yesterday = new Date(`${dayOf(-1)}T10:00:00`).getTime();
  arrive("text de ieri", yesterday);
  const photo = arrive("", yesterday + 60_000, { imageMessage: { mimetype: "image/jpeg", caption: "bonul" } });
  const pdf = arrive("", yesterday + 120_000, { documentMessage: { mimetype: "application/pdf", fileName: "extras.pdf" } });
  arrive("", Date.now() - 60_000, { imageMessage: { mimetype: "image/jpeg", caption: "de azi" } });
  const result = await call("read_messages", { chat_id: ANA, since: dayOf(-1), until: dayOf(-1), types: ["image", "document"] });
  assert.deepEqual(result.structuredContent.messages.map((m) => m.message_id), [photo, pdf]);
});

test("types past the bound of one read's walk: the answer says it stopped and where to go on, never a complete-looking none", async (t) => {
  const { call, arrive, sock } = setup(t);
  const asked = [];
  sock.fetchMessageHistory = async (count, key) => {
    asked.push(key.id);
    setImmediate(() => sock.ev.emit("messaging-history.set", { chats: [], contacts: [], messages: [], isLatest: false }));
    return "history";
  };
  const start = Date.now() - 20 * DAY;
  arrive("înainte de fereastră", start - DAY);
  const first = arrive("", start + 1_000, { imageMessage: { mimetype: "image/jpeg", caption: "contorul" } });
  // More texts after it than one read walks past a type filter (10,000).
  for (let batch = 0; batch < 21; batch++) {
    const messages = Array.from({ length: 500 }, (_, i) => ({
      key: { remoteJid: ANA, fromMe: false, id: `T${batch}-${i}` },
      message: { conversation: `text ${batch}-${i}` },
      messageTimestamp: Math.floor((start + 60_000 + (batch * 500 + i) * 1_000) / 1_000),
    }));
    sock.ev.emit("messages.upsert", { type: "append", messages });
  }
  const last = arrive("", Date.now() - 60_000, { imageMessage: { mimetype: "image/jpeg", caption: "de azi" } });
  const since = new Date(start).toISOString();

  // The newest photo fills the page; the probe for one more stops at the bound: more_in_window, not a finished window.
  const page = await call("read_messages", { chat_id: ANA, since, types: ["image"], limit: 1 });
  assert.deepEqual(page.structuredContent.messages.map((m) => m.message_id), [last]);
  assert.equal(page.structuredContent.more_in_window, true);

  // Paging on from it walks to the bound and finds no photo: an empty page that says so, with the id to go on from.
  const stopped = await call("read_messages", { chat_id: ANA, since, types: ["image"], before: last });
  assert.equal(stopped.structuredContent.count, 0);
  assert.equal(stopped.structuredContent.more_in_window, true);
  assert.equal(stopped.structuredContent.older, undefined, "older messages are stored: the phone is not asked");
  const note = stopped.structuredContent.notes.find((n) => /stopped before the window's start/.test(n));
  assert.ok(note, JSON.stringify(stopped.structuredContent.notes));
  const from = /before "([^"]+)"/.exec(note)[1];
  assert.match(stopped.content[0].text, /no messages found\.\n.*stopped before the window's start: older messages may match/);
  assert.ok(stopped.content[0].text.includes(note));
  const rest = await call("read_messages", { chat_id: ANA, since, types: ["image"], before: from });
  assert.deepEqual(rest.structuredContent.messages.map((m) => m.message_id), [first]);
  assert.equal(rest.structuredContent.more_in_window, undefined);
  assert.equal(rest.structuredContent.notes, undefined);

  // The same walk from the newest, a window or none: told, and never the phone asked while older messages are stored.
  const window = await call("read_messages", { chat_id: ANA, since, types: ["image"], before: last, limit: 5 });
  assert.equal(window.structuredContent.more_in_window, true);
  const whole = await call("read_messages", { chat_id: ANA, types: ["image"], before: last });
  assert.equal(whole.structuredContent.count, 0);
  assert.equal(whole.structuredContent.more_in_window, undefined);
  assert.ok(whole.structuredContent.notes.some((n) => n.includes(`stopped before the chat's start: older messages may match. read_messages again with before "${from}"`)));
  assert.deepEqual(asked, []);
});
