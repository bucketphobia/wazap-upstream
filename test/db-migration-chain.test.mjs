/**
 * The upgrade path a user really walks: a file written by any released schema
 * version reaches the current one, whole. Every fixture here is built through
 * the released migration SQL and plain inserts — never through today's
 * writers, which would put today's shape into a file that is meant to be old.
 *
 * What is proven, from every historical version: the schema ends up the one a
 * new file gets, object for object; every row the file held is still there and
 * still says the same thing; the trigram index answers after the upgrade;
 * SQLite's own integrity_check and foreign_key_check pass; a second open
 * changes nothing; an upgrade cut off in the middle leaves the file at the
 * version it started from, with its rows, and the next open finishes the job;
 * a write-ahead log a crash left behind is migrated with the commits still in
 * it; and a file from a schema this build does not know is refused, untouched,
 * with a message that says what to do.
 *
 * The copy an upgrade takes before it touches the file is proven here too: it
 * is the file as it was, it is taken once and only for a database that is
 * really behind, and an upgrade that cannot take it does not start.
 *
 * db-v5.test.mjs asserts what v5 works out from an older file (flags,
 * last_own_id, catch-up marks). This file asserts the chain itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { AccountDb, SCHEMA_VERSION, StorageError, contentHash, preMigrationName } from "../dist/db/index.js";
import { assertRoomForBackup, preMigrationBackupEnabled } from "../dist/db/pre-migration.js";
import { MIGRATIONS } from "../dist/db/schema.js";
import { sqlite } from "../dist/db/sqlite.js";
import { openForReading } from "../dist/legacy-files.js";
import { importLegacyAccount, scrubQuote } from "../dist/legacy-import/index.js";
import { GROUP, ME, PEER, PEER_LID, T0, sid, tempDir, textMessage } from "./db-fixtures.mjs";
import { buildLegacyAccount } from "./legacy-fixtures.mjs";

/** Every version a released wazap ever wrote. Each one must reach SCHEMA_VERSION. */
const RELEASED = MIGRATIONS.map((migration) => migration.version);
const SEQ = 1048576;
const DAY = 86_400_000;
const DIMS = 768;
const MODEL = "embeddinggemma-300m";
const PEER2 = "40700000003@s.whatsapp.net";

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const mode = (path) => statSync(path).mode & 0o777;
/** Permissions mean nothing to root, and Windows has none of these. */
const modesApply = process.platform !== "win32" && process.getuid?.() !== 0;
/** A message id: the second it belongs to, then a place inside it (ids.ts). */
const idAt = (ts, seq) => (ts / 1000) * SEQ + seq;
const sorted = (items) => items.map((item) => item.sid).sort();

/** A quantized vector, the shape the recall index stores. */
function vector(i) {
  const out = new Int8Array(DIMS);
  for (let d = 0; d < DIMS; d++) out[d] = ((d * 31 + i * 17) % 200) - 100;
  return out;
}

/** The error a call threw, for assertions on more than its type. */
function thrown(body) {
  try {
    body();
  } catch (err) {
    return err;
  }
  return assert.fail("nothing was thrown");
}

/**
 * A file at `version`, holding what an account of that version held: contacts
 * and their lid pairings, four chats (one folding into another, one cleared
 * through a barrier), messages both ways with a tombstone, a voice note with
 * its transcript and one still waiting for it, media, reactions, votes,
 * receipts, notes, a handled mark, embeddings and the queue beside them, and —
 * from the version that first had them — sends, the transcription queue and
 * outbox events. Written through the released migration SQL only.
 *
 * `wal` leaves the file in write-ahead logging and the connection open, so a
 * caller can copy the file and its log the way a crash leaves them. `data`
 * off writes the schema alone: an account that had not stored anything yet.
 */
