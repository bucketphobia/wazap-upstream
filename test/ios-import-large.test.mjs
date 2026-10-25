import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { sqlite } from "../dist/db/sqlite.js";
import { openTemp, ME, PEER } from "./db-fixtures.mjs";
import { initializeIosBinding } from "../dist/ios-import/binding.js";
import { importIos } from "../dist/ios-import/index.js";
test("large sparse archive keeps checkpoints bounded and resolves forward replies across pages", async () => {
  const t = openTemp();
  t.db.bindOwner(ME);
  initializeIosBinding(t.db);
  const path = join(t.dir, "ChatStorage.sqlite");
  const d = new (sqlite().DatabaseSync)(path);
  d.exec(
    `CREATE TABLE ZWACHATSESSION(Z_PK INTEGER PRIMARY KEY,ZCONTACTJID TEXT,ZGROUPINFO INTEGER,ZPARTNERNAME TEXT); CREATE TABLE ZWAGROUPMEMBER(Z_PK INTEGER PRIMARY KEY,ZMEMBERJID TEXT); CREATE TABLE ZWAMESSAGE(Z_PK INTEGER PRIMARY KEY,ZCHATSESSION INTEGER,ZGROUPMEMBER INTEGER,ZISFROMME INTEGER,ZSTANZAID TEXT,ZMESSAGEDATE REAL,ZMESSAGETYPE INTEGER,ZTEXT TEXT,ZPARENTMESSAGE INTEGER); CREATE TABLE ZWAMEDIAITEM(Z_PK INTEGER PRIMARY KEY,ZMESSAGE INTEGER,ZTITLE TEXT,ZMEDIALOCALPATH TEXT,ZMOVIEDURATION REAL);`
  );
  d.prepare("INSERT INTO ZWACHATSESSION VALUES(1,?,NULL,?)").run(PEER, "Peer");
  const add = d.prepare("INSERT INTO ZWAMESSAGE VALUES(?,1,NULL,0,?,700000000,3,NULL,?)");
  d.exec("BEGIN");
  for (let i = 1; i <= 1601; i++) add.run(i * 3, `key${i}`, i < 1601 ? 4803 : null);
  d.exec("COMMIT");
  d.close();
  writeFileSync(join(t.dir, "voice-skip.txt"), "");
  const original = t.db.setMeta.bind(t.db);
  let max = 0;
  t.db.setMeta = (key, value) => {
    if (value !== null) max = Math.max(max, Buffer.byteLength(value));
    return original(key, value);
  };
  try {
    const r = await importIos({ db: t.db, source: path, textOnly: true });
    assert.equal(r.inserted, 1601);
    assert.ok(max < 16000, `metadata value grew to ${max}`);
    assert.equal(JSON.parse(t.db.getMeta("ios_import_v1")).voiceBindings, 2);
    assert.equal(t.db.messages.get(`false_${PEER}_key1`).quotedSid, `false_${PEER}_key1601`);
  } finally {
    t.db.close();
  }
});

