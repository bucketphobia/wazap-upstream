/**
 * A PDF's compressed streams measured before pdf.js or poppler reads them. A
 * stream is stored compressed (Flate, LZW, Brotli, run-length), and a few
 * megabytes can unpack to gigabytes: pdf.js unpacks a font program or a
 * page's content whole, in ArrayBuffers that the document worker's heap
 * limit does not count, and poppler does the same in its own process. Here
 * every stream is unpacked through its filters with a cap and then dropped:
 * one stream past the cap, or all of them past the total, refuses the file
 * before anything else reads it.
 *
 * A stream's dictionary is read forward from its object's "N G obj", as the
 * readers parse it: strings, comments, nested dictionaries and escaped names
 * included. When it cannot be read that way (a dictionary that does not end
 * right before the `stream` keyword, or one built to confuse a reader), the
 * check fails closed: the data is measured as every filter that can expand
 * it. Images are left out when their dictionary reads cleanly: the text read
 * never decodes one, and poppler draws a page's images a line at a time. A
 * stream a crafted file labels as an image, and anything else this check
 * misses, is bounded by the memory watches around the reader and the
 * renderer (src/documents.ts, src/native-run.ts): those are the real bound.
 */
import { brotliDecompressSync, constants, inflateSync } from "node:zlib";

const MB = 1_000_000;

/** What the streams of one PDF may unpack to. */
export const PDF_STREAM_LIMITS = { perStream: 64 * MB, total: 256 * MB };

/** `stream` keywords examined at most; a file with more is refused rather than measured for long. */
const STREAMS_MAX = 100_000;

class TooBig extends Error {}

/** Measuring cost more than any PDF's streams can: the same bytes read again and again by streams that overlap. */
class TooCostly extends Error {}

/**
 * The bytes all streams' bodies may span, as a multiple of the file: each
 * stream's data is its own in a PDF, so an honest file's bodies add up to
 * about its size. Bodies built to overlap would make the check quadratic.
 */
const WORK_PER_BYTE = 4;
const WORK_FLOOR = 16 * MB;

/** What the measuring has read so far, against its allowance. */
class Work {
  private read = 0;

  constructor(private readonly max: number) {}

  add(bytes: number): void {
    this.read += bytes;
    if (this.read > this.max) throw new TooCostly();
  }
}

/** What a stream's dictionary says that matters here; null when it could not be read. */
interface StreamDict {
  /** The filter names in order; null when they are not stated directly (an indirect reference). */
  filters: string[] | null;
  /** An image or an embedded file: never unpacked whole by the readers. */
  skip: boolean;
  /** A direct /Length. */
  length: number | null;
  earlyChange: number;
}

/**
 * Why `pdf` is refused before it is read: a stream that unpacks past
 * `limits.perStream`, or streams past `limits.total` in all. Null for a file
 * whose streams fit. One pass over the file: every search moves forward.
 */
