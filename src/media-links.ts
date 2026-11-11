/**
 * Signed download links: get_media's fallback for the original file, when the
 * server has a public URL and the session is remote. Hosted chat clients
 * refuse to fetch a URL that came from a tool result, so a link is mostly for
 * the person (a tap in the chat opens the file) and for agents with open
 * network access (Cursor's cloud agents, local CLIs); the view and the text
 * are the baseline.
 *
 * A link is a capability: HMAC-SHA256, under a secret made once per install
 * and kept 0600 in the data dir, over the account, the message's row and a
 * tag of its id (never the id, which spells the chat's phone number), and
 * an expiry 30 minutes out. It is checked in constant time, and the message is
 * looked up again at every fetch: deleted, expired or cleared is a 404, the
 * same answer as a forged or stale link. The file goes out as an attachment
 * that no browser renders on this origin (the OAuth consent page's).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Response } from "express";
import type { AccountSource } from "./account-hub.js";
import { asWazapError } from "./errors.js";
import { log } from "./logger.js";
import type { WhatsAppApi } from "./wa-types.js";

/** How long a link opens the file. */
export const MEDIA_LINK_TTL_MS = 30 * 60 * 1000;
/** Where links are served on the HTTP listener. */
export const MEDIA_LINK_ROUTE = "/media/:token";
/** The secret's file in the data dir. */
export const MEDIA_LINK_KEY_FILE = "media-links.key";

const DOMAIN = "wazap-media-link:v1:";
const TOKEN_MAX = 512;

/** What a link names: an account, a message's row in its database and a tag of the message's id, until `expires` (ms). */
export interface LinkClaim {
  account: string;
  row: number;
  tag: string;
  expires: number;
}

/** A short tag of a message id: enough to tell a reused row from the message the link was made for. */
export function sidTag(sid: string): string {
  return createHash("sha256").update(sid).digest().subarray(0, 9).toString("base64url");
}

export class MediaLinks {
  constructor(
    private readonly secret: Buffer,
    /** The server's public origin, as WAZAP_PUBLIC_URL gives it, no trailing slash. */
    readonly publicUrl: string,
    private readonly now: () => number = Date.now
  ) {}

  private sign(payload: string): Buffer {
    return createHmac("sha256", this.secret).update(DOMAIN + payload).digest();
  }

  mint(claim: Omit<LinkClaim, "expires">): { url: string; expires_at: string } {
    const expires = this.now() + MEDIA_LINK_TTL_MS;
    const payload = Buffer.from(JSON.stringify({ a: claim.account, r: claim.row, t: claim.tag, e: Math.ceil(expires / 1000) })).toString("base64url");
    const token = `${payload}.${this.sign(payload).toString("base64url")}`;
    return { url: `${this.publicUrl}/media/${token}`, expires_at: new Date(expires).toISOString() };
  }

  /** The claim of a link that this install signed and that has not expired; null for anything else. */
  verify(token: string): LinkClaim | null {
    if (token.length > TOKEN_MAX) return null;
    const [payload, signature, extra] = token.split(".");
    if (payload === undefined || signature === undefined || extra !== undefined) return null;
    const given = Buffer.from(signature, "base64url");
    const expected = this.sign(payload);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    const { a, r, t, e } = (parsed ?? {}) as Record<string, unknown>;
    if (typeof a !== "string" || typeof r !== "number" || !Number.isSafeInteger(r) || typeof t !== "string" || typeof e !== "number") return null;
    if (e * 1000 <= this.now()) return null;
    return { account: a, row: r, tag: t, expires: e * 1000 };
  }
}

/**
 * The install's link secret: 32 random bytes made the first time and kept in
 * the data dir, readable only by its owner. Never logged, never in an answer.
 * It is written whole to a temporary file and renamed into place, so a crash
 * or a full disk never leaves a short key behind; a short or empty one found
 * there (from before) is replaced the same way.
 */
export function linkSecret(dataDir: string): Buffer {
  const file = join(dataDir, MEDIA_LINK_KEY_FILE);
  const read = (): Buffer | null => {
    try {
      const stored = readFileSync(file);
      return stored.length >= 32 ? stored.subarray(0, 32) : null;
    } catch {
      return null;
    }
  };
  const existing = read();
  if (existing !== null) return existing;
  const secret = randomBytes(32);
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, secret, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } catch {
    rmSync(temporary, { force: true });
    throw new Error("The media link secret could not be written to the data dir.");
  }
  // What is on disk now is what later runs will read: that is the secret.
  return read() ?? secret;
}

const cached = new Map<string, MediaLinks | null>();

/**
 * Links for a server with a public URL, made once per data dir; null without
 * one, and null (said once in the log) when the secret cannot be kept: the
 * server then runs without links rather than not at all.
 */
