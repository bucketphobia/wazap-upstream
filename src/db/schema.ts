/**
 * The account database schema, as ordered migrations over `PRAGMA
 * user_version`. Version N is reached by running migrations 1..N in order.
 * Every migration still pending, with its version bump, runs inside one
 * transaction (`Connection.migrate`), so a crash leaves the file at the whole
 * version it started from and the next open runs them again from there. The
 * file as it was before that transaction is kept beside it for a week
 * (`pre-migration.ts`). A migration, once released, never changes: a new shape
 * is a new entry at the end.
 *
 * Units: every time column is epoch milliseconds. Message ids are
 * chronological (see ids.ts), and the CHECK on `messages` holds the id's
 * second to the timestamp's second, so an id range is a time range.
 *
 * Invariants the schema itself defends, whatever code writes to it:
 * - a message keeps its id, timestamp, key and direction forever, is unique by
 *   chat, direction and key, and its id is never handed out again;
 * - a tombstone (deleted_at set) holds no text, transcript or raw bytes, and
 *   stays a tombstone;
 * - the full-text index and the embeddings follow text and transcript, and a
 *   tombstone takes its embedding, reactions, votes and receipts with it;
 * - (v3) a voice note leaves the transcription queue once it has a transcript,
 *   and with its tombstone or its row;
 * - chats.last_* names the newest message a reader may see — not a tombstone,
 *   not under the clear barrier — after any insert, tombstone, delete or move;
 *   (v5) chats.last_own_id does the same for the account's own messages, and
 *   through a barrier raised or a fold started too;
 * - a file a removed media row pointed at is queued for unlinking in the same
 *   transaction, so a crash never loses it;
 * - a message of the account's own that goes for good leaves no words in the
 *   send that made it.
 */

export interface Migration {
  version: number;
  sql: string;
}

