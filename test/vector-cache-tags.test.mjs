import { test } from "node:test";
import assert from "node:assert/strict";
import { PEER, T0, openTemp, sid, textMessage, wordsOf } from "./db-fixtures.mjs";

process.env.WAZAP_RECALL_CACHE_MAX_MB = "64";

for (const tag of ["client", "missing"]) {
  test(`a warm cache respects the ${tag} tag on semantic search`, async (t) => {
    const { db } = openTemp();
    t.after(() => db.close());
    const other = "40700000003@s.whatsapp.net";
    for (const [chat, key] of [[PEER, "TAGGED"], [other, "OTHER"]]) {
      db.messages.upsert(textMessage(chat, key, T0, "semantic fixture"));
      db.vectors.put(sid(false, chat, key), "m", Int8Array.of(127, 0), wordsOf(db, sid(false, chat, key)));
    }
    db.identity.updateFields(PEER, { addTags: ["client"] });
    await db.vectors.warmCache("m");
    assert.equal(db.vectors.cacheStatus().state, "ready");
    const input = { model: "m", vector: [1, 0], query: "zzzz", limit: 5, minSimilarity: 0, tag };
    const expected = tag === "client" ? [sid(false, PEER, "TAGGED")] : [];
    assert.deepEqual(db.vectors.hybrid(input).hits.map((hit) => hit.message.sid), expected);
    assert.deepEqual((await db.vectors.hybridAsync(input)).hits.map((hit) => hit.message.sid), expected);
  });
}
