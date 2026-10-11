/**
 * Embeddings in the account database: quantized exactly the way recall's
 * index does it (so its vectors import without re-embedding), tied to their
 * message so every deletion takes them along, and searched both on their own
 * and fused with the trigram index — where a hit found only by meaning must
 * clear the floor, so a question with no answer comes back empty.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AccountDb, contentHash, hybridTokens, int8Similarity, quantizeVector, unitVector } from "../dist/db/index.js";
import { EMBED_MODELS } from "../dist/recall/models.js";
import { GROUP, PEER, T0, openTemp, sid, textMessage, wordsOf } from "./db-fixtures.mjs";

const MODEL = "embeddinggemma-300m";
const OTHER = "40700000003@s.whatsapp.net";
const DIMS = 8;

/** A unit-ish direction in 8 dimensions: `axis` weighted 1, `blend` weighted `w`. */
function direction(axis, blend = null, w = 0) {
  const v = new Array(DIMS).fill(0);
  v[axis] = 1;
  if (blend !== null) v[blend] = w;
  return v;
}

/**
 * The old recall index's quantization and similarity (src/recall/store.ts at
 * 7ec2f93), written out: its vectors.bin rows import as they are only while
 * the database quantizes and scores them byte for byte the same way.
 */
function recallQuantize(vector) {
  let norm = 0;
  for (const x of vector) norm += x * x;
  const inv = 1 / Math.sqrt(norm);
  return Int8Array.from(vector.map((x) => Math.round(Math.max(-1, Math.min(1, x * inv)) * 127)));
}

function recallSimilarity(query, row) {
  let norm = 0;
  for (const x of query) norm += x * x;
  const inv = 1 / Math.sqrt(norm);
  let dot = 0;
  for (let i = 0; i < query.length; i++) dot += query[i] * inv * row[i];
  return dot / 127;
}

test("quantization and similarity match the old recall index byte for byte", () => {
  const spec = EMBED_MODELS[MODEL];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const vectors = Array.from({ length: 5 }, () => Array.from({ length: spec.dims }, rnd));
  const query = Array.from({ length: spec.dims }, rnd);
  vectors.forEach((vector, i) => {
    const ours = quantizeVector(vector);
    const theirs = recallQuantize(vector);
    assert.deepEqual([...ours], [...theirs], `row ${i}`);
    assert.ok(Math.abs(int8Similarity(unitVector(query), ours) - recallSimilarity(query, theirs)) < 1e-12);
  });
});

test("an embedding goes with its message: delete, clear, expiry, and edits or transcripts that change its words", async () => {
  const { db, clock } = openTemp();
  const put = (key) => db.vectors.put(sid(false, PEER, key), MODEL, direction(0), wordsOf(db, sid(false, PEER, key)));
  db.messages.upsert(textMessage(PEER, "DEL", T0, "șterge"));
  db.messages.upsert(textMessage(PEER, "EDIT", T0 + 1000, "prima formă"));
  db.messages.upsert({ ...textMessage(PEER, "VOICE", T0 + 2000, "[voice]"), type: "audio" });
  db.messages.upsert(textMessage(PEER, "EXP", T0 + 3000, "efemer", { expiresAt: clock.now + 5000 }));
  db.messages.upsert(textMessage(OTHER, "CLR", T0 + 4000, "golit"));
  db.messages.upsert(textMessage(OTHER, "KEEP", T0 + 5000, "rămâne"));
  for (const key of ["DEL", "EDIT", "VOICE", "EXP"]) assert.equal(put(key), true);
  for (const key of ["CLR", "KEEP"]) assert.equal(db.vectors.put(sid(false, OTHER, key), MODEL, direction(1), wordsOf(db, sid(false, OTHER, key))), true);
  assert.equal(db.vectors.count(MODEL), 6);

  db.messages.delete(sid(false, PEER, "DEL"));
  assert.equal(db.vectors.get(sid(false, PEER, "DEL")), null);
  db.messages.upsert(textMessage(PEER, "EDIT", T0 + 1000, "a doua formă", { editedAt: T0 + 9000 }));
  assert.equal(db.vectors.get(sid(false, PEER, "EDIT")), null, "a vector of words the message no longer says is dropped");
  db.messages.upsert(textMessage(PEER, "EDIT", T0 + 1000, "a doua formă", { editedAt: T0 + 9000 }));
  db.messages.setTranscript(sid(false, PEER, "VOICE"), "cumpără lapte");
  assert.equal(db.vectors.get(sid(false, PEER, "VOICE")), null);
  await db.messages.clearChat(OTHER, T0 + 4000);
  assert.equal(db.vectors.get(sid(false, OTHER, "KEEP")).model, MODEL);
  clock.now += 5000;
  await db.messages.expireDue();
  assert.equal(db.vectors.count(), 1);
  assert.deepEqual(
    db.vectors.backlog({ model: MODEL, limit: 10 }).items.map((item) => item.sid),
    [sid(false, PEER, "VOICE"), sid(false, PEER, "EDIT")]
  );
  db.close();
});

