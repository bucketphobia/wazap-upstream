/**
 * Schema v5, what catch_up and find_contact read: message flags (mentions_me,
 * via_wazap) and their backfill, each chat's newest own message and read mark,
 * the catch-up marks per client, and the indexes the planned reads use. A file
 * of every earlier version, written through the released migrations, upgrades
 * with what it held intact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { AccountDb, MESSAGE_FLAGS, SCHEMA_VERSION, StorageError } from "../dist/db/index.js";
import { MIGRATIONS } from "../dist/db/schema.js";
import { sqlite } from "../dist/db/sqlite.js";
import { GROUP, ME, PEER, PEER_LID, T0, openTemp, sid, tempDir, textMessage } from "./db-fixtures.mjs";

const PEER2 = "40700000003@s.whatsapp.net";
const SEQ = 1048576;
const { mentionsMe: MENTIONS, viaWazap: VIA } = MESSAGE_FLAGS;
const DAY = 86_400_000;

const own = (chat, key, ts, text = key, extra = {}) => textMessage(chat, key, ts, text, { fromMe: true, ...extra });
const idOf = (db, messageSid) => db.messages.get(messageSid, { includeHidden: true })?.id ?? null;

/** What last_own_id must be, worked out the slow way: the newest own row a reader may see in the chat and its folding chats. */
function expectedLastOwn(path, chatId) {
  const reader = new (sqlite().DatabaseSync)(path, { readOnly: true });
  try {
    return (
      reader
        .prepare(
          `SELECT max(m.id) AS id FROM messages m JOIN chats k ON k.id = m.chat_id
           WHERE (k.id = ? OR k.merged_into = ?) AND m.from_me = 1 AND m.deleted_at IS NULL AND m.ts > coalesce(k.cleared_through_ts, 0)`
        )
        .get(chatId, chatId).id ?? null
    );
  } finally {
    reader.close();
  }
}

function plan(path, sql, ...params) {
  const reader = new (sqlite().DatabaseSync)(path, { readOnly: true });
  try {
    return reader
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => row.detail)
      .join("\n");
  } finally {
    reader.close();
  }
}

// ---------------------------------------------------------------- upgrade

/** A file at `version`, written through the released migrations, holding what an account of that version held. */
function releasedFile(version) {
  const path = join(tempDir("wazap-v5-"), "wazap.sqlite");
  const db = new (sqlite().DatabaseSync)(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= version)) {
    db.exec(migration.sql);
    db.exec(`PRAGMA user_version = ${migration.version}`);
  }
  const insert = (sql, ...params) => db.prepare(sql).run(...params);
  insert("INSERT INTO meta(key, value) VALUES ('owner', ?)", ME);
  insert("INSERT INTO contacts(id, phone_jid, name, updated_at) VALUES (1, ?, 'Ana', ?)", PEER, T0);
  insert("INSERT INTO contacts(id, lid, push_name, updated_at) VALUES (2, ?, 'Ana', ?)", PEER_LID, T0);
  insert("INSERT INTO contacts(id, phone_jid, updated_at) VALUES (3, ?, ?)", PEER2, T0);
  insert("INSERT INTO lid_phones(lid, phone_jid, learned_at) VALUES (?, ?, ?)", PEER_LID, PEER, T0);
  insert("INSERT INTO chats(id, jid, kind, contact_id) VALUES (1, ?, 'direct', 1)", PEER);
  insert("INSERT INTO chats(id, jid, kind, name) VALUES (2, ?, 'group', 'Fotbal marți')", GROUP);
  // A lid chat a fold had not finished moving when the file was last closed.
  insert("INSERT INTO chats(id, jid, kind, contact_id, merged_into) VALUES (3, ?, 'direct', 2, 1)", PEER_LID);
  insert("INSERT INTO chats(id, jid, kind, contact_id, cleared_through_ts) VALUES (4, ?, 'direct', 3, ?)", PEER2, T0 + 10_000);
  let seq = 0;
  const message = (chatId, key, fromMe, ts, text, extra = "") => {
    const id = (ts / 1000) * SEQ + seq++;
    insert(
      `INSERT INTO messages(id, chat_id, key_id, from_me, sender_id, ts, type, text, raw, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, 'text', ?, ?, ?)`,
      id,
      chatId,
      key,
      fromMe ? 1 : 0,
      fromMe ? null : chatId === 2 ? 3 : 1,
      ts,
      extra === "deleted" ? null : text,
      extra === "deleted" ? null : new Uint8Array([1, 2, 3]),
      extra === "deleted" ? T0 + 60_000 : null
    );
    if (chatId !== 4 || ts > T0 + 10_000) insert("UPDATE chats SET last_message_id = ?, last_ts = ?, last_from_me = ? WHERE id = ?", id, ts, fromMe ? 1 : 0, chatId);
    return id;
  };
  const ids = {
    A: message(1, "A", true, T0, "ajung la 6"),
    B: message(1, "B", false, T0 + 1_000, "bine"),
    C: message(1, "C", true, T0 + 2_000, null, "deleted"),
    D: message(3, "SENT2", true, T0 + 3_000, "trimis din wazap, pe lid"),
    G1: message(2, "SENT1", true, T0 + 4_000, "vin și eu"),
    G2: message(2, "G2", false, T0 + 5_000, "@40700000001 tu vii?"),
    H: message(4, "H", true, T0 + 9_000, "sub barieră"),
    I: message(4, "I", true, T0 + 11_000, "după barieră"),
  };
  if (version >= 2) {
    const send = (draftId, chatJid, keyId, state) =>
      insert(
        `INSERT INTO sends(draft_id, owner, chat_jid, kind, payload, key_id, state, created_at, expires_at, updated_at)
         VALUES (?, 'session', ?, 'text', '{}', ?, ?, ?, ?, ?)`,
        draftId,
        chatJid,
        keyId,
        state,
        T0,
        T0 + DAY,
        T0
      );
    send("d1", GROUP, "SENT1", "sent");
    send("d2", PEER_LID, "SENT2", "unknown");
    send("d3", PEER, "A", "draft");
  }
  if (version >= 4) {
    insert(
      "INSERT INTO events(kind, lane, message_id, payload, created_at, ready_at, updated_at) VALUES ('message_received', 'chat:2', ?, '{}', ?, ?, ?)",
      ids.G2,
      T0,
      T0,
      T0
    );
  }
  db.exec("COMMIT");
  db.close();
  return { path, ids };
}