test("voice pages and collision exclusions survive interruption and physical reopen", async () => {
  const t = openTemp();
  let db = t.db;
  db.bindOwner(ME);
  initializeIosBinding(db);
  const path = join(t.dir, "large.sqlite");
  const d = new (sqlite().DatabaseSync)(path);
  d.exec(
    `CREATE TABLE ZWACHATSESSION(Z_PK INTEGER PRIMARY KEY,ZCONTACTJID TEXT,ZGROUPINFO INTEGER,ZPARTNERNAME TEXT); CREATE TABLE ZWAGROUPMEMBER(Z_PK INTEGER PRIMARY KEY,ZMEMBERJID TEXT); CREATE TABLE ZWAMESSAGE(Z_PK INTEGER PRIMARY KEY,ZCHATSESSION INTEGER,ZGROUPMEMBER INTEGER,ZISFROMME INTEGER,ZSTANZAID TEXT,ZMESSAGEDATE REAL,ZMESSAGETYPE INTEGER,ZTEXT TEXT,ZPARENTMESSAGE INTEGER); CREATE TABLE ZWAMEDIAITEM(Z_PK INTEGER PRIMARY KEY,ZMESSAGE INTEGER,ZTITLE TEXT,ZMEDIALOCALPATH TEXT,ZMOVIEDURATION REAL);`
  );
  d.prepare("INSERT INTO ZWACHATSESSION VALUES(1,?,NULL,?)").run(PEER, "Peer");
  const add = d.prepare("INSERT INTO ZWAMESSAGE VALUES(?,1,NULL,0,?,700000000,3,NULL,NULL)");
  const media = d.prepare("INSERT INTO ZWAMEDIAITEM VALUES(?,?,NULL,?,NULL)");
  d.exec("BEGIN");
  for (let i = 1; i <= 1103; i++) {
    add.run(i * 3, i === 1 || i === 1103 ? "collision" : `voice${i}`);
    media.run(i * 2, i * 3, "note.opus");
  }
  d.exec("COMMIT");
  d.close();
  writeFileSync(join(t.dir, "note.opus"), "synthetic");
  writeFileSync(join(t.dir, "voice-skip.txt"), "");
  try {
    await assert.rejects(
      importIos({
        db,
        source: path,
        textOnly: true,
        afterChunk() {
          throw Error("interrupt");
        },
      }),
      /interrupt/
    );
    assert.equal(JSON.parse(db.getMeta("ios_import_v1")).last, 1500);
    db.close();
    const { AccountDb } = await import("../dist/db/index.js");
    db = AccountDb.open(t.path);
    await importIos({ db, source: path, textOnly: true });
    db.close();
    db = AccountDb.open(t.path);
    let uploads = 0;
    const result = await importIos({
      db,
      source: path,
      media: t.dir,
      transcriber: async () => {
        uploads++;
        return { text: "transcribed" };
      },
    });
    assert.equal(result.quarantined, 2);
    assert.equal(result.inserted, 1101);
    assert.equal(uploads, 1101);
    assert.equal(result.voice.transcribed, 1101);
    assert.equal(db.messages.get(`false_${PEER}_collision`), null);
    assert.equal(
      (
        await importIos({
          db,
          source: path,
          media: t.dir,
          transcriber: async () => {
            throw Error("must not upload twice");
          },
        })
      ).voice.transcribed,
      1101
    );
  } finally {
    db.close();
  }
});

test("cancellation during collision preparation yields before target rows are written", async () => {
  const t = openTemp();
  t.db.bindOwner(ME);
  initializeIosBinding(t.db);
  const path = join(t.dir, "cancel.sqlite");
  const d = new (sqlite().DatabaseSync)(path);
  d.exec(
    `CREATE TABLE ZWACHATSESSION(Z_PK INTEGER PRIMARY KEY,ZCONTACTJID TEXT,ZGROUPINFO INTEGER,ZPARTNERNAME TEXT);CREATE TABLE ZWAGROUPMEMBER(Z_PK INTEGER PRIMARY KEY,ZMEMBERJID TEXT);CREATE TABLE ZWAMESSAGE(Z_PK INTEGER PRIMARY KEY,ZCHATSESSION INTEGER,ZGROUPMEMBER INTEGER,ZISFROMME INTEGER,ZSTANZAID TEXT,ZMESSAGEDATE REAL,ZMESSAGETYPE INTEGER,ZTEXT TEXT,ZPARENTMESSAGE INTEGER);CREATE TABLE ZWAMEDIAITEM(Z_PK INTEGER PRIMARY KEY,ZMESSAGE INTEGER,ZTITLE TEXT,ZMEDIALOCALPATH TEXT);`
  );
  d.prepare("INSERT INTO ZWACHATSESSION VALUES(1,?,NULL,NULL)").run(PEER);
  const add = d.prepare("INSERT INTO ZWAMESSAGE VALUES(?,1,NULL,0,?,700000000,0,NULL,NULL)");
  d.exec("BEGIN");
  for (let i = 1; i <= 1501; i++) add.run(i, `key${i}`);
  d.exec("COMMIT");
  d.close();
  const signal = new AbortController();
  setImmediate(() => signal.abort());
  try {
    await assert.rejects(importIos({ db: t.db, source: path, textOnly: true, signal: signal.signal }), /stopped/);
    assert.equal(t.db.getMeta("ios_import_v1"), null);
    await importIos({ db: t.db, source: path, textOnly: true });
    const resetSignal = new AbortController();
    t.db.transaction(() => {
      for (let i = 0; i < 501; i++) t.db.setMeta(`ios_import_v2:old:voice:${i}`, "{}");
      t.db.setMeta("unrelated", "keep");
    });
    const deleteKeys = t.db.deleteMetaKeys.bind(t.db);
    t.db.deleteMetaKeys = (keys) => {
      assert.equal(t.db.getMeta("ios_import_v1"), null, "reset must invalidate its root before deleting pages");
      deleteKeys(keys);
      resetSignal.abort();
    };
    await assert.rejects(
      importIos({ db: t.db, source: path, explicit: true, reset: true, textOnly: true, signal: resetSignal.signal }),
      /stopped/
    );
    assert.equal(t.db.getMeta("ios_import_v1"), null);
    assert.equal(t.db.getMeta("unrelated"), "keep");
    assert.equal(t.db.messages.get(`false_${PEER}_key1`).text, null);
  } finally {
    t.db.close();
  }
});

