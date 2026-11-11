/**
 * A tool call the client cancelled, or whose session closed, stops waiting.
 * The SDK never sends the answer of a cancelled request, so what it stops
 * with is for the log and the in-flight slot, which is released only once the
 * handler settles. Only waits stop this way: work that changes something,
 * once started, always runs to its end.
 */
import { WazapError } from "./errors.js";

export function callCancelled(): WazapError {
  return new WazapError("TIMEOUT", "The call was cancelled before it finished.", "Call it again if the answer is still wanted");
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw callCancelled();
}

/** `work`, or callCancelled as soon as `signal` aborts; the work itself goes on for whoever else waits on it. */
export function orCancelled<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(callCancelled());
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(callCancelled());
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(err);
      }
    );
  });
}

/**
 * Work several callers share, such as one transcription a tool call and the
 * auto queue both asked for. Each caller stops waiting on its own cancel; the
 * work itself is stopped (its signal aborts) only when every caller has left
 * before it committed. A caller without a signal keeps it going to its end,
 * and so does the commit: past it, the work runs whoever still waits.
 */
export class SharedRun<T> {
  readonly work: Promise<T>;
  private readonly stop = new AbortController();
  private waiting = 0;
  private pinned = false;
  private committed = false;

  /** `start` gets the run's signal and its commit, which throws once every caller has left. */
  constructor(start: (signal: AbortSignal, commit: () => void) => Promise<T>) {
    this.work = start(this.stop.signal, () => {
      throwIfCancelled(this.stop.signal);
      this.committed = true;
    });
    // A run every caller has left fails with nobody to tell.
    this.work.catch(() => {});
  }

  /** Every caller left before the commit: the work is stopping, and a new caller starts its own. */
  get abandoned(): boolean {
    return this.stop.signal.aborted;
  }

  /** The work, for one more caller, who stops waiting when `signal` aborts. */
  join(signal: AbortSignal | undefined): Promise<T> {
    if (signal === undefined) {
      this.pinned = true;
      return this.work;
    }
    this.waiting++;
    const leave = (): void => {
      this.waiting--;
      if (this.waiting === 0 && !this.pinned && !this.committed) this.stop.abort(callCancelled());
    };
    if (signal.aborted) leave();
    else {
      signal.addEventListener("abort", leave, { once: true });
      const forget = (): void => signal.removeEventListener("abort", leave);
      void this.work.then(forget, forget);
    }
    return orCancelled(this.work, signal);
  }
}
