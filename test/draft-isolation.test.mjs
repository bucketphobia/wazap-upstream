import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { registerTools } from "../dist/tools.js";
import { createToolRegistrar } from "../dist/tool-runtime.js";
import { WazapError } from "../dist/errors.js";
import { writeDaemon } from "../dist/daemon.js";
import { startHttpEndpoint } from "../dist/server.js";
import { asToolSource, childEnv, draftStub, mcpClient, offlineConfig } from "./helpers.mjs";

const CHAT = "40722123456@s.whatsapp.net";
const CASES = [
  ["send_message", { chat_id: CHAT, text: "hello" }],
  ["send_message", { chat_id: CHAT, text: "", file_path: "/unused/stub.png" }],
  ["send_message", { chat_id: CHAT, text: "Lunch?", options: ["yes", "no"] }],
  ["send_message", { chat_id: CHAT, text: "", latitude: 44, longitude: 26 }],
  ["send_message", { chat_id: CHAT, text: "", forward: `false_${CHAT}_message` }],
];
const KINDS = ["text", "media", "poll", "location", "forward"];

function fixture({ now, beforeConfirm } = {}) {
  const store = draftStub(now);
  const receipts = new Map();
  let confirms = 0;
  let sends = 0;
  const wa = {
    getStatus: () => ({ status: "connected", status_since: new Date().toISOString(), read_only: false }),
    draft: async (payload) => store.view(store.put({ chat_id: CHAT, name: "Test" }, payload)),
    // The service's contract: a draft is sent once, and confirming it again answers that send's receipt.
    confirm: async (id) => {
      confirms++;
      await beforeConfirm?.();
      if (receipts.has(id)) return { ...receipts.get(id), already_sent: true };
      const draft = store.take(id);
      sends++;
      const receipt = { chat_id: CHAT, message_id: "sent", text: draft.preview, timestamp: "now" };
      receipts.set(id, receipt);
      return receipt;
    },
  };
  const hub = asToolSource(wa);
  function client(opts = {}) {
    const tools = new Map();
    registerTools({ registerTool: (name, _meta, handler) => tools.set(name, handler) }, hub, { allowWrite: true, ...opts });
    return (name, args) => tools.get(name)(args);
  }
  return { hub, wa, store, client, confirms: () => confirms, sends: () => sends };
}

for (const [index, [name, args]] of CASES.entries()) {
  test(`${name} (${KINDS[index]}): another registration cannot confirm or consume the owner's draft`, async () => {
    const f = fixture();
    const owner = f.client();
    const other = f.client();
    const draft = await owner(name, args);
    assert.equal(draft.structuredContent.status, "draft");
    const id = draft.structuredContent.draft_id;
    for (const extra of [{}, { account_id: "default" }, { account_id: "nonexistent" }]) {
      const denied = await other("confirm_send", { draft_id: id, ...extra });
      assert.equal(denied.structuredContent.error, "DRAFT_NOT_FOUND");
      assert.equal(f.confirms(), 0);
    }
    assert.equal((await owner("confirm_send", { draft_id: id })).structuredContent.message_id, "sent");
    assert.equal(f.confirms(), 1);
    const replay = await owner("confirm_send", { draft_id: id });
    assert.equal(replay.structuredContent.message_id, "sent", "the owner's replay answers the receipt");
    assert.equal(replay.structuredContent.already_sent, true);
    assert.match(replay.content[0].text, /^Already sent to .*; nothing was sent again:/);
    assert.equal(f.sends(), 1, "a replay sends nothing");
    assert.equal((await other("confirm_send", { draft_id: id })).structuredContent.error, "DRAFT_NOT_FOUND");
    assert.equal(f.confirms(), 2, "another registration's replay never reaches the service");
  });
}

test("registrations naming one draft identity own its drafts; another identity does not", async () => {
  const f = fixture();
  const owner = f.client({ draftIdentity: "cred-a" });
  const same = f.client({ draftIdentity: "cred-a" });
  const other = f.client({ draftIdentity: "cred-b" });
  const draft = await owner(...CASES[0]);
  const args = { draft_id: draft.structuredContent.draft_id };
  assert.equal((await other("confirm_send", args)).structuredContent.error, "DRAFT_NOT_FOUND");
  assert.equal(f.confirms(), 0);
  assert.equal((await same("confirm_send", args)).structuredContent.message_id, "sent");
  assert.equal(f.confirms(), 1);
});