const V1 = `
CREATE TABLE meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- One row per person. phone_jid is the number once known; lid is the lid that
-- currently answers for that number (or the only id of a person whose number
-- is unknown). A row merging into another has both cleared and merged_into set
-- until its references have moved over; nothing resolves to it meanwhile.
CREATE TABLE contacts(
  id INTEGER PRIMARY KEY,
  phone_jid TEXT UNIQUE,
  lid TEXT UNIQUE,
  name TEXT,
  -- The name WhatsApp's contact sync gives (notify), and the one the person
  -- publishes on their own messages (push_name): both are searched, and a
  -- contact's notify is shown before a message's push name.
  notify TEXT,
  push_name TEXT,
  verified_name TEXT,
  is_business INTEGER,
  -- The order a contact event first named this person: the address book's
  -- order. NULL for someone known only from their messages or a group.
  listed INTEGER,
  updated_at INTEGER NOT NULL,
  merged_into INTEGER REFERENCES contacts(id)
) STRICT;
CREATE INDEX contacts_merging ON contacts(merged_into) WHERE merged_into IS NOT NULL;
-- The address book's next place is read off this, not counted over every person.
CREATE INDEX contacts_listed ON contacts(listed) WHERE listed IS NOT NULL;

-- Every lid -> number pairing learned, the table Baileys keeps: a lid answers
-- for the number it was last learned with, and an older lid of a number keeps
-- answering for it.
CREATE TABLE lid_phones(
  lid TEXT PRIMARY KEY,
  phone_jid TEXT NOT NULL,
  learned_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX lid_phones_phone ON lid_phones(phone_jid);

-- A direct chat lives under the canonical jid of its person: the number once
-- known. A lid chat folding into the number's chat keeps its row, with
-- merged_into set, until its messages have moved.
CREATE TABLE chats(
  id INTEGER PRIMARY KEY,
  jid TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  contact_id INTEGER REFERENCES contacts(id),
  name TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER,
  muted_until INTEGER,
  unread INTEGER NOT NULL DEFAULT 0,
  cleared_through_ts INTEGER,
  last_message_id INTEGER,
  last_ts INTEGER,
  last_from_me INTEGER,
  -- Visible messages filed under this row: not deleted, after the clear
  -- barrier. Kept by the triggers on messages, so coverage never counts rows.
  visible INTEGER NOT NULL DEFAULT 0,
  proto BLOB,
  merged_into INTEGER REFERENCES chats(id)
) STRICT;
CREATE INDEX chats_waiting ON chats(last_from_me, last_ts);
CREATE INDEX chats_recent ON chats(last_ts);
CREATE INDEX chats_contact ON chats(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX chats_merging ON chats(merged_into) WHERE merged_into IS NOT NULL;

-- Column order is deliberate: the small columns every filter reads come
-- first, the large ones last, so checking deleted_at or expires_at never
-- walks past a raw blob into its overflow pages.
CREATE TABLE messages(
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id),
  key_id TEXT NOT NULL,
  from_me INTEGER NOT NULL CHECK (from_me IN (0, 1)),
  sender_id INTEGER REFERENCES contacts(id),
  ts INTEGER NOT NULL CHECK (ts > 0),
  type TEXT NOT NULL,
  quoted_sid TEXT,
  quoted_from_me INTEGER,
  quoted_key_id TEXT,
  status INTEGER,
  edited_at INTEGER,
  expires_at INTEGER,
  deleted_at INTEGER,
  text TEXT,
  transcript TEXT,
  -- Who made the transcript and when, with its language and length when known: JSON.
  transcript_info TEXT,
  raw BLOB,
  CHECK ((id >> 20) = (ts / 1000)),
  CHECK (deleted_at IS NULL OR (text IS NULL AND transcript IS NULL AND transcript_info IS NULL AND raw IS NULL))
) STRICT;
-- A message is its chat, its direction and its WhatsApp key; every sid
-- spelling resolves to that through the chat, so no spelling is stored.
CREATE UNIQUE INDEX messages_key ON messages(chat_id, from_me, key_id);
CREATE INDEX messages_chat ON messages(chat_id, id);
CREATE INDEX messages_sender ON messages(sender_id, id) WHERE sender_id IS NOT NULL;
CREATE INDEX messages_expiry ON messages(expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
-- Quotes are matched by the quoted message's key, whatever address spelled it.
CREATE INDEX messages_quoted ON messages(quoted_key_id) WHERE quoted_key_id IS NOT NULL;
CREATE INDEX messages_tombstones ON messages(deleted_at) WHERE deleted_at IS NOT NULL;

-- Every message deleted, retracted or expired, by key and without content.
-- A purge removes the tombstone row but never this record, so a quote of the
-- message that arrives later is still scrubbed and the message stays gone.
-- The key is dead for good: sends (F1-e) must not reuse a pre-generated key
-- after a definite failure. The table only grows, a row per such message.
CREATE TABLE retracted(
  key_id TEXT NOT NULL,
  from_me INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (key_id, from_me, chat_id)
) STRICT, WITHOUT ROWID;

-- Reactions and votes remember the order they arrived in: a reader lists
-- them by time, and two left in the same instant in the order they came. A
-- rowid table keeps that order — a change of mind updates the row in place —
-- where a table keyed by message and person cannot.
CREATE TABLE reactions(
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  emoji TEXT NOT NULL,
  ts INTEGER NOT NULL,
  UNIQUE (message_id, contact_id)
) STRICT;
CREATE INDEX reactions_contact ON reactions(contact_id);

CREATE TABLE votes(
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  choice TEXT NOT NULL,
  ts INTEGER NOT NULL,
  UNIQUE (message_id, contact_id)
) STRICT;
CREATE INDEX votes_contact ON votes(contact_id);

CREATE TABLE receipts(
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  delivered_at INTEGER,
  read_at INTEGER,
  played_at INTEGER,
  PRIMARY KEY (message_id, contact_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX receipts_contact ON receipts(contact_id);

CREATE TABLE media(
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, kind)
) STRICT, WITHOUT ROWID;
CREATE INDEX media_path ON media(path);

-- content_hash names the words the vector was made from (see contentHash), so
-- a vector computed before an edit or a transcript is never stored as current.
CREATE TABLE embeddings(
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  vec BLOB NOT NULL
) STRICT;

-- Messages whose words the embedding feed has not looked at since they were
-- stored or changed, kept only while a model is fed (meta embed_model): the
-- triggers below queue a message stored with words, or whose words change,
-- and a delete takes it off. The feed takes a row off once it stored a vector,
-- or skipped the message for good (nothing to embed, words the server refuses).
-- A refill (meta embed_refill_before, a descending id cursor) queues what
-- already existed when a model started being fed.
CREATE TABLE embed_queue(
  message_id INTEGER PRIMARY KEY
) STRICT;

CREATE TABLE contact_notes(
  contact_id INTEGER PRIMARY KEY REFERENCES contacts(id),
  note TEXT,
  tags TEXT,
  fields TEXT,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE handled(
  chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  ask_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX handled_ask ON handled(ask_message_id) WHERE ask_message_id IS NOT NULL;

-- F1-d: the durable webhook outbox. Only the table exists until then. A
-- message deleted from under an event leaves message_id NULL: the outbox
-- treats that event as cancelled.
CREATE TABLE events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ready_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_status INTEGER,
  last_error TEXT
) STRICT;
CREATE INDEX events_due ON events(state, next_attempt_at);
CREATE INDEX events_message ON events(message_id) WHERE message_id IS NOT NULL;

-- F1-e: idempotent sends. Only the table exists until then. A key a
-- retraction or a tombstone used is dead (see retracted): retry a definitely
-- failed send with a fresh key, or keep its row.
CREATE TABLE sends(
  draft_id TEXT PRIMARY KEY,
  owner TEXT,
  chat_id INTEGER,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  key_id TEXT,
  state TEXT NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sends_key ON sends(key_id) WHERE key_id IS NOT NULL;

-- Substring search over text and transcript: trigrams, case- and
-- diacritic-insensitive. External content, kept in step by the triggers below.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  transcript,
  content = 'messages',
  content_rowid = 'id',
  tokenize = 'trigram remove_diacritics 1'
);
-- A delete removes the entry from the index at once instead of leaving it
-- for a later merge: deleted text must not stay readable in index pages.
INSERT INTO messages_fts(messages_fts, rank) VALUES ('secure-delete', 1);

CREATE TRIGGER messages_identity_fixed BEFORE UPDATE OF id, ts, key_id, from_me ON messages
WHEN old.id IS NOT new.id OR old.ts IS NOT new.ts OR old.key_id IS NOT new.key_id OR old.from_me IS NOT new.from_me
BEGIN
  SELECT RAISE(ABORT, 'a stored message keeps its id, timestamp, key and direction');
END;

CREATE TRIGGER messages_tombstone_final BEFORE UPDATE OF deleted_at ON messages
WHEN old.deleted_at IS NOT NULL AND new.deleted_at IS NOT old.deleted_at
BEGIN
  SELECT RAISE(ABORT, 'a deleted message stays deleted');
END;

-- Every row has exactly one index entry, an empty one for a row without
-- words, so the index and the table always agree row for row and the
-- external-content integrity check can prove it.
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
BEGIN
  INSERT INTO messages_fts(rowid, text, transcript) VALUES (new.id, new.text, new.transcript);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, transcript) VALUES ('delete', old.id, old.text, old.transcript);
END;

CREATE TRIGGER messages_content_update AFTER UPDATE OF text, transcript ON messages
WHEN old.text IS NOT new.text OR old.transcript IS NOT new.transcript
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, transcript) VALUES ('delete', old.id, old.text, old.transcript);
  INSERT INTO messages_fts(rowid, text, transcript) VALUES (new.id, new.text, new.transcript);
  -- A vector of words the message no longer says is stale; the backlog picks it up again.
  DELETE FROM embeddings WHERE message_id = new.id;
  -- NOT EXISTS, not OR IGNORE: the statement that fired the trigger overrides a trigger's conflict clause.
  INSERT INTO embed_queue(message_id)
    SELECT new.id WHERE (new.text IS NOT NULL OR new.transcript IS NOT NULL)
      AND EXISTS (SELECT 1 FROM meta WHERE key = 'embed_model')
      AND NOT EXISTS (SELECT 1 FROM embed_queue WHERE message_id = new.id);
END;

CREATE TRIGGER messages_embed_insert AFTER INSERT ON messages
WHEN (new.text IS NOT NULL OR new.transcript IS NOT NULL) AND EXISTS (SELECT 1 FROM meta WHERE key = 'embed_model')
BEGIN
  INSERT INTO embed_queue(message_id) SELECT new.id WHERE NOT EXISTS (SELECT 1 FROM embed_queue WHERE message_id = new.id);
END;

-- chats.visible follows every way a message becomes visible or stops being:
-- stored, tombstoned, physically deleted, moved to another chat, or hidden by
-- a raised clear barrier (recounted then, once per clear).
CREATE TRIGGER messages_visible_insert AFTER INSERT ON messages
WHEN new.deleted_at IS NULL
BEGIN
  UPDATE chats SET visible = visible + 1 WHERE id = new.chat_id AND new.ts > coalesce(cleared_through_ts, 0);
END;

CREATE TRIGGER messages_visible_tombstone AFTER UPDATE OF deleted_at ON messages
WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL
BEGIN
  UPDATE chats SET visible = visible - 1 WHERE id = new.chat_id AND new.ts > coalesce(cleared_through_ts, 0);
END;

CREATE TRIGGER messages_visible_delete AFTER DELETE ON messages
WHEN old.deleted_at IS NULL
BEGIN
  UPDATE chats SET visible = visible - 1 WHERE id = old.chat_id AND old.ts > coalesce(cleared_through_ts, 0);
END;

CREATE TRIGGER messages_visible_move AFTER UPDATE OF chat_id ON messages
WHEN old.chat_id IS NOT new.chat_id AND new.deleted_at IS NULL
BEGIN
  UPDATE chats SET visible = visible - 1 WHERE id = old.chat_id AND old.ts > coalesce(cleared_through_ts, 0);
  UPDATE chats SET visible = visible + 1 WHERE id = new.chat_id AND new.ts > coalesce(cleared_through_ts, 0);
END;

CREATE TRIGGER chats_visible_barrier AFTER UPDATE OF cleared_through_ts ON chats
WHEN new.cleared_through_ts IS NOT old.cleared_through_ts
BEGIN
  UPDATE chats SET visible = (
    SELECT count(*) FROM messages m
    WHERE m.chat_id = new.id AND m.deleted_at IS NULL AND m.ts > coalesce(new.cleared_through_ts, 0)
  ) WHERE id = new.id;
END;

CREATE TRIGGER messages_embed_delete AFTER DELETE ON messages
BEGIN
  DELETE FROM embed_queue WHERE message_id = old.id;
END;

-- The highest id a second has ever handed out, kept for seconds that lost
-- rows to a physical delete, so a freed id is never given to another message:
-- nothing that remembered the old id can land on a different one. It only
-- grows, a row per second that lost a row.
CREATE TABLE id_high(
  second INTEGER PRIMARY KEY,
  top INTEGER NOT NULL
) STRICT;

CREATE TRIGGER messages_id_high AFTER DELETE ON messages
BEGIN
  INSERT INTO id_high(second, top) VALUES (old.id >> 20, old.id)
  ON CONFLICT(second) DO UPDATE SET top = max(top, excluded.top);
END;

-- chats.last_* names the newest message a reader may see in the chat and in
-- every chat still folding into it: never a tombstone, never a row at or
-- before the clear barrier. A change in a folding chat updates the chat it
-- folds into as well.
CREATE TRIGGER messages_last_insert AFTER INSERT ON messages
WHEN new.deleted_at IS NULL
BEGIN
  UPDATE chats SET last_message_id = new.id, last_ts = new.ts, last_from_me = new.from_me
  WHERE (id = new.chat_id OR id = (SELECT merged_into FROM chats WHERE id = new.chat_id))
    AND new.ts > coalesce(cleared_through_ts, 0)
    AND (last_message_id IS NULL OR last_message_id < new.id);
END;

CREATE TRIGGER messages_tombstone AFTER UPDATE OF deleted_at ON messages
WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL
BEGIN
  DELETE FROM embeddings WHERE message_id = new.id;
  DELETE FROM embed_queue WHERE message_id = new.id;
  DELETE FROM reactions WHERE message_id = new.id;
  DELETE FROM votes WHERE message_id = new.id;
  DELETE FROM receipts WHERE message_id = new.id;
  UPDATE chats SET (last_message_id, last_ts, last_from_me) = (
    SELECT m.id, m.ts, m.from_me FROM messages m WHERE m.id = (
      SELECT max((
        SELECT x.id FROM messages x
        WHERE x.chat_id = k.id AND x.deleted_at IS NULL
          AND x.id >= (coalesce(k.cleared_through_ts, 0) / 1000) * 1048576
          AND x.ts > coalesce(k.cleared_through_ts, 0)
        ORDER BY x.id DESC LIMIT 1))
      FROM chats k WHERE k.id = chats.id OR k.merged_into = chats.id))
  WHERE (id = new.chat_id OR id = (SELECT merged_into FROM chats WHERE id = new.chat_id)) AND last_message_id = new.id;
END;

CREATE TRIGGER messages_last_delete AFTER DELETE ON messages
BEGIN
  UPDATE chats SET (last_message_id, last_ts, last_from_me) = (
    SELECT m.id, m.ts, m.from_me FROM messages m WHERE m.id = (
      SELECT max((
        SELECT x.id FROM messages x
        WHERE x.chat_id = k.id AND x.deleted_at IS NULL
          AND x.id >= (coalesce(k.cleared_through_ts, 0) / 1000) * 1048576
          AND x.ts > coalesce(k.cleared_through_ts, 0)
        ORDER BY x.id DESC LIMIT 1))
      FROM chats k WHERE k.id = chats.id OR k.merged_into = chats.id))
  WHERE (id = old.chat_id OR id = (SELECT merged_into FROM chats WHERE id = old.chat_id)) AND last_message_id = old.id;
END;

CREATE TRIGGER messages_last_move AFTER UPDATE OF chat_id ON messages
WHEN old.chat_id IS NOT new.chat_id
BEGIN
  UPDATE chats SET (last_message_id, last_ts, last_from_me) = (
    SELECT m.id, m.ts, m.from_me FROM messages m WHERE m.id = (
      SELECT max((
        SELECT x.id FROM messages x
        WHERE x.chat_id = k.id AND x.deleted_at IS NULL
          AND x.id >= (coalesce(k.cleared_through_ts, 0) / 1000) * 1048576
          AND x.ts > coalesce(k.cleared_through_ts, 0)
        ORDER BY x.id DESC LIMIT 1))
      FROM chats k WHERE k.id = chats.id OR k.merged_into = chats.id))
  WHERE (id = old.chat_id OR id = (SELECT merged_into FROM chats WHERE id = old.chat_id)) AND last_message_id = old.id;
  UPDATE chats SET last_message_id = new.id, last_ts = new.ts, last_from_me = new.from_me
  WHERE id = new.chat_id AND new.deleted_at IS NULL AND new.ts > coalesce(cleared_through_ts, 0)
    AND (last_message_id IS NULL OR last_message_id < new.id);
END;

-- Files a removed media row pointed at, queued in the same transaction that
-- removed it, until the service has unlinked them and says so. A path another
-- row still references is not queued; one recorded again leaves the queue.
-- claimed_at marks a path handed to the service to unlink; recording the path
-- again deletes the row, which cancels the claim.
CREATE TABLE pending_unlinks(
  path TEXT PRIMARY KEY,
  queued_at INTEGER NOT NULL,
  claimed_at INTEGER
) STRICT, WITHOUT ROWID;

CREATE TRIGGER media_released AFTER DELETE ON media
WHEN NOT EXISTS (SELECT 1 FROM media WHERE path = old.path)
BEGIN
  INSERT OR IGNORE INTO pending_unlinks(path, queued_at) VALUES (old.path, CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;

CREATE TRIGGER media_replaced AFTER UPDATE OF path ON media
WHEN old.path IS NOT new.path
BEGIN
  DELETE FROM pending_unlinks WHERE path = new.path;
  INSERT OR IGNORE INTO pending_unlinks(path, queued_at)
    SELECT old.path, CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE NOT EXISTS (SELECT 1 FROM media WHERE path = old.path);
END;

CREATE TRIGGER media_recorded AFTER INSERT ON media
BEGIN
  DELETE FROM pending_unlinks WHERE path = new.path;
END;
`;

