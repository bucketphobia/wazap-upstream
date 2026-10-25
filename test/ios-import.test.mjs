import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { sqlite } from "../dist/db/sqlite.js";
import { openTemp, ME, PEER, GROUP, T0, textMessage } from "./db-fixtures.mjs";
import { markFailure } from "../dist/transcribe/index.js";
import { MessageViews } from "../dist/service/views.js";
import { initializeIosBinding } from "../dist/ios-import/binding.js";
import { importIos, readIosReport } from "../dist/ios-import/index.js";

function source(dir, rows) {
  const path = join(dir, "ChatStorage.sqlite");
  const d = new (sqlite().DatabaseSync)(path);
  d.exec(`CREATE TABLE ZWACHATSESSION(Z_PK INTEGER PRIMARY KEY,ZCONTACTJID TEXT,ZGROUPINFO INTEGER,ZPARTNERNAME TEXT);
 CREATE TABLE ZWAGROUPMEMBER(Z_PK INTEGER PRIMARY KEY,ZMEMBERJID TEXT);
 CREATE TABLE ZWAMESSAGE(Z_PK INTEGER PRIMARY KEY,ZCHATSESSION INTEGER,ZGROUPMEMBER INTEGER,ZISFROMME INTEGER,ZSTANZAID TEXT,ZMESSAGEDATE REAL,ZMESSAGETYPE INTEGER,ZTEXT TEXT,ZPARENTMESSAGE INTEGER);
 CREATE TABLE ZWAMEDIAITEM(Z_PK INTEGER PRIMARY KEY,ZMESSAGE INTEGER,ZTITLE TEXT,ZMEDIALOCALPATH TEXT,ZMOVIEDURATION REAL);
 INSERT INTO ZWACHATSESSION VALUES(1,'${PEER}',NULL,'Peer'),(2,'${GROUP}',1,'Group'),(3,'1@newsletter',NULL,'News');
 INSERT INTO ZWAGROUPMEMBER VALUES(1,'${PEER}');`);
  for (const r of rows) {
    d.prepare("INSERT INTO ZWAMESSAGE VALUES(?,?,?,?,?,?,?,?,?)").run(
      r.pk,
      r.chat ?? 1,
      r.member ?? null,
      r.fromMe ?? 0,
      r.key ?? `key${r.pk}`,
      (T0 + r.pk * 1000 - Date.UTC(2001, 0, 1)) / 1000,
      r.type ?? 0,
      r.text ?? "body",
      r.parent ?? null
    );
    if (r.caption || r.file)
      d.prepare("INSERT INTO ZWAMEDIAITEM VALUES(?,?,?,?,?)").run(r.pk, r.pk, r.caption ?? null, r.file ?? null, 42);
  }
  d.close();
  // Voice uploads require an explicit skip file; empty is the synthetic fixture consent.
  writeFileSync(join(dir, "voice-skip.txt"), "");
  return path;
}
function target() {
  const t = openTemp();
  t.db.bindOwner(ME);
  initializeIosBinding(t.db);
  return t;
}

/** Read durable original-row proof rather than reconstructing it from current SIDs. */
function voiceEntries(db) {
  const progress = JSON.parse(db.getMeta("ios_import_v1"));
  const prefix = `ios_import_v2:${progress.generation}:voice:`;
  return Object.assign({}, ...db.scanMeta(prefix).map(({ value }) => JSON.parse(value)));
}
function legacyProgress(db) {
  const current = JSON.parse(db.getMeta("ios_import_v1"));
  const entries = voiceEntries(db);
  const legacy = {
    hash: current.hash,
    last: current.last,
    report: current.report,
    replies: [],
    voiceBindings: 1,
    collisionRows: Object.entries(entries)
      .filter(([, row]) => row.collision)
      .map(([pk]) => Number(pk)),
    voiceFailureRows: Object.fromEntries(
      Object.entries(entries)
        .filter(([, row]) => row.failure)
        .map(([pk, row]) => [pk, row.failure])
    ),
  };
  db.setMeta(
    "ios_voice_targets_v1",
    JSON.stringify(
      Object.fromEntries(
        Object.entries(entries)
          .filter(([, row]) => row.id !== undefined)
          .map(([pk, row]) => [pk, row.id])
      )
    )
  );
  return legacy;
}

test("maps all supported types, captions, skip counts, and readonly source", async () => {
  const { db, dir } = target();
  try {
    const types = [0, 7, 1, 2, 11, 8, 15, 3, 4, 5, 14, 6, 10, 38, 39, 53, 99];
    const path = source(
      dir,
      types.map((type, i) => ({ pk: i + 1, type, caption: "caption" }))
    );
    const before = readFileSync(path);
    const r = await importIos({ db, source: path });
    assert.equal(r.inserted, 10);
    assert.equal(db.identity.chat(PEER).name, "Peer");
    assert.equal(
      Object.values(r.skippedByType).reduce((a, b) => a + b, 0),
      7
    );
    assert.deepEqual(
      db.messages
        .chatPage(PEER, { limit: 100 })
        .items.map((x) => x.type)
        .sort(),
      ["text", "text", "image", "video", "video", "document", "sticker", "voice", "contact", "location"].sort()
    );
    assert.equal(db.messages.get(`false_${PEER}_key6`).text, "body");
    assert.equal(db.messages.get(`false_${PEER}_key3`).text, "caption");
    assert.equal(db.messages.get(`false_${PEER}_key8`).text, null);
    assert.deepEqual(readFileSync(path), before);
    assert.equal((await importIos({ db, source: path })).inserted, 10);
    assert.equal(readIosReport(db).state, "done");
  } finally {
    db.close();
  }
});

test("insertOnly never changes a live row, even its expiry or flags", () => {
  const { db } = target();
  try {
    const input = textMessage(PEER, "same", T0, "live");
    db.messages.upsert(input);
    const before = db.messages.get(input.sid, { includeHidden: true });
    assert.equal(
      db.messages.upsert({ ...input, text: "archive", flags: 7, expiresAt: T0, insertOnly: true }).outcome,
      "existing"
    );
    assert.deepEqual(db.messages.get(input.sid, { includeHidden: true }), before);
  } finally {
    db.close();
  }
});

test("dry run writes nothing, rerun inserts zero, barriers and quarantine survive", async () => {
  const { db, dir } = target();
  try {
    db.messages.upsert(textMessage(PEER, "live", T0, "winner"));
    const path = source(dir, [
      { pk: 1, key: "live" },
      { pk: 2, chat: 2 },
      { pk: 3, chat: 3 },
      { pk: 4, key: "same" },
      { pk: 5, key: "same" },
      { pk: 6 },
      { pk: 7, type: 1 },
    ]);
    const dry = await importIos({ db, source: path, dryRun: true });
    assert.equal(dry.skippedExisting, 1);
    assert.equal(dry.quarantined, 4);
    assert.equal(db.getMeta("ios_import_v1"), null);
    const r = await importIos({ db, source: path });
    assert.equal(r.inserted, 2);
    assert.equal(r.quarantined, 4);
    // Fresh checkpoint on the same source is still insert-only.
    db.setMeta("ios_import_v1", null);
    assert.equal((await importIos({ db, source: path })).inserted, 0);
  } finally {
    db.close();
  }
});

test("a crash after a committed chunk resumes without double counting", async () => {
  const { db, dir } = target();
  try {
    const path = source(
      dir,
      Array.from({ length: 503 }, (_, i) => ({ pk: i + 1 }))
    );
    await assert.rejects(
      importIos({
        db,
        source: path,
        afterChunk: () => {
          throw new Error("crash");
        },
      }),
      /crash/
    );
    assert.equal(db.counts().messages, 500);
    const r = await importIos({ db, source: path });
    assert.equal(r.inserted, 503);
    assert.equal(db.counts().messages, 503);
  } finally {
    db.close();
  }
});

test("voice files use original path, skip list, three lanes and skip existing transcripts", async () => {
  const { db, dir } = target();
  try {
    const path = source(dir, [
      { pk: 1, type: 3, file: "note.opus" },
      { pk: 2, type: 3, file: "second.opus" },
    ]);
    writeFileSync(join(dir, "note.opus"), "audio");
    writeFileSync(join(dir, "second.opus"), "audio");
    let calls = 0;
    const transcriber = async () => {
      calls++;
      return { text: "transcript" };
    };
    const r = await importIos({ db, source: path, media: dir, transcriber });
    assert.equal(r.voice.transcribed, 2);
    assert.equal(calls, 2);
    await importIos({ db, source: path, media: dir, transcriber });
    assert.equal(calls, 2);
  } finally {
    db.close();
  }
});

test("quotes resolve after a later parent is inserted, and tombstones and clears never revive", async () => {
  const { db, dir } = target();
  try {
    const dead = db.messages.upsert(textMessage(PEER, "dead", T0, "deleted"));
    db.messages.tombstone(dead.id, T0 + 1000);
    await db.messages.clearChat(GROUP, T0 + 100000);
    const path = source(dir, [{ pk: 1, parent: 2 }, { pk: 2 }, { pk: 3, key: "dead" }, { pk: 4, chat: 2, member: 1 }]);
    await importIos({ db, source: path });
    assert.equal(db.messages.get(`false_${PEER}_key1`).quotedSid, `false_${PEER}_key2`);
    assert.equal(db.messages.get(`false_${PEER}_dead`), null);
    assert.equal(db.messages.get(`false_${GROUP}_key4`), null);
  } finally {
    db.close();
  }
});

test("a failure inside a chunk rolls back rows and checkpoint together", async () => {
  const { db, dir } = target();
  const original = db.messages.upsert.bind(db.messages);
  try {
    const path = source(
      dir,
      Array.from({ length: 503 }, (_, i) => ({ pk: i + 1 }))
    );
    let calls = 0;
    db.messages.upsert = (input) => {
      if (++calls === 237) throw new Error("mid-chunk");
      return original(input);
    };
    await assert.rejects(importIos({ db, source: path }), /mid-chunk/);
    assert.equal(db.counts().messages, 0);
    assert.equal(db.getMeta("ios_import_v1"), null);
    db.messages.upsert = original;
    assert.equal((await importIos({ db, source: path })).inserted, 503);
  } finally {
    db.messages.upsert = original;
    db.close();
  }
});

