/**
 * The large operations — clearing or deleting a chat, the expiry sweep, a
 * lid/phone merge — run as short transactions with the event loop turning
 * between them, hand back every derived file to unlink, flush deleted bytes
 * out of the WAL at the end, and leave live writes that land in between
 * subject to the same barriers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { AccountDb } from "../dist/db/index.js";
import { PEER, PEER_LID, T0, openTemp, sid, textMessage, wordsOf } from "./db-fixtures.mjs";

const turn = () => new Promise((resolve) => setImmediate(resolve));

const OTHER = "40700000003@s.whatsapp.net";
/** Generous on purpose: a 200-row chunk takes a few ms; the bound only catches a loop that never yields. */
// The bound proves chunks stay small, not how fast a machine is: shared CI
// runners stall several times longer on the same chunk, and the turn count
// above each check already proves the loop ran between chunks.
const MAX_BLOCK_MS = process.env.CI ? 1_000 : 250;

/** Counts event-loop turns and the longest stall while `work` runs. */
async function watchLoop(work) {
  let turns = 0;
  let longest = 0;
  let last = performance.now();
  let running = true;
  const tick = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    turns++;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  const result = await work();
  running = false;
  return { result, turns, longest };
}

function fill(db, chat, count, { media = 0, prefix = "M", start = T0 } = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push(textMessage(chat, `${prefix}${i}`, start + i * 1000, `mesaj ${i} despre factură și ședință`));
  }
  for (let i = 0; i < rows.length; i += 500) db.messages.upsertMany(rows.slice(i, i + 500));
  for (let i = 0; i < media; i++) db.messages.setMedia(sid(false, chat, `${prefix}${i}`), "preview", `/previews/${prefix}${i}.jpg`);
}

test("clearing thousands of rows yields between chunks, returns every file, and truncates the WAL", async () => {
  const { db, path } = openTemp();
  fill(db, PEER, 3000, { media: 120 });
  fill(db, OTHER, 10);
  const { result, turns, longest } = await watchLoop(() => db.messages.clearChat(PEER, T0 + 3_000_000));
  assert.equal(result.count, 3000);
  assert.equal(result.mediaPaths.length, 120);
  assert.ok(turns >= Math.floor(3000 / 200) - 1, `the loop turned ${turns} times`);
  assert.ok(longest < MAX_BLOCK_MS, `longest stall ${longest.toFixed(1)} ms`);
  assert.equal(statSync(`${path}-wal`).size, 0, "the checkpoint after the batch truncates the WAL");
  assert.deepEqual(db.messages.countInChat(PEER), { messages: 0, tombstones: 0 });
  assert.equal(db.counts().messages, 10);
  assert.equal(db.search.text({ query: "factur", limit: 50 }).items.length, 10);
  assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });
  db.close();
});

test("live writes land between chunks of a clear, and the barrier already holds for them", async () => {
  const { db } = openTemp({ chunkSize: 50 });
  fill(db, PEER, 1000);
  const clearing = db.messages.clearChat(PEER, T0 + 999_000);
  // The clear first folds the log the fill left, in a turn of its own; then its chunks start.
  const rows = () => db["connection"].get("SELECT count(*) AS n FROM messages").n;
  for (let turns = 0; rows() === 1000 && turns < 5; turns++) await new Promise((resolve) => setImmediate(resolve));
  const older = db.messages.upsert(textMessage(PEER, "LATE-OLD", T0 + 10, "vechi"));
  const newer = db.messages.upsert(textMessage(PEER, "LIVE", T0 + 2_000_000, "nou"));
  const midway = db["connection"].get("SELECT count(*) AS n FROM messages").n;
  assert.deepEqual(db.messages.countInChat(PEER), { messages: 1, tombstones: 0 }, "rows under the barrier are hidden before their purge");
  const result = await clearing;
  assert.equal(older.outcome, "cleared");
  assert.equal(newer.outcome, "inserted");
  assert.ok(midway > 1 && midway < 1001, `the write landed mid-clear (${midway} rows physically left)`);
  assert.equal(result.count, 1000);
  assert.deepEqual(db.messages.chatPage(PEER, { limit: 10 }).items.map((m) => m.keyId), ["LIVE"]);
  db.close();
});