function releasedFile(version, { dir = join(tempDir("wazap-chain-"), "account"), wal = false, data = true } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "wazap.sqlite");
  const db = new (sqlite().DatabaseSync)(path);
  if (wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.exec(migration.sql);
    db.exec(`PRAGMA user_version = ${migration.version}`);
  }
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const ids = {};
  if (!data) {
    db.exec("COMMIT");
    if (wal) return { path, dir, ids, db };
    db.close();
    return { path, dir, ids, db: null };
  }

  run("INSERT INTO meta(key, value) VALUES ('owner', ?)", ME);
  run("INSERT INTO meta(key, value) VALUES ('created_at', ?)", String(T0 - DAY));
  // A model is being fed, so every message stored queues for it: the state a
  // recall-enabled account is in when it upgrades.
  run("INSERT INTO meta(key, value) VALUES ('embed_model', ?)", MODEL);

  run("INSERT INTO contacts(id, phone_jid, name, notify, listed, updated_at) VALUES (1, ?, 'Ana Pop', 'Ana', 1, ?)", PEER, T0);
  run("INSERT INTO contacts(id, lid, push_name, updated_at) VALUES (2, ?, 'Ana', ?)", PEER_LID, T0);
  run("INSERT INTO contacts(id, phone_jid, push_name, updated_at) VALUES (3, ?, 'Bogdan', ?)", PEER2, T0);
  run("INSERT INTO lid_phones(lid, phone_jid, learned_at) VALUES (?, ?, ?)", PEER_LID, PEER, T0);

  run("INSERT INTO chats(id, jid, kind, contact_id, unread) VALUES (1, ?, 'direct', 1, 2)", PEER);
  run("INSERT INTO chats(id, jid, kind, name) VALUES (2, ?, 'group', 'Fotbal marți')", GROUP);
  // A lid chat a fold had not finished moving when the file was last closed.
  run("INSERT INTO chats(id, jid, kind, contact_id, merged_into) VALUES (3, ?, 'direct', 2, 1)", PEER_LID);
  run("INSERT INTO chats(id, jid, kind, contact_id) VALUES (4, ?, 'direct', 3)", PEER2);

  let seq = 0;
  const message = (name, chatId, keyId, fromMe, ts, fields = {}) => {
    const id = idAt(ts, seq++);
    run(
      `INSERT INTO messages(id, chat_id, key_id, from_me, sender_id, ts, type, text, transcript, transcript_info, status, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      chatId,
      keyId,
      fromMe ? 1 : 0,
      fromMe ? null : chatId === 1 ? 1 : 3,
      ts,
      fields.type ?? "text",
      fields.text ?? null,
      fields.transcript ?? null,
      fields.transcriptInfo ?? null,
      fields.status ?? null,
      new Uint8Array([0x0a, keyId.length, ...Buffer.from(keyId)])
    );
    ids[name] = id;
    return id;
  };

  message("ana1", 1, "A1", false, T0 + 1_000, { text: "Salut, ajungem la sase?" });
  message("ana2", 1, "A2", true, T0 + 2_000, { text: "Da, ajung la sase fix" });
  message("anaGone", 1, "A3", false, T0 + 3_000, { text: "un mesaj care dispare" });
  message("voice", 1, "V1", false, T0 + 4_000, { type: "audio", transcript: "transcrierea notei vocale", transcriptInfo: '{"by":"local"}' });
  message("waiting", 1, "V2", false, T0 + 5_000, { type: "audio" });
  message("lid", 3, "L1", true, T0 + 6_000, { text: "trimis pe lid, inainte de fold" });
  message("group1", 2, "G1", false, T0 + 7_000, { text: "Cine vine marti?" });
  message("group2", 2, "G2", true, T0 + 8_000, { text: "Vin si eu", status: 3 });
  message("hidden", 4, "H1", false, T0 + 9_000, { text: "sub bariera" });
  message("shown", 4, "H2", true, T0 + 11_000, { text: "dupa bariera" });

  // The barrier goes up after its messages, the way a clear really happens.
  run("UPDATE chats SET cleared_through_ts = ? WHERE id = 4", T0 + 10_000);

  // A message deleted for good: a tombstone, its record, and no words left.
  run("UPDATE messages SET text = NULL, transcript = NULL, transcript_info = NULL, raw = NULL, deleted_at = ? WHERE id = ?", T0 + 20_000, ids.anaGone);
  run("INSERT INTO retracted(key_id, from_me, chat_id, at) VALUES ('A3', 0, 1, ?)", T0 + 20_000);

  run("INSERT INTO reactions(message_id, contact_id, emoji, ts) VALUES (?, 1, '👍', ?)", ids.ana2, T0 + 2_500);
  run("INSERT INTO reactions(message_id, contact_id, emoji, ts) VALUES (?, 3, '🎉', ?)", ids.group2, T0 + 8_500);
  run("INSERT INTO votes(message_id, contact_id, choice, ts) VALUES (?, 3, ?, ?)", ids.group1, '["marti"]', T0 + 7_500);
  run("INSERT INTO receipts(message_id, contact_id, delivered_at, read_at) VALUES (?, 1, ?, ?)", ids.ana2, T0 + 2_100, T0 + 2_200);
  run("INSERT INTO receipts(message_id, contact_id, delivered_at, read_at, played_at) VALUES (?, 3, ?, ?, ?)", ids.group2, T0 + 8_100, T0 + 8_200, T0 + 8_300);

  run("INSERT INTO media(message_id, kind, path, created_at) VALUES (?, 'audio', 'media/v1.ogg', ?)", ids.voice, T0 + 4_100);
  run("INSERT INTO media(message_id, kind, path, created_at) VALUES (?, 'audio', 'media/v2.ogg', ?)", ids.waiting, T0 + 5_100);
  // A file a removed media row left behind, still waiting for the service to unlink it.
  run("INSERT INTO pending_unlinks(path, queued_at) VALUES ('media/gone.jpg', ?)", T0 + 15_000);
  // A second that lost a row to a physical delete keeps the id it handed out.
  run("INSERT INTO id_high(second, top) VALUES (?, ?)", (T0 + 12_000) / 1000, idAt(T0 + 12_000, 3));

  run("INSERT INTO contact_notes(contact_id, note, tags, fields, updated_at) VALUES (1, 'contabila', ?, ?, ?)", '["lucru"]', '{"oras":"Cluj"}', T0);
  run("INSERT INTO handled(chat_id, ask_message_id, at) VALUES (1, ?, ?)", ids.ana1, T0 + 30_000);

  // Two messages the feed has already embedded; the rest are still queued.
  const embed = (id, text, i) => run("INSERT INTO embeddings(message_id, model, content_hash, vec) VALUES (?, ?, ?, ?)", id, MODEL, contentHash(text, null), vector(i));
  embed(ids.ana1, "Salut, ajungem la sase?", 1);
  embed(ids.group1, "Cine vine marti?", 2);
  run("DELETE FROM embed_queue WHERE message_id IN (?, ?)", ids.ana1, ids.group1);

  if (version >= 2) {
    const send = (draftId, chatJid, keyId, state, updatedAt) =>
      run(
        `INSERT INTO sends(draft_id, owner, chat_jid, kind, payload, key_id, state, created_at, expires_at, updated_at)
         VALUES (?, 'session', ?, 'text', ?, ?, ?, ?, ?, ?)`,
        draftId,
        chatJid,
        '{"text":"Vin si eu"}',
        keyId,
        state,
        T0,
        T0 + DAY,
        updatedAt
      );
    send("d-sent", GROUP, "G2", "sent", T0 + 8_000);
    send("d-unknown", PEER_LID, "L1", "unknown", T0 + 6_000);
    send("d-draft", PEER, "D1", "draft", T0);
  }
  if (version >= 3) {
    run("INSERT INTO transcribe_queue(message_id, provider_class, queued_at, attempts, next_at) VALUES (?, 'local', ?, 1, ?)", ids.waiting, T0 + 5_200, T0 + 6_200);
  }
  if (version >= 4) {
    // Only v4 gave the outbox a table it writes to: v1's placeholder was never
    // written by any released build, and v4 replaces it rather than altering it.
    run(
      `INSERT INTO events(kind, lane, message_id, payload, created_at, ready_at, state, updated_at)
       VALUES ('message_received', 'chat:2', ?, '{}', ?, ?, 'pending', ?)`,
      ids.group1,
      T0 + 7_000,
      T0 + 7_000,
      T0 + 7_000
    );
  }
  db.exec("COMMIT");
  if (wal) return { path, dir, ids, db };
  db.close();
  return { path, dir, ids, db: null };
}

/** Every object in the schema, in a stable order: what two files must agree on. */
function schemaOf(path) {
  const reader = new (sqlite().DatabaseSync)(path, { readOnly: true });
  try {
    return reader.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name").all();
  } finally {
    reader.close();
  }
}

/** Every row of every table, as sorted JSON: what an open that changes nothing must leave alone. */
function dumpOf(path) {
  const reader = new (sqlite().DatabaseSync)(path, { readOnly: true });
  try {
    const out = { user_version: reader.prepare("PRAGMA user_version").get().user_version };
    for (const { name } of reader.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      out[name] = reader
        .prepare(`SELECT * FROM "${name}"`)
        .all()
        .map((row) => JSON.stringify(row, (_key, value) => (value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value)))
        .sort();
    }
    return out;
  } finally {
    reader.close();
  }
}

/** SQLite's own verdicts, which the product's quick_check does not cover. */
function sqliteChecks(path) {
  const reader = new (sqlite().DatabaseSync)(path, { readOnly: true });
  try {
    return {
      integrity: reader
        .prepare("PRAGMA integrity_check")
        .all()
        .map((row) => row.integrity_check),
      foreignKeys: reader.prepare("PRAGMA foreign_key_check").all(),
      indexedRows: reader.prepare("SELECT count(*) AS n FROM messages_fts").get().n,
      messageRows: reader.prepare("SELECT count(*) AS n FROM messages").get().n,
    };
  } finally {
    reader.close();
  }
}

const upgrade = (path, options = {}) => AccountDb.open(path, { checkpointDelayMs: 0, now: () => T0 + DAY, ...options });

// ------------------------------------------------------- the schema itself

test("every released version is named here, so a new migration cannot ship without a chain test", () => {
  assert.deepEqual(RELEASED, [1, 2, 3, 4, 5, 6]);
  assert.equal(SCHEMA_VERSION, RELEASED[RELEASED.length - 1]);
});

for (const from of RELEASED) {
  test(`a version ${from} file upgrades to the schema a new file gets, object for object`, () => {
    const { path } = releasedFile(from);
    const db = upgrade(path);
    assert.equal(db.schemaVersion, SCHEMA_VERSION);
    db.close();

    const fresh = join(tempDir("wazap-chain-fresh-"), "wazap.sqlite");
    AccountDb.open(fresh, { checkpointDelayMs: 0 }).close();
    assert.deepEqual(schemaOf(path), schemaOf(fresh), `a v${from} file ends up with a different schema than a new one`);
  });

  test(`a version ${from} file keeps every row it held, and SQLite finds nothing wrong afterwards`, () => {
    const { path, ids } = releasedFile(from);
    const before = dumpOf(path);
    const db = upgrade(path);

    // Counts first: nothing silently lost.
    assert.deepEqual(db.counts(), { messages: 8, tombstones: 1, chats: 3, contacts: 3, embeddings: 2 });

    // Then the rows themselves, word for word.
    assert.equal(db.messages.get(sid(false, PEER, "A1")).text, "Salut, ajungem la sase?");
    assert.equal(db.messages.get(sid(true, PEER, "A2")).text, "Da, ajung la sase fix");
    assert.equal(db.messages.get(sid(false, PEER, "A3")), null, "a tombstone stays one");
    assert.equal(db.messages.get(sid(false, PEER, "A3"), { includeHidden: true }).deletedAt, T0 + 20_000);
    assert.equal(db.messages.get(sid(false, PEER, "V1")).transcript, "transcrierea notei vocale");
    assert.equal(db.messages.get(sid(true, PEER, "L1")).text, "trimis pe lid, inainte de fold", "a folding chat's row answers under the number");
    assert.equal(db.messages.get(sid(false, PEER2, "H1")), null, "still under its barrier");
    assert.equal(db.messages.get(sid(true, PEER2, "H2")).text, "dupa bariera");
    assert.deepEqual(
      db.messages.reactions(sid(true, PEER, "A2")).map((row) => row.emoji),
      ["👍"]
    );
    assert.deepEqual(
      db.messages.votes(sid(false, GROUP, "G1")).map((row) => row.choice),
      ['["marti"]']
    );
    assert.equal(db.identity.notes(PEER).note, "contabila");
    assert.equal(db.identity.chat(GROUP).name, "Fotbal marți");
    assert.equal(db.identity.chat(PEER).unread, 2);
    assert.equal(db.getMeta("owner"), ME);
    assert.equal(db.getMeta("created_at"), String(T0 - DAY), "the day the account was created is not restamped");
    assert.deepEqual(db.vectors.get(sid(false, PEER, "A1")).vector, vector(1), "a stored vector is the same bytes after the upgrade");
    assert.equal(db.vectors.count(MODEL), 2);
    if (from >= 2) assert.equal(db.sends.wasSent("G2"), true, "a confirmed send's key is kept past its row");
    if (from >= 4) assert.equal(db.events.get(1).messageId, ids.group1, "the outbox keeps the event it had not posted");
    db.close();

    // And the tables that only carry over, row for row against the file as it
    // was before it was opened. `events` and `sends` are left out on purpose:
    // v4 replaces the placeholder events table and v2 the placeholder sends
    // table, neither of which a released build ever wrote to.
    const after = dumpOf(path);
    for (const table of ["contacts", "lid_phones", "retracted", "reactions", "votes", "receipts", "media", "embeddings", "contact_notes", "handled", "id_high", "pending_unlinks"]) {
      assert.deepEqual(after[table], before[table], `${table} changed while upgrading from v${from}`);
    }
    if (from >= 3) assert.deepEqual(after.transcribe_queue, before.transcribe_queue, "a voice note waiting to be transcribed keeps its place");
    assert.deepEqual(after.embed_queue, before.embed_queue, "the embedding backlog is neither emptied nor refilled");

    const checks = sqliteChecks(path);
    assert.deepEqual(checks.integrity, ["ok"]);
    assert.deepEqual(checks.foreignKeys, [], "no row points at one that is gone");
    assert.equal(checks.indexedRows, checks.messageRows, "the trigram index has one entry per row, no more and no less");
  });

  test(`a version ${from} file's trigram index still answers after the upgrade`, () => {
    const { path } = releasedFile(from);
    const db = upgrade(path);
    // Substring and mid-word: what the trigram tokenizer promises.
    assert.deepEqual(sorted(db.search.text({ query: "ajung", limit: 10 }).items), [sid(false, PEER, "A1"), sid(true, PEER, "A2")].sort());
    assert.deepEqual(sorted(db.search.text({ query: "notei vocale", limit: 10 }).items), [sid(false, PEER, "V1")], "a transcript is searchable too");
    assert.deepEqual(sorted(db.search.text({ query: "bariera", limit: 10 }).items), [sid(true, PEER2, "H2")], "and nothing under a barrier comes back");
    assert.deepEqual(db.search.text({ query: "dispare", limit: 10 }).items, [], "a tombstone's words left the index when it was made");
    assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] }, "the index agrees with the rows it indexes");

    // And it keeps working for what is stored after the upgrade.
    db.messages.upsert(textMessage(PEER, "NEW", T0 + DAY, "ceva nou de cautat"));
    assert.deepEqual(sorted(db.search.text({ query: "cautat", limit: 10 }).items), [sid(false, PEER, "NEW")]);
    db.close();
  });

  test(`a version ${from} file is copied beside itself before it is migrated`, () => {
    const { path, dir } = releasedFile(from);
    const before = dumpOf(path);
    const copy = join(dir, preMigrationName(from));
    upgrade(path).close();

    if (from === SCHEMA_VERSION) {
      assert.deepEqual(readdirSync(dir), ["wazap.sqlite"], "a file already at the current schema has nothing to migrate, so nothing to copy");
      return;
    }
    // One copy, not one per migration run, and no temp file beside it. Read
    // before anything opens the database again: a reader leaves a -shm of its own.
    assert.deepEqual(readdirSync(dir).sort(), [preMigrationName(from), "wazap.sqlite"]);
    if (modesApply) assert.equal(mode(copy), 0o600, "owner-only, like the database it copies");
    assert.deepEqual(sqliteChecks(copy).integrity, ["ok"], "SQLite finds nothing wrong with the copy");
    assert.deepEqual(dumpOf(copy), before, "every row the file held, at the version it held them");
    assert.equal(dumpOf(path).user_version, SCHEMA_VERSION, "while the database itself went on to the current schema");
  });

  test(`a version ${from} file opened a second time is left exactly as the upgrade left it`, () => {
    const { path } = releasedFile(from);
    const first = upgrade(path);
    const stamps = Object.fromEntries(RELEASED.map((version) => [version, first.getMeta(`migrated_v${version}`)]));
    first.close();
    const after = dumpOf(path);

    const second = AccountDb.open(path, { checkpointDelayMs: 0, now: () => T0 + 30 * DAY });
    assert.equal(second.schemaVersion, SCHEMA_VERSION);
    for (const version of RELEASED) assert.equal(second.getMeta(`migrated_v${version}`), stamps[version], `migrated_v${version} was stamped a second time`);
    second.close();
    assert.deepEqual(dumpOf(path), after, "a second open is not a second migration");
  });
}