test("voice honors skip lists and confines paths, runs three lanes, and preserves terminal failures", async () => {
  const { db, dir } = target();
  try {
    const rows = Array.from({ length: 5 }, (_, i) => ({ pk: i + 1, type: 3, file: `note${i}.opus` }));
    rows.push({ pk: 6, type: 3, chat: 2, member: 1, file: "note0.opus" }, { pk: 7, type: 3, file: "../escape.opus" });
    const path = source(dir, rows);
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `note${i}.opus`), "audio");
    writeFileSync(join(dir, "voice-skip.txt"), GROUP + "\n");
    let active = 0,
      max = 0,
      first = true;
    const transcriber = async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      if (first) {
        first = false;
        throw markFailure(new Error("private provider failure"), "permanent", "audio refused");
      }
      return { text: "transcript" };
    };
    const r = await importIos({ db, source: path, media: dir, transcriber });
    assert.equal(max, 3);
    assert.equal(r.voice.skipped, 1);
    assert.equal(r.voice.missing, 1);
    assert.equal(r.voice.failed, 1);
    assert.equal(r.state, "done");
    const retry = await importIos({ db, source: path, media: dir, transcriber });
    assert.equal(retry.voice.failed, 1);
    assert.equal(retry.voice.transcribed, 4);
    assert.equal(retry.state, "done");
  } finally {
    db.close();
  }
});

test("boot imports a dropped database and get_status exposes its counts", async (t) => {
  const { WhatsAppService } = await import("../dist/whatsapp.js");
  const { connectedService } = await import("./helpers.mjs");
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-ios-boot-",
    id: ME,
    name: "Owner",
    config: { importIos: true, persistHistory: true },
  });
  t.after(() => svc.stop());
  await svc.storage.claimDatabase(ME);
  const folder = join(dirname(svc.databasePath), "import");
  mkdirSync(folder, { recursive: true });
  source(folder, [{ pk: 1 }]);
  await svc.bootStorage();
  const status = svc.getStatus();
  assert.equal(status.storage.ios_import.inserted, 1);
  assert.equal(status.storage.ios_import.state, "done");
  assert.equal((await svc.listChats("all", 20)).data[0].name, "Peer");
});

