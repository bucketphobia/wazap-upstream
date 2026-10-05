/**
 * The durable webhook outbox on its own: an account database, a dispatcher
 * with a clock the test moves, and a receiver the test answers for. Order,
 * the retry schedule, refusals, the 24-hour give-up, freshness, the transcript
 * wait, crashes, pruning and the counters status and doctor read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountDb } from "../dist/db/index.js";
import {
  CONNECTION_LANE,
  OUTBOX_GIVE_UP_MS,
  OUTBOX_SENDING_STALE_MS,
  OUTBOX_RETRY_DELAYS_MS,
  OUTBOX_RETRY_EVERY_MS,
  WEBHOOK_TRANSCRIPT_WAIT_MS,
  WebhookOutbox,
  chatLane,
  deliveryOf,
  readWebhookDelivery,
  retryDelay,
  undeliveredFailure,
} from "../dist/webhook-outbox.js";
import { WebhookSink } from "../dist/webhook.js";
import { webhookCheck } from "../dist/doctor.js";
import { GROUP, PEER, T0, openTemp, sid, textMessage } from "./db-fixtures.mjs";
import { waitFor } from "./helpers.mjs";

const SECRET = "outbox-test-secret";
const URL = "http://127.0.0.1:9/hook";
const CHILD = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "outbox-child.mjs");
const DAY = 24 * 60 * 60_000;

function readyEnv(events = "all", url = URL) {
  return { WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_URL: url, WAZAP_WEBHOOK_SECRET: SECRET, WAZAP_WEBHOOK_EVENTS: events };
}

/** A post that answers each call with the next status (the last one repeats), recording the bodies. */
function answering(...statuses) {
  const post = async (_url, init) => {
    const body = JSON.parse(init.body);
    post.bodies.push(body);
    const status = statuses[Math.min(post.bodies.length - 1, statuses.length - 1)];
    return new Response(null, { status });
  };
  post.bodies = [];
  return post;
}

/** A database, a dispatcher over it with the test's clock, and the log lines it wrote. */
function harness(t, { env = readyEnv(), post = answering(204), awaiting = () => false, payload } = {}) {
  const { db, path, clock } = openTemp();
  const sink = new WebhookSink(env, { post });
  const outbox = new WebhookOutbox(
    {
      db: () => (db.isOpen ? db : null),
      sink: () => sink,
      payload:
        payload ??
        ((event, message) =>
          message === null
            ? JSON.parse(event.payload)
            : { event: event.kind, message_id: message.sid, text: message.transcript ?? message.text }),
      awaitingTranscript: (message) => awaiting(message),
    },
    { now: () => clock.now }
  );
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  t.after(async () => {
    await outbox.stop();
    if (db.isOpen) db.close();
  });
  const run = async () => {
    outbox.kick();
    await outbox.idle();
  };
  return { db, path, clock, sink, outbox, post, logs, run };
}

/** A stored message and its event, in one transaction and in its chat's lane, the way the service writes them. */
function messageEvent(h, key, text = `text ${key}`, { kind = "message_received", readyAt, ts = T0, extra = {}, chat = PEER } = {}) {
  return h.db.transaction(() => {
    const stored = h.db.messages.upsert(textMessage(chat, key, ts, text, extra));
    const lane = chatLane(h.db.identity.chat(chat).id);
    const seq = h.db.events.enqueue({ kind, lane, messageId: stored.id, payload: "{}", createdAt: h.clock.now, readyAt });
    return { seq, sid: sid(false, chat, key) };
  });
}

function connectionEvent(h, status = "linked") {
  return h.db.events.enqueue({
    kind: "connection",
    lane: CONNECTION_LANE,
    messageId: null,
    payload: JSON.stringify({ event: "connection", status }),
    createdAt: h.clock.now,
  });
}

const state = (h, seq) => h.db.events.get(seq);

test("events go out in the order they were queued, one POST at a time", async (t) => {
  let inFlight = 0;
  let peak = 0;
  const bodies = [];
  const post = async (_url, init) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    bodies.push(JSON.parse(init.body));
    inFlight--;
    return new Response(null, { status: 204 });
  };
  const h = harness(t, { post });
  const seqs = [messageEvent(h, "A").seq, connectionEvent(h), messageEvent(h, "B").seq, messageEvent(h, "C").seq];
  h.outbox.kick();
  h.outbox.kick();
  await h.outbox.idle();
  assert.equal(peak, 1);
  assert.deepEqual(
    bodies.map((body) => body.message_id ?? body.status),
    [sid(false, PEER, "A"), "linked", sid(false, PEER, "B"), sid(false, PEER, "C")]
  );
  for (const seq of seqs) assert.equal(state(h, seq).state, "delivered");
});

test("an event being retried holds back the events of its own chat, and no other chat's", async (t) => {
  const post = async (_url, init) => {
    const body = JSON.parse(init.body);
    post.bodies.push(body);
    return new Response(null, { status: body.message_id?.endsWith("POISON") && post.poisoned ? 500 : 204 });
  };
  post.bodies = [];
  post.poisoned = true;
  const h = harness(t, { post });
  const t0 = h.clock.now;
  const poison = messageEvent(h, "POISON");
  const after = messageEvent(h, "SAME_CHAT");
  h.clock.now += 1_000;
  const other = messageEvent(h, "B1", "vreau o programare", { chat: GROUP });
  const linked = connectionEvent(h);
  await h.run();
  assert.deepEqual(
    h.post.bodies.map((body) => body.message_id ?? body.status),
    [poison.sid, other.sid, "linked"],
    "the other chat and the connection went out a second after the failure, not after its retries"
  );
  assert.equal(state(h, after.seq).attempts, 0, "the same chat waits behind its failing event");
  assert.equal(state(h, other.seq).updatedAt - t0, 1_000);

  post.poisoned = false;
  h.clock.now = state(h, poison.seq).nextAttemptAt;
  await h.run();
  assert.deepEqual(h.post.bodies.slice(-2).map((body) => body.message_id), [poison.sid, after.sid], "the chat keeps its order");
  for (const event of [poison, after, other]) assert.equal(state(h, event.seq).state, "delivered");
  assert.equal(state(h, linked).state, "delivered");
});

