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
 *
 * A row's path is trusted for its file name only: the file is always looked
 * for in this account's kept folder, so a data dir that moved (a new disk, a
 * remounted volume, a symlinked path) keeps its files, and no row can point a
 * read or an unlink anywhere else.
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { WAMessage, WASocket } from "baileys";
import type { AccountPaths } from "../config.js";
import { chatKindOf, type AccountDb, type StoredMessage } from "../db/index.js";
import { isNoiseJid } from "../ids.js";
import { log, logError } from "../logger.js";
import type { MediaKeepSettings, MediaKeepType } from "../media-keep.js";
import { mediaInfo, mediaSha256, mediaViewOnce, messageIdFor } from "../messages.js";
import { mediaFilename } from "../outgoing-media.js";
import type { ConnectionStatus } from "../wa-types.js";
import { chatListed } from "../webhook-filter.js";
import type { AccountIdentity } from "./identity.js";
import type { AccountStorage } from "./storage.js";
import { WazapError } from "../errors.js";
import { DIR_MODE, FILE_MODE, statusCodeOf } from "./util.js";
import type { MessageViews } from "./views.js";

/** The `media` kind a kept file is recorded under. */
export const KEPT_KIND = "original";

/** The names mediaFilename gives, and their half-written form: the only files the kept folder's sweep removes. */
const KEPT_NAME = /^\d+-[0-9a-f]{8}\.[a-z0-9]{1,16}$/i;
const PART_NAME = /^\d+-[0-9a-f]{8}\.[a-z0-9]{1,16}\.part$/i;

/** Downloads waiting; past this, the next catch-up finds the rest. */
const QUEUE_MAX = 200;

/** Media of this recent past that arrived with nobody keeping it is fetched by the catch-up. */
const CATCH_UP_MS = 2 * 24 * 60 * 60 * 1000;
/** The catch-up reads the database in pages, and gives up after this many messages it did not want. */
const CATCH_UP_PAGE = 200;
const CATCH_UP_SCAN = 5_000;

/** How often the age limit is applied while the server runs. */
const SWEEP_MS = 60 * 60 * 1000;

/** A download that failed this often, or for good (gone, too big), is not tried again by this process. */
const TRIES = 3;
/** Bounded so a flood cannot grow the record of failures. */
const FAILED_MAX = 5_000;

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
  /** The bytes behind a message's media, from WhatsApp, refusing more than `maxBytes`. */
  mediaBuffer(sock: WASocket, messageId: string, raw: WAMessage, maxBytes?: number): Promise<Buffer>;
  /** Unlinks what the database released; kept files go this way. */
  scheduleFileCleanup(): Promise<void>;
  /** Free and total bytes of the disk under `dir`; a test replaces it. */
  diskSpace?(dir: string): Promise<{ free: number; total: number }>;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** A failure no retry fixes: too big, or WhatsApp no longer has the file. */
function permanent(err: unknown): boolean {
  if (err instanceof WazapError && err.code === "FILE_TOO_LARGE") return true;
  const status = statusCodeOf((err as { cause?: unknown } | undefined)?.cause);
  return status === 403 || status === 404 || status === 410;
}

export class AccountKeep {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  /** Failed downloads by message, with how often they failed. */
  private readonly failures = new Map<string, number>();
  /** Something was turned away by a full queue: a catch-up runs once the queue drains. */
  private overflowed = false;
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

  /** Where the file a row names lives now: its name in this account's kept folder, or null for a name wazap never gives. */
  private located(path: string): string | null {
    const name = basename(path);
    return KEPT_NAME.test(name) ? join(this.paths.keptDir, name) : null;
  }

  // Reading ------------------------------------------------------------------