export function pdfBombReason(pdf: Uint8Array, limits = PDF_STREAM_LIMITS): string | null {
  const buf = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  const keywords = { stream: new Cursor(buf, "stream"), endstream: new Cursor(buf, "endstream"), lf: new Cursor(buf, "\n"), cr: new Cursor(buf, "\r") };
  const objects = new Objects(buf);
  const work = new Work(Math.max(WORK_FLOOR, buf.length * WORK_PER_BYTE));
  let total = 0;
  let streams = 0;
  for (let at = 0; ; ) {
    const found = keywords.stream.next(at);
    if (found < 0) return null;
    at = found + 6;
    // A keyword stands alone: "endstream", "streams" or "xstream" are other words.
    if (!isKeywordAt(buf, found, 6)) continue;
    if (++streams > STREAMS_MAX) return `it has more than ${STREAMS_MAX.toLocaleString("en-US")} streams, more than is checked here`;
    // The data starts after the keyword's line, however long, as both readers skip to it.
    const lf = keywords.lf.next(at);
    const cr = keywords.cr.next(at);
    const eol = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
    if (eol < 0) return null;
    const start = buf[eol] === 0x0d && buf[eol + 1] === 0x0a ? eol + 2 : eol + 1;
    const dict = objects.dictBefore(found);
    if (dict?.skip === true) continue;
    const room = Math.min(limits.perStream, limits.total - total);
    // The readers decode a stream's body only: up to its /Length when "endstream" follows there, else to the next "endstream".
    const body = buf.subarray(start, bodyEnd(buf, start, dict?.length ?? null, keywords.endstream));
    try {
      work.add(body.length);
      total += dict === null ? unknownSize(body, room) : unpackedSize(body, dict.filters, dict.earlyChange, room);
    } catch (err) {
      if (err instanceof TooCostly) return "its streams overlap one another as no PDF's do, so it is not read here";
      if (!(err instanceof TooBig)) throw err;
      return room < limits.perStream
        ? `its streams unpack to more than ${limits.total / MB} MB in all (a compression bomb)`
        : `a stream in it unpacks to more than ${limits.perStream / MB} MB (a compression bomb)`;
    }
  }
}

/** The next place a byte string occurs at or after a point, for searches that only move forward: each costs one pass over the file in all. */
class Cursor {
  private found = -2;

  constructor(
    private readonly buf: Buffer,
    private readonly needle: string
  ) {}

  next(from: number): number {
    if (this.found === -1) return -1;
    if (this.found < from) this.found = this.buf.indexOf(this.needle, from, "latin1");
    return this.found;
  }
}

function isWhite(byte: number | undefined): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c || byte === 0x00;
}

/** ( ) < > [ ] { } / % */
function isDelimiter(byte: number | undefined): boolean {
  return byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e || byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d || byte === 0x2f || byte === 0x25;
}

function isRegular(byte: number | undefined): boolean {
  return byte !== undefined && !isWhite(byte) && !isDelimiter(byte);
}

/** Whether the `size` bytes at `at` are a token of their own: not inside a longer word. */
function isKeywordAt(buf: Buffer, at: number, size: number): boolean {
  return (at === 0 || !isRegular(buf[at - 1])) && !isRegular(buf[at + size]);
}

/**
 * The objects of a file, met in order: the last "N G obj" before a `stream`
 * keyword opens the dictionary that keyword belongs to, read forward from
 * there once.
 */
class Objects {
  private readonly cursor: Cursor;
  private scanned = 0;
  private last = -1;
  private parsedFor = -1;
  private parsed: { end: number; dict: StreamDict } | null = null;

  constructor(private readonly buf: Buffer) {
    this.cursor = new Cursor(buf, "obj");
  }

  /** The dictionary that ends right before the `stream` keyword at `keyword`, or null. */
  dictBefore(keyword: number): StreamDict | null {
    for (;;) {
      const next = this.cursor.next(this.scanned);
      if (next < 0 || next >= keyword) break;
      this.scanned = next + 3;
      if (isKeywordAt(this.buf, next, 3) && isObjectHeader(this.buf, next)) this.last = next + 3;
    }
    if (this.last < 0) return null;
    if (this.parsedFor !== this.last) {
      this.parsedFor = this.last;
      this.parsed = readStreamDict(this.buf, this.last, keyword);
    }
    return this.parsed !== null && this.parsed.end === keyword ? this.parsed.dict : null;
  }
}

/** Whether "obj" at `at` follows an object number and generation: "12 0 obj". */
function isObjectHeader(buf: Buffer, at: number): boolean {
  let i = at - 1;
  const digits = (): boolean => {
    const end = i;
    while (i >= 0 && buf[i]! >= 0x30 && buf[i]! <= 0x39) i--;
    return i < end;
  };
  const space = (): boolean => {
    const end = i;
    while (i >= 0 && isWhite(buf[i])) i--;
    return i < end;
  };
  return space() && digits() && space() && digits() && (i < 0 || !isRegular(buf[i]));
}

