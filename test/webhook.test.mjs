/**
 * W1 outbound webhook: config validation, the three events and the payload they
 * carry, HMAC of the raw body, what the service queues in its outbox and posts,
 * a failed POST that must not take down the WhatsApp path, and the counters
 * status and doctor read. The dispatcher on its own is webhook-outbox.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { parse } from "dotenv";
import { DisconnectReason, proto } from "baileys";

import { renderGetStatus } from "../dist/account-resolve.js";
import { AccountRegistry } from "../dist/accounts.js";
import { accountPaths } from "../dist/config.js";
import { AccountDb } from "../dist/db/index.js";
import { webhookCheck } from "../dist/doctor.js";
import { SentIds } from "../dist/sent-ids.js";
import { MESSAGE_TYPES } from "../dist/wa-types.js";
import {
  WEBHOOK_EVENTS,
  WEBHOOK_KINDS,
  WEBHOOK_TEXT_MAX,
  WebhookSink,
  asWebhookPayload,
  previewText,
  readWebhookSettings,
  requireWebhookUrl,
  webhookConnectionStatus,
  webhookKind,
  webhookSignature,
  webhookSignatureMatches,
} from "../dist/webhook.js";
import { WazapError } from "../dist/errors.js";
import { markFailure } from "../dist/transcribe/failure.js";
import { transcribeWorker } from "../dist/transcribe/worker.js";
import { WebhookOutbox } from "../dist/webhook-outbox.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import {
  connectedService,
  fakeSocket,
  offlineConfig,
  openService,
  storageRows,
  stubAccountSource,
  waitFor,
} from "./helpers.mjs";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const SECRET = "webhook-test-secret";
const WEBHOOK_KEYS = [
  "WAZAP_WEBHOOK",
  "WAZAP_WEBHOOK_URL",
  "WAZAP_WEBHOOK_SECRET",
  "WAZAP_WEBHOOK_EVENTS",
  "WAZAP_WEBHOOK_AUTH",
  "WAZAP_WEBHOOK_CHATS",
  "WAZAP_WEBHOOK_TAG",
  "WAZAP_WEBHOOK_COALESCE",
  "WAZAP_WEBHOOK_RETRY_401",
];

function dataDir() {
  return mkdtempSync(join(tmpdir(), "wazap-webhook-"), { mode: 0o700 });
}

function childEnv(extra = {}) {
  const env = { ...process.env, WAZAP_NO_UPDATE_CHECK: "1", WAZAP_TRANSCRIBE: "off" };
  for (const key of WEBHOOK_KEYS) delete env[key];
  return { ...env, ...extra };
}

function status(dir, args = [], env = {}) {
  return run(process.execPath, [binary, "status", "--data-dir", dir, ...args], { env: childEnv(env) });
}

function wazap(dir, args, { input = "", env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args, "--data-dir", dir], { env: childEnv(env) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

function textMessage(id, body, at = Date.now()) {
  return {
    key: { remoteJid: PEER, fromMe: false, id },
    messageTimestamp: Math.floor(at / 1000),
    message: { conversation: body },
  };
}

/** What another linked device, or wazap itself, sends: the same chat, `fromMe`. */
function ownMessage(id, body, { chat = PEER, at = Date.now() } = {}) {
  return {
    key: { remoteJid: chat, fromMe: true, id },
    messageTimestamp: Math.floor(at / 1000),
    message: { conversation: body },
  };
}

function voiceNote(id, seconds, at = Date.now(), chat = PEER) {
  return {
    key: { remoteJid: chat, fromMe: false, id },
    messageTimestamp: Math.floor(at / 1000),
    message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true, seconds } },
  };
}

/** The close Baileys reports, carrying the status code the handler reads. */
const closedWith = (statusCode) => ({
  connection: "close",
  lastDisconnect: { error: { message: "Connection Terminated", output: { statusCode } } },
});

/** Point the in-process sink at `url`, and hand back the restore the test owes. */
function saveWebhookEnv(url, events) {
  const saved = WEBHOOK_KEYS.map((key) => [key, process.env[key]]);
  for (const key of WEBHOOK_KEYS) delete process.env[key];
  Object.assign(process.env, readyEnv(url, events));
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * The transcription environment is read in the constructor, so it is set around
 * that call and put straight back. The openai provider is the one whose
 * readiness is a key, which keeps whisper.cpp and its model out of this file.
 */
function transcribingService(prefix, config = {}) {
  const keys = ["WAZAP_TRANSCRIBE", "WAZAP_TRANSCRIBE_API_KEY", "WAZAP_TRANSCRIBE_AUTO"];
  const saved = keys.map((key) => [key, process.env[key]]);
  Object.assign(process.env, {
    WAZAP_TRANSCRIBE: "openai",
    WAZAP_TRANSCRIBE_API_KEY: "sk-test-key",
    WAZAP_TRANSCRIBE_AUTO: "1",
  });
  try {
    const connected = connectedService(WhatsAppService, { prefix, id: ME, name: "Răzvan", config: { readOnly: false, ...config } });
    // Only the worker's word may end an event's wait for its transcript, never a look at the clock.
    connected.svc.outbox.transcriptPollMs = 60_000;
    return connected;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function samplePayload(overrides = {}) {
  return {
    event: "message_received",
    from: PEER,
    contact_id: 1,
    phone: "+40700000002",
    chat_id: PEER,
    ts: "2026-09-08T14:00:00+00:00",
    timestamp: "2026-09-08T14:00:00.000Z",
    text: "salut",
    truncated: false,
    kind: "text",
    from_me: false,
    is_self_chat: false,
    message_id: "false_40700000002@s.whatsapp.net_ABC",
    account_id: "default",
    account_name: "default",
    ...overrides,
  };
}

function readyEnv(url, events) {
  const env = { WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_URL: url, WAZAP_WEBHOOK_SECRET: SECRET };
  return events === undefined ? env : { ...env, WAZAP_WEBHOOK_EVENTS: events };
}

/** The account's outbox rows, oldest first. */
function outboxRows(svc) {
  return storageRows(svc, "SELECT seq, kind, state, attempts, last_status, last_error FROM events ORDER BY seq");
}

/** A receiver that records each body and answers what `answer` says, 204 by default. */
async function recorder(answer = () => 204) {
  const received = [];
  const server = await listen(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    received.push(body);
    res.writeHead(answer(body, received.length));
    res.end();
  });
  return { ...server, received };
}

test("webhook is off unless WAZAP_WEBHOOK is an on-value", () => {
  assert.equal(readWebhookSettings({}).kind, "off");
  assert.equal(readWebhookSettings({ WAZAP_WEBHOOK: "off" }).kind, "off");
  assert.equal(readWebhookSettings({ WAZAP_WEBHOOK: "0" }).kind, "off");
  assert.equal(readWebhookSettings({ WAZAP_WEBHOOK: "on" }).kind, "invalid");
});

test("on without a URL or secret is invalid, and names what is missing", () => {
  const both = readWebhookSettings({ WAZAP_WEBHOOK: "on" });
  assert.equal(both.kind, "invalid");
  assert.match(both.detail, /URL or a secret/);
  assert.match(both.fix, /wazap config webhook on/);

  const noUrl = readWebhookSettings({ WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_SECRET: SECRET });
  assert.equal(noUrl.kind, "invalid");
  assert.match(noUrl.detail, /without a URL/);

  const noSecret = readWebhookSettings({ WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_URL: "https://hooks.example/wazap" });
  assert.equal(noSecret.kind, "invalid");
  assert.match(noSecret.detail, /without a secret/);
});

test("an account webhook_url and webhook_secret win over the environment", () => {
  const settings = readWebhookSettings(readyEnv("https://hooks.example/global"), {
    url: "https://hooks.example/work///",
    secret: "  work-secret  ",
  });
  assert.deepEqual(settings, {
    kind: "ready",
    url: "https://hooks.example/work",
    secret: "work-secret",
    events: ["message_received"],
    filter: null,
    coalesce: null,
    retryUnauthorized: false,
  });
});

test("an account webhook_events wins over the environment, in canonical order", () => {
  const settings = readWebhookSettings(readyEnv("https://hooks.example/global", "all"), {
    events: "  connection , MESSAGE_RECEIVED , connection  ",
  });
  assert.deepEqual(settings, {
    kind: "ready",
    url: "https://hooks.example/global",
    secret: SECRET,
    events: ["message_received", "connection"],
    filter: null,
    coalesce: null,
    retryUnauthorized: false,
  });
});

test("an unknown webhook event is invalid rather than silently dropped", () => {
  const settings = readWebhookSettings(readyEnv("https://hooks.example/wazap", "message_received,message_recieved"));
  assert.equal(settings.kind, "invalid");
  assert.match(settings.detail, /message_recieved/);
  assert.match(settings.fix, /WAZAP_WEBHOOK_EVENTS/);
});

test("an account can override only the URL and still use the global secret", () => {
  const settings = readWebhookSettings(readyEnv("https://hooks.example/global"), {
    url: "http://127.0.0.1:9/work",
  });
  assert.deepEqual(settings, {
    kind: "ready",
    url: "http://127.0.0.1:9/work",
    secret: SECRET,
    events: ["message_received"],
    filter: null,
    coalesce: null,
    retryUnauthorized: false,
  });
});

test("asWebhookPayload names the account", () => {
  const payload = asWebhookPayload({
    event: "message_received",
    view: {
      message_id: "false_40700000002@s.whatsapp.net_ABC",
      chat_id: PEER,
      from_me: false,
      timestamp: "2026-09-08T14:00:00+00:00",
      type: "text",
      text: "salut",
      sender: { id: PEER, phone: "40700000002" },
    },
    account: { id: "work", name: "Work" },
    isSelfChat: false,
  });
  assert.equal(payload.account_id, "work");
  assert.equal(payload.account_name, "Work");
  assert.equal(payload.event, "message_received");
  assert.equal(payload.text, "salut");
  assert.equal(payload.phone, "+40700000002", "the sender's number in E.164");
  assert.equal(payload.contact_id, null, "a view without a stored contact names none");
});

test("an audio payload carries the transcription instead of the placeholder", () => {
  const payload = asWebhookPayload({
    event: "message_received",
    view: {
      message_id: "false_40700000002@s.whatsapp.net_V1",
      chat_id: PEER,
      from_me: false,
      timestamp: "2026-09-08T14:00:00+00:00",
      type: "voice",
      text: '[voice message · 0:06] "am uitat umbrela acasă"',
      transcript: "am uitat umbrela acasă",
      sender: { id: PEER, phone: "40700000002" },
    },
    account: { id: "default", name: "default" },
    isSelfChat: false,
  });
  assert.equal(payload.text, "am uitat umbrela acasă");
  assert.equal(payload.kind, "audio");
  assert.equal(payload.truncated, false);
});

/**
 * The instant is the sender's to state, and `messageTimestamp` is a protobuf field
 * nobody bounds, so a junk one must cost one field and not the delivery.
 */
test("an unparseable ts falls back to now instead of throwing the event away", () => {
  const payload = asWebhookPayload({
    event: "message_received",
    view: {
      message_id: "false_40700000002@s.whatsapp.net_JUNK",
      chat_id: PEER,
      from_me: false,
      timestamp: "NaN-NaN-NaNTNaN:NaN:NaN+NaN:NaN",
      type: "text",
      text: "salut",
      sender: { id: PEER, phone: "40700000002" },
    },
    account: { id: "default", name: "default" },
    isSelfChat: false,
  });
  assert.equal(payload.ts, "NaN-NaN-NaNTNaN:NaN:NaN+NaN:NaN", "what the peer said is still reported");
  assert.match(payload.timestamp, /Z$/);
  assert.ok(Number.isFinite(Date.parse(payload.timestamp)));
  assert.equal(payload.text, "salut");
});

test("webhookKind gives every message type a bucket, and both audio types the same one", () => {
  const kinds = new Set(WEBHOOK_KINDS);
  for (const type of MESSAGE_TYPES) {
    assert.ok(kinds.has(webhookKind(type)), `${type} has no webhook kind`);
  }
  assert.equal(webhookKind("text"), "text");
  assert.equal(webhookKind("image"), "image");
  assert.equal(webhookKind("voice"), "audio", "a recorded note");
  assert.equal(webhookKind("audio"), "audio", "an attached file");
  assert.equal(webhookKind("video"), "other");
  assert.equal(webhookKind("unknown"), "other");
});

test("webhookConnectionStatus maps only what a consumer can act on", () => {
  assert.equal(webhookConnectionStatus("connected"), "linked");
  assert.equal(webhookConnectionStatus("disconnected"), "disconnected");
  assert.equal(webhookConnectionStatus("logged_out"), "expired");
  assert.equal(webhookConnectionStatus("session_corrupt"), "expired");
  assert.equal(webhookConnectionStatus("auth_failure"), "expired");
  for (const transient of ["not_linked", "linking", "connecting"]) {
    assert.equal(webhookConnectionStatus(transient), null, `${transient} is nothing to announce`);
  }
});

test("SentIds remembers an id until its ttl runs out, then forgets it", () => {
  let now = 1_000;
  const ids = new SentIds({ ttlMs: 60_000, now: () => now });
  ids.note("true_40700000002@s.whatsapp.net_OWN");
  assert.equal(ids.has("true_40700000002@s.whatsapp.net_OWN"), true);
  assert.equal(ids.size, 1);
  now += 59_000;
  assert.equal(ids.has("true_40700000002@s.whatsapp.net_OWN"), true, "an echo can take a while to come back");
  now += 2_000;
  assert.equal(ids.has("true_40700000002@s.whatsapp.net_OWN"), false);
  assert.equal(ids.size, 0, "nothing is left for a long-running service to carry");
});

test("on with a URL and a secret is ready, and a trailing slash is stripped", () => {
  const settings = readWebhookSettings({
    WAZAP_WEBHOOK: "yes",
    WAZAP_WEBHOOK_URL: "https://hooks.example/wazap///",
    WAZAP_WEBHOOK_SECRET: `  "${SECRET}"  `,
  });
  assert.deepEqual(settings, {
    kind: "ready",
    url: "https://hooks.example/wazap",
    secret: SECRET,
    events: ["message_received"],
    filter: null,
    coalesce: null,
    retryUnauthorized: false,
  });
});

test("an unknown WAZAP_WEBHOOK value is invalid rather than silently on", () => {
  const settings = readWebhookSettings({ WAZAP_WEBHOOK: "maybe" });
  assert.equal(settings.kind, "invalid");
  assert.match(settings.detail, /maybe/);
});

test("plain http is refused unless it points at this machine", () => {
  assert.throws(
    () => requireWebhookUrl("http://example.com/hook"),
    (err) => {
      assert.match(err.message, /non-https/);
      return true;
    }
  );
  assert.equal(requireWebhookUrl("http://127.0.0.1:9/hook"), "http://127.0.0.1:9/hook");
  assert.equal(requireWebhookUrl("https://hooks.example/wazap"), "https://hooks.example/wazap");
});

test("the signature is HMAC-SHA256 of the exact raw body", () => {
  const body = '{"event":"message_received"}';
  const header = webhookSignature(body, SECRET);
  assert.match(header, /^sha256=[0-9a-f]{64}$/);
  assert.equal(webhookSignatureMatches(body, SECRET, header), true);
  assert.equal(webhookSignatureMatches(body, "other", header), false);
  assert.equal(webhookSignatureMatches(`${body} `, SECRET, header), false);
});

test("a ready sink POSTs the small payload with a matching signature", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    const body = await readBody(req);
    received.push({
      path: req.url,
      event: req.headers["x-wazap-event"],
      signature: req.headers["x-wazap-signature"],
      type: req.headers["content-type"],
      body,
    });
    res.writeHead(204);
    res.end();
  });

  const sink = new WebhookSink(readyEnv(server.url), { retryDelays: [] });
  assert.deepEqual(await sink.attempt(samplePayload(), sink.settings()), { ok: true, status: 204 });

  assert.equal(received.length, 1);
  const hit = received[0];
  assert.equal(hit.path, "/hook");
  assert.equal(hit.event, "message_received");
  assert.match(hit.type, /application\/json/);
  assert.equal(webhookSignatureMatches(hit.body, SECRET, hit.signature), true);
  assert.deepEqual(JSON.parse(hit.body), samplePayload());
  await server.close();
});

