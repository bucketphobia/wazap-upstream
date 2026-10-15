import { test } from "node:test";
import assert from "node:assert/strict";
import { PEER, T0, openTemp, sid, textMessage, wordsOf } from "./db-fixtures.mjs";

function seed(db, values) {
  values.forEach((v, i) => {
    const key = `W${i}`;
    db.messages.upsert(textMessage(PEER, key, T0 + i * 1000, `worker fixture ${i}`));
    db.vectors.put(sid(false, PEER, key), "m", Int8Array.of(v, 0), wordsOf(db, sid(false, PEER, key)));
  });
}
const input = { model: "m", vector: [1, 0], query: "zzzz", limit: 5, semanticCandidates: 5, minSimilarity: 0 };

test("worker hybrid results equal the SQLite scan, including tied cutoff scores", async (t) => {
  const { db } = openTemp();
  t.after(() => db.close());
  seed(
    db,
    [
      1, 4, 6, 2, 4, 6, 1, 5, 2, 7, 4, 4, 5, 2, 3, 2, 6, 2, 7, 4, 3, 1, 4, 7, 5, 6, 1, 2, 6, 6, 7, 3, 1, 6, 3, 6, 6, 5,
      4, 5,
    ]
  );
  await db.vectors.warmCache("m");
  assert.deepEqual(await db.vectors.hybridAsync(input), db.vectors.hybrid(input));
  assert.deepEqual(await db.vectors.hybridAsync({ ...input, chat: PEER }), db.vectors.hybrid({ ...input, chat: PEER }));
});