// --------------------------------------------- an upgrade that is cut off

// A v1 file has four migrations left to run, each of which reads the clock
// twice — to stamp its version and to fill created_at. Cutting the clock after
// `stamps` of those reads is a process dying with that many versions' SQL
// already run inside the migration transaction.
for (const stamps of [0, 1, 2, 3]) {
  test(`an upgrade cut off while it writes version ${stamps + 2} leaves the file at the version it started from, and the next open finishes it`, () => {
    const { path, ids } = releasedFile(1);
    const before = dumpOf(path);
    const schema = schemaOf(path);

    let reads = 0;
    assert.throws(
      () =>
        upgrade(path, {
          now: () => {
            if (++reads > stamps * 2) throw new Error("pana de curent");
            return T0 + DAY;
          },
        }),
      /pana de curent/
    );

    const half = dumpOf(path);
    assert.equal(half.user_version, 1, "a cut-off upgrade goes back to the version the file was at");
    assert.deepEqual(half, before, "and to the rows it had");
    assert.deepEqual(schemaOf(path), schema, "and to the schema it had: no half-migrated file is left behind");

    const finished = upgrade(path);
    assert.equal(finished.schemaVersion, SCHEMA_VERSION, "the next open takes it the rest of the way");
    assert.deepEqual(finished.counts(), { messages: 8, tombstones: 1, chats: 3, contacts: 3, embeddings: 2 });
    assert.equal(finished.messages.get(sid(false, PEER, "A1")).text, "Salut, ajungem la sase?");
    assert.equal(finished.identity.chat(PEER).lastOwnId, ids.lid, "the v5 backfill ran over the whole file, not half of it");
    assert.deepEqual(finished.integrityCheck(), { ok: true, problems: [] });
    finished.close();
    assert.deepEqual(sqliteChecks(path).integrity, ["ok"]);
  });
}

