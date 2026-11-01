/**
 * Schema v7, the order messages changed in (messages.change_seq, read by
 * new_since): the backfill of a file of an earlier version, the triggers that
 * give a message a new number when it is stored and when what a reader sees of
 * it changes, and the read off the index.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { proto } from "baileys";

import { AccountDb, SCHEMA_VERSION } from "../dist/db/index.js";
import { contentHashOf } from "../dist/message-content-hash.js";
import { scrubQuote } from "../dist/legacy-import/index.js";
import { MIGRATIONS } from "../dist/db/schema.js";
import { sqlite } from "../dist/db/sqlite.js";
import { ME, PEER, PEER_LID, T0, openTemp, tempDir, textMessage } from "./db-fixtures.mjs";

const SEQ = 1048576;
const idOf = (db, messageSid) => db.messages.get(messageSid, { includeHidden: true })?.id ?? null;

/** Every message's change_seq, by sid-free key id, straight off the file. */
function seqs(path) {
  const reader = new (sqlite().DatabaseSync)(path, { readOnly: true });
  try {
    return Object.fromEntries(reader.prepare("SELECT key_id, change_seq FROM messages").all().map((row) => [row.key_id, row.change_seq]));
  } finally {
    reader.close();
  }
}

const listed = (db, after = 0, top = db.messages.changeTop(), limit = 100) =>
  db.messages.changedSince(after, top, limit).map((row) => [row.message.keyId, row.seq]);

test("a v6 file's messages are numbered in stored_seq order, those from before v5 first by id, and what is stored next comes after all of them", () => {
  const path = join(tempDir("wazap-v7-"), "wazap.sqlite");
  const old = new (sqlite().DatabaseSync)(path);
  old.exec("PRAGMA foreign_keys = ON");
  old.exec("BEGIN IMMEDIATE");
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 6)) {
    old.exec(migration.sql);
    old.exec(`PRAGMA user_version = ${migration.version}`);
  }
  const run = (sql, ...params) => old.prepare(sql).run(...params);
  run("INSERT INTO meta(key, value) VALUES ('owner', ?)", ME);
  run("INSERT INTO contacts(id, phone_jid, name, updated_at) VALUES (1, ?, 'Ana', ?)", PEER, T0);
  run("INSERT INTO chats(id, jid, kind, contact_id) VALUES (1, ?, 'direct', 1)", PEER);
  // Ids ascend with the time sent; stored_seq says when they reached the account (null: before v5).
  const row = (key, offset, storedSeq, deleted = false) =>
    run(
      "INSERT INTO messages(id, chat_id, key_id, from_me, ts, type, text, deleted_at, stored_seq) VALUES (?, 1, ?, 0, ?, 'text', ?, ?, ?)",
      ((T0 + offset) / 1000) * SEQ,
      key,
      T0 + offset,
      deleted ? null : key,
      deleted ? T0 + 99_000 : null,
      storedSeq
    );
  row("late", 4000, 1);
  row("old2", 2000, null);
  row("tomb", 3000, null, true);
  row("old1", 1000, null);
  row("last", 5000, 2);
  old.exec("COMMIT");
  old.close();

  const db = AccountDb.open(path, { now: () => T0 + 86_400_000, checkpointDelayMs: 0 });
  assert.equal(db.schemaVersion, SCHEMA_VERSION);
  assert.ok(SCHEMA_VERSION >= 7);
  assert.equal(db.getMeta("migrated_v7") !== null, true);
  const numbered = seqs(path);
  assert.deepEqual(numbered, { old1: 1, old2: 2, tomb: 3, late: 4, last: 5 });
  assert.equal(db.messages.changeTop(), 5);
  assert.deepEqual(
    listed(db).map(([key]) => key),
    ["old1", "old2", "tomb", "late", "last"],
    "after 0 lists the whole visible history, the deleted one as a tombstone"
  );
  assert.equal(db.messages.changedSince(0, 5, 10).find((entry) => entry.message.keyId === "tomb").message.deletedAt !== null, true);

  db.messages.upsert(textMessage(PEER, "next", T0 + 100, "stored after"));
  assert.equal(seqs(path).next, 6, "past every number the backfill handed out");
  db.close();
});