for (const from of [1, 2, 3, 4]) {
  test(`a version ${from} file, written through the released migrations, upgrades to v5 with its messages intact and its marks worked out`, async () => {
    const { path, ids } = releasedFile(from);
    const db = AccountDb.open(path, { now: () => T0 + DAY, checkpointDelayMs: 0 });
    assert.ok(SCHEMA_VERSION >= 5);
    assert.equal(db.schemaVersion, SCHEMA_VERSION);
    assert.ok(db.getMeta("migrated_v5") !== null);

    // Nothing it held moved or changed.
    assert.equal(db.messages.get(sid(true, PEER, "A")).text, "ajung la 6");
    assert.equal(db.messages.get(sid(false, PEER, "B")).text, "bine");
    assert.equal(db.messages.get(sid(true, PEER, "C")), null, "a tombstone stays one");
    assert.equal(db.messages.get(sid(true, PEER, "SENT2")).text, "trimis din wazap, pe lid", "a folding chat's row answers under the number");
    assert.equal(db.messages.get(sid(false, GROUP, "G2")).text, "@40700000001 tu vii?");
    assert.equal(db.messages.get(sid(true, PEER2, "H")), null, "still under its barrier");
    assert.equal(db.search.text({ query: "barieră", limit: 10 }).items.length, 1);
    assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });
    assert.equal(db.getMeta("owner"), ME);
    if (from >= 4) assert.equal(db.events.get(1).messageId, ids.G2);

    // via_wazap from the confirmed sends it held, under any spelling of their chat; a draft never went out.
    const flags = (messageSid) => db.messages.get(messageSid).flags;
    assert.equal(flags(sid(true, GROUP, "SENT1")), from >= 2 ? VIA : 0);
    assert.equal(flags(sid(true, PEER, "SENT2")), from >= 2 ? VIA : 0);
    assert.equal(flags(sid(true, PEER, "A")), 0);
    assert.equal(flags(sid(false, GROUP, "G2")), 0, "a mention waits for the backfill, which reads the protobuf");

    // Each chat's newest own message: not a tombstone, not under a barrier, folding chats included.
    assert.equal(db.identity.chat(PEER).lastOwnId, ids.D);
    assert.equal(db.identity.chat(GROUP).lastOwnId, ids.G1);
    assert.equal(db.identity.chat(PEER2).lastOwnId, ids.I);
    assert.equal(db.identity.chat(PEER).readThroughId, null);
    assert.equal(db.catchup.get("local"), null);
    assert.equal(db.getMeta("flags_backfill_before"), String(Math.max(...Object.values(ids)) + 1));
    // The keys of the sends it still held are kept past their rows; which older own messages wazap sent is unknown.
    assert.equal(db.sends.wasSent("SENT1"), from >= 2);
    assert.equal(db.sends.wasSent("A"), false, "a draft never went out");
    assert.equal(db.getMeta("via_wazap_known_after"), "migrated_v5");
    assert.equal(db.messages.viaWazapKnownAfter(), Number(db.getMeta("migrated_v5")));

    // What it held reached it before any catch-up mark: no stored_seq, and the first one stored after is 1.
    assert.equal(db.digest.storedTop(), 0);

    // The triggers run from here on, and the fold it left behind finishes with the marks in place.
    const later = db.messages.upsert(own(PEER, "LATER", T0 + 20_000));
    assert.equal(db.identity.chat(PEER).lastOwnId, later.id);
    assert.equal(db.digest.storedTop(), 1);
    await db.resume();
    assert.equal(db.identity.chat(PEER).lastOwnId, later.id);
    assert.equal(db.messages.get(sid(true, PEER, "SENT2")).flags, from >= 2 ? VIA : 0);
    assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });
    db.close();
  });
}

