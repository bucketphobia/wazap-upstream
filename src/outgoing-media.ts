/**
 * What goes out as media: reading a file or a URL into a buffer, the size
 * cap, the mime guess, the GIF conversion, and the Baileys content for each
 * kind. Nothing here touches the socket or the store.
 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { AnyMessageContent } from "baileys";
import { WazapError } from "./errors.js";
import { gifToMp4 } from "./gif.js";
import { publicMedia, type MediaNetwork } from "./safe-media.js";
import type { MediaSource } from "./wa-types.js";

const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const PROFILE_PICTURE_MAX_BYTES = 10 * 1024 * 1024;
const PROFILE_PICTURE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function mediaFilename(info: { mime: string; filename?: string }): string {
  const original = (info.filename ?? "").replace(/[^\w.-]/g, "_");
  const fromName = original.includes(".") ? original.slice(original.lastIndexOf(".") + 1) : "";
  const subtype = info.mime.split("/")[1]?.split(";")[0] ?? "bin";
  // Both filename and MIME came from a message, not from a trusted filesystem.
  // A MIME subtype containing backslashes is a path on Windows; cap it too.
  const extension = [fromName, subtype].find((value) => /^[a-z0-9]{1,16}$/i.test(value)) ?? "bin";
  return `${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
}

export interface LoadedMedia {
  buffer: Buffer;
  mimetype: string;
  filename: string;
  /** A URL's file: the URL its bytes came from, after any redirect. */
  url?: string;
}

export async function assertMediaSource(source: MediaSource, maxBytes = MAX_MEDIA_BYTES): Promise<void> {
  const given = [Boolean(source.file_path), Boolean(source.url), source.inline !== undefined].filter(Boolean).length;
  if (given !== 1) {
    throw new WazapError("FILE_NOT_FOUND", "Provide exactly one of file_path, url or data_base64.", "Give the file exactly one way, of those the tool lists");
  }
  if (source.inline !== undefined) {
    assertMediaSize(source.inline.bytes.length, maxBytes);
    return;
  }
  if (!source.file_path) return;
  let size: number;
  try {
    size = (await stat(source.file_path)).size;
  } catch {
    throw new WazapError("FILE_NOT_FOUND", `No file at "${source.file_path}" on the machine running wazap.`);
  }
  assertMediaSize(size, maxBytes);
}

export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function loadMedia(
  source: MediaSource,
  maxBytes = MAX_MEDIA_BYTES,
  io: Partial<MediaNetwork> = {}
): Promise<LoadedMedia> {
  await assertMediaSource(source, maxBytes);
  if (source.file_path) {
    const path = source.file_path;
    return { buffer: await readFile(path), mimetype: guessMime(path), filename: basename(path) };
  }
  if (source.inline !== undefined) {
    const { bytes, filename, mime } = source.inline;
    const mimetype = sniffMime(bytes, mime ?? null, filename);
    return { buffer: bytes, mimetype, filename: safeFilename(filename, mimetype) };
  }

  const result = await publicMedia(source.url!, { maxBytes, ...io });
  const named = result.filename ?? urlFilename(result.url);
  const mimetype = sniffMime(result.buffer, result.mime, named);
  return { buffer: result.buffer, mimetype, filename: safeFilename(named, mimetype), url: result.url };
}

/** The last segment of a URL's path, decoded: what a browser would save it as. */
function urlFilename(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last);
  } catch {
    return basename(url.split("?")[0] ?? url);
  }
}

/**
 * A name a recipient's phone can save: no path, no control characters, at
 * most 120 characters, and the extension the type has when the name has none.
 */
