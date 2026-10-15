/** Provider-free acceptance through WhatsAppService -> AccountRecall -> hybridAsync. */
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { AccountDb } from "../dist/db/index.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService } from "../test/helpers.mjs";

const [directory, kind = "random", countArg = "500000", stage] = process.argv.slice(2);
if (!directory || !["random", "identical"].includes(kind))
  throw Error("Usage: node scripts/bench-vector-workers.mjs <owned-scratch-dir> [random|identical] [rows]");
const scope = process.env.BENCH_SCOPE || "service";
if (!["service", "cache"].includes(scope)) throw Error("BENCH_SCOPE must be service or cache");
const root = resolve(directory),
  rows = Number(countArg),
  dimensions = 3072,
  model = "embeddinggemma-300m";
if (!Number.isSafeInteger(rows) || rows < 1 || rows > 500000) throw Error("rows must be 1..500000");
const path = join(root, "accounts/default/wazap.sqlite");
// Deterministic synthetic data only: no model, provider, or private fixtures.
function mulberry32(seed) {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
function unitVector(values) {
  const norm = Math.hypot(...values);
  return Float64Array.from(values, (value) => value / norm);
}
function tile(seeds, seedCount, dims, count, output, noise, seed) {
  const random = mulberry32(seed);
  for (let row = 0; row < count; row++) {
    const offset = (row % seedCount) * dims;
    const values = unitVector(
      Float64Array.from(
        { length: dims },
        (_, col) => seeds[offset + col] + ((random() * 2 - 1) * noise) / Math.sqrt(dims)
      )
    );
    for (let col = 0; col < dims; col++) output[row * dims + col] = Math.round(values[col] * 127);
  }
}
if (stage === "prepare") {
  assert.equal(existsSync(path), false, "fixture creation only accepts a new owned scratch directory");
  const db = AccountDb.open(path, { checkpointDelayMs: 0 });
  try {
    const c = db.connection,
      raw = c.db;
    raw.exec("PRAGMA synchronous=OFF; BEGIN");
    raw
      .prepare("INSERT INTO chats(id,jid,kind,name) VALUES(1,?,'direct','Synthetic fixture')")
      .run("15550000001@s.whatsapp.net");
    const message = raw.prepare(
      "INSERT INTO messages(id,chat_id,key_id,from_me,ts,type,text) VALUES(?,1,?,0,?,'text',?)"
    );
    const embedding = raw.prepare("INSERT INTO embeddings(message_id,model,content_hash,vec) VALUES(?,?,?,?)");
    const at = Date.UTC(2026, 9, 12, 12),
      base = (at / 1000) * 1048576;
    let vectors;
    if (kind === "random") {
      const random = mulberry32(20261013),
        seeds = new Float32Array(2048 * dimensions);
      for (let i = 0; i < 2048; i++)
        seeds.set(unitVector(Float64Array.from({ length: dimensions }, () => random() * 2 - 1)), i * dimensions);
      vectors = new Int8Array(rows * dimensions);
      tile(seeds, 2048, dimensions, rows, vectors, 0.5, 777);
    }
    const identical = new Uint8Array(dimensions);
    identical[0] = 127;
    for (let i = 0; i < rows; i++) {
      const text = `Synthetic fixture ${i}`;
      message.run(base + i + 1, `BENCH${i}`, at, text);
      embedding.run(
        base + i + 1,
        model,
        "synthetic",
        vectors ? new Uint8Array(vectors.buffer, i * dimensions, dimensions) : identical
      );
    }
    raw.exec("COMMIT; PRAGMA synchronous=FULL");
    db.setMeta("embed_model", model);
    db.setMeta("search_bench_fixture", JSON.stringify({ kind, rows, dimensions }));
  } finally {
    db.close();
  }
  console.error(`Prepared ${kind} synthetic fixture: ${rows} valid messages and embeddings`);
  process.exit(0);
}
if (!existsSync(path)) {
  const prepared = spawnSync(
    process.execPath,
    [new URL(import.meta.url).pathname, root, kind, String(rows), "prepare"],
    { stdio: ["ignore", "inherit", "inherit"] }
  );
  if (prepared.status !== 0) throw Error("fixture generation failed");
}
// Only query embeddings and WhatsApp transport are stubbed; ranking, lifecycle,
// status, hydration, filtering and view rendering are the committed production code.
process.env.WAZAP_RECALL = "local";
process.env.WAZAP_RECALL_MIN_SIMILARITY = "0";
process.env.WAZAP_RECALL_CACHE_MAX_MB ??= "2048";
process.env.WAZAP_NO_UPDATE_CHECK = "1";
process.env.WAZAP_TRANSCRIBE_AUTO = "off";
const { svc } = connectedService(WhatsAppService, {
  prefix: "wazap-search-bench-",
  id: "15550000000@s.whatsapp.net",
  name: "Synthetic Owner",
  config: { dataDir: root, persistHistory: true },
});
let warm;
try {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  await new Promise((r) => setTimeout(r, 10));
  const at = performance.now();
  await svc.bootStorage();
  assert.deepEqual(JSON.parse(svc.db.getMeta("search_bench_fixture")), { kind, rows, dimensions });
  await svc.db.vectors.warmCache(model, dimensions);
  await svc.recallIdle();
  await new Promise((r) => setTimeout(r, 10));
  histogram.disable();
  warm = {
    cacheBuildMs: performance.now() - at,
    eventLoopMaxMs: histogram.max / 1e6,
    rssMiB: process.memoryUsage().rss / 1048576,
    cache: svc.db.vectors.cacheStatus(),
  };
  assert.equal(warm.cache.state, "ready");
  const random = mulberry32(42);
  const queries = Array.from({ length: 10 }, () =>
    kind === "identical"
      ? Float64Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0))
      : unitVector(Float64Array.from({ length: dimensions }, () => random() * 2 - 1))
  );
  let query = queries[0];
  svc.recallIndex.queryVector = async () => query;
  const call = () =>
    scope === "service"
      ? svc.recall("zzzz", undefined, 10)
      : svc.db.vectors.hybridAsync({
          query: "zzzz",
          model,
          vector: query,
          limit: 10,
          semanticCandidates: 10,
          minSimilarity: 0,
        });
  const hitsOf = (answer) =>
    (answer.data ?? answer).hits.map((hit) => [hit.message.message_id ?? hit.message.sid, hit.score, hit.similarity]);
  const asyncHybrid = svc.db.vectors.hybridAsync.bind(svc.db.vectors);
  for (const q of queries.slice(0, 3)) {
    query = q;
    const cached = await call();
    svc.db.vectors.hybridAsync = async (input) => svc.db.vectors.hybrid(input);
    try {
      const legacy = await call();
      assert.deepEqual(hitsOf(cached), hitsOf(legacy));
    } finally {
      svc.db.vectors.hybridAsync = asyncHybrid;
    }
  }
  assert.ok(svc.db.vectors.cache.workers.length > 0, "production worker pool dispatched");
  const before = svc.db.vectors.cacheStatus().capFallbacks;
  const histogramQuery = monitorEventLoopDelay({ resolution: 1 });
  histogramQuery.enable();
  await new Promise((r) => setTimeout(r, 10));
  const times = [];
  for (const q of queries) {
    query = q;
    const at = performance.now();
    await call();
    times.push(performance.now() - at);
  }
  await new Promise((r) => setTimeout(r, 10));
  histogramQuery.disable();
  const sorted = times.toSorted((a, b) => a - b);
  const sha = process.env.BENCH_COMMIT_SHA || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  console.log(
    JSON.stringify(
      {
        commitSha: sha,
        node: process.version,
        productionPath:
          scope === "service"
            ? "WhatsAppService.recall -> AccountRecall.recall -> Vectors.hybridAsync"
            : "Vectors.hybridAsync (diagnostic cache scope)",
        scope,
        semanticCandidates: scope === "service" ? 100 : 10,
        fixture: `synthetic ${kind}, valid messages; no providers`,
        rows,
        dimensions,
        workers: svc.db.vectors.cache.workers.length,
        parityQueries: 3,
        timedQueries: times.length,
        medianMs: sorted[5],
        p95Ms: sorted[9],
        eventLoopMaxMs: histogramQuery.max / 1e6,
        capHits: svc.db.vectors.cacheStatus().capFallbacks - before,
        warm,
        rssMiB: process.memoryUsage().rss / 1048576,
        times,
      },
      null,
      2
    )
  );
} finally {
  await svc.stop();
}