for (const checkpointFailure of [false, true]) {
  test(
    checkpointFailure
      ? "checkpoint failure waits for other voice lanes before shutdown closes storage"
      : "service shutdown drains paid-result responses before database close and starts no next voice job",
    async (t) => {
      const { createServer } = await import("node:http");
      const { WhatsAppService } = await import("../dist/whatsapp.js");
      const { connectedService } = await import("./helpers.mjs");
      const pending = [];
      let arrived;
      const ready = new Promise((resolve) => {
        arrived = resolve;
      });
      const server = createServer(async (req, res) => {
        for await (const _ of req) {
          /* Drain the synthetic upload before controlling its response. */
        }
        pending.push(res);
        if (pending.length === 3) arrived();
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      const changes = {
        WAZAP_TRANSCRIBE: "openai",
        WAZAP_TRANSCRIBE_AUTO: "all",
        WAZAP_TRANSCRIBE_API_KEY: "synthetic-test-key",
        WAZAP_TRANSCRIBE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      };
      const saved = Object.fromEntries(Object.keys(changes).map((k) => [k, process.env[k]]));
      Object.assign(process.env, changes);
      t.after(() => {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      });
      const { svc } = connectedService(WhatsAppService, {
        prefix: "wazap-ios-stop-",
        id: ME,
        name: "Owner",
        config: { importIos: true, persistHistory: true, readOnly: false },
      });
      t.after(() => svc.stop());
      await svc.storage.claimDatabase(ME);
      const database = svc.databasePath;
      const targetDb = svc.db;
      let failedCheckpoint;
      const checkpointFailed = new Promise((resolve) => {
        failedCheckpoint = resolve;
      });
      const setMeta = targetDb.setMeta.bind(targetDb);
      let injected = false;
      targetDb.setMeta = (key, value) => {
        if (
          checkpointFailure &&
          !injected &&
          key === "ios_import_v1" &&
          typeof value === "string" &&
          JSON.parse(value).report.voice.transcribed === 1
        ) {
          injected = true;
          failedCheckpoint();
          throw new Error("synthetic checkpoint failure");
        }
        return setMeta(key, value);
      };
      t.after(() => {
        targetDb.setMeta = setMeta;
      });
      const folder = join(dirname(database), "import");
      mkdirSync(folder, { recursive: true });
      source(
        folder,
        Array.from({ length: 4 }, (_, i) => ({ pk: i + 1, type: 3, file: `note${i}.opus` }))
      );
      for (let i = 0; i < 4; i++) writeFileSync(join(folder, `note${i}.opus`), "audio");
      const boot = svc.bootStorage().then(() => svc.storage.startImportVoice());
      await ready;
      if (checkpointFailure) {
        pending[0].end(JSON.stringify({ text: "synthetic first transcript" }));
        await checkpointFailed;
      }
      const stopping = svc.stop();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(targetDb.isOpen, true);
      for (const res of checkpointFailure ? pending.slice(1) : pending)
        res.end(JSON.stringify({ text: "synthetic transcript" }));
      await Promise.all([boot, stopping]);
      const db = new (sqlite().DatabaseSync)(database, { readOnly: true });
      assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE transcript IS NOT NULL").get().n, 3);
      assert.equal(pending.length, 3);
      const report = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='ios_import_v1'").get().value).report;
      assert.equal(report.state, "voice");
      assert.equal(report.voice.transcribed, 3);
      db.close();
    }
  );
}

test("expired shutdown grace aborts uploads and leaves voice progress resumable", async (t) => {
  const { createServer } = await import("node:http");
  const { WhatsAppService } = await import("../dist/whatsapp.js");
  const { AccountDb } = await import("../dist/db/index.js");
  const { connectedService } = await import("./helpers.mjs");
  let requests = 0,
    arrived;
  const ready = new Promise((resolve) => {
    arrived = resolve;
  });
  const server = createServer(async (req, _res) => {
    for await (const _ of req) {
      /* Drain the synthetic upload before controlling its response. */
    }
    if (++requests === 3) arrived();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const changes = {
    WAZAP_TRANSCRIBE: "openai",
    WAZAP_TRANSCRIBE_AUTO: "all",
    WAZAP_TRANSCRIBE_API_KEY: "synthetic-test-key",
    WAZAP_TRANSCRIBE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  };
  const saved = Object.fromEntries(Object.keys(changes).map((k) => [k, process.env[k]]));
  Object.assign(process.env, changes);
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-ios-cancel-",
    id: ME,
    name: "Owner",
    config: { importIos: true, persistHistory: true, readOnly: false },
  });
  t.after(() => svc.stop());
  await svc.storage.claimDatabase(ME);
  const database = svc.databasePath;
  const folder = join(dirname(database), "import");
  mkdirSync(folder, { recursive: true });
  const archive = source(
    folder,
    Array.from({ length: 4 }, (_, i) => ({ pk: i + 1, type: 3, file: `note${i}.opus` }))
  );
  for (let i = 0; i < 4; i++) writeFileSync(join(folder, `note${i}.opus`), "audio");
  const boot = svc.bootStorage().then(() => svc.storage.startImportVoice());
  await ready;
  const start = performance.now();
  const stopping = svc.stop();
  await svc.storage.finishImport(0);
  await Promise.all([boot, stopping]);
  assert.ok(performance.now() - start < 5000, "cancellation settles without waiting for provider timeout");
  assert.equal(requests, 3);
  const db = AccountDb.open(database);
  try {
    assert.equal(readIosReport(db).state, "voice");
    assert.equal(readIosReport(db).voice.transcribed, 0);
    const resumed = await importIos({
      db,
      source: archive,
      media: folder,
      transcriber: async () => ({ text: "synthetic resumed transcript" }),
    });
    assert.equal(resumed.state, "done");
    assert.equal(resumed.voice.transcribed, 4);
  } finally {
    db.close();
  }
});

for (const automatic of ["0", ""]) {
  test(`boot honors API AUTO=${automatic || "on-demand default"}; explicit media remains opt-in`, async (t) => {
    const { createServer } = await import("node:http");
    const { WhatsAppService } = await import("../dist/whatsapp.js");
    const { connectedService } = await import("./helpers.mjs");
    const { runIosImport } = await import("../dist/ios-import/cli.js");
    let calls = 0;
    const server = createServer(async (req, res) => {
      for await (const _ of req) {
        /* Drain the synthetic upload. */
      }
      calls++;
      res.end(JSON.stringify({ text: "synthetic explicit transcript" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const changes = {
      WAZAP_TRANSCRIBE: "openai",
      WAZAP_TRANSCRIBE_AUTO: automatic,
      WAZAP_TRANSCRIBE_ALLOW_API: "1",
      WAZAP_TRANSCRIBE_API_KEY: "synthetic-test-key",
      WAZAP_TRANSCRIBE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    };
    const saved = Object.fromEntries(Object.keys(changes).map((k) => [k, process.env[k]]));
    Object.assign(process.env, changes);
    t.after(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    const { svc } = connectedService(WhatsAppService, {
      prefix: "wazap-ios-auto-",
      id: ME,
      name: "Owner",
      config: { importIos: true, persistHistory: true, readOnly: true },
    });
    t.after(() => svc.stop());
    await svc.storage.claimDatabase(ME);
    const folder = join(dirname(svc.databasePath), "import");
    mkdirSync(folder, { recursive: true });
    const archive = source(folder, [{ pk: 1, type: 3, file: "note.opus" }]);
    writeFileSync(join(folder, "note.opus"), "audio");
    await svc.bootStorage();
    assert.equal(calls, 0);
    assert.equal(svc.getStatus().storage.ios_import.inserted, 1);
    await svc.stop();
    await runIosImport({
      ...svc.config,
      command: "import",
      args: ["ios", archive],
      importMedia: folder,
      json: true,
      dryRun: false,
    });
    assert.equal(calls, 1, "explicit desktop --media requests transcription even when automatic uploads are off");
  });
}

test("imported voice exposes its stored transcript in the structured message view", async () => {
  const { db, dir } = target();
  try {
    await importIos({ db, source: source(dir, [{ pk: 1, type: 3 }]) });
    const sid = `false_${PEER}_key1`;
    const views = new MessageViews(
      { db: () => db, readyDb: () => db, settleExpired() {}, transcriptOf: () => undefined },
      { ownJid: () => ME, displayName: () => "Synthetic Peer", noteFor: () => undefined, tagsFor: () => undefined }
    );
    assert.equal(views.viewOfStored(db.messages.get(sid)).transcript, undefined);
    db.messages.setTranscript(sid, "synthetic imported voice words", { provider: "openai", at: T0 });
    const stored = db.messages.get(sid);
    assert.equal(stored.raw, null);
    assert.equal(views.viewOfStored(stored).transcript, "synthetic imported voice words");
  } finally {
    db.close();
  }
});

test("archive names fill existing blank chats and new direct contacts without changing live messages", async () => {
  for (const existing of [true, false]) {
    const { db, dir } = target();
    try {
      const input = textMessage(PEER, "live", T0, "live content");
      if (existing) db.messages.upsert(input);
      const before = db.messages.get(input.sid, { includeHidden: true });
      await importIos({ db, source: source(dir, [{ pk: 1, key: "live" }]) });
      assert.equal(db.identity.chat(PEER).name, "Peer");
      assert.equal(db.identity.contact(PEER).name, "Peer");
      if (existing) assert.deepEqual(db.messages.get(input.sid, { includeHidden: true }), before);
    } finally {
      db.close();
    }
  }
});

test("archive names never replace populated chat or contact names or shadow other live name channels", async () => {
  for (const channel of ["name", "notify", "pushName", "verifiedName"]) {
    const { db, dir } = target();
    try {
      db.identity.upsertChat({ jid: PEER, name: "Live chat" });
      db.identity.upsertContact({ jid: PEER, [channel]: "Live person" });
      const before = db.identity.contact(PEER);
      await importIos({ db, source: source(dir, [{ pk: 1 }]) });
      assert.equal(db.identity.chat(PEER).name, "Live chat");
      assert.deepEqual(db.identity.contact(PEER), before);
    } finally {
      db.close();
    }
  }
});

test("group archive names fill blank group chats without creating group contacts", async () => {
  const { db, dir } = target();
  try {
    db.identity.ensureChat(GROUP);
    await importIos({ db, source: source(dir, [{ pk: 1, chat: 2, member: 1 }]) });
    assert.equal(db.identity.chat(GROUP).name, "Group");
    assert.equal(db.identity.contact(GROUP), null);
  } finally {
    db.close();
  }
});

test("archive contact names follow the existing LID to phone canonical identity", async () => {
  const { db, dir } = target();
  try {
    const lid = "123456789012345@lid";
    await db.learnLidPhone(lid, PEER);
    const path = source(dir, [{ pk: 1 }]);
    const raw = new (sqlite().DatabaseSync)(path);
    raw.prepare("UPDATE ZWACHATSESSION SET ZCONTACTJID=? WHERE Z_PK=1").run(lid);
    raw.close();
    await importIos({ db, source: path });
    assert.equal(db.identity.chat(lid).jid, PEER);
    assert.equal(db.identity.chat(PEER).name, "Peer");
    assert.equal(db.identity.contact(lid).id, db.identity.contact(PEER).id);
    assert.equal(db.identity.contact(PEER).name, "Peer");
  } finally {
    db.close();
  }
});

test("completed imports repair missing names on rerun without replaying rows or requesting voice", async () => {
  const { db, dir } = target();
  try {
    const path = source(dir, [{ pk: 1, type: 3, file: "note.opus" }]);
    writeFileSync(join(dir, "note.opus"), "synthetic audio");
    await importIos({ db, source: path });
    db.identity.upsertChat({ jid: PEER, name: null });
    db.identity.upsertContact({ jid: PEER, name: null });
    const before = db.messages.get(`false_${PEER}_key1`, { includeHidden: true });
    const meta = db.getMeta("ios_import_v1");
    let calls = 0;
    await importIos({
      db,
      source: path,
      transcriber: async () => {
        calls++;
        throw new Error("must not transcribe");
      },
    });
    assert.equal(calls, 0);
    assert.equal(db.counts().messages, 1);
    assert.equal(db.getMeta("ios_import_v1"), meta);
    assert.deepEqual(db.messages.get(`false_${PEER}_key1`, { includeHidden: true }), before);
    assert.equal(db.identity.chat(PEER).name, "Peer");
    assert.equal(db.identity.contact(PEER).name, "Peer");
  } finally {
    db.close();
  }
});

test("archive contact name cannot shadow an existing visible chat name", async () => {
  const { AccountIdentity } = await import("../dist/service/identity.js");
  const { db, dir } = target();
  try {
    db.identity.upsertChat({ jid: PEER, name: "Live chat label" });
    const identity = new AccountIdentity({
      db: () => db,
      readyDb: () => db,
      sock: () => null,
      account: () => ({ id: ME, name: "Owner" }),
      cachedGroup: () => undefined,
    });
    const before = identity.displayName(PEER);
    assert.equal(before, "Live chat label");
    assert.equal(db.identity.contact(PEER).name, null);
    await importIos({ db, source: source(dir, [{ pk: 1 }]) });
    assert.equal(identity.displayName(PEER), before);
    assert.equal(db.identity.contact(PEER).name, null);
  } finally {
    db.close();
  }
});

test("completed text skips message collision scan while retaining names-only repair", async () => {
  const { db, dir } = target();
  try {
    const path = source(dir, [{ pk: 1 }]);
    await importIos({ db, source: path });
    db.identity.upsertChat({ jid: PEER, name: null });
    db.identity.upsertContact({ jid: PEER, name: null });
    const originalFind = db.identity.findByKey;
    db.identity.findByKey = () => {
      throw new Error("completed import must not rescan messages");
    };
    const before = db.getMeta("ios_import_v1");
    await importIos({ db, source: path });
    assert.equal(db.identity.chat(PEER).name, "Peer");
    db.identity.findByKey = originalFind;
    assert.equal(db.getMeta("ios_import_v1"), before);
  } finally {
    db.close();
  }
});
test("dry run inventories a different archive without changing its saved import checkpoint", async () => {
  const { db, dir } = target();
  try {
    const path = source(dir, [{ pk: 1 }]);
    await importIos({ db, source: path });
    const before = db.getMeta("ios_import_v1");
    const archive = new (sqlite().DatabaseSync)(path);
    archive.exec("UPDATE ZWAMESSAGE SET ZTEXT='different';");
    archive.close();
    assert.equal((await importIos({ db, source: path, dryRun: true })).sourceRows, 1);
    assert.equal(db.getMeta("ios_import_v1"), before);
  } finally {
    db.close();
  }
});
test("null timestamps quarantine supported rows and unsupported types skip before validation", async () => {
  const { db, dir } = target();
  try {
    const path = source(dir, [{ pk: 1 }, { pk: 2, chat: 3, type: 14 }]);
    const archive = new (sqlite().DatabaseSync)(path);
    archive.exec("UPDATE ZWAMESSAGE SET ZMESSAGEDATE=NULL WHERE Z_PK=1;");
    archive.close();
    const report = await importIos({ db, source: path });
    assert.equal(report.inserted, 0);
    assert.equal(report.quarantineReasons.invalid_timestamp, 1);
    assert.equal(report.quarantined, 1);
    assert.equal(report.skippedByType[14], 1);
  } finally {
    db.close();
  }
});
test("resolved reply parents never accumulate in chunk checkpoints", async () => {
  const { db, dir } = target();
  try {
    const path = source(dir, [{ pk: 1 }, ...Array.from({ length: 502 }, (_, i) => ({ pk: i + 2, parent: 1 }))]);
    await importIos({
      db,
      source: path,
      afterChunk: () => {
        const progress = JSON.parse(db.getMeta("ios_import_v1"));
        assert.equal(progress.replies, undefined);
        assert.deepEqual(db.scanMeta(`ios_import_v2:${progress.generation}:reply:`), []);
      },
    });
    assert.equal(db.messages.get(`false_${PEER}_key503`).quotedSid, `false_${PEER}_key1`);
  } finally {
    db.close();
  }
});
test("missing voice skip file fails closed; empty file explicitly allows every voice", async () => {
  const { db, dir } = target();
  try {
    const path = source(dir, [{ pk: 1, type: 3, file: "note.opus" }]);
    writeFileSync(join(dir, "note.opus"), "audio");
    let calls = 0;
    const transcriber = async () => {
      calls++;
      return { text: "synthetic" };
    };
    unlinkSync(join(dir, "voice-skip.txt"));
    await importIos({ db, source: path, media: dir, transcriber });
    assert.equal(calls, 0);
    writeFileSync(join(dir, "voice-skip.txt"), "");
    assert.equal((await importIos({ db, source: path, media: dir, transcriber })).voice.transcribed, 1);
    assert.equal(calls, 1);
  } finally {
    db.close();
  }
});
test("permanent voice failures are recorded and not retried on rerun", async () => {
  const { db, dir } = target();
  try {
    const path = source(dir, [{ pk: 1, type: 3, file: "note.opus" }]);
    writeFileSync(join(dir, "note.opus"), "audio");
    writeFileSync(join(dir, "voice-skip.txt"), "");
    let calls = 0;
    const transcriber = async () => {
      calls++;
      throw markFailure(Error("private provider body"), "permanent", "audio refused");
    };
    const report = await importIos({ db, source: path, media: dir, transcriber });
    assert.equal(report.state, "done");
    assert.equal(report.voice.failed, 1);
    await importIos({ db, source: path, media: dir, transcriber });
    assert.equal(calls, 1);
    assert.doesNotMatch(db.getMeta("ios_import_v1"), /private provider body/);
  } finally {
    db.close();
  }
});
test("a transcript rejected by storage is not counted as persisted", async () => {
  const { db, dir } = target();
  try {
    const path = source(dir, [{ pk: 1, type: 3, file: "note.opus" }]);
    writeFileSync(join(dir, "note.opus"), "audio");
    writeFileSync(join(dir, "voice-skip.txt"), "");
    const report = await importIos({
      db,
      source: path,
      media: dir,
      transcriber: async () => {
        db.messages.tombstone(db.messages.get(`false_${PEER}_key1`).id, T0 + 2000);
        return { text: "synthetic" };
      },
    });
    assert.equal(report.voice.transcribed, 0);
    assert.equal(db.messages.get(`false_${PEER}_key1`), null);
  } finally {
    db.close();
  }
});
test("boot records an archive refusal and continues serving; invalid reset preserves import state", async (t) => {
  const { WhatsAppService } = await import("../dist/whatsapp.js");
  const { connectedService } = await import("./helpers.mjs");
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-ios-refusal-",
    id: ME,
    name: "Owner",
    config: { importIos: true, persistHistory: true },
  });
  t.after(() => svc.stop());
  await svc.storage.claimDatabase(ME);
  const folder = join(dirname(svc.databasePath), "import");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "ChatStorage.sqlite"), "not a sqlite database");
  await svc.bootStorage();
  assert.equal(svc.getStatus().storage.state, "ready");
  assert.equal((await svc.listChats("all", 20)).sync, "done");
  assert.equal(svc.db.getMeta("ios_import_error"), "source_not_database");
  const { runIosImport } = await import("../dist/ios-import/cli.js");
  const { parseCli } = await import("../dist/config.js");
  assert.equal(parseCli(["import", "ios", join(folder, "ChatStorage.sqlite"), "--reset"]).config.importReset, true);
  svc.db.setMeta("ios_import_v1", JSON.stringify({ hash: "old", last: 0, report: { state: "rows" } }));
  await svc.stop();
  await assert.rejects(
    runIosImport({
      ...svc.config,
      command: "import",
      args: ["ios", join(folder, "ChatStorage.sqlite")],
      importReset: true,
    })
  );
  const { AccountDb } = await import("../dist/db/index.js");
  const db = AccountDb.open(svc.databasePath);
  assert.equal(db.getMeta("ios_import_v1"), JSON.stringify({ hash: "old", last: 0, report: { state: "rows" } }));
  assert.equal(db.getMeta("ios_import_error"), "source_not_database");
  db.close();
});
test("boot completes text before connection and connected voice runs once in background", async (t) => {
  const { createServer } = await import("node:http");
  let calls = 0,
    release,
    arrived;
  const ready = new Promise((resolve) => {
    arrived = resolve;
  });
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
      /* Drain synthetic audio. */
    }
    calls++;
    release = () => res.end(JSON.stringify({ text: "synthetic" }));
    arrived();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const changes = {
    WAZAP_TRANSCRIBE: "openai",
    WAZAP_TRANSCRIBE_AUTO: "all",
    WAZAP_TRANSCRIBE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    WAZAP_TRANSCRIBE_API_KEY: "synthetic",
    WAZAP_TRANSCRIBE_ALLOW_API: "1",
  };
  const saved = Object.fromEntries(Object.keys(changes).map((k) => [k, process.env[k]]));
  Object.assign(process.env, changes);
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const { WhatsAppService } = await import("../dist/whatsapp.js");
  const { connectedService } = await import("./helpers.mjs");
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-ios-connect-",
    id: ME,
    name: "Owner",
    config: { importIos: true, persistHistory: true },
  });
  t.after(() => svc.stop());
  await svc.storage.claimDatabase(ME);
  svc.status = "disconnected";
  const folder = join(dirname(svc.databasePath), "import");
  mkdirSync(folder, { recursive: true });
  source(folder, [{ pk: 1, type: 3, file: "note.opus" }]);
  writeFileSync(join(folder, "note.opus"), "audio");
  const boot = svc.bootStorage();
  let timer;
  try {
    assert.equal(
      await Promise.race([
        boot.then(() => "ready"),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("blocked"), 3000);
        }),
      ]),
      "ready"
    );
  } finally {
    clearTimeout(timer);
  }
  assert.equal(calls, 0);
  assert.equal(svc.getStatus().storage.state, "ready");
  assert.equal(svc.db.counts().messages, 1);
  svc.storage.startImportVoice();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 0);
  svc.status = "connected";
  svc.storage.startImportVoice();
  svc.storage.startImportVoice();
  await ready;
  assert.equal(calls, 1);
  assert.equal(svc.getStatus().storage.state, "ready");
  assert.equal((await svc.readMessages(PEER, 20)).data.length, 1);
  release();
  await svc.storage.finishImport(1000);
  assert.equal(readIosReport(svc.db).voice.transcribed, 1);
});