test("a new file starts at v5 with no backfill owed", () => {
  const { db } = openTemp();
  assert.equal(db.schemaVersion, SCHEMA_VERSION);
  assert.equal(db.getMeta("flags_backfill_before"), null);
  assert.equal(db.messages.flagsBackfillPending(), false);
  db.close();
});

// ---------------------------------------------------------------- flags

test("flags only gain bits: a replay without them keeps them, and a later mark adds to them", () => {
  const { db } = openTemp();
  const stored = db.messages.upsert(textMessage(GROUP, "M", T0, "@ana vii?", { senderJid: PEER, flags: MENTIONS }));
  assert.equal(db.messages.get(stored.sid).flags, MENTIONS);
  db.messages.upsert(textMessage(GROUP, "M", T0, "@ana vii?", { senderJid: PEER }));
  assert.equal(db.messages.get(stored.sid).flags, MENTIONS, "a replay without the bit keeps it");
  db.messages.upsert(textMessage(GROUP, "M", T0, "edited", { senderJid: PEER, editedAt: T0 + 5, flags: 0 }));
  assert.equal(db.messages.get(stored.sid).flags, MENTIONS, "an edit keeps it too");
  assert.equal(db.messages.addFlags(stored.sid, VIA), true);
  assert.equal(db.messages.addFlags(stored.sid, VIA), false, "already there");
  assert.equal(db.messages.get(stored.sid).flags, MENTIONS | VIA);
  assert.equal(db.messages.addFlags(sid(false, GROUP, "NOPE"), VIA), false);
  for (const junk of [-1, 1.5, Number.NaN]) {
    db.messages.upsert(textMessage(GROUP, "J", T0 + 1000, "x", { senderJid: PEER, flags: junk }));
    assert.equal(db.messages.get(sid(false, GROUP, "J")).flags, 0);
  }
  db.messages.delete(stored.sid);
  assert.equal(db.messages.addFlags(stored.sid, MENTIONS), false, "a tombstone gains nothing");
  assert.equal(db.messages.get(stored.sid, { includeHidden: true }).flags, VIA, "and loses its mention with its words");
  db.close();
});

test("the account's own message filed under a confirmed send's key is via_wazap whoever stores it, and a draft's key is not", () => {
  const { db, clock } = openTemp();
  const draft = (draftId, keyId) =>
    db.sends.insertDraft(
      { draftId, owner: "s", chatJid: PEER, kind: "text", payload: "{}", keyId, createdAt: clock.now, expiresAt: clock.now + DAY },
      10,
      100
    );
  draft("d1", "K1");
  draft("d2", "K2");
  assert.equal(db.sends.claim("d1", "s", clock.now), true);
  db.messages.upsert(own(PEER, "K1", T0));
  db.messages.upsert(own(PEER, "K2", T0 + 1000));
  db.messages.upsert(textMessage(PEER, "K1", T0 + 2000, "their key happens to match"));
  assert.equal(db.messages.get(sid(true, PEER, "K1")).flags, VIA, "sending: the echo of the send");
  assert.equal(db.messages.get(sid(true, PEER, "K2")).flags, 0, "a draft never went out");
  assert.equal(db.messages.get(sid(false, PEER, "K1")).flags, 0, "only the account's own message");
  db.close();
});

test("a send's key outlives its row for 90 days: a copy of its message stored later is still via_wazap", () => {
  const { db, clock } = openTemp();
  const HOUR = 3_600_000;
  db.sends.insertDraft(
    { draftId: "d1", owner: "s", chatJid: PEER, kind: "text", payload: "{}", keyId: "3EB0OLDSEND", createdAt: clock.now, expiresAt: clock.now + DAY },
    10,
    100
  );
  assert.equal(db.sends.wasSent("3EB0OLDSEND"), false, "a draft is not a send");
  assert.equal(db.sends.claim("d1", "s", clock.now), true);
  assert.equal(db.sends.wasSent("3EB0OLDSEND"), true);
  db.sends.settle("d1", "{}", clock.now, clock.now + DAY);
  clock.now += 25 * HOUR;
  assert.equal(db.sends.sweep(clock.now, 100), 1, "the send's row is gone after a day");
  assert.equal(db.sends.get("d1"), null);
  // A history sync after a relink brings the message back.
  db.messages.upsert(own(PEER, "3EB0OLDSEND", clock.now - 24 * HOUR));
  assert.equal(db.messages.get(sid(true, PEER, "3EB0OLDSEND")).flags, VIA);

  clock.now += 90 * DAY;
  db.sends.sweep(clock.now, 100);
  assert.equal(db.sends.wasSent("3EB0OLDSEND"), false, "gone after 90 days");
  assert.equal(db.messages.get(sid(true, PEER, "3EB0OLDSEND")).flags, VIA, "a message keeps the flag it got");
});