export function mediaLinksFor(config: { dataDir: string; publicUrl: string | null }): MediaLinks | null {
  if (!config.publicUrl) return null;
  const key = `${config.dataDir}\n${config.publicUrl}`;
  if (cached.has(key)) return cached.get(key)!;
  let links: MediaLinks | null;
  try {
    links = new MediaLinks(linkSecret(config.dataDir), config.publicUrl.replace(/\/+$/, ""));
  } catch (err) {
    log(`Media links are off: ${err instanceof Error ? err.message : "the secret could not be kept"}`);
    links = null;
  }
  cached.set(key, links);
  return links;
}

/** A mime safe to state as Content-Type: type/subtype and simple parameters, else octet-stream. */
function contentType(mime: string): string {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(\s*;\s*[a-z0-9_.-]+=("[^"\\\r\n]*"|[a-z0-9_.+-]+))*$/i.test(mime)
    ? mime
    : "application/octet-stream";
}

/** Content-Disposition for a download: an ASCII name every client reads, and the sender's own as UTF-8. */
export function attachmentDisposition(filename: string | null, mime: string): string {
  const fallbackExt = /^[a-z]+\/([a-z0-9]+)/i.exec(mime)?.[1] ?? "bin";
  // By code points, never UTF-16 units: a cut through an emoji would leave half of it, which encodeURIComponent refuses.
  const own = [...(filename ?? "")]
    .filter((ch) => {
      const code = ch.codePointAt(0)!;
      return code >= 0x20 && code !== 0x7f && !(code >= 0xd800 && code <= 0xdfff) && ch !== "/" && ch !== "\\";
    })
    .slice(0, 200)
    .join("")
    .trim();
  const name = own === "" ? `whatsapp-media.${fallbackExt}` : own;
  const ascii = name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 100) || `whatsapp-media.${fallbackExt}`;
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Headers every answer of the route carries, file or not. */
const GUARD_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Referrer-Policy": "no-referrer",
};

function refuse(res: Response, status: number, error: string): void {
  res.status(status).set(GUARD_HEADERS).json({ error });
}

/** What a HEAD finds out about a link's file: its type and name, read off the message; null when it has no media now. */
function aboutOriginal(wa: WhatsAppApi, sid: string): { mime: string; filename: string | null } | null {
  try {
    return wa.mediaOriginalInfo?.(sid) ?? null;
  } catch {
    return null;
  }
}

/**
 * GET (and HEAD) /media/:token. 404 alike for a forged, expired or tampered
 * link, an account no longer here, and a message deleted, expired or cleared
 * since. A HEAD (a link checker, `curl -I`, a download manager's first look)
 * is answered from the message alone, with the GET's headers but no length:
 * fetching the file for an answer without a body would spend a download slot,
 * the memory for the whole file and, for expired media, one of the account's
 * requests to the phone.
 */
export async function serveMediaLink(hub: AccountSource, links: MediaLinks, token: string, res: Response, opts: { head?: boolean } = {}): Promise<void> {
  const claim = links.verify(token);
  const binding = claim === null ? undefined : hub.bindings().find((entry) => entry.id === claim.account);
  const sid = claim === null || binding === undefined ? null : (binding.wa.mediaLinkTarget?.(claim.row, claim.tag) ?? null);
  if (binding === undefined || sid === null) {
    refuse(res, 404, "Not found");
    return;
  }
  if (opts.head === true) {
    const about = aboutOriginal(binding.wa, sid);
    if (about === null) {
      refuse(res, 404, "Not found");
      return;
    }
    const type = contentType(about.mime);
    res
      .status(200)
      .set({ ...GUARD_HEADERS, "Content-Type": type, "Content-Disposition": attachmentDisposition(about.filename, type) })
      .end();
    return;
  }
  // A fetch that goes away before its file is ready stops the download (its slot, its wait for the phone).
  const gone = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded) gone.abort();
  });
  let file: { buffer: Buffer; mime: string; filename: string | null };
  try {
    file = await binding.wa.mediaOriginal(sid, { signal: gone.signal });
  } catch (err) {
    if (gone.signal.aborted) return;
    const code = asWazapError(err).code;
    if (code === "MESSAGE_NOT_FOUND" || code === "MEDIA_UNAVAILABLE") refuse(res, 404, "Not found");
    else if (code === "RATE_LIMITED") refuse(res, 429, "Busy, retry in a minute");
    else if (code === "FILE_TOO_LARGE") refuse(res, 413, "Too large to fetch here");
    else refuse(res, 503, "Unavailable, retry later");
    return;
  }
  if (gone.signal.aborted) return;
  const type = contentType(file.mime);
  res
    .status(200)
    .set({
      ...GUARD_HEADERS,
      "Content-Type": type,
      "Content-Length": String(file.buffer.length),
      "Content-Disposition": attachmentDisposition(file.filename, type),
    })
    .end(file.buffer);
}