test("off queues and posts nothing, even when a URL is set", async () => {
  const server = await recorder();
  const saved = WEBHOOK_KEYS.map((key) => [key, process.env[key]]);
  Object.assign(process.env, { WAZAP_WEBHOOK: "off", WAZAP_WEBHOOK_URL: server.url, WAZAP_WEBHOOK_SECRET: SECRET, WAZAP_WEBHOOK_EVENTS: "all" });
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-webhook-off-", id: ME, name: "Răzvan" });
  try {
    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("IN", "salut"), ownMessage("OUT", "pa")] });
    svc.setStatus("disconnected");
    await svc.outbox.idle();
    assert.deepEqual(outboxRows(svc), []);
    assert.equal(server.received.length, 0);
    assert.deepEqual(svc.getStatus().webhook, { enabled: false, valid: true, last_error: null }, "off carries no delivery block");
  } finally {
    await svc.stop();
    await server.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("only the events WAZAP_WEBHOOK_EVENTS names are queued: unset is message_received, all is three, a list is its names", async () => {
  for (const [events, expected] of [
    [undefined, ["message_received"]],
    ["all", ["message_received", "message_sent", "connection"]],
    ["message_received,connection", ["message_received", "connection"]],
  ]) {
    const server = await recorder();
    const restoreEnv = saveWebhookEnv(server.url, events);
    const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-webhook-events-", id: ME, name: "Răzvan" });
    try {
      sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("IN", "salut")] });
      sock.ev.emit("messages.upsert", { type: "notify", messages: [ownMessage("OUT", "typed on the phone")] });
      svc.setStatus("disconnected");
      await waitFor(() => server.received.length === expected.length, 3_000, `the ${expected.join(", ")} POSTs`);
      await svc.outbox.idle();
      assert.deepEqual(outboxRows(svc).map((row) => row.kind), expected, `an event not subscribed to is never written (${events})`);
      assert.deepEqual(server.received.map((body) => body.event), expected);
    } finally {
      await svc.stop();
      await server.close();
      restoreEnv();
    }
  }
});

test("a long body is posted as a preview that says it was cut", () => {
  assert.equal(WEBHOOK_TEXT_MAX, 2000);
  assert.deepEqual(previewText("short"), { text: "short", truncated: false });
  assert.deepEqual(previewText("x".repeat(2000)), { text: "x".repeat(2000), truncated: false });
  const cut = previewText("x".repeat(2001));
  assert.equal(cut.text.length, 2000);
  assert.equal(cut.text, `${"x".repeat(1999)}…`);
  assert.equal(cut.truncated, true);
});

test("a 5xx is a failure worth retrying; webhook test retries it twice, then sets last_error and throws nothing", async () => {
  let hits = 0;
  const server = await listen((_req, res) => {
    hits++;
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("no");
  });
  const sink = new WebhookSink(readyEnv(server.url), { retryDelays: [0, 0] });
  const attempt = await sink.attempt(samplePayload({ text: "x" }), sink.settings());
  assert.deepEqual(
    { ...attempt, fix: undefined },
    { ok: false, status: 502, error: `HTTP 502 from ${new URL(server.url).host}`, fix: undefined, retry: true }
  );
  const lines = [];
  const realError = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    assert.equal((await sink.sendTest()).ok, false);
  } finally {
    console.error = realError;
  }
  assert.equal(hits, 4);
  assert.equal(lines.filter((line) => /retry \d\/2/.test(line)).length, 2);
  assert.match(sink.lastError ?? "", /HTTP 502/);
  assert.equal(sink.info().enabled, true);
  assert.equal(sink.info().valid, true);
  assert.match(sink.info().last_error ?? "", /HTTP 502/);
  await server.close();
});

test("a probe answered 5xx and then 2xx clears last_error", async () => {
  let hits = 0;
  const post = async () => {
    hits++;
    return new Response(hits < 3 ? "no" : null, { status: hits < 3 ? 502 : 204 });
  };
  const sink = new WebhookSink(readyEnv("http://127.0.0.1:9/hook"), { post, retryDelays: [0, 0] });
  const realError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await sink.sendTest(), { ok: true });
  } finally {
    console.error = realError;
  }
  assert.equal(hits, 3);
  assert.equal(sink.lastError, null);
});

test("a POST never rejects, even when serializing the body throws, and the error says nothing of it", async () => {
  const sink = new WebhookSink(readyEnv("http://127.0.0.1:9/hook"), { retryDelays: [] });
  const payload = {
    ...samplePayload(),
    get text() {
      throw new Error(`cannot serialize ${SECRET}`);
    },
  };
  const attempt = await sink.attempt(payload, sink.settings());
  assert.equal(attempt.ok, false);
  assert.equal(attempt.retry, false);
  assert.equal(attempt.error, "Webhook delivery failed.");
  assert.ok(!JSON.stringify(attempt).includes(SECRET), "the secret must not appear in the error");
});

test("an unreachable URL is a soft fail that sets last_error", async () => {
  const sink = new WebhookSink(readyEnv("http://127.0.0.1:1/hook"), { retryDelays: [] });
  const realError = console.error;
  console.error = () => {};
  try {
    await sink.sendTest();
  } finally {
    console.error = realError;
  }
  assert.match(sink.lastError ?? "", /could not reach 127.0.0.1:1/);
  assert.ok(!(sink.lastError ?? "").includes(SECRET), "the secret must not appear in last_error");
});

