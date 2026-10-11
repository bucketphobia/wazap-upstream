/**
 * Kept media: the photos, voice notes and documents of chosen chats,
 * downloaded as they arrive and kept beside the account database, so get_media
 * still has them after WhatsApp's servers let them go. Part of WhatsAppService
 * (src/whatsapp.ts); the settings are src/media-keep.ts.
 *
 * Every kept file is a `media` row of kind `original` against its message, so
 * whatever takes a message off the disk (a delete for everyone, an expiry
 * under strict retention, a clear, a history purge) takes its file too,
 * through the database's unlink queue, crash or not. What this part adds is
 * the bound: no file over the size limit, the oldest going first once the
 * quota is reached or their age is up, and nothing written that would leave
 * the disk nearly full.
 *
 * Only the server keeps (`wazap serve`, with history persisted); a short-lived
 * command neither downloads nor removes. A file is written under a temporary
 * name, renamed, and only then recorded, so a crash leaves at most an
 * unrecorded file, which the next start removes.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WAMessage, WASocket } from "baileys";
import type { AccountPaths } from "../config.js";
import type { AccountDb, StoredMessage } from "../db/index.js";
import { isNoiseJid } from "../ids.js";
import { log, logError } from "../logger.js";
import type { MediaKeepSettings, MediaKeepType } from "../media-keep.js";
import { mediaInfo, mediaSha256, messageIdFor } from "../messages.js";
import { mediaFilename } from "../outgoing-media.js";
import type { ConnectionStatus } from "../wa-types.js";
import { chatListed } from "../webhook-filter.js";
import type { AccountIdentity } from "./identity.js";
import type { AccountStorage } from "./storage.js";
import { DIR_MODE, FILE_MODE, insideDir } from "./util.js";
import type { MessageViews } from "./views.js";

/** The `media` kind a kept file is recorded under. */
export const KEPT_KIND = "original";

/** Arrivals waiting for their download; past this, the catch-up at the next connection finds them. */
const QUEUE_MAX = 200;

/** On connecting, media of this recent past that arrived with nobody keeping it is fetched. */
const CATCH_UP_MS = 2 * 24 * 60 * 60 * 1000;
const CATCH_UP_MAX = 200;

/** How often the age limit is applied while the server runs. */
const SWEEP_MS = 60 * 60 * 1000;

/** A download that failed is not tried again by this process; bounded so a flood cannot grow it. */
const FAILED_MAX = 1000;

/** How long a stop waits for a keep under way before closing the database under it. */
const STOP_WAIT_MS = 5_000;

/** Never written: a file that would leave less free than the smaller of these on the disk. */
const DISK_RESERVE_BYTES = 1024 * 1024 * 1024;
const DISK_RESERVE_SHARE = 0.05;