/** Nesting a dictionary may have before it is taken for hostile. */
const DEPTH_MAX = 32;

/**
 * The dictionary after `from` (an "obj" keyword's end), read forward with
 * strict PDF syntax, and where the whitespace and comments after it end;
 * null when no dictionary can be read there before `limit`.
 */
function readStreamDict(buf: Buffer, from: number, limit: number): { end: number; dict: StreamDict } | null {
  const open = skipSpace(buf, from, limit);
  if (buf[open] !== 0x3c || buf[open + 1] !== 0x3c) return null;
  const entries = new Map<string, [number, number]>();
  const close = skipDict(buf, open, limit, 0, entries);
  if (close < 0) return null;
  const value = (key: string): string | undefined => {
    const span = entries.get(key);
    return span === undefined ? undefined : buf.toString("latin1", span[0], span[1]);
  };
  const filter = value("Filter") ?? value("F");
  let filters: string[] | null = [];
  if (filter !== undefined) filters = /^\s*(\/|\[)/.test(filter) && !/\bR\b/.test(filter) ? [...filter.matchAll(/\/([^\s/[\]<>()%{}]*)/g)].map((m) => decodeName(m[1]!)) : null;
  const name = (key: string): string | null => {
    const raw = value(key);
    return raw !== undefined && raw.startsWith("/") ? decodeName(raw.slice(1)) : null;
  };
  const length = value("Length");
  return {
    end: skipSpace(buf, close, limit),
    dict: {
      filters,
      skip: name("Subtype") === "Image" || name("Type") === "EmbeddedFile",
      length: length !== undefined && /^\d+$/.test(length) ? Number(length) : null,
      earlyChange: /\/EarlyChange\s+0\b/.test(value("DecodeParms") ?? value("DP") ?? "") ? 0 : 1,
    },
  };
}

/** A name with its #xx escapes decoded, as the readers decode it: /Fl#61teDecode is /FlateDecode. */
function decodeName(raw: string): string {
  return raw.replace(/#([0-9a-fA-F]{2})/g, (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Past whitespace and comments. */
function skipSpace(buf: Buffer, at: number, limit: number): number {
  let i = at;
  while (i < limit) {
    const byte = buf[i];
    if (isWhite(byte)) i++;
    else if (byte === 0x25) {
      while (i < limit && buf[i] !== 0x0a && buf[i] !== 0x0d) i++;
    } else break;
  }
  return i;
}

/** The end of the dictionary opening at `at`, its top-level values' spans in `entries` (the last of a key wins, as in the readers); -1 when it is not one. */
function skipDict(buf: Buffer, at: number, limit: number, depth: number, entries: Map<string, [number, number]> | null): number {
  let i = at + 2;
  for (;;) {
    i = skipSpace(buf, i, limit);
    if (i + 1 >= limit) return -1;
    if (buf[i] === 0x3e && buf[i + 1] === 0x3e) return i + 2;
    if (buf[i] !== 0x2f) return -1;
    let k = i + 1;
    while (k < limit && isRegular(buf[k])) k++;
    const key = decodeName(buf.toString("latin1", i + 1, k));
    const start = skipSpace(buf, k, limit);
    const end = skipObject(buf, start, limit, depth + 1);
    if (end < 0) return -1;
    entries?.set(key, [start, end]);
    i = end;
  }
}

/** The end of the object at `at` (a reference "5 0 R" counts as one); -1 when none can be read there before `limit`. */
function skipObject(buf: Buffer, at: number, limit: number, depth: number): number {
  if (at >= limit || depth > DEPTH_MAX) return -1;
  const byte = buf[at];
  if (byte === 0x3c && buf[at + 1] === 0x3c) return skipDict(buf, at, limit, depth, null);
  if (byte === 0x3c) {
    for (let i = at + 1; i < limit; i++) {
      if (buf[i] === 0x3e) return i + 1;
      if (!isWhite(buf[i]) && !/[0-9a-fA-F]/.test(String.fromCharCode(buf[i]!))) return -1;
    }
    return -1;
  }
  if (byte === 0x28) {
    let nesting = 0;
    for (let i = at; i < limit; i++) {
      if (buf[i] === 0x5c) i++;
      else if (buf[i] === 0x28) nesting++;
      else if (buf[i] === 0x29 && --nesting === 0) return i + 1;
    }
    return -1;
  }
  if (byte === 0x5b) {
    let i = at + 1;
    for (;;) {
      i = skipSpace(buf, i, limit);
      if (i >= limit) return -1;
      if (buf[i] === 0x5d) return i + 1;
      i = skipObject(buf, i, limit, depth + 1);
      if (i < 0) return -1;
    }
  }
  if (byte === 0x2f) {
    let i = at + 1;
    while (i < limit && isRegular(buf[i])) i++;
    return i;
  }
  const word = (from: number): [string, number] => {
    let i = from;
    while (i < limit && isRegular(buf[i])) i++;
    return [buf.toString("latin1", from, i), i];
  };
  const [first, end] = word(at);
  if (first === "true" || first === "false" || first === "null") return end;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(first)) return -1;
  // An integer may open a reference: "5 0 R".
  if (/^\d+$/.test(first)) {
    const [generation, afterGeneration] = word(skipSpace(buf, end, limit));
    if (/^\d+$/.test(generation)) {
      const [r, afterR] = word(skipSpace(buf, afterGeneration, limit));
      if (r === "R") return afterR;
    }
  }
  return end;
}

/** Where a stream's data ends: at its direct /Length when "endstream" follows there, else at the next "endstream". */
function bodyEnd(buf: Buffer, start: number, length: number | null, endstream: Cursor): number {
  if (length !== null) {
    const end = start + length;
    let after = end;
    while (after < buf.length && isWhite(buf[after])) after++;
    if (end <= buf.length && buf.toString("latin1", after, after + 9) === "endstream") return end;
  }
  const marker = endstream.next(start);
  return marker < 0 ? buf.length : marker;
}

/**
 * What a stream's body unpacks to through `filters`, every stage counted
 * (pdf.js keeps each stage's output whole), within `room` bytes. Throws
 * TooBig past `room`.
 */
function unpackedSize(body: Uint8Array, filters: string[] | null, earlyChange: number, room: number): number {
  // Whatever the dictionary says (or seems to), data that inflates is measured as Flate.
  const chain = filters === null || filters.length === 0 ? ["FlateDecode"] : filters;
  let input = body;
  let used = 0;
  for (const filter of chain) {
    const output = decodeOne(filter, input, earlyChange, room - used);
    if (output === null) break;
    used += output.length;
    input = output;
  }
  return used;
}

/** An LZW or run-length guess counts as a bomb only when it unpacks this many times its input: random data unpacks a few times. */
const GUESS_RATIO = 50;

/**
 * A stream whose dictionary could not be read, measured as each filter that
 * can expand data on its own. Flate and Brotli have formats of their own and
 * count toward the total; any bytes decode as LZW or run-length, so those
 * guesses never count, and refuse the file only past the room at a ratio no
 * honest data reaches.
 */
function unknownSize(body: Uint8Array, room: number): number {
  let used = 0;
  for (const filter of ["FlateDecode", "BrotliDecode"]) used = Math.max(used, decodeOne(filter, body, 1, room)!.length);
  for (const filter of ["LZWDecode", "RunLengthDecode"]) {
    try {
      decodeOne(filter, body, 1, room);
    } catch (err) {
      if (!(err instanceof TooBig) || body.length * GUESS_RATIO >= room) continue;
      throw err;
    }
  }
  return used;
}

/** One filter's output within `left` bytes (TooBig past it); null for a filter nothing here unpacks. */
function decodeOne(filter: string, input: Uint8Array, earlyChange: number, left: number): Uint8Array | null {
  let output: Uint8Array;
  switch (filter) {
    case "FlateDecode":
    case "Fl":
      // The readers refuse Flate data without a zlib header: so does this, before any zlib handle is made.
      output = zlibHeader(input) ? guarded(() => inflateSync(input, { maxOutputLength: left + 1, finishFlush: constants.Z_SYNC_FLUSH })) : new Uint8Array(0);
      break;
    case "BrotliDecode":
      output = guarded(() => brotliDecompressSync(input, { maxOutputLength: left + 1, finishFlush: constants.BROTLI_OPERATION_FLUSH }));
      break;
    case "LZWDecode":
    case "LZW":
      output = lzwDecode(input, earlyChange, left);
      break;
    case "RunLengthDecode":
    case "RL":
      output = runLengthDecode(input, left);
      break;
    case "ASCII85Decode":
    case "A85":
      output = ascii85Decode(input, left);
      break;
    case "ASCIIHexDecode":
    case "AHx":
      output = asciiHexDecode(input, left);
      break;
    default:
      // An image codec, encryption or a name the readers do not know: nothing here unpacks further.
      return null;
  }
  if (output.length > left) throw new TooBig();
  return output;
}

/** A zlib header as pdf.js and poppler require it: deflate, a valid check, no preset dictionary. */
function zlibHeader(input: Uint8Array): boolean {
  const cmf = input[0];
  const flg = input[1];
  return cmf !== undefined && flg !== undefined && (cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0 && (flg & 0x20) === 0;
}

/** A zlib or Brotli decode: past its cap is TooBig; data that is not of that format unpacks to nothing here. */
function guarded(decode: () => Buffer): Uint8Array {
  try {
    return decode();
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) throw new TooBig();
    return new Uint8Array(0);
  }
}

/** A growable output that refuses to pass `cap`. */
class Output {
  bytes: Uint8Array;
  length = 0;

  constructor(
    private readonly cap: number,
    hint: number
  ) {
    this.bytes = new Uint8Array(Math.max(1, Math.min(cap, hint)));
  }

  reserve(n: number): void {
    if (this.length + n > this.cap) throw new TooBig();
    if (this.length + n <= this.bytes.length) return;
    const grown = new Uint8Array(Math.min(this.cap, Math.max(this.bytes.length * 2, this.length + n)));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  done(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }
}

/**
 * LZW as PDF writes it (9 to 12-bit codes, 256 clears, 257 ends), the way
 * pdf.js reads it, within `cap`: a code past the table repeats the last
 * sequence with its first byte added, so a run of such codes grows each
 * output by one, which pdf.js unpacks too.
 */
export function lzwDecode(input: Uint8Array, earlyChange: number, cap: number): Uint8Array {
  const size = 4096;
  const values = new Uint8Array(size);
  const lengths = new Uint16Array(size).fill(1, 0, 256);
  const previous = new Uint16Array(size);
  const current = new Uint8Array(size);
  for (let i = 0; i < 256; i++) values[i] = i;
  const out = new Output(cap, input.length * 4 + 1024);
  let currentLength = 0;
  let nextCode = 258;
  let codeLength = 9;
  let prevCode = 0;
  let bits = 0;
  let bitCount = 0;
  let pos = 0;
  for (;;) {
    while (bitCount < codeLength) {
      if (pos >= input.length) return out.done();
      bits = ((bits << 8) | input[pos++]!) & 0xffffff;
      bitCount += 8;
    }
    const code = (bits >>> (bitCount - codeLength)) & ((1 << codeLength) - 1);
    bitCount -= codeLength;
    const hasPrevious = currentLength > 0;
    if (code < 256) {
      current[0] = code;
      currentLength = 1;
    } else if (code >= 258) {
      if (code < nextCode) {
        currentLength = lengths[code]!;
        for (let j = currentLength - 1, q = code; j >= 0; j--) {
          if (j < size) current[j] = values[q]!;
          q = previous[q]!;
        }
      } else {
        if (currentLength < size) current[currentLength] = current[0]!;
        currentLength++;
      }
    } else if (code === 256) {
      codeLength = 9;
      nextCode = 258;
      currentLength = 0;
      continue;
    } else {
      return out.done();
    }
    if (hasPrevious) {
      if (nextCode < size) {
        previous[nextCode] = prevCode;
        lengths[nextCode] = lengths[prevCode]! + 1;
        values[nextCode] = current[0]!;
      }
      nextCode++;
      const reach = nextCode + earlyChange;
      if ((reach & (reach - 1)) === 0) codeLength = Math.min(Math.floor(Math.log2(reach)) + 1, 12);
    }
    prevCode = code;
    out.reserve(currentLength);
    // Past the table's 4,096 bytes pdf.js writes zeros, as a typed array reads past its end.
    const shown = Math.min(currentLength, size);
    out.bytes.set(current.subarray(0, shown), out.length);
    out.bytes.fill(0, out.length + shown, out.length + currentLength);
    out.length += currentLength;
  }
}

/** Run-length data (a count, then bytes or one byte repeated; 128 ends), within `cap`. */
function runLengthDecode(input: Uint8Array, cap: number): Uint8Array {
  const out = new Output(cap, input.length * 2 + 1024);
  let pos = 0;
  while (pos < input.length) {
    const n = input[pos++]!;
    if (n === 128) break;
    if (n < 128) {
      const count = Math.min(n + 1, input.length - pos);
      out.reserve(count);
      out.bytes.set(input.subarray(pos, pos + count), out.length);
      out.length += count;
      pos += count;
    } else {
      if (pos >= input.length) break;
      const count = 257 - n;
      out.reserve(count);
      out.bytes.fill(input[pos++]!, out.length, out.length + count);
      out.length += count;
    }
  }
  return out.done();
}

/** ASCII85 to its end mark `~>`, within `cap` ("z" alone is four zero bytes). */
function ascii85Decode(input: Uint8Array, cap: number): Uint8Array {
  const out = new Output(cap, input.length);
  const group: number[] = [];
  const flush = (count: number): void => {
    let value = 0;
    for (let i = 0; i < 5; i++) value = value * 85 + (group[i] ?? 84);
    out.reserve(count);
    for (let i = 0; i < count; i++) out.bytes[out.length++] = (value >>> (24 - 8 * i)) & 0xff;
  };
  for (let pos = 0; pos < input.length; pos++) {
    const byte = input[pos]!;
    if (byte === 0x7e) break;
    if (byte === 0x7a && group.length === 0) {
      out.reserve(4);
      out.bytes.fill(0, out.length, out.length + 4);
      out.length += 4;
      continue;
    }
    if (byte < 0x21 || byte > 0x75) continue;
    group.push(byte - 0x21);
    if (group.length === 5) {
      flush(4);
      group.length = 0;
    }
  }
  if (group.length > 1) flush(group.length - 1);
  return out.done();
}

/** Hex digits to their end mark `>`, within `cap`. */
function asciiHexDecode(input: Uint8Array, cap: number): Uint8Array {
  const out = new Output(cap, input.length / 2 + 1);
  let high = -1;
  for (let pos = 0; pos < input.length; pos++) {
    const byte = input[pos]!;
    if (byte === 0x3e) break;
    const digit = byte >= 0x30 && byte <= 0x39 ? byte - 0x30 : byte >= 0x41 && byte <= 0x46 ? byte - 55 : byte >= 0x61 && byte <= 0x66 ? byte - 87 : -1;
    if (digit < 0) continue;
    if (high < 0) high = digit;
    else {
      out.reserve(1);
      out.bytes[out.length++] = (high << 4) | digit;
      high = -1;
    }
  }
  if (high >= 0) {
    out.reserve(1);
    out.bytes[out.length++] = high << 4;
  }
  return out.done();
}