// -------------------------------------------- a log a crash left behind

test("a write-ahead log a crash left beside an old file is migrated with the commits still in it", () => {
  const { path, db } = releasedFile(1, { wal: true });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  // Committed after that checkpoint, so these rows live only in the log: what
  // a crash leaves, and what the upgrade must neither miss nor undo.
  db.exec("BEGIN IMMEDIATE");
  for (let i = 0; i < 4; i++) {
    const ts = T0 + 40_000 + i * 1000;
    db.prepare("INSERT INTO messages(id, chat_id, key_id, from_me, sender_id, ts, type, text, raw) VALUES (?, 1, ?, 0, 1, ?, 'text', ?, ?)").run(
      idAt(ts, 0),
      `W${i}`,
      ts,
      `doar in jurnal ${i}`,
      new Uint8Array([1, 2, 3])
    );
  }
  db.exec("COMMIT");

  const crashed = join(tempDir("wazap-chain-crash-"), "account", "wazap.sqlite");
  mkdirSync(dirname(crashed), { recursive: true });
  for (const suffix of ["", "-wal"]) copyFileSync(`${path}${suffix}`, `${crashed}${suffix}`);
  db.close();
  assert.ok(readFileSync(`${crashed}-wal`).length > 0, "the copy really carries a log nothing checkpointed");

  const recovered = upgrade(crashed);
  assert.equal(recovered.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(recovered.counts(), { messages: 12, tombstones: 1, chats: 3, contacts: 3, embeddings: 2 }, "the eight the file showed and the four the log held");
  assert.equal(recovered.messages.get(sid(false, PEER, "W3")).text, "doar in jurnal 3");
  assert.equal(recovered.search.text({ query: "jurnal", limit: 20 }).items.length, 4, "the rows the log carried are in the trigram index too");
  assert.deepEqual(recovered.integrityCheck(), { ok: true, problems: [] });
  recovered.close();
  assert.deepEqual(sqliteChecks(crashed), { integrity: ["ok"], foreignKeys: [], indexedRows: 14, messageRows: 14 });
});

// ------------------------------------------------- a schema from the future

test("a file from a schema this build does not know is refused, untouched, with a message that says what to do", () => {
  const { path, dir } = releasedFile(1);
  upgrade(path).close();
  // The copy the upgrade took is the only thing beside the file: no log, no
  // shared memory. It is the baseline the refusal below must not add to.
  const settled = ["wazap.1.pre-migration.sqlite", "wazap.sqlite"];
  assert.deepEqual(readdirSync(dir).sort(), settled, "a clean close leaves nothing beside the file but the copy it took");
  // user_version lives at offset 60 of the header, big-endian: as far as this
  // build can tell, a file a later wazap wrote.
  const bytes = readFileSync(path);
  bytes.writeUInt32BE(SCHEMA_VERSION + 1, 60);
  writeFileSync(path, bytes);
  const before = digest(path);

  const refusal = thrown(() => AccountDb.open(path, { checkpointDelayMs: 0 }));
  assert.ok(refusal instanceof StorageError && refusal.code === "SCHEMA_TOO_NEW");
  assert.match(refusal.message, new RegExp(`schema version ${SCHEMA_VERSION + 1}`), "it names the version it found");
  assert.match(refusal.message, new RegExp(`knows up to ${SCHEMA_VERSION}`), "and the one it knows");
  assert.match(refusal.fix, /npm i -g wazap-mcp@latest/, "and how to get out of it");
  assert.equal(digest(path), before, "a refused open writes nothing");
  assert.deepEqual(readdirSync(dir).sort(), settled, "and leaves no log, no shared memory and no copy behind");

  // status and doctor read the same file the same way: they say so rather than
  // read a schema they only half understand.
  const reading = thrown(() => openForReading(path));
  assert.ok(reading instanceof StorageError && reading.code === "SCHEMA_TOO_NEW");
  assert.equal(digest(path), before);
  assert.deepEqual(readdirSync(dir).sort(), settled);

  // And the file is still one the wazap that wrote it can pick up.
  const reader = new (sqlite().DatabaseSync)(path, { readOnly: true });
  assert.equal(reader.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION + 1);
  assert.equal(reader.prepare("SELECT count(*) AS n FROM messages").get().n, 10);
  reader.close();
});

/**
 * A newer wazap that crashed leaves a file whose log carries the newer schema.
 * This build must refuse it — and it does — but the refusal is not free: the
 * read-write open is what checkpoints the log into the database file, and the
 * close that follows the refusal deletes the log. The file connection.ts
 * promises to leave "exactly as it was" comes back written by the older build.
 * Nothing committed is lost (a checkpoint only moves what is already there),
 * but the promise does not hold, and the user who meant to hand the file back
 * to the wazap that wrote it hands back a different file.
 *
 * Left failing on purpose: the fix is a decision (open the file read-only, or
 * immutable, for the version check before any read-write connection touches
 * it), not something a test should make quietly.
 */
test("a newer schema that is still only in the write-ahead log is refused, and the log is left as it was", { todo: "the refusal checkpoints the log into the file and deletes it; see the note above" }, () => {
  const { path, db } = releasedFile(SCHEMA_VERSION, { wal: true });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);

  const future = join(tempDir("wazap-chain-future-"), "account", "wazap.sqlite");
  mkdirSync(dirname(future), { recursive: true });
  for (const suffix of ["", "-wal"]) copyFileSync(`${path}${suffix}`, `${future}${suffix}`);
  db.close();
  const before = { file: digest(future), wal: digest(`${future}-wal`) };

  const refusal = thrown(() => AccountDb.open(future, { checkpointDelayMs: 0 }));
  assert.ok(refusal instanceof StorageError && refusal.code === "SCHEMA_TOO_NEW", `refused with ${refusal?.code ?? refusal}`);
  assert.match(refusal.message, new RegExp(`schema version ${SCHEMA_VERSION + 1}`), "the version in the log is the one it reports");
  assert.equal(existsSync(`${future}-wal`), true, "the log a newer wazap left is still there");
  assert.equal(digest(`${future}-wal`), before.wal, "and unchanged");
  assert.equal(digest(future), before.file, "the database file is untouched");
});

