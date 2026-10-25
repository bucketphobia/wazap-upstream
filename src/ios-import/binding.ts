/** Account-root archive ownership survives database rotation and import checkpoint resets. */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, createReadStream, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AccountDb } from "../db/index.js";
import { WazapError } from "../errors.js";
import { assertIosStandaloneSource } from "./source.js";

type BindingDb = Pick<AccountDb, "path" | "isOpen" | "getMeta">;
type Stamp = { path: string; dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string };
type Binding =
  | { version: 1; state: "awaiting-source"; owner: string }
  | { version: 1; state: "bound"; owner: string; sha256: string }
  | { version: 1; state: "selection-required" };
const HASH = /^[a-f0-9]{64}$/;
const STAMP_KEYS = ["path", "dev", "ino", "size", "mtimeNs", "ctimeNs"] as const;
const markerPath = (db: BindingDb) => join(dirname(db.path), "ios-import-binding.json");
export const IOS_SELECTION_REQUIRED = "Select the iPhone archive explicitly for the linked account before importing.";
function denied(): never {
  throw new WazapError(
    "INVALID_ID",
    IOS_SELECTION_REQUIRED,
    "Run wazap import ios <ChatStorage.sqlite> --reset after confirming the archive belongs to the linked account."
  );
}
function ownerOf(db: BindingDb): string {
  if (!db.isOpen) denied();
  const owner = db.getMeta("owner");
  if (!owner || !/^\d+@(s\.whatsapp\.net|lid)$/.test(owner)) denied();
  return owner;
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
/** lstat distinguishes an absent marker from broken links or unreadable existing selections. */
function markerExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
function readMarker(path: string): string | null {
  if (!markerExists(path)) return null;
  return readFileSync(path, "utf8");
}
function parseBinding(raw: string | null): Binding | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1) return null;
    if (value.state === "selection-required") return value;
    if (typeof value.owner !== "string" || !value.owner) return null;
    if (value.state === "awaiting-source") return value;
    if (value.state !== "bound" || typeof value.sha256 !== "string" || !HASH.test(value.sha256)) return null;
    return value;
  } catch { return null; }
}
function sourceStamp(source: string): Stamp {
  try {
    const path = realpathSync(source);
    const stat = statSync(path, { bigint: true });
    if (!stat.isFile()) denied();
    return { path, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
      mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
  } catch { return denied(); }
}
function sameStamp(a: Stamp | undefined, b: Stamp): boolean {
  return a !== undefined && STAMP_KEYS.every((key) => a[key] === b[key]);
}
function writeMarker(path: string, value: Binding): void {
  const temp = `${path}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  let ownsTemp = false;
  try {
    const fd = openSync(temp, "wx", 0o600);
    ownsTemp = true;
    try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    ownsTemp = false;
    // Windows may reject opening/flushing a directory; POSIX I/O failures must propagate.
    let directory: number | undefined;
    try {
      directory = openSync(dirname(path), "r");
      fsyncSync(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EISDIR", "EPERM", "EACCES", "EINVAL", "ENOTSUP"].includes(code ?? "")) throw error;
    } finally { if (directory !== undefined) closeSync(directory); }
  } finally { if (ownsTemp) unlinkSync(temp); }
}

export function initializeIosBinding(db: BindingDb): void {
  const path = markerPath(db);
  if (markerExists(path)) return;
  const owner = ownerOf(db);
  if (markerExists(join(dirname(db.path), "import", "ChatStorage.sqlite"))) return;
  writeMarker(path, { version: 1, state: "awaiting-source", owner });
}

export function sealIosBindingBeforeOwnerChange(db: BindingDb): void {
  const path = markerPath(db);
  if (markerExists(path)) {
    // Preserve even malformed selections, but surface directory/read failures before rotation.
    readFileSync(path, "utf8");
    return;
  }
  const owner = ownerOf(db);
  let hash: unknown;
  try { hash = JSON.parse(db.getMeta("ios_import_v1") ?? "null")?.hash; } catch { /* Unknown provenance needs selection. */ }
  writeMarker(path, typeof hash === "string" && HASH.test(hash)
    ? { version: 1, state: "bound", owner, sha256: hash }
    : { version: 1, state: "selection-required" });
}

export async function authorizeIosArchive(args: {
  db: BindingDb; source: string; explicit?: boolean; reselect?: boolean; dryRun?: boolean;
  savedHash?: string | null; signal?: AbortSignal; stopping?: () => boolean;
}): Promise<{ hash: string; assertCurrent(): void }> {
  const checkStopped = () => {
    if (args.signal?.aborted || args.stopping?.())
      throw new WazapError("SERVICE_ERROR", "iPhone import stopped; the last committed chunk will resume.");
  };
  checkStopped();
  const { db, source } = args;
  const owner = ownerOf(db);
  assertIosStandaloneSource(source);
  const stamp = sourceStamp(source);
  const assertCurrent = () => {
    if (ownerOf(db) !== owner) denied();
    assertIosStandaloneSource(source);
    if (!sameStamp(stamp, sourceStamp(source))) denied();
  };
  const path = markerPath(db);
  let raw: string | null = null;
  let unreadable = false;
  if (!args.dryRun) {
    try { raw = readMarker(path); } catch { unreadable = true; }
  }
  const binding = parseBinding(raw);
  const reselect = args.explicit && args.reselect;
  const bound = binding?.state === "bound" && binding.owner === owner ? binding : null;
  const awaiting = binding?.state === "awaiting-source" && binding.owner === owner;
  if (!args.dryRun && !reselect && (unreadable ||
      (raw !== null && !bound && !awaiting) ||
      (raw === null && !args.explicit && !(typeof args.savedHash === "string" && HASH.test(args.savedHash))))) denied();
  const digest = createHash("sha256");
  try {
    for await (const chunk of createReadStream(stamp.path, { signal: args.signal })) {
      checkStopped();
      digest.update(chunk);
    }
  } catch (error) {
    checkStopped();
    if (error instanceof WazapError) throw error;
    return denied();
  }
  checkStopped();
  const hash = digest.digest("hex");
  assertCurrent();
  if (!args.dryRun) {
    if (!reselect && ((bound && bound.sha256 !== hash) ||
        (args.savedHash != null && args.savedHash !== hash))) {
      throw new WazapError(
        "INVALID_ID",
        "The iPhone archive changed since this import began.",
        "Run wazap import ios <ChatStorage.sqlite> --reset after confirming the archive belongs to the linked account."
      );
    }
    // Another selection made while streaming must not be overwritten.
    try { if (!unreadable && readMarker(path) !== raw) denied(); } catch { return denied(); }
    if (!bound || bound.sha256 !== hash || reselect) {
      writeMarker(path, { version: 1, state: "bound", owner, sha256: hash });
    }
  }
  return { hash, assertCurrent };
}
