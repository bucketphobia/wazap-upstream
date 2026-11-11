/**
 * catch_up reads every active chat's aggregate, every group's top senders and
 * its most reacted message in one statement each (Digest.inboundMany,
 * topSendersMany, mostReactedMany). Each must answer, chat for chat, exactly
 * what the one-chat read answers: same floor, same span, same exclusions.
 * And the row counts written into statement text stay row counts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { sqlLimit } from "../dist/db/connection.js";
import { GROUP, PEER, T0, openTemp, sid, textMessage } from "./db-fixtures.mjs";

const GROUP2 = "120363000000000002@g.us";
const EMPTY = "120363000000000003@g.us";
const PEER2 = "40700000003@s.whatsapp.net";
const people = Array.from({ length: 6 }, (_, i) => `4070000010${i}@s.whatsapp.net`);

/** Two groups and two people's chats: senders unevenly busy, mentions, replies, media, polls, a voice note, calls, own messages, reactions. */
function seeded() {
  const fx = openTemp();
  const { db } = fx;
  let n = 0;
  const at = (i) => T0 + i * 1000;
  for (let i = 0; i < 60; i++) {
    const chat = [GROUP, GROUP2, PEER, PEER2][i % 4];
    const group = chat.endsWith("@g.us");
    const sender = group ? people[(i * 7) % (i % 3 === 0 ? 2 : 6)] : undefined;
    const fromMe = i % 9 === 0;
    const type = i % 13 === 0 ? "image" : i % 17 === 0 ? "voice" : i % 19 === 0 ? "poll" : i % 23 === 0 ? "call" : "text";
    db.messages.upsert(
      textMessage(chat, `K${n++}`, at(i), `mesaj numarul ${i} despre ceva`, {
        fromMe,
        type,
        ...(group && !fromMe ? { senderJid: sender } : {}),
        ...(i % 5 === 0 && !fromMe ? { flags: 1 } : {}),
        ...(i % 7 === 0 ? { quotedSid: sid(true, chat, "K0") } : {}),
      })
    );
  }
  // Reactions: two messages in GROUP and one in GROUP2 reacted to by several people.
  for (const [chat, key, who] of [
    [GROUP, "K4", people.slice(0, 3)],
    [GROUP, "K8", people.slice(0, 2)],
    [GROUP2, "K5", people.slice(1, 4)],
    [GROUP2, "K9", people.slice(0, 1)],
  ]) {
    for (const reactor of who) db.messages.react(sid(false, chat, key), reactor, "👍", T0 + 100_000);
  }
  return fx;
}

function spanOf(db, extra = {}) {
  return { afterId: 0, untilId: db.digest.maxId(), afterSeq: -1, untilSeq: db.digest.storedTop(), ...extra };
}

test("a batch of chats reads what each chat's own read reads", () => {
  const { db } = seeded();
  const ids = [GROUP, GROUP2, PEER, PEER2].map((jid) => db.identity.chat(jid).id);
  ids.push(db.identity.ensureChat(EMPTY).id);
  const contactOf = (jid) => db.identity.contactIdOf(jid);
  const spans = [
    spanOf(db),
    spanOf(db, { excludeSenders: new Set([contactOf(people[0])]) }),
    spanOf(db, { untilId: db.messages.chatPage(GROUP, { limit: 30 }).items.at(-20)?.id ?? 0 }),
    spanOf(db, { afterSeq: Math.floor(db.digest.storedTop() / 2) }),
  ];
  const floorSets = [
    ids.map((chatId) => ({ chatId, afterId: 0 })),
    ids.map((chatId, i) => ({ chatId, afterId: i % 2 === 0 ? 0 : (T0 + 30_000) / 1000 * 1048576 })),
    ids.map((chatId) => ({ chatId, afterId: Number.MAX_SAFE_INTEGER })),
    [],
  ];
  const now = T0 + 3_600_000;
  for (const span of spans) {
    for (const floors of floorSets) {
      const one = (floor) => ({ ...span, afterId: floor.afterId });
      assert.deepEqual(db.digest.inboundMany(floors, span, now), floors.map((f) => db.digest.inbound([f.chatId], one(f), now)));
      assert.deepEqual(db.digest.topSendersMany(floors, span, now, 3), floors.map((f) => db.digest.topSenders([f.chatId], one(f), now, 3)));
      assert.deepEqual(db.digest.topSendersMany(floors, span, now, 1), floors.map((f) => db.digest.topSenders([f.chatId], one(f), now, 1)));
      for (const options of [{}, { excludeSenders: new Set([contactOf(people[1])]) }, { min: 1 }, { min: 3 }]) {
        assert.deepEqual(
          db.digest.mostReactedMany(floors, span, now, options),
          floors.map((f) => db.digest.mostReacted([f.chatId], one(f), now, options))
        );
      }
    }
  }
  // The data is varied enough to mean something.
  const all = db.digest.inboundMany(floorSets[0], spans[0], now);
  assert.ok(all[0].count > 5 && all[0].senders > 1 && all[0].mentions > 0 && all[0].replies > 0);
  assert.equal(all[4].count, 0, "a chat with nothing in it reads as zeros");
  assert.ok(db.digest.mostReactedMany(floorSets[0], spans[0], now).filter((id) => id !== null).length >= 2);
});

test("a row count goes into the statement as an integer, or not at all", () => {
  assert.equal(sqlLimit(30), "30");
  assert.equal(sqlLimit(0), "0");
  for (const bad of [-1, 1.5, Number.NaN, Infinity, 2 ** 60, "3; DROP TABLE messages"]) {
    assert.throws(() => sqlLimit(bad), RangeError);
  }
});
