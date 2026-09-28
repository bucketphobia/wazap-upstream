/**
 * Integration contract: a program built on wazap that runs it as the WhatsApp
 * channel of the businesses it serves.
 *
 * Such an integration runs one `wazap serve --http --host 127.0.0.1 --port
 * 8766` under its own supervisor, one registry account per customer slug, a
 * static bearer token (equal to wazap's WAZAP_WRITE_TOKEN), `wazap account
 * add` and `wazap logout --account` from its own code, and a signed webhook
 * back into its API. This file pins what it reads, the way it reads it:
 *
 * - the webhook: the three events, their fields, the 2000-character cut and
 *   the signature;
 * - the MCP handshake and SSE framing, the five tools and the result fields it
 *   parses, the error codes it sorts into "definitely not sent" and
 *   "ambiguous", the session-loss answers it recovers from, and the two CLI
 *   calls.
 *
 * docs/stability.md promises all of it ("The integration contract"). Changing
 * or removing an assertion here breaks integrations built on wazap, so it
 * needs a major version. A skipped test states something an integration
 * expects that wazap does not do today: its skip note names the gap, and its
 * body is the assertion to turn on once the gap closes.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DisconnectReason } from "baileys";

import { AccountHub } from "../dist/account-hub.js";
import { AccountRegistry, parseAccountId } from "../dist/accounts.js";
import { DraftStore } from "../dist/drafts.js";
import { socketFactory } from "../dist/pairing.js";
import { RateLimiter } from "../dist/ratelimit.js";
import { startHttpEndpoint } from "../dist/server.js";
import { registerTools } from "../dist/tools.js";
import { readWebhookSettings, WebhookSink } from "../dist/webhook.js";
import { asToolSource, fakeSocket, offlineConfig, spawnWazap, stubSockets, waitFor } from "./helpers.mjs";

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** An integration's customer slug is the wazap account id. */
const TENANT = "demo-salon";
/** The business owner's own WhatsApp: the linked account, and the self chat an owner-facing assistant listens on. */
const OWNER = "40721000111@s.whatsapp.net";
/** A customer writing to the business. */
const CLIENT = "40733000111@s.whatsapp.net";
const READ_TOKEN = "integration-contract-read-token";
const WRITE_TOKEN = "integration-contract-write-token";
const SECRET = "integration-contract-webhook-secret";

/** The protocol version and client info the integration initializes with. */
const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "integration", version: "1" };
/** Every get_status value the integration maps onto its own connection state. */
const CONNECTION_STATUSES = [
  "not_linked",
  "linking",
  "connecting",
  "connected",
  "disconnected",
  "logged_out",
  "session_corrupt",
  "auth_failure",
];
/** The confirm_send codes the integration reads as "definitely not sent"; ACCOUNT_RESTRICTED also means do not retry. */
const DEFINITELY_UNSENT = [
  "NOT_CONNECTED",
  "NOT_LINKED",
  "SESSION_EXPIRED",
  "SESSION_CORRUPT",
  "RATE_LIMITED",
  "DRAFT_EXPIRED",
  "ACCOUNT_RESTRICTED",
];
/** The arguments the integration passes to each tool it calls, and nothing else. */
const INTEGRATION_CALLS = {
  send_message: ["chat_id", "text", "account_id"],
  confirm_send: ["draft_id", "account_id"],
  manage_chat: ["chat_id", "action", "account_id"],
  link_account: ["phone", "account_id"],
  get_status: ["account_id"],
};
/** An instant the integration parses: ISO 8601 with seconds optional and an offset or Z. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** A direct chat, which the integration derives a customer's phone from. */
const DIRECT_CHAT = /^(\d{8,15})@s\.whatsapp\.net$/;
/** The events the integration routes on; wazap posts the last two only when asked. */
const INTEGRATION_EVENTS = "message_received,message_sent,connection";
const WEBHOOK_ENV = ["WAZAP_WEBHOOK", "WAZAP_WEBHOOK_URL", "WAZAP_WEBHOOK_SECRET", "WAZAP_WEBHOOK_EVENTS", "WAZAP_TRANSCRIBE"];

// ---------------------------------------------------------------------------
// The integration's side of the wire, reduced to what wazap has to satisfy.
// ---------------------------------------------------------------------------

/** A POST as the integration sends it: JSON that accepts SSE, the bearer token, the session id once there is one. */
function postAs(url, { token, session }, body) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (session !== undefined) headers["mcp-session-id"] = session;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
}

/** The first SSE `data:` line is the JSON-RPC envelope, and without one the integration gives up. */
function sseData(body) {
  const line = body.split("\n").find((candidate) => candidate.startsWith("data:"));
  assert.ok(line !== undefined, `the integration reads the first SSE data line and there is none: ${body.slice(0, 300)}`);
  return JSON.parse(line.slice("data:".length).trim());
}

function toolsCall(id, name, args) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

/** The integration's transport: initialize, echo the session id, then tools/call. */
function integrationClient(url, token) {
  let session;
  let nextId = 0;
  const post = (body) => postAs(url, { token, session }, body);
  return {
    get session() {
      return session;
    },
    post,
    nextId: () => ++nextId,
    async initialize() {
      session = undefined;
      const response = await post({
        jsonrpc: "2.0",
        id: ++nextId,
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      });
      const text = await response.text();
      assert.equal(response.status, 200, `initialize answered HTTP ${response.status}: ${text}`);
      const id = response.headers.get("mcp-session-id");
      assert.ok(id, "the integration refuses an initialize that carries no mcp-session-id");
      const envelope = sseData(text);
      assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
      assert.ok(envelope.result, "the integration refuses an initialize without a result");
      session = id;
      const initialized = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      await initialized.body?.cancel();
      assert.ok(initialized.ok || initialized.status === 202, `notifications/initialized answered ${initialized.status}`);
      return envelope.result;
    },
    async tool(name, args) {
      const response = await post(toolsCall(++nextId, name, args));
      const text = await response.text();
      assert.ok(response.ok, `tools/call ${name} answered HTTP ${response.status}: ${text}`);
      const envelope = sseData(text);
      assert.equal(envelope.error, undefined, `the integration reads a JSON-RPC error as a transport failure: ${text}`);
      assert.ok(envelope.result, `the integration refuses an answer without a result: ${text}`);
      return envelope.result;
    },
  };
}

