/**
 * Messages.chatRefs is chatPage without the words: get_recent_messages builds
 * its cursor from it. The same rows, in the same order, on the same pages —
 * across a fold still running, a tombstone, an expired message, a clear
 * barrier and a window start.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { PEER, PEER_LID, T0, openTemp, sid, textMessage } from "./db-fixtures.mjs";

const pick = (message) => ({ id: message.id, keyId: message.keyId, fromMe: message.fromMe, ts: message.ts, type: message.type });

function pages(read, jid, options) {
  const out = [];
  for (let before; ; ) {
    const page = read(jid, { ...options, ...(before === undefined ? {} : { before }) });
    out.push({ items: page.items.map(pick), hasMore: page.hasMore, nextBefore: page.nextBefore });
    if (page.nextBefore === null) return out;
    before = page.nextBefore;
  }
}

test("chatRefs pages the same messages as chatPage, without their words", async () => {
  const { db, clock } = openTemp();
  for (let i = 0; i < 40; i++) {
    db.messages.upsert(
      textMessage(i % 4 === 0 ? PEER_LID : PEER, `K${i}`, T0 + i * 1000, `mesaj ${i}`, {
        fromMe: i % 3 === 0,
        type: i % 7 === 0 ? "image" : "text",
        ...(i === 21 ? { expiresAt: T0 + 3_600_000 + 1 } : {}),
        ...(i === 22 ? { expiresAt: T0 + 1000 } : {}),
      })
    );
  }
  db.messages.delete(sid(false, PEER, "K5"));
  await db.messages.clearChat(PEER, T0 + 2500);
  // The lid chat starts folding into the number's chat; its messages read under the number from now on.
  const fold = db.learnLidPhone(PEER_LID, PEER);
  for (const options of [{ limit: 7 }, { limit: 50 }, { limit: 3, since: T0 + 20_000 }, { limit: 1, since: T0 + 38_000 }]) {
    assert.deepEqual(
      pages((jid, o) => db.messages.chatRefs(jid, o), PEER, options),
      pages((jid, o) => db.messages.chatPage(jid, o), PEER, options),
      JSON.stringify(options)
    );
  }
  await fold;
  clock.now = T0 + 86_400_000;
  assert.deepEqual(
    pages((jid, o) => db.messages.chatRefs(jid, o), PEER, { limit: 9 }),
    pages((jid, o) => db.messages.chatPage(jid, o), PEER, { limit: 9 }),
    "after the fold, and with one more message expired"
  );
  assert.deepEqual(db.messages.chatRefs("40799999999@s.whatsapp.net", { limit: 5 }), { items: [], hasMore: false, nextBefore: null });
});
