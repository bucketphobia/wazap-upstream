/**
 * One open account database: the file and its modes, the pragmas, the schema
 * migrations, a statement cache, write transactions, and the chunked loop the
 * large operations run through so the event loop keeps breathing.
 *
 * Everything is synchronous on the calling thread (node:sqlite's
 * DatabaseSync). A write transaction must therefore never span an `await`:
 * `write()` takes a synchronous function, and a long operation is a sequence
 * of short transactions with `setImmediate` between them.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { errorCode } from "../error-code.js";
import { StorageError } from "./errors.js";
import {
  PRE_MIGRATION_FIX,
  assertRoomForBackup,
  preMigrationBackupEnabled,
  preMigrationBackupHolds,
  preMigrationName,
} from "./pre-migration.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";
import { sqlite, type DatabaseSync, type SQLInputValue, type StatementSync } from "./sqlite.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_CHUNK_SIZE = 200;
/**
 * A chunk also stops once it has run this long. Deleting indexed text costs
 * far more than reading it — the full-text index rewrites its pages at once
 * so deleted words do not linger — and the cost per row grows with the index,
 * so a row count alone cannot bound the pause.
 */
const DEFAULT_CHUNK_BUDGET_MS = 15;
const DEFAULT_CHECKPOINT_DELAY_MS = 2_000;
const MAX_CHECKPOINT_RETRIES = 6;
/**
 * Writes quiet this long, the write-ahead log is checkpointed from a timer,
 * off every commit's path. SQLite's own checkpoint runs inside whichever
 * commit crosses its threshold — a live message, a tool's write — and stalls
 * that commit 15-30 ms; a checkpoint after a quiet second copies only the few
 * pages the last writes touched, each once however often it was rewritten.
 */
const DEFAULT_IDLE_CHECKPOINT_MS = 1_000;
/** Under a steady trickle of writes the log is still checkpointed at least this often, so reads never wade through a long one. */
const IDLE_CHECKPOINT_MAX_MS = 15_000;
/** A checkpoint a reader kept from finishing is tried again this many times before the next write asks. */
const IDLE_CHECKPOINT_RETRIES = 4;
/**
 * The backstop under the idle checkpoint: a log this many pages long (~40 MB)
 * is checkpointed by the commit that reaches it, as SQLite does by itself at
 * 1,000. Only a stretch of writes with no quiet second in it — a first
 * history sync — gets there. Measured against 2,000 and 4,000 on the service's
 * own history ingest: a lower backstop checkpoints inside more of its commits
 * (commit p99 7 ms here, 14-16 ms there; live notify p99 6 ms at 2,000). A
 * raw, gap-free commit loop pauses somewhat longer at the worst with this one
 * (max 177-242 ms against 113-153 ms at 1.6.0's 1,000), as each fold copies more.
 */
const WAL_GUARD_PAGES = 10_000;
/**
 * SQLite's own threshold, kept while a chunked operation runs: a clear, an
 * expiry sweep or a fold rewrites (and, secure_delete on, zeroes) pages all
 * over the file, so one checkpoint of 10,000 of them would stall a chunk's
 * commit for 100-200 ms where 1,000 at a time cost 15-45 ms each.
 */
const BULK_AUTOCHECKPOINT_PAGES = 1_000;
/**
 * When the log starts over, at the first write after a complete checkpoint,
 * its file is cut back to this size, so one long sync does not leave 40 MB
 * beside the database for longer than its next quiet write. Not cut to zero
 * after every idle checkpoint: a live message would then grow the file again,
 * and overwriting a log costs a sync less than extending one.
 */
const WAL_SIZE_LIMIT_BYTES = 8 * 1024 * 1024;
/**
 * How much of the database file the server's connection reads through a
 * memory map instead of a read() and a copy per page. The scans that cannot
 * use an index (the vector scan, catch_up's scan, find_contact's fold) run
 * 0-25% faster (bench-db, 100k messages), more on a busy machine. The mapped
 * pages are the file's own, clean, and count in the process's resident size
 * (up to this much more) until the system takes them back under memory
 * pressure; past this size the rest of the file is read as before. Writes are
 * unchanged. A file cut short under the server ends the process (SIGBUS) at
 * the next read of a lost page; see docs/data.md.
 */