function nonEmpty(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string, got ${JSON.stringify(value)}`);
  assert.ok(value.length > 0, `${label} must not be empty`);
}

/** The structuredContent of a call that worked. */
function answer(result, name) {
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.structuredContent ?? result.content)}`);
  assert.ok(result.structuredContent, `the integration parses structuredContent and ${name} has none`);
  return result.structuredContent;
}

/** A refusal as the integration parses it: `isError` with `{ error, message, fix? }`. Returns the code. */
function refusal(result) {
  assert.equal(result.isError, true, `expected a tool error, got ${JSON.stringify(result.structuredContent)}`);
  const body = result.structuredContent;
  nonEmpty(body?.error, "structuredContent.error");
  assert.equal(typeof body.message, "string");
  if (body.fix !== undefined) assert.equal(typeof body.fix, "string");
  return body.error;
}

// ---------------------------------------------------------------------------
// wazap under test: the real binary, or the real hub over one fake socket.
// ---------------------------------------------------------------------------

function cli(dataDir, args) {
  const { child, stderr } = spawnWazap({ dataDir, args });
  child.stdin.end();
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr: stderr.join("") }));
  });
}

/** Like cli, and keeps stdout too: what a script parses. */
function cliOut(dataDir, args) {
  const { child, stderr } = spawnWazap({ dataDir, args });
  const stdout = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  child.stdin.end();
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: stdout.join(""), stderr: stderr.join("") }));
  });
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const killed = sleep(5_000).then(() => child.kill("SIGKILL"));
  await Promise.race([exited, killed]);
}

/**
 * The environment is read by the service (transcription, at construction) and
 * by the webhook sink (at every event), so it is set before the hub is built
 * and put back once the test is done.
 */
function scopedEnv(t, values) {
  const saved = WEBHOOK_ENV.map((key) => [key, process.env[key]]);
  for (const key of WEBHOOK_ENV) delete process.env[key];
  Object.assign(process.env, { WAZAP_TRANSCRIBE: "off", ...values });
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** What `serve` builds: a registry holding the tenant's account, and a hub over every enabled account. */
function tenantHub(t, overrides = {}) {
  const config = offlineConfig("wazap-integration-", { readOnly: false, ...overrides });
  AccountRegistry.load(config.dataDir).add(TENANT);
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  const svc = hub.get(TENANT);
  assert.ok(svc, "the hub serves the tenant's account");
  t.after(async () => {
    await hub.stop();
    rmSync(config.dataDir, { recursive: true, force: true });
  });
  return { config, hub, svc };
}

/**
 * Give the tenant's service an open socket, the only part standing in for
 * WhatsApp. `sent` and `receipts` record what reached it: a confirmed draft is
 * relayed under the id it was drafted with, and `sent` keeps its text.
 */
function openSocket(svc) {
  const sock = fakeSocket();
  svc.sockClient = sock;
  svc.wireEvents(sock, ++svc.generation);
  svc.account = { id: OWNER, name: "Ana", number: OWNER.split("@")[0] };
  svc.status = "connected";
  svc.initialSyncDone = true;
  const sent = [];
  const receipts = [];
  sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
  sock.relayMessage = async (jid, message, { messageId }) => {
    sent.push({ jid, messageId, content: { text: message.extendedTextMessage?.text ?? message.conversation } });
    return messageId;
  };
  sock.readMessages = async (keys) => {
    receipts.push(...keys);
  };
  return { sock, sent, receipts };
}

/** The HTTP endpoint over the hub, with the two credentials runHttp builds from WAZAP_READ_TOKEN and WAZAP_WRITE_TOKEN. */
async function tenantEndpoint(t, hub, config) {
  const stop = new AbortController();
  t.after(() => stop.abort());
  const port = await startHttpEndpoint(hub, config, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    signal: stop.signal,
    credentials: [
      { token: READ_TOKEN, write: false },
      { token: WRITE_TOKEN, write: true },
    ],
  });
  return `http://127.0.0.1:${port}/mcp`;
}

function message(id, content, { chat = CLIENT, fromMe = false, at = Date.now() } = {}) {
  return {
    key: { remoteJid: chat, fromMe, id },
    messageTimestamp: Math.floor(at / 1000),
    message: typeof content === "string" ? { conversation: content } : content,
  };
}

function upsert(sock, type, ...messages) {
  sock.ev.emit("messages.upsert", { type, messages });
}

const closedWith = (statusCode) => ({
  connection: "close",
  lastDisconnect: { error: { message: "Connection Terminated", output: { statusCode } } },
});

/** The integration's webhook route: keeps the raw bytes it verifies, and answers 204 to everything. */
async function integrationWebhook(t) {
  const hits = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      hits.push({ headers: req.headers, raw, body: JSON.parse(raw.toString("utf8")) });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/hooks/whatsapp`, hits };
}

/** The receiver's check: HMAC-SHA256 of the raw request bytes, compared timing-safe against the header. */
function receiverVerifies(hit, secret = SECRET) {
  const header = hit.headers["x-wazap-signature"];
  if (typeof header !== "string") return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(hit.raw).digest("hex")}`);
  const offered = Buffer.from(header);
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

function assertUtcTimestamp(value, label = "timestamp") {
  nonEmpty(value, label);
  assert.match(value, INSTANT, `${label} must parse as an instant the integration accepts`);
  assert.equal(new Date(value).toISOString(), value, `${label} must be ISO 8601 in UTC`);
}

/** The fields every message event carries. */
function assertMessageEvent(hit) {
  const body = hit.body;
  assert.ok(receiverVerifies(hit), "the integration answers 401 to a body its secret does not sign");
  assert.ok(["message_received", "message_sent"].includes(body.event), body.event);
  for (const key of ["account_id", "chat_id", "from", "message_id", "account_name"]) nonEmpty(body[key], key);
  assert.equal(typeof body.text, "string");
  assert.equal(typeof body.from_me, "boolean");
  assert.equal(typeof body.is_self_chat, "boolean");
  assert.ok(["text", "audio", "image", "other"].includes(body.kind), `kind ${body.kind}`);
  assert.equal(typeof body.truncated, "boolean");
  assertUtcTimestamp(body.timestamp);
  // Additive since the durable outbox (design D9): the sender as a stable contact and a number, null when unknown.
  assert.ok("contact_id" in body, "every message event carries contact_id");
  assert.ok(body.contact_id === null || Number.isSafeInteger(body.contact_id), `contact_id ${body.contact_id}`);
  assert.ok("phone" in body, "every message event carries phone");
  assert.ok(body.phone === null || /^\+\d{8,15}$/.test(body.phone), `phone ${body.phone} is E.164`);
  return body;
}