test("a refused connection says so in last_error, without the URL around it", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const sink = new WebhookSink(readyEnv(`http://127.0.0.1:${port}/hook?token=${SECRET}`), { retryDelays: [] });
  const realError = console.error;
  console.error = () => {};
  try {
    await sink.sendTest();
  } finally {
    console.error = realError;
  }
  assert.equal(sink.lastError, `could not reach 127.0.0.1:${port} (ECONNREFUSED)`);
});

test("sendTest refuses off and invalid config, and posts the same event when ready", async () => {
  const off = await new WebhookSink({}).sendTest();
  assert.equal(off.ok, false);
  assert.match(off.error, /off/i);

  const invalid = await new WebhookSink({ WAZAP_WEBHOOK: "on" }).sendTest();
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /URL or a secret/);

  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(200);
    res.end();
  });
  const ready = await new WebhookSink(readyEnv(server.url), { retryDelays: [] }).sendTest();
  assert.equal(ready.ok, true);
  assert.equal(received[0].event, "message_received");
  assert.equal(received[0].text, "wazap webhook test");
  assert.equal(received[0].message_id, "test");
  assert.equal(received[0].from, "wazap");
  assert.equal(received[0].account_id, "default");
  assert.equal(received[0].account_name, "default");
  await server.close();
});

test("a sink prefers the account webhook_url and names that account on sendTest", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push({
      signature: req.headers["x-wazap-signature"],
      body: await readBody(req),
    });
    res.writeHead(204);
    res.end();
  });
  const workSecret = "work-hook-secret";
  const sink = new WebhookSink(readyEnv("http://127.0.0.1:1/dead"), {
    retryDelays: [],
    account: {
      id: "work",
      name: "Work",
      webhook_url: server.url,
      webhook_secret: workSecret,
    },
  });
  const result = await sink.sendTest();
  assert.equal(result.ok, true);
  assert.equal(received.length, 1);
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.account_id, "work");
  assert.equal(payload.account_name, "Work");
  assert.equal(webhookSignatureMatches(received[0].body, workSecret, received[0].signature), true);
  await server.close();
});

test("an account with its own event list is sent to accounts.json, not to the environment", async () => {
  let calls = 0;
  const post = async () => {
    calls++;
    return new Response(null, { status: 204 });
  };
  const sink = new WebhookSink(readyEnv("https://hooks.example/global", "all"), {
    post,
    retryDelays: [],
    account: { id: "work", name: "Work", webhook_events: "message_received" },
  });
  const result = await sink.sendTest("connection");
  assert.equal(result.ok, false);
  assert.match(result.error, /"connection" is not enabled/);
  assert.equal(result.fix, 'set webhook_events for "work" in accounts.json to message_received,connection, or all');
  assert.equal(calls, 0);
});

test("doctor marks on-without-url invalid, and off as an info check", () => {
  const off = webhookCheck({});
  assert.equal(off.name, "webhook");
  assert.equal(off.state, "info");
  assert.equal(off.detail, "off");

  const bad = webhookCheck({ WAZAP_WEBHOOK: "on" });
  assert.equal(bad.state, "fail");
  assert.match(bad.detail, /URL or a secret/);
  assert.match(bad.fix, /wazap config webhook on/);
});

test("status and status --json show an on-without-secret webhook as a failing check", async () => {
  const dir = dataDir();
  const env = { WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_URL: "https://hooks.example/wazap" };
  const human = await status(dir, [], env);
  assert.match(human.stderr, /✗ webhook: on without a secret/);
  assert.match(human.stderr, /wazap config webhook on/);

  const { stdout } = await status(dir, ["--json"], env);
  const report = JSON.parse(stdout);
  const check = report.checks.find((row) => row.name === "webhook");
  assert.equal(check.state, "fail");
  assert.match(check.detail, /without a secret/);
  assert.ok(!stdout.includes("webhook-test-secret") && !JSON.stringify(report).includes(SECRET));
});

test("status --json carries webhook: off when it is unset", async () => {
  const { stdout } = await status(dataDir(), ["--json"]);
  const report = JSON.parse(stdout);
  assert.deepEqual(
    report.checks.find((row) => row.name === "webhook"),
    { name: "webhook", state: "info", detail: "off" }
  );
});