test("the flags backfill adds via_wazap from the kept keys, and an import marks which own messages it cannot vouch for", async () => {
  const { db, clock } = openTemp({ chunkSize: 2 });
  db.messages.upsert(own(PEER, "3EB0IMPORTED", clock.now - 1000));
  db.messages.upsert(own(PEER, "PHONE1", clock.now - 900));
  db.sends.insertDraft(
    { draftId: "d9", owner: "s", chatJid: PEER, kind: "text", payload: "{}", keyId: "3EB0IMPORTED", createdAt: clock.now, expiresAt: clock.now + DAY },
    10,
    100
  );
  db.sends.claim("d9", "s", clock.now);
  assert.equal(db.messages.viaWazapKnownAfter(), 0, "a new file knows every send");
  db.messages.requestFlagsBackfill();
  assert.equal(db.messages.viaWazapKnownAfter(), clock.now);
  const result = await db.messages.backfillFlags(() => 0);
  assert.equal(result.flagged, 1);
  assert.equal(db.messages.get(sid(true, PEER, "3EB0IMPORTED")).flags, VIA);
  assert.equal(db.messages.get(sid(true, PEER, "PHONE1")).flags, 0);
});

test("a fold keeps the union of both copies' flags", async () => {
  const { db } = openTemp({ chunkSize: 2 });
  db.messages.upsert(textMessage(PEER, "TWIN", T0, "hei", { flags: MENTIONS }));
  db.messages.upsert(textMessage(PEER_LID, "TWIN", T0, "hei", { flags: 4 }));
  db.messages.upsert(textMessage(PEER_LID, "ONLY", T0 + 1000, "doar pe lid", { flags: MENTIONS }));
  await db.learnLidPhone(PEER_LID, PEER);
  assert.equal(db.messages.get(sid(false, PEER, "TWIN")).flags, MENTIONS | 4);
  assert.equal(db.messages.get(sid(false, PEER, "ONLY")).flags, MENTIONS);
  db.close();
});

test("the flags backfill walks down from its cursor as far as 14 days back, a chunk per transaction, and ends by removing the cursor", async () => {
  const { db, path, clock } = openTemp({ chunkSize: 3 });
  const now = T0 + 30 * DAY;
  clock.now = now;
  const bytes = (text) => new Uint8Array(Buffer.from(text));
  // R0..R9 an hour apart, newest first; the even ones mention the account.
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push(db.messages.upsert(textMessage(GROUP, `R${i}`, now - (i + 1) * 3600_000, `r${i}`, { senderJid: PEER, raw: bytes(i % 2 === 0 ? "@me" : "hi") })));
  }
  const old = db.messages.upsert(textMessage(GROUP, "OLD", now - 20 * DAY, "old", { senderJid: PEER, raw: bytes("@me") }));
  const mine = db.messages.upsert(own(GROUP, "MINE", now - 3600_000 - 500, "@me", { raw: bytes("@me") }));
  db.messages.delete(rows[0].sid);
  db.close();

  const reopened = AccountDb.open(path, { now: () => now, checkpointDelayMs: 0, chunkSize: 3 });
  // What a migration or an import leaves: a cursor above everything stored.
  reopened.messages.requestFlagsBackfill();
  const cursor = Number(reopened.getMeta("flags_backfill_before"));
  assert.ok(cursor > rows[0].id && cursor > mine.id);
  assert.equal(reopened.messages.flagsBackfillPending(), true);

  const calls = [];
  const detect = ({ raw, fromMe, chatJid, type }) => {
    calls.push({ text: Buffer.from(raw).toString(), fromMe, chatJid, type, cursor: reopened.getMeta("flags_backfill_before") });
    if (calls.length === 5) throw new Error("a detector that throws counts as none");
    return !fromMe && Buffer.from(raw).toString() === "@me" ? MENTIONS : 0;
  };
  const result = await reopened.messages.backfillFlags(detect);
  // Newest first: MINE, R1..R9; not the tombstone, not the 20-day-old one.
  assert.deepEqual(result, { scanned: 10, flagged: 3, done: true });
  assert.deepEqual(calls.map((call) => call.text), ["@me", "hi", "@me", "hi", "@me", "hi", "@me", "hi", "@me", "hi"]);
  assert.deepEqual([calls[0].fromMe, calls[0].chatJid, calls[0].type], [true, GROUP, "text"]);
  assert.deepEqual(
    calls.map((call) => call.cursor),
    [cursor, cursor, cursor, rows[2].id, rows[2].id, rows[2].id, rows[5].id, rows[5].id, rows[5].id, rows[8].id].map(String),
    "the cursor another start resumes from moves with each committed chunk"
  );
  assert.equal(reopened.getMeta("flags_backfill_before"), null);
  assert.equal(reopened.messages.flagsBackfillPending(), false);
  const flagsOf = (row) => reopened.messages.get(row.sid).flags;
  assert.deepEqual(rows.slice(1).map(flagsOf), [0, MENTIONS, 0, 0, 0, MENTIONS, 0, MENTIONS, 0], "R4's detector threw");
  assert.equal(flagsOf(old), 0, "past the window");
  assert.equal(flagsOf(mine), 0);

  // A cursor left mid-way (a stop, a crash) resumes from there, below it only.
  reopened.setMeta("flags_backfill_before", String(rows[4].id));
  assert.deepEqual(await reopened.messages.backfillFlags(() => MENTIONS), { scanned: 5, flagged: 3, done: true });
  assert.deepEqual(rows.slice(1).map(flagsOf), [0, MENTIONS, 0, 0, MENTIONS, MENTIONS, MENTIONS, MENTIONS, MENTIONS]);
  assert.deepEqual(await reopened.messages.backfillFlags(() => MENTIONS), { scanned: 0, flagged: 0, done: true }, "nothing owed");
  reopened.close();
});