/** The fields every connection event carries. */
function assertConnectionEvent(hit) {
  const body = hit.body;
  assert.ok(receiverVerifies(hit), "the integration answers 401 to a body its secret does not sign");
  assert.equal(body.event, "connection");
  nonEmpty(body.account_id, "account_id");
  assert.ok(["linked", "disconnected", "expired"].includes(body.status), `status ${body.status}`);
  assertUtcTimestamp(body.timestamp);
  // Additive: what WhatsApp says about the account itself, as get_status's health.
  assert.equal(typeof body.health?.state, "string", "every connection event carries health.state");
  assert.ok("until" in body.health && "reason" in body.health);
  return body;
}

// ---------------------------------------------------------------------------
// 1. MCP over HTTP, against the binary started the way the integration's supervisor starts it.
// ---------------------------------------------------------------------------

describe("Integration MCP transport: `wazap serve --http` with WAZAP_READ_TOKEN and WAZAP_WRITE_TOKEN", () => {
  let dataDir;
  let server;
  let url;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "wazap-integration-serve-"));
    const added = await cli(dataDir, ["account", "add", TENANT]);
    assert.equal(added.code, 0, added.stderr);
    const port = await freePort();
    server = spawnWazap({
      dataDir,
      args: ["serve", "--http", "--host", "127.0.0.1", "--port", String(port)],
      env: { WAZAP_READ_TOKEN: READ_TOKEN, WAZAP_WRITE_TOKEN: WRITE_TOKEN, WAZAP_NO_SHARE: "1" },
    });
    server.child.stdin.end();
    url = `http://127.0.0.1:${port}/mcp`;
    await waitFor(
      () =>
        fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) }).then(
          async (res) => (await res.body?.cancel(), true),
          () => false
        ),
      20_000,
      "wazap serve --http to answer"
    );
  });

  after(async () => {
    if (server) await stopChild(server.child);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test("initialize with the write token answers a session id and an SSE result; notifications/initialized is accepted", async () => {
    const client = integrationClient(url, WRITE_TOKEN);
    await client.initialize();
    nonEmpty(client.session, "mcp-session-id");
  });

  test("the write token's session has the five tools the integration calls, and none requires an argument the integration does not pass", async () => {
    const client = integrationClient(url, WRITE_TOKEN);
    await client.initialize();
    const response = await client.post({ jsonrpc: "2.0", id: client.nextId(), method: "tools/list" });
    assert.equal(response.status, 200);
    const { tools } = sseData(await response.text()).result;
    for (const [name, args] of Object.entries(INTEGRATION_CALLS)) {
      const listed = tools.find((tool) => tool.name === name);
      assert.ok(listed, `${name} is missing from a write-token session`);
      const properties = listed.inputSchema?.properties ?? {};
      for (const arg of args) assert.ok(arg in properties, `${name} no longer takes ${arg}`);
      for (const required of listed.inputSchema?.required ?? []) {
        assert.ok(args.includes(required), `${name} now requires ${required}, which the integration never sends`);
      }
    }
    const manage = tools.find((tool) => tool.name === "manage_chat");
    assert.ok(manage.inputSchema.properties.action.enum.includes("mark_read"), "manage_chat lost mark_read");
  });

  test("get_status for the tenant answers a status from the integration's eight, with status_since and the account_id", async () => {
    const client = integrationClient(url, WRITE_TOKEN);
    await client.initialize();
    const status = answer(await client.tool("get_status", { account_id: TENANT }), "get_status");
    assert.ok(CONNECTION_STATUSES.includes(status.status), `the integration's schema refuses status ${status.status}`);
    assert.equal(status.status, "not_linked", "an account that never linked is not_linked");
    nonEmpty(status.status_since, "status_since");
    assert.equal(status.account_id, TENANT);
  });

  test("a refused call is isError with structuredContent { error, message, fix }, including an unknown tenant", async () => {
    const client = integrationClient(url, WRITE_TOKEN);
    await client.initialize();
    const draft = await client.tool("send_message", { chat_id: CLIENT, text: "salut", account_id: TENANT });
    const code = refusal(draft);
    assert.equal(code, "NOT_LINKED");
    assert.ok(DEFINITELY_UNSENT.includes(code), "the integration retries a NOT_LINKED draft later");
    assert.equal(
      refusal(await client.tool("manage_chat", { chat_id: CLIENT, action: "mark_read", account_id: TENANT })),
      "NOT_LINKED"
    );
    // The integration's health probe counts any tool error as wazap answering.
    assert.equal(refusal(await client.tool("get_status", { account_id: "ghost-tenant" })), "ACCOUNT_NOT_FOUND");
  });

  test("a read-token session has no send tools, and calling one is isError with only a text block", async () => {
    const client = integrationClient(url, READ_TOKEN);
    await client.initialize();
    const result = await client.tool("send_message", { chat_id: CLIENT, text: "salut", account_id: TENANT });
    assert.equal(result.isError, true);
    assert.equal(typeof result.structuredContent?.error, "undefined", "the integration reads this form as TOOL_FAILED");
    assert.match(result.content?.[0]?.text ?? "", /send_message/);
  });

  test("a token wazap does not hold is 401, which the integration does not mistake for a lost session", async () => {
    const client = integrationClient(url, WRITE_TOKEN);
    await client.initialize();
    const response = await postAs(
      url,
      { token: "not-the-token", session: client.session },
      toolsCall(1, "get_status", { account_id: TENANT })
    );
    const body = await response.text();
    assert.equal(response.status, 401);
    assert.doesNotMatch(body, /Session not found|send initialize first/);
  });

  test("a lost session is 404 and no session is 400, each a JSON-RPC error, and initialize recovers", async () => {
    const client = integrationClient(url, WRITE_TOKEN);
    await client.initialize();
    const call = toolsCall(1, "get_status", { account_id: TENANT });

    // The status is the promise (docs/stability.md); the words are kept until 2.0 for an integration that still reads them.
    const lost = await postAs(url, { token: WRITE_TOKEN, session: randomUUID() }, call);
    assert.equal(lost.status, 404);
    const lostBody = await lost.text();
    assert.equal(JSON.parse(lostBody).error.code, -32001);
    assert.match(lostBody, /Session not found/);

    const none = await postAs(url, { token: WRITE_TOKEN }, call);
    assert.equal(none.status, 400);
    const noneBody = await none.text();
    assert.equal(JSON.parse(noneBody).error.code, -32000);
    assert.match(noneBody, /send initialize first/);

    await client.initialize();
    assert.equal(answer(await client.tool("get_status", { account_id: TENANT }), "get_status").account_id, TENANT);
  });

  test("an account added with `wazap account add` while serve runs can be linked without a restart", async () => {
    // Linking runs `account add` and then link_account in one request.
    const added = await cli(dataDir, ["account", "add", "late-tenant"]);
    assert.equal(added.code, 0, added.stderr);
    const client = integrationClient(url, WRITE_TOKEN);
    await client.initialize();
    // A malformed phone is refused before any socket opens, but only once the account resolved.
    const result = await client.tool("link_account", { phone: "not-a-phone", account_id: "late-tenant" });
    assert.notEqual(result.structuredContent?.error, "ACCOUNT_NOT_FOUND", result.structuredContent?.message);
  });

  test("`wazap logout --account <slug>` succeeds while serve holds the data dir", async () => {
    // The integration runs serve under its own supervisor and calls logout when a customer unlinks.
    const out = await cli(dataDir, ["logout", "--account", TENANT]);
    assert.equal(out.code, 0, out.stderr);
  });
});