test("what that refusal does do today, so the gap is on the record and not a surprise", () => {
  const { path, db } = releasedFile(SCHEMA_VERSION, { wal: true });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  const future = join(tempDir("wazap-chain-future-"), "account", "wazap.sqlite");
  mkdirSync(dirname(future), { recursive: true });
  for (const suffix of ["", "-wal"]) copyFileSync(`${path}${suffix}`, `${future}${suffix}`);
  db.close();

  const refusal = thrown(() => AccountDb.open(future, { checkpointDelayMs: 0 }));
  assert.ok(refusal instanceof StorageError && refusal.code === "SCHEMA_TOO_NEW", "it is refused, which is the part that matters");
  // What the older build did to the file on its way out. Nothing committed is
  // gone — the version and the rows the log carried are in the file now.
  assert.equal(existsSync(`${future}-wal`), false, "today the log is checkpointed away by the refused open");
  const reader = new (sqlite().DatabaseSync)(future, { readOnly: true });
  try {
    assert.equal(reader.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION + 1, "the newer version survived the checkpoint");
    assert.equal(reader.prepare("SELECT count(*) AS n FROM messages").get().n, 10, "and so did every row");
    assert.deepEqual(
      reader
        .prepare("PRAGMA integrity_check")
        .all()
        .map((row) => row.integrity_check),
      ["ok"]
    );
  } finally {
    reader.close();
  }
});