// ---------------------------------------------------------------- last_own_id

test("last_own_id follows inserts, tombstones, deletes and clears, and never names someone else's message", async () => {
  const { db, path } = openTemp({ chunkSize: 2 });
  const check = (label) => {
    const chat = db.identity.chat(PEER);
    assert.equal(chat.lastOwnId, expectedLastOwn(path, chat.id), label);
  };
  const a = db.messages.upsert(own(PEER, "A", T0));
  db.messages.upsert(textMessage(PEER, "B", T0 + 1000, "theirs"));
  const c = db.messages.upsert(own(PEER, "C", T0 + 2000));
  db.messages.upsert(textMessage(PEER, "D", T0 + 3000, "theirs, newer"));
  assert.equal(db.identity.chat(PEER).lastOwnId, c.id);
  check("insert");

  db.messages.upsert(own(PEER, "OLDER", T0 - 5000));
  assert.equal(db.identity.chat(PEER).lastOwnId, c.id, "an older own message does not take its place");
  db.messages.delete(a.sid);
  assert.equal(db.identity.chat(PEER).lastOwnId, c.id, "a tombstone of an older one changes nothing");
  db.messages.delete(c.sid);
  assert.equal(db.identity.chat(PEER).lastOwnId, idOf(db, sid(true, PEER, "OLDER")));
  check("tombstone");

  const e = db.messages.upsert(own(PEER, "E", T0 + 5000));
  const f = db.messages.upsert(own(PEER, "F", T0 + 9000));
  const cleared = db.messages.clearChat(PEER, T0 + 6000);
  assert.equal(db.identity.chat(PEER).lastOwnId, f.id, "the barrier hides E, not F");
  await cleared;
  check("clear");
  const gone = db.messages.clearChat(PEER, T0 + 9000);
  assert.equal(db.identity.chat(PEER).lastOwnId, null, "hidden the moment the barrier is stored");
  await gone;
  assert.equal(db.identity.chat(PEER).lastOwnId, null);
  const g = db.messages.upsert(own(PEER, "G", T0 + 10_000));
  assert.equal(db.identity.chat(PEER).lastOwnId, g.id);
  assert.equal(e.id < g.id, true);

  db.messages.upsert(own(PEER, "EXP", T0 + 11_000, "fleeting", { expiresAt: T0 + 3_600_000 + 1 }));
  await db.messages.purgeLive();
  assert.equal(db.identity.chat(PEER).lastOwnId, null, "a physical delete recounts too");
  check("purge");
  db.close();
});

test("last_own_id reads a folding chat as part of the number's chat at once, and keeps it through the fold and its twins", async () => {
  const { db, path } = openTemp({ chunkSize: 1 });
  const phoneOwn = db.messages.upsert(own(PEER, "P", T0));
  const lidOwn = db.messages.upsert(own(PEER_LID, "L", T0 + 5000));
  db.messages.upsert(own(PEER, "TWIN", T0 + 7000));
  db.messages.upsert(own(PEER_LID, "TWIN", T0 + 7000));
  db.messages.delete(sid(true, PEER_LID, "TWIN"));
  assert.equal(db.identity.chat(PEER).lastOwnId, idOf(db, sid(true, PEER, "TWIN")));
  assert.equal(db.identity.chat(PEER_LID).lastOwnId, lidOwn.id);

  const phoneTwin = idOf(db, sid(true, PEER, "TWIN"));
  const fold = db.learnLidPhone(PEER_LID, PEER);
  // The pairing is synchronous and the lid chat reads as part of the number's at once; the rows move later.
  const pairedChat = db.identity.chat(PEER);
  assert.equal(pairedChat.lastOwnId, phoneTwin, "the live copy of the twin, as last_message_id reads it until the fold decides");
  assert.equal(pairedChat.lastOwnId, expectedLastOwn(path, pairedChat.id));
  await fold;
  // The fold settles the twin as the tombstone it is on one side; the lid's own message is the newest left.
  assert.equal(db.messages.get(sid(true, PEER, "TWIN")), null);
  const chat = db.identity.chat(PEER);
  assert.equal(chat.lastOwnId, lidOwn.id);
  assert.equal(chat.lastOwnId, expectedLastOwn(path, chat.id));
  assert.equal(phoneOwn.id < lidOwn.id, true);
  db.close();
});

// ---------------------------------------------------------------- read_through_id

