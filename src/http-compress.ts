/**
 * Response compression for /mcp, done at the origin because nothing in front
 * of it does: the SDK marks its SSE answers `no-transform`, Tailscale Funnel
 * compresses nothing, and the off-the-shelf middleware would skip them.
 *
 * gzip only. Node's fetch (every TypeScript MCP client) and Python's httpx
 * offer `gzip, deflate`; brotli at quality 4 measured no smaller on the tool
 * catalogue (11.4 KB against gzip's 10.9 KB for 55.6 KB) and holds 2.4 times
 * the memory per open stream (712 KiB against 299 KiB).
 */
import { constants, createGzip, gzip, type Gzip } from "node:zlib";
import { promisify } from "node:util";

/** Below this, an answer goes as it is: gzip's framing would eat what it saves. */
export const COMPRESS_MIN_BYTES = 1024;

const GZIP_LEVEL = constants.Z_DEFAULT_COMPRESSION;

/** Whether the client's Accept-Encoding takes gzip (q > 0, by name or through `*`). */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  if (header === undefined) return false;
  const value = Array.isArray(header) ? header.join(",") : header;
  let gzipQ: number | undefined;
  let anyQ: number | undefined;
  for (const part of value.split(",")) {
    const [rawCoding, ...params] = part.split(";");
    const coding = rawCoding?.trim().toLowerCase();
    if (!coding) continue;
    let q = 1;
    for (const param of params) {
      const [key, raw] = param.split("=").map((piece) => piece.trim().toLowerCase());
      if (key === "q") {
        const parsed = Number(raw);
        q = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    if (coding === "gzip" || coding === "x-gzip") gzipQ = Math.max(gzipQ ?? 0, q);
    else if (coding === "*") anyQ = q;
  }
  return (gzipQ ?? anyQ ?? 0) > 0;
}

/** A streaming encoder; the caller flushes after every event so SSE is never held back. */
export function gzipStream(): Gzip {
  return createGzip({ level: GZIP_LEVEL });
}

export const SYNC_FLUSH = constants.Z_SYNC_FLUSH;

const gzipAsync = promisify(gzip);

/** A whole body, compressed on the thread pool so a large one never blocks the event loop. */
export function gzipWhole(body: Buffer): Promise<Buffer> {
  return gzipAsync(body, { level: GZIP_LEVEL });
}