function reviewFixture(rows) {
  const t = openTemp();
  t.db.bindOwner(ME);
  initializeIosBinding(t.db);
  const source = join(t.dir, "review.sqlite");
  const d = new (sqlite().DatabaseSync)(source);
  d.exec(
    `CREATE TABLE ZWACHATSESSION(Z_PK INTEGER PRIMARY KEY,ZCONTACTJID TEXT,ZGROUPINFO INTEGER,ZPARTNERNAME TEXT);CREATE TABLE ZWAGROUPMEMBER(Z_PK INTEGER PRIMARY KEY,ZMEMBERJID TEXT);CREATE TABLE ZWAMESSAGE(Z_PK INTEGER PRIMARY KEY,ZCHATSESSION INTEGER,ZGROUPMEMBER INTEGER,ZISFROMME INTEGER,ZSTANZAID TEXT,ZMESSAGEDATE REAL,ZMESSAGETYPE INTEGER,ZTEXT TEXT,ZPARENTMESSAGE INTEGER);CREATE TABLE ZWAMEDIAITEM(Z_PK INTEGER PRIMARY KEY,ZMESSAGE INTEGER,ZTITLE TEXT,ZMEDIALOCALPATH TEXT);`
  );
  d.prepare("INSERT INTO ZWACHATSESSION VALUES(1,?,NULL,NULL)").run(PEER);
  const add = d.prepare("INSERT INTO ZWAMESSAGE VALUES(?,1,NULL,0,?,700000000,?,NULL,?)");
  d.exec("BEGIN");
  for (const r of rows) {
    add.run(r.pk, `key${r.pk}`, r.type ?? 3, r.parent ?? null);
    d.prepare("INSERT INTO ZWAMEDIAITEM VALUES(?,?,NULL,?)").run(r.pk, r.pk, "note.opus");
  }
  d.exec("COMMIT");
  d.close();
  writeFileSync(join(t.dir, "note.opus"), "synthetic");
  writeFileSync(join(t.dir, "voice-skip.txt"), "");
  return { ...t, source };
}