export function safeFilename(name: string, mime: string): string {
  // eslint-disable-next-line no-control-regex
  let clean = (name.split(/[/\\]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (clean === "" || clean === "." || clean === "..") clean = "file";
  const ext = EXTENSION_BY_MIME[mime];
  if (ext !== undefined && !/\.[a-z0-9]{1,8}$/i.test(clean)) clean = `${clean}.${ext}`;
  if (clean.length > 120) {
    const dot = clean.lastIndexOf(".");
    const tail = dot > 0 && clean.length - dot <= 9 ? clean.slice(dot) : "";
    clean = `${clean.slice(0, 120 - tail.length)}${tail}`;
  }
  return clean;
}

/**
 * What a file is, by its first bytes when they say it, else by the type it was
 * declared with (a server's Content-Type, an agent's mime), else by its name.
 * A ZIP is an Office or OpenDocument file when its name says so, or, for a
 * name without a type, when its declared type is one built on ZIP.
 */
export function sniffMime(buffer: Buffer, declared: string | null, filename: string): string {
  const byName = guessMime(filename);
  const magic = magicMime(buffer);
  const given = declared?.split(";")[0]?.trim().toLowerCase() ?? "";
  const stated = /^[a-z]+\/[a-z0-9.+-]+$/.test(given) && given !== "application/octet-stream" ? given : null;
  if (magic === "application/zip") return byName !== "application/octet-stream" ? byName : stated !== null && zipBased(stated) ? stated : magic;
  if (magic !== null) return magic;
  // An MP3 without its ID3 tag starts with a frame header, which is only a few bits a text or binary file can start
  // with too: it names the file only when neither its declared type nor its name says it is something else.
  if (mpegFrame(buffer) && [stated, byName].every((named) => named === null || named === "application/octet-stream" || named.startsWith("audio/"))) {
    return "audio/mpeg";
  }
  return stated ?? byName;
}

/**
 * Whether `b` starts with a valid MPEG audio frame header: the sync bits, a
 * version and a layer that exist (Layer II or III, which is what MP3 and MP2
 * files are; Layer I's bits are those of a UTF-16 byte-order mark, FF FE), a
 * bitrate that is neither free nor invalid, and a sample rate that exists.
 */
function mpegFrame(b: Buffer): boolean {
  if (b.length < 4 || b[0] !== 0xff || (b[1]! & 0xe0) !== 0xe0) return false;
  const version = (b[1]! >> 3) & 0x03;
  const layer = (b[1]! >> 1) & 0x03;
  const bitrate = b[2]! >> 4;
  const sampleRate = (b[2]! >> 2) & 0x03;
  return version !== 0x01 && (layer === 0x01 || layer === 0x02) && bitrate !== 0x00 && bitrate !== 0x0f && sampleRate !== 0x03;
}

/** Types whose files are ZIP archives: Office's, OpenDocument's, macro-enabled Office, and any `+zip`. */
function zipBased(type: string): boolean {
  return (
    /^application\/(vnd\.openxmlformats-officedocument\.|vnd\.oasis\.opendocument\.|vnd\.ms-[a-z]+\.[a-z.]*macroenabled\.12$)/.test(type) ||
    type.endsWith("+zip") ||
    ["application/zip", "application/java-archive", "application/vnd.android.package-archive", "application/vnd.google-earth.kmz"].includes(type)
  );
}

/** HEIF brands of a still image or a sequence of them (a HEIC photo, a burst), as an ISO media file names them. */
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1", "mif2"]);

/** ISO media brands that say what the file is; a brand not here says nothing of it. */
const ISO_BRANDS: Record<string, string> = {
  "qt  ": "video/quicktime",
  "M4A ": "audio/mp4",
  "M4B ": "audio/mp4",
  "M4P ": "audio/mp4",
  "F4A ": "audio/mp4",
  "F4B ": "audio/mp4",
  "crx ": "image/x-canon-cr3",
  isom: "video/mp4",
  iso2: "video/mp4",
  iso3: "video/mp4",
  iso4: "video/mp4",
  iso5: "video/mp4",
  iso6: "video/mp4",
  mp41: "video/mp4",
  mp42: "video/mp4",
  mp71: "video/mp4",
  avc1: "video/mp4",
  dash: "video/mp4",
  mmp4: "video/mp4",
  "M4V ": "video/mp4",
  M4VH: "video/mp4",
  M4VP: "video/mp4",
  MSNV: "video/mp4",
  XAVC: "video/mp4",
  "f4v ": "video/mp4",
};

/**
 * An ISO media file (MP4 and its family: MOV, M4A, HEIC, AVIF, 3GP) by its
 * brands, the major one and then those it is compatible with: an AVIF or HEIF
 * image by any of them, else the first that says what it is. None that does
 * is null: the declared type or the name says it, or it goes as a document.
 */
function isoMediaMime(b: Buffer): string | null {
  const boxEnd = Math.min(b.length, Math.max(16, b.readUInt32BE(0)), 4096);
  const brands = [b.subarray(8, 12).toString("latin1")];
  for (let at = 16; at + 4 <= boxEnd; at += 4) brands.push(b.subarray(at, at + 4).toString("latin1"));
  if (brands.some((brand) => brand === "avif" || brand === "avis")) return "image/avif";
  if (brands.some((brand) => HEIF_BRANDS.has(brand))) return "image/heic";
  for (const brand of brands) {
    if (ISO_BRANDS[brand] !== undefined) return ISO_BRANDS[brand]!;
    if (brand.startsWith("3gp")) return "video/3gpp";
    if (brand.startsWith("3g2")) return "video/3gpp2";
  }
  return null;
}

function magicMime(b: Buffer): string | null {
  const ascii = (from: number, to: number): string => b.subarray(from, to).toString("latin1");
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF") {
    const kind = ascii(8, 12);
    if (kind === "WEBP") return "image/webp";
    if (kind === "WAVE") return "audio/wav";
    if (kind === "AVI ") return "video/x-msvideo";
  }
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 3) === "ID3") return "audio/mpeg";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (b.length >= 12 && ascii(4, 8) === "ftyp") return isoMediaMime(b);
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "application/zip";
  return null;
}

