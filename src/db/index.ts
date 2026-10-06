/**
 * One WhatsApp account's storage: a single SQLite file,
 * `accounts/<id>/wazap.sqlite`, opened synchronously on the calling thread.
 *
 *   const db = AccountDb.open(path);
 *   await db.resume();                    // finishes folds and purges a stop interrupted
 *   db.messages.upsert({...});            // barriers enforced in the write
 *   db.search.text({ query: "factur", limit: 20 });
 *   await db.messages.clearChat(jid, Date.now());  // hidden at once, purged in chunks
 *   const paths = db.claimUnlinks();       // unlink each, then:
 *   const { rerecorded } = db.ackUnlinks(paths);  // recorded again meanwhile: recreate them
 *   db.close();
 *
 * The service (`WhatsAppService`) opens one per account at construction and
 * serves every read and write from it; the legacy JSON stores are imported
 * once at boot (`src/legacy-import/`) and never read again.
 *
 * What the wiring must know (F1-d, F1-e, and any new caller):
 * - Call resume() after every writable open, and unlink files only through
 *   claimUnlinks() / ackUnlinks().
 * - waiting() pages on each chat's last_ts, which moves as messages arrive: a
 *   chat can repeat or be skipped between pages. Treat the cursor as
 *   best-effort paging, not a snapshot.
 * - id_high and retracted only grow: a small row per second that lost a row to
 *   a purge, and one per deleted, retracted or expired message (status
 *   expiries included). Nothing prunes them.
 * - A timestamp is stored as given. One far in the future becomes the chat's
 *   last message until it is corrected; clamping implausible future
 *   timestamps is the service's job, before upsert.
 * - A message event is enqueued with db.events in the transaction that stores
 *   its message (db.transaction), and only the server process posts it.
 * - retracted makes a message key dead for good: a later upsert with that
 *   chat, direction and key is stored as a tombstone. sends therefore never
 *   stores a message before WhatsApp took it, and never retries a key once it
 *   reached the socket (see sends.ts).
 * - transcripts is the durable voice-note queue (F1-f). A note on it with no
 *   transcript yet is still being worked on: transcripts.state(sid) says
 *   queued, failed (given up, with a reason) or null (not queued — done, never
 *   eligible, or gone). The row leaves once setTranscript stores words.
 * - (v5) messages.flags only gain bits (a tombstone loses mentions_me). The
 *   caller passes mentions_me with the message (MessageInput.flags); via_wazap
 *   is also set by the database for the account's own message under the key of
 *   a send that left draft in the last 90 days (sent_keys, pruned by
 *   sends.sweep). Which own messages from before v5 or an import wazap sent is
 *   unknown (messages.viaWazapKnownAfter); styleFor accounts for it. Messages stored
 *   before v5, or by an import, get their mentions from
 *   messages.backfillFlags(detector), which the service runs once it knows the
 *   account's own number; requestFlagsBackfill() asks for it again.
 * - (v5) chats.read_through_id moves only through messages.markReadSelf, only
 *   forward, and only onto someone else's message; last_own_id is kept by the
 *   schema. catchup.advance is compare-and-set when given expectedThroughSeq.
 * - (v5) messages.stored_seq is handed out by every insert, one past the
 *   highest ever given (a delete of the newest keeps it in meta), and renewed
 *   when a system stub is replaced by the message it stood for; nothing else
 *   writes it. Rows from before v5 have none and read as 0.
 * - (v5) contacts.find keeps the people it folded in memory, refolding a
 *   person when any of their row changes; groups need `leftGroup` to exclude
 *   the ones the account left.
 * - digest (catch_up) reads only: every read is bounded above by the untilId
 *   and untilSeq the caller fixed (digest.maxId() and digest.storedTop() when a
 *   digest starts, in one synchronous pass), and per-chat reads take the chat's
 *   family (families()), so a page after the first sees what the first saw
 *   while a lid chat folds.
 */
import { existsSync } from "node:fs";
import { CatchupMarks } from "./catchup.js";
import { Contacts, type LeftGroup } from "./contacts.js";
import { Connection, type CheckpointResult, type ConnectionOptions, type ConnectionSettings } from "./connection.js";
import { Digest } from "./digest.js";
import { StorageError } from "./errors.js";
import { Events } from "./events.js";
import { Identity } from "./identity.js";
import { Merger } from "./merge.js";
import { Messages, type ScrubQuote } from "./messages.js";
import { Search } from "./search.js";
import { Sends } from "./sends.js";
import { Transcripts } from "./transcripts.js";
import type { BulkDeleteResult, Counts, MergeReport } from "./types.js";
import { Vectors } from "./vectors.js";