/**
 * Idempotent sends (F1-e). 0.22 created `sends` and never wrote to it, so the
 * table is replaced, not altered. A draft carries the WhatsApp key it goes out
 * under from the moment it is made, so a send whose outcome is unknown is
 * recognised when WhatsApp echoes that key. A row leaves sending only for sent
 * or unknown, or back to draft when the key never reached the socket; a
 * dispatched key is never retried, since a retraction or a tombstone makes it
 * dead for good (see retracted). The chat is a jid: a draft to a number nobody
 * wrote to yet has no chats row, and must not create one. expires_at is when
 * the draft lapses while it is one, and when the row may go once it settled.
 */
const V2 = `
DROP TABLE sends;

CREATE TABLE sends(
  draft_id TEXT PRIMARY KEY,
  owner TEXT,
  chat_jid TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  key_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'sending', 'sent', 'unknown')),
  receipt TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX sends_key ON sends(key_id);
CREATE INDEX sends_owner ON sends(owner, state, created_at);
CREATE INDEX sends_expiry ON sends(expires_at);

-- A message of the account's own gone for good takes its words out of the
-- send that made it: the row stays, so a repeated confirm still sends nothing.
CREATE TRIGGER retracted_scrubs_send AFTER INSERT ON retracted
WHEN new.from_me = 1
BEGIN
  UPDATE sends SET payload = '{}', receipt = CASE WHEN receipt IS NULL THEN NULL ELSE json_set(receipt, '$.text', '') END
  WHERE key_id = new.key_id;
END;

-- A chat cleared or deleted through a barrier does the same for its sends,
-- in the transaction that stores the barrier: a send whose message the
-- barrier hides, and an unknown send drafted at or before it, to the chat's
-- jid or its person's other one. Every spelling of a chat raises its own
-- barrier, so each row matches its own messages.
CREATE TRIGGER chats_barrier_scrubs_sends AFTER UPDATE OF cleared_through_ts ON chats
WHEN new.cleared_through_ts IS NOT NULL AND new.cleared_through_ts IS NOT old.cleared_through_ts
BEGIN
  UPDATE sends SET payload = '{}', receipt = CASE WHEN receipt IS NULL THEN NULL ELSE json_set(receipt, '$.text', '') END
  WHERE state IN ('sent', 'unknown') AND (
    EXISTS (
      SELECT 1 FROM messages m
      WHERE m.chat_id = new.id AND m.from_me = 1 AND m.key_id = sends.key_id AND m.ts <= new.cleared_through_ts)
    OR (state = 'unknown' AND created_at <= new.cleared_through_ts AND (
      chat_jid = new.jid
      OR chat_jid IN (SELECT phone_jid FROM contacts WHERE id = new.contact_id AND phone_jid IS NOT NULL)
      OR chat_jid IN (SELECT lid FROM contacts WHERE id = new.contact_id AND lid IS NOT NULL))));
END;
`;