/** What the service lends: the socket, the download, and whether a message is still there, read at each call. */
export interface KeepHost {
  stopped(): boolean;
  status(): ConnectionStatus;
  sock(): WASocket | null;
  hasMessage(id: string): boolean;
  /** The bytes behind a message's media, from WhatsApp. */
  mediaBuffer(sock: WASocket, messageId: string, raw: WAMessage): Promise<Buffer>;
  /** Unlinks what the database released; kept files go this way. */
  scheduleFileCleanup(): Promise<void>;
  /** Free and total bytes of the disk under `dir`; a test replaces it. */
  diskSpace?(dir: string): Promise<{ free: number; total: number }>;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export class AccountKeep {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly failed = new Set<string>();
  private worker: Promise<void> | null = null;
  /** Booting, storing, evicting and sweeping, one at a time, so the quota is never counted twice. */
  private work: Promise<void> = Promise.resolve();
  /** The size of each kept file, read once; refreshed against the database's rows at each pass. */
  private readonly sizes = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  /** The disk was too full: said once, until a write succeeds again. */
  private diskWarned = false;

  constructor(
    private readonly host: KeepHost,
    private readonly identity: AccountIdentity,
    private readonly views: MessageViews,
    private readonly storage: AccountStorage,
    private readonly paths: AccountPaths,
    private readonly settings: MediaKeepSettings | undefined,
    /** Whether this process may download and remove: the server, keeping history. */
    private readonly serving: boolean
  ) {}

  /** Whether new media is kept. */
  get active(): boolean {
    return this.serving && this.settings !== undefined && this.settings.policy !== "off";
  }

  /**
   * Whether the settings say, deliberately, that nothing is kept: then the
   * copies an earlier run kept are removed. A value that does not parse also
   * keeps nothing, but removes nothing either: a typo never deletes.
   */
  private get purging(): boolean {
    return this.serving && this.settings !== undefined && this.settings.policy === "off" && this.settings.problems.length === 0;
  }

  // Reading ------------------------------------------------------------------

  /**
   * The kept copy of a message's media, or null: none was kept, the file is
   * gone, or it no longer matches the hash the sender stated (then it is
   * forgotten, and WhatsApp is asked instead). Read whatever the settings say
   * now: a copy kept is served until something removes it.
   */
  async read(sid: string, raw: WAMessage): Promise<Buffer | null> {
    const db = this.storage.readyDb();
    const path = db?.messages.media(sid).find((media) => media.kind === KEPT_KIND)?.path;
    if (db === null || path === undefined) return null;
    // Only a file inside the kept folder is ever read back, whatever a row says.
    if (!insideDir(this.paths.keptDir, path)) return null;
    let buffer: Buffer;
    try {
      buffer = await readFile(path);
    } catch (err) {
      if (!isMissing(err)) logError("kept media read", err);
      else this.forget([path]);
      return null;
    }
    const expected = mediaSha256(raw);
    if (expected !== undefined && !createHash("sha256").update(buffer).digest().equals(expected)) {
      logError("kept media", "a kept file no longer matches its message; it is removed and WhatsApp is asked instead");
      this.forget([path]);
      return null;
    }
    if (!this.host.hasMessage(sid)) return null;
    return buffer;
  }

  // Deciding -----------------------------------------------------------------

  /** Whether this message's media is one the settings keep. Does not look at whether it is kept already. */
  private wants(db: AccountDb, message: StoredMessage, raw: WAMessage): boolean {
    const settings = this.settings;
    if (!this.active || settings === undefined) return false;
    // A view-once message has its own type, never one of these, so it is never kept.
    if (!settings.types.has(message.type as MediaKeepType)) return false;
    if (isNoiseJid(message.chatJid)) return false;
    const info = mediaInfo(raw);
    if (info === undefined) return false;
    if (info.size !== undefined && info.size > settings.maxFileBytes) return false;
    switch (settings.policy) {
      case "all":
        return true;
      case "chats":
        return chatListed(db, settings.chats, message.chatJid);
      case "unmuted": {
        if (settings.chats.length > 0 && chatListed(db, settings.chats, message.chatJid)) return true;
        const mutedUntil = db.identity.chat(message.chatJid)?.mutedUntil ?? null;
        // WhatsApp spells "muted for ever" as -1.
        return mutedUntil === null || (mutedUntil !== -1 && mutedUntil <= Date.now());
      }
      default:
        return false;
    }
  }

  private isKept(db: AccountDb, sid: string): boolean {
    return db.messages.media(sid).some((media) => media.kind === KEPT_KIND);
  }

  // Arriving -----------------------------------------------------------------

  /** Messages that arrived live and were stored: the ones the settings keep are queued for download. */
  noteArrivals(stored: readonly WAMessage[]): void {
    if (!this.active || this.stopping) return;
    for (const raw of stored) {
      const remote = raw.key.remoteJid;
      if (!remote || mediaInfo(raw) === undefined) continue;
      this.enqueue(messageIdFor(raw.key, this.identity.canonical(remote)));
    }
    this.kick();
  }

  /**
   * The link is up: what arrived in the last two days with nobody keeping it
   * (the server was down, or the queue was full) is queued, then the queue runs.
   */
  connected(): void {
    if (!this.active || this.stopping) return;
    const db = this.storage.readyDb();
    if (db !== null && this.settings !== undefined) {
      try {
        const missing = db.messages.withoutMedia(KEPT_KIND, [...this.settings.types], Date.now() - CATCH_UP_MS, CATCH_UP_MAX);
        // Oldest first: it expires on WhatsApp's side first.
        for (const message of missing.reverse()) this.enqueue(message.sid);
      } catch (err) {
        logError("kept media", err);
      }
    }
    this.kick();
  }

  private enqueue(sid: string): void {
    if (this.queued.has(sid) || this.failed.has(sid) || this.queue.length >= QUEUE_MAX) return;
    this.queue.push(sid);
    this.queued.add(sid);
  }

  private kick(): void {
    if (this.worker !== null || this.queue.length === 0) return;
    this.worker = this.drain()
      .catch((err: unknown) => logError("kept media", err))
      .finally(() => {
        this.worker = null;
        // Something queued while the last download finished.
        if (this.queue.length > 0 && this.canDownload()) this.kick();
      });
  }

  private canDownload(): boolean {
    return !this.stopping && !this.host.stopped() && this.host.status() === "connected" && this.host.sock() !== null;
  }

  /** One download at a time; a lost link leaves the rest queued for the next connection. */
  private async drain(): Promise<void> {
    while (this.queue.length > 0 && this.canDownload()) {
      const sid = this.queue.shift()!;
      this.queued.delete(sid);
      await this.fetch(sid);
    }
  }

  private async fetch(sid: string): Promise<void> {
    const db = this.storage.readyDb();
    const sock = this.host.sock();
    if (db === null || sock === null) return;
    const message = db.messages.get(sid);
    const raw = message === null ? null : this.views.rawOf(message);
    if (message === null || raw === null || !this.wants(db, message, raw) || this.isKept(db, sid)) return;
    let buffer: Buffer;
    try {
      buffer = await this.host.mediaBuffer(sock, sid, raw);
    } catch {
      // Expired already, too big, or the link dropped: get_media will say which if asked.
      if (this.failed.size >= FAILED_MAX) this.failed.clear();
      this.failed.add(sid);
      return;
    }
    await this.store(sid, raw, buffer);
  }

  /** get_media downloaded this from WhatsApp: kept too when the settings keep it. */
  offer(sid: string, raw: WAMessage, buffer: Buffer): Promise<void> {
    if (!this.active || this.stopping) return Promise.resolve();
    return this.store(sid, raw, buffer);
  }

  // Storing ------------------------------------------------------------------

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.work.then(task);
    this.work = run.then(
      () => undefined,
      (err: unknown) => logError("kept media", err)
    );
    return run;
  }