test("a live notify POSTs the inbound message, and an append does not", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const saved = WEBHOOK_KEYS.map((key) => [key, process.env[key]]);
  Object.assign(process.env, {
    WAZAP_WEBHOOK: "on",
    WAZAP_WEBHOOK_URL: server.url,
    WAZAP_WEBHOOK_SECRET: SECRET,
  });
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-webhook-live-", id: ME, name: "Răzvan" });
  try {
    sock.ev.emit("messages.upsert", { type: "append", messages: [textMessage("OLD", "history")] });
    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("NEW", "live inbound")] });
    await waitFor(() => received.length > 0, 3_000, "the live webhook POST");
    assert.equal(received.length, 1);
    assert.equal(received[0].event, "message_received");
    assert.equal(received[0].text, "live inbound");
    assert.equal(received[0].chat_id, PEER);
    assert.equal(received[0].from, "40700000002");
    assert.equal(received[0].account_id, "default");
    assert.equal(received[0].account_name, "default");
    assert.ok(received[0].message_id);
    assert.ok(received[0].ts);
    const listed = await svc.readMessages(PEER, 10);
    assert.equal(listed.data.length, 2, "history ingest still stored the append");
  } finally {
    await svc.stop();
    await server.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("stub and system notices are not posted as message_received", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const saved = WEBHOOK_KEYS.map((key) => [key, process.env[key]]);
  Object.assign(process.env, readyEnv(server.url));
  const group = "120363000000000003@g.us";
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-webhook-stub-", id: ME, name: "Răzvan" });
  try {
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: group, fromMe: false, id: "STUB" },
          messageTimestamp: Math.floor(Date.now() / 1000),
          messageStubType: proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD,
        },
        {
          key: { remoteJid: group, fromMe: false, id: "ENC" },
          messageTimestamp: Math.floor(Date.now() / 1000),
          messageStubType: proto.WebMessageInfo.StubType.E2E_ENCRYPTED,
        },
        {
          key: { remoteJid: PEER, fromMe: false, id: "SYS" },
          messageTimestamp: Math.floor(Date.now() / 1000),
          message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING } },
        },
        textMessage("REAL", "only this one"),
      ],
    });
    await waitFor(() => received.length > 0, 3_000, "the user inbound webhook POST");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received.length, 1);
    assert.equal(received[0].text, "only this one");
    assert.equal(received[0].event, "message_received");
    const listed = await svc.readMessages(group, 10);
    assert.ok(
      listed.data.some((row) => row.type === "system"),
      "the stub is still stored, just not posted"
    );
  } finally {
    await svc.stop();
    await server.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a live notify posts to the account webhook_url and names that account", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const saved = WEBHOOK_KEYS.map((key) => [key, process.env[key]]);
  Object.assign(process.env, readyEnv("http://127.0.0.1:1/dead"));
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-webhook-acct-",
    id: ME,
    name: "Work phone",
    account: {
      id: "work",
      name: "Work",
      enabled: true,
      owner: null,
      webhook_url: server.url,
      webhook_secret: "work-live-secret",
    },
  });
  try {
    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("LIVE", "from work")] });
    await waitFor(() => received.length > 0, 3_000, "the per-account webhook POST");
    assert.equal(received.length, 1);
    assert.equal(received[0].text, "from work");
    assert.equal(received[0].account_id, "work");
    assert.equal(received[0].account_name, "Work");
  } finally {
    await svc.stop();
    await server.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

/**
 * The echo is driven as `notify` on purpose, which is the id backstop and not the
 * path production takes. The test after this one covers the `append` Baileys
 * really emits for a local send.
 */
test("a message typed on the phone posts message_sent, and the noted id keeps wazap's own echo quiet", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url, "all");
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-webhook-sent-",
    id: ME,
    name: "Răzvan",
    config: { readOnly: false },
  });
  sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
  sock.sendMessage = async (jid, content) => ({
    key: { remoteJid: jid, fromMe: true, id: "OWN" },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: content.text },
  });
  try {
    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("IN", "salut")] });
    await waitFor(() => received.length > 0, 3_000, "the inbound webhook POST");

    const sent = await svc.sendMessage(PEER, "răspuns");
    sock.ev.emit("messages.upsert", { type: "notify", messages: [ownMessage("OWN", "răspuns")] });
    sock.ev.emit("messages.upsert", { type: "notify", messages: [ownMessage("PHONE", "răspuns")] });
    await waitFor(() => received.length > 1, 3_000, "the message_sent webhook POST");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(sent.message_id, `true_${PEER}_OWN`);
    assert.equal(received.length, 2, "the echo of wazap's own send must not come back as an event");
    assert.equal(received[1].event, "message_sent");
    assert.equal(received[1].from_me, true);
    assert.equal(received[1].text, "răspuns", "the same text as wazap sent, so only the id can tell them apart");
    assert.equal(received[1].message_id, `true_${PEER}_PHONE`);
    assert.equal(received[1].is_self_chat, false);
  } finally {
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

/**
 * What Baileys does with this socket's own send: it re-emits it as an `append`,
 * which the notify gate drops. That gate, not the noted id, is what keeps wazap
 * from answering itself in production.
 */
test("wazap's own send is quiet as the append Baileys emits for it", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url, "all");
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-webhook-append-",
    id: ME,
    name: "Răzvan",
    config: { readOnly: false },
  });
  sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
  sock.sendMessage = async (jid, content) => ({
    key: { remoteJid: jid, fromMe: true, id: "OWN" },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: content.text },
  });
  try {
    sock.ev.emit("messages.upsert", { type: "append", messages: [ownMessage("NEVER_NOTED", "răspuns")] });
    const sent = await svc.sendMessage(PEER, "răspuns");
    sock.ev.emit("messages.upsert", { type: "notify", messages: [ownMessage("OWN", "răspuns")] });
    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("IN", "salut")] });
    await waitFor(() => received.length > 0, 3_000, "the inbound webhook POST");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(sent.message_id, `true_${PEER}_OWN`);
    assert.equal(received.length, 1, "an append is not an event, whether its id was noted or not");
    assert.equal(received[0].event, "message_received");
    assert.equal(received[0].text, "salut");
  } finally {
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("the self chat is marked is_self_chat, and timestamp is ts in UTC", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url, "all");
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-webhook-self-", id: ME, name: "Răzvan" });
  try {
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [ownMessage("SELF", "notă pentru mine", { chat: ME })],
    });
    await waitFor(() => received.length > 0, 3_000, "the self-chat webhook POST");
    const self = received[0];
    assert.equal(self.event, "message_sent");
    assert.equal(self.from_me, true);
    assert.equal(self.is_self_chat, true);
    assert.equal(self.chat_id, ME);
    assert.equal(self.kind, "text");
    assert.equal(self.truncated, false);
    assert.match(self.timestamp, /Z$/);
    assert.equal(
      Date.parse(self.timestamp),
      Date.parse(self.ts),
      "the same instant as ts, not a second look at the clock"
    );

    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("IN", "salut")] });
    await waitFor(() => received.length > 1, 3_000, "the inbound webhook POST");
    assert.equal(received[1].event, "message_received");
    assert.equal(received[1].from_me, false);
    assert.equal(received[1].is_self_chat, false);
  } finally {
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("an image posts kind image, and a sticker falls through to other", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url);
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-webhook-kind-", id: ME, name: "Răzvan" });
  try {
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: PEER, fromMe: false, id: "IMG" },
          messageTimestamp: Math.floor(Date.now() / 1000),
          message: { imageMessage: { mimetype: "image/jpeg" } },
        },
      ],
    });
    await waitFor(() => received.length > 0, 3_000, "the image webhook POST");
    assert.equal(received[0].kind, "image");

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: PEER, fromMe: false, id: "STK" },
          messageTimestamp: Math.floor(Date.now() / 1000),
          message: { stickerMessage: { mimetype: "image/webp" } },
        },
      ],
    });
    await waitFor(() => received.length > 1, 3_000, "the sticker webhook POST");
    assert.equal(received[1].kind, "other");
  } finally {
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("a voice note waits for its transcript, and posts the words as the text", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url);
  const { svc, sock } = transcribingService("wazap-webhook-voice-");
  svc.transcriber = async () => ({ text: "am uitat umbrela acasă", language: "ro", duration_seconds: 6 });
  svc.mediaBuffer = async () => Buffer.from("not really an ogg file");
  try {
    sock.ev.emit("messages.upsert", { type: "notify", messages: [voiceNote("V1", 6)] });
    await waitFor(() => received.length > 0, 5_000, "the voice note webhook POST");
    assert.equal(received[0].text, "am uitat umbrela acasă", "the wait is the only reason the words are here");
    assert.equal(received[0].kind, "audio");
    assert.equal(received[0].event, "message_received");
    assert.equal(received[0].truncated, false);
  } finally {
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

/**
 * The worker runs one note at a time, so one note is still being transcribed
 * when the other is done. The finished one must not pay for it: the wait is per
 * message, and the second transcript is released by hand rather than by a
 * sleep. Two chats, since a chat keeps its own order.
 */
test("a voice note waits for its own transcript, not for another chat's note being transcribed", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url);
  const { svc, sock } = transcribingService("wazap-webhook-per-note-");
  let releaseSecond = () => {};
  const second = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  let calls = 0;
  svc.mediaBuffer = async () => Buffer.from("not really an ogg file");
  svc.transcriber = async () => {
    calls += 1;
    if (calls > 1) await second;
    return { text: calls === 1 ? "prima notă" : "a doua notă", language: "ro", duration_seconds: 6 };
  };
  try {
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [voiceNote("V1", 6), voiceNote("V2", 6, Date.now(), "40700000003@s.whatsapp.net")],
    });
    await waitFor(() => received.length > 0, 5_000, "the first voice note webhook POST");
    assert.equal(received.length, 1, "the second note is still being transcribed");
    assert.equal(received[0].text, "prima notă");

    releaseSecond();
    await waitFor(() => received.length > 1, 5_000, "the second voice note webhook POST");
    assert.equal(received[1].text, "a doua notă");
  } finally {
    releaseSecond();
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("a transcription that fails every attempt still posts the event, carrying the placeholder", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url);
  const { svc, sock } = transcribingService("wazap-webhook-voice-fail-");
  svc.mediaBuffer = async () => Buffer.from("not really an ogg file");
  let calls = 0;
  svc.transcriber = async () => {
    calls += 1;
    throw new Error("whisper exploded");
  };
  const realError = console.error;
  console.error = () => {};
  const timings = transcribeWorker.configure({ retryDelaysMs: [5, 5] });
  try {
    sock.ev.emit("messages.upsert", { type: "notify", messages: [voiceNote("VF", 6)] });
    await waitFor(() => received.length > 0, 5_000, "the failed voice note webhook POST");
    assert.equal(calls, 3, "a crash is tried again, three times in all, before the event gives up waiting");
    assert.equal(received[0].text, "[voice message · 0:06]");
    assert.equal(received[0].kind, "audio");
    assert.equal(received[0].event, "message_received");
  } finally {
    transcribeWorker.configure(timings);
    console.error = realError;
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

/**
 * The "Revin imediat." with nothing after it: a note whose first transcription
 * failed must still reach the consumer with its words when a retry lands
 * inside the minute the event waits.
 */
test("a voice note whose first transcription fails posts the words a retry got", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url);
  const { svc, sock } = transcribingService("wazap-webhook-voice-retry-");
  svc.mediaBuffer = async () => Buffer.from("not really an ogg file");
  let calls = 0;
  svc.transcriber = async () => {
    calls += 1;
    if (calls === 1) throw new Error("whisper.cpp crashed");
    return { text: "ajung în zece minute", language: "ro", duration_seconds: 6 };
  };
  const realError = console.error;
  console.error = () => {};
  const timings = transcribeWorker.configure({ retryDelaysMs: [20] });
  try {
    sock.ev.emit("messages.upsert", { type: "notify", messages: [voiceNote("VR", 6)] });
    await waitFor(() => received.length > 0, 5_000, "the retried voice note webhook POST");
    assert.equal(calls, 2);
    assert.equal(received.length, 1, "one event, sent once the words were there");
    assert.equal(received[0].text, "ajung în zece minute");
  } finally {
    transcribeWorker.configure(timings);
    console.error = realError;
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("a voice note posts its placeholder at once while the provider refuses the key, not after a minute", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url);
  const { svc, sock } = transcribingService("wazap-webhook-voice-paused-");
  svc.mediaBuffer = async () => Buffer.from("not really an ogg file");
  let calls = 0;
  svc.transcriber = async () => {
    calls += 1;
    throw markFailure(new WazapError("TRANSCRIBE_FAILED", "Transcription API returned HTTP 401."), "paused", "provider refused the key (HTTP 401)");
  };
  const realError = console.error;
  console.error = () => {};
  try {
    sock.ev.emit("messages.upsert", { type: "notify", messages: [voiceNote("K1", 6)] });
    await waitFor(() => received.length > 0, 3_000, "the first note's webhook POST");
    assert.equal(received[0].text, "[voice message · 0:06]");

    sock.ev.emit("messages.upsert", { type: "notify", messages: [voiceNote("K2", 6)] });
    await waitFor(() => received.length > 1, 3_000, "the webhook POST of a note arriving during the pause");
    assert.equal(received[1].text, "[voice message · 0:06]");
    assert.equal(calls, 1, "and the paused provider was not asked again");
  } finally {
    console.error = realError;
    transcribeWorker.resume();
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("connection changes post linked, disconnected and expired, once per mapped status", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push({ header: req.headers["x-wazap-event"], body: JSON.parse(await readBody(req)) });
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url, "connection");
  const svc = openService(WhatsAppService, offlineConfig("wazap-webhook-conn-"));
  const sock = fakeSocket();
  svc.start = async () => {};
  svc.wireEvents(sock, ++svc.generation);
  try {
    sock.ev.emit("connection.update", { connection: "open" });
    await waitFor(() => received.length > 0, 3_000, "the linked webhook POST");
    sock.ev.emit("connection.update", closedWith(DisconnectReason.connectionClosed));
    await waitFor(() => received.length > 1, 3_000, "the disconnected webhook POST");
    sock.ev.emit("connection.update", closedWith(DisconnectReason.loggedOut));
    await waitFor(() => received.length > 2, 3_000, "the expired webhook POST");
    svc.setStatus("session_corrupt");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(
      received.map((hit) => hit.body.status),
      ["linked", "disconnected", "expired"]
    );
    assert.equal(received.length, 3, "session_corrupt is expired too, and a consumer hears that once");
    for (const hit of received) {
      assert.equal(hit.header, "connection");
      assert.equal(hit.body.event, "connection");
      assert.equal(hit.body.account_id, "default");
      assert.equal(hit.body.account_name, "default");
      assert.match(hit.body.timestamp, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
  } finally {
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

/**
 * `expired` has no later transition to recover with, because re-linking needs a
 * human. So a status the consumer refused stays in the outbox and is retried
 * until it arrives, unless a newer status replaces it: the consumer hears the
 * current one, never an older one after it.
 */
test("a connection event the consumer refused is retried until it arrives, and a newer status supersedes it", async () => {
  const received = [];
  let attempts = 0;
  let accepting = false;
  const server = await listen(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    attempts += 1;
    // A retry already on the wire when the status changes can land after the
    // consumer starts accepting; refusing disconnected throughout keeps this
    // about the supersede, not about which POST wins that race.
    if (!accepting || body.status === "disconnected") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("no");
      return;
    }
    received.push(body);
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url, "connection");
  const svc = openService(WhatsAppService, offlineConfig("wazap-webhook-conn-fail-"));
  svc.outbox.retryDelays = [20];
  svc.outbox.retryEveryMs = 20;
  const realError = console.error;
  console.error = () => {};
  try {
    svc.setStatus("logged_out");
    await waitFor(() => attempts >= 3, 5_000, "the expired POST and two retries");
    assert.equal(received.length, 0, "nothing was delivered");

    accepting = true;
    await waitFor(() => received.length > 0, 5_000, "the retried expired POST");
    svc.setStatus("session_corrupt");
    assert.equal(outboxRows(svc).length, 1, "session_corrupt is expired again, which was already queued");

    accepting = false;
    svc.setStatus("disconnected");
    await waitFor(() => attempts >= 6, 5_000, "the disconnected POST and two retries");
    svc.setStatus("connected");
    accepting = true;
    await waitFor(() => received.length > 1, 5_000, "the linked POST");
    await svc.outbox.idle();

    assert.deepEqual(
      received.map((hit) => hit.status),
      ["expired", "linked"],
      "expired arrives once; disconnected, refused and then out of date, never does"
    );
    assert.deepEqual(
      outboxRows(svc).map((row) => [row.state, row.last_error]),
      [
        ["delivered", null],
        ["cancelled", "superseded by a newer connection event"],
        ["delivered", null],
      ]
    );
  } finally {
    console.error = realError;
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

/**
 * A filtered event is not a delivery, so it must leave the "only on change"
 * guard where it was. Both statuses here map to `expired`: the second one can
 * only arrive if the filtered first never counted as announced.
 */
test("a filtered connection change does not count as announced", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push(JSON.parse(await readBody(req)));
    res.writeHead(204);
    res.end();
  });
  const restoreEnv = saveWebhookEnv(server.url, "message_received");
  const svc = openService(WhatsAppService, offlineConfig("wazap-webhook-conn-filtered-"));
  try {
    svc.setStatus("logged_out");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received.length, 0, "connection is not an enabled event");

    process.env.WAZAP_WEBHOOK_EVENTS = "all";
    svc.setStatus("session_corrupt");
    await waitFor(() => received.length > 0, 5_000, "the expired webhook POST");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(
      received.map((hit) => hit.status),
      ["expired"]
    );
  } finally {
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("a down webhook does not break ingest or get_status", async () => {
  const saved = WEBHOOK_KEYS.map((key) => [key, process.env[key]]);
  Object.assign(process.env, {
    WAZAP_WEBHOOK: "on",
    WAZAP_WEBHOOK_URL: "http://127.0.0.1:1/hook",
    WAZAP_WEBHOOK_SECRET: SECRET,
  });
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-webhook-soft-", id: ME, name: "Răzvan" });
  try {
    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("LIVE", "still here")] });
    const listed = await svc.readMessages(PEER, 10);
    assert.equal(listed.data[0].text, "still here");
    await waitFor(() => svc.getStatus().webhook.last_error, 3_000, "webhook last_error");
    const status = svc.getStatus();
    assert.equal(status.webhook.enabled, true);
    assert.equal(status.webhook.valid, true);
    assert.match(status.webhook.last_error ?? "", /could not reach/);
    assert.equal(status.status, "connected");
  } finally {
    await svc.stop();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("config webhook on writes url and secret, and prints neither the secret nor most of it", async () => {
  const dir = dataDir();
  const { code, stdout, stderr } = await wazap(dir, ["config", "webhook", "on"], {
    input: `${SECRET}\n`,
    env: { WAZAP_WEBHOOK_URL: "http://127.0.0.1:9/hook" },
  });
  assert.equal(code, 0, stderr);
  const envFile = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envFile, /^WAZAP_WEBHOOK=on$/m);
  assert.match(envFile, /^WAZAP_WEBHOOK_URL=http:\/\/127\.0\.0\.1:9\/hook$/m);
  assert.match(envFile, new RegExp(`^WAZAP_WEBHOOK_SECRET=${SECRET}$`, "m"));
  assert.ok(!stdout.includes(SECRET) && !stderr.includes(SECRET), "the secret must not be printed");
  assert.match(stderr, /webhook: on/);

  const shown = await wazap(dir, ["config"]);
  assert.ok(!shown.stderr.includes(SECRET), "config must not print the secret");
  assert.match(shown.stderr, /secret: set/);
});

test("config webhook on says what is posted: the messages you receive by default, and how to ask for more", async () => {
  const dir = dataDir();
  const { code, stderr } = await wazap(dir, ["config", "webhook", "on"], {
    input: `${SECRET}\n`,
    env: { WAZAP_WEBHOOK_URL: "http://127.0.0.1:9/hook" },
  });
  assert.equal(code, 0, stderr);
  assert.match(stderr, /messages you receive are posted to 127\.0\.0\.1/);
  assert.doesNotMatch(stderr, /both ways|link changes/, "the default does not post what the old line promised");
  assert.match(stderr, /Nothing else is posted by default: set WAZAP_WEBHOOK_EVENTS to all/);
});

test("config webhook on names every event the list asks for, and has no hint when it asked for more", async () => {
  const dir = dataDir();
  const { code, stderr } = await wazap(dir, ["config", "webhook", "on"], {
    input: `${SECRET}\n`,
    env: { WAZAP_WEBHOOK_URL: "http://127.0.0.1:9/hook", WAZAP_WEBHOOK_EVENTS: "all" },
  });
  assert.equal(code, 0, stderr);
  assert.match(stderr, /messages you receive, messages you send from your phone or another device and link changes are posted/);
  assert.doesNotMatch(stderr, /Nothing else is posted by default/);
});

test("config webhook on --account says the events that account asked for, not the global default", async () => {
  const dir = dataDir();
  await wazap(dir, ["account", "add", "work"]);
  const file = join(dir, "accounts.json");
  const registry = JSON.parse(readFileSync(file, "utf8"));
  registry.accounts.find((account) => account.id === "work").webhook_events = "connection";
  writeFileSync(file, JSON.stringify(registry, null, 2));
  const { code, stderr } = await wazap(dir, ["config", "webhook", "on", "--account", "work"], {
    input: `${SECRET}\n`,
    env: { WAZAP_WEBHOOK_URL: "http://127.0.0.1:9/hook" },
  });
  assert.equal(code, 0, stderr);
  assert.match(stderr, /webhook: on for work — link changes are posted to 127\.0\.0\.1/);
  assert.doesNotMatch(stderr, /messages you receive|Nothing else is posted by default/);
});

test("config webhook on keeps a secret that contains #, and webhook test signs with it", async () => {
  const secret = "p@ss#word with spaces";
  const received = [];
  const server = await listen(async (req, res) => {
    received.push({
      signature: req.headers["x-wazap-signature"],
      body: await readBody(req),
    });
    res.writeHead(204);
    res.end();
  });
  const dir = dataDir();
  const enabled = await wazap(dir, ["config", "webhook", "on"], {
    input: `${secret}\n`,
    env: { WAZAP_WEBHOOK_URL: server.url },
  });
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.ok(!enabled.stdout.includes(secret) && !enabled.stderr.includes(secret), "the secret must not be printed");
  const envFile = readFileSync(join(dir, ".env"), "utf8");
  assert.equal(parse(envFile).WAZAP_WEBHOOK_SECRET, secret);
  assert.match(envFile, /WAZAP_WEBHOOK_SECRET='/);

  const probed = await wazap(dir, ["webhook", "test"]);
  assert.equal(probed.code, 0, probed.stderr);
  assert.equal(received.length, 1);
  assert.equal(webhookSignatureMatches(received[0].body, secret, received[0].signature), true);
  assert.equal(webhookSignatureMatches(received[0].body, secret.split("#")[0], received[0].signature), false);
  await server.close();
});

test("wazap webhook test delivers, and refuses when the webhook is off", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push({
      signature: req.headers["x-wazap-signature"],
      body: await readBody(req),
    });
    res.writeHead(204);
    res.end();
  });
  const dir = dataDir();
  const ready = await wazap(dir, ["webhook", "test"], {
    env: readyEnv(server.url),
  });
  assert.equal(ready.code, 0, ready.stderr);
  assert.match(ready.stderr, /test delivered/);
  assert.equal(received.length, 1);
  assert.equal(webhookSignatureMatches(received[0].body, SECRET, received[0].signature), true);
  assert.equal(JSON.parse(received[0].body).event, "message_received");
  assert.equal(JSON.parse(received[0].body).text, "wazap webhook test");
  assert.equal(JSON.parse(received[0].body).account_id, "default");
  assert.equal(JSON.parse(received[0].body).account_name, "default");
  assert.ok(!ready.stderr.includes(SECRET) && !ready.stdout.includes(SECRET));

  const off = await wazap(dir, ["webhook", "test"]);
  assert.equal(off.code, 1);
  assert.match(off.stderr, /Webhook is off/);
  await server.close();
});

test("wazap webhook test --event posts that event, and refuses an unknown one", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push({
      event: req.headers["x-wazap-event"],
      signature: req.headers["x-wazap-signature"],
      body: await readBody(req),
    });
    res.writeHead(204);
    res.end();
  });
  const dir = dataDir();
  const asSent = await wazap(dir, ["webhook", "test", "--event", "message_sent"], { env: readyEnv(server.url, "all") });
  assert.equal(asSent.code, 0, asSent.stderr);
  const asConnection = await wazap(dir, ["webhook", "test", "--event", "connection"], {
    env: readyEnv(server.url, "all"),
  });
  assert.equal(asConnection.code, 0, asConnection.stderr);

  assert.deepEqual(
    received.map((hit) => hit.event),
    ["message_sent", "connection"]
  );
  const sent = JSON.parse(received[0].body);
  assert.equal(sent.event, "message_sent");
  assert.equal(sent.from_me, true);
  assert.equal(sent.text, "wazap webhook test");
  assert.equal(webhookSignatureMatches(received[0].body, SECRET, received[0].signature), true);
  const connection = JSON.parse(received[1].body);
  assert.equal(connection.event, "connection");
  assert.equal(connection.status, "linked");
  assert.match(connection.timestamp, /Z$/);
  assert.equal(webhookSignatureMatches(received[1].body, SECRET, received[1].signature), true);

  const unknown = await wazap(dir, ["webhook", "test", "--event", "frobnicate"], { env: readyEnv(server.url, "all") });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown webhook event "frobnicate"/);
  assert.ok(unknown.stderr.includes(WEBHOOK_EVENTS.join(", ")), unknown.stderr);
  assert.equal(received.length, 2, "a refused event must not POST");
  await server.close();
});

test("wazap webhook test --event refuses an event the filter drops, and posts it once it is enabled", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push({ event: req.headers["x-wazap-event"], body: await readBody(req) });
    res.writeHead(204);
    res.end();
  });
  const dir = dataDir();
  const filtered = await wazap(dir, ["webhook", "test", "--event", "message_sent"], { env: readyEnv(server.url) });
  assert.equal(filtered.code, 1);
  assert.match(filtered.stderr, /Webhook event "message_sent" is not enabled/);
  assert.ok(
    filtered.stderr.includes("set WAZAP_WEBHOOK_EVENTS=message_received,message_sent, or all"),
    filtered.stderr
  );
  assert.equal(received.length, 0, "a filtered event must not POST");

  const enabled = await wazap(dir, ["webhook", "test", "--event", "message_sent"], {
    env: readyEnv(server.url, "all"),
  });
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.equal(received.length, 1);
  assert.equal(received[0].event, "message_sent");
  assert.equal(JSON.parse(received[0].body).event, "message_sent");
  await server.close();
});

