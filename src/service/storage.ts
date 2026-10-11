/**
 * The account database, for one account: opening it, tying it to the linked
 * number, the boot that imports the earlier message files once, the daily
 * pass over the legacy files, what get_status says about it, and the work
 * that takes deleted and expired messages off the disk (the expiry timer and
 * the file cleanup). Part of WhatsAppService (src/whatsapp.ts), which stops
 * it and lends what the boot touches beyond the database through StorageHost.
 */

import { existsSync, readdirSync, renameSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AccountRecord } from "../accounts.js";
import type { AccountPaths, Config } from "../config.js";
import { AccountDb, purgePreMigrationBackups, StorageError } from "../db/index.js";
import { WazapError } from "../errors.js";
import { LidRegistry } from "../identity.js";
import { IMPORT_META, importBetaArchive, importLegacyAccount, scrubQuote, type ImportReport } from "../legacy-import/index.js";
import {
  LEGACY_TTL_MS,
  accountBetaState,
  carryLegacyRecord,
  lateBetaArchive,
  legacyRecordOf,
  legacySchedule,
  linkedOwners,
  moveAccountLegacy,
  purgeAccountLegacy,
  purgePreviousOwners,
  setAsideFor,
  settleAccountArchive,
  settleBetaArchive,
} from "../legacy-files.js";
import { log, logError } from "../logger.js";
import { isoWithOffset } from "../messages.js";
import type { EmbedFeed } from "../recall/index.js";
import { IMPORT_UNVERIFIED_META, importProgress } from "../storage-status.js";
import type { StorageInfo } from "../wa-types.js";
import type { AccountIdentity } from "./identity.js";
import { insideDir, leftGroup } from "./util.js";

/** The account database's file, beside the account's credentials. */
const DB_FILE = "wazap.sqlite";

/** How often a running service looks again at legacy files whose week may be up. */
const LEGACY_SWEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Whether an account still has files from before the account database: the
 * snapshot, history, barriers, notes, the recall index, or a 0.15-beta
 * archive. The import reads them once; F1-b2b moves them aside afterwards.
 */
