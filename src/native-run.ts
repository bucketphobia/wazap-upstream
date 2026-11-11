/**
 * The native helpers get_media runs on a sender's file (poppler's pdftoppm,
 * Quick Look, sips, ffmpeg): each under a time limit, a memory limit read
 * from the operating system while it runs, and a process-wide number at once.
 * A crafted file can make a parser allocate gigabytes in seconds (a PDF font
 * that inflates to 4 GB made pdftoppm reach 2 GB); a timeout alone lets that
 * happen, so the child's resident memory is polled and the child killed past
 * its limit.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { callCancelled, throwIfCancelled } from "./cancel.js";

const exec = promisify(execFile);

/**
 * A fixed number of runs at once; the rest wait in order. A slot given up
 * passes straight to the next in line. A waiter whose `signal` aborts (its
 * call was cancelled) leaves the line and rejects with the cancellation.
 */
export class Slots {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly size: number) {}

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfCancelled(signal);
    if (this.running >= this.size) {
      await new Promise<void>((resolve, reject) => {
        const grant = (): void => {
          signal?.removeEventListener("abort", leave);
          resolve();
        };
        const leave = (): void => {
          const at = this.waiting.indexOf(grant);
          if (at >= 0) this.waiting.splice(at, 1);
          reject(callCancelled());
        };
        this.waiting.push(grant);
        signal?.addEventListener("abort", leave, { once: true });
      });
    } else this.running++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) this.running--;
      else next();
    }
  }
}

export interface NativeLimits {
  timeoutMs: number;
  /** Resident memory past which the child is killed. */
  maxRssBytes: number;
  signal?: AbortSignal;
}

/** How often a child's memory is read. */
const POLL_MS = 200;

/** A child killed for its memory, with what it printed before. */
export class NativeMemoryError extends Error {
  constructor(
    readonly limit: number,
    readonly stderr: string
  ) {
    super(`it used more than ${Math.round(limit / 1_000_000)} MB of memory and was stopped`);
  }
}

/**
 * The `VmRSS:` line of /proc/<pid>/status in bytes. The kernel states it in kB
 * whatever its page size; statm counts pages, which are 16 or 64 KiB on some
 * arm64 kernels, not the 4 KiB a fixed multiplier would assume.
 */
export function vmRssBytes(status: string): number | null {
  const found = /^VmRSS:\s*(\d+)\s*kB/m.exec(status);
  return found === null ? null : Number(found[1]) * 1024;
}

/**
 * The memory column of `tasklist /FO CSV /NH` in bytes: the working set, as
 * "12,345 K" grouped in the system's locale. null when no process matched
 * (tasklist then prints an INFO line, not a row).
 */
export function tasklistBytes(csv: string): number | null {
  const row = csv.split(/\r?\n/).find((line) => line.startsWith('"'));
  const cells = row?.match(/"[^"]*"/g);
  const digits = cells?.at(-1)?.replace(/\D/g, "") ?? "";
  return digits === "" ? null : Number(digits) * 1024;
}

/** A process's resident memory in bytes: /proc on Linux, tasklist on Windows, ps elsewhere; null when it cannot be read (the process is gone). */
export async function residentBytes(pid: number, platform: NodeJS.Platform = process.platform): Promise<number | null> {
  try {
    if (platform === "linux") return vmRssBytes(await readFile(`/proc/${pid}/status`, "utf8"));
    if (platform === "win32") {
      const { stdout } = await exec("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeout: 2_000, windowsHide: true });
      return tasklistBytes(stdout);
    }
    const { stdout } = await exec("/bin/ps", ["-o", "rss=", "-p", String(pid)], { timeout: 2_000, windowsHide: true });
    const kib = Number(stdout.trim());
    return stdout.trim() !== "" && Number.isFinite(kib) ? kib * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * `file` with `args`, its output captured, under `limits`. Rejects like
 * execFile (the error carries stdout and stderr) on a failure, a timeout or
 * an abort, and with NativeMemoryError when the child grew past its memory.
 */
export function runNative(file: string, args: string[], limits: NativeLimits): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let overLimit = false;
    let reading = false;
    const child = execFile(
      file,
      args,
      { timeout: limits.timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL", ...(limits.signal ? { signal: limits.signal } : {}) },
      (err, stdout, stderr) => {
        clearInterval(watch);
        if (overLimit) reject(new NativeMemoryError(limits.maxRssBytes, String(stderr)));
        else if (err) reject(Object.assign(err, { stdout: String(stdout), stderr: String(stderr) }));
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
    const watch = setInterval(() => {
      if (reading || child.pid === undefined || child.exitCode !== null) return;
      reading = true;
      void residentBytes(child.pid).then((rss) => {
        reading = false;
        if (rss !== null && rss > limits.maxRssBytes && child.exitCode === null) {
          overLimit = true;
          child.kill("SIGKILL");
        }
      });
    }, POLL_MS);
    watch.unref();
  });
}

/** ffmpeg frame grabs and sips conversions running at once, process-wide. */
export const helperSlots = new Slots(2);
/** What one of them may grow to: ffmpeg decoding a 4K frame stays well under it. */
export const HELPER_RSS_BYTES = 1_000_000_000;
