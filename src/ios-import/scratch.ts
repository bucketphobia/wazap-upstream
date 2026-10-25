/** Disposable, bounded-cache work index. Never attaches or writes the archive. */
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqlite, type DatabaseSync } from "../db/sqlite.js";
export function openScratch() {
  const directory = mkdtempSync(join(tmpdir(), "wazap-ios-"));
  let db: DatabaseSync | undefined;
  try {
    chmodSync(directory, 0o700);
    const path = join(directory, "index.sqlite");
    db = new (sqlite().DatabaseSync)(path);
    chmodSync(path, 0o600);
    db.exec(`PRAGMA journal_mode=OFF; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE;
      CREATE TABLE identities(pk INTEGER PRIMARY KEY,sid TEXT); CREATE INDEX identities_sid ON identities(sid);
      CREATE TABLE media(message INTEGER PRIMARY KEY,caption TEXT,path TEXT);`);
    const opened = db;
    const identity = db.prepare("INSERT INTO identities VALUES(?,?)");
    const media = db.prepare("INSERT OR IGNORE INTO media VALUES(?,?,?)");
    const getMedia = db.prepare("SELECT caption, path mediaPath FROM media WHERE message=?");
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
