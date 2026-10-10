/**
 * The durable voice-note queue: kept in the account database so a restart
 * resumes it, retried with backoff on the database's clock, given up on with a
 * reason when another attempt cannot help, emptied of notes deleted or expired
 * meanwhile, and served by one worker for the whole process, account by
 * account in turn — with a note that just arrived started at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { accountPaths } from "../dist/config.js";
import { AccountDb, SCHEMA_VERSION } from "../dist/db/index.js";
import { MIGRATIONS } from "../dist/db/schema.js";
import { sqlite } from "../dist/db/sqlite.js";
import { WazapError } from "../dist/errors.js";
import { markFailure } from "../dist/transcribe/failure.js";
import { TranscribeWorker, transcribeWorker } from "../dist/transcribe/worker.js";
import { checkTranscribeQueue, transcriptionStatusLine } from "../dist/transcribe-status.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { PEER, T0, openTemp, sid } from "./db-fixtures.mjs";
import { connectedService, storageRows } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";

const TRANSCRIBE_ENV = [
  "WAZAP_TRANSCRIBE",
  "WAZAP_TRANSCRIBE_API_KEY",
  "WAZAP_TRANSCRIBE_AUTO",
  "WAZAP_TRANSCRIBE_MODEL",
  "WAZAP_TRANSCRIBE_URL",
  "WAZAP_TRANSCRIBE_ALLOW_API",
  "WAZAP_WHISPER_BIN",
  "WAZAP_WHISPER_MODEL",
  "OPENAI_API_KEY",
];
const CONFIGURED = { WAZAP_TRANSCRIBE: "openai", WAZAP_TRANSCRIBE_API_KEY: "sk-test-key" };

// Database level ---------------------------------------------------------------

function voiceRow(key, ts, extra = {}) {
  return {
    chatJid: PEER,
    keyId: key,
    fromMe: false,
    ts,
    type: "voice",
    text: "[voice message · 0:06]",
    raw: new Uint8Array([0x0a, key.length, ...Buffer.from(key)]),
    ...extra,
  };
}

function queuedDb(keys, providerClass = "api") {
  const fixture = openTemp();
  keys.forEach((key, i) => {
    fixture.db.messages.upsert(voiceRow(key, T0 + i * 1000));
    assert.equal(fixture.db.transcripts.enqueue(sid(false, PEER, key), providerClass), true);
  });
  return fixture;
}

test("a note leaves the queue with its transcript, its tombstone, its purge or its deadline", async () => {
  const { db, clock } = queuedDb(["DONE", "GONE", "KEPT", "EXPIRING"]);
  const state = (key) => db.transcripts.state(sid(false, PEER, key));

  db.messages.setTranscript(sid(false, PEER, "DONE"), "gata");
  assert.equal(state("DONE"), null, "a transcript stored by any path takes the note off");

  db.messages.delete(sid(false, PEER, "GONE"), { at: clock.now });
  assert.equal(storageRows({ path: db.path }, "SELECT count(*) AS n FROM transcribe_queue")[0].n, 2, "the tombstone took its row");

  db.messages.setExpiry(sid(false, PEER, "EXPIRING"), clock.now + 1_000);
  clock.now += 2_000;
  const next = db.transcripts.next();
  assert.equal(next.sid, sid(false, PEER, "KEPT"), "the newest note has expired, so it is skipped, not run");
  assert.equal(storageRows({ path: db.path }, "SELECT count(*) AS n FROM transcribe_queue")[0].n, 1, "and leaves on the way");

  await db.messages.clearChat(PEER, clock.now);
  assert.equal(db.transcripts.next(), null, "a cleared chat's notes are not run");
  assert.equal(db.transcripts.stats().queued, 0);
  db.close();
});

test("a note still waiting a day after it was queued is given up on as too_old, and never runs later", () => {
  const { db, clock } = queuedDb(["OLD"]);
  clock.now += 60_000;
  db.messages.upsert(voiceRow("FRESH", clock.now - 1_000));
  db.transcripts.enqueue(sid(false, PEER, "FRESH"), "api");

  clock.now += 24 * 3_600_000 - 60_000;
  const next = db.transcripts.next("api");
  assert.equal(next.sid, sid(false, PEER, "FRESH"), "a minute short of a day, it still runs");
  assert.deepEqual(db.transcripts.state(sid(false, PEER, "OLD")), { state: "failed", attempts: 0, error: "too_old" });
  clock.now += 7 * 24 * 3_600_000;
  assert.equal(db.transcripts.next("local"), null);
  assert.equal(db.transcripts.state(sid(false, PEER, "OLD")).state, "failed", "given up for good, whichever provider asks");
  db.close();
});

test("a note queued for this machine is never handed to an API; a note queued for an API may run locally", () => {
  const { db } = queuedDb(["LOCAL"], "local");
  db.messages.upsert(voiceRow("API", T0 + 10_000));
  db.transcripts.enqueue(sid(false, PEER, "API"), "api");

  assert.equal(db.transcripts.next("api").sid, sid(false, PEER, "API"));
  assert.deepEqual(db.transcripts.state(sid(false, PEER, "LOCAL")), { state: "failed", attempts: 0, error: "provider_changed" });
  db.transcripts.claim(db.transcripts.next("api").id);
  assert.equal(db.transcripts.next("local"), null, "the API note is running; the local one stays given up");

  const local = queuedDb(["V1"], "api");
  assert.equal(local.db.transcripts.next("local").sid, sid(false, PEER, "V1"), "audio meant for an API may stay on this machine");
  db.close();
  local.db.close();
});

test("a run a crash left under way is waiting again after a restart, its attempt counted, and given up at the third", () => {
  const { db, path, clock } = queuedDb(["V1"]);
  const note = sid(false, PEER, "V1");
  const reopen = (current) => {
    current.close();
    return AccountDb.open(path, { now: () => clock.now, checkpointDelayMs: 0 });
  };

  let current = db;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const item = current.transcripts.next();
    assert.equal(current.transcripts.claim(item.id), attempt);
    current = reopen(current);
    assert.equal(current.transcripts.recover(3), 1);
    assert.deepEqual(current.transcripts.state(note), { state: "queued", attempts: attempt, running: false, error: null });
  }
  current.transcripts.claim(current.transcripts.next().id);
  current = reopen(current);
  current.transcripts.recover(3);
  assert.deepEqual(
    current.transcripts.state(note),
    { state: "failed", attempts: 3, error: "interrupted too often" },
    "a note that takes the process down with it cannot loop"
  );
  current.close();
});

test("a note given up on stays given up, with its reason, and is not queued again", () => {
  const { db } = queuedDb(["V1"]);
  const note = sid(false, PEER, "V1");
  const item = db.transcripts.next();
  db.transcripts.claim(item.id);
  db.transcripts.fail(item.id, "media no longer on WhatsApp (HTTP 404)");

  assert.equal(db.transcripts.enqueue(note, "api"), false, "a live re-delivery of the same note does not queue it again");
  assert.equal(db.transcripts.next(), null);
  const stats = db.transcripts.stats();
  assert.equal(stats.queued, 0);
  assert.equal(stats.failed, 1);
  assert.deepEqual(stats.lastError, { reason: "media no longer on WhatsApp (HTTP 404)", at: stats.lastError.at, final: true });
  db.close();
});

// Worker level -----------------------------------------------------------------

function fakeSource(db, name, run, { ready = () => true } = {}) {
  const runs = [];
  return {
    runs,
    source: {
      name,
      db: () => db,
      ready,
      providerClass: () => "api",
      run: async (note) => {
        runs.push(note);
        await run(note);
      },
    },
  };
}

test("a failing note is retried on the database's clock, and gives up after the third attempt", async () => {
  const { db, clock } = queuedDb(["V1"]);
  const worker = new TranscribeWorker({ retryDelaysMs: [10_000, 60_000] });
  const { source, runs } = fakeSource(db, "default", async () => {
    throw new Error("whisper.cpp fell over");
  });
  const realError = console.error;
  console.error = () => {};
  try {
    worker.register(source);
    await worker.idle();
    assert.equal(runs.length, 1);
    assert.equal(db.transcripts.dueIn(), 10_000);

    clock.now += 9_999;
    worker.kick();
    await worker.idle();
    assert.equal(runs.length, 1, "not before its wait is over");

    clock.now += 1;
    worker.kick();
    await worker.idle();
    assert.equal(runs.length, 2);
    assert.equal(db.transcripts.dueIn(), 60_000, "and the second wait is longer");

    clock.now += 60_000;
    worker.kick();
    await worker.idle();
    assert.equal(runs.length, 3);
    assert.deepEqual(db.transcripts.state(sid(false, PEER, "V1")), { state: "failed", attempts: 3, error: "unexpected error" });
    assert.equal(db.transcripts.dueIn(), null);

    clock.now += 3_600_000;
    worker.kick();
    await worker.idle();
    assert.equal(runs.length, 3, "a note given up on is never run again on its own");
  } finally {
    console.error = realError;
    worker.unregister(source);
    db.close();
  }
});

test("a failure another attempt cannot fix gives up at once; one that is not the note's fault spends no attempt", async () => {
  const { db } = queuedDb(["EXPIRED", "WAITS"]);
  const worker = new TranscribeWorker();
  const expired = Object.defineProperty(new WazapError("MEDIA_UNAVAILABLE", "Could not download"), "cause", {
    value: { output: { statusCode: 410 } },
  });
  const { source, runs } = fakeSource(db, "default", async (note) => {
    if (note.endsWith("EXPIRED")) throw expired;
    throw new WazapError("NOT_CONNECTED", "The socket closed.");
  });
  const realError = console.error;
  console.error = () => {};
  try {
    worker.register(source);
    await worker.idle();
    assert.deepEqual(db.transcripts.state(sid(false, PEER, "EXPIRED")), {
      state: "failed",
      attempts: 1,
      error: "media no longer on WhatsApp (HTTP 410)",
    });
    assert.deepEqual(db.transcripts.state(sid(false, PEER, "WAITS")), {
      state: "queued",
      attempts: 0,
      running: false,
      error: "not connected",
    });
    assert.equal(runs.length, 2);
    assert.ok(db.transcripts.dueIn() > 0, "and it waits before it is tried again");
  } finally {
    console.error = realError;
    worker.unregister(source);
    db.close();
  }
});

test("a provider refusing the key pauses the whole worker, longer each time, and one note probes it", async () => {
  const { db } = queuedDb(["V1", "V2", "V3"]);
  let now = 1_000_000;
  const worker = new TranscribeWorker({ now: () => now });
  let refusing = true;
  const { source, runs } = fakeSource(db, "default", async () => {
    if (refusing) throw markFailure(new WazapError("TRANSCRIBE_FAILED", "HTTP 401"), "paused", "provider refused the key (HTTP 401)");
  });
  const realError = console.error;
  console.error = () => {};
  try {
    worker.register(source);
    await worker.idle();
    assert.equal(runs.length, 1, "one note found the key refused; the other two were not downloaded and sent");
    assert.deepEqual(worker.paused(), { reason: "provider refused the key (HTTP 401)", until: now + 30_000 });

    const pauses = [];
    for (let round = 0; round < 7; round++) {
      const { until } = worker.paused();
      now = until - 1;
      worker.kick();
      await worker.idle();
      assert.equal(runs.length, round + 1, "nothing runs before the pause is over, whatever wakes the worker");
      now = until;
      const before = now;
      worker.kick();
      await worker.idle();
      assert.equal(runs.length, round + 2, "once it is over, a single note probes the provider");
      pauses.push((worker.paused().until - before) / 1000);
    }
    assert.deepEqual(pauses, [60, 120, 240, 480, 900, 900, 900], "twice as long each time, up to 15 minutes");
    assert.deepEqual(
      ["V1", "V2", "V3"].map((key) => db.transcripts.state(sid(false, PEER, key)).attempts),
      [0, 0, 0],
      "a refused key is not the notes' fault"
    );

    refusing = false;
    now = worker.paused().until;
    worker.kick();
    await worker.idle();
    assert.equal(worker.paused(), null);
    assert.equal(db.transcripts.stats().queued, 0, "the key works again: every note runs");
  } finally {
    console.error = realError;
    worker.unregister(source);
    db.close();
  }
});

test("a caller waiting on a note is let go when its run cannot go on, and while the worker is paused", async () => {
  const { db } = queuedDb(["WAITS", "PAUSED", "LATER"]);
  const worker = new TranscribeWorker();
  const settledNow = async (promise) => Promise.race([promise.then(() => true), sleep(20).then(() => false)]);
  const { source } = fakeSource(db, "default", async (note) => {
    if (note.endsWith("LATER")) throw new WazapError("NOT_CONNECTED", "The socket closed.");
    throw new WazapError("TRANSCRIBE_UNAVAILABLE", "whisper.cpp not found");
  });
  const realError = console.error;
  console.error = () => {};
  try {
    worker.register(source);
    const waits = worker.settled(source, sid(false, PEER, "LATER"));
    await worker.idle();
    assert.equal(await settledNow(waits), true, "a note its account could not serve leaves its waiter free to post");
    assert.notEqual(worker.paused(), null);
    assert.equal(await settledNow(worker.settled(source, sid(false, PEER, "WAITS"))), true, "no waiter is held while paused");
    assert.equal(db.transcripts.state(sid(false, PEER, "WAITS")).state, "queued", "though the note stays queued");
  } finally {
    console.error = realError;
    worker.unregister(source);
    db.close();
  }
});

test("an hourly round gives up on notes queued a day ago and forgets old failures, even while nothing runs", async () => {
  const { db, clock } = queuedDb(["STALE", "FAILED"]);
  db.transcripts.fail(db.transcripts.next("api").id, "media no longer on WhatsApp (HTTP 404)");
  const worker = new TranscribeWorker({ maintainMs: 10 });
  const { source, runs } = fakeSource(db, "default", async () => {}, { ready: () => false });
  try {
    worker.register(source);
    await worker.idle();
    clock.now += 31 * 24 * 3_600_000;
    await sleep(40);
    assert.equal(runs.length, 0);
    assert.deepEqual(db.transcripts.state(sid(false, PEER, "STALE")), { state: "failed", attempts: 0, error: "too_old" });
    assert.equal(db.transcripts.state(sid(false, PEER, "FAILED")), null, "a failure a month old is forgotten");
  } finally {
    worker.unregister(source);
    db.close();
  }
});

test("an account that is not connected keeps its notes until it is", async () => {
  const { db } = queuedDb(["V1"]);
  const worker = new TranscribeWorker();
  let connected = false;
  const { source, runs } = fakeSource(db, "default", async () => {}, { ready: () => connected });
  try {
    worker.register(source);
    await worker.idle();
    assert.equal(runs.length, 0);
    assert.equal(db.transcripts.stats().queued, 1);

    connected = true;
    worker.kick();
    await worker.idle();
    assert.equal(runs.length, 1);
  } finally {
    worker.unregister(source);
    db.close();
  }
});

test("two accounts share one worker: one note at a time, the accounts in turn", async () => {
  const first = queuedDb(["A1", "A2", "A3"]);
  const second = queuedDb(["B1", "B2", "B3"]);
  const worker = new TranscribeWorker();
  const order = [];
  let running = 0;
  let peak = 0;
  const run = (label) => async (note) => {
    running++;
    peak = Math.max(peak, running);
    order.push(`${label}:${note.split("_").pop()}`);
    await sleep(2);
    running--;
  };
  const a = fakeSource(first.db, "work", run("work"));
  const b = fakeSource(second.db, "home", run("home"));
  try {
    worker.register(a.source);
    worker.register(b.source);
    await worker.idle();
    assert.equal(peak, 1, "a second whisper run would fight the first one for the machine");
    assert.equal(order.length, 6);
    for (let i = 1; i < order.length; i++) {
      assert.notEqual(order[i].split(":")[0], order[i - 1].split(":")[0], `a backlog on one account does not starve the other: ${order}`);
    }
    assert.deepEqual(
      order.filter((entry) => entry.startsWith("work")),
      ["work:A3", "work:A2", "work:A1"],
      "the newest note of an account goes first"
    );
  } finally {
    worker.unregister(a.source);
    worker.unregister(b.source);
    first.db.close();
    second.db.close();
  }
});

// Service level ----------------------------------------------------------------

/** Runs `body` with exactly `env` as the transcription environment, then puts the old one back. */
function withEnv(env, body) {
  const saved = TRANSCRIBE_ENV.map((key) => [key, process.env[key]]);
  for (const key of TRANSCRIBE_ENV) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function serviceWith(env = {}, config = {}) {
  return withEnv(env, () =>
    connectedService(WhatsAppService, {
      prefix: "wazap-transcribe-queue-",
      id: ME,
      name: "Răzvan",
      config: { readOnly: false, persistHistory: true, ...config },
    })
  );
}

/** Both seams: no provider is spawned and no media is fetched; `started` lists the notes in the order their runs began. */
function stub(svc, { text = "am uitat umbrela acasă", delayMs = 1 } = {}) {
  const state = { calls: 0, started: [], running: 0, peak: 0 };
  svc.mediaBuffer = async (_sock, messageId) => {
    state.started.push(messageId.split("_").pop());
    return Buffer.from("not really an ogg file");
  };
  svc.transcriber = async () => {
    state.calls++;
    state.running++;
    state.peak = Math.max(state.peak, state.running);
    await sleep(delayMs);
    state.running--;
    return { text, language: "ro", duration_seconds: 6 };
  };
  return state;
}

const voiceNote = (id, { seconds = 6, at = Date.now(), ptt = true } = {}) => ({
  key: { remoteJid: PEER, fromMe: false, id },
  messageTimestamp: Math.floor(at / 1000),
  message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt, seconds } },
});
const sidOf = (id) => `false_${PEER}_${id}`;
async function waitUntil(condition, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(2);
  }
}
const deliver = (sock, messages) => sock.ev.emit("messages.upsert", { type: "notify", messages });