// ----------------------------------- the whole way from the 0.21 JSON files

test("an account that still has its 0.21 files and a 0.22 database reaches the current schema and then imports them", async () => {
  const fx = await buildLegacyAccount();
  // What a 0.22 install left beside the legacy files: an account database at
  // schema v1, whose import had not run when the user upgraded.
  const { path } = releasedFile(1, { dir: join(fx.dataDir, "accounts", "default"), data: false });
  assert.equal(dumpOf(path).user_version, 1);

  const db = AccountDb.open(path, { scrubQuote, checkpointDelayMs: 0, now: () => fx.now });
  try {
    assert.equal(db.schemaVersion, SCHEMA_VERSION, "the 0.22 file is migrated before a legacy file is read");
    const report = await importLegacyAccount({ dataDir: fx.dataDir, accountId: "default", accountPaths: fx.paths, db, options: { now: () => fx.now } });
    assert.equal(report.state, "done");
    assert.equal(report.owner, ME);
    assert.equal(report.verification.ok, true, JSON.stringify(report.verification.unexpected));
    assert.ok(db.counts().messages > 10, "the JSON files' messages are in the database");
    assert.ok(db.search.text({ query: "sedinta", limit: 20 }).items.length > 0, "and in the trigram index");
    assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });
  } finally {
    db.close();
  }
  assert.deepEqual(sqliteChecks(path).integrity, ["ok"]);
  assert.deepEqual(sqliteChecks(path).foreignKeys, []);
});