test("a message takes a number when stored and a new one when what a reader sees of it changes, and not when the same values are stored again", () => {
  const { db, path } = openTemp();
  const a = db.messages.upsert(textMessage(PEER, "A", T0 + 5000, "prima"));
  const b = db.messages.upsert(textMessage(PEER, "B", T0 + 1000, "trimis înainte, sosit după"));
  assert.deepEqual(listed(db), [["A", 1], ["B", 2]], "by arrival, not by the time sent");

  // The same values again, and a status rising: nothing a reader sees moved.
  db.messages.upsert(textMessage(PEER, "A", T0 + 5000, "prima"));
  db.messages.upsert(textMessage(PEER, "A", T0 + 5000, "prima", { status: 3 }));
  assert.equal(seqs(path).A, 1);
  assert.equal(db.messages.changeTop(), 2);

  // An edit.
  db.messages.upsert(textMessage(PEER, "A", T0 + 5000, "a doua versiune", { editedAt: T0 + 9000 }));
  assert.deepEqual(listed(db, 2).map(([key]) => key), ["A"]);
  assert.equal(db.messages.changedSince(2, 3, 10)[0].message.text, "a doua versiune");
  assert.equal(seqs(path).A, 3);

  // A transcript added later.
  const voice = db.messages.upsert(textMessage(PEER, "V", T0 + 6000, null, { type: "audio" }));
  assert.equal(seqs(path).V, 4);
  assert.equal(db.messages.setTranscript(voice.sid, "salut"), true);
  assert.equal(seqs(path).V, 5);
  db.messages.setTranscript(voice.sid, "salut");
  assert.equal(seqs(path).V, 5, "the same transcript again moves nothing");

  // Reactions and receipts are not a change.
  db.messages.react(a.sid, PEER, "👍", T0 + 7000);
  assert.equal(seqs(path).A, 3);

  // A tombstone: listed in its place, the words gone.
  db.messages.delete(b.sid);
  assert.equal(seqs(path).B, 6);
  const gone = db.messages.changedSince(5, 6, 10);
  assert.deepEqual(gone.map((entry) => [entry.message.keyId, entry.message.deletedAt !== null, entry.message.text]), [["B", true, null]]);

  // A stub replaced by the message it stood for.
  db.messages.upsert(textMessage(PEER, "S", T0 + 8000, "[missing message]", { type: "system" }));
  assert.equal(seqs(path).S, 7);
  db.messages.upsert(textMessage(PEER, "S", T0 + 8000, "decriptat"));
  assert.equal(seqs(path).S, 8);
  assert.equal(db.messages.changeTop(), 8);
  db.close();
});

test("the top is fixed by the caller: what changes after it is not in that read and comes with the next", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "A", T0, "unu"));
  const top = db.messages.changeTop();
  db.messages.upsert(textMessage(PEER, "B", T0 + 1000, "doi"));
  db.messages.upsert(textMessage(PEER, "A", T0, "unu, editat", { editedAt: T0 + 5000 }));
  assert.deepEqual(listed(db, 0, top), [], "A's only number now lies past the top");
  assert.deepEqual(listed(db, top).map(([key]) => key), ["B", "A"]);
  db.close();
});

test("a number freed by a physical delete is never handed out again", () => {
  const { db, path } = openTemp();
  db.messages.upsert(textMessage(PEER, "A", T0, "unu"));
  const story = db.messages.upsert(textMessage("status@broadcast", "STORY", T0 + 2000, "poveste", { senderJid: PEER, expiresAt: T0 + 86_400_000 }));
  assert.equal(db.messages.changeTop(), 2);
  // The feed keeps no tombstone: the delete tombstones the row (number 3) and then removes it.
  db.messages.delete(story.sid);
  assert.equal(idOf(db, story.sid), null);
  assert.equal(db.messages.changeTop(), 3, "the high-water mark survives the delete");
  db.messages.upsert(textMessage(PEER, "B", T0 + 3000, "doi"));
  assert.equal(seqs(path).B, 4);
  db.close();
});

test("the status feed is not listed, nor a row behind a clear barrier or past its deadline", async () => {
  const { db, clock } = openTemp();
  db.messages.upsert(textMessage("status@broadcast", "STORY", T0 + 1000, "poveste", { senderJid: PEER, expiresAt: clock.now + 86_400_000 }));
  db.messages.upsert(textMessage(PEER, "KEPT", T0 + 2000, "rămâne"));
  const soon = db.messages.upsert(textMessage(PEER, "SOON", T0 + 3000, "expiră"));
  db.messages.setExpiry(soon.sid, clock.now + 1000);
  assert.deepEqual(listed(db).map(([key]) => key), ["KEPT", "SOON"]);
  clock.now += 2000;
  assert.deepEqual(listed(db).map(([key]) => key), ["KEPT"], "expired, even before the sweep ran");
  db.messages.upsert(textMessage(PEER, "BEFORE", T0 + 4000, "înainte de ștergere"));
  await db.messages.clearChat(PEER, T0 + 4500);
  assert.deepEqual(listed(db), [], "cleared chats are not reported");
  db.close();
});