test("deleting a chat takes it off the list, keeps its barrier, and returns its files", async () => {
  const { db } = openTemp();
  fill(db, PEER, 450, { media: 3 });
  fill(db, OTHER, 5);
  db.identity.upsertChat({ jid: PEER, archived: true, pinned: 1, unread: 4 });
  db.identity.markHandled(PEER, sid(false, PEER, "M449"));
  const { result, turns } = await watchLoop(() => db.messages.deleteChat(PEER, T0 + 449_000));
  assert.equal(result.count, 450);
  assert.equal(result.mediaPaths.length, 3);
  assert.ok(turns >= 2);
  assert.deepEqual(db.messages.listChats({ limit: 10 }).items.map((item) => item.chat.jid), [OTHER]);
  const chat = db.identity.chat(PEER);
  assert.deepEqual([chat.archived, chat.pinned, chat.unread, chat.clearedThroughTs], [false, null, 0, T0 + 449_000]);
  assert.equal(db.identity.handled(PEER), null);
  assert.equal(db.messages.upsert(textMessage(PEER, "M3", T0 + 3000, "replay")).outcome, "cleared");
  db.close();
});

test("a chat deleted while its purge runs keeps what arrives after the delete: its unread count, archive, handled mark and message", async () => {
  const { db } = openTemp();
  fill(db, PEER, 450);
  db.identity.upsertChat({ jid: PEER, archived: true, pinned: 1, unread: 4 });
  const purge = db.messages.deleteChat(PEER, T0 + 449_000);
  // The chat's reset is part of the delete, so what lands between the purge's chunks is not wiped at its end.
  const reset = db.identity.chat(PEER);
  assert.deepEqual([reset.archived, reset.pinned, reset.unread], [false, null, 0], "the list entry is reset with the barrier");
  await new Promise((resolve) => setImmediate(resolve));
  db.messages.upsert(textMessage(PEER, "LATER", T0 + 500_000, "salut din nou"));
  db.identity.upsertChat({ jid: PEER, archived: true, unread: 1 });
  db.identity.markHandled(PEER, sid(false, PEER, "LATER"));
  await purge;
  const chat = db.identity.chat(PEER);
  assert.deepEqual([chat.archived, chat.unread], [true, 1]);
  assert.notEqual(db.identity.handled(PEER), null);
  assert.deepEqual(db.messages.chatPage(PEER, { limit: 10 }).items.map((m) => m.keyId), ["LATER"]);
  db.close();
});

test("an expiry sweep over thousands of rows yields between chunks and hands back files", async () => {
  const { db, clock } = openTemp();
  const rows = [];
  for (let i = 0; i < 2500; i++) {
    rows.push(textMessage(PEER, `S${i}`, T0 + i, `mesaj ${i}`, { expiresAt: clock.now + 1000 + (i % 7) }));
  }
  db.messages.upsertMany(rows);
  for (let i = 0; i < 40; i++) db.messages.setMedia(sid(false, PEER, `S${i}`), "download", `/media/S${i}`);
  clock.now += 2000;
  const { result, turns, longest } = await watchLoop(() => db.messages.expireDue());
  assert.equal(result.count, 2500);
  assert.equal(result.mediaPaths.length, 40);
  assert.ok(turns >= 11, `the loop turned ${turns} times`);
  assert.ok(longest < MAX_BLOCK_MS, `longest stall ${longest.toFixed(1)} ms`);
  assert.equal(db.counts().tombstones, 2500);
  assert.equal(db.messages.nextExpiry(), null);
  db.close();
});

test("expired stories leave the status feed for good: no tombstone left to walk, and a replay stays out", async () => {
  const { db, clock } = openTemp();
  const STATUS = "status@broadcast";
  const story = (key, ts, expiresAt) => textMessage(STATUS, key, ts, `story ${key}`, { senderJid: OTHER, expiresAt });
  db.messages.upsertMany(Array.from({ length: 300 }, (_, i) => story(`S${i}`, T0 + i, clock.now + 1000)));
  db.messages.upsert(story("LIVE", T0 + 500, clock.now + 86_400_000));
  db.messages.setMedia(sid(false, STATUS, "S0"), "preview", "/previews/S0.jpg");
  assert.equal(db.messages.upsert(story("LATE", T0 - 86_400_000, clock.now - 1)).outcome, "expired", "a story synced after its day");
  clock.now += 2000;
  const swept = await db.messages.expireDue();
  assert.equal(swept.count, 300);
  assert.deepEqual(swept.mediaPaths, ["/previews/S0.jpg"]);
  assert.equal(db.counts().tombstones, 0, "no expired story stays behind as a row");
  assert.deepEqual(db.messages.chatPage(STATUS, { limit: 10 }).items.map((m) => m.keyId), ["LIVE"]);
  for (const key of ["S0", "LATE"]) {
    assert.notEqual(db.messages.upsert(story(key, T0, clock.now + 86_400_000)).outcome, "inserted", `${key} replayed stays gone`);
    assert.equal(db.messages.get(sid(false, STATUS, key)), null);
  }
  assert.equal(db.counts().tombstones, 0, "a replay leaves no row either");
  assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });
  db.close();
});

