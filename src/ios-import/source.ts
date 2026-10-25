/** Read-only validation of extracted, standalone Core Data archives. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sqlite, type DatabaseSync } from "../db/sqlite.js";
import { WazapError } from "../errors.js";

export type IosSourceReason =
  | "source_incomplete"
  | "source_unreadable"
  | "source_not_database"
  | "source_schema_unsupported"
  | "source_changed"
  | "source_corrupt";
const messages: Record<IosSourceReason, string> = {
  source_incomplete:
    "The iPhone archive is not a standalone database. Export a complete, checkpointed archive before importing.",
  source_unreadable: "The iPhone archive cannot be read.",
  source_not_database: "The iPhone archive is not an unencrypted SQLite database.",
  source_schema_unsupported: "The iPhone archive has an unsupported database structure.",
  source_changed: "The iPhone archive changed during import. Use a stable extracted copy.",
  source_corrupt: "The iPhone archive database could not be read safely.",
};
export class IosSourceError extends WazapError {
  constructor(readonly reason: IosSourceReason) {
    super("INVALID_ID", messages[reason]);
    this.name = "IosSourceError";
  }
}
function fail(reason: IosSourceReason): never {
  throw new IosSourceError(reason);
}
type Stamp = { path: string; dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };
function stamp(path: string): Stamp {
  try {
    const canonical = realpathSync(path);
    const stat = statSync(canonical, { bigint: true });
    if (!stat.isFile() || !(Number(stat.mode) & 0o444)) fail("source_unreadable");
    return {
      path: canonical,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  } catch (error) {
    if (error instanceof IosSourceError) throw error;
    return fail("source_unreadable");
  }
}
function same(a: Stamp, b: Stamp): boolean {
  return (
    a.path === b.path &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
function companions(path: string): void {
  for (const suffix of ["-wal", "-journal"]) {
    let fd: number | undefined;
    let existed = false;
    try {
      const info = lstatSync(`${path}${suffix}`, { bigint: true });
      existed = true;
      if (!info.isFile() || info.size !== 0n || !(Number(info.mode) & 0o444)) fail("source_incomplete");
      fd = openSync(`${path}${suffix}`, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.size !== 0n || opened.dev !== info.dev || opened.ino !== info.ino)
        fail("source_incomplete");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") fail("source_incomplete");
      // Only absence at lstat is acceptable; disappearance after lstat is a race.
      if (existed) fail("source_incomplete");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
function checkCompanions(original: string, canonical: string): void {
  companions(original);
  if (original !== canonical) companions(canonical);
}
function readMain(path: string, header: boolean): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY);
    if (!fstatSync(fd).isFile()) fail("source_unreadable");
    if (header) {
      const bytes = Buffer.alloc(16);
      if (readSync(fd, bytes, 0, 16, 0) !== 16 || !bytes.equals(Buffer.from("SQLite format 3\0")))
        fail("source_not_database");
    }
  } catch (error) {
    if (error instanceof IosSourceError) throw error;
    fail("source_unreadable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Binding hashes arbitrary bytes; this guard deliberately does not parse SQLite. */
export function assertIosStandaloneSource(path: string): void {
  const original = resolve(path);
  const before = stamp(original);
  checkCompanions(original, before.path);
  readMain(before.path, false);
  const after = stamp(original);
  if (!same(before, after)) fail("source_changed");
  checkCompanions(original, before.path);
}

const columns: Record<string, string[]> = {
  ZWACHATSESSION: ["Z_PK", "ZCONTACTJID", "ZGROUPINFO", "ZPARTNERNAME"],
  ZWAGROUPMEMBER: ["Z_PK", "ZMEMBERJID"],
  ZWAMESSAGE: [
    "Z_PK",
    "ZCHATSESSION",
    "ZGROUPMEMBER",
    "ZISFROMME",
    "ZSTANZAID",
    "ZMESSAGEDATE",
    "ZMESSAGETYPE",
    "ZTEXT",
    "ZPARENTMESSAGE",
  ],
  ZWAMEDIAITEM: ["Z_PK", "ZMESSAGE", "ZTITLE", "ZMEDIALOCALPATH"],
};
function validateSchema(db: DatabaseSync): void {
  for (const [table, required] of Object.entries(columns)) {
    const entry = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=? COLLATE NOCASE").get(table);
    if (entry?.type !== "table" || typeof entry.sql !== "string" || !/^CREATE\s+TABLE\b/i.test(entry.sql))
      fail("source_schema_unsupported");
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    const names = new Set(info.map((column) => String(column.name).toUpperCase()));
    if (!required.every((name) => names.has(name))) fail("source_schema_unsupported");
    const key = info.filter((column) => column.pk !== 0);
    if (
      key.length !== 1 ||
      String(key[0].name).toUpperCase() !== "Z_PK" ||
      String(key[0].type).toUpperCase() !== "INTEGER"
    )
      fail("source_schema_unsupported");
    // A true INTEGER PRIMARY KEY aliases the rowid and has no separate PK index.
    // WITHOUT ROWID and the column-level PRIMARY KEY DESC exception have one.
    if (
      db
        .prepare(`PRAGMA index_list(${table})`)
        .all()
        .some((index) => index.origin === "pk")
    )
      fail("source_schema_unsupported");
    // Rowid order makes each endpoint an indexed seek, independent of table size.
    // Read as bigint so unsafe values are rejected before Node converts to Number.
    for (const order of ["ASC", "DESC"]) {
      const endpoint = db.prepare(`SELECT Z_PK AS pk FROM ${table} ORDER BY Z_PK ${order} LIMIT 1`);
      endpoint.setReadBigInts(true);
      const row = endpoint.get();
      if (row && (typeof row.pk !== "bigint" || row.pk <= 0n || row.pk > BigInt(Number.MAX_SAFE_INTEGER)))
        fail("source_schema_unsupported");
    }
  }
}

export function openIosSource(path: string): {
  db: DatabaseSync;
  format: "coredata-v1";
  assertCurrent(): void;
  close(): void;
} {
  const original = resolve(path);
  assertIosStandaloneSource(original);
  const before = stamp(original);
  readMain(before.path, true);
  const assertCurrent = (): void => {
    checkCompanions(original, before.path);
    let current: Stamp;
    try {
      current = stamp(original);
    } catch {
      return fail("source_changed");
    }
    if (!same(before, current)) fail("source_changed");
    checkCompanions(original, current.path);
  };
  let db: DatabaseSync | undefined;
  try {
    assertCurrent();
    db = new (sqlite().DatabaseSync)(`${pathToFileURL(before.path).href}?mode=ro&immutable=1`, { readOnly: true });
    validateSchema(db);
    assertCurrent();
    const opened = db;
    let closed = false;
    return {
      db: opened,
      format: "coredata-v1",
      assertCurrent,
      close() {
        if (!closed) {
          closed = true;
          opened.close();
        }
      },
    };
  } catch (error) {
    db?.close();
    if (error instanceof IosSourceError) throw error;
    fail("source_corrupt");
  }
}