// ---------------------------------------------------------------------------
// 2. The CLI, in a throwaway data dir with no server running.
// ---------------------------------------------------------------------------

describe("Integration CLI calls: `account add` and `logout --account`", () => {
  let dataDir;

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), "wazap-integration-cli-"));
  });

  after(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test("account add <slug> exits 0; adding it again exits non-zero with `already exists` on stderr", async () => {
    const first = await cli(dataDir, ["account", "add", TENANT]);
    assert.equal(first.code, 0, first.stderr);
    const again = await cli(dataDir, ["account", "add", TENANT]);
    assert.notEqual(again.code, 0, "the integration only tolerates a repeated add by its stderr");
    assert.match(again.stderr, /already exists/);
  });

  test("account add --json answers { account_id, created, enabled } on stdout, and an account already there is created: false with exit 0", async () => {
    const slug = "json-tenant";
    const first = await cliOut(dataDir, ["account", "add", slug, "--json"]);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), { account_id: slug, created: true, enabled: true });
    const again = await cliOut(dataDir, ["account", "add", slug, "--json"]);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(JSON.parse(again.stdout), { account_id: slug, created: false, enabled: true });
    const bad = await cliOut(dataDir, ["account", "add", "Not A Slug", "--json"]);
    assert.notEqual(bad.code, 0, "an id wazap refuses is still a failure");
    assert.equal(bad.stdout, "");
  });

  test("every slug the integration mints is an account id wazap accepts", async () => {
    const longest = `${"a".repeat(27)}-1000`;
    assert.equal(longest.length, 32);
    for (const slug of ["abc", "123", "salon", "salon-ana-2", longest]) assert.equal(parseAccountId(slug), slug);
    const added = await cli(dataDir, ["account", "add", longest]);
    assert.equal(added.code, 0, added.stderr);
  });

  test("--version --json is one JSON object on stdout with version, baileys and node; plain --version prints nothing on stdout", async () => {
    const json = await cliOut(dataDir, ["--version", "--json"]);
    assert.equal(json.code, 0, json.stderr);
    const version = JSON.parse(json.stdout);
    assert.equal(version.version, PACKAGE_VERSION);
    for (const key of ["version", "baileys", "node"]) assert.match(version[key], /^\d+\.\d+\.\d+/, key);
    assert.equal(json.stdout.trim().split("\n").length, 1, "one line, so a script reads it whole");

    const plain = await cliOut(dataDir, ["--version"]);
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stdout, "");
    assert.match(plain.stderr, new RegExp(PACKAGE_VERSION.replaceAll(".", "\\.")));
  });

  test("logout --account on an account that never linked exits 0", async () => {
    const out = await cli(dataDir, ["logout", "--account", TENANT]);
    assert.equal(out.code, 0, out.stderr);
  });

  test("logout --account on an account wazap does not have exits non-zero with `No account`", async () => {
    const out = await cli(dataDir, ["logout", "--account", "ghost-tenant"]);
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /No account/);
  });
});

// ---------------------------------------------------------------------------
// 3. The tools on a live account, through the real HTTP endpoint and the integration's transport.
// ---------------------------------------------------------------------------

