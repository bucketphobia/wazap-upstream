/**
 * One media download into memory, as WhatsAppService.mediaBuffer does it:
 * inside the process's download budget (src/media-budget.ts), stopped when
 * WhatsApp's CDN goes quiet or takes too long, refused past the in-memory
 * cap, and checked against deletion as it lands. Split out of
 * src/whatsapp.ts so it can be tested with a stream of its own.
 */
import type { Readable } from "node:stream";
import { callCancelled } from "../cancel.js";
import { WazapError } from "../errors.js";
import { statusCodeOf } from "./util.js";
import { downloadBudget as processBudget, UNKNOWN_SIZE_RESERVE, type DownloadBudget } from "../media-budget.js";

export interface DownloadSource {
  /** The decrypted media as a stream (Baileys' downloadMediaMessage). */
  open(): Promise<Readable>;
  /** Throws when the message is gone (deleted, expired, cleared): checked per chunk. */
  stillThere(): void;
}

/** WhatsApp's CDN no longer has the file (404, 410): the phone may upload it again. */
export function cdnExpired(err: unknown): boolean {
  const status = statusCodeOf(err) ?? (err as { status?: unknown } | undefined)?.status;
  return status === 404 || status === 410;
}

/** Why a download was stopped by its own clock. */
class Stalled extends Error {
  constructor(readonly why: "idle" | "total") {
    super(why);
  }
}

function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / 1_000_000)} MB`;
}

/** The size refusal, before a byte is fetched or once the stream outgrows the cap. */
export function tooLarge(messageId: string, cap: number, size?: number): WazapError {
  return new WazapError(
    "FILE_TOO_LARGE",
    `${size === undefined ? `The media of ${messageId} is over ${megabytes(cap)}` : `The media of ${messageId} is ${megabytes(size)}`}; ` +
      `wazap holds a download in memory and takes at most ${megabytes(cap)}, so this one cannot be fetched.`,
    "Tell the user it is too large to open here; they can open it on the phone"
  );
}

/**
 * The media's bytes. `declared` (the envelope's size) is reserved in the
 * budget and, when it is under the cap, allocated once so the download is
 * not held twice while it is concatenated.
 */
export async function downloadToMemory(
  messageId: string,
  source: DownloadSource,
  {
    declared,
    cap,
    budget = processBudget,
    signal,
    waitMs,
  }: { declared?: number; cap: number; budget?: DownloadBudget; signal?: AbortSignal; waitMs?: number }
): Promise<Buffer> {
  if (declared !== undefined && declared > cap) throw tooLarge(messageId, cap, declared);
  // A cancelled call leaves the line for a slot, and stops its download at the next chunk; `waitMs` shortens the line's wait.
  const release = await budget.acquire(declared ?? UNKNOWN_SIZE_RESERVE, signal, waitMs);
  const { idleMs, totalMs } = budget.limits;
  let stream: Readable | null = null;
  let stalled: Stalled | null = null;
  let cancelled: WazapError | null = null;
  let fail: (err: Error) => void = () => {};
  const clock = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  clock.catch(() => {});
  const stop = (why: "idle" | "total"): void => {
    stalled ??= new Stalled(why);
    fail(stalled);
    stream?.destroy(stalled);
  };
  const cancel = (): void => {
    cancelled ??= callCancelled();
    fail(cancelled);
    stream?.destroy(cancelled);
  };
  const total = setTimeout(() => stop("total"), totalMs);
  let idle = setTimeout(() => stop("idle"), idleMs);
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  try {
    // The CDN may not answer at all: the clocks run from before the request, and a stream that
    // arrives after they ran out, or after the call was cancelled, is closed unread.
    const opened = source.open();
    opened.then((late) => (stalled !== null || cancelled !== null ? late.destroy() : undefined)).catch(() => {});
    stream = await Promise.race([opened, clock]);
    let out: Buffer | null = declared !== undefined && declared > 0 ? Buffer.allocUnsafe(declared) : null;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      clearTimeout(idle);
      idle = setTimeout(() => stop("idle"), idleMs);
      source.stillThere();
      const piece = chunk as Buffer;
      if (bytes + piece.length > cap) {
        stream.destroy();
        throw tooLarge(messageId, cap);
      }
      if (out !== null && bytes + piece.length <= out.length) piece.copy(out, bytes);
      else {
        // More than the envelope said: from here on, chunks are kept and joined at the end.
        if (out !== null) {
          chunks.push(out.subarray(0, bytes));
          out = null;
        }
        chunks.push(piece);
      }
      bytes += piece.length;
    }
    return out !== null ? out.subarray(0, bytes) : Buffer.concat(chunks, bytes);
  } catch (err) {
    if (cancelled !== null) throw cancelled;
    if (err instanceof Stalled || stalled !== null) {
      const why = (stalled ?? (err as Stalled)).why;
      throw new WazapError(
        "TIMEOUT",
        why === "idle"
          ? `The download of ${messageId} stalled: WhatsApp sent nothing for ${idleMs / 1000} s.`
          : `The download of ${messageId} took over ${totalMs / 1000} s and was stopped.`,
        "Retry once; if it stalls again, check the connection with get_status"
      );
    }
    throw err;
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
    signal?.removeEventListener("abort", cancel);
    release();
  }
}