test("finding 7: a vector made from words the message no longer says is refused, and the message stays in the backlog", () => {
  const { db } = openTemp();
  const target = sid(false, PEER, "A");
  db.messages.upsert(textMessage(PEER, "A", T0, "my card PIN is 4321"));
  const job = db.vectors.backlog({ model: "m", limit: 10 }).items[0];
  db.messages.upsert(textMessage(PEER, "A", T0, "never mind", { editedAt: T0 + 60_000 }));
  assert.equal(db.vectors.put(job.sid, "m", [1, 0, 0, 0], job.contentHash), false, "the vector of the old words is refused");
  assert.equal(db.vectors.get(target), null);
  const again = db.vectors.backlog({ model: "m", limit: 10 }).items;
  assert.deepEqual(again.map((item) => [item.sid, item.text]), [[target, "never mind"]]);
  assert.deepEqual(db.vectors.vectorSearch({ model: "m", vector: [1, 0, 0, 0], limit: 5, minSimilarity: 0.9 }), []);
  assert.equal(db.vectors.put(target, "m", [0, 1, 0, 0], again[0].contentHash), true);
  db.messages.setTranscript(target, "voce");
  assert.equal(db.vectors.get(target), null, "a transcript changes the words, so the stored vector goes");
  assert.equal(job.contentHash, contentHash("my card PIN is 4321", null));
  db.close();
});

test("the backlog lists visible messages with words and no vector from that model, newest first, resumably", () => {
  const { db, clock } = openTemp();
  for (let i = 0; i < 12; i++) db.messages.upsert(textMessage(PEER, `B${i}`, T0 + i * 1000, `mesaj ${i}`));
  db.messages.upsert({ ...textMessage(PEER, "IMG", T0 + 20_000, null), type: "image", text: null });
  db.messages.upsert(textMessage(PEER, "GONE", T0 + 21_000, "expirat", { expiresAt: clock.now - 1 }));
  db.messages.delete(sid(false, PEER, "B11"));
  for (const i of [10, 9, 8, 7]) db.vectors.put(sid(false, PEER, `B${i}`), MODEL, direction(i % DIMS), wordsOf(db, sid(false, PEER, `B${i}`)));
  db.vectors.put(sid(false, PEER, "B6"), "e5-base-multilingual", direction(2), wordsOf(db, sid(false, PEER, "B6")));

  const first = db.vectors.backlog({ model: MODEL, limit: 3, scanCap: 100 });
  assert.deepEqual(first.items.map((item) => item.sid.split("_").pop()), ["B6", "B5", "B4"]);
  assert.equal(first.hasMore, true);
  const capped = db.vectors.backlog({ model: MODEL, limit: 3, before: first.nextBefore, scanCap: 2 });
  assert.deepEqual(capped.items.map((item) => item.sid.split("_").pop()), ["B3", "B2"]);
  assert.equal(capped.hasMore, true);
  const rest = db.vectors.backlog({ model: MODEL, limit: 10, before: capped.nextBefore });
  assert.deepEqual(rest.items.map((item) => item.sid.split("_").pop()), ["B1", "B0"]);
  assert.equal(rest.hasMore, false);
  db.close();
});

test("the embedding queue: while a model is fed, stored and edited words queue their message, and a vector, a delete or a skip takes it off", async () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "BEFORE", T0, "înainte de feed"));
  assert.equal(db.vectors.queueSize(), 0, "nothing is queued while no model is fed");
  assert.deepEqual(db.vectors.feed(MODEL), { refilling: true }, "a model fed for the first time owes a refill");
  while (db.vectors.refill(2)) {
    /* bounded steps */
  }
  assert.deepEqual(db.vectors.feed(MODEL), { refilling: false });
  assert.deepEqual(db.vectors.queued({ model: MODEL, limit: 10 }).items.map((item) => item.sid), [sid(false, PEER, "BEFORE")]);

  db.messages.upsert(textMessage(PEER, "NEW", T0 + 1000, "mesaj nou"));
  db.messages.upsert(textMessage(PEER, "OLD", T0 - 86_400_000, "mesaj vechi"));
  db.messages.upsert({ ...textMessage(PEER, "IMG", T0 + 2000, null), type: "image", text: null });
  const queued = db.vectors.queued({ model: MODEL, limit: 10 });
  assert.deepEqual(queued.items.map((item) => item.sid.split("_").pop()), ["NEW", "BEFORE", "OLD"], "newest first, whatever order they arrived in");

  const byKey = Object.fromEntries(queued.items.map((item) => [item.sid.split("_").pop(), item]));
  assert.equal(db.vectors.put(byKey.NEW.sid, MODEL, direction(0), byKey.NEW.contentHash), true);
  db.messages.delete(byKey.OLD.sid);
  db.vectors.dequeue([byKey.BEFORE.id]);
  assert.equal(db.vectors.queueSize(), 0, "embedded, deleted and skipped messages leave the queue");

  db.messages.upsert(textMessage(PEER, "NEW", T0 + 1000, "mesaj nou, editat", { editedAt: T0 + 5000 }));
  db.messages.setTranscript(sid(false, PEER, "BEFORE"), "cu voce");
  assert.deepEqual(db.vectors.queued({ model: MODEL, limit: 10 }).items.map((item) => item.sid.split("_").pop()), ["NEW", "BEFORE"], "new words queue the message again");

  db.vectors.unfeed();
  assert.equal(db.vectors.queueSize(), 0);
  db.messages.upsert(textMessage(PEER, "AFTER", T0 + 9000, "după"));
  assert.equal(db.vectors.queueSize(), 0, "a model no longer fed queues nothing");
  db.close();
});