describe("Integration tool calls on a linked tenant", () => {
  async function live(t, overrides) {
    // No webhook: a developer shell's WAZAP_WEBHOOK must not receive these messages.
    scopedEnv(t, {});
    const { config, hub, svc } = tenantHub(t, overrides);
    const socket = openSocket(svc);
    // The client wrote first, so the chat is known and has a message to mark read.
    upsert(socket.sock, "notify", message("IN1", "Bună, aveți loc mâine?"));
    const url = await tenantEndpoint(t, hub, config);
    return { svc, ...socket, url };
  }

  test("send_message drafts, confirm_send sends once, and each answers the fields the integration parses", async (t) => {
    const f = await live(t);
    const client = integrationClient(f.url, WRITE_TOKEN);
    await client.initialize();
    const text = "Da, mâine la 10:00.";

    const draft = answer(await client.tool("send_message", { chat_id: CLIENT, text, account_id: TENANT }), "send_message");
    nonEmpty(draft.draft_id, "draft_id");
    assert.equal(draft.account_id, TENANT);
    assert.equal(f.sent.length, 0, "a draft never reaches WhatsApp");

    const confirmed = answer(
      await client.tool("confirm_send", { draft_id: draft.draft_id, account_id: TENANT }),
      "confirm_send"
    );
    for (const key of ["message_id", "chat_id", "text", "timestamp"]) nonEmpty(confirmed[key], key);
    assert.equal(confirmed.chat_id, CLIENT);
    assert.equal(confirmed.text, text);
    assert.match(confirmed.timestamp, INSTANT);
    assert.equal(confirmed.message_id, `true_${CLIENT}_${f.sent[0].messageId}`, "the id the webhook would use for the same message");
    assert.equal(confirmed.account_id, TENANT);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].jid, CLIENT);
    assert.equal(f.sent[0].content.text, text);
  });

  test("a confirmed draft is spent: confirm_send again in the same session answers the same receipt and sends nothing", async (t) => {
    // The integration never confirms a draft twice in one session: it confirms once, and its
    // transport retries confirm_send only after the session is gone. A receipt it did read
    // would be the same receipt, with the same message_id.
    const f = await live(t);
    const client = integrationClient(f.url, WRITE_TOKEN);
    await client.initialize();
    const draft = answer(await client.tool("send_message", { chat_id: CLIENT, text: "salut", account_id: TENANT }), "draft");
    const args = { draft_id: draft.draft_id, account_id: TENANT };
    const first = answer(await client.tool("confirm_send", args), "confirm_send");
    const again = answer(await client.tool("confirm_send", args), "confirm_send again");
    for (const key of ["message_id", "chat_id", "text", "timestamp"]) assert.equal(again[key], first[key], key);
    assert.equal(again.already_sent, true);
    assert.equal(f.sent.length, 1);
  });

  test("after the integration re-initializes, confirm_send still owns the draft and sends it once", async (t) => {
    // The integration's transport retries confirm_send after the session it drafted in is
    // gone. The token is the identity, so the re-initialized session still owns the draft.
    const f = await live(t);
    const client = integrationClient(f.url, WRITE_TOKEN);
    await client.initialize();
    const draft = answer(await client.tool("send_message", { chat_id: CLIENT, text: "salut", account_id: TENANT }), "draft");
    await client.initialize();
    const confirmed = answer(
      await client.tool("confirm_send", { draft_id: draft.draft_id, account_id: TENANT }),
      "confirm_send after re-init"
    );
    nonEmpty(confirmed.message_id, "message_id");
    assert.equal(f.sent.length, 1, "the retried confirm sends the draft once");
    const again = answer(await client.tool("confirm_send", { draft_id: draft.draft_id, account_id: TENANT }), "replay");
    assert.equal(again.already_sent, true);
    assert.equal(f.sent.length, 1);
  });

  test("confirm_send on a socket that is not usable answers a definitely-unsent code, sends nothing and keeps the draft", async (t) => {
    const f = await live(t);
    const client = integrationClient(f.url, WRITE_TOKEN);
    await client.initialize();
    const draft = answer(await client.tool("send_message", { chat_id: CLIENT, text: "salut", account_id: TENANT }), "draft");
    const args = { draft_id: draft.draft_id, account_id: TENANT };
    for (const status of CONNECTION_STATUSES.filter((value) => value !== "connected")) {
      f.svc.status = status;
      const code = refusal(await client.tool("confirm_send", args));
      assert.ok(DEFINITELY_UNSENT.includes(code), `a ${status} socket answered ${code}, which the integration reads as ambiguous`);
      assert.equal(f.sent.length, 0, `a ${status} socket must not send`);
    }
    f.svc.status = "connected";
    answer(await client.tool("confirm_send", args), "confirm_send after the socket came back");
    assert.equal(f.sent.length, 1);
  });

  test("a send that fails once handed to the socket is SEND_OUTCOME_UNKNOWN, which the integration files as ambiguous, and is never sent again", async (t) => {
    const f = await live(t);
    const client = integrationClient(f.url, WRITE_TOKEN);
    await client.initialize();
    const draft = answer(await client.tool("send_message", { chat_id: CLIENT, text: "salut", account_id: TENANT }), "draft");
    const args = { draft_id: draft.draft_id, account_id: TENANT };
    const answers = f.sock.relayMessage;
    let attempts = 0;
    f.sock.relayMessage = async () => {
      attempts++;
      throw new Error("Timed Out");
    };
    const code = refusal(await client.tool("confirm_send", args));
    assert.equal(code, "SEND_OUTCOME_UNKNOWN");
    assert.ok(!DEFINITELY_UNSENT.includes(code), "the integration must record it as unknown and never retry it");
    f.sock.relayMessage = answers;
    assert.equal(refusal(await client.tool("confirm_send", args)), "SEND_OUTCOME_UNKNOWN");
    assert.equal(attempts, 1);
    assert.equal(f.sent.length, 0);
  });

  test("a stop while the send is with WhatsApp never answers a definitely-unsent code", async (t) => {
    const f = await live(t);
    const client = integrationClient(f.url, WRITE_TOKEN);
    await client.initialize();
    const draft = answer(await client.tool("send_message", { chat_id: CLIENT, text: "salut", account_id: TENANT }), "draft");
    let handed = false;
    let fail;
    f.sock.relayMessage = () => {
      handed = true;
      return new Promise((_resolve, reject) => (fail = reject));
    };
    const pending = client.tool("confirm_send", { draft_id: draft.draft_id, account_id: TENANT });
    await waitFor(() => handed, 3_000, "the send handed to the socket");
    await f.svc.stop();
    fail(new Error("Connection Closed"));
    const code = refusal(await pending);
    assert.ok(!DEFINITELY_UNSENT.includes(code), `${code} would make the integration draft the message again`);
    assert.equal(code, "SEND_OUTCOME_UNKNOWN");
  });

  test("a number lookup WhatsApp does not answer refuses the draft with NOT_CONNECTED, never NOT_ON_WHATSAPP", async (t) => {
    const f = await live(t);
    const client = integrationClient(f.url, WRITE_TOKEN);
    await client.initialize();
    f.sock.onWhatsApp = async () => {
      throw new Error("Timed Out");
    };
    const stranger = "40733000999@s.whatsapp.net";
    const code = refusal(await client.tool("send_message", { chat_id: stranger, text: "salut", account_id: TENANT }));
    assert.equal(code, "NOT_CONNECTED");
    assert.ok(DEFINITELY_UNSENT.includes(code), "the integration retries it later instead of failing the message for good");
    assert.equal(f.sent.length, 0);
  });

  test("the account's write budget refuses with RATE_LIMITED before anything is sent", async (t) => {
    const f = await live(t, { rateLimitPerMinute: 1 });
    const client = integrationClient(f.url, WRITE_TOKEN);
    await client.initialize();
    for (const text of ["unu", "doi"]) {
      const draft = answer(await client.tool("send_message", { chat_id: CLIENT, text, account_id: TENANT }), "draft");
      const result = await client.tool("confirm_send", { draft_id: draft.draft_id, account_id: TENANT });
      if (text === "unu") answer(result, "the first confirm_send");
      else assert.equal(refusal(result), "RATE_LIMITED");
    }
    assert.ok(DEFINITELY_UNSENT.includes("RATE_LIMITED"));
    assert.equal(f.sent.length, 1);
  });

  test("a draft past its lifetime is DRAFT_EXPIRED and sends nothing", async (t) => {
    const f = await live(t);
    let now = Date.now();
    f.svc.drafts = new DraftStore(() => now);
    const client = integrationClient(f.url, WRITE_TOKEN);
    await client.initialize();
    const draft = answer(await client.tool("send_message", { chat_id: CLIENT, text: "salut", account_id: TENANT }), "draft");
    now += 16 * 60_000;
    assert.equal(refusal(await client.tool("confirm_send", { draft_id: draft.draft_id, account_id: TENANT })), "DRAFT_EXPIRED");
    assert.equal(f.sent.length, 0);
  });

  test("manage_chat mark_read answers { chat_id, action: mark_read, applied } and sends the read receipt", async (t) => {
    const f = await live(t);
    const client = integrationClient(f.url, WRITE_TOKEN);
    await client.initialize();
    const applied = answer(
      await client.tool("manage_chat", { chat_id: CLIENT, action: "mark_read", account_id: TENANT }),
      "manage_chat"
    );
    assert.equal(applied.chat_id, CLIENT);
    assert.equal(applied.action, "mark_read", "the integration refuses a result whose action is not the one it asked for");
    nonEmpty(applied.applied, "applied");
    assert.deepEqual(
      f.receipts.map((key) => key.id),
      ["IN1"]
    );
  });

  test("mark_read has a budget of its own: with the sends' spent it still answers, and its own runs out apart", async (t) => {
    const f = await live(t, { rateLimitPerMinute: 1 });
    const client = integrationClient(f.url, WRITE_TOKEN);
    await client.initialize();
    const send = async (text) => {
      const draft = answer(await client.tool("send_message", { chat_id: CLIENT, text, account_id: TENANT }), "draft");
      return client.tool("confirm_send", { draft_id: draft.draft_id, account_id: TENANT });
    };
    answer(await send("prima"), "confirm_send");
    assert.equal(refusal(await send("a doua")), "RATE_LIMITED", "the sends' budget of 1 is spent");
    const markRead = () => client.tool("manage_chat", { chat_id: CLIENT, action: "mark_read", account_id: TENANT });
    assert.equal(answer(await markRead(), "manage_chat").action, "mark_read", "a read mark does not wait on the sends' budget");

    assert.equal(f.svc.readMarks.perMinute, 3, "three times the account's writes a minute");

    // Its own bucket, on a clock that does not move, so the test does not race the refill.
    f.svc.readMarks = new RateLimiter(1, () => 0, "Read mark");
    answer(await markRead(), "manage_chat");
    const refused = await markRead();
    assert.equal(refusal(refused), "RATE_LIMITED");
    assert.match(refused.structuredContent.message, /^Read mark rate limit/);
  });

  test("get_status follows the socket through connected, disconnected and logged_out, all in the integration's eight", async (t) => {
    const f = await live(t);
    // A disconnect schedules a reconnect; this one must not open a real socket.
    f.svc.start = async () => {};
    const client = integrationClient(f.url, WRITE_TOKEN);
    await client.initialize();
    const status = async () => {
      const body = answer(await client.tool("get_status", { account_id: TENANT }), "get_status");
      assert.ok(CONNECTION_STATUSES.includes(body.status), `the integration's schema refuses status ${body.status}`);
      nonEmpty(body.status_since, "status_since");
      return body.status;
    };

    assert.equal(await status(), "connected");
    f.sock.ev.emit("connection.update", closedWith(DisconnectReason.connectionClosed));
    assert.equal(await status(), "disconnected");
    const next = fakeSocket();
    f.svc.wireEvents(next, ++f.svc.generation);
    next.ev.emit("connection.update", closedWith(DisconnectReason.loggedOut));
    assert.equal(await status(), "logged_out");
  });
});