  private store(sid: string, raw: WAMessage, buffer: Buffer): Promise<void> {
    return this.serial(async () => {
      const settings = this.settings;
      const db = this.storage.readyDb();
      if (settings === undefined || db === null || this.stopping || this.host.stopped()) return;
      const message = db.messages.get(sid);
      if (message === null || !this.wants(db, message, raw) || this.isKept(db, sid)) return;
      if (buffer.length === 0 || buffer.length > settings.maxFileBytes || buffer.length > settings.quotaBytes) return;
      const expected = mediaSha256(raw);
      if (expected !== undefined && !createHash("sha256").update(buffer).digest().equals(expected)) return;

      await this.enforce(db, buffer.length);
      if (!(await this.roomFor(buffer.length))) return;
      if (!this.host.hasMessage(sid)) return;

      const info = mediaInfo(raw);
      const final = join(this.paths.keptDir, mediaFilename(info ?? { mime: "application/octet-stream" }));
      const part = `${final}.part`;
      await mkdir(this.paths.keptDir, { recursive: true, mode: DIR_MODE });
      try {
        await writeFile(part, buffer, { mode: FILE_MODE });
        await rename(part, final);
      } catch (err) {
        await rm(part, { force: true });
        throw err;
      }
      // Deleted while the file was written: the record is refused, and the file goes at once.
      const recorded = this.host.hasMessage(sid) && db.isOpen ? db.messages.setMedia(sid, KEPT_KIND, final) : { stored: false, replaced: null };
      if (!recorded.stored) {
        await rm(final, { force: true });
        return;
      }
      this.sizes.set(final, buffer.length);
      this.diskWarned = false;
      if (recorded.replaced !== null) void this.host.scheduleFileCleanup().catch(() => {});
    });
  }

  /** Whether writing `bytes` leaves the disk its reserve. Unknown free space never blocks. */
  private async roomFor(bytes: number): Promise<boolean> {
    let space: { free: number; total: number };
    try {
      space = this.host.diskSpace !== undefined ? await this.host.diskSpace(this.paths.root) : await diskSpace(this.paths.root);
    } catch {
      return true;
    }
    const reserve = Math.min(DISK_RESERVE_BYTES, space.total * DISK_RESERVE_SHARE);
    if (space.free - bytes >= reserve) return true;
    if (!this.diskWarned) {
      this.diskWarned = true;
      logError("kept media", "the disk is nearly full, so arriving media is not being kept; free some space");
    }
    return false;
  }

