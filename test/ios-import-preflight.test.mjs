import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { openTemp, ME, PEER } from "./db-fixtures.mjs";
import { sqlite } from "../dist/db/sqlite.js";
import { initializeIosBinding } from "../dist/ios-import/binding.js";
import { importIos } from "../dist/ios-import/index.js";

function source(path) {
  const d = new (sqlite().DatabaseSync)(path);
  d.exec(`CREATE TABLE ZWACHATSESSION(Z_PK INTEGER PRIMARY KEY,ZCONTACTJID TEXT,ZGROUPINFO INTEGER,ZPARTNERNAME TEXT);
CREATE TABLE ZWAGROUPMEMBER(Z_PK INTEGER PRIMARY KEY,ZMEMBERJID TEXT);
CREATE TABLE ZWAMESSAGE(Z_PK INTEGER PRIMARY KEY,ZCHATSESSION INTEGER,ZGROUPMEMBER INTEGER,ZISFROMME INTEGER,ZSTANZAID TEXT,ZMESSAGEDATE REAL,ZMESSAGETYPE INTEGER,ZTEXT TEXT,ZPARENTMESSAGE INTEGER);
CREATE TABLE ZWAMEDIAITEM(Z_PK INTEGER PRIMARY KEY,ZMESSAGE INTEGER,ZTITLE TEXT,ZMEDIALOCALPATH TEXT);`);
  d.prepare("INSERT INTO ZWACHATSESSION VALUES(1,?,NULL,'Peer')").run(PEER);
  d.exec("INSERT INTO ZWAMESSAGE VALUES(1,1,NULL,0,'original',700000000,0,'original',NULL)");
  return d;
}
for (const kind of ["wal", "journal", "schema", "message-key", "media-key", "chat-key", "not-sqlite"]) {
  test(`invalid ${kind} replacement preserves selected archive and progress before reset`, async () => {
    const t = openTemp();
    try {
      t.db.bindOwner(ME);
      initializeIosBinding(t.db);
      const original = join(t.dir, "original.sqlite");
      source(original).close();
      await importIos({ db: t.db, source: original, explicit: true, textOnly: true });
      const markerPath = join(dirname(t.path), "ios-import-binding.json");
      const marker = readFileSync(markerPath);
      const metadata = t.db.scanMeta("ios_");
      const replacement = join(t.dir, "replacement.sqlite");
      const d = source(replacement);
      if (kind === "schema") d.exec("DROP TABLE ZWAMEDIAITEM");
      if (kind === "message-key") d.exec("UPDATE ZWAMESSAGE SET Z_PK=9007199254740992");
      if (kind === "media-key") d.exec("INSERT INTO ZWAMEDIAITEM(Z_PK) VALUES(0)");
      if (kind === "chat-key") d.exec("UPDATE ZWACHATSESSION SET Z_PK=-1");
      d.close();
      if (kind === "not-sqlite") writeFileSync(replacement, "not a database");
      if (kind === "wal" || kind === "journal") writeFileSync(`${replacement}-${kind}`, "pending source state");
      const bytes = readFileSync(replacement);
      await assert.rejects(importIos({ db: t.db, source: replacement, explicit: true, reset: true }), (error) => {
        assert.equal(
          error.reason,
          kind === "wal" || kind === "journal"
            ? "source_incomplete"
            : kind === "not-sqlite"
              ? "source_not_database"
              : "source_schema_unsupported"
        );
        return true;
      });
      assert.deepEqual(readFileSync(markerPath), marker);
      assert.deepEqual(t.db.scanMeta("ios_"), metadata);
      assert.deepEqual(readFileSync(replacement), bytes);
      assert.equal(t.db.messages.get(`false_${PEER}_original`).text, "original");
      if (kind === "wal" || kind === "journal")
        assert.equal(readFileSync(`${replacement}-${kind}`, "utf8"), "pending source state");
    } finally {
      t.db.close();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
}