export { StorageError, type StorageErrorCode } from "./errors.js";
export { SCHEMA_VERSION } from "./schema.js";
export { SEQ_SPAN, idLowerBound, idUpperBound, secondOfId } from "./ids.js";
export { chatKindOf, isLidJid, normalizeJid, parseSid, sidOf } from "./identity.js";
export { mergeNotes } from "./merge.js";
export { foldText, DEFAULT_SCAN_CAP, DEFAULT_TRIGRAM_CAP } from "./search.js";
export { contentHash, hybridTokens, hybridWords, int8Similarity, quantizeVector, unitVector, RRF_K } from "./vectors.js";
export { isSqliteExperimentalWarning } from "./sqlite.js";
export type { FlagDetector, RecentExchangeItem, ScrubQuote } from "./messages.js";
export { messageStyle, styleOf, type MessageStyle, type StyleStats } from "./style.js";
export { FLAGS_BACKFILL_META, FLAGS_BACKFILL_WINDOW_MS } from "./messages.js";
export { MESSAGE_FLAGS } from "./types.js";
export type { CatchupAdvance, CatchupMark, CatchupMarks } from "./catchup.js";
export { DIGEST_MEDIA } from "./digest.js";
export type { Digest, DigestContact, DigestMedia, DigestSpan, InboundAggregate, TailMessage, WindowMessage } from "./digest.js";
export { ADDRESS_BOOK_MAX_PAGE, FIND_SCORES, LOOKUP_MIN_DIGITS, compareAddressBook } from "./contacts.js";
export type { AddressBookEntry, AddressBookInput, AddressBookKey, AddressBookOrder, AddressBookPage, ContactCandidate, Contacts, FindInput, FindKind, FindResult, FindVerdict, LeftGroup, LookupInput, MatchClass, MatchSource, QualifierHit, QualifierSource } from "./contacts.js";
export { DIMINUTIVES, INFLECTIONS, RELATIONSHIPS, diminutivesOf, inflectionForms, nameWords, relationOf, relationNameMatch } from "./names.js";
export type { NewDraft, SendRecord, SendState, Sends } from "./sends.js";
export { SENT_KEYS_RETENTION_MS } from "./sends.js";
export { TRANSCRIBE_MAX_ATTEMPTS, TRANSCRIBE_QUEUE_MAX_AGE_MS } from "./transcripts.js";
export type { ProviderClass, TranscribeItem, TranscribeQueueStats, TranscribeState } from "./transcripts.js";
export type { EventInput, EventRecord, EventState, EventStats } from "./events.js";
export type { CheckpointResult, ConnectionOptions, ConnectionSettings } from "./connection.js";
export {
  PRE_MIGRATION_FIX,
  PRE_MIGRATION_SETTING,
  PRE_MIGRATION_TTL_MS,
  preMigrationBackupEnabled,
  preMigrationBackupHolds,
  preMigrationBackups,
  preMigrationName,
  purgePreMigrationBackups,
  type PreMigrationBackup,
} from "./pre-migration.js";
export type {
  BacklogItem,
  HybridHit,
  HybridResult,
  HybridSearchInput,
  VectorHit,
  VectorSearchInput,
} from "./vectors.js";
export type * from "./types.js";

/** Pages one incremental merge step writes; ~3 ms a step on a 100k-message index. */
const FTS_MERGE_PAGES = 100;

/**
 * An online copy of an account database at `destination`, for `wazap backup`.
 *
 * Read-only from end to end: the file is never migrated, never written and
 * never opened read-write, so the command is the same with a server running as
 * without one — a running server's writes neither block it nor land in it, and
 * a database an older wazap wrote is copied as it is instead of being refused.
 * Whether a write-ahead log lies beside it decides how it opens, the rule
 * `openForReading` follows (see src/legacy-files.ts): with a log the copy
 * includes what the log holds, without one nothing is created beside the file.
 *
 * The copy is not encrypted. It holds every message the account has.
 */
export async function backupDatabase(path: string, destination: string): Promise<number> {
  const db = AccountDb.open(path, {
    readOnly: true,
    anySchema: true,
    immutable: !existsSync(`${path}-wal`),
    checkpointDelayMs: 0,
  });
  try {
    return await db.backup(destination);
  } finally {
    db.close();
  }
}

export interface AccountDbOptions extends ConnectionOptions {
  /** Strips a quoted message's embedded copy from a quoting message's protobuf; see ScrubQuote. */
  scrubQuote?: ScrubQuote;
  /** Tells a group the account left from its stored chat protobuf; see LeftGroup. */
  leftGroup?: LeftGroup;
}

export class AccountDb {
  readonly identity: Identity;
  readonly messages: Messages;
  readonly search: Search;
  readonly vectors: Vectors;
  readonly sends: Sends;
  readonly transcripts: Transcripts;
  /** The webhook outbox; see src/webhook-outbox.ts for who posts it. */
  readonly events: Events;
  /** Where each client's catch-up summary left off (v5). */
  readonly catchup: CatchupMarks;
  /** The window reads a catch-up digest is built from (F2-2); see digest.ts. */
  readonly digest: Digest;
  /** Who a name, a nickname or a relationship means: people and groups, scored (find_contact). */
  readonly contacts: Contacts;
  private readonly merger: Merger;