test("a voice note waiting for its transcript holds back only its own chat, and a POST that gets through brings the other chats' retries forward", async (t) => {
  let up = false;
  const post = async (_url, init) => {
    const body = JSON.parse(init.body);
    post.bodies.push(body);
    return new Response(null, { status: up ? 204 : 503 });
  };
  post.bodies = [];
  const h = harness(t, { post, awaiting: () => true });
  const voice = messageEvent(h, "VOICE", "[voice message · 0:06]", { readyAt: h.clock.now + WEBHOOK_TRANSCRIPT_WAIT_MS });
  const text = messageEvent(h, "AFTER_VOICE");
  const group = messageEvent(h, "G1", "în grup", { chat: GROUP });
  await h.run();
  assert.deepEqual(h.post.bodies.map((body) => body.message_id), [group.sid], "the group did not wait for the voice note");
  assert.equal(state(h, text.seq).attempts, 0, "the text after the voice note waits for it");

  // The group's event is in its 5-minute retries when the receiver comes back.
  for (let i = 0; i < 4; i++) {
    h.clock.now = state(h, group.seq).nextAttemptAt;
    await h.run();
  }
  assert.ok(state(h, group.seq).nextAttemptAt - h.clock.now >= 2 * 60_000);
  up = true;
  h.clock.now += 60_000;
  const third = messageEvent(h, "C1", "altă conversație", { chat: "40700000009@s.whatsapp.net" });
  // A kick, not a nudge: only the delivery of the new chat's event can bring the rest forward.
  h.outbox.kick();
  await h.outbox.idle();
  for (const event of [third, group, voice, text]) {
    assert.equal(state(h, event.seq).state, "delivered", event.sid);
    assert.equal(state(h, event.seq).updatedAt, h.clock.now, `${event.sid} went out at once`);
  }
});

test("after an outage only the newest connection status goes out; the flaps before it are cancelled as superseded", async (t) => {
  let up = false;
  const post = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (up) post.bodies.push([h.clock.now, body.status]);
    return new Response(null, { status: up ? 204 : 502 });
  };
  post.bodies = [];
  const h = harness(t, { post });
  const t0 = h.clock.now;
  const flaps = [];
  for (let i = 0; i < 5; i++) {
    flaps.push(connectionEvent(h, "disconnected"));
    h.outbox.nudge();
    await h.outbox.idle();
    h.clock.now += 20 * 60_000;
    flaps.push(connectionEvent(h, "linked"));
    h.outbox.nudge();
    await h.outbox.idle();
    h.clock.now += 5 * 60_000;
  }
  up = true;
  h.outbox.nudge();
  await h.outbox.idle();
  assert.deepEqual(post.bodies, [[t0 + 125 * 60_000, "linked"]], "one POST, the current status");
  assert.equal(state(h, flaps.at(-1)).state, "delivered");
  for (const seq of flaps.slice(0, -1)) {
    assert.equal(state(h, seq).state, "cancelled");
    assert.equal(state(h, seq).lastError, "superseded by a newer connection event");
  }
});

test("a retryable failure is tried again after 1 s, 5 s, 30 s and 2 min, then every 5 min", async (t) => {
  const h = harness(t, { post: answering(503) });
  const { seq } = messageEvent(h, "RETRY");
  await h.run();
  const expected = [...OUTBOX_RETRY_DELAYS_MS, ...Array(4).fill(OUTBOX_RETRY_EVERY_MS)];
  assert.deepEqual(expected, [1_000, 5_000, 30_000, 120_000, 300_000, 300_000, 300_000, 300_000]);
  for (const [index, delay] of expected.entries()) {
    const row = state(h, seq);
    assert.equal(row.state, "pending");
    assert.equal(row.attempts, index + 1);
    assert.equal(row.nextAttemptAt - h.clock.now, delay, `after ${index + 1} failures`);
    assert.equal(row.lastStatus, 503);
    assert.equal(row.lastError, "HTTP 503 from 127.0.0.1:9");
    h.clock.now = row.nextAttemptAt - 1;
    await h.run();
    assert.equal(h.post.bodies.length, index + 1, "not a moment early");
    h.clock.now = row.nextAttemptAt;
    await h.run();
    assert.equal(h.post.bodies.length, index + 2);
  }
  assert.equal(retryDelay(1), 1_000);
  assert.equal(retryDelay(5), OUTBOX_RETRY_EVERY_MS);
});