test("the queue survives a restart: a note that arrived while the account could not run it is transcribed after", async () => {
  const before = serviceWith(CONFIGURED);
  before.svc.status = "disconnected";
  const idle = stub(before.svc);
  deliver(before.sock, [voiceNote("V1")]);
  await before.svc.transcribeIdle();
  assert.equal(idle.calls, 0);
  const status = before.svc.getStatus().transcription;
  assert.deepEqual(status, { auto: "on", queued: 1, running_for_seconds: null, failed: 0, last_error: null, paused: null });
  assert.match(transcriptionStatusLine(status), /voice transcription queue\*\*: 1 waiting/);
  await before.svc.stop();
  const statusChecks = withEnv(CONFIGURED, () => checkTranscribeQueue({ dataDir: before.svc.config.dataDir }));
  assert.deepEqual(statusChecks, [{ name: "voice queue", state: "info", detail: "1 waiting" }], "wazap status reads it with no server running");
  const offChecks = withEnv({}, () => checkTranscribeQueue({ dataDir: before.svc.config.dataDir }));
  assert.equal(offChecks[0].state, "warn", "a queue nothing will run is worth a warning");

  const after = serviceWith(CONFIGURED, { dataDir: before.svc.config.dataDir });
  const provider = stub(after.svc);
  await after.svc.transcribeIdle();
  assert.equal(provider.calls, 1, "the restart found the note where it was");
  assert.equal(after.svc.db.messages.get(sidOf("V1")).transcript, "am uitat umbrela acasă");
  assert.equal(after.svc.getStatus().transcription.queued, 0);
  await after.svc.stop();
});