test("a story its author revoked leaves no row behind either, seen or not, and a replay stays out", async () => {
  const { db, clock } = openTemp();
  const STATUS = "status@broadcast";
  const story = (key) => textMessage(STATUS, key, T0, `story ${key}`, { senderJid: OTHER, expiresAt: clock.now + 86_400_000 });
  db.messages.upsert(story("SEEN"));
  db.messages.setMedia(sid(false, STATUS, "SEEN"), "preview", "/previews/SEEN.jpg");
  assert.deepEqual(db.messages.delete(sid(false, STATUS, "SEEN")).mediaPaths, ["/previews/SEEN.jpg"]);
  assert.equal(db.messages.delete(sid(false, STATUS, "UNSEEN"), { ts: T0 }).outcome, "placeholder");
  assert.equal(db.counts().tombstones, 0, "no revoked story stays behind as a row");
  for (const key of ["SEEN", "UNSEEN"]) {
    assert.notEqual(db.messages.upsert(story(key)).outcome, "inserted", `${key} replayed stays gone`);
    assert.equal(db.messages.get(sid(false, STATUS, key)), null);
  }
  assert.equal(db.counts().tombstones, 0);
  assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });
  db.close();
});

test("a merge of a large lid chat into the phone chat yields between chunks", async () => {
  const { db } = openTemp();
  fill(db, PEER_LID, 2000, { prefix: "L" });
  fill(db, PEER, 500, { prefix: "P", start: T0 + 5_000_000 });
  const { result, turns, longest } = await watchLoop(() => db.learnLidPhone(PEER_LID, PEER));
  assert.equal(result.movedMessages, 2000);
  assert.ok(turns >= 9, `the loop turned ${turns} times`);
  assert.ok(longest < MAX_BLOCK_MS, `longest stall ${longest.toFixed(1)} ms`);
  assert.deepEqual(db.messages.countInChat(PEER), { messages: 2500, tombstones: 0 });
  assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });
  db.close();
});

test("a clear raises its barrier at once, and queued purges run one after another", async () => {
  const { db } = openTemp({ chunkSize: 20 });
  fill(db, PEER, 300);
  const order = [];
  const first = db.messages.clearChat(PEER, T0 + 150_000).then((r) => order.push(["first", r.count]));
  const second = db.messages.clearChat(PEER, T0 + 299_000).then((r) => order.push(["second", r.count]));
  assert.equal(db.messages.upsert(textMessage(PEER, "M250", T0 + 250_000, "replay")).outcome, "cleared", "before any purge ran");
  await Promise.all([first, second]);
  await db.idle();
  assert.deepEqual(order, [["first", 300], ["second", 0]]);
  db.close();
});

test("optimize merges the index in small steps and leaves it consistent", async () => {
  const { db } = openTemp();
  for (let batch = 0; batch < 20; batch++) fill(db, PEER, 100, { prefix: `B${batch}-`, start: T0 + batch * 1_000_000 });
  const { result, turns } = await watchLoop(() => db.optimize());
  assert.ok(result.steps >= 1);
  assert.ok(turns >= result.steps - 1);
  assert.equal(db.search.text({ query: "factur", limit: 5 }).items.length, 5);
  assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });
  db.close();
});