const MMAP_BYTES = 256 * 1024 * 1024;

/**
 * A row count written into a statement's text (`LIMIT ${sqlLimit(n)}`) rather
 * than bound. node:sqlite's SQLite (3.47+) lets the planner read a bound LIMIT
 * and marks the statement to be prepared again whenever that parameter is
 * bound, which is every run: 20-30 µs a run for a statement of a few joins,
 * against 2 µs for the same text with the number in it. For the reads that run
 * once per chat (catch_up); the values are a handful of constants, so the
 * statement cache gains a few entries, not one per call.
 */
export function sqlLimit(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Not a row count: ${n}`);
  return String(n);
}

export interface ConnectionOptions {
  /** status and doctor: never migrates, never writes, refuses a schema it would have to change. */
  readOnly?: boolean;
  /**
   * With readOnly: open the file as immutable, which creates no -wal or -shm
   * beside it and ignores a write-ahead log. Only for a database no process
   * has open.
   */
  immutable?: boolean;
  /**
   * With readOnly: accept a schema older than this build's, which the tables
   * would be read wrong through. Only for copying the file (`wazap backup`),
   * never for reading it; a newer schema is refused as always.
   */
  anySchema?: boolean;
  /** How long a statement waits on a lock held by another connection (busy_timeout). */
  timeoutMs?: number;
  /** The clock expiry and bookkeeping read; tests move it. Epoch ms. */
  now?: () => number;
  /** Rows per transaction in the chunked operations. */
  chunkSize?: number;
  /** Milliseconds a delete chunk may run before it commits and yields. */
  chunkBudgetMs?: number;
  /**
   * After a single delete, a WAL checkpoint runs this long later, so the
   * deleted bytes leave the write-ahead log soon without a checkpoint per
   * message; a checkpoint a reader kept busy retries after it, backing off.
   * 0 turns the timer off; bulk deletes always try a checkpoint when they finish.
   */
  checkpointDelayMs?: number;
  /**
   * Writes quiet this long, a passive checkpoint moves the write-ahead log
   * into the database file from a timer, and commits stop checkpointing below
   * the ~40 MB backstop. 0 leaves checkpoints to SQLite, inside the commit
   * that fills 1,000 pages. Writable opens only.
   */
  idleCheckpointMs?: number;
  /**
   * The copy taken beside an existing database before it is migrated. Unset
   * follows WAZAP_PRE_MIGRATION_BACKUP (on unless it says otherwise); false
   * upgrades without one. Read-only opens never take one, whatever this says.
   */
  preMigrationBackup?: boolean;
}

export interface ConnectionSettings {
  journalMode: string;
  synchronous: "off" | "normal" | "full" | "extra" | "unknown";
  foreignKeys: boolean;
  secureDelete: boolean;
  ftsSecureDelete: boolean;
  busyTimeoutMs: number;
}

export interface CheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
}

/** Owner-only, whatever the umask: the file holds every message of the account. */
function enforceMode(path: string, mode: number): void {
  if (process.platform === "win32") return;
  const current = statSync(path).mode & 0o777;
  if ((current & ~mode) !== 0) chmodSync(path, mode);
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

interface Copy {
  /** Where the finished copy lands. */
  target: string;
  /** The exclusive file it is written to first, in the destination's own folder. */
  temp: string;
}

/**
 * Everything a copy of a live database needs around the bytes: the destination
 * is not the database under another name, its folder exists and is owner-only,
 * and the copy goes to a new exclusive `0600` temp file so nothing half-written
 * ever carries the destination's name.
 *
 * A destination that is the live database — another case on a case-insensitive
 * disk, a symlink, a hard link — is refused by comparing the files themselves,
 * not their paths.
 */
function beginCopy(live: string, destination: string): Copy {
  const target = resolve(destination);
  if (existsSync(target)) {
    const aimed = statSync(target);
    for (const path of [live, `${live}-wal`, `${live}-shm`]) {
      if (!existsSync(path)) continue;
      const own = statSync(path);
      if (own.dev === aimed.dev && own.ino === aimed.ino) {
        throw new StorageError("INVALID_INPUT", "A backup cannot overwrite the database it copies.");
      }
    }
  }
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const temp = join(dir, `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  closeSync(openSync(temp, "wx", FILE_MODE));
  enforceMode(temp, FILE_MODE);
  return { target, temp };
}