test("transient voice failure remains resumable rather than becoming a terminal note", async () => {
  const { db, dir } = target();
  try {
    const path = source(dir, [{ pk: 1, type: 3, file: "note.opus" }]);
    writeFileSync(join(dir, "note.opus"), "audio");
    const first = await importIos({
      db,
      source: path,
      media: dir,
      transcriber: async () => {
        throw markFailure(Error("private"), "transient", "provider busy");
      },
    });
    assert.equal(first.state, "voice");
    const next = await importIos({ db, source: path, media: dir, transcriber: async () => ({ text: "recovered" }) });
    assert.equal(next.state, "done");
    assert.equal(next.voice.transcribed, 1);
    assert.equal(next.voice.failed, 0);
  } finally {
    db.close();
  }
});

for (const legacy of [false, true]) {
  test(`${legacy ? "legacy completed" : "persisted completed"} collision exclusions cannot transcribe an existing live row`, async () => {
    const fixture = target();
    let db = fixture.db;
    const dir = fixture.dir;
    try {
      db.messages.upsert(textMessage(PEER, "collision", T0, "live", { type: "voice" }));
      const path = source(dir, [
        { pk: 1, type: 3, key: "collision", file: "note.opus" },
        { pk: 2, type: 3, key: "collision", file: "note.opus" },
      ]);
      writeFileSync(join(dir, "note.opus"), "audio");
      await importIos({ db, source: path, textOnly: true });
      assert.equal(readIosReport(db).quarantineReasons.identity_collision, 2);
      if (legacy) {
        const progress = legacyProgress(db);
        delete progress.collisionRows;
        progress.collisionSids = [`false_${PEER}_collision`];
        db.setMeta("ios_import_v1", JSON.stringify(progress));
      }
      db.close();
      const { AccountDb } = await import("../dist/db/index.js");
      db = AccountDb.open(fixture.path);
      let calls = 0;
      const transcriber = async () => {
        calls++;
        return { text: "must not attach to live" };
      };
      await importIos({ db, source: path, media: dir, transcriber });
      await importIos({ db, source: path, media: dir, transcriber });
      assert.equal(calls, 0);
      assert.equal(db.messages.get(`false_${PEER}_collision`).transcript, null);
      if (legacy) assert.equal(db.getMeta("ios_import_error"), "voice_collision_exclusions_missing");
    } finally {
      db.close();
    }
  });
}
test("explicit reset reselects a changed archive without overwriting imported rows", async () => {
  const { db, dir, path: targetPath } = target();
  const archive = source(dir, [{ pk: 1 }]);
  await importIos({ db, source: archive });
  db.setMeta("ios_import_error", "source_changed");
  db.close();
  const raw = new (sqlite().DatabaseSync)(archive);
  raw.exec("UPDATE ZWAMESSAGE SET ZTEXT='changed archive';");
  raw.close();
  const { runIosImport } = await import("../dist/ios-import/cli.js");
  await runIosImport({
    dataDir: dir,
    persistHistory: true,
    readOnly: true,
    args: ["ios", archive],
    importReset: true,
    json: true,
  });
  const { AccountDb } = await import("../dist/db/index.js");
  const opened = AccountDb.open(targetPath);
  try {
    assert.equal(opened.getMeta("ios_import_error"), null);
    assert.equal(opened.messages.get(`false_${PEER}_key1`).text, "body");
    assert.equal(readIosReport(opened).skippedExisting, 1);
  } finally {
    opened.close();
  }
});
test("unsupported archive rows are counted before any identity quarantine", async () => {
  const { db, dir } = target();
  try {
    const path = source(dir, [{ pk: 1, chat: 3, type: 14 }]);
    const report = await importIos({ db, source: path });
    assert.equal(report.quarantined, 0);
    assert.equal(report.skippedByType[14], 1);
  } finally {
    db.close();
  }
});