// ---------------------------------------------------------------------------
// 4. Pairing: link_account, then the phone enters the code.
// ---------------------------------------------------------------------------

describe("Integration pairing: link_account → linking → connection linked", () => {
  /**
   * One test on purpose: link_account has a process-wide budget of two calls a
   * minute, and the third call is itself part of the contract.
   */
  test("connecting, not_linked, the code and its expiry, linking, the linked webhook, ALREADY_LINKED, RATE_LIMITED", async (t) => {
    const hook = await integrationWebhook(t);
    scopedEnv(t, {
      WAZAP_WEBHOOK: "on",
      WAZAP_WEBHOOK_URL: hook.url,
      WAZAP_WEBHOOK_SECRET: SECRET,
      WAZAP_WEBHOOK_EVENTS: INTEGRATION_EVENTS,
    });
    const { config, hub, svc } = tenantHub(t);
    const url = await tenantEndpoint(t, hub, config);
    const client = integrationClient(url, WRITE_TOKEN);
    await client.initialize();
    const status = async () => answer(await client.tool("get_status", { account_id: TENANT }), "get_status").status;

    assert.equal(await status(), "connecting", "a service that has not started yet");
    await svc.start();
    assert.equal(await status(), "not_linked", "no credentials");

    // The socket the service opens once the pairing lands.
    svc.start = async () => {
      const sock = fakeSocket();
      svc.sockClient = sock;
      svc.wireEvents(sock, ++svc.generation);
      sock.ev.emit("connection.update", { connection: "open" });
    };
    const phoneSide = fakeSocket({ pairingCode: "K7PX3MQZ", user: { id: "40721000111:12@s.whatsapp.net", name: "Ana" } });
    const pairing = stubSockets(socketFactory, [phoneSide]);
    t.after(() => {
      if (!phoneSide.ended) phoneSide.end();
      pairing.restore();
    });
    const linking = client.tool("link_account", { phone: "+40721000111", account_id: TENANT });
    await waitFor(() => pairing.opened.length > 0, 5_000, "the pairing socket to open");
    phoneSide.ev.emit("connection.update", { qr: "pairing-qr" });
    const code = answer(await linking, "link_account");
    nonEmpty(code.code, "code");
    nonEmpty(code.phone_masked, "phone_masked");
    assert.match(code.expires_at, INSTANT, "the integration's instant parser must accept expires_at");
    assert.ok(Date.parse(code.expires_at) > Date.now(), "a fresh code expires in the future");
    assert.equal(code.account_id, TENANT);

    assert.equal(await status(), "linking");

    phoneSide.ev.emit("connection.update", { connection: "open" });
    await waitFor(() => hook.hits.some((hit) => hit.body.event === "connection"), 5_000, "the connection webhook");
    const linked = assertConnectionEvent(hook.hits.find((hit) => hit.body.event === "connection"));
    assert.equal(linked.status, "linked");
    assert.equal(linked.account_id, TENANT);
    assert.equal(await status(), "connected");

    const again = await client.tool("link_account", { phone: "+40721000111", account_id: TENANT });
    assert.equal(refusal(again), "ALREADY_LINKED");
    const third = await client.tool("link_account", { phone: "+40721000111", account_id: TENANT });
    assert.equal(refusal(third), "RATE_LIMITED");
  });
});