test("archive voice refuses existing text targets at capture, upload, and result persistence", async () => {
  const t = reviewFixture([{ pk: 1 }, { pk: 2 }]);
  const sid = `false_${PEER}_key1`;
  try {
    t.db.messages.upsert({
      chatJid: PEER,
      fromMe: false,
      keyId: "key1",
      senderJid: PEER,
      ts: Date.UTC(2023, 2, 8),
      type: "text",
      text: "live text",
    });
    await importIos({ db: t.db, source: t.source, textOnly: true });
    const root = JSON.parse(t.db.getMeta("ios_import_v1"));
    const key = `ios_import_v2:${root.generation}:voice:${"0".padStart(20, "0")}`;
    const page = JSON.parse(t.db.getMeta(key));
    assert.equal(page["1"], undefined, "text target must not acquire a voice binding");
    page["1"] = { id: t.db.messages.get(sid).id };
    t.db.setMeta(key, JSON.stringify(page));
    let calls = 0;
    await importIos({
      db: t.db,
      source: t.source,
      media: t.dir,
      transcriber: async () => {
        calls++;
        const raw = new (sqlite().DatabaseSync)(t.path);
        raw.prepare("UPDATE messages SET type='text' WHERE key_id='key2'").run();
        raw.close();
        return { text: "paid result" };
      },
    });
    assert.equal(calls, 1);
    assert.equal(t.db.messages.get(sid).transcript, null);
    assert.equal(t.db.messages.get(`false_${PEER}_key2`).transcript, null);
  } finally {
    t.db.close();
  }
});

test("legacy deferred replies cannot claim a replacement child from its current SID", async () => {
  const t = reviewFixture([
    { pk: 1, type: 0, parent: 2 },
    { pk: 2, type: 0 },
  ]);
  try {
    await importIos({ db: t.db, source: t.source, textOnly: true });
    const root = JSON.parse(t.db.getMeta("ios_import_v1"));
    delete root.format;
    delete root.generation;
    delete root.replyCursor;
    root.voiceBindings = 1;
    root.report.state = "replies";
    root.replies = [{ child: `false_${PEER}_key1`, parent: 2 }];
    t.db.setMeta("ios_import_v1", JSON.stringify(root));
    t.db.setMeta("ios_voice_targets_v1", "{}");
    const raw = new (sqlite().DatabaseSync)(t.path);
    raw.prepare("UPDATE messages SET quoted_sid=NULL,quoted_from_me=NULL,quoted_key_id=NULL WHERE key_id='key1'").run();
    raw.close();
    await importIos({ db: t.db, source: t.source, textOnly: true });
    assert.equal(t.db.getMeta("ios_import_error"), "legacy_reply_bindings_missing");
    assert.equal(t.db.messages.get(`false_${PEER}_key1`).quotedSid, null);
  } finally {
    t.db.close();
  }
});

test("one checkpoint exception stops new voice dispatch while accepted uploads drain", async () => {
  const t = reviewFixture(Array.from({ length: 8 }, (_, i) => ({ pk: i + 1 })));
  try {
    await importIos({ db: t.db, source: t.source, textOnly: true });
    const accepted = [];
    let fail = true;
    const original = t.db.setMeta.bind(t.db);
    t.db.setMeta = (key, value) => {
      if (fail && key === "ios_import_v1" && JSON.parse(value).report.voice.transcribed === 1) {
        fail = false;
        throw Error("checkpoint storage failure");
      }
      return original(key, value);
    };
    const running = importIos({
      db: t.db,
      source: t.source,
      media: t.dir,
      transcriber: () => {
        if (accepted.length >= 3) {
          accepted.push(null);
          return Promise.resolve({ text: "unexpected dispatch" });
        }
        return new Promise((resolve) => accepted.push(resolve));
      },
    });
    while (accepted.length < 3) await new Promise((resolve) => setImmediate(resolve));
    accepted[0]({ text: "first" });
    await new Promise((resolve) => setImmediate(resolve));
    accepted[1]({ text: "second" });
    accepted[2]({ text: "third" });
    await assert.rejects(running, /checkpoint storage failure/);
    assert.equal(accepted.length, 3);
    assert.equal(t.db.messages.get(`false_${PEER}_key3`).transcript, "third");
  } finally {
    t.db.close();
  }
});