/** The written copy, on disk and under its name: fsync first, then one atomic rename. */
function finishCopy({ target, temp }: Copy): void {
  // Windows requires write access for FlushFileBuffers (fsync).
  const fd = openSync(temp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
}

/**
 * A copy of `db` at `destination`, taken on the calling thread.
 *
 * node:sqlite's own `backup()` is asynchronous, and the one caller that cannot
 * await — `Connection.open`, which is synchronous so a service answers from the
 * moment it exists — is the one that must copy before it migrates. `VACUUM
 * INTO` is SQLite's synchronous way to copy a live database: it reads the
 * source under a read transaction, so the copy is the last committed state and
 * never a write in flight, and writes a whole database carrying the same rows,
 * the same schema and the same `user_version`. It is not a page-for-page image
 * — the copy is rebuilt, so its free pages are gone rather than copied — and a
 * pre-existing empty file is what it writes into, which is how the copy keeps
 * the temp file's `0600` from its first byte.
 */
function copyDatabase(db: DatabaseSync, live: string, destination: string): Copy {
  const copy = beginCopy(live, destination);
  try {
    db.prepare("VACUUM INTO ?").run(copy.temp);
    return copy;
  } catch (err) {
    rmSync(copy.temp, { force: true });
    throw err;
  }
}

/** SQLITE_BUSY and SQLITE_LOCKED: someone else has the file, and trying later is the answer. */
function heldByAnother(err: unknown): boolean {
  const code = (err as { errcode?: unknown }).errcode;
  return code === 5 || code === 6;
}

/** A synchronous pause, for the one place that has to wait on another process without an await. */
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

/**
 * Switches the file to WAL journaling, waiting for another connection to let go.
 *
 * Changing the journal mode needs the database to itself, and SQLite answers
 * SQLITE_BUSY straight away rather than calling the busy handler it calls for
 * every other statement — so the waiting is ours, bounded by the same timeout.
 * It only ever comes up for a file that is not in WAL yet (one restored from a
 * backup, or written by something other than a released wazap) while a second
 * wazap has it open; once either of them has switched it, the pragma is a
 * no-op for everyone.
 */
function toWal(db: DatabaseSync, timeoutMs: number): string | undefined {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return (db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string } | undefined)?.journal_mode;
    } catch (err) {
      if (!heldByAnother(err) || Date.now() >= deadline) throw err;
      Atomics.wait(PAUSE, 0, 0, Math.min(50, 2 ** attempt));
    }
  }
}

function tooNew(path: string, version: number): StorageError {
  return new StorageError(
    "SCHEMA_TOO_NEW",
    `${path} has schema version ${version}; this wazap knows up to ${SCHEMA_VERSION}.`,
    "Update wazap to the version that wrote this file (npm i -g wazap-mcp@latest)"
  );
}

/**
 * The copy itself, once the version is settled: an existing one that reads
 * whole is left alone, anything else is written and renamed into place.
 *
 * Fail-closed. Every way this can go wrong — a folder that cannot be written,
 * a disk that fills, a copy that does not read back — leaves the database
 * exactly as it was and stops the open, because the caller is about to migrate
 * it. The message carries the cause's code and no path or content: what failed
 * is a code, where it failed is already in the account the log names.
 */