test("an auto transcript is stored with who made it, and search finds its words", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  stub(svc);
  deliver(sock, [voiceNote("V1", { seconds: 6 })]);
  await svc.transcribeIdle();

  const stored = svc.db.messages.get(sidOf("V1"));
  assert.equal(stored.transcript, "am uitat umbrela acasă");
  assert.equal(stored.transcriptInfo.provider, "openai");
  assert.equal(stored.transcriptInfo.language, "ro");
  assert.equal(stored.transcriptInfo.duration_seconds, 6);
  const hits = (await svc.searchMessages("umbrela", undefined, 10)).data;
  assert.deepEqual(hits.map((view) => view.message_id), [sidOf("V1")]);
  assert.equal(svc.db.transcripts.state(sidOf("V1")), null, "and the note left the queue");
  await svc.stop();
});

test("a voice note deleted while it waits is never transcribed", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  svc.status = "disconnected";
  const provider = stub(svc);
  const at = Date.now() - 60_000;
  const doomed = voiceNote("DOOMED", { at });
  deliver(sock, [doomed, voiceNote("KEPT", { at: at + 1000 })]);
  sock.ev.emit("messages.delete", { keys: [doomed.key] });
  assert.equal(svc.db.transcripts.stats().queued, 1, "the delete took the note off the queue");

  svc.status = "connected";
  svc.voice.transcribeWorker.kick();
  await svc.transcribeIdle();
  assert.deepEqual(provider.started, ["KEPT"]);
  await svc.stop();
});