  /**
   * The kept files as the database records them, each with its size, oldest
   * first. A row whose file is gone is forgotten; a size is read once.
   */
  private async inventory(db: AccountDb): Promise<Array<{ path: string; createdAt: number; size: number }>> {
    const rows = db.messages.mediaOfKind(KEPT_KIND);
    const live = new Set(rows.map((row) => row.path));
    for (const path of this.sizes.keys()) if (!live.has(path)) this.sizes.delete(path);
    const out: Array<{ path: string; createdAt: number; size: number }> = [];
    const gone: string[] = [];
    for (const row of rows) {
      let size = this.sizes.get(row.path);
      if (size === undefined) {
        try {
          size = (await stat(row.path)).size;
          this.sizes.set(row.path, size);
        } catch (err) {
          if (isMissing(err)) gone.push(row.path);
          continue;
        }
      }
      out.push({ ...row, size });
    }
    if (gone.length > 0) this.forget(gone);
    return out;
  }

  /**
   * The limits, with room for `incoming` more bytes: files past their age go,
   * then the oldest until the rest and the newcomer fit the quota.
   */
  private async enforce(db: AccountDb, incoming = 0): Promise<void> {
    const settings = this.settings;
    if (settings === undefined) return;
    const files = await this.inventory(db);
    const drop: string[] = [];
    const cutoff = settings.maxAgeMs > 0 ? Date.now() - settings.maxAgeMs : null;
    let total = 0;
    const kept: typeof files = [];
    for (const file of files) {
      if (cutoff !== null && file.createdAt < cutoff) drop.push(file.path);
      else {
        kept.push(file);
        total += file.size;
      }
    }
    for (const file of kept) {
      if (total + incoming <= settings.quotaBytes) break;
      drop.push(file.path);
      total -= file.size;
    }
    if (drop.length === 0) return;
    this.forget(drop);
    // The bytes leave the disk before new ones land.
    await this.host.scheduleFileCleanup().catch(() => {});
  }

  /** Forgets these kept files; the database queues them for unlinking. */
  private forget(paths: readonly string[]): void {
    const db = this.storage.readyDb();
    if (db === null || paths.length === 0) return;
    try {
      db.messages.dropMedia(KEPT_KIND, paths);
      for (const path of paths) this.sizes.delete(path);
      void this.host.scheduleFileCleanup().catch(() => {});
    } catch (err) {
      logError("kept media", err);
    }
  }

  // Lifecycle ----------------------------------------------------------------

  /**
   * At start, once the database is ready: removes what a crash left (files the
   * database does not know, half-written ones) and, when keeping is off on
   * purpose, every kept copy; otherwise applies the limits, which may have
   * shrunk since the last run, and arms the hourly age sweep.
   */
  boot(): Promise<void> {
    if (!this.serving || this.stopping) return Promise.resolve();
    return this.serial(async () => {
      const db = this.storage.readyDb();
      if (db === null) return;
      if (this.purging) {
        const rows = db.messages.mediaOfKind(KEPT_KIND);
        if (rows.length > 0) {
          this.forget(rows.map((row) => row.path));
          log(`kept media: WAZAP_MEDIA_KEEP=off, so the ${rows.length} file(s) kept earlier are removed`);
        }
      }
      await this.sweepOrphans(db);
      if (this.active) {
        await this.enforce(db);
        if (this.timer === null) {
          this.timer = setInterval(() => void this.serial(async () => {
            const current = this.storage.readyDb();
            if (current !== null && !this.stopping) await this.enforce(current);
          }), SWEEP_MS);
          this.timer.unref();
        }
      }
    });
  }

  /** Files in the kept folder that no row records: a write a crash cut short. */
  private async sweepOrphans(db: AccountDb): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.paths.keptDir);
    } catch {
      return;
    }
    const known = new Set(db.messages.mediaOfKind(KEPT_KIND).map((row) => row.path));
    for (const name of names) {
      const path = join(this.paths.keptDir, name);
      if (known.has(path) || !db.isOpen) continue;
      // A path still queued for unlinking is the queue's to remove.
      await rm(path, { force: true, recursive: false }).catch((err: unknown) => logError("kept media", err));
    }
  }

  /** Before the database closes: no new download starts, and one under way gets a moment to land. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.queued.clear();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((done) => {
      timer = setTimeout(done, STOP_WAIT_MS);
      timer.unref();
    });
    await Promise.race([Promise.allSettled([this.worker, this.work]), waited]);
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function diskSpace(dir: string): Promise<{ free: number; total: number }> {
  const fs = await statfs(dir);
  return { free: fs.bavail * fs.bsize, total: fs.blocks * fs.bsize };
}