// ------------------------------------------ the copy taken before the upgrade

/**
 * This is where "nothing copies the database before it migrates it" used to be
 * pinned. It does now: an upgrade's safety net is no longer only that it is one
 * transaction. What the copy must be, and must not be, is below.
 */

test("a database that is new, or already current, is not copied: there is nothing to copy it from", () => {
  const fresh = join(tempDir("wazap-chain-fresh-"), "wazap.sqlite");
  AccountDb.open(fresh, { checkpointDelayMs: 0 }).close();
  assert.deepEqual(readdirSync(dirname(fresh)), ["wazap.sqlite"], "a file created here was never at another version");

  // And the open that follows, which finds the schema current, adds nothing.
  AccountDb.open(fresh, { checkpointDelayMs: 0 }).close();
  assert.deepEqual(readdirSync(dirname(fresh)), ["wazap.sqlite"]);
});

test("a read-only open never copies, whatever version it finds: status and doctor write nothing at all", () => {
  const { path, dir } = releasedFile(1);
  const before = digest(path);

  for (const open of [() => openForReading(path), () => AccountDb.open(path, { readOnly: true }), () => AccountDb.open(path, { readOnly: true, immutable: true })]) {
    const refusal = thrown(open);
    assert.ok(refusal instanceof StorageError && refusal.code === "SCHEMA_OUTDATED", `refused with ${refusal?.code ?? refusal}`);
  }
  assert.deepEqual(readdirSync(dir), ["wazap.sqlite"], "no copy, no log, no shared memory");
  assert.equal(digest(path), before);
});

test("a copy already beside the file that reads whole is kept as it is, not taken again", () => {
  const { path, dir } = releasedFile(1);
  const copy = join(dir, preMigrationName(1));
  // A first attempt that died after writing its copy: a byte-for-byte copy of
  // the file, which is a different file on disk than a fresh one would be.
  copyFileSync(path, copy);
  const kept = digest(copy);

  upgrade(path).close();
  assert.equal(digest(copy), kept, "the copy on disk is the one that was already there");
  assert.equal(dumpOf(path).user_version, SCHEMA_VERSION);
});

test("a copy already beside the file that does not read whole is replaced, atomically", () => {
  const { path, dir } = releasedFile(1);
  const copy = join(dir, preMigrationName(1));
  writeFileSync(copy, "not a database at all");

  upgrade(path).close();
  assert.deepEqual(sqliteChecks(copy).integrity, ["ok"], "what is there now is a database");
  assert.equal(dumpOf(copy).user_version, 1, "at the version the name claims");
  assert.deepEqual(readdirSync(dir).sort(), [preMigrationName(1), "wazap.sqlite"], "and no half-written temp file is left beside it");
});