test("finding 2: a clear hides everything under its barrier at once, stays hidden after a stop mid-purge, and resume finishes it", async () => {
  const { db, path, clock } = openTemp({ chunkSize: 10 });
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push(textMessage(PEER, `K${i}`, T0 + i * 1000, `secret ${i}`));
  db.messages.upsertMany(rows);
  db.messages.setMedia(sid(false, PEER, "K5"), "preview", "/tmp/preview-K5.jpg");
  db.vectors.put(sid(false, PEER, "K50"), "m", [1, 0, 0], wordsOf(db, sid(false, PEER, "K50")));
  const clearing = db.messages.clearChat(PEER, T0 + 99_000);
  clearing.catch(() => {});

  const hidden = (store) => {
    assert.equal(store.identity.chat(PEER).lastMessageId, null, "last_* never names a row under the barrier");
    assert.deepEqual(store.messages.chatPage(PEER, { limit: 1000 }).items, []);
    assert.equal(store.messages.get(sid(false, PEER, "K50")), null);
    assert.deepEqual(store.search.text({ query: "secret", limit: 5 }).items, []);
    assert.deepEqual(store.search.text({ query: "se", limit: 5 }).items, []);
    assert.deepEqual(store.messages.listChats({ limit: 5 }).items, []);
    assert.deepEqual(store.messages.recent({ since: T0, limit: 5 }).items, []);
    assert.deepEqual(store.messages.waiting({ since: T0, until: T0 + 200_000, limit: 5 }).items, []);
    assert.deepEqual(store.messages.coverage(PEER), { oldest: null, newest: null });
    assert.equal(store.counts().messages, 0);
    assert.deepEqual(store.messages.countInChat(PEER), { messages: 0, tombstones: 0 });
    assert.deepEqual(store.vectors.vectorSearch({ model: "m", vector: [1, 0, 0], limit: 5 }), []);
    assert.deepEqual(store.vectors.hybrid({ query: "secret", vector: [1, 0, 0], model: "m", limit: 5, minSimilarity: 0.5 }).hits, []);
    assert.deepEqual(store.vectors.backlog({ model: "m", limit: 5 }).items, []);
  };
  hidden(db);
  // The fold of what the fill left takes two turns, then one chunk commits.
  await turn();
  await turn();
  await turn();
  db.close();
  await clearing.catch(() => {});

  const reopened = AccountDb.open(path, { now: () => clock.now, chunkSize: 10, checkpointDelayMs: 0 });
  const left = reopened["connection"].get("SELECT count(*) AS n FROM messages").n;
  assert.ok(left > 0 && left < 100, `the purge was interrupted with ${left} rows physically left`);
  hidden(reopened);
  const resumed = await reopened.resume();
  assert.equal(resumed.purged.count, left);
  assert.equal(reopened["connection"].get("SELECT count(*) AS n FROM messages").n, 0);
  assert.deepEqual(reopened.pendingUnlinks(), ["/tmp/preview-K5.jpg"]);
  reopened.close();
});

test("finding 2: the file of a row purged before a stop stays queued for unlink until acknowledged", async () => {
  const { db, path, clock } = openTemp({ chunkSize: 10 });
  for (let i = 0; i < 100; i++) db.messages.upsert(textMessage(PEER, `K${i}`, T0 + i * 1000, `secret ${i}`));
  db.messages.setMedia(sid(false, PEER, "K0"), "download", "/data/photo-K0.jpg");
  const clearing = db.messages.clearChat(PEER, T0 + 99_000);
  clearing.catch(() => {});
  // The fold of what the fill left takes two turns, then K0's chunk commits.
  await turn();
  await turn();
  await turn();
  db.close();
  await clearing.catch(() => {});

  const reopened = AccountDb.open(path, { now: () => clock.now, checkpointDelayMs: 0 });
  assert.equal(reopened["connection"].get("SELECT count(*) AS n FROM messages WHERE key_id = 'K0'").n, 0, "K0's chunk committed");
  assert.deepEqual(reopened.pendingUnlinks(), ["/data/photo-K0.jpg"]);
  const claimed = reopened.claimUnlinks();
  assert.deepEqual(claimed, ["/data/photo-K0.jpg"]);
  assert.deepEqual(reopened.ackUnlinks(claimed), { acked: ["/data/photo-K0.jpg"], rerecorded: [] });
  assert.deepEqual(reopened.pendingUnlinks(), []);
  reopened.close();
});

test("finding 2: a path still referenced is never queued, and one recorded again leaves the queue", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "A", T0, "a"));
  db.messages.upsert(textMessage(PEER, "B", T0 + 1000, "b"));
  db.messages.setMedia(sid(false, PEER, "A"), "preview", "/shared.jpg");
  db.messages.setMedia(sid(false, PEER, "B"), "preview", "/shared.jpg");
  assert.deepEqual(db.messages.delete(sid(false, PEER, "A")).mediaPaths, []);
  assert.deepEqual(db.pendingUnlinks(), []);
  assert.deepEqual(db.messages.delete(sid(false, PEER, "B")).mediaPaths, ["/shared.jpg"]);
  assert.deepEqual(db.pendingUnlinks(), ["/shared.jpg"]);
  db.messages.upsert(textMessage(PEER, "C", T0 + 2000, "c"));
  db.messages.setMedia(sid(false, PEER, "C"), "preview", "/shared.jpg");
  assert.deepEqual(db.pendingUnlinks(), []);
  db.close();
});