function takeCopy(db: DatabaseSync, path: string, from: number): void {
  const dir = dirname(path);
  const target = join(dir, preMigrationName(from));
  // A first attempt that died after writing the copy left a usable one behind;
  // taking it again would only copy a database that has not changed since.
  if (preMigrationBackupHolds(target, from)) return;
  try {
    assertRoomForBackup(path, dir);
    const copy = copyDatabase(db, path, target);
    try {
      if (!preMigrationBackupHolds(copy.temp, from)) {
        throw new StorageError(
          "BACKUP_FAILED",
          "The copy taken of the account database before its upgrade did not read back whole, so nothing was migrated.",
          PRE_MIGRATION_FIX
        );
      }
      // Renamed over whatever was there: a copy that did not read whole is
      // worth less than this one, and the swap is atomic either way.
      finishCopy(copy);
    } catch (err) {
      rmSync(copy.temp, { force: true });
      throw err;
    }
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError(
      "BACKUP_FAILED",
      `The account database could not be copied before its upgrade (${errorCode(err) ?? "unknown"}), so nothing was migrated.`,
      PRE_MIGRATION_FIX
    );
  }
}

/**
 * A copy of an older database beside it, before the upgrade writes anything.
 *
 * Which lock this is safe under was the whole question, and SQLite answers half
 * of it: a copy cannot be taken from a connection that is inside a write
 * transaction, so the migration's own `BEGIN IMMEDIATE` cannot hold it. What
 * holds it instead is a second connection to the same file, taking that very
 * `BEGIN IMMEDIATE` — the write lock the migration uses — and holding it across
 * the version read and the copy. So:
 *
 * - no other process can commit a migration while the copy is being taken, so
 *   the copy is never of a database halfway through its upgrade and never of
 *   one already upgraded under an older version's name;
 * - the version the copy is named for is read under that lock, not before it,
 *   so a process that lost the race finds the schema current and copies nothing;
 * - the copy is read off the open connection, which is not in a transaction, so
 *   it is the last committed state — a writer's uncommitted pages are invisible
 *   to it (WAL) and its read lock does not block one;
 * - a database another process is migrating right now fails to take the lock and
 *   fails exactly where the migration would have, with the same error.
 *
 * The lock is released before the journal-mode switch (a pragma no transaction
 * may hold) and taken again by `migrate()`, which re-reads the version inside
 * it: whoever gets there second finds nothing left to do.
 */
function backUpBeforeMigrating(db: DatabaseSync, path: string, timeoutMs: number): void {
  const guard = new (sqlite().DatabaseSync)(path, { timeout: timeoutMs });
  try {
    guard.exec("BEGIN IMMEDIATE");
    const from = userVersion(guard);
    if (from <= 0 || from >= SCHEMA_VERSION) return;
    takeCopy(db, path, from);
  } finally {
    try {
      if (guard.isTransaction) guard.exec("ROLLBACK");
    } catch {
      // The lock goes with the connection either way.
    }
    guard.close();
  }
}

export class Connection {
  readonly readOnly: boolean;
  readonly now: () => number;
  readonly chunkSize: number;
  readonly chunkBudgetMs: number;
  private readonly checkpointDelayMs: number;
  private readonly statements = new Map<string, StatementSync>();
  private bulkTail: Promise<unknown> = Promise.resolve();
  private checkpointTimer: NodeJS.Timeout | null = null;
  private checkpointRetries = 0;
  private readonly idleCheckpointMs: number;
  private idleTimer: NodeJS.Timeout | null = null;
  /** performance.now() of the last commit, and of the first one the log has held since its last idle checkpoint (null: none). */
  private lastCommitAt = 0;
  private dirtySince: number | null = null;
  private idleRetries = 0;
  /** Chunked operations running now; while there are any, commits checkpoint at SQLite's own 1,000 pages. */
  private chunkedRunning = 0;
  private readonly timeoutMs: number;
  private closed = false;
  private namesEpoch = 0;