  private constructor(private readonly connection: Connection, options: AccountDbOptions) {
    this.identity = new Identity(connection);
    this.messages = new Messages(connection, this.identity, options.scrubQuote ?? null);
    this.search = new Search(connection, this.identity, this.messages);
    this.vectors = new Vectors(connection, this.identity, this.messages, this.search);
    this.sends = new Sends(connection);
    this.transcripts = new Transcripts(connection, this.messages);
    this.events = new Events(connection);
    this.catchup = new CatchupMarks(connection);
    this.digest = new Digest(connection);
    this.contacts = new Contacts(connection, options.leftGroup ?? null);
    this.merger = new Merger(connection, this.identity, this.messages);
  }

  /** Opens (creating and migrating when writable) the database at `path`. */
  static open(path: string, options: AccountDbOptions = {}): AccountDb {
    return new AccountDb(Connection.open(path, options), options);
  }

  get path(): string {
    return this.connection.path;
  }

  get readOnly(): boolean {
    return this.connection.readOnly;
  }

  get schemaVersion(): number {
    return this.connection.schemaVersion;
  }

  get isOpen(): boolean {
    return this.connection.isOpen;
  }

  settings(): ConnectionSettings {
    return this.connection.settings();
  }

  getMeta(key: string): string | null {
    return this.connection.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? null;
  }

  setMeta(key: string, value: string | null): void {
    this.connection.write(() => {
      if (value === null) this.connection.run("DELETE FROM meta WHERE key = ?", key);
      else this.connection.run("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", key, value);
    });
  }

  /**
   * Ties the file to one WhatsApp account. The first call records the owner;
   * a later call naming someone else refuses, so one account's history never
   * lands in another's file.
   */
  bindOwner(ownerJid: string): void {
    this.connection.write(() => {
      const current = this.getMeta("owner");
      if (current === null) this.setMeta("owner", ownerJid);
      else if (current !== ownerJid) {
        throw new StorageError("OWNER_MISMATCH", `This database belongs to ${current}, not ${ownerJid}.`);
      }
    });
  }

  /**
   * Several writes as one transaction: all of them or none. The body must be
   * synchronous — a transaction never spans an await.
   */
  transaction<T>(body: () => T): T {
    return this.connection.write(body);
  }

  /**
   * Merges the full-text index's segments a hundred pages at a time, with the
   * event loop running between steps, then refreshes the planner statistics.
   * A merged index makes every later delete several times cheaper, and it
   * drops the entries of deleted rows for good. Run it after an import or in
   * an idle moment; it queues behind other large operations.
   */
  optimize(): Promise<{ steps: number }> {
    this.connection.assertWritable();
    return this.connection.bulk(async () => {
      let steps = 0;
      await this.connection.chunked(() => {
        const before = this.connection.get<{ n: number }>("SELECT total_changes() AS n")!.n;
        this.connection.run("INSERT INTO messages_fts(messages_fts, rank) VALUES ('merge', ?)", -FTS_MERGE_PAGES);
        steps++;
        // The command itself counts as one change; anything more means it wrote pages.
        return this.connection.get<{ n: number }>("SELECT total_changes() AS n")!.n - before > 1;
      });
      this.connection.db.exec("PRAGMA optimize");
      return { steps };
    });
  }

  /** Makes a lid and a phone number one person and one chat; chunked. */
  learnLidPhone(lid: string, phoneJid: string): Promise<MergeReport> {
    return this.merger.learnLidPhone(lid, phoneJid);
  }

  /** Finishes any fold a crash or a close interrupted. */
  resumeMerges(): Promise<MergeReport> {
    return this.merger.resumeMerges();
  }

  /**
   * Finishes what a crash or a close interrupted: folds first, then the
   * physical purge under every stored clear barrier. Call once after opening a
   * writable database; reads are already correct before it runs.
   */
  async resume(): Promise<{ merges: MergeReport; purged: BulkDeleteResult }> {
    const merges = await this.merger.resumeMerges();
    const purged = await this.messages.resumePurges();
    return { merges, purged };
  }

  /**
   * Files removed rows pointed at and no row references any more, oldest
   * first, whether claimed or not. A read-only view of the queue.
   */
  pendingUnlinks(limit = 1000): string[] {
    return this.connection
      .all<{ path: string }>("SELECT path FROM pending_unlinks ORDER BY queued_at, path LIMIT ?", Math.max(1, Math.floor(limit)))
      .map((row) => row.path);
  }

