/**
 * The message rules the storage layer enforces on its own: chronological ids
 * that never move, keyset pages that lose nothing, and the barriers — a
 * tombstone beats any replay, a newer edit beats a stale one, a cleared chat
 * stays cleared, an expiry only moves earlier — plus the denormalized last
 * message per chat and everything hanging off a message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AccountDb, SEQ_SPAN, StorageError, secondOfId } from "../dist/db/index.js";
import { GROUP, ME, PEER, PEER_LID, T0, openTemp, sid, sids, textMessage, wordsOf } from "./db-fixtures.mjs";

const OTHER = "40700000003@s.whatsapp.net";
const STATUS = "status@broadcast";

test("ids are the second times 2^20 plus a sequence, consecutive inside one second", () => {
  const { db } = openTemp();
  const a = db.messages.upsert(textMessage(PEER, "A", T0, "a"));
  const b = db.messages.upsert(textMessage(PEER, "B", T0 + 300, "b"));
  const c = db.messages.upsert(textMessage(OTHER, "C", T0 + 999, "c"));
  const base = (T0 / 1000) * SEQ_SPAN;
  assert.deepEqual([a.id, b.id, c.id], [base, base + 1, base + 2]);
  for (const id of [a.id, b.id, c.id]) {
    assert.ok(Number.isSafeInteger(id));
    assert.equal(secondOfId(id), T0 / 1000);
  }
  const next = db.messages.upsert(textMessage(PEER, "D", T0 + 1000, "d"));
  assert.equal(next.id, base + SEQ_SPAN);
  db.close();
});

test("finding 6: an id freed by a purge is never handed to another message, and a mark pointing at it goes null", async () => {
  const { db } = openTemp();
  const ask = db.messages.upsert(textMessage(PEER, "ASK", T0 + 500, "can you send the contract?"));
  db.identity.markHandled(PEER, sid(false, PEER, "ASK"));
  const conn = db["connection"];
  conn.write(() =>
    conn.run(
      "INSERT INTO events(kind, lane, message_id, payload, created_at, ready_at, updated_at) VALUES ('message_received', 'chat:1', ?, '{}', 1, 1, 1)",
      ask.id
    )
  );
  await db.messages.clearChat(PEER, T0 + 1000);
  assert.equal(conn.get("SELECT message_id FROM events").message_id, null, "an event whose message is gone points nowhere");
  const other = db.messages.upsert(textMessage(GROUP, "G1", T0 + 700, "group secret", { senderJid: OTHER }));
  assert.notEqual(other.id, ask.id);
  assert.equal(other.id, ask.id + 1);
  const handled = db.identity.handled(PEER);
  assert.deepEqual([handled.askMessageId, handled.askSid], [null, null]);
  db.close();
});

test("a history message arriving late sorts by its own time, not by arrival", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "late", T0 + 10_000, "newest"));
  db.messages.upsert(textMessage(PEER, "old", T0, "oldest"));
  db.messages.upsert(textMessage(PEER, "mid", T0 + 5_000, "middle"));
  assert.deepEqual(
    db.messages.chatPage(PEER, { limit: 10 }).items.map((m) => m.text),
    ["newest", "middle", "oldest"]
  );
  assert.equal(db.identity.chat(PEER).lastMessageId, db.messages.get(sid(false, PEER, "late")).id);
  db.close();
});

test("a message keeps its id through replays, edits, transcripts and status changes", () => {
  const { db } = openTemp();
  const { id } = db.messages.upsert(textMessage(PEER, "A", T0, "v1"));
  db.messages.upsert(textMessage(PEER, "A", T0 + 7_000, "v2", { editedAt: T0 + 60_000 }));
  db.messages.setTranscript(sid(false, PEER, "A"), "ce spune vocea");
  db.messages.setStatus(sid(false, PEER, "A"), 3);
  const stored = db.messages.get(sid(false, PEER, "A"));
  assert.equal(stored.id, id);
  assert.equal(stored.ts, T0, "the protocol timestamp is the first one seen");
  assert.equal(stored.text, "v2");
  assert.equal(stored.transcript, "ce spune vocea");
  db.close();
});

test("keyset pages over one second lose and repeat nothing while rows are edited and transcribed between pages", () => {
  const { db } = openTemp();
  const original = [];
  for (let i = 0; i < 150; i++) {
    const key = `K${String(i).padStart(3, "0")}`;
    db.messages.upsert(textMessage(PEER, key, T0, `mesaj ${i}`));
    original.push(sid(false, PEER, key));
  }
  const seen = [];
  let before;
  let page = 0;
  for (;;) {
    const result = db.messages.chatPage(PEER, { limit: 40, ...(before === undefined ? {} : { before }) });
    seen.push(...sids(result.items));
    // Between pages: edit, transcribe and re-deliver rows on both sides of the cursor.
    const target = original[(page * 37) % original.length];
    db.messages.upsert(textMessage(PEER, target.split("_").pop(), T0, `edit ${page}`, { editedAt: T0 + 1000 * (page + 1) }));
    db.messages.setTranscript(original[(page * 53 + 11) % original.length], `transcriere ${page}`);
    db.messages.upsert(textMessage(PEER, original[(page * 29 + 3) % original.length].split("_").pop(), T0, "replay"));
    page++;
    if (!result.hasMore) break;
    before = result.nextBefore;
  }
  assert.equal(seen.length, 150);
  assert.equal(new Set(seen).size, 150);
  assert.deepEqual([...seen].sort(), [...original].sort());
  db.close();
});

test("a tombstone beats every replay: upsert, transcript, reaction, receipt, media and embedding", () => {
  const { db } = openTemp();
  const message = textMessage(PEER, "A", T0, "secret");
  const { id } = db.messages.upsert({ ...message, transcript: "vocea secretă" });
  const deleted = db.messages.delete(message.sid, { at: T0 + 60_000 });
  assert.deepEqual(deleted, { outcome: "deleted", id, mediaPaths: [] });

  assert.deepEqual(db.messages.upsert(message), { outcome: "deleted", id, sid: message.sid });
  assert.deepEqual(db.messages.upsert({ ...message, editedAt: T0 + 120_000, text: "edited" }).outcome, "deleted");
  assert.equal(db.messages.setTranscript(message.sid, "again"), false);
  assert.equal(db.messages.react(message.sid, OTHER, "👍", T0 + 1), false);
  assert.equal(db.messages.receipt(message.sid, OTHER, { readAt: T0 + 1 }), false);
  assert.equal(db.messages.setMedia(message.sid, "preview", "/tmp/x.jpg").stored, false);
  assert.equal(db.vectors.put(message.sid, "embeddinggemma-300m", new Array(8).fill(1), wordsOf(db, message.sid)), false);
  assert.deepEqual(db.messages.delete(message.sid), { outcome: "already", id, mediaPaths: [] });

  assert.equal(db.messages.get(message.sid), null);
  const hidden = db.messages.get(message.sid, { includeHidden: true });
  assert.equal(hidden.deletedAt, T0 + 60_000);
  assert.equal(hidden.text, null);
  assert.equal(hidden.transcript, null);
  assert.equal(hidden.raw, null);
  db.close();
});

test("a retraction for a message not seen yet stores a tombstone at the protocol time, never at zero", () => {
  const { db } = openTemp();
  const target = sid(false, PEER, "unseen");
  assert.throws(
    () => db.messages.delete(target),
    (err) => err instanceof StorageError && err.code === "INVALID_INPUT"
  );
  const placeholder = db.messages.delete(target, { ts: T0 + 5_000, at: T0 + 5_000 });
  assert.equal(placeholder.outcome, "placeholder");
  const row = db.messages.get(target, { includeHidden: true });
  assert.equal(row.ts, T0 + 5_000);
  assert.equal(row.deletedAt, T0 + 5_000);
  assert.equal(secondOfId(row.id), (T0 + 5_000) / 1000);

  assert.equal(db.messages.upsert(textMessage(PEER, "unseen", T0, "too late")).outcome, "deleted");
  assert.equal(db.messages.get(target), null);
  assert.equal(db.search.text({ query: "too late", limit: 5 }).items.length, 0);
  assert.equal(db.identity.chat(PEER).lastMessageId, null, "a tombstone is never a chat's last message");
  db.close();
});

test("a newer stored edit beats a stale replay, while status and expiry still merge", () => {
  const { db } = openTemp();
  const key = "E";
  db.messages.upsert(textMessage(PEER, key, T0, "v1"));
  assert.equal(db.messages.upsert(textMessage(PEER, key, T0, "v2", { editedAt: T0 + 60_000 })).outcome, "updated");
  const replay = db.messages.upsert(textMessage(PEER, key, T0, "v1", { status: 3, expiresAt: T0 + 86_400_000 }));
  assert.equal(replay.outcome, "stale");
  assert.equal(db.messages.upsert(textMessage(PEER, key, T0, "v1.5", { editedAt: T0 + 30_000 })).outcome, "stale");
  let stored = db.messages.get(sid(false, PEER, key));
  assert.equal(stored.text, "v2");
  assert.equal(stored.editedAt, T0 + 60_000);
  assert.equal(stored.status, 3);
  assert.equal(stored.expiresAt, T0 + 86_400_000);
  assert.equal(db.search.text({ query: "v1", limit: 5, scanCap: 100 }).items.length, 0);

  assert.equal(db.messages.upsert(textMessage(PEER, key, T0, "v3", { editedAt: T0 + 90_000, status: 2 })).outcome, "updated");
  stored = db.messages.get(sid(false, PEER, key));
  assert.equal(stored.text, "v3");
  assert.equal(stored.status, 3, "status never falls");
  db.close();
});

test("a cleared chat refuses everything at or before the barrier, inclusive, and takes newer messages", async () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "A", T0, "a"));
  db.messages.upsert(textMessage(PEER, "B", T0 + 1000, "b"));
  db.messages.upsert(textMessage(PEER, "C", T0 + 2000, "c"));
  const cleared = await db.messages.clearChat(PEER, T0 + 1000);
  assert.equal(cleared.count, 2);
  assert.deepEqual(cleared.sids.sort(), [sid(false, PEER, "A"), sid(false, PEER, "B")]);

  assert.equal(db.messages.upsert(textMessage(PEER, "B", T0 + 1000, "b replay")).outcome, "cleared");
  assert.equal(db.messages.upsert(textMessage(PEER, "old", T0 + 500, "older")).outcome, "cleared");
  assert.equal(db.messages.delete(sid(false, PEER, "gone"), { ts: T0 }).outcome, "cleared");
  assert.equal(db.messages.upsert(textMessage(PEER, "new", T0 + 1001, "newer")).outcome, "inserted");
  assert.deepEqual(
    db.messages.chatPage(PEER, { limit: 10 }).items.map((m) => m.text),
    ["c", "newer"]
  );
  const second = await db.messages.clearChat(PEER, T0 + 500);
  assert.equal(second.count, 0);
  assert.equal(db.identity.chat(PEER).clearedThroughTs, T0 + 1000, "a barrier never moves back");
  db.close();
});

test("an expiry only moves earlier, and a message past it disappears from every read before the sweep", async () => {
  const { db, clock } = openTemp();
  const a = textMessage(PEER, "A", T0, "rămâne");
  const b = textMessage(PEER, "B", T0 + 1000, "dispare curând", { expiresAt: T0 + 7_200_000 });
  db.messages.upsert(a);
  db.messages.upsert(b);
  assert.equal(db.messages.setExpiry(b.sid, T0 + 9_000_000), false);
  db.messages.upsert({ ...b, expiresAt: T0 + 99_000_000 });
  assert.equal(db.messages.get(b.sid).expiresAt, T0 + 7_200_000);
  assert.equal(db.messages.setExpiry(b.sid, T0 + 5_400_000), true);
  assert.equal(db.messages.nextExpiry(), T0 + 5_400_000);

  clock.now = T0 + 5_400_000;
  assert.equal(db.messages.get(b.sid), null);
  assert.deepEqual(db.messages.chatPage(PEER, { limit: 10 }).items.map((m) => m.sid), [a.sid]);
  assert.equal(db.search.text({ query: "dispare", limit: 5 }).items.length, 0);
  assert.equal(db.search.text({ query: "di", limit: 5 }).items.length, 0);
  assert.equal(db.messages.recent({ since: T0, limit: 10 }).items.length, 1);
  assert.equal(db.messages.listChats({ limit: 5 }).items[0].last.sid, a.sid);
  assert.equal(db.messages.upsert(b).outcome, "expired");

  const swept = await db.messages.expireDue();
  assert.deepEqual(swept.sids, [b.sid]);
  assert.equal(db.messages.nextExpiry(), null);
  assert.equal(db.identity.chat(PEER).lastMessageId, db.messages.get(a.sid).id);
  const { expiresAt: _dropped, ...withoutMarker } = b;
  assert.equal(db.messages.upsert(withoutMarker).outcome, "deleted", "a replay without the ephemeral marker stays gone");
  db.close();
});

test("a message that arrives already expired is stored as a barrier, not as content", () => {
  const { db, clock } = openTemp();
  const late = textMessage(PEER, "L", T0, "expired on arrival", { expiresAt: clock.now - 1 });
  assert.equal(db.messages.upsert(late).outcome, "expired");
  const row = db.messages.get(late.sid, { includeHidden: true });
  assert.notEqual(row.deletedAt, null);
  assert.equal(row.text, null);
  const { expiresAt: _dropped, ...replay } = late;
  assert.equal(db.messages.upsert(replay).outcome, "deleted");
  db.close();
});

test("last_* follows inserts, tombstones, deletes, clears and expiry, and drives the waiting list", async () => {
  const { db, clock } = openTemp();
  const last = () => {
    const chat = db.identity.chat(PEER);
    return chat.lastMessageId === null ? null : [db.messages.byIds([chat.lastMessageId])[0].keyId, chat.lastFromMe];
  };
  db.messages.upsert(textMessage(PEER, "A", T0, "a"));
  db.messages.upsert(textMessage(PEER, "B", T0 + 1000, "b", { fromMe: true }));
  db.messages.upsert(textMessage(PEER, "C", T0 + 2000, "c?"));
  assert.deepEqual(last(), ["C", false]);
  assert.deepEqual(db.messages.waiting({ since: T0, until: T0 + 10_000, limit: 5 }).items.map((w) => w.last.keyId), ["C"]);

  db.messages.upsert(textMessage(PEER, "old", T0 - 60_000, "history"));
  assert.deepEqual(last(), ["C", false], "an older history message never becomes the last one");

  db.messages.delete(sid(false, PEER, "C"));
  assert.deepEqual(last(), ["B", true]);
  assert.deepEqual(db.messages.waiting({ since: T0, until: T0 + 10_000, limit: 5 }).items, []);

  db.messages.upsert(textMessage(PEER, "D", T0 + 3000, "d", { expiresAt: T0 + 4_000_000 }));
  assert.deepEqual(last(), ["D", false]);
  clock.now = T0 + 4_000_000;
  assert.equal(db.messages.listChats({ limit: 5 }).items[0].last.keyId, "B", "an expired last message is skipped before the sweep");
  await db.messages.expireDue();
  assert.deepEqual(last(), ["B", true]);

  await db.messages.clearChat(PEER, T0 + 3000);
  assert.equal(last(), null);
  assert.deepEqual(db.messages.listChats({ limit: 5 }).items, []);
  db.messages.upsert(textMessage(PEER, "E", T0 + 5000, "e"));
  assert.deepEqual(last(), ["E", false]);
  db.close();
});

test("waiting candidates: their last word inside the window, oldest first, archived and handled left out unless asked", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "P1", T0 + 2000, "ai timp?"));
  db.messages.upsert(textMessage(OTHER, "O1", T0 + 1000, "factura?"));
  db.messages.upsert(textMessage(GROUP, "G1", T0 + 3000, "cine vine?", { senderJid: OTHER }));
  db.messages.upsert(textMessage(ME, "M1", T0 + 4000, "notă", { fromMe: true }));
  db.identity.upsertChat({ jid: GROUP, archived: true });
  db.identity.markHandled(OTHER, sid(false, OTHER, "O1"), T0 + 1500);
  const jids = (options) => db.messages.waiting({ since: T0, until: T0 + 10_000, limit: 10, ...options }).items.map((w) => w.chat.jid);
  assert.deepEqual(jids({}), [PEER]);
  const all = db.messages.waiting({ since: T0, until: T0 + 10_000, limit: 10, includeHandled: true }).items;
  assert.deepEqual(all.map((w) => w.chat.jid), [OTHER, PEER]);
  assert.equal(all[0].handled.askSid, sid(false, OTHER, "O1"));
  assert.equal(all[1].handled, null);
  assert.deepEqual(jids({ includeArchived: true, includeHandled: true }), [OTHER, PEER, GROUP]);
  assert.deepEqual(db.messages.waiting({ since: T0 + 1500, until: T0 + 10_000, limit: 10 }).items.map((w) => w.chat.jid), [PEER]);
  db.close();
});

test("finding 11: waiting narrows kinds, archived and handled chats in SQL before the limit, and pages with a cursor", () => {
  const { db, clock } = openTemp();
  for (let i = 0; i < 5; i++) {
    db.messages.upsert(textMessage(`1203630000000000${10 + i}@g.us`, `G${i}`, T0 + i * 1000, "group chatter", { senderJid: "40711111111@s.whatsapp.net" }));
  }
  db.messages.upsert(textMessage(STATUS, "S", T0 + 6000, "story", { senderJid: "40722222222@s.whatsapp.net", expiresAt: clock.now + 86_400_000 }));
  db.messages.upsert(textMessage(PEER, "ASK", T0 + 7000, "poti sa-mi trimiti contractul?"));
  const window = { since: T0 - 1, until: T0 + 3_600_000 };

  assert.deepEqual(db.messages.waiting({ ...window, limit: 5, kinds: ["direct"] }).items.map((w) => w.last.keyId), ["ASK"]);
  const first = db.messages.waiting({ ...window, limit: 5 });
  assert.deepEqual(first.items.map((w) => w.last.keyId), ["G0", "G1", "G2", "G3", "G4"]);
  assert.notEqual(first.next, null);
  const second = db.messages.waiting({ ...window, limit: 5, after: first.next });
  assert.deepEqual(second.items.map((w) => w.last.keyId), ["ASK"]);
  assert.equal(second.next, null);
  assert.deepEqual(db.messages.waiting({ ...window, limit: 10, kinds: ["status"] }).items.map((w) => w.last.keyId), ["S"]);

  db.identity.markHandled(PEER, sid(false, PEER, "ASK"));
  assert.deepEqual(db.messages.waiting({ ...window, limit: 10, kinds: ["direct"] }).items, []);
  db.messages.upsert(textMessage(PEER, "AGAIN", T0 + 8000, "si inca ceva?"));
  assert.deepEqual(db.messages.waiting({ ...window, limit: 10, kinds: ["direct"] }).items.map((w) => w.last.keyId), ["AGAIN"]);
  db.close();
});

test("reactions, votes and receipts are kept for every message, survive reopen, and the newest event wins", () => {
  const { db, path } = openTemp();
  for (let i = 0; i < 300; i++) db.messages.upsert(textMessage(PEER, `M${i}`, T0 + i * 1000, `m${i}`));
  const oldest = sid(false, PEER, "M0");
  assert.equal(db.messages.react(oldest, OTHER, "👍", T0 + 10_000), true);
  assert.equal(db.messages.react(oldest, OTHER, "❤️", T0 + 5_000), true);
  assert.equal(db.messages.react(oldest, ME, "😂", T0 + 6_000), true);
  assert.equal(db.messages.react(oldest, ME, "", T0 + 5_500), true, "a removal older than the reaction is ignored");
  db.messages.vote(oldest, OTHER, JSON.stringify(["da"]), T0 + 7_000);
  db.messages.vote(oldest, OTHER, JSON.stringify(["nu"]), T0 + 8_000);
  db.messages.receipt(oldest, OTHER, { deliveredAt: T0 + 2_000 });
  db.messages.receipt(oldest, OTHER, { deliveredAt: T0 + 3_000, readAt: T0 + 4_000 });
  db.close();

  const reopened = AccountDb.open(path);
  assert.deepEqual(
    reopened.messages.reactions(oldest).map((r) => [r.jid, r.emoji]),
    [[ME, "😂"], [OTHER, "👍"]]
  );
  assert.deepEqual(reopened.messages.votes(oldest).map((v) => [v.jid, v.choice]), [[OTHER, '["nu"]']]);
  assert.deepEqual(
    reopened.messages.receipts(oldest).map((r) => [r.jid, r.deliveredAt, r.readAt, r.playedAt]),
    [[OTHER, T0 + 3_000, T0 + 4_000, null]],
    "each time keeps the latest one seen"
  );
  reopened.messages.react(oldest, ME, "", T0 + 9_000);
  assert.deepEqual(reopened.messages.reactions(oldest).map((r) => r.jid), [OTHER]);
  reopened.close();
});

test("reaction withdrawals survive reopen and reject older replays in single and batched reads", async () => {
  const { db, path } = openTemp();
  const message = textMessage(PEER, "WITHDRAWN", T0, "hello");
  db.messages.upsert(message);
  db.messages.react(message.sid, OTHER, "👍", T0 + 1000);
  db.messages.react(message.sid, OTHER, null, T0 + 3000);
  db.messages.react(message.sid, ME, "", T0 + 3000);
  db.close();
  const reopened = AccountDb.open(path);
  try {
    reopened.messages.react(message.sid, OTHER, "👍", T0 + 2000);
    reopened.messages.react(message.sid, ME, "❤️", T0 + 2000);
    assert.deepEqual(reopened.messages.reactions(message.sid), []);
    const id = reopened.messages.get(message.sid).id;
    assert.equal(reopened.messages.marksOf([id]).reactions.size, 0);
    await reopened.learnLidPhone(PEER_LID, OTHER);
    reopened.messages.react(message.sid, PEER_LID, "❤️", T0 + 2000);
    assert.deepEqual(reopened.messages.reactions(message.sid), []);
    reopened.messages.react(message.sid, OTHER, "❤️", T0 + 4000);
    assert.equal(reopened.messages.reactions(message.sid)[0].emoji, "❤️");
    assert.equal(reopened.messages.react("false_4072@s.whatsapp.net_MISSING", OTHER, null, T0), false);
    assert.throws(() => reopened.messages.react(message.sid, OTHER, "👍", NaN));
    reopened.messages.delete(message.sid);
    assert.equal(reopened.messages.react(message.sid, OTHER, "👍", T0 + 5000), false);
    assert.deepEqual(reopened.integrityCheck(), { ok: true, problems: [] });
  } finally {
    reopened.close();
  }
});

test("derived files: a replaced path is handed back, and a tombstone hands back every path it held", () => {
  const { db } = openTemp();
  const message = textMessage(PEER, "IMG", T0, "[image] poza");
  db.messages.upsert({ ...message, type: "image" });
  assert.deepEqual(db.messages.setMedia(message.sid, "preview", "/p/a.jpg"), { stored: true, replaced: null });
  assert.deepEqual(db.messages.setMedia(message.sid, "preview", "/p/b.jpg"), { stored: true, replaced: "/p/a.jpg" });
  db.messages.setMedia(message.sid, "download", "/d/a.jpg");
  assert.deepEqual(db.messages.media(message.sid).map((m) => m.kind), ["download", "preview"]);
  const deleted = db.messages.delete(message.sid);
  assert.deepEqual(deleted.mediaPaths.sort(), ["/d/a.jpg", "/p/b.jpg"]);
  assert.deepEqual(db.messages.media(message.sid), []);
  db.close();
});

test("a retraction scrubs its quotes and transcript, and a later quote of it arrives scrubbed", () => {
  const scrubbed = new Uint8Array([0xde, 0xad]);
  const calls = [];
  const { db } = openTemp({
    scrubQuote: (raw, quotedSid) => {
      calls.push(quotedSid);
      return scrubbed;
    },
  });
  const original = textMessage(PEER, "Q0", T0, "textul citat", { transcript: "vocea" });
  db.messages.upsert(original);
  const reply = textMessage(PEER, "Q1", T0 + 1000, "răspuns", { quotedSid: original.sid });
  db.messages.upsert(reply);
  db.messages.upsert(textMessage(PEER, "Q2", T0 + 2000, "fără citat"));

  db.messages.delete(original.sid);
  assert.deepEqual(db.messages.get(reply.sid).raw, scrubbed);
  assert.notDeepEqual(db.messages.get(sid(false, PEER, "Q2")).raw, scrubbed);
  assert.equal(db.messages.get(original.sid, { includeHidden: true }).transcript, null);

  const later = textMessage(PEER, "Q3", T0 + 3000, "alt răspuns", { quotedSid: original.sid });
  db.messages.upsert(later);
  assert.deepEqual(db.messages.get(later.sid).raw, scrubbed);
  assert.deepEqual(calls, [original.sid, original.sid]);
  db.close();
});

test("finding 4: a retraction scrubs a quote that spelled the quoted message with the other address", async () => {
  const scrubbed = new Uint8Array(Buffer.from("SCRUBBED"));
  const { db } = openTemp({ scrubQuote: () => scrubbed });
  await db.learnLidPhone(PEER_LID, PEER);
  db.messages.upsert(textMessage(PEER, "Q", T0, "secret original"));
  db.messages.upsert(
    textMessage(PEER, "M", T0 + 5000, "reply", {
      quotedSid: sid(false, PEER_LID, "Q"),
      raw: new Uint8Array(Buffer.from("REPLY+EMBEDDED:secret original")),
    })
  );
  db.messages.delete(sid(false, PEER, "Q"));
  assert.deepEqual(db.messages.get(sid(false, PEER, "M")).raw, scrubbed);
  db.close();
});

test("finding 4: a quote of a retracted message stays scrubbed after a clear purged the tombstone", async () => {
  const scrubbed = new Uint8Array(Buffer.from("SCRUBBED"));
  const { db } = openTemp({ scrubQuote: () => scrubbed });
  const quoting = () =>
    textMessage(PEER, "M", T0 + 5000, "reply", {
      quotedSid: sid(false, PEER, "Q"),
      raw: new Uint8Array(Buffer.from("REPLY+EMBEDDED:secret original")),
    });
  db.messages.upsert(textMessage(PEER, "Q", T0, "secret original"));
  db.messages.upsert(quoting());
  db.messages.delete(sid(false, PEER, "Q"));
  assert.deepEqual(db.messages.get(sid(false, PEER, "M")).raw, scrubbed);
  await db.messages.clearChat(PEER, T0 + 1000);
  assert.equal(db.messages.get(sid(false, PEER, "Q"), { includeHidden: true }), null, "the tombstone itself was purged");
  db.messages.upsert(quoting());
  assert.deepEqual(db.messages.get(sid(false, PEER, "M")).raw, scrubbed, "a replay of the quote arrives scrubbed");
  db.close();
});

test("senders: an incoming direct message is the contact's, a group message its author's, a sent one nobody's", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "D", T0, "direct"));
  db.messages.upsert(textMessage(GROUP, "G", T0, "grup", { senderJid: OTHER }));
  db.messages.upsert(textMessage(PEER, "S", T0, "trimis", { fromMe: true }));
  assert.equal(db.messages.get(sid(false, PEER, "D")).senderJid, PEER);
  assert.equal(db.messages.get(sid(false, GROUP, "G")).senderJid, OTHER);
  assert.equal(db.messages.get(sid(true, PEER, "S")).senderJid, null);
  assert.equal(db.identity.chat(GROUP).kind, "group");
  assert.equal(db.identity.chat(PEER).contactId, db.identity.contact(PEER).id);
  db.close();
});

test("recent messages across chats page newest first from a time, and can leave out statuses", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "old", T0 - 86_400_000, "ieri"));
  for (let i = 0; i < 5; i++) {
    db.messages.upsert(textMessage(i % 2 === 0 ? PEER : OTHER, `R${i}`, T0 + i * 1000, `r${i}`));
  }
  db.messages.upsert(textMessage(STATUS, "ST", T0 + 2500, "status", { senderJid: OTHER, expiresAt: T0 + 86_400_000 }));
  const first = db.messages.recent({ since: T0, limit: 3 });
  assert.deepEqual(first.items.map((m) => m.keyId), ["R4", "R3", "ST"]);
  assert.equal(first.hasMore, true);
  const second = db.messages.recent({ since: T0, limit: 3, before: first.nextBefore });
  assert.deepEqual(second.items.map((m) => m.keyId), ["R2", "R1", "R0"]);
  assert.equal(second.hasMore, false);
  assert.deepEqual(
    db.messages.recent({ since: T0, limit: 10, excludeKinds: ["status"] }).items.map((m) => m.keyId),
    ["R4", "R3", "R2", "R1", "R0"]
  );
  assert.deepEqual(db.messages.recent({ since: T0 + 1000, until: T0 + 2000, limit: 10 }).items.map((m) => m.keyId), ["R2", "R1"]);
  db.close();
});

test("coverage and counts reflect visible messages; tombstones are counted apart", () => {
  const { db } = openTemp();
  for (let i = 0; i < 4; i++) db.messages.upsert(textMessage(PEER, `C${i}`, T0 + i * 1000, `c${i}`));
  db.messages.upsert(textMessage(OTHER, "X", T0 + 10_000, "x"));
  db.messages.delete(sid(false, PEER, "C0"));
  const chat = db.messages.coverage(PEER);
  assert.deepEqual([chat.oldest.sid, chat.newest.sid], [sid(false, PEER, "C1"), sid(false, PEER, "C3")]);
  const all = db.messages.coverage();
  assert.deepEqual([all.oldest.sid, all.newest.sid], [sid(false, PEER, "C1"), sid(false, OTHER, "X")]);
  assert.deepEqual(db.messages.coverage("40799999999@s.whatsapp.net"), { oldest: null, newest: null });
  assert.deepEqual(db.counts(), { messages: 4, tombstones: 1, chats: 2, contacts: 2, embeddings: 0 });
  assert.deepEqual(db.messages.countInChat(PEER), { messages: 3, tombstones: 1 });
  db.close();
});

test("timestamps the store cannot file faithfully are refused", () => {
  const { db } = openTemp();
  for (const ts of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
    assert.throws(
      () => db.messages.upsert(textMessage(PEER, "bad", ts, "x")),
      (err) => err instanceof StorageError && err.code === "INVALID_INPUT",
      `ts ${ts}`
    );
  }
  assert.throws(
    () => db.messages.upsert(textMessage(PEER, "bad", T0, "x", { expiresAt: -5 })),
    (err) => err instanceof StorageError && err.code === "INVALID_INPUT"
  );
  assert.equal(db.counts().messages, 0);
  db.close();
});

test("a handled mark reopens only when the other side writes after its ask, not for the user's own or a system notice", () => {
  const { db, clock } = openTemp();
  const window = { since: T0, until: T0 + 3_600_000, limit: 10, kinds: ["direct"] };
  const waiting = () => db.messages.waiting(window).items.map((w) => w.last.keyId);
  db.messages.upsert(textMessage(PEER, "ASK", T0 + 1000, "poți să mă suni?"));
  db.identity.markHandled(PEER, sid(false, PEER, "ASK"));
  assert.deepEqual(waiting(), []);

  // A security-code notice is the chat's newest row and is theirs, but nobody wrote.
  db.messages.upsert(textMessage(PEER, "SYS", T0 + 2000, "[security code changed]", { type: "system" }));
  assert.deepEqual(waiting(), [], "a system notice does not reopen");
  assert.deepEqual(db.messages.waiting({ ...window, includeHandled: true }).items.map((w) => w.last.keyId), ["SYS"]);

  db.messages.upsert(textMessage(PEER, "THEIRS", T0 + 3000, "mersi"));
  assert.deepEqual(waiting(), ["THEIRS"], "a message from them after the ask reopens");

  // A mark naming no message covers what came before it, and reopens on theirs after it.
  db.messages.upsert(textMessage(OTHER, "O1", T0 + 4000, "salut"));
  db.identity.markHandled(OTHER, null, T0 + 4500);
  assert.deepEqual(waiting(), ["THEIRS"]);
  db.messages.upsert(textMessage(OTHER, "O2", T0 + 6000, "ești acolo?"));
  assert.deepEqual(waiting(), ["THEIRS", "O2"]);

  // A later message that expired before anyone read it does not count.
  db.messages.upsert(textMessage(ME, "M-ASK", T0 + 7000, "ce faci?"));
  db.identity.markHandled(ME, sid(false, ME, "M-ASK"));
  db.messages.upsert(textMessage(ME, "M-GONE", T0 + 8000, "dispare", { expiresAt: clock.now + 1000 }));
  clock.now += 2000;
  assert.deepEqual(waiting(), ["THEIRS", "O2"]);
  db.close();
});

test("the lookups the service wires on: lid pairings in order, people with their notes, every chat, the last inbound, search coverage", async () => {
  const { db } = openTemp();
  await db.learnLidPhone(PEER_LID, PEER);
  await db.learnLidPhone("99999999999999@lid", OTHER);
  assert.deepEqual(db.identity.lidPairs(), [
    [PEER_LID, PEER],
    ["99999999999999@lid", OTHER],
  ]);

  db.identity.upsertContact({ jid: PEER, name: "Ana" });
  db.identity.setNote(OTHER, "contabil");
  const people = db.identity.listContacts();
  assert.deepEqual(
    people.map((p) => [p.contact.phoneJid, p.contact.name, p.notes?.note ?? null]),
    [
      [PEER, "Ana", null],
      [OTHER, null, "contabil"],
    ]
  );

  db.identity.upsertChat({ jid: GROUP, name: "Echipa" });
  db.messages.upsert(textMessage(PEER, "P1", T0 + 1000, "factura de azi"));
  db.messages.upsert(textMessage(PEER, "P2", T0 + 2000, "am trimis factura", { fromMe: true }));
  db.messages.upsert(textMessage(STATUS, "S1", T0 + 3000, "factura în story", { senderJid: OTHER, expiresAt: T0 + 86_400_000 }));
  assert.deepEqual(
    db.identity.listChats().map((c) => [c.jid, c.lastTs]),
    [
      [GROUP, null],
      [PEER, T0 + 2000],
      [STATUS, T0 + 3000],
    ],
    "chats without a message are listed too"
  );
  assert.equal(db.messages.lastInboundTs(), T0 + 3000, "a story is a sign of life too");
  db.messages.delete(sid(false, STATUS, "S1"));
  assert.equal(db.messages.lastInboundTs(), T0 + 1000);

  assert.deepEqual(db.search.coverage({}), { messages: 2, chats: 1, oldestTs: T0 + 1000, newestTs: T0 + 2000 });
  db.messages.upsert(textMessage(OTHER, "O1", T0 + 5000, "altceva"));
  assert.deepEqual(db.search.coverage({ excludeKinds: ["status"], since: T0 + 1500 }), {
    messages: 2,
    chats: 2,
    oldestTs: T0 + 2000,
    newestTs: T0 + 5000,
  });
  assert.deepEqual(db.search.coverage({ chat: "40799999999@s.whatsapp.net" }), { messages: 0, chats: 0, oldestTs: null, newestTs: null });
  db.close();
});

test("a delivery status climbs past an error: ERROR outranks PENDING and nothing the server confirmed", () => {
  const { db } = openTemp();
  const statusOf = (key) => db.messages.get(sid(true, PEER, key)).status;
  db.messages.upsert(textMessage(PEER, "E1", T0, "unu", { fromMe: true }));
  assert.equal(db.messages.setStatus(sid(true, PEER, "E1"), 0), true, "an error on a message with no status stands");
  assert.equal(statusOf("E1"), 0);
  db.messages.setStatus(sid(true, PEER, "E1"), 2);
  assert.equal(statusOf("E1"), 2, "a later confirmation replaces it");

  db.messages.upsert(textMessage(PEER, "E2", T0 + 1000, "doi", { fromMe: true, status: 1 }));
  db.messages.setStatus(sid(true, PEER, "E2"), 0);
  assert.equal(statusOf("E2"), 0, "a failure is the answer to a pending send");
  db.messages.upsert(textMessage(PEER, "E2", T0 + 1000, "doi", { fromMe: true, status: 1 }));
  assert.equal(statusOf("E2"), 0, "a replay of the pending send does not undo it");

  db.messages.upsert(textMessage(PEER, "E3", T0 + 2000, "trei", { fromMe: true, status: 3 }));
  db.messages.setStatus(sid(true, PEER, "E3"), 0);
  assert.equal(statusOf("E3"), 3, "an error after a confirmation is ignored");
  db.close();
});