test("wazap webhook test --account posts to that account's override", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push({
      signature: req.headers["x-wazap-signature"],
      body: await readBody(req),
    });
    res.writeHead(204);
    res.end();
  });
  const dir = dataDir();
  const workSecret = "work-cli-secret";
  AccountRegistry.load(dir).add("work", "Work");
  AccountRegistry.load(dir).setWebhook("work", { url: server.url, secret: workSecret });
  const probed = await wazap(dir, ["webhook", "test", "--account", "work"], {
    env: readyEnv("http://127.0.0.1:1/dead"),
  });
  assert.equal(probed.code, 0, probed.stderr);
  assert.equal(received.length, 1);
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.account_id, "work");
  assert.equal(payload.account_name, "Work");
  assert.equal(webhookSignatureMatches(received[0].body, workSecret, received[0].signature), true);
  assert.ok(!probed.stderr.includes(workSecret) && !probed.stdout.includes(workSecret));
  await server.close();
});

test("wazap webhook test --account refuses an unknown id", async () => {
  const { code, stderr } = await wazap(dataDir(), ["webhook", "test", "--account", "ghost"], {
    env: readyEnv("http://127.0.0.1:9/hook"),
  });
  assert.equal(code, 1);
  assert.match(stderr, /No account "ghost"/);
});