test("the refill queues only what has no vector from the model, in bounded steps that resume after a reopen", () => {
  const { db, path, clock } = openTemp();
  for (let i = 0; i < 10; i++) db.messages.upsert(textMessage(PEER, `R${i}`, T0 + i * 1000, `rând ${i}`));
  for (const i of [9, 5, 1]) db.vectors.put(sid(false, PEER, `R${i}`), MODEL, direction(i % DIMS), wordsOf(db, sid(false, PEER, `R${i}`)));
  assert.deepEqual(db.vectors.feed(MODEL), { refilling: true });
  assert.equal(db.vectors.refill(4), true, "the first step covers four rows and owes more");
  assert.equal(db.vectors.queueSize(), 3, "R8, R7, R6 — R9 has its vector");
  db.close();

  const reopened = AccountDb.open(path, { now: () => clock.now, checkpointDelayMs: 0 });
  assert.deepEqual(reopened.vectors.feed(MODEL), { refilling: true }, "the refill's place survives the reopen");
  while (reopened.vectors.refill(4)) {
    /* resumes below R6 */
  }
  assert.deepEqual(reopened.vectors.queued({ model: MODEL, limit: 20 }).items.map((item) => item.sid.split("_").pop()), ["R8", "R7", "R6", "R4", "R3", "R2", "R0"]);
  assert.deepEqual(reopened.vectors.feed("e5-base-multilingual"), { refilling: true }, "another model owes its own refill");
  reopened.close();
});

test("vector search ranks by cosine under the filters and the floor, and skips expired rows", () => {
  const { db, clock } = openTemp();
  const docs = [
    ["NEAR", PEER, T0, direction(0, 1, 0.1)],
    ["MID", PEER, T0 + 1000, direction(0, 1, 1)],
    ["FAR", OTHER, T0 + 2000, direction(1)],
    ["GRP", GROUP, T0 + 3000, direction(0, 2, 0.05)],
    ["EXP", PEER, T0 + 4000, direction(0)],
  ];
  for (const [key, chat, ts, vector] of docs) {
    const extra = chat === GROUP ? { senderJid: OTHER } : key === "EXP" ? { expiresAt: clock.now + 10 } : {};
    db.messages.upsert(textMessage(chat, key, ts, `doc ${key}`, extra));
    assert.equal(db.vectors.put(sid(false, chat, key), MODEL, vector, wordsOf(db, sid(false, chat, key))), true);
  }
  clock.now += 10;
  const keys = (hits) => hits.map((hit) => hit.message.keyId);
  const all = db.vectors.vectorSearch({ model: MODEL, vector: direction(0), limit: 10 });
  assert.deepEqual(keys(all), ["GRP", "NEAR", "MID"]);
  assert.ok(all[0].similarity > 0.99 && all[2].similarity < 0.72 && all[2].similarity > 0.7);
  assert.deepEqual(keys(db.vectors.vectorSearch({ model: MODEL, vector: direction(0), limit: 10, minSimilarity: 0.9 })), ["GRP", "NEAR"]);
  assert.deepEqual(keys(db.vectors.vectorSearch({ model: MODEL, vector: direction(0), limit: 10, chat: PEER })), ["NEAR", "MID"]);
  assert.deepEqual(keys(db.vectors.vectorSearch({ model: MODEL, vector: direction(0), limit: 10, from: OTHER })), ["GRP"]);
  assert.deepEqual(keys(db.vectors.vectorSearch({ model: MODEL, vector: direction(0), limit: 10, since: T0 + 1, until: T0 + 3000 })), ["GRP", "MID"]);
  assert.deepEqual(keys(db.vectors.vectorSearch({ model: MODEL, vector: direction(0), limit: 1 })), ["GRP"]);
  assert.deepEqual(keys(db.vectors.vectorSearch({ model: "e5-base-multilingual", vector: direction(0), limit: 10 })), []);
  db.close();
});

