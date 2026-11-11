/**
 * Just enough of a ZIP reader to take the XML out of an Office or
 * OpenDocument file: the central directory, stored and deflated entries, and
 * nothing else (no ZIP64, no encryption, no spanning). The archive is the
 * sender's, so every number in it is checked before it is believed: how many
 * entries there are, how big each one says it will be, how much that is for
 * its compressed size, and how much is inflated in all. inflateRawSync's
 * maxOutputLength stops an entry that lies about its size. Runs in the
 * document worker (src/document-worker.ts), never on the event loop.
 */
import { inflateRawSync } from "node:zlib";

/** What an archive may hold before it is refused as a bomb or a mistake. */
export interface ZipLimits {
  /** Entries in the central directory. */
  maxEntries: number;
  /** One entry, inflated. */
  maxEntryBytes: number;
  /** Everything read from the archive, inflated. */
  maxTotalBytes: number;
  /** Inflated bytes per compressed byte, for an entry over 64 KB. */
  maxRatio: number;
}

export const ZIP_LIMITS: ZipLimits = {
  maxEntries: 10_000,
  maxEntryBytes: 20_000_000,
  maxTotalBytes: 60_000_000,
  maxRatio: 200,
};

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export class ZipReader {
  readonly entries: ZipEntry[];
  private inflated = 0;

  constructor(
    private readonly data: Buffer,
    private readonly limits: ZipLimits = ZIP_LIMITS
  ) {
    this.entries = this.directory();
  }

  /** The central directory, found from the end record (which may be followed by a comment of up to 64 KB). */
  private directory(): ZipEntry[] {
    const data = this.data;
    const floor = Math.max(0, data.length - 22 - 0xffff);
    let end = -1;
    for (let at = data.length - 22; at >= floor; at--) {
      if (data.readUInt32LE(at) === EOCD_SIGNATURE) {
        end = at;
        break;
      }
    }
    if (end < 0) throw new ZipError("not a ZIP archive");
    const count = data.readUInt16LE(end + 10);
    const size = data.readUInt32LE(end + 12);
    const start = data.readUInt32LE(end + 16);
    if (count === 0xffff || start === 0xffffffff) throw new ZipError("ZIP64 archives are not read");
    if (count > this.limits.maxEntries) throw new ZipError(`${count} entries, over ${this.limits.maxEntries}`);
    if (start + size > end) throw new ZipError("the central directory runs past its end");
    const entries: ZipEntry[] = [];
    let at = start;
    for (let i = 0; i < count; i++) {
      if (at + 46 > end || data.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw new ZipError("a broken central directory");
      const flags = data.readUInt16LE(at + 8);
      const method = data.readUInt16LE(at + 10);
      const compressedSize = data.readUInt32LE(at + 20);
      const entrySize = data.readUInt32LE(at + 24);
      const nameLength = data.readUInt16LE(at + 28);
      const extraLength = data.readUInt16LE(at + 30);
      const commentLength = data.readUInt16LE(at + 32);
      const offset = data.readUInt32LE(at + 42);
      const name = data.toString("utf8", at + 46, at + 46 + nameLength);
      if ((flags & 0x1) === 0) entries.push({ name, method, compressedSize, size: entrySize, offset });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  find(name: string): ZipEntry | undefined {
    return this.entries.find((entry) => entry.name === name);
  }

  /** One entry's bytes, inflated, within the limits; null when it is not there. */
  read(name: string): Buffer | null {
    const entry = this.find(name);
    return entry === undefined ? null : this.readEntry(entry);
  }

  /** One entry as UTF-8 text; null when it is not there. */
  text(name: string): string | null {
    return this.read(name)?.toString("utf8") ?? null;
  }

  readEntry(entry: ZipEntry): Buffer {
    const { maxEntryBytes, maxTotalBytes, maxRatio } = this.limits;
    if (entry.size > maxEntryBytes) throw new ZipError(`${entry.name} inflates to ${entry.size} bytes, over ${maxEntryBytes}`);
    if (this.inflated + entry.size > maxTotalBytes) throw new ZipError(`over ${maxTotalBytes} bytes inflated in all`);
    if (entry.size > 65_536 && entry.size > entry.compressedSize * maxRatio) {
      throw new ZipError(`${entry.name} claims a ${Math.round(entry.size / Math.max(1, entry.compressedSize))}:1 ratio`);
    }
    const data = this.data;
    const at = entry.offset;
    if (at + 30 > data.length || data.readUInt32LE(at) !== LOCAL_SIGNATURE) throw new ZipError(`${entry.name}: no local header`);
    const begin = at + 30 + data.readUInt16LE(at + 26) + data.readUInt16LE(at + 28);
    const stop = begin + entry.compressedSize;
    if (stop > data.length) throw new ZipError(`${entry.name} runs past the archive`);
    const raw = data.subarray(begin, stop);
    let out: Buffer;
    if (entry.method === 0) out = Buffer.from(raw);
    else if (entry.method === 8) {
      try {
        // One byte more than it claims: an entry that lies about its size fails here instead of inflating on.
        out = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size + 1) });
      } catch {
        throw new ZipError(`${entry.name} does not inflate to its stated size`);
      }
    } else throw new ZipError(`${entry.name}: compression method ${entry.method} is not read`);
    if (out.length !== entry.size) throw new ZipError(`${entry.name} is not the size it states`);
    this.inflated += out.length;
    return out;
  }
}