  /**
   * The kept copy of a message's media, or null: none was kept, the file is
   * gone, or it no longer matches the hash the sender stated (then the server
   * forgets it, and WhatsApp is asked instead). Read whatever the settings say
   * now: a copy kept is served until something removes it.
   */
  async read(sid: string, raw: WAMessage): Promise<Buffer | null> {
    const db = this.storage.readyDb();
    const recorded = db?.messages.media(sid).find((media) => media.kind === KEPT_KIND)?.path;
    if (db === null || recorded === undefined) return null;
    const path = this.located(recorded);
    if (path === null) return null;
    let buffer: Buffer;
    try {
      buffer = await readFile(path);
    } catch (err) {
      if (!isMissing(err)) logError("kept media read", err);
      else this.forget([recorded]);
      return null;
    }
    const expected = mediaSha256(raw);
    if (expected !== undefined && !createHash("sha256").update(buffer).digest().equals(expected)) {
      logError("kept media", "a kept file no longer matches its message; WhatsApp is asked instead");
      this.forget([recorded]);
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
    if (!settings.types.has(message.type as MediaKeepType)) return false;
    // A view-once message usually has a type of its own; one flagged on its media node does not.
    if (mediaViewOnce(raw)) return false;
    if (isNoiseJid(message.chatJid)) return false;
    const info = mediaInfo(raw);
    if (info === undefined) return false;
    if (info.size !== undefined && info.size > settings.maxFileBytes) return false;
    const listed = settings.chats.length > 0 && chatListed(db, settings.chats, message.chatJid);
    if (listed) return true;
    // Channels and broadcast lists are not conversations: kept only when listed.
    const kind = chatKindOf(message.chatJid);
    if (kind !== "direct" && kind !== "group") return false;
    switch (settings.policy) {
      case "all":
        return true;
      case "unmuted": {
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

  private gaveUp(sid: string): boolean {
    return (this.failures.get(sid) ?? 0) >= TRIES;
  }

  // Arriving -----------------------------------------------------------------

  /** Messages that arrived live and were stored: queued for download, and the settings decide when each is taken. */
  noteArrivals(stored: readonly WAMessage[]): void {
    if (!this.active || this.stopping) return;
    for (const raw of stored) {
      const remote = raw.key.remoteJid;
      if (!remote || mediaInfo(raw) === undefined) continue;
      this.enqueue(messageIdFor(raw.key, this.identity.canonical(remote)));
    }
    this.kick();
  }

  /** The link is up: what arrived in the last two days with nobody keeping it is queued, then the queue runs. */
  connected(): void {
    if (!this.active || this.stopping) return;
    this.catchUp();
    this.kick();
  }

  /**
   * Queues the wanted media of the last two days that is not kept yet,
   * oldest first, as far as the queue has room: the server was down, the
   * link was, or the queue turned it away. Pages past what it does not want.
   */
  private catchUp(): void {
    const db = this.storage.readyDb();
    const settings = this.settings;
    if (db === null || settings === undefined) return;
    try {
      const since = Date.now() - CATCH_UP_MS;
      const found: string[] = [];
      let before: number | undefined;
      let scanned = 0;
      const room = (): number => QUEUE_MAX - this.queue.length - found.length;
      while (room() > 0 && scanned < CATCH_UP_SCAN) {
        const page = db.messages.withoutMedia(KEPT_KIND, [...settings.types], since, CATCH_UP_PAGE, before);
        if (page.length === 0) break;
        for (const message of page) {
          scanned++;
          if (room() <= 0) break;
          if (this.queued.has(message.sid) || this.gaveUp(message.sid)) continue;
          const raw = this.views.rawOf(message);
          if (raw !== null && this.wants(db, message, raw)) found.push(message.sid);
        }
        before = page[page.length - 1]!.id;
        if (page.length < CATCH_UP_PAGE) break;
      }
      // Oldest first: it expires on WhatsApp's side first.
      for (const sid of found.reverse()) this.enqueue(sid);
    } catch (err) {
      logError("kept media", err);
    }
  }

  private enqueue(sid: string): void {
    if (this.queued.has(sid) || this.gaveUp(sid)) return;
    if (this.queue.length >= QUEUE_MAX) {
      this.overflowed = true;
      return;
    }
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
    while (this.canDownload()) {
      if (this.queue.length === 0) {
        // The queue turned something away: look again, now that there is room.
        if (!this.overflowed) break;
        this.overflowed = false;
        this.catchUp();
        if (this.queue.length === 0) break;
      }
      const sid = this.queue.shift()!;
      this.queued.delete(sid);
      await this.fetch(sid);
    }
  }

  private async fetch(sid: string): Promise<void> {
    const db = this.storage.readyDb();
    const sock = this.host.sock();
    const settings = this.settings;
    if (db === null || sock === null || settings === undefined) return;
    const message = db.messages.get(sid);
    const raw = message === null ? null : this.views.rawOf(message);
    if (message === null || raw === null || !this.wants(db, message, raw) || this.isKept(db, sid)) return;
    // A disk with no room for it is not worth the download.
    const declared = mediaInfo(raw)?.size;
    if (declared !== undefined && !(await this.roomFor(declared))) return;
    let buffer: Buffer;
    try {
      // No more than a kept file may hold: an understated size costs at most that much.
      buffer = await this.host.mediaBuffer(sock, sid, raw, settings.maxFileBytes);
    } catch (err) {
      // Expired, too big, or the link dropped: get_media will say which if asked. A dropped link is tried
      // again by a later catch-up, a few times; expired and too big are not.
      if (this.failures.size >= FAILED_MAX) this.failures.clear();
      this.failures.set(sid, permanent(err) ? TRIES : (this.failures.get(sid) ?? 0) + 1);
      return;
    }
    const expected = mediaSha256(raw);
    if (expected !== undefined && !createHash("sha256").update(buffer).digest().equals(expected)) {
      // Not the file the sender stated: asking again brings the same bytes.
      this.failures.set(sid, TRIES);
      return;
    }
    this.failures.delete(sid);
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

      // Everything that can refuse the file is asked before anything kept is evicted for it.
      if (!(await this.roomFor(buffer.length))) return;
      if (!this.host.hasMessage(sid)) return;
      await this.enforce(db, buffer.length);
      if (!this.host.hasMessage(sid) || !db.isOpen || this.stopping) return;

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
   * first. A row recorded under an earlier path of the data dir is pointed at
   * the kept folder now; one whose file is gone is forgotten; a row whose name
   * wazap never gives is left alone. A size is read once.
   */
  private async inventory(db: AccountDb): Promise<Array<{ path: string; createdAt: number; size: number }>> {
    const out: Array<{ path: string; createdAt: number; size: number }> = [];
    const gone: string[] = [];
    const live = new Set<string>();
    for (const row of db.messages.mediaOfKind(KEPT_KIND)) {
      const path = this.located(row.path);
      if (path === null) continue;
      let size = path === row.path ? this.sizes.get(path) : undefined;
      if (size === undefined) {
        try {
          size = (await stat(path)).size;
        } catch (err) {
          if (isMissing(err)) gone.push(row.path);
          continue;
        }
        if (path !== row.path && db.isOpen) db.messages.rehomeMedia(KEPT_KIND, row.path, path);
        this.sizes.set(path, size);
      }
      live.add(path);
      out.push({ path, createdAt: row.createdAt, size });
    }
    for (const path of this.sizes.keys()) if (!live.has(path)) this.sizes.delete(path);
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

  /**
   * Forgets these kept files; the database queues them for unlinking. Only
   * the server forgets: another process reading a vanished file leaves the
   * row to it.
   */
  private forget(paths: readonly string[]): void {
    const db = this.storage.readyDb();
    if (!this.serving || db === null || paths.length === 0) return;
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
      // Rows under an earlier path of the data dir are pointed here first, so the sweep below spares their files.
      if (this.active) await this.enforce(db);
      await this.sweepOrphans(db);
      if (this.active && this.timer === null) {
        this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
        this.timer.unref();
      }
    });
  }

  /** The hourly pass: the age limit, and the quota. */
  sweep(): Promise<void> {
    return this.serial(async () => {
      const db = this.storage.readyDb();
      if (db !== null && this.active && !this.stopping) await this.enforce(db);
    });
  }

  /**
   * Files in the kept folder that no row records, by the names wazap gives
   * only: a write a crash cut short, or a record a restored or replaced
   * database no longer has. Anything else in the folder is left alone.
   */
  private async sweepOrphans(db: AccountDb): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.paths.keptDir);
    } catch {
      return;
    }
    const known = new Set(db.messages.mediaOfKind(KEPT_KIND).map((row) => basename(row.path)));
    for (const name of names) {
      if (!db.isOpen) return;
      if (known.has(name) || !(KEPT_NAME.test(name) || PART_NAME.test(name))) continue;
      const path = join(this.paths.keptDir, name);
      try {
        if (!(await lstat(path)).isFile()) continue;
        await rm(path, { force: true });
      } catch (err) {
        if (!isMissing(err)) logError("kept media", err);
      }
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