function legacyFilesPresent(dataDir: string, paths: AccountPaths): boolean {
  const files = [
    paths.storeFile,
    paths.notesFile,
    join(paths.root, "retention.json"),
    join(paths.root, "recall", "state.json"),
    join(paths.root, "archive.sqlite"),
    join(dataDir, "archive.sqlite"),
  ];
  if (files.some((file) => existsSync(file))) return true;
  try {
    return readdirSync(paths.historyDir).some((name) => name.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

/** What the boot touches beyond the database: the service's, read at each call. */
export interface StorageHost {
  stopped(): boolean;
  /** What the service mirrors from a database it starts reading. */
  adoptDatabase(db: AccountDb): void;
  /** A stop or a crash cut these short: settled when the database opens. */
  recoverSends(db: AccountDb): void;
  recoverTranscriptions(db: AccountDb): void;
  /** The webhook outbox posts what the database holds, once it is ready. */
  startOutbox(): void;
  scheduleFlagsBackfill(db: AccountDb): void;
  embedFeed(): EmbedFeed | null;
  /** Kept media settles what a crash left and applies its limits, once the database is ready. */
  bootKeep(): Promise<void>;
}

export class AccountStorage {
  /** The account database, opened in the constructor; null only when it could not be opened. */
  accountDb: AccountDb | null = null;
  /**
   * `preparing` while the legacy files are being imported, `failed` when the
   * database could not be opened or prepared. Tools refuse in both, the first
   * with NOT_CONNECTED, which says "retry later" to every client.
   */
  storageState: "ready" | "preparing" | "failed" = "ready";
  /** What get_status said about storage while the database was open, for a stopped service to repeat. */
  private lastStorageInfo: StorageInfo | undefined;
  storageFault: WazapError | null = null;
  private storageBoot: Promise<void> | null = null;
  expiryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The daily pass over the legacy files, the beta archive and set-aside databases. */
  legacyTimer: ReturnType<typeof setInterval> | null = null;
  expiryAt: number | undefined;
  expirySweep: Promise<void> = Promise.resolve();
  /** Unlinking the files deleted messages released, one pass at a time. */
  fileWork: Promise<void> = Promise.resolve();
  /** A cleanup that failed, reported once to whoever waits for cleanup next. */
  fileFault: WazapError | null = null;

  constructor(
    private readonly host: StorageHost,
    private readonly identity: AccountIdentity,
    private readonly config: Config,
    private readonly accountRecord: AccountRecord,
    private readonly paths: AccountPaths
  ) {}

  /** The account database's path. */
  get databasePath(): string {
    return join(this.paths.root, DB_FILE);
  }

  /**
   * The account database for tests and for the doctor: every read and seed
   * goes through the same API the tools use. Refuses while the account is
   * still importing its earlier files, and when the database failed.
   */
  get db(): AccountDb {
    if (this.storageState === "preparing") throw this.preparingError();
    if (this.accountDb === null || this.storageState === "failed") {
      throw this.storageFault ?? new WazapError("SERVICE_ERROR", "The account database is not open.");
    }
    if (!this.accountDb.isOpen) {
      throw new WazapError("NOT_CONNECTED", "The account is stopping.", "Call get_status, wait, retry");
    }
    return this.accountDb;
  }

  /** The database when it answers reads and takes writes, or null: preparing, failed, stopped. */
  readyDb(): AccountDb | null {
    const db = this.accountDb;
    return db !== null && db.isOpen && this.storageState === "ready" ? db : null;
  }

  preparingError(): WazapError {
    return new WazapError(
      "NOT_CONNECTED",
      `Account "${this.accountRecord.id}" is preparing its database from its earlier message files. This happens once, after an upgrade.`,
      "Call get_status, wait, retry"
    );
  }

  private storageFail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const fix = err instanceof StorageError || err instanceof WazapError ? err.fix : undefined;
    this.storageState = "failed";
    this.storageFault = new WazapError(
      "SERVICE_ERROR",
      `The account database of "${this.accountRecord.id}" could not be used: ${message}`,
      fix ?? "Run `wazap status`, check the account directory's permissions and free disk space, then restart the server"
    );
    logError(`account database ${this.accountRecord.id}`, err);
  }

  /**
   * Opens the database synchronously, so a service answers from the moment it
   * exists; the import, the purge of an interrupted clear and the rest of the
   * boot wait for bootStorage().
   */
  openDatabase(): void {
    try {
      const db = AccountDb.open(this.databasePath, { scrubQuote, leftGroup, now: () => Date.now() });
      this.accountDb = db;
      this.host.adoptDatabase(db);
      this.host.recoverSends(db);
      this.host.recoverTranscriptions(db);
      if (this.legacyPending(db)) this.storageState = "preparing";
    } catch (err) {
      this.storageFail(err);
    }
  }

  private legacyPending(db: AccountDb): boolean {
    const state = db.getMeta(IMPORT_META.state);
    if (state === "done" || state === "imported" || state === "skipped") return false;
    return state === "running" || legacyFilesPresent(this.config.dataDir, this.paths);
  }

  /**
   * Ties the database to the linked number. A file another number filled — the
   * account logged out and a different phone linked — is set aside whole, next
   * to it: one person's history never shows under another's. The newest file
   * set aside for the linking number takes its place when there is one (that
   * number linked here before), otherwise a fresh one does. Legacy files the
   * earlier import read stay unread, and the record of what was moved to
   * legacy/ goes with whichever database serves next, so its week still runs.
   */
  claimDatabase(owner: string): void {
    const db = this.accountDb;
    if (db === null || !db.isOpen || this.storageState === "failed") return;
    try {
      db.bindOwner(owner);
      return;
    } catch (err) {
      if (!(err instanceof StorageError) || err.code !== "OWNER_MISMATCH") {
        this.storageFail(err);
        return;
      }
    }
    const imported = db.getMeta(IMPORT_META.state) !== null;
    const legacy = legacyRecordOf(db);
    db.close();
    let at = Date.now();
    while (["", "-wal", "-shm"].some((suffix) => existsSync(join(this.paths.root, `wazap.${at}.previous-owner.sqlite${suffix}`)))) at++;
    const aside = join(this.paths.root, `wazap.${at}.previous-owner.sqlite`);
    try {
      const restore = setAsideFor(this.paths.root, owner);
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(`${this.databasePath}${suffix}`)) renameSync(`${this.databasePath}${suffix}`, `${aside}${suffix}`);
      }
      if (restore !== null) {
        // The database file first: a -wal never lands beside a file it does not belong to.
        for (const suffix of ["", "-wal", "-shm"]) {
          const from = join(this.paths.root, `${restore}${suffix}`);
          if (existsSync(from)) renameSync(from, `${this.databasePath}${suffix}`);
        }
        log(`account ${this.accountRecord.id}: a number linked here before is linked again; its database is back, the other one set aside`);
      } else {
        log(`account ${this.accountRecord.id}: a different number is linked; its earlier database was set aside`);
      }
      const next = AccountDb.open(this.databasePath, { scrubQuote, leftGroup, now: () => Date.now() });
      this.accountDb = next;
      if (restore === null && (imported || legacyFilesPresent(this.config.dataDir, this.paths))) next.setMeta(IMPORT_META.state, "skipped");
      carryLegacyRecord(legacy, next);
      next.bindOwner(owner);
      this.identity.lids = new LidRegistry();
      this.host.adoptDatabase(next);
      this.storageState = this.legacyPending(next) ? "preparing" : "ready";
      // The next bootStorage() prepares the database now in place.
      this.storageBoot = null;
    } catch (err) {
      this.storageFail(err);
    }
  }

  /**
   * What start() runs before the socket, once per service: finish a fold or a
   * purge a stop interrupted, import the account's earlier files the first
   * time, forget the history of an account that keeps none, reconcile preview
   * files, and arm the expiry timer and the embedding feed. Tests call it to
   * boot a service without a socket.
   */
  bootStorage(): Promise<void> {
    this.storageBoot ??= this.bootStorageOnce().catch((err: unknown) => {
      this.storageBoot = null;
      throw err;
    });
    return this.storageBoot;
  }

  private async bootStorageOnce(): Promise<void> {
    const db = this.accountDb;
    if (db === null || this.storageState === "failed") throw this.storageFault ?? new WazapError("SERVICE_ERROR", "The account database is not open.");
    if (this.host.stopped() || !db.isOpen) return;
    try {
      await db.resume();
      if (this.legacyPending(db)) {
        this.storageState = "preparing";
        log(`account ${this.accountRecord.id}: importing the earlier message files into the account database (once)`);
        const report = await importLegacyAccount({
          dataDir: this.config.dataDir,
          accountId: this.accountRecord.id,
          accountPaths: this.paths,
          db,
          options: { retention: this.config.retention === true },
        });
        this.noteImport(db, report);
        // What the import stored carries no flags yet: the backfill works them out.
        db.messages.requestFlagsBackfill();
        this.identity.lids = new LidRegistry();
        this.host.adoptDatabase(db);
      }
      await this.importLateBeta(db);
      if (this.host.stopped() || !db.isOpen) return;
      if (!this.config.persistHistory) {
        try {
          db.schedule.settleReplied(Date.now());
        } catch (err) {
          logError("reminders", err);
        }
        await db.messages.purgeLive();
        db.sends.forgetWords();
        db.schedule.forgetWords();
      }
      this.storageState = "ready";
    } catch (err) {
      if (this.host.stopped() || !db.isOpen) return;
      this.storageFail(err);
      throw this.storageFault!;
    }
    await this.reconcilePreviews(db).catch((err: unknown) => logError("preview reconcile", err));
    await this.host.bootKeep().catch((err: unknown) => logError("kept media", err));
    await this.scheduleFileCleanup().catch(() => {});
    this.retireLegacy();
    if (this.legacyTimer === null && !this.host.stopped()) {
      this.legacyTimer = setInterval(() => this.retireLegacy(), LEGACY_SWEEP_MS);
      this.legacyTimer.unref();
    }
    this.armExpiry();
    this.host.startOutbox();
    this.host.scheduleFlagsBackfill(db);
    const feed = this.host.embedFeed();
    if (feed !== null) feed.kick();
    else {
      // Recall is off, or its settings do not parse: no queue is kept that nothing
      // would drain. The feed that runs again refills it once.
      try {
        db.vectors.unfeed();
      } catch (err) {
        logError("recall index", err);
      }
    }
  }

  /**
   * A beta archive this account's number owns and its import did not take (it
   * was not linked then, or the archive came later): imported now, before the
   * account serves, so the archive is never retired with rows only it holds.
   * A failure is logged and retried at the next start; the archive stays.
   */
  private async importLateBeta(db: AccountDb): Promise<void> {
    const archive = lateBetaArchive(this.config.dataDir, this.paths, db);
    if (archive === null || this.host.stopped() || !db.isOpen) return;
    const before = this.storageState;
    this.storageState = "preparing";
    log(`account ${this.accountRecord.id}: importing the beta archive.sqlite its number owns (once)`);
    try {
      const result = await importBetaArchive({
        dataDir: this.config.dataDir,
        accountId: this.accountRecord.id,
        accountPaths: this.paths,
        db,
        betaArchive: archive,
        options: { retention: this.config.retention === true },
      });
      const beta = result.phases?.beta;
      log(`account ${this.accountRecord.id}: beta archive ${result.outcome}${beta ? `, ${beta.imported} messages added` : ""}`);
      db.messages.requestFlagsBackfill();
      this.identity.lids = new LidRegistry();
      this.host.adoptDatabase(db);
    } catch (err) {
      if (this.host.stopped() || !db.isOpen) return;
      const code = (err as { code?: unknown })?.code;
      logError(`account ${this.accountRecord.id}`, `the beta archive import failed (${typeof code === "string" ? code : "error"}); it stays and is tried again at the next start`);
    } finally {
      if (this.storageState === "preparing") this.storageState = before;
    }
  }

  /**
   * What the legacy files' week asks of this account, at boot and daily:
   * move its imported legacy files into legacy/, delete what is due (a week
   * on, at once under WAZAP_RETENTION=1, never an unverified import's), and
   * move or delete the beta archive. Each step fails alone and is logged by
   * its error code, never by a path inside the files.
   */
  retireLegacy(): void {
    const db = this.readyDb();
    if (db === null) return;
    const id = this.accountRecord.id;
    const now = Date.now();
    const retention = this.config.retention === true;
    const step = (what: string, run: () => void): void => {
      try {
        run();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code ?? (err instanceof Error ? err.name : "error");
        logError(`account ${id}`, `${what} failed (${code}); tried again at the next pass`);
      }
    };
    step("moving the earlier message files into legacy/", () => {
      const { moved, recorded } = moveAccountLegacy(this.paths.root, db, now);
      if (!recorded || moved === 0) return;
      const schedule = legacySchedule(db);
      const when =
        schedule?.deleteAfter == null
          ? "kept until you delete them"
          : retention
            ? "deleted now (WAZAP_RETENTION=1)"
            : `deleted after ${isoWithOffset(schedule.deleteAfter)}`;
      log(`account ${id}: moved ${moved} earlier message files into legacy/, ${when}`);
    });
    step("deleting legacy/", () => {
      const entries = purgeAccountLegacy(this.paths.root, db, now, retention);
      if (entries !== null) log(`account ${id}: deleted ${entries} earlier message files from legacy/`);
    });
    step("settling the account's beta archive", () => {
      const { moved, deleted } = settleAccountArchive(this.paths.root, db, now, retention);
      if (moved) log(`account ${id}: moved its beta archive.sqlite into legacy/`);
      if (deleted > 0) log(`account ${id}: deleted ${deleted} beta archive(s) from legacy/`);
    });
    step("deleting set-aside databases", () => {
      const deleted = purgePreviousOwners(this.paths.root, now, linkedOwners(this.config.dataDir));
      if (deleted > 0) log(`account ${id}: deleted ${deleted} database(s) set aside when a different number linked`);
    });
    // The open database's own version is the proof its upgrade landed: a copy
    // taken for a version it is not past yet is the safety net of an upgrade
    // that has not finished, and stays however old it is.
    step("deleting pre-migration copies", () => {
      const deleted = purgePreMigrationBackups(this.paths.root, now, db.schemaVersion, retention);
      if (deleted > 0) log(`account ${id}: deleted ${deleted} copy/copies taken before an earlier upgrade`);
    });
    step("settling the beta archive", () => {
      const { moved, deleted } = settleBetaArchive(this.config.dataDir, now, retention, (accountId) =>
        accountId === id ? accountBetaState(db) : undefined
      );
      if (moved) log("moved the beta archive.sqlite into legacy/");
      if (deleted > 0) log(`deleted ${deleted} beta archive(s) from legacy/`);
    });
  }

  /** Logs how the import went; an import with unexplained differences still serves, and says so for doctor. */
  private noteImport(db: AccountDb, report: ImportReport): void {
    const counts = `${report.totals.messages} messages, ${report.totals.chats} chats`;
    if (report.state === "done") {
      db.setMeta(IMPORT_UNVERIFIED_META, null);
      log(`account ${this.accountRecord.id}: imported ${counts}, verified`);
      return;
    }
    const unexpected = report.verification?.unexpected ?? {};
    db.setMeta(IMPORT_UNVERIFIED_META, JSON.stringify({ at: report.finishedAt, unexpected }));
    const summary = Object.entries(unexpected)
      .map(([kind, n]) => `${kind} ${n}`)
      .join(", ");
    logError(
      `account ${this.accountRecord.id}`,
      `imported ${counts}, but verification found differences it could not explain (${summary || "verification did not run"}); serving from the database`
    );
  }

  /**
   * Preview files the database does not know: kept and recorded when their
   * message is still visible (a preview made before the upgrade), removed when
   * it is not. Bounded by the files in the folder.
   */
  private async reconcilePreviews(db: AccountDb): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.paths.previewsDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".jpg")) continue;
      const path = join(this.paths.previewsDir, name);
      if (!db.isOpen) return;
      const sid = name.slice(0, -".jpg".length);
      const known = db.messages.get(sid);
      if (known !== null && db.messages.media(sid).some((media) => media.kind === "preview" && media.path === path)) continue;
      if (known === null || !db.messages.setMedia(sid, "preview", path).stored) await rm(path, { force: true });
    }
  }

  /**
   * A message a read found past its deadline becomes a tombstone there and
   * then, before the sweep reaches it: an expiry once observed stays, even if
   * the clock moves back.
   */
  settleExpired(db: AccountDb, id: string): void {
    const row = db.messages.get(id, { includeHidden: true });
    const now = Date.now();
    if (row === null || row.deletedAt !== null || row.expiresAt === null || row.expiresAt > now) return;
    db.messages.delete(row.sid, { at: now });
    void this.scheduleFileCleanup().catch(() => {});
  }

  /** What get_status says about the database; reads two meta rows. */
  storageInfo(): StorageInfo | undefined {
    const db = this.accountDb;
    if (this.storageState === "failed") return { state: "failed" };
    // Stopped (a logout, a removal, a restart): what it last said, not a failure.
    if (db === null || !db.isOpen) return this.lastStorageInfo;
    this.lastStorageInfo = this.readStorageInfo(db);
    return this.lastStorageInfo;
  }

  private readStorageInfo(db: AccountDb): StorageInfo {
    if (this.storageState === "preparing") {
      const progress = importProgress(db);
      return progress === null ? { state: "preparing" } : { state: "preparing", progress: `${progress.phase} (${progress.step} of ${progress.steps})` };
    }
    const info: StorageInfo = { state: db.getMeta(IMPORT_UNVERIFIED_META) === null ? "ready" : "imported-unverified" };
    const schedule = legacySchedule(db);
    if (schedule !== null && schedule.deletedAt === null) {
      info.legacy_files = schedule.kept !== null ? { kept: schedule.kept } : { deleted_after: isoWithOffset(schedule.movedAt + LEGACY_TTL_MS) };
    }
    return info;
  }

  /**
   * Unlinks the files the database released — previews and kept media of
   * deleted, cleared or expired messages, and kept media past its limits —
   * one pass at a time. A failure is kept for the next
   * caller that waits on cleanup, and the paths stay queued in the database.
   */
  scheduleFileCleanup(): Promise<void> {
    const run = this.fileWork.then(() => this.unlinkReleased());
    this.fileWork = run.catch((err: unknown) => {
      this.fileFault = new WazapError(
        "WHATSAPP_ERROR",
        "Local message persistence or cleanup failed.",
        "Check the account directory permissions and disk space before restarting"
      );
      logError("message storage", err);
    });
    return this.fileWork;
  }

  async unlinkReleased(): Promise<void> {
    const db = this.accountDb;
    if (db === null || !db.isOpen || db.readOnly) return;
    const claimed = db.claimUnlinks();
    if (claimed.length === 0) return;
    const done: string[] = [];
    let failure: unknown = null;
    for (const path of claimed) {
      try {
        // Only files wazap itself made are ever unlinked, whatever a row says.
        if (this.ownsFile(path)) await rm(path, { force: true });
        done.push(path);
      } catch (err) {
        failure ??= err;
      }
    }
    if (db.isOpen) db.ackUnlinks(done);
    if (failure !== null) throw failure;
  }

  private ownsFile(path: string): boolean {
    return insideDir(this.paths.previewsDir, path) || insideDir(this.paths.keptDir, path);
  }

  /**
   * One unreferenced timer per account, on the earliest deadline the database
   * holds: a disappearing message under WAZAP_RETENTION, or a story's day.
   * Reads already hide a message the moment its deadline passes; the timer is
   * what takes its words, vector and files off the disk while nobody reads.
   */
  armExpiry(): void {
    const db = this.readyDb();
    if (this.host.stopped() || db === null) return;
    const next = db.messages.nextExpiry();
    if (next === null) {
      if (this.expiryTimer) clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
      this.expiryAt = undefined;
      return;
    }
    if (this.expiryTimer !== null && this.expiryAt !== undefined && this.expiryAt <= next) return;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryAt = next;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.expiryAt = undefined;
      void this.sweepExpired();
    }, Math.max(1, Math.min(2_147_483_647, next - Date.now())));
    this.expiryTimer.unref();
  }

  sweepExpired(): Promise<void> {
    this.expirySweep = this.expirySweep
      .then(async () => {
        const db = this.readyDb();
        if (this.host.stopped() || db === null) return;
        await db.messages.expireDue();
        await this.scheduleFileCleanup();
        this.armExpiry();
      })
      .catch((err: unknown) => logError("message expiry", err));
    return this.expirySweep;
  }

  requireCleanupOwner(): void {
    if (this.host.stopped()) throw new WazapError("NOT_CONNECTED", "The service stopped before local cleanup could complete.",
      "Reconnect and verify the operation; WhatsApp may already have accepted it");
  }
}