test("finding 2: a delete under a barrier whose purge has not run yet never makes a hidden row the last one", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "A", T0, "a"));
  db.messages.upsert(textMessage(PEER, "B", T0 + 1000, "b"));
  db.messages.upsert(textMessage(PEER, "C", T0 + 2000, "c"));
  const clearing = db.messages.clearChat(PEER, T0 + 1000);
  assert.equal(db.identity.chat(PEER).lastMessageId, db.messages.get(sid(false, PEER, "C")).id);
  db.messages.delete(sid(false, PEER, "C"));
  assert.equal(db.identity.chat(PEER).lastMessageId, null);
  return clearing.then(() => db.close());
});

test("finding 9: a checkpoint never waits for a reader holding a snapshot, and the WAL is truncated once it lets go", async () => {
  const { db, path } = openTemp({ checkpointDelayMs: 20 });
  for (let i = 0; i < 50; i++) db.messages.upsert(textMessage(PEER, `K${i}`, T0 + i * 1000, `text ${i}`));
  const { sqlite } = await import("../dist/db/sqlite.js");
  const reader = new (sqlite().DatabaseSync)(path, { readOnly: true });
  reader.exec("BEGIN");
  reader.prepare("SELECT count(*) AS n FROM messages").get();
  db.messages.upsert(textMessage(PEER, "late", T0 + 60_000, "after the reader's snapshot"));

  let started = performance.now();
  const cleared = await db.messages.clearChat(PEER, T0 + 10_000);
  assert.equal(cleared.count, 11);
  assert.ok(performance.now() - started < 1000, `clear with its checkpoint took ${Math.round(performance.now() - started)} ms`);
  started = performance.now();
  const busy = db.checkpoint();
  assert.ok(performance.now() - started < 200, `an explicit checkpoint took ${Math.round(performance.now() - started)} ms`);
  assert.equal(busy.busy, 1);
  assert.equal(db.settings().busyTimeoutMs, 5000, "the busy timeout is restored");

  reader.exec("COMMIT");
  reader.close();
  const deadline = Date.now() + 3000;
  while (statSync(`${path}-wal`).size !== 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(statSync(`${path}-wal`).size, 0, "the retry truncated the WAL once the reader let go");
  db.close();
});

test("a second lid chat folding into the same number shares the barrier a first fold already carries", async () => {
  const LID_A = "111111111111111@lid";
  const LID_B = "222222222222222@lid";
  const { db, path, clock } = openTemp({ chunkSize: 2 });
  for (let i = 0; i < 6; i++) {
    db.messages.upsert(textMessage(PEER, `P${i}`, T0 + i * 1000, `phone ${i}`));
    db.messages.upsert(textMessage(LID_A, `A${i}`, T0 + i * 1000 + 100, `lid a ${i}`));
    db.messages.upsert(textMessage(LID_B, `B${i}`, T0 + i * 1000 + 200, `lid b ${i}`));
  }
  const first = db.learnLidPhone(LID_B, PEER);
  const clear = db.messages.clearChat(LID_A, T0 + 3500);
  const second = db.learnLidPhone(LID_A, PEER);
  for (const op of [first, clear, second]) op.catch(() => {});
  db.close();
  await Promise.allSettled([first, clear, second]);

  const reopened = AccountDb.open(path, { now: () => clock.now, chunkSize: 2, checkpointDelayMs: 0 });
  const visible = reopened.messages.chatPage(PEER, { limit: 100 }).items;
  assert.deepEqual(visible.filter((m) => m.ts <= T0 + 3500).map((m) => m.keyId), [], "no row under the shared barrier is readable");
  await reopened.resume();
  assert.deepEqual(
    reopened.messages.chatPage(PEER, { limit: 100 }).items.map((m) => m.keyId).sort(),
    ["A4", "A5", "B4", "B5", "P4", "P5"]
  );
  assert.deepEqual(reopened.integrityCheck(), { ok: true, problems: [] });
  reopened.close();
});

test("n3: a row a stored barrier hides answers to no accessor and takes no write before its purge", async () => {
  const { db, path, clock } = openTemp({ chunkSize: 1 });
  const hidden = sid(false, PEER, "K0");
  for (let i = 0; i < 50; i++) db.messages.upsert(textMessage(PEER, `K${i}`, T0 + i * 1000, `secret ${i}`));
  db.messages.setMedia(hidden, "download", "/data/K0.jpg");
  db.messages.react(hidden, "40711111111@s.whatsapp.net", "👍", T0 + 5);
  db.messages.setTranscript(hidden, "voice words");
  db.vectors.put(hidden, "m", [1, 0, 0], wordsOf(db, hidden));
  db.messages.clearChat(PEER, T0 + 60_000).catch(() => {});
  db.close();

  const reopened = AccountDb.open(path, { now: () => clock.now, checkpointDelayMs: 0 });
  assert.equal(reopened.messages.get(hidden), null);
  assert.deepEqual(reopened.messages.media(hidden), []);
  assert.deepEqual(reopened.messages.reactions(hidden), []);
  assert.deepEqual(reopened.messages.receipts(hidden), []);
  assert.equal(reopened.vectors.get(hidden), null);
  assert.deepEqual(reopened.messages.setMedia(hidden, "preview", "/data/K0-p.jpg"), { stored: false, replaced: null });
  assert.equal(reopened.messages.setTranscript(hidden, "new words"), false);
  assert.equal(reopened.messages.setStatus(hidden, 4), false);
  assert.equal(reopened.messages.react(hidden, "40711111112@s.whatsapp.net", "x", T0 + 9), false);
  assert.equal(reopened.messages.receipt(hidden, "40711111112@s.whatsapp.net", { readAt: T0 + 9 }), false);
  assert.equal(reopened.vectors.put(hidden, "m", [0, 1, 0], "any"), false);
  await reopened.resume();
  reopened.close();
});

test("n4: a path recorded again between claim and acknowledgement is reported, not acknowledged, and stale claims return", () => {
  const { db, clock } = openTemp();
  db.messages.upsert(textMessage(PEER, "C", T0, "c"));
  db.messages.upsert(textMessage(PEER, "D", T0 + 1000, "d"));
  const C = sid(false, PEER, "C");
  db.messages.setMedia(C, "preview", "/p/1.jpg");
  db.messages.setMedia(C, "preview", "/p/2.jpg");
  db.messages.setMedia(C, "download", "/d/C.ogg");
  db.messages.delete(C);
  assert.deepEqual(db.pendingUnlinks().sort(), ["/d/C.ogg", "/p/1.jpg", "/p/2.jpg"]);

  const claimed = db.claimUnlinks(2);
  assert.equal(claimed.length, 2);
  assert.deepEqual(db.claimUnlinks(10).length, 1, "claimed paths are not handed out twice");
  const rerecorded = claimed[1];
  db.messages.setMedia(sid(false, PEER, "D"), "preview", rerecorded);
  assert.deepEqual(db.ackUnlinks(claimed), { acked: [claimed[0]], rerecorded: [rerecorded] });
  assert.ok(!db.pendingUnlinks().includes(rerecorded));

  clock.now += 11 * 60_000;
  assert.equal(db.claimUnlinks(10).length, 1, "a claim older than ten minutes is handed out again");
  db.close();
});

test("purgeLive forgets every live message and its files, and keeps every tombstone and retraction", async () => {
  const { db } = openTemp({ chunkSize: 3 });
  for (let i = 0; i < 10; i++) db.messages.upsert(textMessage(PEER, `L${i}`, T0 + i * 1000, `live ${i}`));
  db.messages.upsert(textMessage(PEER, "GONE", T0 + 20_000, "deleted"));
  db.messages.delete(sid(false, PEER, "GONE"));
  db.messages.delete(sid(false, PEER, "UNSEEN"), { ts: T0 + 30_000 });
  db.messages.setMedia(sid(false, PEER, "L3"), "preview", "/tmp/l3.jpg");

  const result = await db.messages.purgeLive();
  assert.equal(result.count, 10);
  assert.deepEqual(result.mediaPaths, ["/tmp/l3.jpg"]);
  assert.deepEqual(db.messages.chatPage(PEER, { limit: 50 }).items, []);
  assert.equal(db.counts().tombstones, 2);
  assert.equal(db.messages.upsert(textMessage(PEER, "L4", T0 + 4000, "live 4")).outcome, "inserted", "no barrier: a sync may bring it back");
  assert.equal(db.messages.upsert(textMessage(PEER, "GONE", T0 + 20_000, "deleted")).outcome, "deleted");
  assert.equal(db.messages.upsert(textMessage(PEER, "UNSEEN", T0 + 30_000, "late")).outcome, "deleted");
  assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });
  db.close();
});