// ---- v3 (F1-f): the voice-note transcription queue -----------------------
// Additive, and self-contained: one table, its index and two triggers. No
// backfill: a file upgraded from an earlier version starts with an empty
// queue, so nothing stored before the upgrade is transcribed on its own.
const V3 = `
-- Incoming voice notes the service transcribes on its own, one at a time, and
-- the ones it gave up on. A row with failed_at NULL is queued: attempts counts
-- the runs started (a run counts when it starts, so a note that takes the
-- process down with it cannot loop), next_at is the earliest it may run again,
-- started_at marks the run under way (one a restart finds is recovered). A row
-- with failed_at set is no longer queued: it records why, so the note is not
-- queued again. error is a short reason and never content. A transcript
-- stored for the message, a tombstone or a delete takes the row with it.
-- provider_class is where the audio was meant to go when the note was queued:
-- a note queued for this machine ('local') is never handed to an API.
CREATE TABLE transcribe_queue(
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  provider_class TEXT NOT NULL CHECK (provider_class IN ('local', 'api')),
  queued_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  started_at INTEGER,
  error TEXT,
  error_at INTEGER,
  failed_at INTEGER
) STRICT;
CREATE INDEX transcribe_queue_waiting ON transcribe_queue(next_at) WHERE failed_at IS NULL;

CREATE TRIGGER messages_transcribed AFTER UPDATE OF transcript ON messages
WHEN new.transcript IS NOT NULL
BEGIN
  DELETE FROM transcribe_queue WHERE message_id = new.id;
END;

CREATE TRIGGER messages_tombstone_transcribe AFTER UPDATE OF deleted_at ON messages
WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL
BEGIN
  DELETE FROM transcribe_queue WHERE message_id = new.id;
END;
`;
// ---- end v3 ----------------------------------------------------------------