test("n9: vector and hybrid search still fill their pages while a clear's purge is pending", async () => {
  const { db, path, clock } = openTemp();
  const put = (messageSid, vector) => db.vectors.put(messageSid, MODEL, vector, wordsOf(db, messageSid));
  for (let i = 0; i < 100; i++) {
    db.messages.upsert(textMessage(PEER, `C${i}`, T0 + i * 1000, `cleared ${i}`));
    put(sid(false, PEER, `C${i}`), [1, 0.01 * i, 0]);
  }
  for (let i = 0; i < 20; i++) {
    db.messages.upsert(textMessage(OTHER, `V${i}`, T0 + i * 1000, `visible ${i}`));
    put(sid(false, OTHER, `V${i}`), [1, 0.5, 0.3]);
  }
  db.messages.clearChat(PEER, T0 + 200_000).catch(() => {});
  db.close();

  const reopened = AccountDb.open(path, { now: () => clock.now, checkpointDelayMs: 0 });
  const vector = reopened.vectors.vectorSearch({ model: MODEL, vector: [1, 0, 0], limit: 10, minSimilarity: 0.5 });
  assert.equal(vector.length, 10);
  assert.ok(vector.every((hit) => hit.message.chatJid === OTHER));
  const hybrid = reopened.vectors.hybrid({ query: "zzzz", model: MODEL, vector: [1, 0, 0], limit: 10, minSimilarity: 0.5 });
  assert.equal(hybrid.hits.length, 10);
  await reopened.resume();
  assert.equal(reopened.vectors.vectorSearch({ model: MODEL, vector: [1, 0, 0], limit: 10, minSimilarity: 0.5 }).length, 10);
  reopened.close();
});

test("an int8 vector imported as-is is searched like one quantized here", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "IMP", T0, "importat"));
  const quantized = quantizeVector(direction(3, 4, 0.5));
  assert.equal(db.vectors.put(sid(false, PEER, "IMP"), MODEL, quantized, wordsOf(db, sid(false, PEER, "IMP"))), true);
  assert.deepEqual([...db.vectors.get(sid(false, PEER, "IMP")).vector], [...quantized]);
  const [hit] = db.vectors.vectorSearch({ model: MODEL, vector: direction(3, 4, 0.5), limit: 1 });
  assert.ok(Math.abs(hit.similarity - 1) < 0.01);
  db.close();
});

test("hybrid search: both ways outranks either, meaning-only hits need the floor, an unanswerable question returns nothing", () => {
  const { db } = openTemp();
  const docs = [
    // Found by the word and by meaning.
    ["BOTH", T0, "Am trimis factura pe august", direction(0, 1, 0.2)],
    // Found only by meaning: a paraphrase that shares no word with the query.
    ["PARA", T0 + 1000, "Ți-am dat documentul de plată pentru luna trecută", direction(0, 1, 0.6)],
    // Found only by meaning, weakly: under a strict floor it is noise.
    ["WEAK", T0 + 2000, "Mergem la munte sâmbătă", direction(0, 5, 2.5)],
    // Found only by the word.
    ["WORD", T0 + 3000, "Factura de gaz a venit", direction(6)],
    ["NONE", T0 + 4000, "Ce mai faci?", direction(7)],
  ];
  for (const [key, ts, text, vector] of docs) {
    db.messages.upsert(textMessage(PEER, key, ts, text));
    db.vectors.put(sid(false, PEER, key), MODEL, vector, wordsOf(db, sid(false, PEER, key)));
  }
  const keys = (result) => result.hits.map((hit) => hit.message.keyId);

  const result = db.vectors.hybrid({ query: "Unde e factura?", vector: direction(0), model: MODEL, limit: 10, minSimilarity: 0.35 });
  assert.equal(result.semantic, true);
  // RRF with k = 60: BOTH 1/62 + 1/61, WORD 1/61 (lexical 1st), PARA 1/62 (semantic 2nd), WEAK 1/63.
  assert.deepEqual(keys(result), ["BOTH", "WORD", "PARA", "WEAK"]);
  const both = result.hits[0];
  assert.deepEqual([both.lexicalRank !== null, both.semanticRank !== null], [true, true]);
  assert.ok(result.hits.every((hit) => hit.lexicalRank !== null || hit.similarity >= 0.35));

  const strict = db.vectors.hybrid({ query: "Unde e factura?", vector: direction(0), model: MODEL, limit: 10, minSimilarity: 0.8 });
  assert.deepEqual(keys(strict), ["BOTH", "WORD", "PARA"], "a weak meaning-only hit is noise under the floor; a lexical one needs none");

  const nothing = db.vectors.hybrid({ query: "Când pleacă trenul spre Viena?", vector: direction(3), model: MODEL, limit: 10, minSimilarity: 0.35 });
  assert.deepEqual(nothing.hits, []);

  const lexicalOnly = db.vectors.hybrid({ query: "factura", model: MODEL, limit: 10, minSimilarity: 0.35 });
  assert.equal(lexicalOnly.semantic, false);
  assert.deepEqual(keys(lexicalOnly), ["WORD", "BOTH"]);
  assert.deepEqual(keys(db.vectors.hybrid({ query: "factura", vector: direction(0), model: MODEL, limit: 10, minSimilarity: 0.35, chat: OTHER })), []);
  db.close();
});

