/**
 * MCP session ids that carry their owner's mark: `<uuid>.<mac>`, where mac is
 * an HMAC over the uuid, the credential the session was opened with and what
 * that session handed its client (its tools, workflows and instructions, as
 * one digest), keyed by a secret this install keeps. A session this process
 * no longer holds (a restart, the idle sweep, eviction) can then be brought
 * back for the client holding its id, only for the credential it was minted
 * for, and only while wazap would hand that client the same tools and
 * instructions: an id is worthless to anyone else, and no one without the key
 * can make one up.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { log } from "./logger.js";

const KEY_BYTES = 32;
/** 128 bits of HMAC-SHA256, base64url. */
const MAC_CHARS = 22;
const ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{22})$/;

export class SessionIds {
  constructor(private readonly key: Buffer) {}

  private mac(uuid: string, owner: string, shape: string): string {
    return createHmac("sha256", this.key).update(`${uuid}\n${owner}\n${shape}`).digest("base64url").slice(0, MAC_CHARS);
  }

  /** A new id for a session opened by `owner` and handed `shape`. */
  mint(owner: string, shape: string): string {
    const uuid = randomUUID();
    return `${uuid}.${this.mac(uuid, owner, shape)}`;
  }

  /** Whether `id` is one this install minted for exactly this owner and this shape. */
  verify(id: string, owner: string, shape: string): boolean {
    const parts = ID.exec(id);
    if (parts === null) return false;
    const want = Buffer.from(this.mac(parts[1]!, owner, shape));
    const got = Buffer.from(parts[2]!);
    return got.length === want.length && timingSafeEqual(got, want);
  }
}

const loaded = new Map<string, SessionIds>();

/**
 * The install's key, from `file` (hex, 0600), made there on first use. A
 * file that cannot be read or written leaves a key for this process alone:
 * sessions still come back after the idle sweep, just not after a restart.
 * One per file per process, so every endpoint on a data dir agrees.
 */
export function sessionIds(file: string): SessionIds {
  const known = loaded.get(file);
  if (known !== undefined) return known;
  const ids = new SessionIds(readKey(file));
  loaded.set(file, ids);
  return ids;
}

function readKey(file: string): Buffer {
  try {
    const text = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(text)) return Buffer.from(text, "hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return processKey(err);
  }
  const key = randomBytes(KEY_BYTES);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${key.toString("hex")}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    return key;
  } catch (err) {
    return processKey(err);
  }
}

function processKey(err: unknown): Buffer {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  log(`HTTP session key unavailable${code ? ` (${code})` : ""}; sessions will not survive a restart`);
  return randomBytes(KEY_BYTES);
}
