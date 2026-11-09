/** Disposable, bounded-cache work index. Never attaches or writes the archive. */
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { sqlite, type DatabaseSync } from "../db/sqlite.js";
const PREFIX = ".ios-scratch-";
const STALE_MS = 24 * 3600_000;
/** Lives in the account's data directory: it holds numbers and captions. The next run removes what a killed run left. */
export function openScratch(parent: string) {
  // Day-old folders are leftovers; a younger one may belong to a run that is still going (a dry run takes no lock).
  // ponytail: folder mtime does not move while SQLite writes inside, so a run older than a day can lose its index to another run.
  try {
    for (const name of readdirSync(parent))
      try {
        if (name.startsWith(PREFIX) && Date.now() - statSync(join(parent, name)).mtimeMs > STALE_MS)
          rmSync(join(parent, name), { recursive: true, force: true });
      } catch {
        // Leftovers are only clutter; they never fail a run.
      }
  } catch {
    // An unreadable folder fails at mkdtemp below if it matters.
  }
  const directory = mkdtempSync(join(parent, PREFIX));
  let db: DatabaseSync | undefined;
  try {
    chmodSync(directory, 0o700);
    const path = join(directory, "index.sqlite");
    db = new (sqlite().DatabaseSync)(path);
    chmodSync(path, 0o600);
    db.exec(`PRAGMA journal_mode=OFF; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE;
      CREATE TABLE identities(pk INTEGER PRIMARY KEY,sid TEXT); CREATE INDEX identities_sid ON identities(sid);
      CREATE TABLE media(message INTEGER PRIMARY KEY,caption TEXT,path TEXT,duration REAL);`);
    const opened = db;
    const identity = db.prepare("INSERT INTO identities VALUES(?,?)");
    const media = db.prepare("INSERT OR IGNORE INTO media VALUES(?,?,?,?)");
    const getMedia = db.prepare("SELECT caption, path mediaPath, duration FROM media WHERE message=?");
    return {
      db,
      identity,
      media,
      getMedia,
      close() {
        try {
          opened.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      db?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