test("finding 10: hybrid finds an exact multi-word match buried under newer messages that share only a common word", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "TARGET", T0, "factura Enel pentru luna august a venit"));
  for (let i = 0; i < 150; i++) db.messages.upsert(textMessage(PEER, `N${i}`, T0 + 10_000 + i * 1000, `multumesc pentru tot ${i}`));
  const result = db.vectors.hybrid({ query: "factura Enel pentru august", model: "m", limit: 10, minSimilarity: 0.5 });
  assert.equal(result.hits[0]?.message.keyId, "TARGET");
  assert.equal(result.lexicalCapped, true, "the common word had more matches than were examined");
  const narrow = db.vectors.hybrid({ query: "factura Enel", model: "m", limit: 10, minSimilarity: 0.5 });
  assert.deepEqual(narrow.hits.map((hit) => hit.message.keyId), ["TARGET"]);
  assert.equal(narrow.lexicalCapped, false);
  db.close();
});

test("n6: hybrid finds a message made only of common words, and looks up digits and acronyms too short for the index", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "TARGET", T0, "pentru luna august plata chiria"));
  for (const [word, start] of [["pentru", 10_000], ["luna", 400_000], ["august", 800_000], ["plata chiria", 1_200_000]]) {
    for (let i = 0; i < 150; i++) db.messages.upsert(textMessage(PEER, `${word}-${i}`, T0 + start + i * 1000, `${word} ${i}`));
  }
  const rank = (query) => db.vectors.hybrid({ query, model: "m", limit: 10, minSimilarity: 0.5 }).hits.findIndex((hit) => hit.message.keyId === "TARGET");
  assert.equal(rank("pentru luna august plata"), 0);
  assert.equal(rank("luna august plata chiria"), 0);

  db.messages.upsert(textMessage(PEER, "SHORT", T0 + 5, "PIN 42 la BT"));
  for (let i = 0; i < 5; i++) db.messages.upsert(textMessage(PEER, `S${i}`, T0 + 2_000_000 + i, `pin ${i}`));
  assert.equal(db.vectors.hybrid({ query: "PIN BT", model: "m", limit: 10, minSimilarity: 0.5 }).hits[0]?.message.keyId, "SHORT");
  const tiny = db.vectors.hybrid({ query: "BT 42", model: "m", limit: 10, minSimilarity: 0.5 });
  assert.equal(tiny.hits[0]?.message.keyId, "SHORT");
  db.close();
});