test("408, 425, 429 and 5xx are retried; any other 4xx fails at once, after one POST", async (t) => {
  for (const status of [408, 425, 429, 500, 502, 503]) {
    const h = harness(t, { post: answering(status) });
    const { seq } = messageEvent(h, `S${status}`);
    await h.run();
    assert.equal(h.post.bodies.length, 1);
    assert.equal(state(h, seq).state, "pending", `${status} is retried`);
    assert.equal(state(h, seq).nextAttemptAt, h.clock.now + 1_000);
  }
  for (const status of [400, 401, 403, 404, 410, 413, 422]) {
    const h = harness(t, { post: answering(status, 204) });
    const { seq } = messageEvent(h, `S${status}`);
    const behind = connectionEvent(h);
    await h.run();
    const row = state(h, seq);
    assert.equal(row.state, "failed", `${status} is a refusal`);
    assert.equal(row.attempts, 1);
    assert.equal(row.lastStatus, status);
    assert.match(row.lastError, new RegExp(`^HTTP ${status} from 127\\.0\\.0\\.1:9, not retried: the receiver`));
    assert.ok(!row.lastError.includes(SECRET));
    assert.equal(state(h, behind).state, "delivered", "a refused event does not hold back the next one");
  }
});

test("an unreachable receiver is retried like a 5xx, and the error names the host, not the URL", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const h = harness(t, { env: readyEnv("all", `http://127.0.0.1:${port}/hook?token=${SECRET}`), post: fetch });
  const { seq } = messageEvent(h, "DOWN");
  await h.run();
  const row = state(h, seq);
  assert.equal(row.state, "pending");
  assert.equal(row.lastStatus, null);
  assert.equal(row.lastError, `could not reach 127.0.0.1:${port} (ECONNREFUSED)`);
});

test("an event is retried every 5 min, tried one last time at 24 hours, then fails; one that never got a turn fails unposted", async (t) => {
  const h = harness(t, { post: answering(503) });
  const { seq } = messageEvent(h, "OLD");
  const created = h.clock.now;
  const deadline = created + OUTBOX_GIVE_UP_MS;
  await h.run();
  // Into the 5-minute retries, as four more failed POSTs would have got it.
  for (let i = 0; i < 4; i++) {
    h.db.events.claim(seq, created);
    h.db.events.retry(seq, created, 503, "HTTP 503 from 127.0.0.1:9", created);
  }
  h.clock.now = deadline - 2 * 60_000;
  await h.run();
  assert.equal(state(h, seq).state, "pending");
  assert.equal(state(h, seq).nextAttemptAt, deadline, "five minutes on is past the day: the last attempt is at its very end");
  h.clock.now = deadline + 50;
  await h.run();
  const row = state(h, seq);
  assert.equal(row.state, "failed");
  assert.equal(row.attempts, 7);
  assert.equal(row.lastError, "HTTP 503 from 127.0.0.1:9; gave up 24 h after the event");
  assert.equal(h.post.bodies.length, 3);

  const late = messageEvent(h, "NEVER");
  h.clock.now += OUTBOX_GIVE_UP_MS;
  await h.run();
  assert.equal(state(h, late.seq).state, "failed");
  assert.equal(state(h, late.seq).attempts, 0, "a day-old event nobody tried is not posted at all");
  assert.equal(h.post.bodies.length, 3);
});

test("new traffic brings a waiting retry forward once its last attempt is 30 s old: a receiver back after an outage hears it at once", async (t) => {
  let upAt = Infinity;
  const posts = [];
  const post = async (_url, init) => {
    posts.push([h.clock.now, JSON.parse(init.body).message_id]);
    return new Response(null, { status: h.clock.now >= upAt ? 204 : 503 });
  };
  const h = harness(t, { post });
  const t0 = h.clock.now;
  upAt = t0 + 13 * 60_000;
  const first = messageEvent(h, "A1");
  await h.run();
  // The receiver stays down for 13 minutes; the retries run on their schedule.
  while (state(h, first.seq).nextAttemptAt < t0 + 14 * 60_000) {
    h.clock.now = state(h, first.seq).nextAttemptAt;
    await h.run();
  }
  const lastAttempt = posts.at(-1)[0];
  assert.equal(lastAttempt - t0, 12 * 60_000 + 36_000, "0, 1 s, 6 s, 36 s, 2 min 36 s, 7 min 36 s, 12 min 36 s");
  assert.equal(state(h, first.seq).nextAttemptAt - t0, 17 * 60_000 + 36_000);

  h.clock.now = t0 + 14 * 60_000;
  const client = messageEvent(h, "B1", "mai aveți loc azi?");
  h.outbox.nudge();
  await h.outbox.idle();
  assert.deepEqual(posts.slice(-2), [
    [t0 + 14 * 60_000, first.sid],
    [t0 + 14 * 60_000, client.sid],
  ], "both went out the moment the client wrote");

  const fresh = messageEvent(h, "C1");
  upAt = Infinity;
  await h.run();
  assert.equal(state(h, fresh.seq).nextAttemptAt, h.clock.now + 1_000);
  for (const delay of [1_000, 5_000]) {
    h.clock.now += delay;
    await h.run();
  }
  assert.equal(state(h, fresh.seq).nextAttemptAt, h.clock.now + 30_000);
  h.clock.now += 20_000;
  messageEvent(h, "C2");
  h.outbox.nudge();
  await h.outbox.idle();
  assert.equal(state(h, fresh.seq).attempts, 3, "an attempt 20 s old is not brought forward");
});