test("cache follows inserts, model replacements, edits, rollback and clear barriers", async (t) => {
  const { db } = openTemp();
  t.after(() => db.close());
  seed(db, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
  await db.vectors.warmCache("m");
  const equal = async () => assert.deepEqual(await db.vectors.hybridAsync(input), db.vectors.hybrid(input));
  await equal();
  db.messages.delete(sid(false, PEER, "W8"));
  await equal();
  db.messages.upsert(textMessage(PEER, "W7", T0 + 7000, "edited", { editedAt: T0 + 100000 }));
  await equal();
  assert.throws(
    () =>
      db.transaction(() => {
        db.messages.delete(sid(false, PEER, "W6"));
        throw new Error("rollback fixture");
      }),
    /rollback fixture/
  );
  await equal();
  db.vectors.put(sid(false, PEER, "W6"), "other", [0, 1], wordsOf(db, sid(false, PEER, "W6")));
  await equal();
  db.messages.upsert(textMessage(PEER, "OLD", T0 - 1000, "old imported row"));
  db.vectors.put(sid(false, PEER, "OLD"), "m", Int8Array.of(127, 0), wordsOf(db, sid(false, PEER, "OLD")));
  await equal();
  await db.messages.clearChat(PEER, T0 + 3000);
  await equal();
});

test("worker search preserves expiry, recency and ordered ties after an older insert", async (t) => {
  const { db, clock } = openTemp();
  t.after(() => db.close());
  seed(db, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
  db.messages.upsert(textMessage(PEER, "EXP", T0, "fixture expiring", { expiresAt: clock.now + 100 }));
  db.vectors.put(sid(false, PEER, "EXP"), "m", Int8Array.of(127, 0), wordsOf(db, sid(false, PEER, "EXP")));
  await db.vectors.warmCache("m");
  db.messages.upsert(textMessage(PEER, "OLDTIE", T0 - 1000, "fixture older tie"));
  db.vectors.put(sid(false, PEER, "OLDTIE"), "m", Int8Array.of(50, 0), wordsOf(db, sid(false, PEER, "OLDTIE")));
  const timed = { ...input, recencyHalfLifeMs: 100000 };
  assert.deepEqual(await db.vectors.hybridAsync(timed), db.vectors.hybrid(timed));
  clock.now += 101;
  assert.deepEqual(await db.vectors.hybridAsync(timed), db.vectors.hybrid(timed));
});

test("writes during worker scans and simultaneous searches cannot expose stale vectors", async (t) => {
  const { db } = openTemp({ chunkSize: 1, chunkBudgetMs: 1 });
  t.after(() => db.close());
  seed(
    db,
    Array.from({ length: 100 }, (_, i) => (i % 100) + 1)
  );
  await db.vectors.warmCache("m");
  const first = db.vectors.hybridAsync(input);
  const second = db.vectors.hybridAsync(input);
  // Let the pool dispatch, then install a clear barrier before its purge finishes.
  await new Promise((resolve) => setImmediate(resolve));
  const clear = db.messages.clearChat(PEER, T0 + 99000);
  assert.equal((await first).hits.length, 0);
  assert.equal((await second).hits.length, 0);
  await clear;
  assert.deepEqual(await db.vectors.hybridAsync(input), db.vectors.hybrid(input));
});

test("a stopped worker falls back to SQLite and closing rejects an in-flight query", async (t) => {
  const { db } = openTemp();
  t.after(() => db.close());
  seed(db, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
  await db.vectors.warmCache("m");
  await db.vectors.hybridAsync(input);
  await db.vectors.cache.workers[0].terminate();
  assert.deepEqual(await db.vectors.hybridAsync(input), db.vectors.hybrid(input));
  const other = openTemp().db;
  seed(other, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
  await other.vectors.warmCache("m");
  const pending = other.vectors.hybridAsync(input);
  await new Promise((resolve) => setImmediate(resolve));
  other.close();
  await assert.rejects(pending, (err) => err.code === "CLOSED");
});

test("an initially empty cache and later model dimension switch become searchable", async (t) => {
  const { db } = openTemp();
  t.after(() => db.close());
  await db.vectors.warmCache("m");
  seed(db, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
  await db.vectors.warmCache("m", 2);
  assert.deepEqual(await db.vectors.hybridAsync(input), db.vectors.hybrid(input));
  db.vectors.put(sid(false, PEER, "W8"), "m", [1, 0, 0], wordsOf(db, sid(false, PEER, "W8")));
  await db.vectors.warmCache("m", 3);
  const changed = { ...input, vector: [1, 0, 0] };
  assert.deepEqual(await db.vectors.hybridAsync(changed), db.vectors.hybrid(changed));
});

// Large dirty queues exercise the production cache without message/FTS setup cost.
async function cacheFixture(t, count) {
  const { sqlite } = await import("../dist/db/sqlite.js");
  const { VectorCache } = await import("../dist/db/vector-cache.js");
  const raw = new (sqlite().DatabaseSync)(":memory:");
  raw.exec("CREATE TABLE embeddings(message_id INTEGER PRIMARY KEY, model TEXT, vec BLOB)");
  const vec = new Uint8Array(3072);
  vec[0] = 127;
  const insert = raw.prepare("INSERT INTO embeddings VALUES (?, ?, ?)");
  raw.exec("BEGIN");
  for (let i = 1; i <= count; i++) insert.run(i, "m", vec);
  raw.exec("COMMIT");
  const c = {
    db: raw,
    get: (sql, ...args) => raw.prepare(sql).get(...args),
    all: (sql, ...args) => raw.prepare(sql).all(...args),
    run: (sql, ...args) => raw.prepare(sql).run(...args),
    assertOpen: () => assert.ok(raw.isOpen),
  };
  const cache = new VectorCache(c);
  t.after(() => {
    cache.close();
    raw.close();
  });
  await cache.warm("m");
  const unit = new Float64Array(3072);
  unit[0] = 1;
  await cache.rank("m", unit, 10, 0);
  return { raw, cache, unit, insert, vec };
}

test("large dirty backlog reconciles without holding a query behind it", async (t) => {
  const { raw, cache, unit, insert, vec } = await cacheFixture(t, 50000);
  raw.exec("UPDATE embeddings SET vec=vec; BEGIN");
  for (let id = 50001; id <= 52000; id++) insert.run(id, "m", vec);
  raw.exec("DELETE FROM embeddings WHERE message_id>48000 AND message_id<=48500; COMMIT");
  assert.equal(await cache.rank("m", unit, 10, 0), null);
  let turns = 0;
  const timer = setInterval(() => turns++, 0);
  t.after(() => clearInterval(timer));
  for (let i = 0; i < 1000 && cache.status().state !== "ready"; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cache.status().state, "ready");
  assert.ok(turns > 1, "background reconciliation yielded to other work");
  assert.deepEqual(
    (await cache.rank("m", unit, 10, 0)).map((x) => x.id),
    [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
  );
});

test("first and queued searches settle while embedding writes remain active", async (t) => {
  const { raw, cache, unit } = await cacheFixture(t, 10000);
  let active = true;
  const writer = setInterval(() => raw.prepare("UPDATE embeddings SET vec=vec WHERE message_id=10000").run(), 1);
  const stop = setTimeout(() => {
    active = false;
    clearInterval(writer);
  }, 1500);
  t.after(() => {
    clearInterval(writer);
    clearTimeout(stop);
  });
  await Promise.all([cache.rank("m", unit, 10, 0), cache.rank("m", unit, 10, 0)]);
  assert.equal(active, true, "queries must finish before the writer stops");
});

test("worker exit during dirty reconciliation falls back instead of returning an empty ranking", async (t) => {
  const { cache, unit } = await cacheFixture(t, 2048);
  const sync = cache.sync.bind(cache);
  cache.sync = async () => {
    await sync();
    await cache.workers[0].terminate();
  };
  assert.equal(await cache.rank("m", unit, 10, 0), null);
});