test("an unowned service draft fails closed even without send rules", async () => {
  const f = fixture();
  const draft = await f.wa.draft({ kind: "text", chatId: CHAT, text: "orphan" });
  assert.equal(
    (await f.client()("confirm_send", { draft_id: draft.draft_id })).structuredContent.error,
    "DRAFT_NOT_FOUND"
  );
  assert.equal(f.confirms(), 0);
});

test("wrong account cannot redirect an owned draft, and failure preserves it", async () => {
  const f = fixture();
  const owner = f.client();
  const draft = await owner(...CASES[0]);
  const args = { draft_id: draft.structuredContent.draft_id };
  assert.equal(
    (await owner("confirm_send", { ...args, account_id: "work" })).structuredContent.error,
    "DRAFT_NOT_FOUND"
  );
  assert.equal(f.confirms(), 0);
  assert.equal((await owner("confirm_send", args)).structuredContent.message_id, "sent");
});

test("a failed confirm remains retryable only by its owner", async () => {
  let fail = true;
  const f = fixture({
    beforeConfirm: () => {
      if (fail) throw new WazapError("NOT_CONNECTED", "offline");
    },
  });
  const owner = f.client();
  const draft = await owner(...CASES[0]);
  const args = { draft_id: draft.structuredContent.draft_id };
  assert.equal((await owner("confirm_send", args)).structuredContent.error, "NOT_CONNECTED");
  assert.equal((await f.client()("confirm_send", args)).structuredContent.error, "DRAFT_NOT_FOUND");
  assert.equal(f.confirms(), 1);
  fail = false;
  assert.equal((await owner("confirm_send", args)).structuredContent.message_id, "sent");
});

test("owned expired drafts still report DRAFT_EXPIRED; foreign ones reveal nothing", async () => {
  let now = Date.now();
  const f = fixture({ now: () => now });
  const owner = f.client();
  const draft = await owner(...CASES[0]);
  now += 16 * 60_000;
  const args = { draft_id: draft.structuredContent.draft_id };
  assert.equal((await f.client()("confirm_send", args)).structuredContent.error, "DRAFT_NOT_FOUND");
  const expired = (await owner("confirm_send", args)).structuredContent;
  assert.equal(expired.error, "DRAFT_EXPIRED");
  assert.match(expired.fix, /wait for a new yes: the yes given to the expired draft does not carry over/, "a redrafted message is not sent on the old yes");
});

/**
 * A draft the talk moved past is never sent on a later yes (P20): the session
 * did something else in between, so the user's words answered that, not this
 * draft. Only an assistant's session is held to it — stdio and a client wazap
 * names (`local`, `local:…`), and a hosted agent that signed in (`oauth:…`).
 */
const ASSISTANT_CLIENTS = [undefined, "local:claude-code", "oauth:client_7f3"];
/** A builder's own program (an integration) keeps the contract it has. */
const BUILDER_CLIENTS = ["token:write", "token:integration"];

for (const name of ASSISTANT_CLIENTS) {
  test(`${name ?? "local"}: a draft another tool call came after is refused, and the draft just made sends`, async () => {
    const f = fixture();
    const assistant = f.client(name === undefined ? {} : { client: name });
    const id = (await assistant(...CASES[0])).structuredContent.draft_id;
    await assistant("learn", {});
    const stale = (await assistant("confirm_send", { draft_id: id })).structuredContent;
    assert.equal(stale.error, "DRAFT_STALE");
    assert.match(stale.fix, /call send_message again, show the new preview and ask for a yes to it/);
    assert.equal(f.confirms(), 0, "the refusal never reaches the service");
    assert.equal(f.sends(), 0, "nothing was sent");
    assert.doesNotThrow(() => f.store.take(id), "the draft itself is left alone");

    // What the fix asks for: a new draft, confirmed on a yes to that preview.
    const again = (await assistant(...CASES[0])).structuredContent.draft_id;
    assert.equal((await assistant("confirm_send", { draft_id: again })).structuredContent.message_id, "sent");
    assert.equal(f.sends(), 1);
  });
}