/** JPEG, PNG or WebP, capped at 10 MB before Baileys sees the buffer. */
export async function loadProfilePicture(source: MediaSource, io: Partial<MediaNetwork> = {}): Promise<LoadedMedia> {
  const media = await loadMedia(source, PROFILE_PICTURE_MAX_BYTES, io);
  if (!PROFILE_PICTURE_MIMES.has(media.mimetype)) {
    throw new WazapError(
      "INVALID_IMAGE",
      `A profile picture must be a JPEG, PNG or WebP, not ${media.mimetype}.`,
      "Pass a JPEG, PNG or WebP image instead"
    );
  }
  return media;
}

function assertMediaSize(size: number, maxBytes: number): void {
  if (size <= maxBytes) return;
  throw new WazapError(
    "FILE_TOO_LARGE",
    `The file is ${Math.round(size / 1_048_576)} MB; the limit is ${Math.round(maxBytes / 1_048_576)} MB.`
  );
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || "file";
}

/** With `asGif`, a .gif becomes the mp4 WhatsApp loops; an mp4 is already that. Anything else is refused. */
export async function asGifMedia(media: LoadedMedia, asGif: boolean): Promise<LoadedMedia> {
  if (!asGif) return media;
  if (media.mimetype === "image/gif") {
    const buffer = await gifToMp4(media.buffer);
    return { buffer, mimetype: "video/mp4", filename: media.filename.replace(/\.gif$/i, "") + ".mp4" };
  }
  if (media.mimetype.startsWith("video/")) return media;
  throw new WazapError(
    "MEDIA_UNAVAILABLE",
    `as: "gif" needs a .gif or a video, not ${media.mimetype}.`,
    'Pass a .gif or an mp4, or leave out as: "gif"'
  );
}

/** Whether WhatsApp shows a caption on media sent this way: never on a voice note, nor on a plain audio file. */
export function captionTravels(mime: string, opts: { asDocument: boolean; asVoice: boolean; asGif: boolean }): boolean {
  if (opts.asVoice) return false;
  return opts.asGif || opts.asDocument || nativeKind(mime) !== "audio";
}

/**
 * The types WhatsApp's own viewer and players take. Baileys labels every
 * image it sends image/jpeg and every video video/mp4, so a HEIC photo, a
 * WebM, MKV or AVI video or a WAV recording sent as one would not open on the
 * recipient's phone: those, and any other type, go as a document.
 */
const NATIVE_IMAGES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const NATIVE_VIDEOS = new Set(["video/mp4", "video/quicktime", "video/3gpp"]);
const NATIVE_AUDIO = new Set(["audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/amr", "audio/ogg", "audio/opus"]);

/** What a file of this type is sent as, without `as`. */
export function nativeKind(mime: string): "image" | "video" | "audio" | "document" {
  const type = mime.split(";")[0]!.trim().toLowerCase();
  if (NATIVE_IMAGES.has(type)) return "image";
  if (NATIVE_VIDEOS.has(type)) return "video";
  if (NATIVE_AUDIO.has(type)) return "audio";
  return "document";
}

/** The MIME a draft's file or URL names by its extension, before anything is read; a URL without one names none. */
export function mimeOfSource(source: MediaSource): string {
  if (source.file_path) return guessMime(source.file_path);
  if (source.inline !== undefined) return sniffMime(source.inline.bytes, source.inline.mime ?? null, source.inline.filename);
  if (!source.url) return "application/octet-stream";
  try {
    return guessMime(new URL(source.url).pathname);
  } catch {
    return "application/octet-stream";
  }
}

export function mediaContent(
  media: LoadedMedia,
  opts: { caption?: string; asDocument: boolean; asVoice: boolean; asGif: boolean }
): AnyMessageContent {
  const { buffer, mimetype, filename } = media;
  if (opts.asVoice) return { audio: buffer, mimetype: "audio/ogg; codecs=opus", ptt: true };
  if (opts.asGif) return { video: buffer, gifPlayback: true, caption: opts.caption };
  if (opts.asDocument) return { document: buffer, mimetype, fileName: filename, caption: opts.caption };
  const kind = nativeKind(mimetype);
  if (kind === "image") return { image: buffer, caption: opts.caption };
  if (kind === "video") return { video: buffer, caption: opts.caption };
  if (kind === "audio") return { audio: buffer, mimetype };
  return { document: buffer, mimetype, fileName: filename, caption: opts.caption };
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
  webm: "video/webm",
  wav: "audio/wav",
  heic: "image/heic",
  avif: "image/avif",
  json: "application/json",
  md: "text/markdown",
  html: "text/html",
  ics: "text/calendar",
  vcf: "text/vcard",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};

/** The extension a type is saved under, for a name that has none. */
const EXTENSION_BY_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_BY_EXTENSION)
    .filter(([ext]) => !["jpeg", "opus"].includes(ext))
    .map(([ext, mime]) => [mime, ext])
);

function guessMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}