test("a read mark from the account's own devices only moves forward, through any spelling, and never onto its own message", async () => {
  const { db } = openTemp();
  const first = db.messages.upsert(textMessage(PEER_LID, "T1", T0, "unu"));
  const second = db.messages.upsert(textMessage(PEER_LID, "T2", T0 + 1000, "doi"));
  const mine = db.messages.upsert(own(PEER_LID, "M1", T0 + 2000));

  assert.deepEqual(db.messages.markReadSelf(`${PEER_LID}_T2`), { moved: true, chatJid: PEER_LID, readThroughId: second.id });
  assert.deepEqual(db.messages.markReadSelf(`false_${PEER_LID}_T1`), { moved: false, chatJid: PEER_LID, readThroughId: second.id }, "never back");
  assert.deepEqual(db.messages.markReadSelf(`${PEER_LID}_M1`), { moved: false, chatJid: PEER_LID, readThroughId: second.id }, "own message: found, not read");
  assert.deepEqual(db.messages.markReadSelf(`true_${PEER_LID}_T2`), { moved: false, chatJid: null, readThroughId: null }, "the direction is honoured when given");
  assert.deepEqual(db.messages.markReadSelf(`${PEER_LID}_UNSEEN`), { moved: false, chatJid: null, readThroughId: null });
  assert.deepEqual(db.messages.markReadSelf("nonsense"), { moved: false, chatJid: null, readThroughId: null });
  assert.equal(mine.id > second.id && first.id < second.id, true);

  // The number's chat has read further; the lid chat folding into it keeps the later mark, from the moment it pairs.
  const phoneLater = db.messages.upsert(textMessage(PEER, "P9", T0 + 9000, "nouă"));
  db.messages.markReadSelf(`${PEER}_P9`);
  const fold = db.learnLidPhone(PEER_LID, PEER);
  assert.equal(db.identity.chat(PEER).readThroughId, phoneLater.id);
  await fold;
  assert.equal(db.identity.chat(PEER).readThroughId, phoneLater.id);
  // After the pairing a receipt under the lid spelling marks the number's chat.
  const newest = db.messages.upsert(textMessage(PEER_LID, "T10", T0 + 10_000, "zece"));
  assert.deepEqual(db.messages.markReadSelf(`${PEER_LID}_T10`), { moved: true, chatJid: PEER, readThroughId: newest.id });
  db.close();
});

test("a fold carries the folding chat's later read mark over to the number's chat", async () => {
  const { db } = openTemp({ chunkSize: 1 });
  db.messages.upsert(textMessage(PEER, "P1", T0, "unu"));
  db.messages.markReadSelf(`${PEER}_P1`);
  const later = db.messages.upsert(textMessage(PEER_LID, "L5", T0 + 5000, "cinci"));
  db.messages.markReadSelf(`${PEER_LID}_L5`);
  const fold = db.learnLidPhone(PEER_LID, PEER);
  assert.equal(db.identity.chat(PEER).readThroughId, later.id, "at once");
  await fold;
  assert.equal(db.identity.chat(PEER).readThroughId, later.id);
  db.close();
});

// ---------------------------------------------------------------- catchup_marks

/** An account that has stored `count` messages: stored_seq 1..count handed out. */
function storedMessages(db, count) {
  db.transaction(() => {
    for (let i = 0; i < count; i++) db.messages.upsert(textMessage(PEER, `S${i}`, T0 + i * 1000, `m${i}`));
  });
  assert.equal(db.digest.storedTop(), count);
}

test("a catch-up mark advances in one statement, only forward, keeping the one before it for a repeat", () => {
  const { db, clock } = openTemp();
  storedMessages(db, 1000);
  assert.equal(db.catchup.get("claude"), null);
  assert.equal(db.catchup.repeat("claude"), null);

  const started = clock.now - 500;
  let step = db.catchup.advance("claude", 100, { at: started });
  assert.deepEqual(step, {
    advanced: true,
    mark: { client: "claude", throughSeq: 100, throughAt: started, previousSeq: null, previousAt: null, updatedAt: clock.now },
  });
  assert.deepEqual(db.catchup.repeat("claude"), { afterSeq: null, afterAt: null, throughSeq: 100, throughAt: started });

  clock.now += 1000;
  step = db.catchup.advance("claude", 250);
  assert.deepEqual(step.mark, { client: "claude", throughSeq: 250, throughAt: clock.now, previousSeq: 100, previousAt: started, updatedAt: clock.now });
  assert.deepEqual(db.catchup.repeat("claude"), { afterSeq: 100, afterAt: started, throughSeq: 250, throughAt: clock.now });

  for (const stale of [250, 180]) {
    step = db.catchup.advance("claude", stale);
    assert.equal(step.advanced, false, `${stale} is not past the mark`);
    assert.equal(db.catchup.repeat("claude").afterSeq, 100, "the window to repeat survives");
  }

  // A summary built over a mark another call has moved since does not advance it.
  assert.equal(db.catchup.advance("claude", 400, { expectedThroughSeq: 100 }).advanced, false);
  assert.equal(db.catchup.advance("claude", 400, { expectedThroughSeq: null }).advanced, false, "null expects no mark at all");
  assert.equal(db.catchup.advance("claude", 400, { expectedThroughSeq: 250 }).advanced, true);
  assert.deepEqual([db.catchup.repeat("claude").afterSeq, db.catchup.repeat("claude").throughSeq], [250, 400]);
  assert.equal(db.catchup.advance("fresh", 7, { expectedThroughSeq: 3 }).advanced, false, "no mark to expect");
  assert.equal(db.catchup.get("fresh"), null);
  assert.equal(db.catchup.advance("fresh", 7, { expectedThroughSeq: null }).advanced, true);

  // Clients are independent; a mark rolls back with the transaction around it.
  assert.equal(db.catchup.get("chatgpt"), null);
  assert.throws(() =>
    db.transaction(() => {
      db.catchup.advance("claude", 999);
      throw new Error("the summary failed after all");
    })
  );
  assert.equal(db.catchup.get("claude").throughSeq, 400);

  // A mark never covers what has not reached the account, however far a caller asks it to go.
  step = db.catchup.advance("claude", 2 ** 50, { expectedThroughSeq: 400 });
  assert.deepEqual([step.advanced, step.mark.throughSeq], [true, 1000]);
  assert.equal(db.catchup.advance("claude", 2 ** 50).advanced, false, "held to the newest, it is not past the mark");
  db.messages.upsert(textMessage(PEER2, "NEXT", T0, "sosit după"));
  assert.equal(db.catchup.advance("claude", 2 ** 50).mark.throughSeq, 1001);

  // A summary that read by time keeps that time for its repeat, not the mark it replaced.
  db.catchup.advance("dated", 500, { at: clock.now - 10, from: { seq: null, at: clock.now - 86_400_000 } });
  db.messages.upsert(textMessage(PEER2, "NEXT2", T0, "încă unul"));
  assert.equal(db.catchup.advance("dated", 1002, { expectedThroughSeq: 500, from: { seq: null, at: clock.now - 3_600_000 } }).advanced, true);
  assert.deepEqual(db.catchup.repeat("dated"), { afterSeq: null, afterAt: clock.now - 3_600_000, throughSeq: 1002, throughAt: clock.now });
  assert.equal(db.catchup.reset("fresh"), true);
  assert.equal(db.catchup.get("fresh"), null);
  for (const [client, seq] of [["", 1], ["x".repeat(201), 1], ["ok", -1], ["ok", 1.5]]) {
    assert.throws(() => db.catchup.advance(client, seq), (err) => err instanceof StorageError && err.code === "INVALID_INPUT");
  }
  db.close();
});