for (const name of BUILDER_CLIENTS) {
  test(`${name}: a static token sends a draft it comes back to, as before`, async () => {
    const f = fixture();
    const builder = f.client({ client: name });
    const id = (await builder(...CASES[0])).structuredContent.draft_id;
    await builder("learn", {});
    assert.equal((await builder("confirm_send", { draft_id: id })).structuredContent.message_id, "sent");
    assert.equal(f.sends(), 1);
  });
}

test("a draft confirmed with nothing in between sends, and a repeat still answers the service", async () => {
  const f = fixture();
  const assistant = f.client();
  const id = (await assistant(...CASES[0])).structuredContent.draft_id;
  assert.equal((await assistant("confirm_send", { draft_id: id })).structuredContent.message_id, "sent");
  await assistant("learn", {});
  // Once a confirm has reached the service, its answer stands: never DRAFT_STALE,
  // which would have the assistant draft the same message a second time.
  const replay = (await assistant("confirm_send", { draft_id: id })).structuredContent;
  assert.equal(replay.already_sent, true);
  assert.equal(f.sends(), 1);
});

test("tool-runtime keeps rated tool budgets across registrations", async () => {
  const register = createToolRegistrar([
    {
      name: "test_rate",
      title: "Test",
      description: "Test",
      schema: {},
      write: false,
      rate: 1,
      handler: async () => ({ content: [], structuredContent: { ok: true } }),
    },
  ]);
  function client() {
    let call;
    register(
      {
        registerTool: (_name, _meta, handler) => {
          call = handler;
        },
      },
      fixture().hub,
      { allowWrite: false }
    );
    return call;
  }
  assert.equal((await client()({})).structuredContent.ok, true);
  assert.equal((await client()({})).structuredContent.error, "RATE_LIMITED");
});

async function endpoint(t) {
  const f = fixture();
  const config = offlineConfig("wazap-draft-isolation-", { readOnly: false });
  const stop = new AbortController();
  t.after(() => {
    stop.abort();
    rmSync(config.dataDir, { recursive: true, force: true });
  });
  const port = await startHttpEndpoint(f.hub, config, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    signal: stop.signal,
    credentials: [
      { token: "shared-test-token", write: true },
      { token: "other-test-token", write: true },
      // The daemon's own channel: remote sessions on it still get per-session drafts.
      { token: "local-test-token", write: true, localFiles: true },
    ],
  });
  return { ...f, config, port };
}

