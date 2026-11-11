import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountDb } from "../dist/db/index.js";
import { VectorCache } from "../dist/db/vector-cache.js";
import { sqlite } from "../dist/db/sqlite.js";
import { PEER, T0, openTemp, sid, textMessage, wordsOf } from "./db-fixtures.mjs";

// The cache and workers are opt-in; these tests exercise them.
process.env.WAZAP_RECALL_CACHE_MAX_MB ??= "2048";
const input = { model: "m", vector: [1, 0], query: "zzzz", limit: 2, semanticCandidates: 2, minSimilarity: 0 };
function seed(db, values) {
  values.forEach((v, i) => {
    const msg = textMessage(PEER, "R" + i, T0 + i * 1000, "fixture " + i);
    db.messages.upsert(msg);
    db.vectors.put(msg.sid, "m", Int8Array.of(v, 0), wordsOf(db, msg.sid));
  });
}
async function until(check) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("background operation did not settle");
}
function rawFixture(t, n = 0, dims = 2) {
  const raw = new (sqlite().DatabaseSync)(":memory:");
  raw.exec("CREATE TABLE embeddings(message_id INTEGER PRIMARY KEY,model TEXT,vec BLOB)");
  const insert = raw.prepare("INSERT INTO embeddings VALUES(?,?,?)");
  raw.exec("BEGIN");
  for (let i = 1; i <= n; i++) insert.run(i, "m", new Uint8Array(dims).fill(1));
  raw.exec("COMMIT");
  const c = {
    db: raw,
    get: (s, ...p) => raw.prepare(s).get(...p),
    all: (s, ...p) => raw.prepare(s).all(...p),
    run: (s, ...p) => raw.prepare(s).run(...p),
    assertOpen: () => assert.ok(raw.isOpen),
  };
  const cache = new VectorCache(c);
  t.after(() => {
    cache.close();
    raw.close();
  });
  return { raw, c, cache, insert };
}