// ---------------------------------------------------------------------------
// 5. The webhook.
// ---------------------------------------------------------------------------

describe("Integration webhook: the events and fields it parses", () => {
  async function hooked(t) {
    const hook = await integrationWebhook(t);
    scopedEnv(t, {
      WAZAP_WEBHOOK: "on",
      WAZAP_WEBHOOK_URL: hook.url,
      WAZAP_WEBHOOK_SECRET: SECRET,
      WAZAP_WEBHOOK_EVENTS: INTEGRATION_EVENTS,
    });
    const { hub, svc } = tenantHub(t);
    return { hook, hub, svc };
  }

  /** Nothing else is in flight once `count` events arrived and a beat passed. */
  async function settled(hook, count, label) {
    await waitFor(() => hook.hits.length >= count, 5_000, label);
    await sleep(100);
  }

  test("an integration's wazap has to opt in to message_sent and connection; a loopback http URL is accepted", () => {
    const url = "http://127.0.0.1:8080/hooks/whatsapp";
    const base = { WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_URL: url, WAZAP_WEBHOOK_SECRET: SECRET };
    const unset = readWebhookSettings(base);
    assert.equal(unset.kind, "ready");
    assert.equal(unset.url, url);
    assert.deepEqual(unset.events, ["message_received"], "unset is message_received only");
    for (const events of [INTEGRATION_EVENTS, "all"]) {
      assert.deepEqual(readWebhookSettings({ ...base, WAZAP_WEBHOOK_EVENTS: events }).events, [
        "message_received",
        "message_sent",
        "connection",
      ]);
    }
  });

  test("message_received carries every field the integration parses, signed over the raw bytes with the secret", async (t) => {
    const { hook, svc } = await hooked(t);
    const { sock } = openSocket(svc);
    const at = Date.parse("2026-09-16T08:30:05.000Z");
    upsert(sock, "notify", message("CLIENT1", "Bună ziua, aveți loc mâine la 10? Mulțumesc!", { at }));
    await settled(hook, 1, "the message_received POST");

    assert.equal(hook.hits.length, 1);
    const hit = hook.hits[0];
    assert.match(hit.headers["x-wazap-signature"], /^sha256=[0-9a-f]{64}$/);
    assert.match(hit.headers["content-type"], /^application\/json/);
    const body = assertMessageEvent(hit);
    assert.equal(body.event, "message_received");
    assert.equal(body.account_id, TENANT);
    assert.equal(body.chat_id, CLIENT);
    assert.match(body.chat_id, DIRECT_CHAT, "the integration derives the customer's phone from a direct chat id");
    assert.equal(body.message_id, `false_${CLIENT}_CLIENT1`);
    assert.equal(body.text, "Bună ziua, aveți loc mâine la 10? Mulțumesc!");
    assert.equal(body.from_me, false);
    assert.equal(body.is_self_chat, false);
    assert.equal(body.kind, "text");
    assert.equal(body.truncated, false);
    assert.equal(body.timestamp, "2026-09-16T08:30:05.000Z", "the message's own instant, in UTC");
    assert.equal(receiverVerifies(hit, "another-secret"), false);
    assert.equal(body.phone, "+40733000111", "the client's number in E.164");
    assert.ok(Number.isSafeInteger(body.contact_id), "a stable id for the client");
  });

  test("a text over 2000 characters arrives as 2000, ending in …, with truncated: true", async (t) => {
    const { hook, svc } = await hooked(t);
    const { sock } = openSocket(svc);
    upsert(sock, "notify", message("LONG", "ă".repeat(2500)));
    await settled(hook, 1, "the long message POST");
    const body = assertMessageEvent(hook.hits[0]);
    assert.equal(body.text.length, 2000);
    assert.ok(body.text.endsWith("…"));
    assert.equal(body.truncated, true);
  });

  test("a message typed on the phone is message_sent with from_me; in the owner's self chat it is also is_self_chat", async (t) => {
    const { hook, svc } = await hooked(t);
    const { sock } = openSocket(svc);
    upsert(sock, "notify", message("PHONE1", "Vin eu la 10.", { fromMe: true }));
    await settled(hook, 1, "the takeover message_sent POST");
    upsert(sock, "notify", message("SELF1", "azi", { chat: OWNER, fromMe: true }));
    await settled(hook, 2, "the self-chat message_sent POST");

    const [takeover, self] = hook.hits.map(assertMessageEvent);
    assert.equal(takeover.event, "message_sent");
    assert.equal(takeover.from_me, true);
    assert.equal(takeover.is_self_chat, false, "the integration routes this to human takeover");
    assert.equal(takeover.chat_id, CLIENT);
    assert.equal(self.event, "message_sent");
    assert.equal(self.from_me, true);
    assert.equal(self.is_self_chat, true, "the integration routes this to the owner-facing assistant");
    assert.equal(self.chat_id, OWNER);
  });

  test("a message wazap sent through send_message and confirm_send produces no message_sent, however Baileys echoes it", async (t) => {
    const { hook, hub, svc } = await hooked(t);
    const { sock, sent } = openSocket(svc);
    const tools = new Map();
    registerTools({ registerTool: (name, _meta, handler) => tools.set(name, handler) }, asToolSource(hub), {
      allowWrite: true,
    });
    const draft = await tools.get("send_message")({ chat_id: CLIENT, text: "Te aștept.", account_id: TENANT });
    const confirmed = await tools.get("confirm_send")({ draft_id: draft.structuredContent.draft_id, account_id: TENANT });
    assert.equal(confirmed.isError, undefined, JSON.stringify(confirmed.structuredContent));
    assert.equal(sent.length, 1);

    const echo = message(sent[0].messageId, "Te aștept.", { fromMe: true });
    upsert(sock, "append", echo);
    upsert(sock, "notify", echo);
    upsert(sock, "notify", message("AFTER", "Mulțumesc"));
    await settled(hook, 1, "the inbound that follows the echo");

    assert.deepEqual(
      hook.hits.map((hit) => hit.body.event),
      ["message_received"],
      "the integration must not hear its own reply as a takeover"
    );
  });

  test("history sync produces no events", async (t) => {
    const { hook, svc } = await hooked(t);
    const { sock } = openSocket(svc);
    const old = Date.now() - 86_400_000;
    sock.ev.emit("messaging-history.set", {
      chats: [{ id: CLIENT }],
      contacts: [],
      messages: [message("HIST1", "ieri", { at: old }), message("HIST2", "ok", { fromMe: true, at: old })],
      isLatest: true,
    });
    upsert(sock, "append", message("HIST3", "alaltăieri", { at: old }));
    upsert(sock, "notify", message("LIVE", "acum"));
    await settled(hook, 1, "the live message after the history");
    assert.deepEqual(
      hook.hits.map((hit) => hit.body.message_id),
      [`false_${CLIENT}_LIVE`]
    );
  });

  test("kind is text, audio, image or other", async (t) => {
    const { hook, svc } = await hooked(t);
    const { sock } = openSocket(svc);
    upsert(
      sock,
      "notify",
      message("IMG", { imageMessage: { mimetype: "image/jpeg", caption: "tunsoarea asta" } }),
      message("VOICE", { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: 4 } }),
      message("VID", { videoMessage: { mimetype: "video/mp4", seconds: 3 } })
    );
    await settled(hook, 3, "the three media POSTs");
    const kinds = Object.fromEntries(hook.hits.map(assertMessageEvent).map((body) => [body.message_id, body.kind]));
    assert.deepEqual(kinds, {
      [`false_${CLIENT}_IMG`]: "image",
      [`false_${CLIENT}_VOICE`]: "audio",
      [`false_${CLIENT}_VID`]: "other",
    });
  });

  test("connection posts linked, disconnected and expired for the tenant, signed, with a UTC timestamp", async (t) => {
    const { hook, svc } = await hooked(t);
    svc.start = async () => {};
    const sock = fakeSocket();
    svc.wireEvents(sock, ++svc.generation);

    sock.ev.emit("connection.update", { connection: "open" });
    await settled(hook, 1, "linked");
    sock.ev.emit("connection.update", closedWith(DisconnectReason.connectionClosed));
    await settled(hook, 2, "disconnected");
    sock.ev.emit("connection.update", closedWith(DisconnectReason.loggedOut));
    await settled(hook, 3, "expired");

    const bodies = hook.hits.map(assertConnectionEvent);
    assert.deepEqual(
      bodies.map((body) => body.status),
      ["linked", "disconnected", "expired"]
    );
    for (const body of bodies) assert.equal(body.account_id, TENANT);
  });

  test("a restriction that comes and goes while linked is a connection event with health; a ban is expired with health banned", async (t) => {
    const { hook, svc } = await hooked(t);
    svc.start = async () => {};
    const sock = fakeSocket();
    svc.wireEvents(sock, ++svc.generation);

    sock.ev.emit("connection.update", { connection: "open" });
    await settled(hook, 1, "linked");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const restrictedAt = Date.now();
    sock.ev.emit("connection.update", { reachoutTimeLock: { isActive: true, enforcementType: "DEFAULT" } });
    await settled(hook, 2, "linked, restricted");
    sock.ev.emit("connection.update", { reachoutTimeLock: { isActive: false } });
    await settled(hook, 3, "linked, lifted");
    sock.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { message: "Connection Failure", output: { statusCode: 403 }, data: { reason: "403" } } },
    });
    await settled(hook, 4, "expired, banned");

    const bodies = hook.hits.map(assertConnectionEvent);
    assert.deepEqual(
      bodies.map((body) => `${body.status}/${body.health.state}`),
      ["linked/ok", "linked/reachout_restricted", "linked/ok", "expired/banned"]
    );
    // The link did not move: the restriction is dated when it came, not when the link came up.
    assert.ok(Date.parse(bodies[1].timestamp) >= restrictedAt, "a health change is dated when it happened");
  });

  test("`wazap webhook test --account <slug>` posts bodies the integration accepts, with the probe chat the integration ignores", async () => {
    const posts = [];
    const sink = new WebhookSink(
      {
        WAZAP_WEBHOOK: "on",
        WAZAP_WEBHOOK_URL: "http://127.0.0.1:8080/hooks/whatsapp",
        WAZAP_WEBHOOK_SECRET: SECRET,
        WAZAP_WEBHOOK_EVENTS: INTEGRATION_EVENTS,
      },
      {
        account: { id: TENANT, name: TENANT },
        post: async (_url, init) => {
          const raw = Buffer.from(init.body, "utf8");
          posts.push({ headers: init.headers, raw, body: JSON.parse(init.body) });
          return new Response(null, { status: 204 });
        },
      }
    );
    for (const event of ["message_received", "message_sent", "connection"]) {
      assert.deepEqual(await sink.sendTest(event), { ok: true });
    }
    const [received, sent, connection] = posts;
    assert.equal(assertMessageEvent(received).event, "message_received");
    assert.equal(assertMessageEvent(sent).event, "message_sent");
    assert.equal(assertConnectionEvent(connection).status, "linked");
    for (const hit of [received, sent, connection]) assert.equal(hit.body.account_id, TENANT);
    assert.equal(received.body.chat_id, "test@s.whatsapp.net");
    assert.doesNotMatch(received.body.chat_id, DIRECT_CHAT, "the integration routes the probe to ignore, with no client");
  });
});