test("a message under both spellings of a folding chat is listed once, as the chat it reads as, and a move to the kept chat lists it once more", async () => {
  const { db, path } = openTemp({ chunkSize: 1 });
  db.messages.upsert(textMessage(PEER, "P", T0, "pe număr"));
  db.messages.upsert(textMessage(PEER_LID, "L", T0 + 1000, "pe lid"));
  db.messages.upsert(textMessage(PEER, "TWIN", T0 + 2000, "geamăn"));
  db.messages.upsert(textMessage(PEER_LID, "TWIN", T0 + 2000, "geamăn"));
  const fold = db.learnLidPhone(PEER_LID, PEER);
  // Paired but not yet moved: the twin is one message, and the lid's own row reads under the number.
  const mid = db.messages.changedSince(0, db.messages.changeTop(), 100).map((entry) => [entry.message.keyId, entry.message.chatJid]);
  assert.deepEqual(mid, [["P", PEER], ["TWIN", PEER], ["L", PEER]], "the number's own copy of the twin keeps its place; the lid's rows took new numbers");
  await fold;
  const after = db.messages.changedSince(0, db.messages.changeTop(), 100).map((entry) => [entry.message.keyId, entry.message.chatJid]);
  assert.deepEqual(after.map(([key]) => key).sort(), ["L", "P", "TWIN"], "once each after the fold");
  assert.ok(after.every(([, chat]) => chat === PEER));
  assert.ok(seqs(path).L > 4, "the row moved under the number took a new number");
  db.close();
});

test("the read walks the change_seq index", () => {
  const { db, path } = openTemp();
  for (let i = 0; i < 20; i++) db.messages.upsert(textMessage(PEER, `K${i}`, T0 + i * 1000, `m${i}`));
  db.close();
  const reader = new (sqlite().DatabaseSync)(path, { readOnly: true });
  try {
    const plan = reader
      .prepare(
        `EXPLAIN QUERY PLAN SELECT m.id FROM messages m INDEXED BY messages_changed WHERE m.change_seq > ? AND m.change_seq <= ? ORDER BY m.change_seq LIMIT 5`
      )
      .all(0, 20)
      .map((entry) => entry.detail)
      .join("\n");
    assert.match(plan, /messages_changed/);
    assert.doesNotMatch(plan, /TEMP B-TREE/);
  } finally {
    reader.close();
  }
});

test("a lid chat's pairing gives every message of it its own new number, whichever way it folds", async () => {
  const { db, path } = openTemp({ chunkSize: 100 });
  for (const key of ["A", "B", "C"]) db.messages.upsert(textMessage(PEER_LID, key, T0 + 1000, key));
  const before = Math.max(...Object.values(seqs(path)));
  await db.learnLidPhone(PEER_LID, PEER);
  const after = Object.values(seqs(path));
  assert.equal(new Set(after).size, 3, "distinct numbers, so a page never splits a tie");
  assert.ok(after.every((n) => n > before));
  db.close();
});

test("a message deleted before its deadline is still listed after it; the sweep's own tombstone is not", async () => {
  const { db, clock } = openTemp();
  const early = db.messages.upsert(textMessage(PEER, "EARLY", T0, "va fi șters", { expiresAt: clock.now + 10_000 }));
  db.messages.upsert(textMessage(PEER, "SWEPT", T0 + 1000, "expiră", { expiresAt: clock.now + 10_000 }));
  db.messages.delete(early.sid);
  clock.now += 20_000;
  assert.deepEqual(listed(db).map(([key]) => key), ["EARLY"], "SWEPT is past its deadline and not yet swept");
  await db.messages.expireDue();
  assert.deepEqual(listed(db).map(([key]) => key), ["EARLY"], "the sweep's tombstone stays hidden, the deletion stays listed");
  db.close();
});