test("a message deleted, expired or cleared before its POST is cancelled and never posted, also before a retry", async (t) => {
  const h = harness(t, { post: answering(503, 204) });
  const deleted = messageEvent(h, "DEL");
  const expiring = messageEvent(h, "EXP", "gone soon", { ts: T0 + 30_000, extra: { expiresAt: h.clock.now + 5_000 } });
  const cleared = messageEvent(h, "CLR", "cleared", { ts: T0 + 1_000 });
  const kept = messageEvent(h, "KEEP", "kept", { ts: T0 + 60_000 });

  await h.run();
  assert.deepEqual(h.post.bodies.map((body) => body.message_id), [deleted.sid], "the first POST failed and will be retried");
  h.db.messages.delete(deleted.sid, { at: h.clock.now });
  h.clock.now += 6_000;
  await h.db.messages.clearChat(PEER, T0 + 1_000);
  await h.run();

  assert.equal(h.post.bodies.length, 2, "only the message still there was posted again");
  assert.equal(h.post.bodies[1].message_id, kept.sid);
  for (const gone of [deleted, expiring, cleared]) {
    const row = state(h, gone.seq);
    assert.equal(row.state, "cancelled", gone.sid);
    assert.equal(row.lastError, "the message was deleted, expired or cleared before it was posted");
  }
  assert.equal(state(h, kept.seq).state, "delivered");
});

test("the webhook turned off cancels what waits, and an event it no longer subscribes to is cancelled when its turn comes", async (t) => {
  const env = readyEnv("message_received");
  const h = harness(t, { env });
  const connection = connectionEvent(h);
  const received = messageEvent(h, "IN");
  const sent = messageEvent(h, "OUT", "typed on the phone", { kind: "message_sent" });
  await h.run();
  assert.deepEqual(h.post.bodies.map((body) => body.message_id), [received.sid]);
  assert.equal(state(h, connection).state, "cancelled");
  assert.equal(state(h, connection).lastError, "connection is not an enabled event");
  assert.equal(state(h, sent.seq).state, "cancelled");

  const waiting = messageEvent(h, "LATER");
  env.WAZAP_WEBHOOK = "off";
  await h.run();
  assert.equal(state(h, waiting.seq).state, "cancelled");
  assert.equal(state(h, waiting.seq).lastError, "the webhook is off");
  env.WAZAP_WEBHOOK = "on";
  await h.run();
  assert.equal(h.post.bodies.length, 1, "turning it back on does not post what was cancelled");
});

test("a voice note's event waits for its transcript while one is being made, and goes without it at ready_at", async (t) => {
  let transcribing = true;
  const h = harness(t, { awaiting: () => transcribing });
  const now = h.clock.now;
  const voiced = messageEvent(h, "V1", "[voice message · 0:06]", { readyAt: now + WEBHOOK_TRANSCRIPT_WAIT_MS });
  await h.run();
  assert.equal(h.post.bodies.length, 0);
  h.db.messages.setTranscript(voiced.sid, "am uitat umbrela acasă");
  await h.run();
  assert.deepEqual(h.post.bodies.map((body) => body.text), ["am uitat umbrela acasă"], "posted as soon as the words are stored");

  const silent = messageEvent(h, "V2", "[voice message · 0:09]", { readyAt: now + WEBHOOK_TRANSCRIPT_WAIT_MS });
  h.clock.now = now + WEBHOOK_TRANSCRIPT_WAIT_MS - 1;
  await h.run();
  assert.equal(h.post.bodies.length, 1, "still waiting a millisecond before ready_at");
  h.clock.now = now + WEBHOOK_TRANSCRIPT_WAIT_MS;
  await h.run();
  assert.equal(h.post.bodies[1].text, "[voice message · 0:09]");
  assert.equal(state(h, silent.seq).state, "delivered");

  transcribing = false;
  messageEvent(h, "V3", "[voice message · 0:03]", { readyAt: h.clock.now + WEBHOOK_TRANSCRIPT_WAIT_MS });
  await h.run();
  assert.equal(h.post.bodies.length, 3, "a transcription that settled without words holds nothing up");
});

test("a payload that cannot be built fails the event without posting it or logging what it said", async (t) => {
  const h = harness(t, {
    payload: () => {
      throw new Error(`cannot build ${SECRET}`);
    },
  });
  const { seq } = messageEvent(h, "BAD");
  const next = connectionEvent(h);
  await h.run();
  assert.equal(h.post.bodies.length, 0);
  assert.equal(state(h, seq).state, "failed");
  assert.equal(state(h, seq).lastError, "Webhook delivery failed.");
  assert.equal(state(h, next).state, "failed", "the builder threw for that one too");
  assert.ok(!h.logs.join("\n").includes(SECRET));
});

test("stop waits for the POST in flight and records it; a POST a crash cut short is sent again", async (t) => {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const posting = new Promise((resolve) => {
    started = resolve;
  });
  const post = async () => {
    started();
    await gate;
    return new Response(null, { status: 204 });
  };
  const h = harness(t, { post });
  const { seq } = messageEvent(h, "FLIGHT");
  h.outbox.kick();
  await posting;
  assert.equal(state(h, seq).state, "sending");
  const stopping = h.outbox.stop();
  release();
  await stopping;
  assert.equal(state(h, seq).state, "delivered", "stop recorded the answer before returning");

  // A row left `sending`, as a process killed mid-POST leaves it, is taken over once no POST can still be running.
  const again = messageEvent(h, "CUT");
  h.db.events.claim(again.seq, h.clock.now);
  h.clock.now += OUTBOX_SENDING_STALE_MS;
  const recorder = answering(204);
  const reopened = new WebhookOutbox(
    {
      db: () => h.db,
      sink: () => new WebhookSink(readyEnv(), { post: recorder }),
      payload: (event, message) => ({ event: event.kind, message_id: message.sid }),
      awaitingTranscript: () => false,
    },
    { now: () => h.clock.now }
  );
  reopened.start();
  await reopened.idle();
  await reopened.stop();
  assert.deepEqual(recorder.bodies.map((body) => body.message_id), [again.sid]);
  assert.equal(state(h, again.seq).attempts, 2);
  assert.equal(state(h, again.seq).state, "delivered");
});