test("config webhook on --account stores url and secret in accounts.json, then test posts to it", async () => {
  const received = [];
  const server = await listen(async (req, res) => {
    received.push({
      signature: req.headers["x-wazap-signature"],
      body: await readBody(req),
    });
    res.writeHead(204);
    res.end();
  });
  const dir = dataDir();
  await wazap(dir, ["account", "add", "work"]);
  const workSecret = "work-config-secret";
  const enabled = await wazap(dir, ["config", "webhook", "on", "--account", "work"], {
    input: `${workSecret}\n`,
    env: { WAZAP_WEBHOOK_URL: server.url },
  });
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.match(enabled.stderr, /webhook: on for work/);
  assert.ok(!enabled.stdout.includes(workSecret) && !enabled.stderr.includes(workSecret));

  const file = JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8"));
  const work = file.accounts.find((account) => account.id === "work");
  assert.equal(work.webhook_url, server.url);
  assert.equal(work.webhook_secret, workSecret);
  const envFile = parse(readFileSync(join(dir, ".env"), "utf8"));
  assert.equal(envFile.WAZAP_WEBHOOK, "on", "the switch stays global");
  assert.equal(envFile.WAZAP_WEBHOOK_URL, undefined, "the URL belongs to the account, not .env");
  assert.equal(envFile.WAZAP_WEBHOOK_SECRET, undefined);

  const probed = await wazap(dir, ["webhook", "test", "--account", "work"]);
  assert.equal(probed.code, 0, probed.stderr);
  assert.equal(received.length, 1);
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.account_id, "work");
  assert.equal(webhookSignatureMatches(received[0].body, workSecret, received[0].signature), true);
  await server.close();
});

test("config webhook off --account drops the override; the account follows the global again", async () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  registry.add("work", "Work");
  registry.setWebhook("work", { url: "https://hooks.example/work", secret: "gone" });
  const { code, stderr } = await wazap(dir, ["config", "webhook", "off", "--account", "work"]);
  assert.equal(code, 0, stderr);
  assert.match(stderr, /override removed for work/);
  const work = JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8")).accounts.find(
    (account) => account.id === "work"
  );
  assert.equal(work.webhook_url, undefined);
  assert.equal(work.webhook_secret, undefined);
});

test("config webhook on --account refuses an unknown id before asking for a secret", async () => {
  const dir = dataDir();
  const { code, stderr } = await wazap(dir, ["config", "webhook", "on", "--account", "ghost"], {
    input: "secret\n",
    env: { WAZAP_WEBHOOK_URL: "https://hooks.example/x" },
  });
  assert.equal(code, 1);
  assert.match(stderr, /No account "ghost"/);
});

test("config rejects a webhook secret on the command line", async () => {
  const { code, stderr } = await wazap(dataDir(), ["config", "webhook", "on", SECRET]);
  assert.equal(code, 1);
  assert.match(stderr, /never a command-line argument/);
  assert.ok(!stderr.includes(SECRET) || stderr.includes("never a command-line argument"));
});

/** A post that answers every call with `status`, and counts the calls. */
function answering(status) {
  const post = async () => {
    post.calls++;
    return new Response(status < 300 ? null : "Invalid API key", { status });
  };
  post.calls = 0;
  return post;
}

test("a 4xx refusal is not worth retrying, names the status and a hint, and never the secret", async () => {
  for (const status of [400, 401, 403, 404, 410, 413, 422]) {
    const post = answering(status);
    const sink = new WebhookSink(readyEnv("http://127.0.0.1:9/hook"), { post, retryDelays: [0, 0] });
    const attempt = await sink.attempt(samplePayload(), sink.settings());
    assert.equal(attempt.ok, false);
    assert.equal(attempt.retry, false, `${status} is not retried`);
    assert.equal(attempt.status, status);
    assert.match(attempt.error, new RegExp(`^HTTP ${status} from 127\\.0\\.0\\.1:9, not retried: the receiver`));
    assert.ok(!attempt.error.includes(SECRET), "the secret must not appear in the error");
  }

  const post = answering(401);
  const sink = new WebhookSink(readyEnv("http://127.0.0.1:9/hook"), { post, retryDelays: [0, 0] });
  assert.match((await sink.attempt(samplePayload(), sink.settings())).error, /check the API key or secret it expects/);

  const realError = console.error;
  console.error = () => {};
  let probe;
  try {
    probe = await sink.sendTest();
  } finally {
    console.error = realError;
  }
  assert.equal(probe.ok, false);
  assert.equal(post.calls, 2, "webhook test does not retry a refusal either");
  assert.match(probe.fix, /API key or secret/);
  assert.match(probe.fix, /wazap webhook test/);
});

test("a 401 is retried only when WAZAP_WEBHOOK_RETRY_401 is on", async () => {
  const post = answering(401);
  const env = readyEnv("http://127.0.0.1:9/hook");
  const off = new WebhookSink(env, { post, retryDelays: [0, 0] });
  assert.equal((await off.attempt(samplePayload(), off.settings())).retry, false);

  const on = new WebhookSink({ ...env, WAZAP_WEBHOOK_RETRY_401: "on" }, { post, retryDelays: [0, 0] });
  const attempt = await on.attempt(samplePayload(), on.settings());
  assert.equal(attempt.retry, true);
  assert.match(attempt.error, /^HTTP 401 from 127\.0\.0\.1:9$/);
  assert.equal(on.settings().retryUnauthorized, true);
});

test("408, 425, 429 and 5xx are worth retrying", async () => {
  for (const status of [408, 425, 429, 500, 503]) {
    const post = answering(status);
    const sink = new WebhookSink(readyEnv("http://127.0.0.1:9/hook"), { post, retryDelays: [0, 0] });
    const attempt = await sink.attempt(samplePayload(), sink.settings());
    assert.equal(attempt.retry, true, `${status} is retried`);
    assert.equal(post.calls, 1, "one attempt is one POST; the outbox schedules the next");
    assert.match(attempt.error, new RegExp(`^HTTP ${status} from 127\\.0\\.0\\.1:9$`));
  }
});