test("two connections advancing one client's mark cannot both move it from the same place", () => {
  const { db, path } = openTemp();
  storedMessages(db, 40);
  db.catchup.advance("local", 10);
  const other = AccountDb.open(path, { checkpointDelayMs: 0 });
  const seenByFirst = db.catchup.get("local").throughSeq;
  const seenBySecond = other.catchup.get("local").throughSeq;
  assert.equal(other.catchup.advance("local", 30, { expectedThroughSeq: seenBySecond }).advanced, true);
  assert.equal(db.catchup.advance("local", 20, { expectedThroughSeq: seenByFirst }).advanced, false);
  assert.deepEqual([db.catchup.repeat("local").afterSeq, db.catchup.repeat("local").throughSeq], [10, 30]);
  other.close();
  db.close();
});

// ---------------------------------------------------------------- stored_seq

test("stored_seq orders messages as they reached the account: a late one after, a freed number never again, a replaced stub anew", () => {
  const { db, path } = openTemp();
  const seqOf = (messageSid) => {
    const reader = new (sqlite().DatabaseSync)(path, { readOnly: true });
    try {
      return reader.prepare("SELECT stored_seq FROM messages WHERE id = ?").get(idOf(db, messageSid))?.stored_seq ?? null;
    } finally {
      reader.close();
    }
  };
  assert.equal(db.digest.storedTop(), 0);
  const newer = db.messages.upsert(textMessage(PEER, "NEW", T0 + 60_000, "trimis acum"));
  const late = db.messages.upsert(textMessage(PEER, "LATE", T0, "trimis înainte, sosit după"));
  assert.ok(late.id < newer.id, "the id orders by when it was sent");
  assert.ok(seqOf(late.sid) > seqOf(newer.sid), "stored_seq by when it arrived");
  assert.equal(db.digest.storedTop(), seqOf(late.sid));

  // An update is not an arrival; a stub replaced by the message it stood for is.
  db.messages.upsert(textMessage(PEER, "NEW", T0 + 60_000, "trimis acum", { status: 3 }));
  assert.equal(seqOf(newer.sid), 1);
  const stub = db.messages.upsert(textMessage(PEER2, "STUB", T0 + 1000, "[missing message]", { type: "system" }));
  const stubSeq = seqOf(stub.sid);
  db.messages.upsert(textMessage(PEER2, "STUB", T0 + 1000, "decriptat la a doua încercare"));
  assert.ok(seqOf(stub.sid) > stubSeq);
  assert.equal(db.digest.storedTop(), seqOf(stub.sid));

  // The newest one goes for good: its number is not handed out again.
  const story = db.messages.upsert(textMessage("status@broadcast", "STORY", T0 + 2000, "poveste", { senderJid: PEER, expiresAt: T0 + 86_400_000 }));
  const storySeq = seqOf(story.sid);
  db.messages.delete(story.sid);
  assert.equal(idOf(db, story.sid), null, "the status feed keeps no tombstone");
  assert.equal(db.digest.storedTop(), storySeq);
  const after = db.messages.upsert(textMessage(PEER, "AFTER", T0 + 3000, "după"));
  assert.equal(seqOf(after.sid), storySeq + 1);
  db.close();
});