test("a dispatcher starting while another still posts over the same file leaves that POST and its chat alone until it is stale", async (t) => {
  const old = harness(t);
  const clock = old.clock;
  let inFlight = 0;
  let peak = 0;
  const bodies = [];
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const posting = new Promise((resolve) => {
    started = resolve;
  });
  const slow = new WebhookSink(readyEnv(), {
    post: async (_url, init) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      bodies.push(JSON.parse(init.body).message_id);
      if (bodies.length === 1) {
        started();
        await gate;
      }
      inFlight--;
      return new Response(null, { status: 204 });
    },
  });
  const over = (db) =>
    new WebhookOutbox(
      { db: () => (db.isOpen ? db : null), sink: () => slow, payload: (event, message) => ({ event: event.kind, message_id: message.sid }), awaitingTranscript: () => false },
      { now: () => clock.now }
    );
  const first = messageEvent(old, "A1");
  const second = messageEvent(old, "A2");
  const retiring = over(old.db);
  retiring.start();
  await posting;

  const successor = AccountDb.open(old.path, { now: () => clock.now });
  t.after(() => successor.close());
  const next = over(successor);
  next.start();
  await next.idle();
  assert.deepEqual(bodies, [first.sid], "the new dispatcher did not post the event in flight, nor the one behind it");

  const stopping = retiring.stop();
  release();
  await stopping;
  assert.equal(successor.events.get(first.seq).state, "delivered");
  assert.equal(successor.events.get(first.seq).attempts, 1);

  clock.now += 1;
  next.kick();
  await next.idle();
  assert.deepEqual(bodies, [first.sid, second.sid]);
  assert.equal(peak, 1, "never two POSTs at once");
  await next.stop();

  // A claim that outlived any POST is taken over; the overtaken dispatcher's late answer changes nothing.
  const third = messageEvent(old, "A3");
  successor.events.claim(third.seq, clock.now);
  clock.now += OUTBOX_SENDING_STALE_MS;
  assert.equal(successor.events.claim(third.seq, clock.now, clock.now - OUTBOX_SENDING_STALE_MS), true);
  assert.equal(successor.events.delivered(third.seq, 204, clock.now, 1), false, "attempt 1 was overtaken by attempt 2");
  assert.equal(successor.events.delivered(third.seq, 204, clock.now, 2), true);
});

test("a run of identical refusals logs a few lines, and one line when delivery comes back", async (t) => {
  let status = 401;
  const post = async () => new Response(null, { status });
  const h = harness(t, { post });
  for (let i = 0; i < 250; i++) messageEvent(h, `R${i}`);
  await h.run();
  status = 204;
  messageEvent(h, "BACK");
  await h.run();
  const lines = h.logs.filter((line) => line.includes("webhook"));
  assert.equal(lines.length, 4, lines.join("\n"));
  assert.match(lines[0], /ERROR \(webhook\): HTTP 401 from 127\.0\.0\.1:9, not retried/);
  assert.match(lines[1], /\(100 failures in a row\)/);
  assert.match(lines[2], /\(200 failures in a row\)/);
  assert.match(lines[3], /webhook delivered again after 250 failures/);
});

test("delivered events are pruned after 7 days, failed and cancelled ones after 30, at start", async (t) => {
  const h = harness(t);
  const old = (days) => h.clock.now - days * DAY;
  const close = (outcome, days) => {
    const seq = connectionEvent(h);
    h.db.events.claim(seq, old(days));
    if (outcome === "delivered") h.db.events.delivered(seq, 204, old(days));
    if (outcome === "failed") h.db.events.fail(seq, 401, "refused", old(days));
    if (outcome === "cancelled") h.db.events.cancel(seq, "off", old(days));
    return seq;
  };
  const gone = [close("delivered", 8), close("failed", 31), close("cancelled", 31)];
  const kept = [close("delivered", 6), close("failed", 29), close("cancelled", 29)];
  const waiting = connectionEvent(h);
  h.db.events.claim(waiting, old(40));
  h.db.events.retry(waiting, h.clock.now + DAY, 503, "down", old(40));
  const outbox = new WebhookOutbox(
    { db: () => h.db, sink: () => h.sink, payload: () => ({}), awaitingTranscript: () => false },
    { now: () => h.clock.now, giveUpMs: 100 * DAY }
  );
  outbox.start();
  await outbox.stop();
  for (const seq of gone) assert.equal(state(h, seq), null, `event ${seq} was pruned`);
  for (const seq of kept) assert.notEqual(state(h, seq), null, `event ${seq} is kept`);
  assert.equal(state(h, waiting).state, "pending", "an open event is never pruned");
  assert.equal(await h.db.events.prune(h.clock.now, h.clock.now, 1), 2, "the rest, one row per chunk, but the latest delivery");
});