test("an event the account database cannot store is counted as dropped, and posted nowhere", async () => {
  const server = await recorder();
  const restoreEnv = saveWebhookEnv(server.url, "all");
  const svc = openService(WhatsAppService, offlineConfig("wazap-webhook-drop-"));
  const realError = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    // The database is still being prepared from an older version's files.
    svc.storage.storageState = "preparing";
    svc.setStatus("logged_out");
    const { delivery } = svc.getStatus().webhook;
    assert.equal(delivery.dropped, 1);
    assert.ok(Number.isFinite(Date.parse(delivery.last_dropped_at)));
    assert.ok(lines.some((line) => /dropped connection expired: the account database could not store it/.test(line)));
    svc.storage.storageState = "ready";
    await svc.outbox.idle();
    assert.equal(server.received.length, 0);
    assert.deepEqual(outboxRows(svc), []);
  } finally {
    console.error = realError;
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("get_status and its webhook line carry the counters and the last failure, one POST per refused event", async () => {
  let hits = 0;
  let status = 401;
  const server = await listen(async (req, res) => {
    await readBody(req);
    hits++;
    res.writeHead(status, { "content-type": "text/plain" });
    res.end("Invalid API key");
  });
  const restoreEnv = saveWebhookEnv(server.url);
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-webhook-stats-", id: ME, name: "Răzvan" });
  const realError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(svc.getStatus().webhook.delivery, {
      delivered: 0,
      failed: 0,
      cancelled: 0,
      pending: 0,
      dropped: 0,
      consecutive_failures: 0,
      retrying: 0,
      last_success_at: null,
      last_failure_at: null,
      last_failure: null,
      last_status: null,
      last_dropped_at: null,
      oldest_pending_at: null,
    });
    for (const id of ["R1", "R2", "R3"]) {
      sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage(id, `refused ${id}`)] });
    }
    await waitFor(() => svc.getStatus().webhook.delivery?.failed === 3, 5_000, "three refused events");
    assert.equal(hits, 3, "a refusal is not retried");

    const result = renderGetStatus(svc.getStatus(), false, stubAccountSource(svc));
    const { delivery, last_error: lastError } = result.structuredContent.webhook;
    assert.equal(delivery.failed, 3);
    assert.equal(delivery.consecutive_failures, 3);
    assert.equal(delivery.delivered, 0);
    assert.equal(delivery.last_status, 401);
    assert.match(lastError, /^HTTP 401 from 127\.0\.0\.1:\d+, not retried/, "last_error is the failure no delivery cleared");
    const line = result.content[0].text.split("\n").find((row) => row.startsWith("- **webhook**"));
    assert.match(
      line,
      /^- \*\*webhook\*\*: on · 0 delivered, 3 failed, 0 cancelled, 0 pending · failing: 3 in a row · last failure at \S+: HTTP 401 from 127\.0\.0\.1:\d+, not retried: the receiver refuses the request/
    );
    assert.ok(!line.includes("last error"), "last_error is that same failure, said once");
    assert.deepEqual(outboxRows(svc).map((row) => [row.state, row.attempts, row.last_status]), [
      ["failed", 1, 401],
      ["failed", 1, 401],
      ["failed", 1, 401],
    ]);

    status = 204;
    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("BACK", "back")] });
    await waitFor(() => svc.getStatus().webhook.delivery?.delivered === 1, 5_000, "the delivery after the refusals");
    const recovered = svc.getStatus().webhook;
    assert.equal(recovered.delivery.consecutive_failures, 0);
    assert.equal(recovered.delivery.failed, 3, "failed is a total, not a run");
    assert.match(recovered.delivery.last_failure, /^HTTP 401/, "the last failure stays readable after recovery");
    assert.equal(recovered.last_error, null, "last_error keeps its meaning: a delivery clears it");
  } finally {
    console.error = realError;
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("status reads the outbox from another process: it fails after a run of refusals, passes once delivery is back, server running or stopped", async () => {
  const dir = dataDir();
  const env = readyEnv("http://127.0.0.1:9/hook");
  const db = AccountDb.open(accountPaths(dir, "default").databaseFile);
  let answer = 401;
  const sink = new WebhookSink(env, { post: async () => new Response(null, { status: answer }) });
  const outbox = new WebhookOutbox({
    db: () => db,
    sink: () => sink,
    payload: (event, message) => ({ event: event.kind, message_id: message.sid }),
    awaitingTranscript: () => false,
  });
  let keys = 0;
  const queue = (n) => {
    for (let i = 0; i < n; i++) {
      db.transaction(() => {
        const stored = db.messages.upsert({ chatJid: PEER, keyId: `K${++keys}`, fromMe: false, ts: Date.now(), type: "text", text: "salut" });
        db.events.enqueue({ kind: "message_received", lane: "chat:1", messageId: stored.id, payload: "{}", createdAt: Date.now() });
      });
    }
  };
  const realError = console.error;
  console.error = () => {};
  try {
    queue(3);
    outbox.kick();
    await outbox.idle();

    const failing = await status(dir, ["--json"], env);
    const check = JSON.parse(failing.stdout).checks.find((row) => row.name === "webhook");
    assert.equal(check.state, "fail");
    assert.match(
      check.detail,
      /^on \(127\.0\.0\.1:9\); 3 events failed in a row, the last at \S+: HTTP 401 from 127\.0\.0\.1:9, not retried/
    );
    assert.match(check.fix, /API key or secret it expects/);
    assert.match(check.fix, /wazap webhook test/);
    assert.ok(!failing.stdout.includes(SECRET));

    const human = await status(dir, [], env);
    assert.match(human.stderr, /✗ webhook: on \(127\.0\.0\.1:9\); 3 events failed in a row/);

    answer = 204;
    queue(1);
    outbox.kick();
    await outbox.idle();
    const running = await status(dir, ["--json"], env);
    assert.deepEqual(
      JSON.parse(running.stdout).checks.find((row) => row.name === "webhook"),
      { name: "webhook", state: "ok", detail: "on (127.0.0.1:9); 1 delivered, 3 failed" }
    );
  } finally {
    console.error = realError;
    await outbox.stop();
    db.close();
  }
  const stopped = await status(dir, ["--json"], env);
  assert.deepEqual(
    JSON.parse(stopped.stdout).checks.find((row) => row.name === "webhook"),
    { name: "webhook", state: "ok", detail: "on (127.0.0.1:9); 1 delivered, 3 failed" },
    "the same, read with the server stopped"
  );
});

test("doctor warns on a failure since the last delivery or an event retrying, and fails on three failures or 10 minutes of retries", () => {
  const env = readyEnv("https://hooks.example/wazap");
  const now = Date.parse("2026-09-15T12:00:00.000Z");
  const quiet = {
    delivered: 5,
    failed: 0,
    cancelled: 0,
    pending: 0,
    dropped: 0,
    consecutive_failures: 0,
    retrying: 0,
    last_success_at: "2026-09-15T11:00:00.000Z",
    last_failure_at: null,
    last_failure: null,
    last_status: null,
    last_dropped_at: null,
    oldest_pending_at: null,
  };
  assert.deepEqual(webhookCheck(env, [], now), { name: "webhook", state: "ok", detail: "on (hooks.example)" });
  assert.deepEqual(webhookCheck(env, [{ account: "default", delivery: { ...quiet, cancelled: 2, pending: 1 } }], now), {
    name: "webhook",
    state: "ok",
    detail: "on (hooks.example); 5 delivered, 2 cancelled, 1 pending",
  });

  const once = {
    ...quiet,
    failed: 1,
    consecutive_failures: 1,
    last_failure_at: "2026-09-15T11:30:00.000Z",
    last_failure: "timed out reaching hooks.example",
  };
  const flaky = webhookCheck(env, [{ account: "default", delivery: once }], now);
  assert.equal(flaky.state, "warn");
  assert.equal(
    flaky.detail,
    "on (hooks.example); the last event failed at 2026-09-15T11:30:00.000Z: timed out reaching hooks.example"
  );
  assert.match(flaky.fix, /reachable and answer 2xx/);

  const down = {
    ...quiet,
    pending: 12,
    retrying: 1,
    last_failure_at: "2026-09-15T11:59:00.000Z",
    last_failure: "HTTP 503 from hooks.example",
    last_status: 503,
    oldest_pending_at: "2026-09-15T11:59:00.000Z",
  };
  const retrying = webhookCheck(
    env,
    [
      { account: "default", delivery: quiet },
      { account: "work", delivery: down },
    ],
    now
  );
  assert.equal(retrying.state, "warn");
  assert.equal(
    retrying.detail,
    "on (hooks.example); work: retrying: 1 failed attempts, 12 events waiting, the oldest waiting 1 min: HTTP 503 from hooks.example"
  );
  assert.match(retrying.fix, /reachable and answer 2xx/);

  const blip = { ...down, retrying: 5, oldest_pending_at: "2026-09-15T11:59:54.000Z" };
  assert.equal(
    webhookCheck(env, [{ account: "work", delivery: blip }], now).state,
    "warn",
    "five quick retries six seconds into an outage are not yet broken delivery"
  );

  const stuck = { ...down, retrying: 1, oldest_pending_at: "2026-09-15T11:50:00.000Z" };
  assert.equal(webhookCheck(env, [{ account: "work", delivery: stuck }], now).state, "fail", "ten minutes of retries is");
  stuck.retrying = 3;
  stuck.oldest_pending_at = "2026-09-15T09:30:00.000Z";
  const broken = webhookCheck(env, [{ account: "work", delivery: stuck }], now);
  assert.equal(broken.state, "fail");
  assert.match(broken.detail, /retrying: 3 failed attempts, 12 events waiting, the oldest waiting 2 h 30 min: HTTP 503/);
});


test("history sync, an append and wazap's own sends queue no event; a live message is written with it, once", async () => {
  const server = await recorder();
  const restoreEnv = saveWebhookEnv(server.url, "all");
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-webhook-queue-",
    id: ME,
    name: "Răzvan",
    config: { readOnly: false },
  });
  sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
  sock.sendMessage = async (jid, content) => ({
    key: { remoteJid: jid, fromMe: true, id: "OWN" },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: content.text },
  });
  try {
    const old = Date.now() - 86_400_000;
    sock.ev.emit("messaging-history.set", {
      chats: [{ id: PEER }],
      contacts: [],
      messages: [textMessage("HIST1", "ieri", old), ownMessage("HIST2", "ok", { at: old })],
      isLatest: true,
    });
    sock.ev.emit("messages.upsert", { type: "append", messages: [textMessage("APPEND", "alaltăieri", old)] });
    await svc.sendMessage(PEER, "răspuns");
    sock.ev.emit("messages.upsert", { type: "append", messages: [ownMessage("OWN", "răspuns")] });
    sock.ev.emit("messages.upsert", { type: "notify", messages: [ownMessage("OWN", "răspuns")] });
    assert.deepEqual(outboxRows(svc), [], "nothing was queued");

    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("LIVE", "acum")] });
    // Written with the message, before anything could post it.
    assert.deepEqual(outboxRows(svc).map((row) => [row.kind, row.state]), [["message_received", "pending"]]);
    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("LIVE", "acum")] });
    await waitFor(() => server.received.length > 0, 3_000, "the live POST");
    await svc.outbox.idle();
    assert.deepEqual(outboxRows(svc).map((row) => [row.kind, row.state]), [["message_received", "delivered"]], "delivered twice by WhatsApp, queued once");
    assert.deepEqual(server.received.map((body) => body.message_id), [`false_${PEER}_LIVE`]);
  } finally {
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("the body is built when the event is posted: an edit and a transcript that landed while it waited go with it, a delete cancels it", async () => {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const server = await recorder();
  const restoreEnv = saveWebhookEnv(server.url, "all");
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-webhook-fresh-", id: ME, name: "Răzvan" });
  const posting = svc.webhook;
  // The connection event goes first and holds the line until the gate opens.
  svc.webhook = new WebhookSink(readyEnv(server.url, "all"), {
    post: async (url, init) => {
      if (JSON.parse(init.body).event === "connection") await gate;
      return fetch(url, init);
    },
  });
  try {
    svc.setStatus("disconnected");
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("EDIT", "prima versiune"), voiceNote("VOICE", 6), textMessage("GONE", "șters")],
    });
    sock.ev.emit("messages.update", [
      { key: { remoteJid: PEER, fromMe: false, id: "EDIT" }, update: { message: { editedMessage: { message: { conversation: "versiunea corectată" } } } } },
    ]);
    svc.db.messages.setTranscript(`false_${PEER}_VOICE`, "am uitat umbrela acasă");
    sock.ev.emit("messages.delete", { keys: [{ remoteJid: PEER, fromMe: false, id: "GONE" }] });
    release();
    await waitFor(() => server.received.length >= 3, 3_000, "the connection and the two message POSTs");
    await svc.outbox.idle();
    assert.deepEqual(
      server.received.map((body) => body.text ?? body.status),
      ["disconnected", "versiunea corectată", "am uitat umbrela acasă"]
    );
    assert.deepEqual(outboxRows(svc).map((row) => row.state), ["delivered", "delivered", "delivered", "cancelled"]);
  } finally {
    release();
    svc.webhook = posting;
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("message events name the sender's contact_id and E.164 phone, and a lid whose number is unknown has a contact_id only", async () => {
  const server = await recorder();
  const restoreEnv = saveWebhookEnv(server.url, "all");
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-webhook-identity-", id: ME, name: "Răzvan" });
  const group = "120363000000000009@g.us";
  const lid = "98765432109876@lid";
  try {
    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("IN", "salut")] });
    sock.ev.emit("messages.upsert", { type: "notify", messages: [ownMessage("OUT", "pa")] });
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: group, fromMe: false, id: "LID", participant: lid },
          messageTimestamp: Math.floor(Date.now() / 1000),
          message: { conversation: "din grup" },
        },
      ],
    });
    await waitFor(() => server.received.length === 3, 3_000, "the three message POSTs");
    const [received, sent, fromLid] = server.received;
    assert.equal(received.phone, "+40700000002");
    assert.equal(received.contact_id, svc.db.identity.contactIdOf(PEER));
    assert.equal(typeof received.contact_id, "number");
    assert.equal(received.from, "40700000002", "from is unchanged");
    assert.equal(sent.phone, "+40700000001", "the account itself sent it");
    assert.equal(sent.contact_id, svc.db.identity.contactIdOf(ME));
    assert.equal(fromLid.phone, null);
    assert.equal(fromLid.contact_id, svc.db.identity.contactIdOf(lid));
    assert.equal(typeof fromLid.contact_id, "number");

    const [view] = (await svc.readMessages(PEER, 10)).data.filter((message) => message.message_id === `false_${PEER}_IN`);
    assert.equal(view.sender.contact_id, received.contact_id, "read_messages names the same contact");
    assert.equal(view.sender.phone, "40700000002", "sender.phone is unchanged");
    const chat = (await svc.listChats("individual", 10)).data.find((row) => row.chat_id === PEER);
    assert.equal(chat.contact_id, received.contact_id);
    assert.equal(chat.phone, "+40700000002");
    const groupChat = (await svc.listChats("groups", 10)).data.find((row) => row.chat_id === group);
    assert.equal(groupChat.contact_id, undefined, "a group is nobody's contact");
    assert.equal(groupChat.phone, undefined);
  } finally {
    await svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("with WAZAP_PERSIST_HISTORY=0 a message event still waiting at a stop is cancelled at the next start, and its connection event still goes out", async () => {
  let up = false;
  const server = await recorder(() => (up ? 204 : 503));
  const restoreEnv = saveWebhookEnv(server.url, "all");
  const config = offlineConfig("wazap-webhook-ephemeral-", { persistHistory: false });
  const realError = console.error;
  console.error = () => {};
  try {
    const first = openService(WhatsAppService, config);
    const sock = fakeSocket();
    first.sockClient = sock;
    first.wireEvents(sock, ++first.generation);
    first.account = { id: ME, name: "Răzvan", number: ME.split("@")[0] };
    first.status = "connected";
    first.setStatus("disconnected");
    sock.ev.emit("messages.upsert", { type: "notify", messages: [textMessage("KEPT_NOWHERE", "salut")] });
    await waitFor(() => server.received.length >= 2, 3_000, "both events tried once");
    await first.stop();

    up = true;
    const second = openService(WhatsAppService, config);
    try {
      await second.bootStorage();
      await waitFor(() => outboxRows(second).every((row) => row.state !== "pending"), 3_000, "the outbox to settle");
      assert.deepEqual(
        outboxRows(second).map((row) => [row.kind, row.state]),
        [
          ["connection", "delivered"],
          ["message_received", "cancelled"],
        ]
      );
      assert.deepEqual(server.received.slice(2).map((body) => body.event), ["connection"], "the purged message was not posted");
    } finally {
      await second.stop();
    }
  } finally {
    console.error = realError;
    await server.close();
    restoreEnv();
  }
});

test("the echo of a draft wazap confirmed writes no message_sent event, even when it arrives after a restart", async () => {
  const dir = dataDir();
  const server = await recorder();
  const restoreEnv = saveWebhookEnv(server.url, "all");
  const serviceOn = () => {
    const connected = connectedService(WhatsAppService, {
      prefix: "wazap-webhook-own-",
      id: ME,
      name: "Răzvan",
      config: { dataDir: dir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0 },
    });
    connected.sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
    return connected;
  };
  const first = serviceOn();
  let second = null;
  try {
    const draft = await first.svc.draft({ kind: "text", chatId: PEER, text: "Te aștept." }, "session_a");
    let key = null;
    first.sock.relayMessage = async (_jid, _message, options) => {
      key = options.messageId;
      throw new Error("Connection Closed");
    };
    await assert.rejects(first.svc.confirm(draft.draft_id, "session_a"), { code: "SEND_OUTCOME_UNKNOWN" });
    await first.svc.stop();

    second = serviceOn();
    second.sock.ev.emit("messages.upsert", { type: "notify", messages: [ownMessage(key, "Te aștept.")] });
    second.sock.ev.emit("messages.upsert", { type: "notify", messages: [ownMessage("PHONE", "Te aștept.")] });
    assert.deepEqual(
      storageRows(second.svc, "SELECT e.kind, m.key_id FROM events e JOIN messages m ON m.id = e.message_id ORDER BY e.seq").map(
        (row) => [row.kind, row.key_id]
      ),
      [["message_sent", "PHONE"]],
      "the echo was stored and recognised in the same transaction, from the send the first run recorded"
    );
    await waitFor(() => server.received.length > 0, 3_000, "the phone's message_sent");
    await second.svc.outbox.idle();
    assert.deepEqual(server.received.map((body) => body.message_id), [`true_${PEER}_PHONE`]);
  } finally {
    await first.svc.stop();
    if (second !== null) await second.svc.stop();
    await server.close();
    restoreEnv();
  }
});


test("a voice note's event whose wait a restart cut short goes out with the words the next run transcribes", async () => {
  const dir = dataDir();
  const server = await recorder();
  const restoreEnv = saveWebhookEnv(server.url);
  const first = transcribingService("wazap-webhook-voice-restart-", { dataDir: dir, persistHistory: true });
  let releaseRun = () => {};
  const gate = new Promise((resolve) => {
    releaseRun = resolve;
  });
  first.svc.mediaBuffer = async () => Buffer.from("not really an ogg file");
  first.svc.transcriber = async () => {
    await gate;
    return { text: "prea târziu", language: "ro", duration_seconds: 6 };
  };
  const sid = `false_${PEER}_MID`;
  let second = null;
  try {
    first.sock.ev.emit("messages.upsert", { type: "notify", messages: [voiceNote("MID", 6)] });
    await waitFor(() => first.svc.db.transcripts.state(sid)?.running === true, 3_000, "the transcription to start");
    await first.svc.outbox.idle();
    assert.equal(server.received.length, 0, "the event waits for the words");
    // The process goes down mid-run: the note is still queued, its event still pending.
    transcribeWorker.unregister(first.svc.voice.transcribeSource);
    await first.svc.stop();
    releaseRun();
    await transcribeWorker.idle();

    second = transcribingService("wazap-webhook-voice-restart-", { dataDir: dir, persistHistory: true });
    second.svc.mediaBuffer = async () => Buffer.from("not really an ogg file");
    second.svc.transcriber = async () => ({ text: "am ajuns acasă", language: "ro", duration_seconds: 6 });
    // As start() boots: the outbox starts while the socket is still connecting.
    second.svc.status = "connecting";
    await second.svc.bootStorage();
    await sleep(1_500);
    assert.equal(server.received.length, 0, "a boot still connecting keeps the event waiting for the words");
    second.sock.ev.emit("connection.update", { connection: "open" });
    await waitFor(() => server.received.length > 0, 5_000, "the event after the restart");
    assert.deepEqual(
      server.received.map((body) => [body.message_id, body.text]),
      [[sid, "am ajuns acasă"]],
      "once, with the words the second run got"
    );
  } finally {
    releaseRun();
    await first.svc.stop();
    if (second !== null) await second.svc.stop();
    await server.close();
    restoreEnv();
  }
});

test("config webhook chats, tag, coalesce and retry-401 are stored and config prints them", async () => {
  const dir = dataDir();
  await wazap(dir, ["config", "webhook", "on"], {
    input: `${SECRET}\n`,
    env: { WAZAP_WEBHOOK_URL: "http://127.0.0.1:9/hook" },
  });
  const chats = await wazap(dir, ["config", "webhook", "chats", "+40 722 000 002,120363000000000001@g.us"]);
  assert.equal(chats.code, 0, chats.stderr);
  assert.match(chats.stderr, /webhook chats: 2 chats/);
  const tag = await wazap(dir, ["config", "webhook", "tag", "#Autopeloc"]);
  assert.equal(tag.code, 0, tag.stderr);
  assert.match(tag.stderr, /webhook tag: autopeloc/);
  const window = await wazap(dir, ["config", "webhook", "coalesce", "90"]);
  assert.equal(window.code, 0, window.stderr);
  assert.match(window.stderr, /90s quiet, delivered by 180s/);
  const retry = await wazap(dir, ["config", "webhook", "retry-401", "on"]);
  assert.equal(retry.code, 0, retry.stderr);
  const shown = await wazap(dir, ["config"]);
  assert.match(shown.stderr, /filter: tag autopeloc, 2 chats/);
  assert.match(shown.stderr, /coalesce: 90s quiet, by 180s/);
  assert.match(shown.stderr, /retry 401: on/);
  const env = parse(readFileSync(join(dir, ".env"), "utf8"));
  assert.equal(env.WAZAP_WEBHOOK_CHATS, "40722000002,120363000000000001@g.us");
  assert.equal(env.WAZAP_WEBHOOK_TAG, "autopeloc");
  assert.equal(env.WAZAP_WEBHOOK_COALESCE, "90");
  assert.equal(env.WAZAP_WEBHOOK_RETRY_401, "on");

  const cleared = await wazap(dir, ["config", "webhook", "filter", "off"]);
  assert.equal(cleared.code, 0, cleared.stderr);
  const after = parse(readFileSync(join(dir, ".env"), "utf8"));
  assert.equal(after.WAZAP_WEBHOOK_CHATS, undefined);
  assert.equal(after.WAZAP_WEBHOOK_TAG, undefined);
  assert.match((await wazap(dir, ["config"])).stderr, /filter: off/);
});

test("config webhook chats none with no tag is an empty filter, and a bad chat is refused", async () => {
  const dir = dataDir();
  await wazap(dir, ["config", "webhook", "on"], {
    input: `${SECRET}\n`,
    env: { WAZAP_WEBHOOK_URL: "http://127.0.0.1:9/hook" },
  });
  const none = await wazap(dir, ["config", "webhook", "chats", "none"]);
  assert.equal(none.code, 0, none.stderr);
  assert.equal(parse(readFileSync(join(dir, ".env"), "utf8")).WAZAP_WEBHOOK_CHATS, "");
  assert.match((await wazap(dir, ["config"])).stderr, /filter: empty/);
  const bad = await wazap(dir, ["config", "webhook", "chats", "hello"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /not a chat id or a phone number/);
  const tooLong = await wazap(dir, ["config", "webhook", "coalesce", "301"]);
  assert.equal(tooLong.code, 1);
  assert.match(tooLong.stderr, /1 to 300/);
});

test("config webhook --account stores the filter on that account, replacing the global one", async () => {
  const dir = dataDir();
  await wazap(dir, ["account", "add", "work"]);
  await wazap(dir, ["config", "webhook", "on"], {
    input: `${SECRET}\n`,
    env: { WAZAP_WEBHOOK_URL: "http://127.0.0.1:9/hook" },
  });
  await wazap(dir, ["config", "webhook", "tag", "global-tag"]);
  const local = await wazap(dir, ["config", "webhook", "tag", "autopeloc", "--account", "work"]);
  assert.equal(local.code, 0, local.stderr);
  const work = JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8")).accounts.find((account) => account.id === "work");
  assert.equal(work.webhook_tag, "autopeloc");
  assert.equal(work.webhook_chats, undefined);
  const shown = await wazap(dir, ["config", "--account", "work"]);
  assert.match(shown.stderr, /filter: tag autopeloc/);
  assert.doesNotMatch(shown.stderr, /global-tag/);
  const off = await wazap(dir, ["config", "webhook", "off", "--account", "work"]);
  assert.equal(off.code, 0, off.stderr);
  const cleared = JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8")).accounts.find((account) => account.id === "work");
  assert.equal(cleared.webhook_tag, undefined);
});