  private constructor(
    readonly path: string,
    readonly db: DatabaseSync,
    options: ConnectionOptions
  ) {
    this.readOnly = options.readOnly === true;
    this.now = options.now ?? Date.now;
    this.chunkSize = Math.max(1, Math.floor(options.chunkSize ?? DEFAULT_CHUNK_SIZE));
    this.chunkBudgetMs = Math.max(1, options.chunkBudgetMs ?? DEFAULT_CHUNK_BUDGET_MS);
    this.checkpointDelayMs = Math.max(0, options.checkpointDelayMs ?? DEFAULT_CHECKPOINT_DELAY_MS);
    this.idleCheckpointMs = this.readOnly ? 0 : Math.max(0, options.idleCheckpointMs ?? DEFAULT_IDLE_CHECKPOINT_MS);
    this.timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  }

  static open(path: string, options: ConnectionOptions = {}): Connection {
    const { DatabaseSync } = sqlite();
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (options.readOnly === true) {
      if (!existsSync(path)) {
        throw new StorageError("NOT_FOUND", `${path} does not exist.`, "Start the wazap server once to create it");
      }
      const source = options.immutable === true ? `${pathToFileURL(path).href}?immutable=1` : path;
      const db = new DatabaseSync(source, { readOnly: true, timeout });
      try {
        const version = userVersion(db);
        if (version > SCHEMA_VERSION) throw tooNew(path, version);
        if (version < SCHEMA_VERSION && options.anySchema !== true) {
          throw new StorageError(
            "SCHEMA_OUTDATED",
            `${path} has schema version ${version}; this wazap migrates it to ${SCHEMA_VERSION} when the server starts.`,
            "Restart the wazap server so it migrates the database"
          );
        }
        db.exec("PRAGMA query_only = ON");
      } catch (err) {
        db.close();
        throw err;
      }
      return new Connection(path, db, options);
    }

    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    enforceMode(dir, DIR_MODE);
    // Created here, not by SQLite, so the file is never briefly world-readable;
    // SQLite gives the -wal and -shm files the database file's mode.
    closeSync(openSync(path, "a", FILE_MODE));
    enforceMode(path, FILE_MODE);
    for (const side of [`${path}-wal`, `${path}-shm`]) if (existsSync(side)) enforceMode(side, FILE_MODE);

    const db = new DatabaseSync(path, { timeout, enableForeignKeyConstraints: true });
    try {
      // Before anything that writes: a newer file is left exactly as it was.
      // migrate() checks again inside its transaction, where the answer holds.
      const version = userVersion(db);
      if (version > SCHEMA_VERSION) throw tooNew(path, version);
      // A copy of what an upgrade is about to change, taken before the
      // journal-mode switch, which is itself a write to the file. Only for a
      // database that exists and is behind: a new file (version 0) has nothing
      // to copy, one already current has nothing to migrate.
      if (version > 0 && version < SCHEMA_VERSION && (options.preMigrationBackup ?? preMigrationBackupEnabled())) {
        backUpBeforeMigrating(db, path, timeout);
      }
      const mode = toWal(db, timeout);
      if (mode !== "wal") {
        throw new StorageError("INVALID_INPUT", `${path} could not switch to WAL journaling.`);
      }
      db.exec("PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON;");
      const connection = new Connection(path, db, options);
      db.exec(`PRAGMA mmap_size = ${MMAP_BYTES}`);
      if (connection.idleCheckpointMs > 0) {
        db.exec(`PRAGMA wal_autocheckpoint = ${WAL_GUARD_PAGES}; PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
      }
      connection.migrate();
      return connection;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  /**
   * Pending migrations and their version bumps commit together, or not at
   * all. The version is read inside the write transaction: a second process
   * opening the same new file waits for the first one's migration and then
   * finds nothing left to do, instead of running it again.
   */
  private migrate(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const from = userVersion(this.db);
      if (from > SCHEMA_VERSION) throw tooNew(this.path, from);
      for (const migration of MIGRATIONS) {
        if (migration.version <= from) continue;
        this.db.exec(migration.sql);
        this.db.exec(`PRAGMA user_version = ${migration.version}`);
        this.db
          .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
          .run(`migrated_v${migration.version}`, String(this.now()));
        this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('created_at', ?)").run(String(this.now()));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  get schemaVersion(): number {
    return userVersion(this.db);
  }

  /** The settings that make the promises hold, read back from SQLite: what doctor can show. */
  settings(): ConnectionSettings {
    this.assertOpen();
    const pragma = <T>(name: string): T => (this.db.prepare(`PRAGMA ${name}`).get() as Record<string, T>)[name] as T;
    const ftsSecureDelete = this.db
      .prepare("SELECT v FROM messages_fts_config WHERE k = 'secure-delete'")
      .get() as { v: number } | undefined;
    return {
      journalMode: pragma<string>("journal_mode"),
      synchronous: (["off", "normal", "full", "extra"] as const)[pragma<number>("synchronous")] ?? "unknown",
      foreignKeys: pragma<number>("foreign_keys") === 1,
      secureDelete: pragma<number>("secure_delete") === 1,
      ftsSecureDelete: ftsSecureDelete?.v === 1,
      busyTimeoutMs: (this.db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
    };
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  assertOpen(): void {
    if (this.closed) throw new StorageError("CLOSED", "The account database is closed.");
  }

  assertWritable(): void {
    this.assertOpen();
    if (this.readOnly) throw new StorageError("READ_ONLY", "This account database was opened read-only.");
  }

  stmt(sql: string): StatementSync {
    this.assertOpen();
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** A statement whose rows come back as arrays: the vector scan's loop builds no objects it would throw away. */
  arrayStmt(sql: string): StatementSync {
    this.assertOpen();
    const key = `arrays:${sql}`;
    let statement = this.statements.get(key);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      statement.setReturnArrays(true);
      this.statements.set(key, statement);
    }
    return statement;
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): number {
    const changes = Number(this.stmt(sql).run(...params).changes);
    // A statement on its own commits on its own.
    if (!this.db.isTransaction) this.committed();
    return changes;
  }

  /**
   * Moves whenever a write may have changed what names a jid: a contact's or a
   * chat's name, a note or a tag, a lid paired with a number, a chat or
   * contact folded into another — and on every rollback, which may undo one a
   * reader saw. A cache of names is good for as long as this stays put.
   */
  get namesVersion(): number {
    return this.namesEpoch;
  }

  namesChanged(): void {
    this.namesEpoch++;
  }

  /**
   * A write transaction around a synchronous body. Nested calls join the
   * outer transaction, so helpers can require one without caring who opened it.
   */
  write<T>(body: () => T): T {
    this.assertWritable();
    if (this.db.isTransaction) return body();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.db.exec("COMMIT");
      this.committed();
      return result;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      this.namesEpoch++;
      throw err;
    }
  }

  /**
   * One part of a write that may fail on its own. Inside a transaction it runs
   * under a savepoint: an error undoes what this part wrote, goes to `failed`,
   * and the transaction goes on with the parts before and after it. Outside one
   * it is a write transaction of its own. An error that took the whole
   * transaction with it (SQLite rolls one back on a full disk or an I/O error)
   * is thrown, never swallowed: the parts before it are gone too.
   */
  attempt(body: () => void, failed: (err: unknown) => void): void {
    this.assertWritable();
    if (!this.db.isTransaction) {
      try {
        this.write(body);
      } catch (err) {
        failed(err);
      }
      return;
    }
    // Savepoints nest by name: ROLLBACK TO and RELEASE take the newest one called this.
    this.db.exec("SAVEPOINT wazap_part");
    try {
      body();
    } catch (err) {
      this.namesEpoch++;
      if (!this.db.isTransaction) throw err;
      this.db.exec("ROLLBACK TO wazap_part");
      this.db.exec("RELEASE wazap_part");
      failed(err);
      return;
    }
    this.db.exec("RELEASE wazap_part");
  }

  /**
   * A commit grew the log: the idle checkpoint is due a quiet second from now,
   * and no later than IDLE_CHECKPOINT_MAX_MS after the first commit it covers.
   * One timer serves a whole burst; it re-arms itself rather than being reset
   * on every commit.
   */
  private committed(): void {
    if (this.idleCheckpointMs === 0) return;
    const now = performance.now();
    this.lastCommitAt = now;
    if (this.dirtySince === null) {
      this.dirtySince = now;
      this.idleRetries = 0;
    }
    if (this.idleTimer === null) this.armIdleCheckpoint(this.idleCheckpointMs);
  }

  private armIdleCheckpoint(delay: number): void {
    this.idleTimer = setTimeout(() => this.idleCheckpoint(), Math.max(1, Math.ceil(delay)));
    this.idleTimer.unref();
  }

  /**
   * A passive checkpoint once writes went quiet: it copies what it can and
   * never waits on a reader or a writer. One a reader kept from finishing
   * tries again a few times; the next commit asks anew either way.
   */
  private idleCheckpoint(): void {
    this.idleTimer = null;
    if (this.closed || this.dirtySince === null) return;
    const now = performance.now();
    const quiet = now - this.lastCommitAt;
    const pending = now - this.dirtySince;
    if (quiet < this.idleCheckpointMs && pending < IDLE_CHECKPOINT_MAX_MS) {
      this.armIdleCheckpoint(Math.min(this.idleCheckpointMs - quiet, IDLE_CHECKPOINT_MAX_MS - pending));
      return;
    }
    if (this.db.isTransaction) {
      this.armIdleCheckpoint(this.idleCheckpointMs);
      return;
    }
    const done = this.passiveCheckpoint();
    if (!done && this.idleRetries < IDLE_CHECKPOINT_RETRIES) {
      this.idleRetries++;
      this.dirtySince = performance.now() - IDLE_CHECKPOINT_MAX_MS;
      this.armIdleCheckpoint(this.idleCheckpointMs * 2 ** this.idleRetries);
    }
  }

  /**
   * PRAGMA wal_checkpoint(PASSIVE), which the idle checkpoint is: whether it
   * copied the whole log. A failure counts as done; the next commit asks again.
   */
  private passiveCheckpoint(): boolean {
    this.dirtySince = null;
    try {
      const row = this.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as CheckpointResult | undefined;
      return row === undefined || (row.busy === 0 && row.checkpointed >= row.log);
    } catch {
      return true;
    }
  }

  /**
   * A large operation as many small transactions: `step` does at most one
   * chunk and says whether more is left. Between chunks the event loop runs,
   * so live messages keep flowing while a chat of 50,000 rows is cleared.
   *
   * What the log already holds (up to the ~40 MB backstop after a burst) is
   * folded first, in a turn of its own: once the threshold drops to 1,000
   * pages, the first chunk's commit would fold all of it inside that commit,
   * a longer pause than either step alone. Two setImmediates follow it: a
   * caller in a socket's callback (most are) is in the loop's I/O phase, from
   * which one fires in the check phase right after, with no I/O between.
   */
  async chunked(step: () => boolean): Promise<void> {
    if (this.chunkedRunning === 0 && this.foldBacklog()) await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
    this.autocheckpointFor(+1);
    try {
      for (;;) {
        if (!this.write(step)) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      this.autocheckpointFor(-1);
    }
  }

  /** The idle checkpoint, now, when one is pending and no transaction is open; whether it ran. One a reader cut short is asked again by the next commit. */
  private foldBacklog(): boolean {
    if (this.idleCheckpointMs === 0 || this.closed || this.dirtySince === null || this.db.isTransaction) return false;
    if (!this.passiveCheckpoint()) this.dirtySince = performance.now();
    return true;
  }

  /** Commits checkpoint at 1,000 pages while a chunked operation runs, at the ~40 MB backstop otherwise (see BULK_AUTOCHECKPOINT_PAGES). */
  private autocheckpointFor(delta: 1 | -1): void {
    if (this.idleCheckpointMs === 0) return;
    const before = this.chunkedRunning;
    this.chunkedRunning = Math.max(0, before + delta);
    if (this.closed || (before > 0) === (this.chunkedRunning > 0)) return;
    this.db.exec(`PRAGMA wal_autocheckpoint = ${this.chunkedRunning > 0 ? BULK_AUTOCHECKPOINT_PAGES : WAL_GUARD_PAGES}`);
  }

  /** Large operations run one at a time; two chunked loops over one chat would race each other's cursors. */
  bulk<T>(work: () => Promise<T>): Promise<T> {
    const run = this.bulkTail.then(work, work);
    this.bulkTail = run.catch(() => undefined);
    return run;
  }

  /** Settles once every queued large operation has finished. */
  async idle(): Promise<void> {
    for (;;) {
      const tail = this.bulkTail;
      await tail;
      if (tail === this.bulkTail) return;
    }
  }

  /**
   * Moves the WAL into the main file and truncates it, so deleted bytes leave
   * the log — without ever waiting. A reader holding an older snapshot (status,
   * doctor, a search worker) would make a TRUNCATE checkpoint wait for the whole
   * busy timeout on the calling thread; here the busy timeout is 0 for the
   * duration, so a busy log is checkpointed as far as it can be (what PASSIVE
   * does), reported with `busy: 1`, and retried later on a timer.
   */
  checkpoint(): CheckpointResult {
    this.assertWritable();
    if (this.db.isTransaction) return { busy: 1, log: -1, checkpointed: -1 };
    this.db.exec("PRAGMA busy_timeout = 0");
    let row: CheckpointResult | undefined;
    try {
      row = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as CheckpointResult | undefined;
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${this.timeoutMs}`);
    }
    const result = row ?? { busy: 0, log: 0, checkpointed: 0 };
    if (result.busy !== 0) {
      this.scheduleCheckpoint(true);
    } else {
      this.checkpointRetries = 0;
      // The log is empty: the idle checkpoint has nothing left to do.
      this.dirtySince = null;
    }
    return result;
  }

  /**
   * A later truncating checkpoint: after a single delete, or again when a
   * reader kept the log busy. Several requests share one timer; retries back
   * off to a minute and give up after a few, until the next delete asks again.
   */
  scheduleCheckpoint(retry = false): void {
    if (this.readOnly || this.closed || this.checkpointDelayMs === 0 || this.checkpointTimer !== null) return;
    if (retry) {
      if (this.checkpointRetries >= MAX_CHECKPOINT_RETRIES) return;
      this.checkpointRetries++;
    } else {
      this.checkpointRetries = 0;
    }
    const delay = Math.min(60_000, this.checkpointDelayMs * 2 ** this.checkpointRetries);
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = null;
      if (this.closed) return;
      try {
        this.checkpoint();
      } catch {
        // The next delete or bulk operation asks again.
      }
    }, delay);
    this.checkpointTimer.unref();
  }

  /**
   * An online copy of the whole database to `destination`, taken while the
   * account keeps working. The copy is owner-only like the original.
   *
   * A destination that is the live database under any name — another case on
   * a case-insensitive disk, a symlink, a hard link — is refused by comparing
   * the files themselves, not their paths. The copy is written to a new
   * exclusive temp file beside the destination and renamed over it only when
   * complete, so even a missed alias could never truncate the live file.
   */
  async backup(destination: string): Promise<number> {
    this.assertOpen();
    const copy = beginCopy(this.path, destination);
    try {
      const pages = await sqlite().backup(this.db, copy.temp);
      finishCopy(copy);
      return pages;
    } catch (err) {
      rmSync(copy.temp, { force: true });
      throw err;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.checkpointTimer !== null) {
      clearTimeout(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }
}
