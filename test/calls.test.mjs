/**
 * The call reducer, driven by events and a clock. Baileys never delivers a call
 * as a message, so everything wazap stores about one is derived here; these pin
 * what each event sequence resolves to, and that the result survives the encode
 * and decode persistence puts it through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";

import { CallTracker, callMessage, callMessageLine, callNodeLine } from "../dist/calls.js";
import { callInfo } from "../dist/messages.js";

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const GROUP = "447851830860-1443638182@g.us";
const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

const event = (status, { from = PEER, id = "C1", at = T0, ...rest } = {}) => ({
  chatId: from,
  from,
  id,
  date: new Date(at),
  status,
  offline: false,
  ...rest,
});

const track = () => new CallTracker();

/** Assert the fields named in `expected`, ignoring the rest of the entry. */
const like = (actual, expected, label = "") => {
  assert.ok(actual, `${label} expected an entry, got ${actual}`);
  for (const [field, value] of Object.entries(expected)) assert.deepEqual(actual[field], value, `${label} ${field}`);
};

test("a call that was answered carries how long it lasted", () => {
  const calls = track();
  assert.equal(calls.observe(event("offer"), ME, T0), null);
  assert.equal(calls.observe(event("ringing"), ME, T0 + 2_000), null);
  assert.equal(calls.observe(event("accept"), ME, T0 + 8_000), null);
  assert.equal(calls.pending, 1, "an answered call stays pending until it ends");

  const entry = calls.observe(event("terminate"), ME, T0 + 368_000);
  assert.deepEqual(entry, {
    callId: "C1",
    chatId: PEER,
    at: T0,
    kind: "voice",
    direction: "incoming",
    outcome: "answered",
    durationSeconds: 360,
  });
  assert.equal(calls.pending, 0);
});

test("nobody picking up is missed at one end and unanswered at the other", () => {
  const incoming = track();
  incoming.observe(event("offer", { isVideo: true }), ME, T0);
  like(incoming.observe(event("timeout"), ME, T0 + 30_000), {
    outcome: "missed",
    kind: "video",
    direction: "incoming",
  });

  const outgoing = track();
  outgoing.observe(event("offer", { from: `${ME.split("@")[0]}:12@s.whatsapp.net` }), ME, T0);
  like(outgoing.observe(event("timeout", { from: ME }), ME, T0 + 30_000), {
    outcome: "unanswered",
    direction: "outgoing",
  });
});

test("hanging up before the other end picks up is not an answered call", () => {
  const calls = track();
  calls.observe(event("offer"), ME, T0);
  like(calls.observe(event("terminate"), ME, T0 + 12_000), { outcome: "missed" });
  assert.equal(calls.observe(event("terminate"), ME, T0 + 13_000), null, "a repeated terminal event stores nothing");
});

test("declining a call says so", () => {
  const calls = track();
  calls.observe(event("offer"), ME, T0);
  like(calls.observe(event("reject"), ME, T0 + 4_000), { outcome: "rejected" });
});

test("a group call is filed under the group, not the caller", () => {
  const calls = track();
  calls.observe(event("offer", { isGroup: true, groupJid: GROUP, chatId: GROUP }), ME, T0);
  like(calls.observe(event("reject"), ME, T0 + 4_000), { chatId: GROUP });
});

test("a call whose end never arrives is given up on after two minutes, once", () => {
  const calls = track();
  calls.observe(event("offer"), ME, T0);
  assert.deepEqual(calls.expire(T0 + MINUTE), [], "still ringing");

  const expired = calls.expire(T0 + 2 * MINUTE + 1);
  assert.equal(expired.length, 1);
  like(expired[0], { outcome: "missed", at: T0 });
  assert.deepEqual(calls.expire(T0 + 10 * MINUTE), [], "and never a second time");
  assert.equal(calls.pending, 0);
});

test("an answered call is not cut off at two minutes, only at the long cap", () => {
  const calls = track();
  calls.observe(event("offer"), ME, T0);
  calls.observe(event("accept"), ME, T0 + 5_000);

  assert.deepEqual(calls.expire(T0 + 3 * MINUTE), [], "a two-minute duration would be invented, not measured");
  const expired = calls.expire(T0 + 5_000 + 6 * 3_600_000);
  assert.equal(expired.length, 1);
  like(expired[0], { outcome: "answered", durationSeconds: 6 * 3_600 });
});

test("an event for a call wazap never saw offered still records it", () => {
  const calls = track();
  like(calls.observe(event("terminate", { at: T0 }), ME, T0), { callId: "C1", chatId: PEER, outcome: "missed" });
});

const ENTRIES = [
  {
    callId: "A",
    chatId: PEER,
    at: T0,
    kind: "voice",
    direction: "incoming",
    outcome: "answered",
    durationSeconds: 360,
  },
  { callId: "B", chatId: PEER, at: T0, kind: "video", direction: "incoming", outcome: "missed" },
  { callId: "C", chatId: PEER, at: T0, kind: "voice", direction: "outgoing", outcome: "unanswered" },
  { callId: "D", chatId: PEER, at: T0, kind: "video", direction: "outgoing", outcome: "rejected" },
  {
    callId: "E",
    chatId: GROUP,
    at: T0,
    kind: "voice",
    direction: "outgoing",
    outcome: "answered",
    durationSeconds: 45,
  },
];

test("an entry survives the encode and decode the store puts it through", () => {
  for (const entry of ENTRIES) {
    const raw = callMessage(entry);
    const restored = proto.WebMessageInfo.decode(proto.WebMessageInfo.encode(raw).finish());
    assert.deepEqual(
      callInfo(restored),
      {
        kind: entry.kind,
        direction: entry.direction,
        outcome: entry.outcome,
        ...(entry.durationSeconds === undefined ? {} : { duration_seconds: entry.durationSeconds }),
      },
      entry.callId
    );
    assert.equal(
      restored.key.id,
      `call_${entry.callId}`,
      "the id is stable, so a redelivery lands on the same message"
    );
    assert.equal(Number(restored.messageTimestamp), Math.floor(entry.at / 1000));
  }
});

test("the call debug log shows a stanza whole, bytes as their length, and only messages that carry a call", () => {
  const node = {
    tag: "call",
    attrs: { from: "40700000002@s.whatsapp.net", t: "1790000000" },
    content: [{ tag: "terminate", attrs: { "call-id": "C1", reason: "accepted_elsewhere" }, content: [{ tag: "enc", attrs: {}, content: new Uint8Array(32) }] }],
  };
  assert.equal(
    callNodeLine(node),
    '<call from=40700000002@s.whatsapp.net t=1790000000><terminate call-id=C1 reason=accepted_elsewhere><enc>[32 B]</enc></terminate></call>'
  );
  const key = { remoteJid: "40700000002@s.whatsapp.net", fromMe: true, id: "M1" };
  assert.equal(callMessageLine({ key, message: { conversation: "salut" } }), null);
  assert.match(callMessageLine({ key, message: { callLogMesssage: { callOutcome: 0 } } }), /^call message: id=M1 .*fromMe=true callLogMesssage=\{"callOutcome":0\}$/);
  assert.match(callMessageLine({ key, messageStubType: proto.WebMessageInfo.StubType.CALL_MISSED_VOICE }), /stub=CALL_MISSED_VOICE$/);
});