// ---- v4 (F1-d): the durable webhook outbox ---------------------------------
// Self-contained: one table and its indexes. No build before this one wrote an
// event, so version 1's placeholder table is replaced, not altered.
/**
 * One row per event, in the order the account produced it (seq, never handed
 * out twice), in a lane: its chat (`chat:<chats.id>`) or `connection`; events
 * of one lane are posted in seq order, lanes independently. A message event is
 * written in the transaction that stores its message, and keeps only what the
 * message row cannot say (payload); its body is built from the message when it
 * is posted. A message deleted from under an event leaves message_id NULL, and
 * the dispatcher cancels that event. state: pending (waiting for ready_at or
 * next_attempt_at), sending (a POST started; one a crash left behind is taken
 * over once it is older than a POST can run), then delivered, failed or
 * cancelled for good. updated_at is the last change: when an attempt ended,
 * and when a closed event is pruned from.
 */
const V4 = `
DROP TABLE IF EXISTS events;
CREATE TABLE events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  lane TEXT NOT NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ready_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'delivered', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_status INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX events_open ON events(seq) WHERE state IN ('pending', 'sending');
CREATE INDEX events_lane ON events(lane, seq) WHERE state IN ('pending', 'sending');
CREATE INDEX events_state ON events(state, updated_at);
CREATE INDEX events_message ON events(message_id) WHERE message_id IS NOT NULL;
`;
// ---- end v4 ----------------------------------------------------------------

