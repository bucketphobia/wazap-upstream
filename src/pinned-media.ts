/**
 * Media a draft took from a URL or from the call itself, pinned when it was
 * drafted: the bytes the preview described are the bytes that leave, however
 * long the yes takes and whatever the URL serves by then. Each file lives in
 * the account's `outgoing/` folder (0700, files 0600) under its SHA-256, read
 * back and checked against it at the send; the draft row (and a scheduled
 * message's row) names it by that hash. A file goes once no draft waiting to
 * be confirmed, no send under way and no scheduled message waiting names it:
 * after the send, at the draft's expiry, on a cancel, and at the next start
 * for whatever a crash left. Two drafts of the same bytes share one file.
 *
 * Bounded: all pinned files of an account together at most
 * PINNED_MAX_TOTAL_BYTES, and never a file that would leave the disk less free
 * than the smaller of 1 GB and 5% (the rule kept media follows).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WazapError } from "./errors.js";
import { logError } from "./logger.js";

/** What a draft's payload keeps of its pinned file. */
export interface PinnedMedia {
  sha256: string;
  mime: string;
  size: number;
  filename: string;
  /** A URL's file: the host its bytes came from, after any redirect (a draft from before this field has none). */
  fetchedFrom?: string;
}

/** Every pinned file of one account together; a draft that would pass it is refused. */
export const PINNED_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const DISK_RESERVE_BYTES = 1024 * 1024 * 1024;
const DISK_RESERVE_SHARE = 0.05;
/** A half-written file older than this is a crash's: the sweep removes it. */
const PART_STALE_MS = 10 * 60_000;
const SHA = /^[0-9a-f]{64}$/;