test("hybrid: a hit sharing one word of a three-word query is noise unless its meaning clears the floor", () => {
  const { db } = openTemp();
  const put = (key, ts, text, vector) => {
    db.messages.upsert(textMessage(PEER, key, ts, text));
    assert.equal(db.vectors.put(sid(false, PEER, key), MODEL, vector, wordsOf(db, sid(false, PEER, key))), true);
  };
  // Long messages, each carrying exactly one word of the query and nothing of its meaning.
  put("PLASMA", T0, "Am citit azi un articol lung despre donarea de plasma la centrul de transfuzii, apoi am trecut pe la piață după roșii și brânză pentru cina de sâmbătă seara", direction(1));
  put("CONTAIN", T0 + 1000, "Echipa de la bloc a pus un containment provizoriu în jurul țevii sparte din subsol, dar apa tot a ajuns în boxele vecinilor până a venit instalatorul spre seară", direction(2));
  put("FIELD", T0 + 2000, "Meciul copiilor s-a mutat pe field-ul din spatele școlii, fiindcă terenul mare e închis toată săptămâna pentru gazon nou și un gard refăcut de primărie", direction(3));
  put("CALIB", T0 + 3000, "Tehnicianul vine mâine dimineață pentru calibration la imprimanta cea nouă de la birou, deci ajung mai târziu și nu mai prind ședința de la nouă", direction(4));
  put("PROC", T0 + 4000, "Procedure-ul băncii pentru cardul nou durează două săptămâni, așa că le-am cerut să mi-l trimită prin curier acasă, nu la sucursala din centru", direction(5));
  const query = "plasma containment field calibration procedure";
  const search = (over = {}) => db.vectors.hybrid({ query, vector: direction(0), model: MODEL, limit: 10, minSimilarity: 0.35, ...over });
  const keys = (result) => result.hits.map((hit) => hit.message.keyId);

  assert.deepEqual(keys(search()), [], "five one-word matches of a five-word query are not an answer");
  assert.deepEqual(keys(search({ vector: null })), [], "nor are they without a query vector");
  assert.deepEqual(keys(search({ query: "plasma field" })), [], "one word of a two-word query, and none of its meaning, is noise too");
  assert.deepEqual(keys(search({ query: "plasma field", vector: null })), ["FIELD", "PLASMA"], "without a query vector the word is all there is");
  assert.deepEqual(keys(search({ query: "calibration" })), ["CALIB"]);

  // Two words of the query, or the whole of it, stand on their own.
  put("PAIR", T0 + 5000, "Am primit procedure-ul de calibration pentru cântar, îl citesc diseară", direction(6));
  put("PHRASE", T0 + 6000, "Pe tablă scria plasma containment field calibration procedure și nimeni nu știa de unde vine", direction(7));
  assert.deepEqual(keys(search()).sort(), ["PAIR", "PHRASE"]);

  // One word whose message is close in meaning stays, under the floor it does not.
  put("NEAR", T0 + 7000, "Ți-am trimis procedure-ul", direction(0, 1, 0.3));
  put("BELOW", T0 + 8000, "Am găsit plasma veche în frigider", direction(0, 2, 4));
  const near = search().hits.find((hit) => hit.message.keyId === "NEAR");
  assert.ok(near && near.similarity > 0.9, "a one-word hit its meaning vouches for is kept, as both");
  assert.ok(!keys(search()).includes("BELOW"), "a one-word hit whose meaning ranked it under the floor is dropped");
  // Its meaning counts even when the semantic side ranked closer messages ahead of it.
  put("TOP", T0 + 9000, "Nimic din cuvintele căutate aici", direction(0));
  const narrow = search({ semanticCandidates: 1 });
  const kept = narrow.hits.find((hit) => hit.message.keyId === "NEAR");
  assert.ok(kept, "NEAR is kept though only TOP was a semantic candidate");
  assert.deepEqual([kept.semanticRank, kept.similarity], [null, null], "and it reads as a match by words, as before");
  assert.ok(!keys(narrow).includes("BELOW"));
  db.close();
});

test("hybrid: function words do not make a question long, so one content word of a two-word question still answers it", () => {
  const { db } = openTemp();
  const put = (key, ts, text, vector) => {
    db.messages.upsert(textMessage(PEER, key, ts, text));
    assert.equal(db.vectors.put(sid(false, PEER, key), MODEL, vector, wordsOf(db, sid(false, PEER, key))), true);
  };
  // Each carries one content word of the question, and a meaning just under the floor.
  put("TIME", T0, "Let's say 7pm, if that time still works for you", direction(0, 1, 1.78));
  put("VEDEM", T0 + 1000, "Ne vedem la șapte la Ana acasă", direction(0, 2, 1.78));
  const search = (query) => db.vectors.hybrid({ query, vector: direction(0), model: MODEL, limit: 10, minSimilarity: 0.5 });
  const keys = (result) => result.hits.map((hit) => hit.message.keyId);

  // "what", "are", "we": three looked-up words, two of them content words.
  const english = search("what time are we meeting");
  assert.deepEqual(keys(english), ["TIME"]);
  assert.deepEqual([english.hits[0].lexicalRank, english.hits[0].semanticRank], [1, null], "kept for its word, its meaning (0.49) under the floor");
  assert.deepEqual(keys(search("Când ne vedem mâine?")), ["VEDEM"], "„când” is a function word, „vedem” and „mâine” the question");
  assert.deepEqual(keys(search("la ce oră ne vedem")), ["VEDEM"]);
  // Three content words still need two of them.
  assert.deepEqual(keys(search("what time is the team meeting")), []);
  db.close();
});

test("hybrid: function words answer nothing, neither beside a long question nor alone", () => {
  const { db } = openTemp();
  const put = (key, ts, text, vector) => {
    db.messages.upsert(textMessage(PEER, key, ts, text));
    assert.equal(db.vectors.put(sid(false, PEER, key), MODEL, vector, wordsOf(db, sid(false, PEER, key))), true);
  };
  put("PADDED", T0, "What did they say about the plasma donation on Saturday?", direction(1));
  put("WHO", T0 + 1000, "Are you sure the plumber said Tuesday? Who told you that", direction(2));
  put("ESTE", T0 + 2000, "Ședința este mâine la zece, asta e tot ce știu", direction(3));
  put("PHRASE", T0 + 3000, "Sorry, who are you?", direction(4));
  put("NEAR", T0 + 4000, "Are you the new neighbour?", direction(0, 5, 0.3));
  const search = (query, over = {}) => db.vectors.hybrid({ query, vector: direction(7), model: MODEL, limit: 10, minSimilarity: 0.5, ...over });
  const keys = (result) => result.hits.map((hit) => hit.message.keyId);

  assert.deepEqual(keys(search("plasma containment field calibration procedure")), []);
  assert.deepEqual(keys(search("what is the plasma containment field calibration procedure")), [], "„what” is no second word of the question");

  // A query of function words alone: only the phrase itself, or a meaning at the floor, answers it.
  assert.deepEqual(keys(search("who are you")), ["PHRASE"]);
  assert.deepEqual(keys(search("ce este asta")), []);
  assert.deepEqual(keys(search("the")), []);
  assert.deepEqual(keys(search("the", { vector: null })), []);
  const near = search("the", { vector: direction(0) });
  assert.deepEqual(keys(near), ["NEAR"]);
  assert.ok(near.hits[0].lexicalRank !== null && near.hits[0].similarity > 0.9, "a function-word hit its meaning vouches for stays, as both");
  db.close();
});