test("pruning keeps the latest delivery, so failures it ended do not read as current a week later", async (t) => {
  let status = 401;
  const h = harness(t, { post: async () => new Response(null, { status }) });
  for (const key of ["F1", "F2", "F3"]) messageEvent(h, key);
  await h.run();
  status = 204;
  h.clock.now += 60_000;
  const ok = messageEvent(h, "OK1");
  await h.run();
  const env = readyEnv("message_received", "https://hooks.example/wazap");
  const check = () => {
    const delivery = readWebhookDelivery(h.path);
    return [delivery.consecutive_failures, undeliveredFailure(delivery), webhookCheck(env, [{ account: "default", delivery }], h.clock.now).state];
  };
  assert.deepEqual(check(), [0, null, "ok"]);

  h.clock.now += 8 * DAY;
  assert.equal(await h.db.events.prune(h.clock.now - 7 * DAY, h.clock.now - 30 * DAY), 0, "the only delivery is the latest one");
  assert.equal(state(h, ok.seq).state, "delivered");
  assert.deepEqual(check(), [0, null, "ok"], "a week later the refusals are still over");

  h.clock.now += 1_000;
  const later = messageEvent(h, "OK2");
  await h.run();
  assert.equal(await h.db.events.prune(h.clock.now - 7 * DAY, h.clock.now - 30 * DAY), 1, "an older delivery goes once a newer one exists");
  assert.equal(state(h, ok.seq), null);
  assert.equal(state(h, later.seq).state, "delivered");
});

test("the counters status and doctor read: from the rows, read-only, with the server running and after it stopped", async (t) => {
  const answer = answering(204, 401, 401, 503);
  // Each answer a millisecond after the last, so the failures come after the delivery.
  const h = harness(t, { post: async (url, init) => ((h.clock.now += 1), answer(url, init)) });
  const created = h.clock.now;
  messageEvent(h, "OK");
  const refused = [messageEvent(h, "R1"), messageEvent(h, "R2")];
  const retrying = messageEvent(h, "RETRY");
  const cancelled = messageEvent(h, "GONE");
  h.db.events.cancel(cancelled.seq, "the message was deleted, expired or cleared before it was posted", h.clock.now);
  await h.run();
  assert.deepEqual(refused.map((event) => state(h, event.seq).state), ["failed", "failed"]);
  assert.equal(state(h, retrying.seq).state, "pending");

  const expected = {
    delivered: 1,
    failed: 2,
    cancelled: 1,
    pending: 1,
    dropped: 0,
    consecutive_failures: 2,
    retrying: 1,
    last_success_at: new Date(created + 1).toISOString(),
    last_failure_at: new Date(created + 4).toISOString(),
    last_failure: "HTTP 503 from 127.0.0.1:9",
    last_status: 503,
    last_dropped_at: null,
    oldest_pending_at: new Date(created).toISOString(),
  };
  assert.deepEqual(h.outbox.delivery(h.db), expected);
  assert.deepEqual(readWebhookDelivery(h.path), expected, "another process, while this one holds the database open");
  h.db.close();
  assert.deepEqual(readWebhookDelivery(h.path), expected, "another process, with the server stopped");
  assert.equal(readWebhookDelivery(join(dirname(h.path), "missing.sqlite")), null);

  const failedAt = Date.parse(expected.last_failure_at);
  assert.equal(undeliveredFailure({ ...expected, last_success_at: new Date(failedAt - 1).toISOString() }), "HTTP 503 from 127.0.0.1:9");
  assert.equal(undeliveredFailure({ ...expected, last_success_at: new Date(failedAt + 1).toISOString() }), null);
  assert.deepEqual(deliveryOf(null).delivered, 0);

  h.outbox.dropped("connection linked", Object.assign(new Error(SECRET), { code: "SQLITE_FULL" }));
  const dropped = h.outbox.delivery(null);
  assert.equal(dropped.dropped, 1);
  assert.ok(Number.isFinite(Date.parse(dropped.last_dropped_at)));
  assert.ok(h.logs.some((line) => /dropped connection linked: the account database could not store it \(SQLITE_FULL\)/.test(line)));
  assert.ok(!h.logs.join("\n").includes(SECRET));
});

test("the counters are read in one transaction: a delivery the server records meanwhile cannot make them disagree", async (t) => {
  const h = harness(t);
  const { seq } = messageEvent(h, "RACE");
  const reader = AccountDb.open(h.path, { readOnly: true });
  t.after(() => reader.close());
  const connection = reader.events["c"];
  const read = connection.get.bind(connection);
  let statements = 0;
  // The server delivers the event right after the reader's first statement.
  connection.get = (...args) => {
    const row = read(...args);
    if (++statements === 1) {
      h.db.events.claim(seq, h.clock.now);
      h.db.events.delivered(seq, 204, h.clock.now, 1);
    }
    return row;
  };
  const stats = reader.events.stats();
  assert.equal(statements > 1, true);
  assert.deepEqual(
    [stats.pending, stats.delivered, stats.oldestPendingAt, stats.lastSuccessAt],
    [1, 0, h.clock.now, null],
    "the whole read sees the event still waiting"
  );
  assert.deepEqual([reader.events.stats().pending, reader.events.stats().delivered], [0, 1]);
});