test("a live note stamped days ago is queued in the transaction that stores it, so a crash right after cannot lose it", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  // Disconnected, so the worker never picks the note up: as if the process died right after the commit.
  svc.status = "disconnected";
  deliver(sock, [voiceNote("LATE", { at: Date.now() - 3 * 86_400_000 })]);
  assert.equal(svc.db.transcripts.state(sidOf("LATE"))?.state, "queued");
  await svc.stop();
});

test("a queue that refuses a note does not hide the note: it is stored, announced and waited for like any other", async () => {
  const { svc } = serviceWith(CONFIGURED);
  svc.status = "disconnected";
  svc.db.transcripts.enqueue = () => {
    throw new Error("disk I/O error");
  };
  const realError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  let stored;
  try {
    stored = svc.ingest.ingestMessages([voiceNote("V1")], true);
  } finally {
    console.error = realError;
  }
  assert.deepEqual(stored.map((raw) => raw.key.id), ["V1"], "what reaches webhooks and waits is the stored note");
  assert.equal(svc.db.messages.get(sidOf("V1")).type, "voice");
  assert.ok(logged.some((line) => /transcribe/.test(line)), "and the refusal is logged as the queue's");
  await svc.stop();
});

test("audio files, long notes and notes of unknown length are never queued", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  svc.status = "disconnected";
  stub(svc);
  const at = Date.now() - 60_000;
  deliver(sock, [
    voiceNote("FILE", { at, ptt: false }),
    voiceNote("LONG", { seconds: 601, at: at + 1000 }),
    { ...voiceNote("NOLENGTH", { at: at + 2000 }), message: { audioMessage: { mimetype: "audio/ogg", ptt: true } } },
    { ...voiceNote("MINE", { at: at + 3000 }), key: { remoteJid: PEER, fromMe: true, id: "MINE" } },
    voiceNote("SHORT", { seconds: 600, at: at + 4000 }),
  ]);
  assert.deepEqual(
    storageRows(svc, "SELECT m.key_id FROM transcribe_queue q JOIN messages m ON m.id = q.message_id").map((row) => row.key_id),
    ["SHORT"]
  );
  await svc.stop();
});