// ---- v5 (F2-1): what catch_up and find_contact read ------------------------
// Self-contained: columns added to messages and chats, one table, the
// triggers that keep chats.last_own_id, the indexes the planned reads use,
// and the backfills a file upgraded from an earlier version needs at once.
// Flags derived from a message's protobuf (mentions_me) cannot be computed in
// SQL: the service backfills the last 14 days after opening, below the
// descending id cursor in meta flags_backfill_before (Messages.backfillFlags).
/**
 * - messages.flags: bits the service sets when it stores a message, and that
 *   only ever gain bits (an edit or a replay never clears one; a tombstone
 *   loses mentions_me with the words): 1 mentions_me
 *   (an incoming message whose mentions name the account, by number or lid),
 *   2 via_wazap (the account's own message sent through wazap: its key is a
 *   confirmed send's). A fold keeps the union of both copies' bits.
 * - chats.last_own_id: the newest message of the account's own a reader may
 *   see in the chat and in every chat folding into it, kept like last_*.
 * - chats.read_through_id: the newest message the account's own devices (the
 *   phone) reported read in the chat; it only moves forward, and a fold keeps
 *   the later of the two.
 * - messages.stored_seq: the order the account stored its messages in, one
 *   past the highest ever handed out (a physical delete of the newest keeps its
 *   number in meta stored_seq_high), so it only grows. The id orders messages
 *   by when they were sent; this orders them by when they reached the account,
 *   so a message filed late — a call when it ends, dated at its ring, a message
 *   decrypted on a retry, one the phone dates ahead — still comes after what
 *   was stored before it. A system stub replaced by the message it stood for
 *   (a retried decryption) takes a new one. Null for what a file held before v5.
 * - catchup_marks: per client of the account, the stored_seq a summary
 *   covered through and when it started (through_seq, through_at), and the
 *   same of the one before it (previous_seq, previous_at), so a summary can be
 *   repeated; advanced in one statement.
 * - sent_keys: the WhatsApp key of every send wazap let go of (it left draft),
 *   kept 90 days — the window the draft context reads — while the send rows
 *   themselves go a day after they settle. Nothing but the key and when.
 *   meta via_wazap_known_after says before when the record is incomplete: a
 *   file that already held the account's own messages when it reached v5.
 */