test("two lid chats folding into one number list a message they both hold once", async () => {
  const L2 = "999888777666555@lid";
  const { db } = openTemp({ chunkSize: 1 });
  db.messages.upsert(textMessage(PEER_LID, "TWIN", T0 + 1000, "unu"));
  db.messages.upsert(textMessage(L2, "TWIN", T0 + 1000, "unu"));
  db.messages.upsert(textMessage(PEER, "OWN", T0, "pe număr"));
  const first = db.learnLidPhone(PEER_LID, PEER);
  const second = db.learnLidPhone(L2, PEER);
  const keys = () => listed(db).map(([key]) => key).sort();
  assert.deepEqual(keys(), ["OWN", "TWIN"], "mid-fold");
  await Promise.all([first, second]);
  assert.deepEqual(keys(), ["OWN", "TWIN"], "after it");
  db.close();
});

test("the numbering has a random epoch, on a new file and on an upgraded one", () => {
  const epoch = (db) => db.getMeta("change_epoch");
  const a = openTemp();
  const b = openTemp();
  assert.match(epoch(a.db), /^[0-9a-f]{16}$/);
  assert.notEqual(epoch(a.db), epoch(b.db));
  a.db.close();
  b.db.close();
  const path = join(tempDir("wazap-v7-epoch-"), "wazap.sqlite");
  const old = new (sqlite().DatabaseSync)(path);
  old.exec("BEGIN IMMEDIATE");
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 6)) {
    old.exec(migration.sql);
    old.exec(`PRAGMA user_version = ${migration.version}`);
  }
  old.exec("COMMIT");
  old.close();
  const upgraded = AccountDb.open(path, { checkpointDelayMs: 0, now: () => T0 });
  assert.match(epoch(upgraded), /^[0-9a-f]{16}$/);
  upgraded.close();
});

test("a row stored before a content hash existed does not change when the hash first arrives, and does when the hash then differs", () => {
  const { db, path } = openTemp();
  db.messages.upsert(textMessage(PEER, "A", T0, "unu"));
  db.close();
  const hashed = AccountDb.open(path, { checkpointDelayMs: 0, contentHash: (raw) => `h${raw.length}` });
  hashed.messages.upsert(textMessage(PEER, "A", T0, "unu", { raw: new Uint8Array([1, 2, 3]) }));
  assert.equal(seqs(path).A, 1, "null to a value is not a change");
  hashed.messages.upsert(textMessage(PEER, "A", T0, "unu", { raw: new Uint8Array([1, 2, 3]) }));
  assert.equal(seqs(path).A, 1);
  hashed.messages.upsert(textMessage(PEER, "A", T0, "unu", { raw: new Uint8Array([1, 2, 3, 4]) }));
  assert.equal(seqs(path).A, 2, "other content is");
  hashed.close();
});

test("a page size the store would cut is refused, not cut", () => {
  const { db } = openTemp();
  assert.throws(() => db.messages.changedSince(0, 1, 1001), { code: "INVALID_INPUT" });
  assert.throws(() => db.messages.changedSince(0, 1, 0), { code: "INVALID_INPUT" });
  db.close();
});

test("a quote scrubbed from a row stored without a content hash is a change all the same, and a scan that scrubs nothing is not", () => {
  const { db, path } = openTemp({ scrubQuote });
  const reply = (key, quotes) =>
    textMessage(PEER, key, T0 + 2000, "răspuns", {
      quotedSid: `false_${PEER}_Q`,
      raw: proto.WebMessageInfo.encode({
        key: { remoteJid: PEER, id: key },
        message: { extendedTextMessage: { text: "răspuns", contextInfo: { stanzaId: "Q", ...(quotes ? { quotedMessage: { conversation: "citat secret" } } : {}) } } },
      }).finish(),
    });
  db.messages.upsert(textMessage(PEER, "Q", T0, "citat secret"));
  db.messages.upsert(reply("R", true));
  db.messages.upsert(reply("PLAIN", false));
  db.close();

  // A file stored before the hash existed, or by a process without the hook: every hash is null.
  const reopened = AccountDb.open(path, { checkpointDelayMs: 0, scrubQuote, contentHash: contentHashOf });
  const before = seqs(path);
  reopened.messages.delete(`false_${PEER}_Q`);
  const after = seqs(path);
  assert.ok(after.R > before.R, "R lost its embedded copy of the quote");
  assert.equal(after.PLAIN, before.PLAIN, "a reply with nothing to scrub is untouched");
  const row = reopened.messages.changedSince(before.R, reopened.messages.changeTop(), 10).find((entry) => entry.message.keyId === "R");
  assert.equal(proto.WebMessageInfo.decode(row.message.raw).message.extendedTextMessage.contextInfo.quotedMessage, null);
  reopened.close();
});