test("WAZAP_TRANSCRIBE_AUTO=0 and no provider queue nothing, and a queue kept while off waits without running", async () => {
  const manual = serviceWith({ ...CONFIGURED, WAZAP_TRANSCRIBE_AUTO: "0" });
  const manualCalls = stub(manual.svc);
  deliver(manual.sock, [voiceNote("M1")]);
  await manual.svc.transcribeIdle();
  assert.equal(manual.svc.db.transcripts.state(sidOf("M1")), null);
  assert.equal(manualCalls.calls, 0);
  assert.equal(manual.svc.getStatus().transcription.auto, "off");
  await manual.svc.stop();

  const queued = serviceWith(CONFIGURED);
  queued.svc.status = "disconnected";
  deliver(queued.sock, [voiceNote("Q1")]);
  await queued.svc.stop();

  const off = serviceWith({}, { dataDir: queued.svc.config.dataDir });
  const offCalls = stub(off.svc);
  deliver(off.sock, [voiceNote("O1")]);
  await off.svc.transcribeIdle();
  assert.equal(offCalls.calls, 0, "switched off, nothing runs");
  assert.equal(off.svc.db.transcripts.state(sidOf("O1")), null, "and nothing new is queued");
  assert.equal(off.svc.db.transcripts.state(sidOf("Q1")).state, "queued", "but the queue is kept for when it is switched on");
  assert.match(transcriptionStatusLine(off.svc.getStatus().transcription), /1 waiting \(automatic transcription is off/);
  await off.svc.stop();
});

test("opening the database recovers a run a crash left marked as started, even where nothing transcribes", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-transcribe-stale-"));
  const path = join(accountPaths(dataDir, "default").root, "wazap.sqlite");
  const crashed = AccountDb.open(path, { checkpointDelayMs: 0 });
  crashed.messages.upsert(voiceRow("V1", Date.now() - 60_000));
  crashed.transcripts.enqueue(sid(false, PEER, "V1"), "api");
  crashed.transcripts.claim(crashed.transcripts.next("api").id);
  crashed.close();

  const { svc } = serviceWith({}, { dataDir });
  assert.deepEqual(svc.db.transcripts.state(sid(false, PEER, "V1")), { state: "queued", attempts: 1, running: false, error: null });
  assert.equal(svc.getStatus().transcription.running_for_seconds, null, "status reports no run that is not happening");
  await svc.stop();
});

test("wazap status warns that a read-only account's queue never runs with an API provider", async () => {
  const queued = serviceWith(CONFIGURED);
  queued.svc.status = "disconnected";
  deliver(queued.sock, [voiceNote("V1")]);
  await queued.svc.stop();

  const checks = withEnv(CONFIGURED, () => checkTranscribeQueue({ dataDir: queued.svc.config.dataDir, readOnly: true, rateLimitPerMinute: 20 }));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].state, "warn");
  assert.match(checks[0].detail, /read-only/);
  assert.match(checks[0].fix, /WAZAP_TRANSCRIBE_ALLOW_API=1/);
});

test("status recognizes separately approved API processing on a read-only account", async () => {
  const queued = serviceWith(CONFIGURED);
  queued.svc.status = "disconnected";
  deliver(queued.sock, [voiceNote("OPT_STATUS")]);
  await queued.svc.stop();
  const checks = withEnv({ ...CONFIGURED, WAZAP_TRANSCRIBE_ALLOW_API: "1", WAZAP_TRANSCRIBE_AUTO: "1" },
    () => checkTranscribeQueue({ dataDir: queued.svc.config.dataDir, readOnly: true, rateLimitPerMinute: 20 }));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].state, "info");
  assert.doesNotMatch(checks[0].detail, /read-only|never runs|waits/);
});

test("a note waiting for its account runs as soon as the connection opens, not at the next poll", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  svc.status = "disconnected";
  const provider = stub(svc);
  deliver(sock, [voiceNote("V1")]);
  await svc.transcribeIdle();
  assert.equal(provider.calls, 0);

  svc.setStatus("connected");
  await waitUntil(() => svc.db.messages.get(sidOf("V1")).transcript !== null, 1_000);
  assert.equal(provider.calls, 1);
  await svc.stop();
});

test("a short-lived command queues arriving notes but leaves transcribing them to the server", async () => {
  const queued = serviceWith(CONFIGURED);
  queued.svc.status = "disconnected";
  deliver(queued.sock, [voiceNote("V1")]);
  await queued.svc.stop();

  const live = serviceWith(CONFIGURED, { dataDir: queued.svc.config.dataDir, command: "status" });
  const provider = stub(live.svc);
  deliver(live.sock, [voiceNote("V2")]);
  await live.svc.transcribeIdle();
  assert.equal(provider.calls, 0, "`wazap status --live` or `contacts resync` must not work through the backlog");
  assert.equal(live.svc.db.transcripts.stats().queued, 2, "the notes wait for the server");
  await live.svc.stop();
});

test("a note queued for local transcription is given up, not uploaded, once the provider is an API", async () => {
  const local = serviceWith({ WAZAP_TRANSCRIBE: "local" });
  local.svc.status = "disconnected";
  deliver(local.sock, [voiceNote("V1")]);
  assert.equal(local.svc.db.transcripts.state(sidOf("V1")).state, "queued");
  await local.svc.stop();

  const api = serviceWith(CONFIGURED, { dataDir: local.svc.config.dataDir });
  const provider = stub(api.svc);
  await api.svc.transcribeIdle();
  assert.equal(provider.calls, 0, "audio the user meant to keep on this machine never leaves it");
  assert.deepEqual(api.svc.db.transcripts.state(sidOf("V1")), { state: "failed", attempts: 0, error: "provider_changed" });
  await api.svc.stop();
});

