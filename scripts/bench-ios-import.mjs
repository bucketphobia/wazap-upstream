/** Synthetic only. Routine: node scripts/bench-ios-import.mjs 100000; manual: ... 1000000. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { AccountDb } from "../dist/db/index.js";
import { sqlite } from "../dist/db/sqlite.js";
import { initializeIosBinding } from "../dist/ios-import/binding.js";
import { importIos } from "../dist/ios-import/index.js";
const count = Number(process.argv[2] ?? 100000);
if (!Number.isSafeInteger(count) || count < 1) throw Error("row count must be a positive integer");
const directory = mkdtempSync(join(tmpdir(), "wazap-ios-bench-"));
const path = join(directory, "ChatStorage.sqlite");
const peer = "40700000002@s.whatsapp.net";
const source = new (sqlite().DatabaseSync)(path);
source.exec(
  `PRAGMA journal_mode=OFF;CREATE TABLE ZWACHATSESSION(Z_PK INTEGER PRIMARY KEY,ZCONTACTJID TEXT,ZGROUPINFO INTEGER,ZPARTNERNAME TEXT);CREATE TABLE ZWAGROUPMEMBER(Z_PK INTEGER PRIMARY KEY,ZMEMBERJID TEXT);CREATE TABLE ZWAMESSAGE(Z_PK INTEGER PRIMARY KEY,ZCHATSESSION INTEGER,ZGROUPMEMBER INTEGER,ZISFROMME INTEGER,ZSTANZAID TEXT,ZMESSAGEDATE REAL,ZMESSAGETYPE INTEGER,ZTEXT TEXT,ZPARENTMESSAGE INTEGER);CREATE TABLE ZWAMEDIAITEM(Z_PK INTEGER PRIMARY KEY,ZMESSAGE INTEGER,ZTITLE TEXT,ZMEDIALOCALPATH TEXT);`
);
source.prepare("INSERT INTO ZWACHATSESSION VALUES(1,?,NULL,?)").run(peer, "Synthetic peer");
const row = source.prepare("INSERT INTO ZWAMESSAGE VALUES(?,1,NULL,0,?,700000000,?,?,?)");
const media = source.prepare("INSERT INTO ZWAMEDIAITEM VALUES(?,?,NULL,?)");
source.exec("BEGIN");
for (let i = 1; i <= count; i++) {
  const type = i % 20 < 3 ? 3 : 0;
  const key = i % 100 === 0 || i % 100 === 1 ? `collision-${Math.floor((i - 1) / 100)}` : `key-${i}`;
  row.run(i * 3, key, type, type === 0 ? "synthetic body" : null, i < count && i % 7 === 0 ? (i + 1) * 3 : null);
  if (type === 3) media.run(i, i * 3, "note.opus");
}
source.exec("COMMIT");
source.close();
writeFileSync(join(directory, "voice-skip.txt"), "");
writeFileSync(join(directory, "note.opus"), "synthetic");
const db = AccountDb.open(join(directory, "target.sqlite"), { checkpointDelayMs: 0 });
db.bindOwner("40700000001@s.whatsapp.net");
initializeIosBinding(db);
let maxMeta = 0,
  checkpoints = 0,
  peakRss = process.memoryUsage().rss,
  uploads = 0;
const setMeta = db.setMeta.bind(db);
db.setMeta = (key, value) => {
  if (value !== null) maxMeta = Math.max(maxMeta, Buffer.byteLength(value));
  if (key === "ios_import_v1") checkpoints++;
  return setMeta(key, value);
};
const baselineRss = process.memoryUsage().rss;
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const sample = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 10);
const start = performance.now();
try {
  const report = await importIos({
    db,
    source: path,
    media: directory,
    transcriber: async () => {
      uploads++;
      return { text: "synthetic transcript" };
    },
  });
  loop.disable();
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  console.log(
    JSON.stringify(
      {
        rows: count,
        elapsedMs: Math.round(performance.now() - start),
        baselineRssMiB: Math.round(baselineRss / 1048576),
        incrementalPeakRssMiB: Math.round((peakRss - baselineRss) / 1048576),
        peakRssMiB: Math.round(peakRss / 1048576),
        eventLoopMaxMs: Number((loop.max / 1e6).toFixed(2)),
        maxMetadataBytes: maxMeta,
        checkpoints,
        uploads,
        report,
      },
      null,
      2
    )
  );
  const controller = new AbortController();
  const canonical = db.identity.canonicalJid.bind(db.identity);
  let preparationRows = 0;
  let requestedAt;
  db.identity.canonicalJid = (...args) => {
    if (++preparationRows === 1)
      setImmediate(() => {
        requestedAt = performance.now();
        controller.abort();
      });
    return canonical(...args);
  };
  const progressBeforeCancel = db.getMeta("ios_import_v1");
  const cancelStart = performance.now();
  try {
    await importIos({ db, source: path, dryRun: true, signal: controller.signal });
    assert.fail("expected cancellation");
  } catch (error) {
    assert.equal(controller.signal.aborted, true);
    assert.equal(error.code, "SERVICE_ERROR");
    assert.equal(db.getMeta("ios_import_v1"), progressBeforeCancel);
    console.log(
      JSON.stringify({
        cancellation: {
          phase: "collision preparation",
          elapsedMs: Math.round(performance.now() - cancelStart),
          stopLatencyMs: Math.round(performance.now() - requestedAt),
          preparationRows,
          progressUnchanged: true,
          committedSourceRows: 0,
          message: error.message,
        },
      })
    );
  }
} finally {
  clearInterval(sample);
  loop.disable();
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