// ---------------------------------------------------------------- indexes

test("the planned reads use the v5 indexes, not a scan", () => {
  const { db, path } = openTemp();
  for (let i = 0; i < 50; i++) {
    db.messages.upsert(textMessage(i % 2 ? GROUP : PEER, `K${i}`, T0 + i * 1000, `m${i}`, { fromMe: i % 3 === 0, senderJid: i % 2 && i % 3 ? PEER2 : undefined, type: i % 10 === 0 ? "call" : i % 7 === 0 ? "poll" : "text", flags: i % 5 === 0 ? MENTIONS : 0 }));
  }
  db.close();
  const lower = T0 * 1048.576;
  const cases = [
    [
      "newest own message of a chat (last_own_id)",
      `SELECT x.id FROM messages x INDEXED BY messages_own WHERE x.chat_id = 1 AND x.from_me = 1 AND x.deleted_at IS NULL AND x.id >= 0 AND x.ts > 0 ORDER BY x.id DESC LIMIT 1`,
      /USING (COVERING )?INDEX messages_own/,
    ],
    [
      "own messages of a chat in a window (answered, style, how often they talk)",
      `SELECT count(*) FROM messages m WHERE m.chat_id = ? AND m.from_me = 1 AND m.deleted_at IS NULL AND m.id >= ?`,
      /USING COVERING INDEX messages_own/,
      1,
      lower,
    ],
    ["mentions in a window", `SELECT m.id FROM messages m WHERE (m.flags & 1) <> 0 AND m.id > ? AND m.id <= ?`, /USING (COVERING )?INDEX messages_mentions/, lower, lower * 2],
    [
      "the chats something reached after a catch-up mark",
      `SELECT m.chat_id, min(m.id) AS low FROM messages m INDEXED BY messages_stored
       WHERE m.stored_seq > ? AND m.stored_seq <= ? AND m.id > ? AND m.id <= ? GROUP BY m.chat_id`,
      /USING COVERING INDEX messages_stored/,
      10,
      40,
      lower,
      lower * 2,
    ],
    [
      "the newest stored_seq handed out",
      `SELECT stored_seq FROM messages INDEXED BY messages_stored WHERE stored_seq IS NOT NULL ORDER BY stored_seq DESC LIMIT 1`,
      /USING COVERING INDEX messages_stored/,
    ],
    ["calls in a window", `SELECT m.id FROM messages m WHERE m.type = 'call' AND m.id > ?`, /USING (COVERING )?INDEX messages_calls/, lower],
    ["polls and events in a window", `SELECT m.id FROM messages m WHERE m.type IN ('poll', 'event') AND m.id > ?`, /USING (COVERING )?INDEX messages_polls/, lower],
    [
      "polls the account has not voted on",
      `SELECT m.id FROM messages m WHERE m.type IN ('poll', 'event') AND m.id > ?
         AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.message_id = m.id AND v.contact_id = ?)`,
      /USING (COVERING )?INDEX messages_polls[\s\S]*USING COVERING INDEX sqlite_autoindex_votes_1/,
      lower,
      1,
    ],
    [
      // No index of its own: the chat's id range off messages_chat reads few enough rows (see bench-db, catch_up rows).
      "window aggregation of a chat by id range",
      `SELECT count(*) AS n, count(DISTINCT m.sender_id) AS senders, sum(m.type IN ('image', 'video')) AS media, max(m.id) AS newest
       FROM messages m WHERE m.chat_id = ? AND m.id > ? AND m.id <= ? AND m.from_me = 0 AND m.deleted_at IS NULL
         AND (m.expires_at IS NULL OR m.expires_at > ?)`,
      /SEARCH m USING INDEX messages_chat \(chat_id=\? AND id>\? AND id<\?\)/,
      2,
      lower,
      lower * 2,
      T0,
    ],
  ];
  for (const [label, sql, expected, ...params] of cases) {
    const detail = plan(path, sql, ...params);
    assert.match(detail, expected, `${label}:\n${detail}`);
    assert.doesNotMatch(detail, /SCAN m\b(?! USING)/, `${label} scans:\n${detail}`);
  }
});

test("a deleted, retracted or expired message leaves the mentions a window lists", async () => {
  const { db, path, clock } = openTemp();
  const mention = (key, ts, extra = {}) => db.messages.upsert(textMessage(GROUP, key, ts, "@eu", { senderJid: PEER, flags: MENTIONS, ...extra }));
  mention("KEEP", T0);
  const deleted = mention("DEL", T0 + 1000);
  mention("EXP", T0 + 2000, { expiresAt: clock.now + 10 });
  db.messages.delete(deleted.sid);
  clock.now += 20;
  await db.messages.expireDue();
  db.close();
  const reader = new (sqlite().DatabaseSync)(path, { readOnly: true });
  const listed = reader.prepare("SELECT key_id FROM messages m WHERE (m.flags & 1) <> 0 AND m.id > 0 ORDER BY m.id").all().map((row) => row.key_id);
  reader.close();
  assert.deepEqual(listed, ["KEEP"]);
});
