/**
 * What media downloads may take from the one process that holds every
 * account's WhatsApp link and every agent's session: a download is held in
 * memory whole, so a burst of video requests from several cloud agents could
 * otherwise push the machine into swap and drop the link for everyone (one
 * 100 MB download measured +200 MB RSS, four at once +600 MB). A download
 * reserves its declared size before it starts; past the concurrency or the
 * byte budget it waits its turn, briefly, then is told to retry.
 */
import { callCancelled } from "./cancel.js";
import { WazapError } from "./errors.js";

export interface DownloadLimits {
  /** Downloads running at once, process-wide. */
  concurrent: number;
  /** Declared bytes of the downloads running at once. */
  bytes: number;
  /** How long a download waits for room before RATE_LIMITED. */
  waitMs: number;
  /** A download that receives nothing for this long is stopped. */
  idleMs: number;
  /** A download that has not finished in this long is stopped. */
  totalMs: number;
}

export const DOWNLOAD_LIMITS: DownloadLimits = {
  concurrent: 3,
  bytes: 300_000_000,
  waitMs: 30_000,
  idleMs: 30_000,
  totalMs: 180_000,
};

/** What a download whose size the envelope does not state reserves. */
export const UNKNOWN_SIZE_RESERVE = 16_000_000;

interface Waiter {
  bytes: number;
  grant: () => void;
}

export class DownloadBudget {
  private running = 0;
  private reserved = 0;
  private readonly queue: Waiter[] = [];

  constructor(readonly limits: DownloadLimits = DOWNLOAD_LIMITS) {}

  /** Downloads running and the bytes they reserved, for tests and diagnostics. */
  get usage(): { running: number; reserved: number; waiting: number } {
    return { running: this.running, reserved: this.reserved, waiting: this.queue.length };
  }

  private fits(bytes: number): boolean {
    // One download always runs, whatever its size: the per-file cap bounds it, and refusing it would starve it.
    return this.running === 0 || (this.running < this.limits.concurrent && this.reserved + bytes <= this.limits.bytes);
  }

  /**
   * Room for a download of `bytes`, in arrival order: resolves with the call
   * that gives it back, or rejects with RATE_LIMITED after `waitMs` (the
   * limits' own unless a caller with less time left gives its own), or with
   * the cancellation at once when `signal` aborts while it waits.
   */
  acquire(bytes: number, signal?: AbortSignal, waitMs: number = this.limits.waitMs): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(callCancelled());
    const take = (): (() => void) => {
      this.running++;
      this.reserved += bytes;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.running--;
        this.reserved -= bytes;
        this.drain();
      };
    };
    if (this.queue.length === 0 && this.fits(bytes)) return Promise.resolve(take());
    return new Promise((resolve, reject) => {
      const leave = (): boolean => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancelled);
        const at = this.queue.indexOf(waiter);
        if (at < 0) return false;
        this.queue.splice(at, 1);
        return true;
      };
      const waiter: Waiter = {
        bytes,
        grant: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancelled);
          resolve(take());
        },
      };
      // A cancelled call gives its place up at once: the next in line may fit now.
      const cancelled = (): void => {
        if (!leave()) return;
        reject(callCancelled());
        this.drain();
      };
      signal?.addEventListener("abort", cancelled, { once: true });
      const timer = setTimeout(() => {
        leave();
        reject(
          new WazapError(
            "RATE_LIMITED",
            `Media downloads are busy: ${this.running} running, ${Math.round(this.reserved / 1_000_000)} MB in memory.`,
            "Wait 30 seconds, then retry once"
          )
        );
        this.drain();
      }, waitMs);
      this.queue.push(waiter);
    });
  }

  private drain(): void {
    while (this.queue.length > 0 && this.fits(this.queue[0]!.bytes)) this.queue.shift()!.grant();
  }
}

/** The process's one budget, shared by every account. */
export const downloadBudget = new DownloadBudget();