for (const legacy of [false, true]) {
  test(`${legacy ? "SID-only legacy" : "source-row"} collision exclusions survive learnLidPhone and restart`, async () => {
    const fixture = target();
    let db = fixture.db;
    try {
      const lid = "123456789012345@lid";
      const live = textMessage(PEER, "collision", T0, "live", { type: "voice" });
      db.messages.upsert(live);
      const before = db.messages.get(live.sid, { includeHidden: true });
      const path = source(fixture.dir, [
        { pk: 1, type: 3, key: "collision", file: "note.opus" },
        { pk: 2, type: 3, key: "collision", file: "note.opus" },
      ]);
      const raw = new (sqlite().DatabaseSync)(path);
      raw.prepare("UPDATE ZWACHATSESSION SET ZCONTACTJID=? WHERE Z_PK=1").run(lid);
      raw.close();
      writeFileSync(join(fixture.dir, "note.opus"), "synthetic audio");
      await importIos({ db, source: path, textOnly: true });
      assert.equal(readIosReport(db).quarantineReasons.identity_collision, 2);
      if (legacy) {
        const progress = legacyProgress(db);
        delete progress.collisionRows;
        progress.collisionSids = [`false_${PEER}_collision`];
        db.setMeta("ios_import_v1", JSON.stringify(progress));
      }
      await db.learnLidPhone(lid, PEER);
      assert.equal(db.identity.canonicalJid(lid), PEER);
      db.close();
      const { AccountDb } = await import("../dist/db/index.js");
      db = AccountDb.open(fixture.path);
      let uploads = 0;
      const transcriber = async () => {
        uploads++;
        return { text: "ambiguous archive audio" };
      };
      await importIos({ db, source: path, media: fixture.dir, transcriber });
      await importIos({ db, source: path, media: fixture.dir, transcriber });
      assert.equal(uploads, 0);
      assert.deepEqual(db.messages.get(live.sid, { includeHidden: true }), before);
      if (legacy) assert.equal(db.getMeta("ios_import_error"), "voice_collision_exclusions_missing");
    } finally {
      db.close();
    }
  });
}
test("an archive response cannot overwrite a transcript stored while the upload was pending", async () => {
  const { db, dir } = target();
  try {
    const path = source(dir, [{ pk: 1, type: 3, file: "note.opus" }]);
    writeFileSync(join(dir, "note.opus"), "audio");
    let live;
    const report = await importIos({
      db,
      source: path,
      media: dir,
      transcriber: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        db.messages.setTranscript(`false_${PEER}_key1`, "live transcript", { provider: "local", at: T0 });
        live = db.messages.get(`false_${PEER}_key1`, { includeHidden: true });
        return { text: "late archive transcript" };
      },
    });
    assert.deepEqual(db.messages.get(`false_${PEER}_key1`, { includeHidden: true }), live);
    assert.equal(report.voice.transcribed, 0);
  } finally {
    db.close();
  }
});
for (const running of [false, true]) {
  test(`archive voice does not duplicate the normal ${running ? "inflight" : "queued"} live job`, async () => {
    const { db, dir } = target();
    try {
      const input = textMessage(PEER, "key1", T0, "live", { type: "voice" });
      const message = db.messages.upsert(input);
      db.transcripts.enqueue(input.sid, "api");
      if (running) db.transcripts.claim(message.id);
      const path = source(dir, [{ pk: 1, type: 3, file: "note.opus" }]);
      writeFileSync(join(dir, "note.opus"), "audio");
      let calls = 0;
      await importIos({
        db,
        source: path,
        media: dir,
        background: true,
        transcriber: async () => {
          calls++;
          return { text: "duplicate" };
        },
      });
      assert.equal(calls, 0);
      assert.equal(db.messages.get(input.sid).transcript, null);
      assert.equal(db.transcripts.state(input.sid).state, "queued");
    } finally {
      db.close();
    }
  });
}
test("a background archive transcript wakes an idle embedding feed before the next upload finishes", async (t) => {
  const { createServer } = await import("node:http");
  const { EmbedFeed } = await import("../dist/recall/index.js");
  const { WhatsAppService } = await import("../dist/whatsapp.js");
  const { connectedService, waitFor } = await import("./helpers.mjs");
  const pending = [];
  let arrived;
  const ready = new Promise((resolve) => {
    arrived = resolve;
  });
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
      /*Drain synthetic upload.*/
    }
    pending.push(res);
    if (pending.length === 2) arrived();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const changes = {
    WAZAP_RECALL: "off",
    WAZAP_TRANSCRIBE: "openai",
    WAZAP_TRANSCRIBE_AUTO: "all",
    WAZAP_TRANSCRIBE_API_KEY: "synthetic",
    WAZAP_TRANSCRIBE_ALLOW_API: "1",
    WAZAP_TRANSCRIBE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  };
  const saved = Object.fromEntries(Object.keys(changes).map((k) => [k, process.env[k]]));
  Object.assign(process.env, changes);
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-ios-embed-wake-",
    id: ME,
    name: "Owner",
    config: { importIos: true, persistHistory: true },
  });
  t.after(() => svc.stop());
  await svc.storage.claimDatabase(ME);
  const folder = join(dirname(svc.databasePath), "import");
  mkdirSync(folder, { recursive: true });
  source(folder, [
    { pk: 1, type: 3, file: "one.opus" },
    { pk: 2, type: 3, file: "two.opus" },
  ]);
  writeFileSync(join(folder, "one.opus"), "audio");
  writeFileSync(join(folder, "two.opus"), "audio");
  const feed = new EmbedFeed({
    db: () => svc.db,
    model: "synthetic-wake",
    words: (message) => message.transcript,
    embed: async (texts) => texts.map(() => [1]),
  });
  svc.recallIndex.embedFeed = feed;
  await svc.bootStorage();
  await feed.idle();
  assert.equal(svc.db.vectors.count("synthetic-wake"), 0);
  svc.storage.startImportVoice();
  await ready;
  try {
    pending[0].end(JSON.stringify({ text: "first synthetic transcript" }));
    await waitFor(() => svc.db.vectors.count("synthetic-wake") === 1, 1000, "archive transcript wakes idle feed");
    assert.equal(pending[1].writableEnded, false);
  } finally {
    for (const response of pending)
      if (!response.writableEnded) response.end(JSON.stringify({ text: "second synthetic transcript" }));
    await svc.storage.finishImport(1000);
    await feed.idle();
  }
});