const DAY = 86_400_000;

/** A vector whose cosine with direction(0) is `cosine`, bent toward `axis`. */
function atCosine(cosine, axis) {
  return direction(0, axis, Math.sqrt(1 / (cosine * cosine) - 1));
}

test("hybrid with recency: an old close match outranks fresh weak ones sharing its word, however few candidates meaning takes", () => {
  const { db, clock } = openTemp();
  clock.now = T0 + 400 * DAY;
  const put = (key, daysAgo, text, vector) => {
    db.messages.upsert(textMessage(PEER, key, clock.now - daysAgo * DAY, text));
    assert.equal(db.vectors.put(sid(false, PEER, key), MODEL, vector, wordsOf(db, sid(false, PEER, key))), true);
  };
  put("OLD", 120, "Cafeneaua de pe Florilor 12 are terasă și deschide la opt", atCosine(0.66, 1));
  put("F1", 1, "Cafeneaua a fost plină azi", atCosine(0.34, 2));
  put("F2", 2, "Am uitat umbrela la cafeneaua lor", atCosine(0.3, 3));
  put("F3", 3, "Cafeneaua era închisă", atCosine(0.25, 4));
  const search = (over = {}) =>
    db.vectors.hybrid({ query: "unde e cafeneaua", vector: direction(0), model: MODEL, limit: 10, minSimilarity: 0.35, recencyHalfLifeMs: 30 * DAY, ...over });
  const keys = (result) => result.hits.map((hit) => hit.message.keyId);

  const result = search();
  assert.deepEqual(keys(result), ["OLD", "F1", "F2", "F3"], "four months old, it is still the one that answers");
  assert.deepEqual([result.hits[0].lexicalRank, result.hits[0].semanticRank], [4, 1]);
  assert.ok(result.hits.slice(1).every((hit) => hit.semanticRank === null && hit.similarity === null), "the fresh ones are word hits only");
  assert.equal(keys(search({ semanticCandidates: 1 }))[0], "OLD", "the one candidate meaning takes is the most similar, not the freshest");
  db.close();
});

test("hybrid with recency: a four-month-old paraphrase at 0.42 is still found, with no word of the query", () => {
  const { db, clock } = openTemp();
  clock.now = T0 + 400 * DAY;
  db.messages.upsert(textMessage(PEER, "OLD", clock.now - 120 * DAY, "Daca tu imi promiti ca o sa ai grija de masina"));
  assert.equal(db.vectors.put(sid(false, PEER, "OLD"), MODEL, atCosine(0.42, 1), wordsOf(db, sid(false, PEER, "OLD"))), true);
  const result = db.vectors.hybrid({ query: "automobil", vector: direction(0), model: MODEL, limit: 10, minSimilarity: 0.35, recencyHalfLifeMs: 30 * DAY });
  assert.deepEqual(result.hits.map((hit) => hit.message.keyId), ["OLD"], "weighed by age it would be 0.30, under the floor");
  db.close();
});

test("hybrid: one word of a two-word query stays with part of a meaning, and long messages that only contain it go", () => {
  const { db } = openTemp();
  const put = (key, ts, text, vector) => {
    db.messages.upsert(textMessage(PEER, key, ts, text));
    assert.equal(db.vectors.put(sid(false, PEER, key), MODEL, vector, wordsOf(db, sid(false, PEER, key))), true);
  };
  put("REPORT", T0, "Sync-ul a adus 110 contacte noi; singura grijă rămâne lista de la service, pe care o verific mâine dimineață", atCosine(0.2, 1));
  put("ANSWER", T0 + 1000, "Ai grijă de ea cât sunt plecat", atCosine(0.42, 2));
  const search = (over = {}) => db.vectors.hybrid({ query: "grija automobil", vector: direction(0), model: MODEL, limit: 10, minSimilarity: 0.35, ...over });
  const keys = (result) => result.hits.map((hit) => hit.message.keyId);
  assert.deepEqual(keys(search()), ["ANSWER"], "0.42 clears 70% of the floor, 0.2 does not");
  assert.deepEqual(keys(search({ vector: null })).sort(), ["ANSWER", "REPORT"]);
  db.close();
});