const V5 = `
ALTER TABLE messages ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN stored_seq INTEGER;
ALTER TABLE chats ADD COLUMN last_own_id INTEGER;
ALTER TABLE chats ADD COLUMN read_through_id INTEGER;

CREATE TABLE catchup_marks(
  client TEXT NOT NULL,
  through_seq INTEGER NOT NULL,
  through_at INTEGER NOT NULL,
  previous_seq INTEGER,
  previous_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client)
) STRICT, WITHOUT ROWID;

-- What reached the account after a stored_seq, and the newest one handed out,
-- off the index; chat_id rides along so a window's chats read the index alone.
CREATE INDEX messages_stored ON messages(stored_seq, chat_id) WHERE stored_seq IS NOT NULL;

-- A physical delete of the newest stored message keeps its number, so the
-- next message never takes a stored_seq a catch-up mark already covers.
CREATE TRIGGER messages_stored_high AFTER DELETE ON messages
WHEN old.stored_seq IS NOT NULL AND old.stored_seq > coalesce((
  SELECT stored_seq FROM messages INDEXED BY messages_stored WHERE stored_seq IS NOT NULL ORDER BY stored_seq DESC LIMIT 1), 0)
BEGIN
  INSERT INTO meta(key, value) VALUES ('stored_seq_high', CAST(old.stored_seq AS TEXT))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(excluded.value AS INTEGER) > CAST(meta.value AS INTEGER);
END;

CREATE TABLE sent_keys(
  key_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (key_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX sent_keys_at ON sent_keys(at);

-- A send leaving draft (claimed, or stored past it) records its key.
CREATE TRIGGER sends_key_sent AFTER UPDATE OF state ON sends
WHEN old.state = 'draft' AND new.state <> 'draft'
BEGIN
  INSERT INTO sent_keys(key_id, at) SELECT new.key_id, new.updated_at
  WHERE NOT EXISTS (SELECT 1 FROM sent_keys WHERE key_id = new.key_id);
END;

CREATE TRIGGER sends_key_stored AFTER INSERT ON sends
WHEN new.state <> 'draft'
BEGIN
  INSERT INTO sent_keys(key_id, at) SELECT new.key_id, new.updated_at
  WHERE NOT EXISTS (SELECT 1 FROM sent_keys WHERE key_id = new.key_id);
END;

-- The account's own messages per chat, tombstones left out: last_own_id is
-- walked back off it, and so are the own messages of a chat in a window (who
-- answered, how the user writes, how much they talk to someone). The two
-- constant columns make a count over it read the index alone. The triggers
-- name it (INDEXED BY): without statistics the planner may walk messages_chat,
-- every message of a chat the account never wrote in.
CREATE INDEX messages_own ON messages(chat_id, id, from_me, deleted_at) WHERE from_me = 1 AND deleted_at IS NULL;
-- Messages that mention the account, by id: a window's mentions without a scan.
CREATE INDEX messages_mentions ON messages(id) WHERE (flags & 1) <> 0;
-- Calls, and polls and events, by id: a window's calls or open polls without a scan.
CREATE INDEX messages_calls ON messages(id) WHERE type = 'call';
CREATE INDEX messages_polls ON messages(id) WHERE type IN ('poll', 'event');

-- A mention is part of what a message said: a tombstone keeps none, so a
-- window's mentions never list a deleted message.
CREATE TRIGGER messages_tombstone_mentions AFTER UPDATE OF deleted_at ON messages
WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL AND (new.flags & 1) <> 0
BEGIN
  UPDATE messages SET flags = flags & ~1 WHERE id = new.id;
END;

CREATE TRIGGER messages_last_own_insert AFTER INSERT ON messages
WHEN new.from_me = 1 AND new.deleted_at IS NULL
BEGIN
  UPDATE chats SET last_own_id = new.id
  WHERE (id = new.chat_id OR id = (SELECT merged_into FROM chats WHERE id = new.chat_id))
    AND new.ts > coalesce(cleared_through_ts, 0)
    AND (last_own_id IS NULL OR last_own_id < new.id);
END;

CREATE TRIGGER messages_last_own_tombstone AFTER UPDATE OF deleted_at ON messages
WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL AND new.from_me = 1
BEGIN
  UPDATE chats SET last_own_id = (
    SELECT max((
      SELECT x.id FROM messages x INDEXED BY messages_own
      WHERE x.chat_id = k.id AND x.from_me = 1 AND x.deleted_at IS NULL
        AND x.id >= (coalesce(k.cleared_through_ts, 0) / 1000) * 1048576
        AND x.ts > coalesce(k.cleared_through_ts, 0)
      ORDER BY x.id DESC LIMIT 1))
    FROM chats k WHERE k.id = chats.id OR k.merged_into = chats.id)
  WHERE (id = new.chat_id OR id = (SELECT merged_into FROM chats WHERE id = new.chat_id)) AND last_own_id = new.id;
END;

CREATE TRIGGER messages_last_own_delete AFTER DELETE ON messages
WHEN old.from_me = 1
BEGIN
  UPDATE chats SET last_own_id = (
    SELECT max((
      SELECT x.id FROM messages x INDEXED BY messages_own
      WHERE x.chat_id = k.id AND x.from_me = 1 AND x.deleted_at IS NULL
        AND x.id >= (coalesce(k.cleared_through_ts, 0) / 1000) * 1048576
        AND x.ts > coalesce(k.cleared_through_ts, 0)
      ORDER BY x.id DESC LIMIT 1))
    FROM chats k WHERE k.id = chats.id OR k.merged_into = chats.id)
  WHERE (id = old.chat_id OR id = (SELECT merged_into FROM chats WHERE id = old.chat_id)) AND last_own_id = old.id;
END;

CREATE TRIGGER messages_last_own_move AFTER UPDATE OF chat_id ON messages
WHEN old.chat_id IS NOT new.chat_id AND new.from_me = 1
BEGIN
  UPDATE chats SET last_own_id = (
    SELECT max((
      SELECT x.id FROM messages x INDEXED BY messages_own
      WHERE x.chat_id = k.id AND x.from_me = 1 AND x.deleted_at IS NULL
        AND x.id >= (coalesce(k.cleared_through_ts, 0) / 1000) * 1048576
        AND x.ts > coalesce(k.cleared_through_ts, 0)
      ORDER BY x.id DESC LIMIT 1))
    FROM chats k WHERE k.id = chats.id OR k.merged_into = chats.id)
  WHERE (id = old.chat_id OR id = (SELECT merged_into FROM chats WHERE id = old.chat_id)) AND last_own_id = old.id;
  UPDATE chats SET last_own_id = new.id
  WHERE id = new.chat_id AND new.deleted_at IS NULL AND new.ts > coalesce(cleared_through_ts, 0)
    AND (last_own_id IS NULL OR last_own_id < new.id);
END;

-- A raised barrier hides own messages too: the chat and the chat it folds into recount.
CREATE TRIGGER chats_last_own_barrier AFTER UPDATE OF cleared_through_ts ON chats
WHEN new.cleared_through_ts IS NOT old.cleared_through_ts
BEGIN
  UPDATE chats SET last_own_id = (
    SELECT max((
      SELECT x.id FROM messages x INDEXED BY messages_own
      WHERE x.chat_id = k.id AND x.from_me = 1 AND x.deleted_at IS NULL
        AND x.id >= (coalesce(k.cleared_through_ts, 0) / 1000) * 1048576
        AND x.ts > coalesce(k.cleared_through_ts, 0)
      ORDER BY x.id DESC LIMIT 1))
    FROM chats k WHERE k.id = chats.id OR k.merged_into = chats.id)
  WHERE id = new.id OR id = new.merged_into;
END;

-- A chat starting to fold into another reads as part of it at once: the
-- target's newest own message and read mark take the folding chat's into account.
CREATE TRIGGER chats_fold_marks AFTER UPDATE OF merged_into ON chats
WHEN new.merged_into IS NOT old.merged_into
BEGIN
  UPDATE chats SET last_own_id = (
    SELECT max((
      SELECT x.id FROM messages x INDEXED BY messages_own
      WHERE x.chat_id = k.id AND x.from_me = 1 AND x.deleted_at IS NULL
        AND x.id >= (coalesce(k.cleared_through_ts, 0) / 1000) * 1048576
        AND x.ts > coalesce(k.cleared_through_ts, 0)
      ORDER BY x.id DESC LIMIT 1))
    FROM chats k WHERE k.id = chats.id OR k.merged_into = chats.id)
  WHERE id = new.merged_into OR id = old.merged_into;
  UPDATE chats SET read_through_id = new.read_through_id
  WHERE id = new.merged_into AND new.read_through_id IS NOT NULL
    AND (read_through_id IS NULL OR read_through_id < new.read_through_id);
END;

-- What a file upgraded from an earlier version already holds.
UPDATE chats SET last_own_id = (
  SELECT max((
    SELECT x.id FROM messages x INDEXED BY messages_own
    WHERE x.chat_id = k.id AND x.from_me = 1 AND x.deleted_at IS NULL
      AND x.id >= (coalesce(k.cleared_through_ts, 0) / 1000) * 1048576
      AND x.ts > coalesce(k.cleared_through_ts, 0)
    ORDER BY x.id DESC LIMIT 1))
  FROM chats k WHERE k.id = chats.id OR k.merged_into = chats.id);

-- A confirmed send's message, under the chat its jid names (or the number a
-- lid pairs with), or a chat folding into or out of that one.
WITH spelled(key_id, chat_id) AS (
  SELECT s.key_id, c.id FROM sends s CROSS JOIN chats c
  WHERE s.state <> 'draft' AND c.jid IN (s.chat_jid, (SELECT p.phone_jid FROM lid_phones p WHERE p.lid = s.chat_jid))
),
family(key_id, chat_id) AS (
  SELECT key_id, chat_id FROM spelled
  UNION SELECT sp.key_id, c.merged_into FROM spelled sp CROSS JOIN chats c WHERE c.id = sp.chat_id AND c.merged_into IS NOT NULL
  UNION SELECT sp.key_id, c.id FROM spelled sp CROSS JOIN chats c WHERE c.merged_into = sp.chat_id
)
UPDATE messages SET flags = flags | 2 WHERE id IN (
  SELECT m.id FROM family f CROSS JOIN messages m ON m.chat_id = f.chat_id AND m.from_me = 1 AND m.key_id = f.key_id
);

INSERT INTO sent_keys(key_id, at) SELECT key_id, max(updated_at) FROM sends WHERE state <> 'draft' GROUP BY key_id;
-- Sends older than a day left no record: which of the account's own messages
-- before now wazap sent can no longer be told.
INSERT INTO meta(key, value) SELECT 'via_wazap_known_after', 'migrated_v5' WHERE EXISTS (SELECT 1 FROM messages WHERE from_me = 1);

-- The mentions of what is already stored come from the protobuf: the service
-- walks down from here, the newest first, as far as 14 days back.
INSERT INTO meta(key, value) SELECT 'flags_backfill_before', CAST(max(id) + 1 AS TEXT) FROM messages HAVING count(*) > 0;
`;
// ---- end v5 ----------------------------------------------------------------