  /**
   * Hands paths to unlink to the caller and marks them claimed: unclaimed
   * ones, and claims older than `staleAfterMs` (a process that died between
   * claiming and acknowledging). Recording a claimed path again before the
   * acknowledgement cancels its claim.
   */
  claimUnlinks(limit = 1000, staleAfterMs = 10 * 60_000): string[] {
    return this.connection.write(() => {
      const now = this.connection.now();
      const paths = this.connection
        .all<{ path: string }>(
          `SELECT path FROM pending_unlinks WHERE claimed_at IS NULL OR claimed_at <= ?
           ORDER BY queued_at, path LIMIT ?`,
          now - Math.max(0, staleAfterMs),
          Math.max(1, Math.floor(limit))
        )
        .map((row) => row.path);
      if (paths.length > 0) {
        this.connection.run("UPDATE pending_unlinks SET claimed_at = ? WHERE path IN (SELECT value FROM json_each(?))", now, JSON.stringify(paths));
      }
      return paths;
    });
  }

  /**
   * Acknowledges claimed paths as unlinked and takes them off the queue.
   * `rerecorded` are the ones a message recorded again after the claim: their
   * claim was cancelled, they stay referenced, and the caller must not have
   * unlinked them — or must recreate the file if it already did.
   */
  ackUnlinks(paths: readonly string[]): { acked: string[]; rerecorded: string[] } {
    const result = { acked: [] as string[], rerecorded: [] as string[] };
    if (paths.length === 0) return result;
    this.connection.write(() => {
      for (const path of new Set(paths)) {
        const row = this.connection.get<{ claimed_at: number | null }>("SELECT claimed_at FROM pending_unlinks WHERE path = ?", path);
        if (row !== undefined && row.claimed_at !== null) {
          this.connection.run("DELETE FROM pending_unlinks WHERE path = ?", path);
          result.acked.push(path);
        } else if (row !== undefined || this.connection.get("SELECT 1 FROM media WHERE path = ?", path) !== undefined) {
          result.rerecorded.push(path);
        } else {
          result.acked.push(path);
        }
      }
    });
    return result;
  }

  /**
   * Whole-account counts for status, off indexes: rows a stored clear barrier
   * already hides are not messages any more, even before their purge ran.
   */
  counts(): Counts {
    const row = this.connection.get<Counts & { total: number; hidden: number }>(
      `SELECT (SELECT count(*) FROM messages) AS total,
              (SELECT count(*) FROM messages INDEXED BY messages_tombstones WHERE deleted_at IS NOT NULL) AS tombstones,
              (SELECT count(*) FROM chats c CROSS JOIN messages m ON m.chat_id = c.id
                 AND m.id < ((c.cleared_through_ts / 1000) + 1) * 1048576 AND m.ts <= c.cleared_through_ts
                 AND m.deleted_at IS NULL
               WHERE c.cleared_through_ts IS NOT NULL) AS hidden,
              (SELECT count(*) FROM chats WHERE merged_into IS NULL) AS chats,
              (SELECT count(*) FROM contacts WHERE merged_into IS NULL) AS contacts,
              (SELECT count(*) FROM embeddings) AS embeddings`
    )!;
    return {
      messages: row.total - row.tombstones - row.hidden,
      tombstones: row.tombstones,
      chats: row.chats,
      contacts: row.contacts,
      embeddings: row.embeddings,
    };
  }

  /**
   * SQLite's quick_check, plus — on a writable connection — the full-text
   * index compared against the messages it indexes. For doctor, and for tests
   * that must prove the triggers kept the index in step.
   */
  integrityCheck(): { ok: boolean; problems: string[] } {
    const problems = this.connection
      .all<{ quick_check: string }>("PRAGMA quick_check")
      .map((row) => row.quick_check)
      .filter((line) => line !== "ok");
    if (!this.connection.readOnly) {
      try {
        this.connection.run("INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)");
      } catch (err) {
        problems.push(`full-text index: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const drifted = this.connection.get<{ n: number }>(
      `SELECT count(*) AS n FROM chats c WHERE c.visible != (
         SELECT count(*) FROM messages m WHERE m.chat_id = c.id AND m.deleted_at IS NULL AND m.ts > coalesce(c.cleared_through_ts, 0))`
    )!.n;
    if (drifted > 0) problems.push(`visible message counts: ${drifted} chats disagree with their rows`);
    return { ok: problems.length === 0, problems };
  }

  checkpoint(): CheckpointResult {
    return this.connection.checkpoint();
  }

  /** An online copy of the database, owner-only, taken while the account keeps working. */
  backup(destination: string): Promise<number> {
    return this.connection.backup(destination);
  }

  /** Settles once queued chunked operations (clears, expiry sweeps, merges) have finished. */
  idle(): Promise<void> {
    return this.connection.idle();
  }

  close(): void {
    this.connection.close();
  }
}