async function httpClient(t, port, token = "shared-test-token") {
  const client = new Client({ name: "draft-isolation", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
  );
  t.after(() => client.close());
  return client;
}

test("HTTP: one token's sessions share its drafts — a confirm over a new session still lands", async (t) => {
  const f = await endpoint(t);
  const owner = await httpClient(t, f.port);
  const other = await httpClient(t, f.port);
  const draft = await owner.callTool({ name: "send_message", arguments: CASES[0][1] });
  const args = { draft_id: draft.structuredContent.draft_id };
  assert.equal(
    (await other.callTool({ name: "confirm_send", arguments: args })).structuredContent.message_id,
    "sent"
  );
  assert.equal(f.confirms(), 1);
  const replay = await owner.callTool({ name: "confirm_send", arguments: args });
  assert.equal(replay.structuredContent.already_sent, true, "either session's replay answers the receipt");
  assert.equal(f.sends(), 1);
});

test("HTTP: a session on another token cannot confirm it", async (t) => {
  const f = await endpoint(t);
  const owner = await httpClient(t, f.port);
  const other = await httpClient(t, f.port, "other-test-token");
  const draft = await owner.callTool({ name: "send_message", arguments: CASES[0][1] });
  const args = { draft_id: draft.structuredContent.draft_id };
  assert.equal(
    (await other.callTool({ name: "confirm_send", arguments: args })).structuredContent.error,
    "DRAFT_NOT_FOUND"
  );
  assert.equal(f.confirms(), 0);
  assert.equal(
    (await owner.callTool({ name: "confirm_send", arguments: args })).structuredContent.message_id,
    "sent"
  );
});

test("HTTP: the local channel keeps per-session drafts even on one credential", async (t) => {
  const f = await endpoint(t);
  const owner = await httpClient(t, f.port, "local-test-token");
  const other = await httpClient(t, f.port, "local-test-token");
  const draft = await owner.callTool({ name: "send_message", arguments: CASES[0][1] });
  const args = { draft_id: draft.structuredContent.draft_id };
  assert.equal(
    (await other.callTool({ name: "confirm_send", arguments: args })).structuredContent.error,
    "DRAFT_NOT_FOUND"
  );
  assert.equal(f.confirms(), 0);
  assert.equal(
    (await owner.callTool({ name: "confirm_send", arguments: args })).structuredContent.message_id,
    "sent"
  );
});

test("HTTP: resuming the same authenticated session preserves its drafts", async (t) => {
  const f = await endpoint(t);
  const owner = new Client({ name: "resuming", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${f.port}/mcp`), {
    requestInit: { headers: { authorization: "Bearer shared-test-token" } },
  });
  await owner.connect(transport);
  t.after(() => owner.close());
  const draft = await owner.callTool({ name: "send_message", arguments: CASES[0][1] });
  const sid = transport.sessionId;
  assert.ok(sid);
  await owner.close();
  const response = await fetch(`http://127.0.0.1:${f.port}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer shared-test-token",
      "mcp-session-id": sid,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: {
        name: "confirm_send",
        arguments: { draft_id: draft.structuredContent.draft_id },
      },
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /"message_id":"sent"/);
  assert.equal(f.confirms(), 1);
});

test("HTTP: a new initialize on the same token still owns the earlier session's drafts", async (t) => {
  const f = await endpoint(t);
  const old = await httpClient(t, f.port);
  const draft = await old.callTool({ name: "send_message", arguments: CASES[0][1] });
  await old.close();
  const fresh = await httpClient(t, f.port);
  assert.equal(
    (await fresh.callTool({ name: "confirm_send", arguments: { draft_id: draft.structuredContent.draft_id } }))
      .structuredContent.message_id,
    "sent"
  );
  assert.equal(f.confirms(), 1);
});

test("HTTP: a new initialize on another token is still told nothing", async (t) => {
  const f = await endpoint(t);
  const old = await httpClient(t, f.port);
  const draft = await old.callTool({ name: "send_message", arguments: CASES[0][1] });
  await old.close();
  const fresh = await httpClient(t, f.port, "other-test-token");
  assert.equal(
    (await fresh.callTool({ name: "confirm_send", arguments: { draft_id: draft.structuredContent.draft_id } }))
      .structuredContent.error,
    "DRAFT_NOT_FOUND"
  );
  assert.equal(f.confirms(), 0);
});

test("two real stdio bridges sharing a daemon cannot confirm each other's drafts", async (t) => {
  const f = await endpoint(t);
  const file = join(f.config.dataDir, "daemon.json");
  // The credential the daemon's loopback endpoint issues in production (localFiles).
  const daemon = { pid: process.pid, port: f.port, token: "local-test-token", version: "test" };
  writeDaemon(file, daemon);
  async function bridge() {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { runBridge } from ${JSON.stringify(new URL("../dist/bridge.js", import.meta.url).href)};
       import { readDaemon } from ${JSON.stringify(new URL("../dist/daemon.js", import.meta.url).href)};
       await runBridge(readDaemon(process.argv[1]), process.argv[1]);`,
        file,
      ],
      { env: childEnv(), stdio: ["pipe", "pipe", "pipe"] }
    );
    child.stderr.resume();
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = once(child, "exit");
      child.kill();
      await ended;
    });
    const rpc = mcpClient(child);
    await rpc.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    rpc.notify("notifications/initialized");
    return async (name, args) => (await rpc.request("tools/call", { name, arguments: args })).result;
  }
  const owner = await bridge();
  const other = await bridge();
  const draft = await owner("send_message", CASES[0][1]);
  const args = { draft_id: draft.structuredContent.draft_id };
  assert.equal((await other("confirm_send", args)).structuredContent.error, "DRAFT_NOT_FOUND");
  assert.equal(f.confirms(), 0);
  assert.equal((await owner("confirm_send", args)).structuredContent.message_id, "sent");
});