test("a note queued for an API is transcribed locally once the provider is local", async () => {
  const api = serviceWith(CONFIGURED);
  api.svc.status = "disconnected";
  deliver(api.sock, [voiceNote("V1")]);
  await api.svc.stop();

  const local = serviceWith({ WAZAP_TRANSCRIBE: "local" }, { dataDir: api.svc.config.dataDir });
  local.svc.transcribeReadiness = async () => ({ ok: true, detail: "whisper.cpp, stubbed" });
  stub(local.svc);
  await local.svc.transcribeIdle();
  assert.equal(local.svc.db.messages.get(sidOf("V1")).transcriptInfo.provider, "local");
  await local.svc.stop();
});

test("a stop in the middle of a transcription keeps the transcript it paid for, and does not upload it again", async () => {
  const before = serviceWith(CONFIGURED);
  const provider = stub(before.svc, { delayMs: 150 });
  deliver(before.sock, [voiceNote("V1")]);
  await waitUntil(() => provider.calls === 1);
  await before.svc.stop();

  const after = serviceWith(CONFIGURED, { dataDir: before.svc.config.dataDir });
  const again = stub(after.svc);
  await after.svc.transcribeIdle();
  assert.equal(after.svc.db.messages.get(sidOf("V1")).transcript, "am uitat umbrela acasă", "the stop waited for the answer");
  assert.equal(again.calls, 0, "so the restart has nothing to send");
  await after.svc.stop();
});

test("removing an account cancels its transcription under way instead of waiting for it, and the note keeps its attempt", async () => {
  const before = serviceWith(CONFIGURED);
  before.svc.mediaBuffer = async () => Buffer.from("not really an ogg file");
  let calls = 0;
  before.svc.transcriber = (_settings, _file, opts) =>
    new Promise((_resolve, reject) => {
      calls++;
      opts.signal.addEventListener("abort", () => reject(markFailure(new WazapError("TRANSCRIBE_FAILED", "cancelled"), "waiting", "stopping")));
    });
  deliver(before.sock, [voiceNote("V1")]);
  await waitUntil(() => calls === 1);
  const started = Date.now();
  before.svc.abortTranscription();
  await before.svc.stop();
  assert.ok(Date.now() - started < 2_000, "the stop did not wait out the run");

  const after = serviceWith({}, { dataDir: before.svc.config.dataDir });
  assert.deepEqual(after.svc.db.transcripts.state(sidOf("V1")), { state: "queued", attempts: 0, running: false, error: null });
  await after.svc.stop();
});

test("a voice note that just arrived starts at once, ahead of a history backlog", async (t) => {
  const { svc, sock } = serviceWith(CONFIGURED);
  svc.status = "disconnected";
  const provider = stub(svc);
  const now = Date.now();
  sock.ev.emit("messaging-history.set", {
    chats: [],
    contacts: [],
    messages: [1, 2, 3, 4].map((n) => voiceNote(`H${n}`, { at: now - n * 3_600_000 })),
    isLatest: true,
  });
  await svc.ingest.historyIdle();
  assert.equal(svc.db.transcripts.stats().queued, 4);
  await sleep(5);

  svc.status = "connected";
  const deliveredAt = performance.now();
  let startedAt = null;
  let storedAt = null;
  const seam = svc.mediaBuffer;
  svc.mediaBuffer = async (...args) => {
    startedAt ??= performance.now();
    return seam(...args);
  };
  deliver(sock, [voiceNote("LIVE")]);
  const waited = svc.voice.transcribeWorker.settled(svc.voice.transcribeSource, sidOf("LIVE")).then(() => {
    storedAt = performance.now();
  });
  await waited;
  await svc.transcribeIdle();

  assert.equal(provider.started[0], "LIVE", "the note someone just sent is not held behind yesterday's");
  assert.deepEqual(provider.started.slice(1), ["H1", "H2", "H3", "H4"], "and the backlog follows, newest first");
  assert.equal(provider.calls, 5);
  const toStart = startedAt - deliveredAt;
  const toTranscript = storedAt - deliveredAt;
  t.diagnostic(`time to start: ${toStart.toFixed(1)} ms; time to transcript with a stub provider: ${toTranscript.toFixed(1)} ms`);
  assert.ok(toStart < 250, `the run started ${toStart} ms after the note arrived`);
  assert.ok(toTranscript < 1_000, `the transcript was stored ${toTranscript} ms after the note arrived`);
  await svc.stop();
});

test("the shared worker is the one every service uses", () => {
  const { svc } = serviceWith(CONFIGURED);
  assert.equal(svc.voice.transcribeWorker, transcribeWorker);
  return svc.stop();
});

// Migration -------------------------------------------------------------------

/**
 * A database exactly as a build of schema `version` left it — 1 is 0.22.0's,
 * 2 the one with idempotent sends — holding voice notes that were never
 * transcribed: written through those migrations' own SQL, not through this
 * build's API.
 */
function writeAtVersion(path, version, notes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("BEGIN IMMEDIATE");
    const now = String(Date.now());
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= version)) {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(`migrated_v${migration.version}`, now);
    }
    db.prepare("INSERT INTO meta(key, value) VALUES ('created_at', ?), ('import_state', 'done')").run(now);
    db.prepare("INSERT INTO chats(id, jid, kind) VALUES (1, ?, 'direct')").run(PEER);
    const insert = db.prepare("INSERT INTO messages(id, chat_id, key_id, from_me, ts, type, text) VALUES (?, 1, ?, 0, ?, 'voice', ?)");
    notes.forEach(([key, ts]) => insert.run(Math.floor(ts / 1000) * 1048576, key, ts, "[voice message · 0:06]"));
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

