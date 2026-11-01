/**
 * A hash of what a stored message says, for the database's change number
 * (messages.content_hash, schema 7): the content of its protobuf without the
 * parts that vary between copies of the same message. The same message arrives
 * again with a different messageContextInfo (the sender's device list and
 * secret), a refreshed media link or key, other thumbnails or scan data, and a
 * status, receipts or push name around it; none of that changes what a reader
 * sees. A message's own contextInfo (its quote, mentions) is content, so a
 * quote copy removed after the quoted message was deleted does change it. The
 * envelopes the message view looks through (a device-sent copy, an ephemeral
 * message, a document with caption) are looked through here too, so a wrapped
 * and an unwrapped copy of the same content hash alike. View-once and edit
 * envelopes are not: the view shows the first, and the second is not unwrapped.
 */
import { createHash } from "node:crypto";
import { proto } from "baileys";
import type { ContentHasher } from "./db/index.js";

/** Keys left out wherever they sit: they vary between copies, or are links and keys that expire. */
const VOLATILE = new Set([
  "messageContextInfo",
  "senderKeyDistributionMessage",
  "url",
  "directPath",
  "mediaKey",
  "mediaKeyTimestamp",
  "fileEncSha256",
  "jpegThumbnail",
  "thumbnailDirectPath",
  "thumbnailSha256",
  "thumbnailEncSha256",
  "streamingSidecar",
  "midQualityFileSha256",
  "midQualityFileEncSha256",
  "scansSidecar",
  "scanLengths",
  "firstScanSidecar",
  "firstScanLength",
  "mediaKeyDomain",
]);

/** Envelopes the message view looks through (unwrapEnvelopes in messages.ts): the inner message is the content. */
const ENVELOPES = ["deviceSentMessage", "ephemeralMessage", "documentWithCaptionMessage"] as const;

type Node = Record<string, unknown>;

const unwrapped = (message: Node | null): Node | null => {
  let current = message;
  for (let depth = 0; depth < 5 && current !== null; depth++) {
    const inner = ENVELOPES.map((key) => (current![key] as Node | null | undefined)?.message).find((value): value is Node => value != null);
    if (inner === undefined) break;
    current = inner;
  }
  return current;
};

const stable = (value: unknown, depth: number): unknown => {
  if (depth > 32 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stable(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !VOLATILE.has(key))
      .map(([key, child]) => [key, stable(child, depth + 1)])
  );
};

/** Null when the bytes do not decode. */
export const contentHashOf: ContentHasher = (raw) => {
  try {
    const plain = proto.WebMessageInfo.toObject(proto.WebMessageInfo.decode(raw), { longs: Number, bytes: String }).message ?? null;
    return createHash("sha256").update(JSON.stringify(stable(unwrapped(plain as Node | null), 0))).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
};