function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_048_576))} MB`;
}

export interface PinnedStoreOptions {
  maxTotalBytes?: number;
  /** Free and total bytes of the disk under `dir`; a test replaces it. */
  diskSpace?: (dir: string) => Promise<{ free: number; total: number }>;
  now?: () => number;
}

export class PinnedStore {
  /** Hashes being pinned for a draft not yet stored: a sweep meanwhile keeps them. */
  private readonly pinning = new Map<string, number>();
  /**
   * Hashes released since the running sweep read what the database names: the
   * draft they were pinned for may be stored after that read, so the sweep
   * keeps them, and the next sweep judges them.
   */
  private readonly released = new Set<string>();
  /** Files a sweep is removing now: a pin of the same bytes waits for the removal, then writes them again. */
  private readonly removing = new Map<string, Promise<void>>();
  private sweeping: Promise<void> | null = null;
  private sweepAgain = false;
  private readonly maxTotal: number;
  private readonly now: () => number;

  constructor(
    readonly dir: string,
    private readonly opts: PinnedStoreOptions = {}
  ) {
    this.maxTotal = opts.maxTotalBytes ?? PINNED_MAX_TOTAL_BYTES;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Writes `buffer` under its hash, unless the same bytes are already pinned,
   * and holds it against sweeps until `release` (the draft stored, or not).
   */
  async pin(buffer: Buffer, mime: string, filename: string): Promise<PinnedMedia> {
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    this.pinning.set(sha256, (this.pinning.get(sha256) ?? 0) + 1);
    try {
      await this.removing.get(sha256);
      await oneWriteAtATime(() => this.write(sha256, buffer));
      return { sha256, mime, size: buffer.length, filename };
    } catch (err) {
      this.release(sha256);
      if (err instanceof WazapError) throw err;
      // The disk's own words name the server's paths: they go to the log, and the caller hears what happened.
      logError("pinned media", err);
      throw new WazapError(
        "SERVICE_ERROR",
        "The file could not be kept for the draft on the machine running wazap; nothing was drafted.",
        "Try the draft again; if it fails again, the server's log says why"
      );
    }
  }

  /**
   * Writes the bytes under their hash unless they are there already, after
   * checking the account's cap and the disk's reserve. Run one at a time, so
   * each check sees every file written before it.
   */
  private async write(sha256: string, buffer: Buffer): Promise<void> {
    const path = join(this.dir, sha256);
    const known = await stat(path).then(
      (found) => found.size === buffer.length,
      () => false
    );
    if (!known) {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const held = await this.totalBytes();
      if (held + buffer.length > this.maxTotal) {
        throw new WazapError(
          "FILE_TOO_LARGE",
          `Drafts and scheduled messages of this account already hold ${megabytes(held)} of media waiting to go; with this file (${megabytes(buffer.length)}) that would pass the ${megabytes(this.maxTotal)} they may hold.`,
          "Send or cancel waiting drafts and scheduled messages with media, or wait for unconfirmed drafts to expire (15 minutes)"
        );
      }
      if (!(await this.roomFor(buffer.length))) {
        throw new WazapError(
          "FILE_TOO_LARGE",
          "The disk of the machine running wazap is nearly full, so the file is not kept for the draft.",
          "Free some space there, then draft again"
        );
      }
      // A name of its own for each write, so two drafts of the same bytes at once each write and rename their own
      // copy (the second rename replaces the first with the same bytes); the time last, for the sweep of a crash's.
      const part = join(this.dir, `${sha256}.${randomUUID()}.${this.now()}.part`);
      try {
        await writeFile(part, buffer, { mode: 0o600 });
        await rename(part, path);
      } catch (err) {
        await rm(part, { force: true }).catch(() => undefined);
        throw err;
      }
    }
  }

  /** The draft that pinned `sha256` is stored, or failed: a sweep may judge the file by the database from now on. */
  release(sha256: string): void {
    const held = (this.pinning.get(sha256) ?? 0) - 1;
    if (held > 0) this.pinning.set(sha256, held);
    else this.pinning.delete(sha256);
    if (this.sweeping !== null) this.released.add(sha256);
  }

  /** The pinned bytes, checked against their hash: a file changed or gone is refused, never sent in its place. */
  async read(pinned: PinnedMedia): Promise<Buffer> {
    if (!SHA.test(pinned.sha256)) throw this.gone();
    const buffer = await readFile(join(this.dir, pinned.sha256)).catch(() => {
      throw this.gone();
    });
    if (createHash("sha256").update(buffer).digest("hex") !== pinned.sha256) throw this.gone();
    return buffer;
  }

  private gone(): WazapError {
    return new WazapError(
      "FILE_NOT_FOUND",
      "The file this draft pinned when it was drafted is no longer on the machine running wazap; nothing was sent.",
      "Tell the user; draft the message again with the file, show the new preview and ask for a yes"
    );
  }

  /**
   * Removes every pinned file `referenced()` does not name and no pin holds;
   * `referenced()` answering null (nothing to judge by) removes nothing. One
   * sweep at a time; one asked for while another runs runs after it.
   */
  sweep(referenced: () => ReadonlySet<string> | null): Promise<void> {
    if (this.sweeping !== null) {
      this.sweepAgain = true;
      return this.sweeping;
    }
    this.sweeping = (async () => {
      do {
        this.sweepAgain = false;
        await this.sweepOnce(referenced).catch((err: unknown) => logError("pinned media", err));
      } while (this.sweepAgain);
    })().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private async sweepOnce(referenced: () => ReadonlySet<string> | null): Promise<void> {
    this.released.clear();
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    if (names.length === 0) return;
    const keep = referenced();
    if (keep === null) return;
    for (const name of names) {
      if (SHA.test(name)) {
        // What the database named when it was read, what a draft is pinning now, and what a draft released since
        // (it may have been stored after that read) all stay. The check and the start of the removal are one step.
        if (keep.has(name) || this.pinning.has(name) || this.released.has(name)) continue;
        const removal = rm(join(this.dir, name), { force: true });
        this.removing.set(
          name,
          removal.catch(() => undefined)
        );
        try {
          await removal;
        } finally {
          this.removing.delete(name);
        }
      } else if (name.endsWith(".part")) {
        const at = Number(name.split(".").at(-2));
        if (Number.isFinite(at) && this.now() - at > PART_STALE_MS) await rm(join(this.dir, name), { force: true });
      }
    }
  }

  /** Bytes every pinned file holds now. */
  async totalBytes(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    let total = 0;
    for (const name of names) {
      if (!SHA.test(name) && !name.endsWith(".part")) continue;
      total += await stat(join(this.dir, name)).then(
        (found) => found.size,
        () => 0
      );
    }
    return total;
  }

  /** Whether writing `bytes` leaves the disk its reserve. Unknown free space never blocks. */
  private async roomFor(bytes: number): Promise<boolean> {
    try {
      const space = this.opts.diskSpace !== undefined ? await this.opts.diskSpace(this.dir) : await diskSpace(this.dir);
      return space.free - bytes >= Math.min(DISK_RESERVE_BYTES, space.total * DISK_RESERVE_SHARE);
    } catch {
      return true;
    }
  }
}

/**
 * The pins' writes, every account's, one after another: each checks the cap
 * and the disk's reserve against what is on disk, which a write still under
 * way would not have shown, so drafts at once could each pass a check that
 * all of them together fail. A write is short next to the fetch before it.
 */
let writes: Promise<unknown> = Promise.resolve();

function oneWriteAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = writes.then(task, task);
  writes = run.catch(() => undefined);
  return run;
}

async function diskSpace(dir: string): Promise<{ free: number; total: number }> {
  const fs = await statfs(dir);
  return { free: fs.bavail * fs.bsize, total: fs.blocks * fs.bsize };
}