for (const from of [1, 2]) {
  test(`a v${from} database holding voice notes upgrades to v3 with an empty queue`, () => {
    assert.ok(SCHEMA_VERSION >= 3);
    const now = Date.now();
    const direct = openTemp();
    direct.db.close();
    const path = `${direct.path}.v${from}`;
    writeAtVersion(path, from, [["OLD1", now - 3_600_000], ["OLD2", now - 60_000]]);
    const upgraded = AccountDb.open(path, { checkpointDelayMs: 0 });
    assert.equal(upgraded.schemaVersion, SCHEMA_VERSION);
    assert.ok(upgraded.getMeta("migrated_v3") !== null);
    assert.deepEqual(upgraded.transcripts.stats(), { queued: 0, startedAt: null, failed: 0, lastError: null }, "no backfill");
    assert.equal(upgraded.messages.get(sid(false, PEER, "OLD2")).type, "voice", "the notes themselves came through");
    assert.equal(upgraded.transcripts.enqueue(sid(false, PEER, "OLD2"), "api"), true, "and the queue works on the upgraded file");
    upgraded.close();
  });
}

test("a service on a v2 database upgraded to v3 transcribes nothing stored before, and new notes as usual", async () => {
  const now = Date.now();
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-transcribe-v2-"));
  writeAtVersion(join(accountPaths(dataDir, "default").root, "wazap.sqlite"), 2, [["OLD1", now - 3_600_000], ["OLD2", now - 60_000]]);
  const { svc, sock } = serviceWith(CONFIGURED, { dataDir });
  const provider = stub(svc);
  await svc.transcribeIdle();
  assert.equal(svc.db.schemaVersion, SCHEMA_VERSION);
  assert.equal(provider.calls, 0, "nothing stored before the upgrade is transcribed on its own");
  deliver(sock, [voiceNote("NEW")]);
  await svc.transcribeIdle();
  assert.deepEqual(provider.started, ["NEW"], "a note that arrives after it is");
  assert.equal(svc.db.messages.get(sidOf("NEW")).transcript, "am uitat umbrela acasă");
  await svc.stop();
});

test("with transcription on this machine the user's own voice notes are queued too", async () => {
  const { svc, sock } = serviceWith({ WAZAP_TRANSCRIBE: "local" });
  svc.status = "disconnected";
  deliver(sock, [voiceNote("THEIRS"), { ...voiceNote("MINE"), key: { remoteJid: PEER, fromMe: true, id: "MINE" } }]);
  assert.deepEqual(
    storageRows(svc, "SELECT m.key_id FROM transcribe_queue q JOIN messages m ON m.id = q.message_id ORDER BY m.key_id").map((row) => row.key_id),
    ["MINE", "THEIRS"],
    "free to run, so no reason to leave the user's own words out"
  );
  await svc.stop();
});

test("with transcription on this machine, notes stored without a transcript are queued once the account connects", async () => {
  const { svc, sock } = serviceWith({ WAZAP_TRANSCRIBE: "local" });
  svc.transcribeReadiness = async () => ({ ok: true, detail: "whisper.cpp, stubbed" });
  svc.status = "disconnected";
  const provider = stub(svc);
  // A history sync brings notes older than a day: on arrival they are stored, not queued.
  const old = Date.now() - 30 * 86_400_000;
  sock.ev.emit("messaging-history.set", {
    chats: [],
    contacts: [],
    messages: [voiceNote("OLD1", { at: old }), { ...voiceNote("OLD2", { at: old + 60_000 }), key: { remoteJid: PEER, fromMe: true, id: "OLD2" } }],
    isLatest: true,
  });
  await waitUntil(() => svc.db.messages.get(sidOf("OLD1")) !== null);
  assert.equal(storageRows(svc, "SELECT count(*) AS n FROM transcribe_queue")[0].n, 0);

  svc.setStatus("connected");
  await waitUntil(() => svc.db.messages.get(sidOf("OLD1")).transcript !== null, 2_000);
  assert.deepEqual(provider.started, ["OLD2", "OLD1"], "newest first, the user's own among them");
  assert.equal(svc.db.messages.get(sidOf("OLD1")).transcript, "am uitat umbrela acasă");
  svc.setStatus("disconnected");
  svc.setStatus("connected");
  await svc.transcribeIdle();
  assert.equal(provider.calls, 2, "a note with its transcript is not queued again");
  await svc.stop();
});

test("with a billed provider, notes stored without a transcript stay off the queue when the account connects", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  svc.status = "disconnected";
  const provider = stub(svc);
  sock.ev.emit("messaging-history.set", { chats: [], contacts: [], messages: [voiceNote("OLD1", { at: Date.now() - 30 * 86_400_000 })], isLatest: true });
  await waitUntil(() => svc.db.messages.get(sidOf("OLD1")) !== null);
  svc.setStatus("connected");
  await svc.transcribeIdle();
  assert.equal(provider.calls, 0);
  await svc.stop();
});


const OWN_AUTO = { ...CONFIGURED, WAZAP_TRANSCRIBE_ALLOW_API: "1", WAZAP_TRANSCRIBE_AUTO: "on" };
const ownVoice = (id, options = {}, peer = PEER) => ({ ...voiceNote(id, options), key: { remoteJid: peer, fromMe: true, id } });

test("explicit own API AUTO transcribes new outgoing and self-chat notes once with incoming notes", async () => {
  const { svc, sock } = serviceWith(OWN_AUTO, { readOnly: true });
  const provider = stub(svc);
  try {
    const mine = ownVoice("OWN_NEW");
    deliver(sock, [voiceNote("IN_NEW"), mine, ownVoice("SELF_NEW", {}, ME)]);
    deliver(sock, [mine]);
    await svc.transcribeIdle();
    assert.equal(provider.calls, 3);
    assert.equal(svc.db.messages.get(sid(true, PEER, "OWN_NEW")).transcript, "am uitat umbrela acasă");
    assert.equal(svc.db.messages.get(sid(true, ME, "SELF_NEW")).transcript, "am uitat umbrela acasă");
    deliver(sock, [mine]);
    await svc.transcribeIdle();
    assert.equal(provider.calls, 3, "replayed notes with a transcript are not uploaded again");
    assert.equal(svc.config.readOnly, true);
  } finally { await svc.stop(); }
});