test("hybrid: a word hit whose meaning is under the floor fuses as a word hit, never over a match by meaning alone", () => {
  const { db } = openTemp();
  const put = (key, ts, text, vector) => {
    db.messages.upsert(textMessage(PEER, key, ts, text));
    assert.equal(db.vectors.put(sid(false, PEER, key), MODEL, vector, wordsOf(db, sid(false, PEER, key))), true);
  };
  put("WORD", T0, "Factura a venit", atCosine(0.3, 1));
  put("MEANING", T0 + 1000, "Plata pentru curent e scadentă mâine", atCosine(0.6, 2));
  const result = db.vectors.hybrid({ query: "factura de gaz", vector: direction(0), model: MODEL, limit: 10, minSimilarity: 0.35 });
  const byKey = new Map(result.hits.map((hit) => [hit.message.keyId, hit]));
  assert.deepEqual([...byKey.keys()], ["MEANING", "WORD"]);
  assert.deepEqual([byKey.get("WORD").lexicalRank, byKey.get("WORD").semanticRank, byKey.get("WORD").similarity], [1, null, null]);
  assert.ok(byKey.get("WORD").score <= byKey.get("MEANING").score, "its meaning under the floor adds nothing to its words");
  db.close();
});

test("hybrid with recency: equal matches go newest first, an old one ranks lower but is never dropped", () => {
  const { db, clock } = openTemp();
  clock.now = T0 + 400 * DAY;
  const put = (key, daysAgo, text, vector) => {
    db.messages.upsert(textMessage(PEER, key, clock.now - daysAgo * DAY, text));
    assert.equal(db.vectors.put(sid(false, PEER, key), MODEL, vector, wordsOf(db, sid(false, PEER, key))), true);
  };
  put("TWIN_OLD", 60, "Am lăsat cheile la portar", atCosine(0.6, 1));
  put("TWIN_NEW", 1, "Cheile sunt la vecina de la 3", atCosine(0.6, 2));
  put("EDGE_OLD", 36, "Ok mersi", atCosine(0.36, 3));
  put("EDGE_NEW", 1, "Bine atunci", atCosine(0.36, 4));
  put("STRONG_OLD", 365, "Rezerva e în cutia poștală", atCosine(0.52, 5));
  const result = db.vectors.hybrid({ query: "zzz", vector: direction(0), model: MODEL, limit: 10, minSimilarity: 0.35, recencyHalfLifeMs: 30 * DAY });
  assert.deepEqual(
    result.hits.map((hit) => hit.message.keyId),
    ["TWIN_NEW", "TWIN_OLD", "STRONG_OLD", "EDGE_NEW", "EDGE_OLD"],
    "age orders matches at the floor and drops none: the old borderline one comes last, a year-old 0.52 keeps 70% of its rank"
  );
  assert.ok(result.hits.every((hit) => hit.lexicalRank === null));
  db.close();
});

test("hybrid lexical ranking prefers candidates carrying more of the query words", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "ONE", T0 + 2000, "contractul e gata"));
  db.messages.upsert(textMessage(PEER, "TWO", T0, "contractul de închiriere e semnat"));
  db.messages.upsert(textMessage(PEER, "ZERO", T0 + 3000, "nimic"));
  const result = db.vectors.hybrid({ query: "contractul de închiriere", model: MODEL, limit: 5, minSimilarity: 0.35 });
  assert.deepEqual(result.hits.map((hit) => hit.message.keyId), ["TWO", "ONE"]);
  assert.deepEqual(hybridTokens("Unde e ședința de mâine?"), ["unde", "sedinta", "maine"]);
  assert.deepEqual(hybridTokens("ce zi e"), []);
  assert.deepEqual(hybridTokens("ora 17"), ["ora", "17"]);
  assert.deepEqual(hybridTokens("PIN la BT"), ["pin", "bt"]);
  db.close();
});

test("vectors survive reopen and a read-only connection can search them", () => {
  const { db, path } = openTemp();
  db.messages.upsert(textMessage(PEER, "P", T0, "persistent"));
  db.vectors.put(sid(false, PEER, "P"), MODEL, direction(2), wordsOf(db, sid(false, PEER, "P")));
  db.close();
  const reader = AccountDb.open(path, { readOnly: true });
  assert.deepEqual(reader.vectors.vectorSearch({ model: MODEL, vector: direction(2), limit: 1 }).map((hit) => hit.message.keyId), ["P"]);
  assert.equal(reader.vectors.hybrid({ query: "persistent", vector: direction(2), model: MODEL, limit: 1, minSimilarity: 0.35 }).hits.length, 1);
  reader.close();
});