/** The receiver a crash test posts to: every body it got, and what it answers. */
async function receiver(t, onRequest) {
  const hits = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      hits.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      onRequest(hits.length, res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}/hook`, hits };
}

function child(args) {
  const proc = fork(CHILD, [JSON.stringify(args)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(proc, "exit");
  return { proc, exited };
}

/** A dispatcher in this process over the database the dead child left, started a little later, until `done`. */
async function afterRestart(t, path, url, done) {
  const db = AccountDb.open(path);
  const sink = new WebhookSink(readyEnv("all", url));
  const outbox = new WebhookOutbox(
    {
      db: () => db,
      sink: () => sink,
      payload: (event, message) => ({ event: event.kind, message_id: message.sid, text: message.text }),
      awaitingTranscript: () => false,
    },
    // The restart comes after a POST started by the dead process could have run out.
    { now: () => Date.now() + OUTBOX_SENDING_STALE_MS }
  );
  t.after(async () => {
    await outbox.stop();
    db.close();
  });
  outbox.start();
  await waitFor(done, 10_000, "the restarted outbox to deliver");
  await outbox.idle();
  return db;
}

test("no event is lost when the server is killed between storing the message and posting it", async (t) => {
  const { path, db: created } = openTemp();
  created.close();
  const hook = await receiver(t, (_n, res) => {
    res.writeHead(204);
    res.end();
  });
  const dying = child({ path, mode: "enqueue", chat: PEER, key: "CRASH1", at: T0 });
  const [, signal] = await dying.exited;
  assert.equal(signal, "SIGKILL");

  const db = await afterRestart(t, path, hook.url, () => hook.hits.length > 0);
  assert.deepEqual(hook.hits.map((hit) => hit.message_id), [sid(false, PEER, "CRASH1")], "delivered exactly once");
  assert.equal(hook.hits[0].text, "before the crash");
  assert.deepEqual(deliveryOf(db.events.stats()).delivered, 1);
});

test("an event whose POST a crash cut short is posted again: once to a receiver that dedupes, at least once to one that does not", async (t) => {
  const { path, db: seeded } = openTemp();
  seeded.transaction(() => {
    const stored = seeded.messages.upsert(textMessage(PEER, "MIDPOST", T0, "in flight when the server died"));
    // The child posts on the real clock, so the event is created on it too.
    seeded.events.enqueue({ kind: "message_received", lane: "chat:1", messageId: stored.id, payload: "{}", createdAt: Date.now() });
  });
  seeded.close();

  let dying;
  const hook = await receiver(t, (n, res) => {
    if (n === 1) {
      // The receiver took the event, and the server dies before it hears back.
      dying.proc.kill("SIGKILL");
      dying.exited.then(() => res.destroy());
      return;
    }
    res.writeHead(204);
    res.end();
  });
  dying = child({ path, mode: "post", url: hook.url, secret: SECRET });
  await waitFor(() => hook.hits.length > 0, 10_000, "the child's POST");
  const [, signal] = await dying.exited;
  assert.equal(signal, "SIGKILL");
  assert.equal(hook.hits.length, 1);

  const db = await afterRestart(t, path, hook.url, () => hook.hits.length > 1);
  assert.equal(hook.hits.length, 2, "at least once: the receiver saw it twice");
  const deduped = new Set(hook.hits.map((hit) => hit.message_id));
  assert.deepEqual([...deduped], [sid(false, PEER, "MIDPOST")], "exactly once to a receiver that dedupes by message_id");
  const row = db.events.head() ?? db.events.get(1);
  assert.equal(row.state, "delivered");
  assert.equal(row.attempts, 2);
});

function coalesceEnv(seconds) {
  return { ...readyEnv(), WAZAP_WEBHOOK_COALESCE: String(seconds) };
}

/** A payload close to a real message event, so a burst can carry the added fields. */
function burstPayload(event, message) {
  if (message === null) return JSON.parse(event.payload);
  return {
    event: event.kind,
    message_id: message.sid,
    text: message.text,
    ts: "2026-09-01T13:00:00+03:00",
    timestamp: new Date(message.ts).toISOString(),
    chat_id: message.chatJid,
  };
}

test("with no coalesce window each message is its own POST and the body has no burst fields", async (t) => {
  const h = harness(t, { payload: burstPayload });
  messageEvent(h, "A", "one");
  messageEvent(h, "B", "two");
  await h.run();
  assert.equal(h.post.bodies.length, 2);
  assert.equal(h.post.bodies[0].count, undefined);
  assert.equal(h.post.bodies[0].message_ids, undefined);
  assert.equal(h.post.bodies[1].message_id, sid(false, PEER, "B"));
});

test("a quiet window posts one chat's messages as one body, and another chat is not held", async (t) => {
  const h = harness(t, { env: coalesceEnv(90), payload: burstPayload });
  const start = h.clock.now;
  messageEvent(h, "A", "one", { ts: start });
  messageEvent(h, "B", "two", { ts: start + 1000 });
  const other = messageEvent(h, "G", "group", { chat: GROUP, ts: start });
  await h.run();
  assert.equal(h.post.bodies.length, 0, "90s has not passed");

  h.clock.now = start + 89_000;
  await h.run();
  assert.equal(h.post.bodies.length, 0);

  h.clock.now = start + 90_000;
  await h.run();
  assert.equal(h.post.bodies.length, 2);
  const body = h.post.bodies[0];
  const alone = h.post.bodies[1];
  assert.equal(body.count, 2);
  assert.deepEqual(body.message_ids, [sid(false, PEER, "A"), sid(false, PEER, "B")]);
  assert.deepEqual(body.texts, ["one", "two"]);
  assert.equal(body.message_id, sid(false, PEER, "B"), "the fields that already existed name the latest message");
  assert.equal(body.text, "two");
  assert.equal(body.first_ts, "2026-09-01T13:00:00+03:00");
  assert.equal(body.first_timestamp, new Date(start).toISOString());
  assert.equal(alone.count, undefined, "a single message stays the old shape");
  assert.equal(alone.message_id, other.sid);
  assert.deepEqual(
    [state(h, 1).state, state(h, 2).state, state(h, 3).state],
    ["delivered", "delivered", "delivered"]
  );
});

test("one chat's quiet window does not hold another chat", async (t) => {
  const h = harness(t, { env: coalesceEnv(90), payload: burstPayload });
  const start = h.clock.now;
  messageEvent(h, "A", "one");
  const other = messageEvent(h, "G", "elsewhere", { chat: GROUP });
  h.clock.now = start + 80_000;
  messageEvent(h, "B", "two");
  h.clock.now = start + 90_000;
  await h.run();
  assert.deepEqual(
    h.post.bodies.map((body) => body.message_id),
    [other.sid],
    "the other chat's window ended; this chat is still inside the quiet period the second message started"
  );
  assert.equal(state(h, 1).state, "pending");
  h.clock.now = start + 170_000;
  await h.run();
  assert.deepEqual(h.post.bodies[1].message_ids, [sid(false, PEER, "A"), sid(false, PEER, "B")]);
});

test("a new message extends the quiet window, and the cap still delivers a conversation that does not pause", async (t) => {
  const h = harness(t, { env: coalesceEnv(90), payload: burstPayload });
  const start = h.clock.now;
  messageEvent(h, "A", "one");
  h.clock.now = start + 80_000;
  await h.run();
  assert.equal(h.post.bodies.length, 0);
  messageEvent(h, "B", "two");
  h.clock.now = start + 169_000;
  await h.run();
  assert.equal(h.post.bodies.length, 0, "the second message moved the quiet deadline to 170s");
  h.clock.now = start + 170_000;
  await h.run();
  assert.deepEqual(h.post.bodies[0].texts, ["one", "two"]);

  const later = h.clock.now;
  for (let i = 0; i < 4; i++) {
    h.clock.now = later + i * 50_000;
    messageEvent(h, `C${i}`, `line ${i}`);
  }
  h.clock.now = later + 170_000;
  await h.run();
  assert.equal(h.post.bodies.length, 1, "still inside the 180s cap");
  h.clock.now = later + 180_000;
  await h.run();
  assert.equal(h.post.bodies.length, 2);
  assert.equal(h.post.bodies[1].count, 4);
  assert.deepEqual(
    h.post.bodies[1].message_ids,
    ["C0", "C1", "C2", "C3"].map((key) => sid(false, PEER, key))
  );
});

test("a burst that already failed retries as that burst, and a later message waits for its own window", async (t) => {
  const post = answering(500, 204, 204);
  const h = harness(t, { env: coalesceEnv(1), post, payload: burstPayload });
  const start = h.clock.now;
  messageEvent(h, "A", "one");
  messageEvent(h, "B", "two");
  h.clock.now = start + 1000;
  await h.run();
  assert.deepEqual(h.post.bodies[0].message_ids, [sid(false, PEER, "A"), sid(false, PEER, "B")]);
  assert.equal(state(h, 1).state, "pending");
  h.clock.now = state(h, 1).nextAttemptAt - 500;
  messageEvent(h, "C", "three");
  h.clock.now = state(h, 1).nextAttemptAt;
  await h.run();
  assert.deepEqual(h.post.bodies[1].message_ids, [sid(false, PEER, "A"), sid(false, PEER, "B")]);
  assert.equal(state(h, 3).state, "pending", "the message after the failed POST is not pulled into the retry");
  h.clock.now += 500;
  await h.run();
  assert.equal(h.post.bodies[2].message_id, sid(false, PEER, "C"));
  assert.equal(h.post.bodies[2].count, undefined);
});

test("a burst still open at restart is posted once, after the window, by the next dispatcher", async (t) => {
  const { db, clock } = openTemp();
  const post = answering(204);
  const env = coalesceEnv(1);
  const sink = new WebhookSink(env, { post });
  const host = {
    db: () => (db.isOpen ? db : null),
    sink: () => sink,
    payload: burstPayload,
    awaitingTranscript: () => false,
  };
  const h = { db, clock };
  const first = new WebhookOutbox(host, { now: () => clock.now });
  let second = null;
  t.after(async () => {
    await second?.stop();
    await first.stop();
    if (db.isOpen) db.close();
  });
  const start = clock.now;
  messageEvent(h, "A", "one", { ts: start });
  messageEvent(h, "B", "two", { ts: start });
  first.kick();
  await first.idle();
  assert.equal(post.bodies.length, 0);
  await first.stop();
  second = new WebhookOutbox(host, { now: () => clock.now });
  clock.now = start + 1000;
  second.kick();
  await second.idle();
  assert.equal(post.bodies.length, 1);
  assert.deepEqual(post.bodies[0].message_ids, [sid(false, PEER, "A"), sid(false, PEER, "B")]);
  assert.equal(post.bodies[0].first_timestamp, new Date(start).toISOString());
});

test("a 401 is retried when the setting says so, and fails at once when it does not", async (t) => {
  const refused = harness(t, { post: answering(401) });
  const seq = messageEvent(refused, "NO").seq;
  await refused.run();
  assert.equal(state(refused, seq).state, "failed");
  assert.equal(state(refused, seq).attempts, 1);

  const post = answering(401, 204);
  const retried = harness(t, { env: { ...readyEnv(), WAZAP_WEBHOOK_RETRY_401: "on" }, post });
  const again = messageEvent(retried, "YES").seq;
  await retried.run();
  assert.equal(state(retried, again).state, "pending");
  assert.match(state(retried, again).lastError, /^HTTP 401 from /);
  retried.clock.now = state(retried, again).nextAttemptAt;
  await retried.run();
  assert.equal(state(retried, again).state, "delivered");
  assert.equal(post.bodies.length, 2);
});
