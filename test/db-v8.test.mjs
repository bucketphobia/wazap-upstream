/**
 * Schema v8: the embeddings are counted off an index of their model, which
 * recall status reads every ten seconds and the account counts read on every
 * status, instead of walking every stored vector.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { PEER, T0, openTemp, sid, textMessage, wordsOf } from "./db-fixtures.mjs";

const plan = (db, sql, ...params) => db.connection.all(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((row) => row.detail).join(" | ");

test("counting a model's embeddings reads the model index, and counts what put and delete leave", () => {
  const { db } = openTemp();
  try {
    assert.match(plan(db, "SELECT count(*) AS n FROM embeddings WHERE model = ?", "m1"), /COVERING INDEX embeddings_model/);
    assert.match(plan(db, "SELECT count(*) AS n FROM embeddings"), /COVERING INDEX embeddings_model/);
    for (let i = 0; i < 6; i++) db.messages.upsert(textMessage(PEER, `K${i}`, T0 + i * 1000, `mesajul ${i}`));
    const put = (key, model) => assert.equal(db.vectors.put(sid(false, PEER, key), model, [1, 0, 0], wordsOf(db, sid(false, PEER, key))), true);
    for (let i = 0; i < 4; i++) put(`K${i}`, "m1");
    put("K4", "m2");
    assert.equal(db.vectors.count("m1"), 4);
    assert.equal(db.vectors.count("m2"), 1);
    assert.equal(db.vectors.count(), 5);
    db.messages.delete(sid(false, PEER, "K0"));
    assert.equal(db.vectors.count("m1"), 3, "a tombstone takes its vector, and the index with it");
    assert.equal(db.counts().embeddings, 4);
    assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });
  } finally {
    db.close();
  }
});