test("an upgrade that cannot write its copy does not start, and says why without naming a path", { skip: !modesApply }, () => {
  // A log and its shared memory beside the file, the way a running wazap
  // leaves them, so the only thing the folder is needed for is the copy.
  const { path, dir, db: live } = releasedFile(1, { wal: true });
  const before = dumpOf(path);
  chmodSync(dir, 0o500);
  let refusal;
  try {
    refusal = thrown(() => upgrade(path));
  } finally {
    chmodSync(dir, 0o700);
  }

  assert.ok(refusal instanceof StorageError && refusal.code === "BACKUP_FAILED", `refused with ${refusal?.code ?? refusal}`);
  assert.match(refusal.message, /could not be copied before its upgrade \(EACCES\)/, "the cause is a code, not a system message");
  assert.doesNotMatch(refusal.message, /wazap\.sqlite|\//, "and no path of the user's is in it");
  assert.match(refusal.fix, /WAZAP_PRE_MIGRATION_BACKUP=0/, "with the way out for someone who means it");

  assert.deepEqual(dumpOf(path), before, "the database is at the version it was, with the rows it had");
  assert.deepEqual(readdirSync(dir).sort(), ["wazap.sqlite", "wazap.sqlite-shm", "wazap.sqlite-wal"], "and nothing half-written is left behind");
  live.close();

  // The next start, with the folder writable again, takes the copy and migrates.
  upgrade(path).close();
  assert.equal(dumpOf(path).user_version, SCHEMA_VERSION);
  assert.deepEqual(dumpOf(join(dir, preMigrationName(1))), before);
});

test("a disk that cannot hold the copy is refused before the first byte is written", () => {
  const dir = tempDir("wazap-chain-space-");
  const path = join(dir, "wazap.sqlite");
  // A database and a disk of known sizes, the disk handed in: a real
  // filesystem's limits differ (ext4 refuses a sparse file of a petabyte with
  // EFBIG), so the reading is what is under test, not the disk it ran on.
  writeFileSync(path, Buffer.alloc(64 * 1024));
  const disk = (free) => () => free;

  const refusal = thrown(() => assertRoomForBackup(path, dir, disk(1024 * 1024)));
  assert.ok(refusal instanceof StorageError && refusal.code === "BACKUP_FAILED", `refused with ${refusal?.code ?? refusal}`);
  assert.match(refusal.message, /less free space than the copy needs/);
  assert.match(refusal.message, /nothing was migrated/);
  assert.doesNotMatch(refusal.message, /\//, "no path in it");

  assert.doesNotThrow(() => assertRoomForBackup(path, dir, disk(64 * 1024 * 1024)), "a disk with room for it and the margin is no objection");
  assert.doesNotThrow(
    () =>
      assertRoomForBackup(path, dir, () => {
        throw new Error("no answer");
      }),
    "a filesystem that will not say is left to the write itself"
  );
  assert.doesNotThrow(() => assertRoomForBackup(path, dir), "and the real reading of this disk holds a 64 KiB database");
});

test("the copy can be turned off knowingly, by the setting and by the option", () => {
  const byOption = releasedFile(1);
  upgrade(byOption.path, { preMigrationBackup: false }).close();
  assert.deepEqual(readdirSync(byOption.dir), ["wazap.sqlite"], "the option skips it");
  assert.equal(dumpOf(byOption.path).user_version, SCHEMA_VERSION, "and the upgrade still runs");

  assert.equal(preMigrationBackupEnabled({}), true, "unset means the copy is taken");
  assert.equal(preMigrationBackupEnabled({ WAZAP_PRE_MIGRATION_BACKUP: "1" }), true);
  assert.equal(preMigrationBackupEnabled({ WAZAP_PRE_MIGRATION_BACKUP: "0" }), false);
  assert.equal(preMigrationBackupEnabled({ WAZAP_PRE_MIGRATION_BACKUP: "off" }), false);

  const bySetting = releasedFile(1);
  const had = process.env.WAZAP_PRE_MIGRATION_BACKUP;
  process.env.WAZAP_PRE_MIGRATION_BACKUP = "0";
  try {
    upgrade(bySetting.path).close();
  } finally {
    if (had === undefined) delete process.env.WAZAP_PRE_MIGRATION_BACKUP;
    else process.env.WAZAP_PRE_MIGRATION_BACKUP = had;
  }
  assert.deepEqual(readdirSync(bySetting.dir), ["wazap.sqlite"], "and so does the setting");
  assert.equal(dumpOf(bySetting.path).user_version, SCHEMA_VERSION);
});

test("two processes upgrading the same file at once leave one copy, of the file as it was", async () => {
  const { path, dir } = releasedFile(1);
  const before = dumpOf(path);
  const open = `
    const { AccountDb } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, "dist", "db", "index.js")).href)});
    const db = AccountDb.open(${JSON.stringify(path)}, { checkpointDelayMs: 0, timeoutMs: 20000 });
    process.stdout.write(String(db.schemaVersion));
    db.close();
  `;
  const both = await Promise.all([run(process.execPath, ["--input-type=module", "-e", open]), run(process.execPath, ["--input-type=module", "-e", open])]);
  for (const done of both) assert.equal(done.stdout, String(SCHEMA_VERSION), "both ended up on the current schema");

  const copies = readdirSync(dir).filter((name) => name.endsWith(".pre-migration.sqlite"));
  assert.deepEqual(copies, [preMigrationName(1)], "one copy, not one per process");
  assert.deepEqual(dumpOf(join(dir, copies[0])), before, "and it is the file as it was, not one halfway through its upgrade");
  // The log and its shared memory may outlive two processes closing at once —
  // whichever closed last could not take the lock that deletes them. A half
  // written copy may not.
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "no temp file of a loser is left behind");
});