test("background archive leaves an unqueued raw live voice to AccountVoice", async () => {
  const { db, dir } = target();
  try {
    const input = textMessage(PEER, "key1", T0, "live", { type: "voice" });
    db.messages.upsert(input);
    const path = source(dir, [{ pk: 1, type: 3, file: "note.opus" }]);
    writeFileSync(join(dir, "note.opus"), "audio");
    let calls = 0;
    await importIos({
      db,
      source: path,
      media: dir,
      background: true,
      transcriber: async () => {
        calls++;
        return { text: "duplicate" };
      },
    });
    assert.equal(calls, 0);
    assert.equal(db.messages.get(input.sid).transcript, null);
  } finally {
    db.close();
  }
});
test("explicit desktop CLI still transcribes a raw live overlap under its writer lock", async (t) => {
  const { createServer } = await import("node:http");
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
      /*Drain synthetic audio.*/
    }
    calls++;
    res.end(JSON.stringify({ text: "explicit archive transcript" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const changes = {
    WAZAP_TRANSCRIBE: "openai",
    WAZAP_TRANSCRIBE_AUTO: "0",
    WAZAP_TRANSCRIBE_API_KEY: "synthetic",
    WAZAP_TRANSCRIBE_ALLOW_API: "1",
    WAZAP_TRANSCRIBE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  };
  const saved = Object.fromEntries(Object.keys(changes).map((k) => [k, process.env[k]]));
  Object.assign(process.env, changes);
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const { db, dir, path: targetPath } = target();
  const input = textMessage(PEER, "key1", T0, "live", { type: "voice" });
  db.messages.upsert(input);
  db.close();
  const archive = source(dir, [{ pk: 1, type: 3, file: "note.opus" }]);
  writeFileSync(join(dir, "note.opus"), "audio");
  const { runIosImport } = await import("../dist/ios-import/cli.js");
  await runIosImport({
    dataDir: dir,
    persistHistory: true,
    readOnly: true,
    args: ["ios", archive],
    importMedia: dir,
    json: true,
  });
  const { AccountDb } = await import("../dist/db/index.js");
  const reopened = AccountDb.open(targetPath);
  try {
    const message = reopened.messages.get(input.sid);
    assert.equal(message.transcript, "explicit archive transcript");
    assert.deepEqual(message.raw, input.raw);
    assert.equal(calls, 1);
  } finally {
    reopened.close();
  }
});
for (const legacy of [false, true]) {
  test(`${legacy ? "legacy SID-only" : "source-row"} permanent voice failure stays excluded after learnLidPhone and restart`, async () => {
    const fixture = target();
    let db = fixture.db;
    try {
      const lid = "123456789012345@lid",
        path = source(fixture.dir, [{ pk: 1, type: 3, file: "note.opus" }]);
      const raw = new (sqlite().DatabaseSync)(path);
      raw.prepare("UPDATE ZWACHATSESSION SET ZCONTACTJID=? WHERE Z_PK=1").run(lid);
      raw.close();
      writeFileSync(join(fixture.dir, "note.opus"), "audio");
      let calls = 0;
      const transcriber = async () => {
        calls++;
        throw markFailure(Error("private body"), "permanent", "audio refused");
      };
      await importIos({ db, source: path, media: fixture.dir, transcriber });
      assert.equal(calls, 1);
      assert.equal(readIosReport(db).state, "done");
      if (legacy) {
        const progress = legacyProgress(db);
        delete progress.voiceFailureRows;
        progress.voiceFailures = { [`false_${lid}_key1`]: "permanent" };
        db.setMeta("ios_import_v1", JSON.stringify(progress));
      }
      await db.learnLidPhone(lid, PEER);
      db.close();
      const { AccountDb } = await import("../dist/db/index.js");
      db = AccountDb.open(fixture.path);
      await importIos({ db, source: path, media: fixture.dir, transcriber });
      assert.equal(calls, 1);
      assert.equal(db.messages.get(`false_${PEER}_key1`).transcript, null);
      if (legacy) assert.equal(db.getMeta("ios_import_error"), "voice_failure_exclusions_missing");
    } finally {
      db.close();
    }
  });
}
test("distinct source voice rows keep original targets across physical reopen and LID fold", async () => {
  const fixture = target();
  let db = fixture.db;
  try {
    const lid = "123456789012345@lid";
    const path = source(fixture.dir, [
      { pk: 1, type: 3, key: "same", file: "lid.opus" },
      { pk: 2, chat: 2, type: 3, key: "same", file: "phone.opus" },
    ]);
    const raw = new (sqlite().DatabaseSync)(path);
    raw.prepare("UPDATE ZWACHATSESSION SET ZCONTACTJID=? WHERE Z_PK=1").run(lid);
    raw.prepare("UPDATE ZWACHATSESSION SET ZCONTACTJID=?,ZGROUPINFO=NULL WHERE Z_PK=2").run(PEER);
    raw.close();
    writeFileSync(join(fixture.dir, "lid.opus"), "lid audio");
    writeFileSync(join(fixture.dir, "phone.opus"), "phone audio");
    const text = await importIos({ db, source: path, textOnly: true });
    assert.equal(text.inserted, 2);
    assert.equal(text.quarantined, 0);
    const phoneId = db.messages.get(`false_${PEER}_same`).id;
    db.close();
    const { AccountDb } = await import("../dist/db/index.js");
    db = AccountDb.open(fixture.path);
    await db.learnLidPhone(lid, PEER);
    assert.equal(db.messages.get(`false_${PEER}_same`).id, phoneId);
    db.close();
    db = AccountDb.open(fixture.path);
    const uploads = [];
    await importIos({
      db,
      source: path,
      media: fixture.dir,
      transcriber: async (file) => {
        const name = file.split("/").at(-1);
        uploads.push(name);
        return { text: name };
      },
    });
    assert.deepEqual(uploads, ["phone.opus"]);
    assert.equal(db.messages.get(`false_${PEER}_same`).transcript, "phone.opus");
  } finally {
    db.close();
  }
});
test("voice target bindings commit with chunks and survive interruption and physical reopen", async () => {
  const fixture = target();
  let db = fixture.db;
  const writes = [];
  const watch = (targetDb) => {
    const setMeta = targetDb.setMeta.bind(targetDb);
    targetDb.setMeta = (key, value) => {
      if (key.startsWith("ios_import_v2:") && key.includes(":voice:") && value !== null)
        writes.push({ entries: Object.keys(JSON.parse(value)).length, bytes: Buffer.byteLength(value) });
      return setMeta(key, value);
    };
  };
  watch(db);
  try {
    const path = source(
      fixture.dir,
      Array.from({ length: 503 }, (_, i) => ({
        pk: i + 1,
        ...([1, 501].includes(i + 1) ? { type: 3, file: `note${i + 1}.opus` } : {}),
      }))
    );
    for (const pk of [1, 501]) writeFileSync(join(fixture.dir, `note${pk}.opus`), "audio");
    await assert.rejects(
      importIos({
        db,
        source: path,
        afterChunk: () => {
          throw Error("interrupted");
        },
      }),
      /interrupted/
    );
    const targets = voiceEntries(db);
    assert.equal(targets[1].id, db.messages.get(`false_${PEER}_key1`).id);
    assert.equal(targets[501], undefined);
    db.close();
    const { AccountDb } = await import("../dist/db/index.js");
    db = AccountDb.open(fixture.path);
    watch(db);
    let calls = 0;
    await importIos({
      db,
      source: path,
      media: fixture.dir,
      transcriber: async () => {
        calls++;
        return { text: "synthetic" };
      },
    });
    assert.equal(calls, 2);
    assert.equal(db.counts().messages, 503);
    const persisted = voiceEntries(db);
    assert.equal(Object.keys(persisted).length, 2);
    assert.equal(persisted[1].id, targets[1].id);
    assert.equal(persisted[501].id, db.messages.get(`false_${PEER}_key501`).id);
    assert.equal(db.messages.get(`false_${PEER}_key1`).transcript, "synthetic");
    assert.equal(db.messages.get(`false_${PEER}_key501`).transcript, "synthetic");
    assert.ok(writes.length > 0);
    assert.ok(writes.every((row) => row.entries <= 500));
  } finally {
    db.close();
  }
});
test("legacy completed voice without original target bindings fails closed without reconstructing targets", async () => {
  const { db, dir } = target();
  try {
    const path = source(dir, [{ pk: 1, type: 3, file: "note.opus" }]);
    writeFileSync(join(dir, "note.opus"), "audio");
    await importIos({ db, source: path, textOnly: true });
    const progress = legacyProgress(db);
    delete progress.voiceBindings;
    db.setMeta("ios_import_v1", JSON.stringify(progress));
    db.setMeta("ios_voice_targets_v1", null);
    db.messages.get = () => {
      throw Error("must not reconstruct original target bindings");
    };
    let calls = 0;
    await importIos({
      db,
      source: path,
      media: dir,
      transcriber: async () => {
        calls++;
        return { text: "unsafe" };
      },
    });
    assert.equal(calls, 0);
    assert.equal(db.getMeta("ios_import_error"), "voice_target_bindings_missing");
  } finally {
    db.close();
  }
});
test("invalid reset source preserves existing voice binding state", async () => {
  const { db, dir, path: targetPath } = target();
  db.setMeta("ios_voice_targets_v1", JSON.stringify({ 999: 123 }));
  db.setMeta("unrelated", "preserved");
  db.close();
  const path = join(dir, "wrong.sqlite");
  writeFileSync(path, "not sqlite");
  const { runIosImport } = await import("../dist/ios-import/cli.js");
  await assert.rejects(
    runIosImport({ dataDir: dir, persistHistory: true, readOnly: true, args: ["ios", path], importReset: true })
  );
  const { AccountDb } = await import("../dist/db/index.js");
  const reopened = AccountDb.open(targetPath);
  try {
    assert.equal(reopened.getMeta("ios_voice_targets_v1"), JSON.stringify({ 999: 123 }));
    assert.equal(reopened.getMeta("unrelated"), "preserved");
  } finally {
    reopened.close();
  }
});

test("target binding writes and rows roll back when their chunk checkpoint fails", async () => {
  const { db, dir } = target();
  const setMeta = db.setMeta.bind(db);
  try {
    const path = source(dir, [{ pk: 1, type: 3, file: "note.opus" }]);
    let rejected = false;
    db.setMeta = (key, value) => {
      if (key === "ios_import_v1" && !rejected) {
        rejected = true;
        throw Error("checkpoint failed");
      }
      return setMeta(key, value);
    };
    await assert.rejects(importIos({ db, source: path, textOnly: true }), /checkpoint failed/);
    assert.equal(db.counts().messages, 0);
    assert.equal(db.getMeta("ios_import_v1"), null);
    assert.equal(db.getMeta("ios_voice_targets_v1"), null);
    db.setMeta = setMeta;
    await importIos({ db, source: path, textOnly: true });
    assert.equal(Object.keys(voiceEntries(db)).length, 1);
  } finally {
    db.setMeta = setMeta;
    db.close();
  }
});
test("legacy interrupted text resumes rows but cannot invent bindings for its earlier chunk", async () => {
  const fixture = target();
  let db = fixture.db;
  try {
    const path = source(
      fixture.dir,
      Array.from({ length: 503 }, (_, i) => ({
        pk: i + 1,
        ...([1, 501].includes(i + 1) ? { type: 3, file: `note${i + 1}.opus` } : {}),
      }))
    );
    for (const pk of [1, 501]) writeFileSync(join(fixture.dir, `note${pk}.opus`), "audio");
    await assert.rejects(
      importIos({
        db,
        source: path,
        afterChunk: () => {
          throw Error("interrupted");
        },
      }),
      /interrupted/
    );
    const progress = legacyProgress(db);
    delete progress.voiceBindings;
    db.setMeta("ios_import_v1", JSON.stringify(progress));
    db.close();
    const { AccountDb } = await import("../dist/db/index.js");
    db = AccountDb.open(fixture.path);
    let calls = 0;
    await importIos({
      db,
      source: path,
      media: fixture.dir,
      transcriber: async () => {
        calls++;
        return { text: "must not guess" };
      },
    });
    assert.equal(calls, 0);
    assert.equal(db.counts().messages, 503);
    assert.equal(db.getMeta("ios_import_error"), "voice_target_bindings_missing");
  } finally {
    db.close();
  }
});

for (const phase of ["voice", "done"]) {
  test(`changed archive media path is refused before resumed ${phase} voice or label repair`, async () => {
    const { db, dir } = target();
    try {
      const path = source(dir, [{ pk: 1, type: 3, file: "original.opus" }]);
      writeFileSync(join(dir, "original.opus"), "original audio");
      writeFileSync(join(dir, "replacement.opus"), "replacement audio");
      await importIos({ db, source: path, textOnly: true });
      if (phase === "done") {
        await importIos({ db, source: path, media: dir, transcriber: async () => ({ text: "original transcript" }) });
      }
      assert.equal(readIosReport(db).state, phase);
      const checkpoint = db.getMeta("ios_import_v1");
      const bindings = voiceEntries(db);
      const row = db.messages.get(`false_${PEER}_key1`);
      db.identity.upsertChat({ jid: PEER, name: null });
      db.identity.upsertContact({ jid: PEER, name: null });
      const archive = new (sqlite().DatabaseSync)(path);
      archive.exec("UPDATE ZWAMEDIAITEM SET ZMEDIALOCALPATH='replacement.opus' WHERE Z_PK=1;");
      archive.close();
      let uploads = 0;
      await assert.rejects(
        importIos({
          db,
          source: path,
          media: dir,
          transcriber: async () => {
            uploads++;
            return { text: "wrong audio" };
          },
        }),
        /The iPhone archive changed since this import began\./
      );
      assert.equal(uploads, 0);
      assert.deepEqual(db.messages.get(row.sid), row);
      assert.equal(db.getMeta("ios_import_v1"), checkpoint);
      assert.deepEqual(voiceEntries(db), bindings);
      assert.equal(db.identity.chat(PEER).name, null);
      assert.equal(db.identity.contact(PEER).name, null);
    } finally {
      db.close();
    }
  });
}

async function importSafetyFixture(
  t,
  { policy = "account", allowApi = false, command = "serve", voices = 1, hold = false, automatic = true } = {}
) {
  const { createServer } = await import("node:http");
  const { WhatsAppService } = await import("../dist/whatsapp.js");
  const { connectedService } = await import("./helpers.mjs");
  const { AccountRegistry } = await import("../dist/accounts.js");
  let calls = 0;
  const responses = [];
  let arrive;
  const ready = new Promise((resolve) => {
    arrive = resolve;
  });
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
      /* Drain synthetic audio only. */
    }
    calls++;
    responses.push(res);
    if (calls === Math.min(3, voices)) arrive();
    if (!hold || calls > 3) res.end(JSON.stringify({ text: "synthetic importer safety transcript" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const changes = {
    WAZAP_TRANSCRIBE: "openai",
    WAZAP_TRANSCRIBE_AUTO: "1",
    WAZAP_TRANSCRIBE_ALLOW_API: allowApi ? "1" : "0",
    WAZAP_TRANSCRIBE_API_KEY: "synthetic-import-safety-key",
    WAZAP_TRANSCRIBE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  };
  const saved = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  let svc;
  t.after(async () => {
    svc?.storage.stopImport();
    for (const res of responses)
      if (!res.writableEnded) res.end(JSON.stringify({ text: "synthetic importer safety transcript" }));
    await svc?.stop();
    server.closeAllConnections();
    server.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  ({ svc } = connectedService(WhatsAppService, {
    prefix: "wazap-ios-safety-",
    id: ME,
    name: "Owner",
    config: { persistHistory: true, readOnly: policy === "global", command, importIos: automatic },
    account: { id: "default", name: "Owner", enabled: true, owner: ME, writes: policy !== "account" },
  }));
  AccountRegistry.load(svc.config.dataDir).setWrites("default", policy !== "account");
  await svc.storage.claimDatabase(ME);
  const folder = join(dirname(svc.databasePath), "import");
  mkdirSync(folder, { recursive: true });
  const rows = Array.from({ length: voices }, (_, i) => ({ pk: i + 1, type: 3, file: `note${i}.opus` }));
  const archive = source(folder, rows);
  for (const row of rows) writeFileSync(join(folder, row.file), "synthetic audio");
  return { svc, folder, archive, responses, ready, calls: () => calls };
}

for (const entry of ["boot", "cli"]) {
  for (const policy of ["global", "account"]) {
    for (const allowApi of [false, true]) {
      test(`import safety: ${entry} ${policy} read-only ${allowApi ? "allows explicit API consent" : "refuses unapproved API uploads"}`, async (t) => {
        const fixture = await importSafetyFixture(t, { policy, allowApi });
        const { svc, folder, archive } = fixture;
        await svc.bootStorage();
        if (entry === "boot") {
          svc.storage.startImportVoice();
          await svc.storage.iosImport;
        } else {
          const { runIosImport } = await import("../dist/ios-import/cli.js");
          await svc.stop();
          await runIosImport({
            ...svc.config,
            command: "import",
            args: ["ios", archive],
            importMedia: folder,
            json: true,
          });
        }
        assert.equal(fixture.calls(), allowApi ? 1 : 0);
        const { AccountDb } = await import("../dist/db/index.js");
        const read = AccountDb.open(svc.databasePath, { readOnly: true });
        try {
          assert.equal(
            read.messages.get(`false_${PEER}_key1`).transcript,
            allowApi ? "synthetic importer safety transcript" : null
          );
        } finally {
          read.close();
        }
      });
    }
  }
}

for (const command of ["status", "contacts", "serve"]) {
  test(`import safety: ${command} ${command === "serve" ? "starts" : "does not start"} background archive uploads`, async (t) => {
    const fixture = await importSafetyFixture(t, { policy: "writable", command });
    await fixture.svc.bootStorage();
    fixture.svc.storage.startImportVoice();
    await fixture.svc.storage.iosImport;
    assert.equal(fixture.calls(), command === "serve" ? 1 : 0);
  });
}

for (const imported of [false, true]) {
  test(`import ownership: ${imported ? "imported" : "never imported"} archive stays paused across a new owner and restart`, async (t) => {
    const { WhatsAppService } = await import("../dist/whatsapp.js");
    const { connectedService } = await import("./helpers.mjs");
    const { AccountDb } = await import("../dist/db/index.js");
    const { readdirSync } = await import("node:fs");
    const fixture = await importSafetyFixture(t, { policy: "writable" });
    const first = fixture.svc;
    if (imported) await first.bootStorage();
    else {
      const { existsSync } = await import("node:fs");
      const marker = join(dirname(first.databasePath), "ios-import-binding.json");
      if (existsSync(marker)) unlinkSync(marker);
    }
    const before = first.db.getMeta("ios_import_v1");
    const dataDir = first.config.dataDir;
    const root = dirname(first.databasePath);
    await first.stop();
    const other = "40700000077@s.whatsapp.net";
    const next = connectedService(WhatsAppService, {
      prefix: "wazap-ios-owner-",
      id: other,
      name: "Other",
      config: { ...first.config, dataDir },
    }).svc;
    t.after(() => next.stop());
    await next.storage.claimDatabase(other);
    await next.bootStorage();
    assert.equal(
      next.db.messages.get(`false_${PEER}_key1`),
      null,
      "old archive text must not enter a new owner's database"
    );
    next.storage.startImportVoice();
    await next.storage.iosImport;
    assert.equal(fixture.calls(), 0);
    assert.equal(next.getStatus().storage.ios_import_error, "archive_selection_required");
    await next.stop();
    const restarted = connectedService(WhatsAppService, {
      prefix: "wazap-ios-owner-",
      id: other,
      name: "Other",
      config: { ...first.config, dataDir },
    }).svc;
    t.after(() => restarted.stop());
    await restarted.storage.claimDatabase(other);
    await restarted.bootStorage();
    restarted.storage.startImportVoice();
    await restarted.storage.iosImport;
    assert.equal(restarted.db.messages.get(`false_${PEER}_key1`), null, "the ownership barrier must survive restart");
    assert.equal(fixture.calls(), 0);
    await restarted.stop();
    const aside = readdirSync(root).find((name) => /^wazap\.\d+\.previous-owner\.sqlite$/.test(name));
    const old = AccountDb.open(join(root, aside), { readOnly: true });
    try {
      assert.equal(old.getMeta("ios_import_v1"), before, "the previous owner's progress remains intact");
    } finally {
      old.close();
    }
    if (imported) {
      const restored = connectedService(WhatsAppService, {
        prefix: "wazap-ios-owner-",
        id: ME,
        name: "Owner",
        config: { ...first.config, dataDir },
      }).svc;
      t.after(() => restored.stop());
      await restored.storage.claimDatabase(ME);
      await restored.bootStorage();
      assert.equal(restored.db.getMeta("ios_import_v1"), before);
      restored.storage.startImportVoice();
      await restored.storage.iosImport;
      assert.equal(fixture.calls(), 1, "the original owner can resume its own voice import");
    }
  });
}

test("import ownership: corrupt selection pauses text and voice without changing the archive", async (t) => {
  const fixture = await importSafetyFixture(t, { policy: "writable" });
  const original = readFileSync(fixture.archive);
  writeFileSync(join(dirname(fixture.svc.databasePath), "ios-import-binding.json"), "not json");
  await fixture.svc.bootStorage();
  fixture.svc.storage.startImportVoice();
  await fixture.svc.storage.iosImport;
  assert.equal(fixture.svc.db.messages.get(`false_${PEER}_key1`), null);
  assert.equal(fixture.calls(), 0);
  assert.equal(fixture.svc.getStatus().storage.ios_import_error, "archive_selection_required");
  assert.deepEqual(readFileSync(fixture.archive), original);
});

test("import ownership: changed completed source is refused before repairing names", async () => {
  const { db, dir } = target();
  try {
    const path = source(dir, [{ pk: 1 }]);
    await importIos({ db, source: path });
    const before = db.getMeta("ios_import_v1");
    db.identity.upsertChat({ jid: PEER, name: null });
    const changed = new (sqlite().DatabaseSync)(path);
    changed.exec("UPDATE ZWACHATSESSION SET ZPARTNERNAME='Different archive';");
    changed.close();
    await assert.rejects(importIos({ db, source: path }), /archive.*changed|archive.*select/i);
    assert.equal(db.identity.chat(PEER).name, null);
    assert.equal(db.getMeta("ios_import_v1"), before);
  } finally {
    db.close();
  }
});

for (const allowApi of [false, true]) {
  test(`import ownership: explicit reset reselects for the new owner ${allowApi ? "with" : "without"} API consent`, async (t) => {
    const { WhatsAppService } = await import("../dist/whatsapp.js");
    const { connectedService } = await import("./helpers.mjs");
    const { runIosImport } = await import("../dist/ios-import/cli.js");
    const { AccountDb } = await import("../dist/db/index.js");
    const fixture = await importSafetyFixture(t, { allowApi });
    await fixture.svc.bootStorage();
    await fixture.svc.stop();
    const other = "40700000077@s.whatsapp.net";
    const next = connectedService(WhatsAppService, {
      prefix: "wazap-ios-reselect-",
      id: other,
      name: "Other",
      config: fixture.svc.config,
      account: { id: "default", name: "Other", enabled: true, owner: other, writes: false },
    }).svc;
    t.after(() => next.stop());
    await next.storage.claimDatabase(other);
    await next.bootStorage();
    assert.equal(next.db.messages.get(`false_${PEER}_key1`), null);
    const config = {
      ...next.config,
      command: "import",
      args: ["ios", fixture.archive],
      importMedia: fixture.folder,
      json: true,
    };
    await next.stop();
    await assert.rejects(runIosImport(config), /Select the iPhone archive/);
    assert.equal(fixture.calls(), 0);
    await runIosImport({ ...config, importReset: true });
    const read = AccountDb.open(next.databasePath, { readOnly: true });
    try {
      assert.equal(read.getMeta("owner"), other);
      assert.equal(
        read.messages.get(`false_${PEER}_key1`).transcript,
        allowApi ? "synthetic importer safety transcript" : null
      );
    } finally {
      read.close();
    }
    assert.equal(fixture.calls(), allowApi ? 1 : 0, "reset cannot bypass the account's API permission");
  });
}

test(
  "import ownership: account rotation drains accepted uploads into the old database and starts no new ones",
  { timeout: 10000 },
  async (t) => {
    const { AccountDb } = await import("../dist/db/index.js");
    const { readdirSync } = await import("node:fs");
    const fixture = await importSafetyFixture(t, { policy: "writable", voices: 4, hold: true });
    await fixture.svc.bootStorage();
    const old = fixture.svc.db;
    const root = dirname(fixture.svc.databasePath);
    fixture.svc.storage.startImportVoice();
    await fixture.ready;
    const claim = fixture.svc.storage.claimDatabase("40700000077@s.whatsapp.net");
    await new Promise((resolve) => setImmediate(resolve));
    const keptOpen = old.isOpen;
    let blocked = false;
    try {
      void fixture.svc.db;
    } catch (err) {
      blocked = err.code === "NOT_CONNECTED";
    }
    for (const response of fixture.responses)
      response.end(JSON.stringify({ text: "synthetic accepted old-owner transcript" }));
    await claim;
    assert.equal(keptOpen, true, "accepted paid results settle before the old database closes");
    assert.equal(blocked, true, "reads cannot expose the old owner's rows during the switch");
    assert.equal(fixture.calls(), 3, "the fourth upload must not start after owner change begins");
    assert.equal(fixture.svc.db.counts().messages, 0);
    const aside = readdirSync(root).find((name) => /^wazap\.\d+\.previous-owner\.sqlite$/.test(name));
    const previous = AccountDb.open(join(root, aside), { readOnly: true });
    try {
      assert.equal(previous.getMeta("owner"), ME);
      assert.equal(
        previous.connection.db.prepare("SELECT count(*) n FROM messages WHERE transcript IS NOT NULL").get().n,
        3
      );
      assert.equal(JSON.parse(previous.getMeta("ios_import_v1")).report.state, "voice");
    } finally {
      previous.close();
    }
  }
);

test(
  "import ownership: a failed ownership barrier still stops scheduling archive uploads",
  { timeout: 10000 },
  async (t) => {
    const fixture = await importSafetyFixture(t, { policy: "writable", voices: 4, hold: true });
    await fixture.svc.bootStorage();
    const old = fixture.svc.db;
    fixture.svc.storage.startImportVoice();
    await fixture.ready;
    const marker = join(dirname(fixture.svc.databasePath), "ios-import-binding.json");
    unlinkSync(marker);
    mkdirSync(marker);
    await fixture.svc.storage.claimDatabase("40700000077@s.whatsapp.net");
    for (const response of fixture.responses)
      response.end(JSON.stringify({ text: "synthetic accepted old-owner transcript" }));
    await fixture.svc.storage.iosImport;
    assert.equal(fixture.calls(), 3, "an ownership barrier error must not permit a fourth upload");
    assert.equal(old.isOpen, true);
    assert.equal(old.getMeta("owner"), ME, "failed persistence must prevent database replacement");
  }
);

for (const refusal of ["reply", "collision", "failure"]) {
  test(`boot preserves the actionable legacy ${refusal} refusal and blocks background voice`, async (t) => {
    const fixture = await importSafetyFixture(t, { policy: "writable" });
    const { svc, archive } = fixture;
    await importIos({ db: svc.db, source: archive, textOnly: true });
    const legacy = legacyProgress(svc.db);
    let reason;
    if (refusal === "reply") {
      legacy.replies = [{ child: `false_${PEER}_key1`, parent: 1 }];
      reason = "legacy_reply_bindings_missing";
    } else if (refusal === "collision") {
      delete legacy.collisionRows;
      legacy.report.quarantineReasons.identity_collision = 1;
      reason = "voice_collision_exclusions_missing";
    } else {
      delete legacy.voiceFailureRows;
      legacy.voiceFailures = { [`false_${PEER}_key1`]: "permanent" };
      reason = "voice_failure_exclusions_missing";
    }
    const progress = JSON.stringify(legacy);
    svc.db.setMeta("ios_import_v1", progress);
    svc.db.setMeta("ios_import_error", "source_changed");
    await svc.bootStorage();
    assert.equal(svc.getStatus().storage.state, "ready");
    assert.equal(svc.getStatus().storage.ios_import_error, reason);
    assert.equal(svc.db.getMeta("ios_import_v1"), progress);
    svc.storage.startImportVoice();
    assert.equal(svc.storage.iosImport, null);
    assert.equal(fixture.calls(), 0);
  });
}

test("a successful boot retry clears a stale source refusal and permits background voice", async (t) => {
  const fixture = await importSafetyFixture(t, { policy: "writable" });
  fixture.svc.db.setMeta("ios_import_error", "source_incomplete");
  await fixture.svc.bootStorage();
  assert.equal(fixture.svc.getStatus().storage.ios_import_error, undefined);
  fixture.svc.storage.startImportVoice();
  await fixture.svc.storage.iosImport;
  assert.equal(fixture.calls(), 1);
});

test("disabled automatic importer ignores a dropped archive and allocates no ownership file or worker", async (t) => {
  const { existsSync, readdirSync } = await import("node:fs");
  const fixture = await importSafetyFixture(t, { policy: "writable", automatic: false });
  const { svc, archive, folder } = fixture;
  const before = readFileSync(archive);
  const files = readdirSync(folder);
  assert.equal(existsSync(join(dirname(svc.databasePath), "ios-import-binding.json")), false);
  await svc.bootStorage();
  svc.storage.startImportVoice();
  assert.equal(svc.getStatus().storage.state, "ready");
  assert.equal(svc.db.getMeta("ios_import_v1"), null);
  assert.equal(svc.db.getMeta("ios_import_error"), null);
  assert.equal(svc.db.messages.get(`false_${PEER}_key1`), null);
  assert.equal(svc.storage.iosImport, null);
  assert.equal(svc.storage.iosAbort, null);
  assert.equal(fixture.calls(), 0);
  assert.deepEqual(readFileSync(archive), before);
  assert.deepEqual(readdirSync(folder), files);
});

for (const selected of [false, true]) {
  test(`disabled owner rotation preserves ${selected ? "existing" : "missing"} selection and re-enable refuses the prior archive`, async (t) => {
    const { existsSync } = await import("node:fs");
    const { WhatsAppService } = await import("../dist/whatsapp.js");
    const { connectedService } = await import("./helpers.mjs");
    const fixture = await importSafetyFixture(t, { policy: "writable", automatic: false });
    const { svc, archive } = fixture;
    const marker = join(dirname(svc.databasePath), "ios-import-binding.json");
    if (selected) await importIos({ db: svc.db, source: archive, explicit: true, textOnly: true });
    const before = selected ? readFileSync(marker) : null;
    if (!selected) assert.equal(existsSync(marker), false);
    const other = "40700000088@s.whatsapp.net";
    await svc.storage.claimDatabase(other);
    await svc.bootStorage();
    assert.equal(svc.db.getMeta("ios_import_v1"), null);
    assert.equal(svc.db.getMeta("ios_import_error"), null);
    if (selected) assert.deepEqual(readFileSync(marker), before);
    else assert.equal(existsSync(marker), false);
    await svc.stop();
    const next = connectedService(WhatsAppService, {
      prefix: "wazap-ios-optin-other-",
      id: other,
      name: "Other",
      config: { ...svc.config, importIos: true },
    }).svc;
    t.after(() => next.stop());
    await next.storage.claimDatabase(other);
    await next.bootStorage();
    assert.equal(next.getStatus().storage.ios_import_error, "archive_selection_required");
    assert.equal(next.db.messages.get(`false_${PEER}_key1`), null);
    next.storage.startImportVoice();
    assert.equal(fixture.calls(), 0);
  });
}

test("explicit CLI import remains available with automatic import disabled and disabled boot preserves its state", async (t) => {
  const fixture = await importSafetyFixture(t, { policy: "writable", automatic: false });
  const { svc, archive, folder } = fixture;
  const { runIosImport } = await import("../dist/ios-import/cli.js");
  const { AccountDb } = await import("../dist/db/index.js");
  const { WhatsAppService } = await import("../dist/whatsapp.js");
  const { connectedService } = await import("./helpers.mjs");
  await svc.stop();
  await runIosImport({ ...svc.config, importIos: false, args: ["ios", archive], importMedia: folder });
  assert.equal(fixture.calls(), 1);
  const read = AccountDb.open(svc.databasePath);
  assert.equal(read.messages.get(`false_${PEER}_key1`).transcript, "synthetic importer safety transcript");
  const progress = read.getMeta("ios_import_v1");
  read.setMeta("ios_import_error", "existing_refusal");
  read.close();
  const marker = join(dirname(svc.databasePath), "ios-import-binding.json");
  const before = readFileSync(marker);
  writeFileSync(archive, "unreadable archive format");
  const next = connectedService(WhatsAppService, {
    prefix: "wazap-ios-optin-resume-",
    id: ME,
    name: "Owner",
    config: { ...svc.config, importIos: false },
  }).svc;
  t.after(() => next.stop());
  await next.storage.claimDatabase(ME);
  await next.bootStorage();
  next.storage.startImportVoice();
  assert.equal(next.getStatus().storage.state, "ready");
  assert.equal(next.db.getMeta("ios_import_v1"), progress);
  assert.equal(next.db.getMeta("ios_import_error"), "existing_refusal");
  assert.deepEqual(readFileSync(marker), before);
  assert.equal(fixture.calls(), 1);
});