// ---- v6: scheduled messages and reminders ----------------------------------
// Self-contained and additive: two tables and their indexes, both empty on a
// file upgraded from an earlier version.
/**
 * - scheduled: a draft confirm_send scheduled instead of sending. draft_id is
 *   that draft's id (unique, so a repeated confirm answers the same schedule);
 *   key_id the WhatsApp key it was drafted with, which it goes out under.
 *   payload is the frozen draft (the sends row's), emptied to '{}' once sent.
 *   state: pending (waiting for send_at, or next_attempt_at after a failure
 *   that may pass), sending (a send row, send_id, was made and confirmed; one
 *   a crash left is settled from that row when the database is next served),
 *   then sent, unknown (handed to WhatsApp, arrival not known), failed (a
 *   failure no retry fixes), missed (not sent by send_at plus the grace
 *   window) or cancelled, for good. reported_at: when a webhook event about
 *   the outcome was queued.
 * - reminders: a note about a chat, due at due_at. condition no_reply holds
 *   while no message of someone else's reached the chat after the reminder was
 *   made: since_seq is the newest stored_seq then, and since_ts its time.
 *   state: pending, fired (posted to the webhook, or due with it off: outcome
 *   says which), skipped (someone replied) or cancelled.
 */
const V6 = `
CREATE TABLE scheduled(
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL UNIQUE,
  owner TEXT,
  chat_jid TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  key_id TEXT NOT NULL UNIQUE,
  send_at INTEGER NOT NULL,
  time_zone TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'unknown', 'failed', 'missed', 'cancelled')),
  send_id TEXT,
  message_id TEXT,
  error_code TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  reported_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX scheduled_due ON scheduled(send_at) WHERE state = 'pending';
CREATE INDEX scheduled_state ON scheduled(state, updated_at);

CREATE TABLE reminders(
  id TEXT PRIMARY KEY,
  owner TEXT,
  chat_jid TEXT NOT NULL,
  note TEXT NOT NULL,
  condition TEXT NOT NULL CHECK (condition IN ('always', 'no_reply')),
  due_at INTEGER NOT NULL,
  time_zone TEXT,
  since_seq INTEGER NOT NULL,
  since_ts INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'fired', 'skipped', 'cancelled')),
  outcome TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX reminders_due ON reminders(due_at) WHERE state = 'pending';
CREATE INDEX reminders_state ON reminders(state, updated_at);
`;
// ---- end v6 ----------------------------------------------------------------

/** Every migration, in order. The schema version a build knows is the last one's. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: V1 },
  { version: 2, sql: V2 },
  { version: 3, sql: V3 },
  { version: 4, sql: V4 },
  { version: 5, sql: V5 },
  { version: 6, sql: V6 },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