test("own API AUTO remains off by default and does not override AUTO or API permission", async () => {
  for (const env of [
    { ...CONFIGURED, WAZAP_TRANSCRIBE_ALLOW_API: "1", WAZAP_TRANSCRIBE_AUTO: "1" },
    { ...OWN_AUTO, WAZAP_TRANSCRIBE_AUTO: "0" },
    { ...OWN_AUTO, WAZAP_TRANSCRIBE_ALLOW_API: "0" },
  ]) {
    const { svc, sock } = serviceWith(env, { readOnly: true });
    const provider = stub(svc);
    try {
      deliver(sock, [ownVoice("OWN_GATED")]);
      await svc.transcribeIdle();
      assert.equal(provider.calls, 0);
      assert.equal(svc.db.transcripts.state(sid(true, PEER, "OWN_GATED")), null);
    } finally { await svc.stop(); }
  }
});

test("own API AUTO preserves duration guards and never enrolls history, old live replays or backfill", async () => {
  const { svc, sock } = serviceWith(OWN_AUTO, { readOnly: true });
  svc.status = "disconnected";
  const provider = stub(svc);
  try {
    const unknown = ownVoice("OWN_UNKNOWN");
    delete unknown.message.audioMessage.seconds;
    deliver(sock, [ownVoice("OWN_LONG", { seconds: 601 }), ownVoice("OWN_AUDIO", { ptt: false }), unknown,
      ownVoice("OWN_OLD_LIVE", { at: Date.now() - 60_000 }), ownVoice("OWN_BOUNDARY", { seconds: 600 })]);
    svc.ingest.ingestMessages([ownVoice("OWN_RECENT_HISTORY"), ownVoice("OWN_ARCHIVE", { at: Date.now() - 30 * 86_400_000 })], false);
    svc.voice.backfillTranscripts();
    const queued = storageRows(svc, "SELECT m.key_id FROM transcribe_queue q JOIN messages m ON m.id = q.message_id").map(r => r.key_id);
    assert.deepEqual(queued, ["OWN_BOUNDARY"]);
    svc.status = "connected";
    svc.voice.transcribeWorker.kick();
    await svc.transcribeIdle();
    assert.equal(provider.calls, 1);
  } finally { await svc.stop(); }
});

test("a stored outgoing note delivered again live does not become a new paid AUTO upload", async () => {
  const { svc, sock } = serviceWith(OWN_AUTO, { readOnly: true });
  const provider = stub(svc);
  try {
    const replay = ownVoice("OWN_STORED");
    svc.ingest.ingestMessages([replay], false);
    replay.message.audioMessage.seconds = 7;
    deliver(sock, [replay]);
    await svc.transcribeIdle();
    assert.equal(provider.calls, 0);
    assert.equal(svc.db.transcripts.state(sid(true, PEER, "OWN_STORED")), null);
  } finally { await svc.stop(); }
});


test("own API AUTO refuses unknown creation times and honors the startup-second boundary", async () => {
  const { svc } = serviceWith(OWN_AUTO, { readOnly: true });
  svc.status = "disconnected";
  try {
    for (const [id, timestamp] of [["OWN_MISSING_STAMP", undefined], ["OWN_NAN_STAMP", NaN]]) {
      const raw = ownVoice(id);
      svc.ingest.ingestMessages([raw], false);
      raw.messageTimestamp = timestamp;
      const messageId = sid(true, PEER, id);
      svc.voice.queueTranscript(raw, { sid: messageId, outcome: "inserted" }, true);
      assert.equal(svc.db.transcripts.state(messageId), null, "unknown timestamp must not authorize a paid upload");
    }
    const boundary = ownVoice("OWN_START_BOUNDARY", { at: svc.voice.ownAutoSince });
    svc.ingest.ingestMessages([boundary], true);
    assert.equal(svc.db.transcripts.state(sid(true, PEER, "OWN_START_BOUNDARY"))?.state, "queued");
  } finally { await svc.stop(); }
});

test("own API permission is still mandatory in writable mode", async () => {
  const { svc, sock } = serviceWith({ ...OWN_AUTO, WAZAP_TRANSCRIBE_ALLOW_API: "0" });
  const provider = stub(svc);
  try {
    deliver(sock, [ownVoice("OWN_WRITABLE_DENIED")]);
    await svc.transcribeIdle();
    assert.equal(provider.calls, 0);
  } finally { await svc.stop(); }
});

test("approved own API queue resumes after restart but revoked permission and local queues never upload", async () => {
  for (const variant of ["resume", "revoked", "local_to_api"]) {
    const initial = serviceWith(variant === "local_to_api" ? { WAZAP_TRANSCRIBE: "local" } : OWN_AUTO, { readOnly: true });
    initial.svc.status = "disconnected";
    deliver(initial.sock, [ownVoice("OWN_RESTART")]);
    const noteId = sid(true, PEER, "OWN_RESTART");
    assert.equal(initial.svc.db.transcripts.state(noteId)?.state, "queued");
    await initial.svc.stop();
    if (variant === "resume") await sleep(1100);
    const next = serviceWith(variant === "revoked" ? { ...OWN_AUTO, WAZAP_TRANSCRIBE_AUTO: "auto" } : OWN_AUTO,
      { readOnly: true, dataDir: initial.svc.config.dataDir });
    const provider = stub(next.svc);
    try {
      await next.svc.transcribeIdle();
      assert.equal(provider.calls, variant === "resume" ? 1 : 0);
      if (variant === "resume") assert.ok(next.svc.db.messages.get(noteId).transcript);
      else if (variant === "revoked") assert.equal(next.svc.db.transcripts.state(noteId), null);
      else assert.equal(next.svc.db.transcripts.state(noteId)?.state, "failed");
      if (variant === "local_to_api") assert.equal(next.svc.db.transcripts.state(noteId)?.error, "provider_changed");
    } finally { await next.svc.stop(); }
  }
});