test("sparse voice scanning yields after one raw source page before a late voice upload", async () => {
  const t = reviewFixture(Array.from({ length: 1002 }, (_, i) => ({ pk: i + 1, type: i === 1001 ? 3 : 0 })));
  const proto = sqlite().DatabaseSync.prototype;
  const prepare = proto.prepare;
  const controller = new AbortController();
  let pages = 0,
    uploads = 0;
  try {
    await importIos({ db: t.db, source: t.source, textOnly: true });
    proto.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (
        sql.includes("WHERE m.") &&
        sql.includes("m.Z_PK>? ORDER BY m.Z_PK LIMIT 500") &&
        sql.includes("NULL caption")
      ) {
        const all = statement.all.bind(statement);
        statement.all = (...params) => {
          const result = all(...params);
          pages++;
          if (pages === 1) setImmediate(() => controller.abort());
          return result;
        };
      }
      return statement;
    };
    const report = await importIos({
      db: t.db,
      source: t.source,
      media: t.dir,
      signal: controller.signal,
      transcriber: async () => {
        uploads++;
        return { text: "must not reach this yet" };
      },
    });
    assert.equal(report.state, "voice");
    assert.equal(pages, 1);
    assert.equal(uploads, 0);
  } finally {
    proto.prepare = prepare;
    t.db.close();
  }
});

test("prepared collision membership follows source PK after canonical identity changes", async () => {
  const t = reviewFixture(Array.from({ length: 1002 }, (_, i) => ({ pk: i + 1, type: 0 })));
  const lid = "123456789012345@lid";
  const raw = new (sqlite().DatabaseSync)(t.source);
  raw.prepare("UPDATE ZWACHATSESSION SET ZCONTACTJID=?").run(lid);
  raw.exec("UPDATE ZWAMESSAGE SET ZSTANZAID='collision' WHERE Z_PK>=1001");
  raw.close();
  let folded = false;
  try {
    const report = await importIos({
      db: t.db,
      source: t.source,
      textOnly: true,
      afterChunk: async () => {
        if (!folded) {
          folded = true;
          await t.db.learnLidPhone(lid, PEER);
        }
      },
    });
    assert.equal(report.quarantineReasons.identity_collision, 2);
    assert.equal(t.db.messages.get(`false_${PEER}_collision`), null);
  } finally {
    t.db.close();
  }
});

test("arbitrary source type values share bounded private-safe report buckets", async () => {
  const types = Array.from({ length: 1400 }, (_, i) => (i % 2 === 0 ? 10000 + i : `private-source-type-${i}`));
  const t = reviewFixture([
    ...types.map((type, i) => ({ pk: i + 1, type })),
    { pk: 1401, type: 14 },
    { pk: 1402, type: 0 },
  ]);
  let maximum = 0;
  const setMeta = t.db.setMeta.bind(t.db);
  t.db.setMeta = (key, value) => {
    if (key === "ios_import_v1" && value !== null) {
      maximum = Math.max(maximum, Buffer.byteLength(value));
      assert.doesNotMatch(value, /private-source-type/);
      assert.ok(Object.keys(JSON.parse(value).report.sourceByType).length <= 17);
    }
    return setMeta(key, value);
  };
  try {
    const report = await importIos({ db: t.db, source: t.source, textOnly: true });
    assert.deepEqual(report.sourceByType, { 0: 1, 14: 1, unknown: 1400 });
    assert.deepEqual(report.skippedByType, { 14: 1, unknown: 1400 });
    assert.ok(maximum < 16000);
    const root = JSON.parse(t.db.getMeta("ios_import_v1"));
    root.report.sourceByType["private-old-type"] = 5;
    root.report.skippedByType["private-old-type"] = 5;
    setMeta("ios_import_v1", JSON.stringify(root));
    const { readIosReport } = await import("../dist/ios-import/index.js");
    assert.equal(readIosReport(t.db).sourceByType.unknown, 1405);
    assert.doesNotMatch(JSON.stringify(readIosReport(t.db)), /private-old-type/);
    await importIos({ db: t.db, source: t.source, textOnly: true });
  } finally {
    t.db.close();
  }
});