function trackingNames(raw) {
  return raw
    .prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'vector_cache_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

test("A-S1 external connection writes invalidate cached similarities", async (t) => {
  const { db, path } = openTemp();
  t.after(() => db.close());
  seed(db, [2, 1, 2, 3]);
  await db.vectors.warmCache("m");
  await db.vectors.hybridAsync(input);
  const other = AccountDb.open(path);
  t.after(() => other.close());
  other.vectors.put(sid(false, PEER, "R3"), "m", Int8Array.of(0, 127), wordsOf(other, sid(false, PEER, "R3")));
  assert.deepEqual(await db.vectors.hybridAsync(input), db.vectors.hybrid(input));
  await until(() => db.vectors.cacheStatus().state === "ready");
  assert.deepEqual(await db.vectors.hybridAsync(input), db.vectors.hybrid(input));
});

test("A-S2 worker failure releases memory and recovers with bounded attempts", async (t) => {
  const { db } = openTemp();
  t.after(() => db.close());
  seed(db, [2, 1, 2, 3]);
  await db.vectors.warmCache("m");
  await db.vectors.hybridAsync(input);
  const cache = db.vectors.cache;
  cache.recoveryDelayMs = 10;
  await cache.workers[0].terminate();
  assert.equal(cache.vectors.byteLength, 0);
  await until(() => db.vectors.cacheStatus().state === "ready");
  assert.deepEqual(await db.vectors.hybridAsync(input), db.vectors.hybrid(input));
  assert.equal(db.vectors.cacheStatus().recoveries, 0, "a recovery that reached ready leaves no spent attempts");
});

test("A-S3 large dirty backlog reconciles in background and declines queued worker scans", async (t) => {
  const { cache, raw } = rawFixture(t, 6000);
  await cache.warm("m");
  raw.exec("UPDATE embeddings SET vec=vec");
  assert.equal(await cache.rank("m", Float64Array.of(1, 0), 2, 0), null);
  await until(
    () => raw.prepare("SELECT count(*) AS n FROM vector_cache_dirty").get().n === 0 && cache.status().state === "ready"
  );
  assert.deepEqual(
    (await cache.rank("m", Float64Array.of(1, 0), 2, 0)).map((x) => x.id),
    [2, 1]
  );
});

test("A-S4 zero limit disables allocation and growth retains shared buffer identity", async (t) => {
  const { cache, raw, insert } = rawFixture(t, 2);
  cache.maxBytes = 0;
  await cache.warm("m");
  assert.equal(cache.status().state, "disabled");
  assert.equal(cache.vectors.byteLength, 0);
  const other = rawFixture(t, 2);
  await other.cache.warm("m");
  const original = other.cache.vectors.buffer;
  for (let i = 3; i < 1300; i++) other.insert.run(i, "m", Uint8Array.of(1, 0));
  await other.cache.warm("m");
  await until(() => other.cache.status().state === "ready" && other.cache.slots.size === 1299);
  assert.equal(other.cache.vectors.buffer, original);
  assert.ok(other.cache.status().sharedBytes <= other.cache.maxBytes);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM embeddings").get().n, 2);
  assert.ok(insert);
});

test("A-S4 allocation failures are latched and never retried per query", async (t) => {
  const { cache } = rawFixture(t, 2);
  let calls = 0;
  cache.allocate = async () => {
    calls++;
    throw new RangeError("synthetic allocation failure");
  };
  await cache.warm("m");
  for (let i = 0; i < 10; i++) await cache.warm("m");
  assert.equal(calls, 1);
  assert.equal(cache.vectors.byteLength, 0);
  assert.equal(cache.status().state, "failed");
});

test("A-S5 exact four-row heap history and more than 100 identical vectors avoid replay", async (t) => {
  const { db } = openTemp();
  t.after(() => db.close());
  seed(db, [2, 1, 2, 3]);
  await db.vectors.warmCache("m");
  assert.deepEqual(
    (await db.vectors.hybridAsync(input)).hits.map((x) => x.message.keyId),
    ["R3", "R0"]
  );
  const other = openTemp().db;
  t.after(() => other.close());
  seed(other, Array(300).fill(7));
  await other.vectors.warmCache("m");
  const query = { ...input, limit: 100, semanticCandidates: 100 };
  assert.deepEqual(await other.vectors.hybridAsync(query), other.vectors.hybrid(query));
  assert.equal(other.vectors.cacheStatus().capFallbacks, 0);
  assert.equal(other.vectors.cache.status().fullReplays, undefined);
});

test("A-S5 ascending-ID adversary falls back at the fixed total admission cap", async (t) => {
  const { cache, raw, insert } = rawFixture(t);
  raw.exec("BEGIN");
  for (let i = 1; i <= 20000; i++) {
    const vec = new Uint8Array(16);
    for (let d = 0; d < 16; d++) vec[d] = (i >> d) & 1;
    insert.run(i, "m", vec);
  }
  raw.exec("COMMIT");
  await cache.warm("m");
  const unit = Float64Array.from({ length: 16 }, (_, i) => 2 ** i / 65536);
  assert.equal(await cache.rank("m", unit, 2, 0), null);
  assert.equal(cache.status().capFallbacks, 1);
  assert.equal(cache.status().state, "ready");
});

test("A-S6 warm counts in yielding pages and scan timeouts settle safely", async (t) => {
  const { cache, c } = rawFixture(t, 3000);
  let turns = 0;
  const original = c.all;
  c.all = (sql, ...p) => {
    assert.doesNotMatch(sql, /count\s*\(/i);
    return original(sql, ...p);
  };
  const tick = setInterval(() => turns++, 0);
  t.after(() => clearInterval(tick));
  await cache.warm("m");
  assert.ok(turns > 1);
  await cache.rank("m", Float64Array.of(1, 0), 2, 0);
  cache.scanTimeoutMs = 10;
  cache.workers[0].postMessage = () => {};
  assert.equal(
    await Promise.race([
      cache.rank("m", Float64Array.of(1, 0), 2, 0),
      new Promise((_, reject) => setTimeout(() => reject(Error("scan did not time out")), 500)),
    ]),
    null
  );
  assert.equal(cache.status().state, "recovering");
});

test("A-S1 external deletion during dispatch never returns stale content", async (t) => {
  const { db, path } = openTemp();
  t.after(() => db.close());
  seed(db, [2, 1, 2, 3]);
  await db.vectors.warmCache("m");
  const other = AccountDb.open(path);
  t.after(() => other.close());
  const pending = db.vectors.hybridAsync(input);
  await new Promise((resolve) => setImmediate(resolve));
  other.messages.delete(sid(false, PEER, "R3"));
  assert.deepEqual(await pending, db.vectors.hybrid(input));
});

test("A-S2 recovery stops after three consecutive failed attempts and keeps SQLite available", async (t) => {
  const { db } = openTemp();
  t.after(() => db.close());
  seed(db, [2, 1, 2, 3]);
  await db.vectors.warmCache("m");
  await db.vectors.hybridAsync(input);
  const cache = db.vectors.cache;
  cache.recoveryDelayMs = 1;
  cache.allocate = async () => {
    throw new Error("synthetic warm failure");
  };
  await cache.workers[0].terminate();
  await until(() => cache.status().state === "failed");
  assert.equal(cache.status().recoveries, 3);
  assert.equal(cache.status().sharedBytes, 0);
  assert.deepEqual(trackingNames(db.vectors.c.db), []);
  assert.deepEqual(await db.vectors.hybridAsync(input), db.vectors.hybrid(input));
});

test("the recovery budget resets once a search is served from the recovered cache", async (t) => {
  const { cache } = rawFixture(t, 128);
  cache.recoveryDelayMs = 1;
  await cache.warm("m");
  for (let i = 0; i < 5; i++) {
    await cache.rank("m", Float64Array.of(1, 0), 2, 0);
    await cache.workers[0].terminate();
    await until(() => cache.status().state === "ready");
  }
  assert.equal(cache.status().recoveries, 1);
  assert.notEqual(await cache.rank("m", Float64Array.of(1, 0), 2, 0), null);
  assert.equal(cache.status().recoveries, 0);
});

test("a failure that recurs after every warm still ends in failed", async (t) => {
  const { cache } = rawFixture(t, 128);
  cache.recoveryDelayMs = 1;
  cache.scanTimeoutMs = 10;
  const startWorkers = cache.startWorkers.bind(cache);
  cache.startWorkers = () => {
    startWorkers();
    for (const worker of cache.workers) worker.postMessage = () => {};
  };
  for (let i = 0; i < 10 && cache.status().state !== "failed"; i++) {
    await cache.warm("m");
    await until(() => ["ready", "failed"].includes(cache.status().state));
    await cache.rank("m", Float64Array.of(1, 0), 2, 0);
  }
  assert.equal(cache.status().state, "failed");
  assert.equal(cache.status().recoveries, 3);
});

test("consecutive external changes back off without using up the recovery budget", async (t) => {
  const { cache } = rawFixture(t, 128);
  let version = 0;
  cache.dataVersion = () => ++version;
  cache.recoveryDelayMs = 100;
  await cache.warm("m");
  const delays = [cache.retryAt - Date.now()];
  for (let i = 0; i < 3; i++) {
    cache.retryAt = 0;
    cache.maintain();
    await cache.tail;
    delays.push(cache.retryAt - Date.now());
  }
  assert.ok(
    delays.every((delay, i) => i === 0 || delay > delays[i - 1] * 1.5),
    `retry delays grow: ${delays}`
  );
  assert.equal(cache.status().recoveries, 0);
});

test("a warm cancelled while stopping workers settles instead of rejecting", async (t) => {
  const { cache } = rawFixture(t, 2);
  const stopWorkers = cache.stopWorkers.bind(cache);
  let once = true;
  cache.stopWorkers = async () => {
    if (once) {
      once = false;
      cache.fail(new Error("synthetic failure while warming"));
    }
    return stopWorkers();
  };
  await assert.doesNotReject(cache.warm("m"));
  assert.equal(cache.status().state, "recovering");
});

test("external changes while warming do not use up the recovery budget", async (t) => {
  const { cache } = rawFixture(t, 128);
  let version = 0;
  cache.dataVersion = () => ++version;
  cache.recoveryDelayMs = 1;
  await cache.warm("m");
  for (let i = 0; i < 6; i++) {
    cache.retryAt = 0;
    cache.maintain();
    await cache.tail;
  }
  assert.equal(cache.status().state, "recovering");
  assert.equal(cache.status().reason, "external_change");
  assert.equal(cache.status().recoveries, 0);
});

test("an external change during the last recovery attempt does not end the cache", async (t) => {
  const { cache } = rawFixture(t, 128);
  cache.recoveryDelayMs = 1;
  await cache.warm("m");
  const allocate = cache.allocate.bind(cache);
  let broken = true;
  cache.allocate = async (...args) => {
    if (broken) throw new Error("synthetic warm failure");
    return allocate(...args);
  };
  cache.fail(new Error("worker_failure"));
  for (let i = 0; i < 2; i++) {
    cache.retryAt = 0;
    cache.maintain();
    await cache.tail;
  }
  assert.equal(cache.status().recoveries, 2);
  broken = false;
  let version = 0;
  cache.dataVersion = () => ++version;
  cache.retryAt = 0;
  cache.maintain();
  await cache.tail;
  assert.equal(cache.status().state, "recovering");
  assert.equal(cache.status().reason, "external_change");
  assert.equal(cache.status().recoveries, 2);
});

test("external changes in a row after real failures give back only the attempt that was counted", async (t) => {
  const { cache } = rawFixture(t, 128);
  cache.recoveryDelayMs = 1;
  await cache.warm("m");
  const allocate = cache.allocate.bind(cache);
  let broken = true;
  cache.allocate = async (...args) => {
    if (broken) throw new Error("synthetic warm failure");
    return allocate(...args);
  };
  cache.fail(new Error("worker_failure"));
  for (let i = 0; i < 2; i++) {
    cache.retryAt = 0;
    cache.maintain();
    await cache.tail;
  }
  assert.equal(cache.status().recoveries, 2);
  broken = false;
  let version = 0;
  cache.dataVersion = () => ++version;
  for (let i = 0; i < 3; i++) {
    cache.retryAt = 0;
    cache.maintain();
    await cache.tail;
    assert.equal(cache.status().reason, "external_change");
    assert.equal(cache.status().recoveries, 2, `external change ${i + 1} leaves the spent attempts spent`);
  }
  broken = true;
  delete cache.dataVersion;
  // The attempt after an external change is free; the one after a real failure is the third counted.
  for (let i = 0; i < 2; i++) {
    cache.retryAt = 0;
    cache.maintain();
    await cache.tail;
  }
  assert.equal(cache.status().state, "failed", "a third counted failure still ends the cache");
  assert.equal(cache.status().recoveries, 3);
});

test("a permanently blocked cache drops its tracking and never queries it again", async (t) => {
  const { cache, raw } = rawFixture(t, 2);
  assert.equal(trackingNames(raw).length, 4);
  const cleared = [];
  const clearInterval = globalThis.clearInterval;
  globalThis.clearInterval = (timer) => (cleared.push(timer), clearInterval(timer));
  t.after(() => (globalThis.clearInterval = clearInterval));
  cache.maxBytes = 0;
  await cache.warm("m");
  assert.equal(cache.status().state, "disabled");
  assert.ok(cleared.includes(cache.timer), "the maintenance timer stops with the cache");
  assert.deepEqual(trackingNames(raw), []);
  assert.doesNotThrow(() => raw.prepare("INSERT OR REPLACE INTO embeddings VALUES(9,'m',?)").run(Uint8Array.of(1, 0)));
  assert.doesNotThrow(() => cache.maintain());
  assert.equal(cache.ready("m", 2), false);
  assert.equal(cache.indexedCount("m"), undefined);
});

test("cache errors fail the cache instead of escaping maintain, ready and indexedCount", async (t) => {
  const { cache, raw, c } = rawFixture(t, 128);
  await cache.warm("m");
  await cache.rank("m", Float64Array.of(1, 0), 2, 0);
  raw.exec("UPDATE embeddings SET vec=vec");
  const get = c.get;
  c.get = () => {
    throw new Error("synthetic sqlite failure");
  };
  assert.doesNotThrow(() => cache.maintain());
  assert.equal(cache.status().state, "recovering");
  c.get = get;
  cache.retryAt = 0;
  cache.maintain();
  await cache.tail;
  await until(() => cache.status().state === "ready");
  c.get = () => {
    throw new Error("synthetic sqlite failure");
  };
  assert.equal(cache.ready("m", 2), false);
  assert.equal(cache.status().state, "recovering");
  c.get = get;
  cache.retryAt = 0;
  cache.maintain();
  await until(() => cache.status().state === "ready");
  c.get = () => {
    throw new Error("synthetic sqlite failure");
  };
  assert.equal(cache.indexedCount("m"), undefined);
  assert.equal(cache.status().state, "recovering");
});

test("newer messages append to the sorted index and a removal falls back to the full merge", async (t) => {
  const { cache, raw, insert } = rawFixture(t, 10);
  await cache.warm("m");
  const appended = cache.order.buffer;
  const ids = async () => (await cache.rank("m", Float64Array.of(1, 0), 20, 0)).map((hit) => hit.id);
  for (let i = 11; i <= 14; i++) insert.run(i, "m", new Uint8Array(2).fill(1));
  cache.maintain();
  await cache.tail;
  assert.equal(cache.order.buffer, appended, "appended in place");
  assert.deepEqual(await ids(), [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  raw.exec("DELETE FROM embeddings WHERE message_id=3");
  insert.run(15, "m", new Uint8Array(2).fill(1));
  cache.maintain();
  await cache.tail;
  assert.notEqual(cache.order.buffer, appended, "merged into the other index");
  assert.deepEqual(await ids(), [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 2, 1]);
});

test("A-S4 size limit refuses a cache before allocating its vector payload", async (t) => {
  const { cache } = rawFixture(t, 2000, 3072);
  cache.maxBytes = 1048576;
  await cache.warm("m");
  assert.equal(cache.status().state, "disabled");
  assert.equal(cache.status().reason, "size_limit");
  assert.equal(cache.status().sharedBytes, 0);
});

test("A-S6 a warm deadline is bounded and reported without content", async (t) => {
  const { cache } = rawFixture(t, 2000);
  cache.warmTimeoutMs = -1;
  await cache.warm("m");
  assert.equal(cache.status().state, "recovering");
  assert.equal(cache.status().reason, "warm_timeout");
  assert.equal(cache.status().sharedBytes, 0);
});

test("A-S4 the public zero setting installs no cache tracking triggers", async (t) => {
  const saved = process.env.WAZAP_RECALL_CACHE_MAX_MB;
  process.env.WAZAP_RECALL_CACHE_MAX_MB = "0";
  try {
    const { cache, raw } = rawFixture(t, 2);
    await cache.warm("m");
    assert.equal(cache.status().state, "disabled");
    assert.equal(raw.prepare("SELECT name FROM sqlite_temp_master WHERE name='vector_cache_dirty'").get(), undefined);
  } finally {
    if (saved === undefined) delete process.env.WAZAP_RECALL_CACHE_MAX_MB;
    else process.env.WAZAP_RECALL_CACHE_MAX_MB = saved;
  }
});

test("WAZAP_RECALL_CACHE_MAX_MB sets the cache limit a new cache enforces", async (t) => {
  // 300 vectors of 4096 bytes need ~1.2 MiB: over a 1 MiB limit, under 2 MiB.
  const saved = process.env.WAZAP_RECALL_CACHE_MAX_MB;
  t.after(() => {
    if (saved === undefined) delete process.env.WAZAP_RECALL_CACHE_MAX_MB;
    else process.env.WAZAP_RECALL_CACHE_MAX_MB = saved;
  });
  const states = {};
  for (const value of ["1", "2", "nonsense"]) {
    process.env.WAZAP_RECALL_CACHE_MAX_MB = value;
    const { cache } = rawFixture(t, 300, 4096);
    await cache.warm("m");
    states[value] = { state: cache.status().state, reason: cache.status().reason };
    if (value === "2") assert.ok(cache.status().sharedBytes <= 2 * 1048576);
  }
  assert.deepEqual(states, {
    1: { state: "disabled", reason: "size_limit" },
    2: { state: "ready", reason: undefined },
    nonsense: { state: "disabled", reason: "disabled" },
  });
});

for (const count of [128, 1000]) {
  test(`background reconciliation preserves failure at a yielded ${count}-row batch`, async (t) => {
    const { cache, raw } = rawFixture(t, count);
    await cache.warm("m");
    await cache.rank("m", Float64Array.of(1, 0), 2, 0);
    cache.recoveryDelayMs = 10000;
    const original = cache.yield.bind(cache);
    let terminated = false;
    cache.yield = async () => {
      await original();
      if (!terminated && cache.status().state === "reconciling") {
        terminated = true;
        await cache.workers[0].terminate();
      }
    };
    raw.exec("UPDATE embeddings SET vec=vec");
    cache.maintain();
    await cache.tail;
    assert.equal(terminated, true);
    assert.equal(cache.status().state, "recovering");
    assert.equal(cache.loaded, false);
    assert.equal(cache.status().sharedBytes, 0, "failed background task must not allocate after release");
    cache.yield = original;
    cache.retryAt = 0;
    cache.recoveryDelayMs = 1;
    cache.maintain();
    await until(() => cache.status().state === "ready");
    assert.equal(cache.status().recoveries, 1, "ready alone does not give the attempt back");
    assert.deepEqual(
      (await cache.rank("m", Float64Array.of(1, 0), 2, 0)).map((x) => x.id),
      [2, 1]
    );
    assert.equal(cache.status().recoveries, 0, "a search served from the recovered cache does");
  });
}

test("a queued warm cannot bypass a newer worker failure and its recovery budget", async (t) => {
  const { cache } = rawFixture(t, 128);
  await cache.warm("m");
  await cache.rank("m", Float64Array.of(1, 0), 2, 0);
  cache.recoveryDelayMs = 10000;
  let resume;
  const held = cache.enqueue(
    () =>
      new Promise((resolve) => {
        resume = resolve;
      })
  );
  await new Promise((resolve) => setImmediate(resolve));
  const warm = cache.warm("different", 2);
  await cache.workers[0].terminate();
  resume();
  await held;
  await warm;
  assert.equal(cache.status().state, "recovering");
  assert.equal(cache.status().recoveries, 0);
  assert.equal(cache.status().sharedBytes, 0);
});

test("close during background reconciliation leaves no allocated storage", async (t) => {
  const { cache, raw } = rawFixture(t, 1000);
  await cache.warm("m");
  await cache.rank("m", Float64Array.of(1, 0), 2, 0);
  const original = cache.yield.bind(cache);
  let closed = false;
  cache.yield = async () => {
    await original();
    if (!closed && cache.status().state === "reconciling") {
      closed = true;
      cache.close();
    }
  };
  raw.exec("UPDATE embeddings SET vec=vec");
  cache.maintain();
  await cache.tail;
  assert.equal(closed, true);
  assert.equal(cache.loaded, false);
  assert.equal(cache.status().sharedBytes, 0);
});

test("external invalidation during background reconciliation rewarms before publishing ready", async (t) => {
  const { db, path } = openTemp();
  t.after(() => db.close());
  seed(db, [2, 1, 2, 3]);
  await db.vectors.warmCache("m");
  await db.vectors.hybridAsync(input);
  const other = AccountDb.open(path);
  t.after(() => other.close());
  const cache = db.vectors.cache;
  const original = cache.yield.bind(cache);
  let changed = false;
  cache.yield = async () => {
    await original();
    if (!changed && cache.status().state === "reconciling") {
      changed = true;
      other.vectors.put(sid(false, PEER, "R3"), "m", Int8Array.of(0, 127), wordsOf(other, sid(false, PEER, "R3")));
      assert.equal(cache.ready("m", 2), false);
    }
  };
  db.vectors.put(sid(false, PEER, "R0"), "m", Int8Array.of(5, 0), wordsOf(db, sid(false, PEER, "R0")));
  cache.maintain();
  await cache.tail;
  await until(() => cache.status().state === "ready");
  assert.equal(changed, true);
  assert.equal(cache.loaded, true);
  assert.deepEqual(await db.vectors.hybridAsync(input), db.vectors.hybrid(input));
});
