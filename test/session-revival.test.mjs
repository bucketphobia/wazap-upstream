/**
 * A session wazap no longer holds — lost to a restart, the idle sweep or an
 * eviction — is served again for the credential it was minted for, under the
 * id the client holds, instead of answering 404. Nobody else can use the id,
 * an id wazap did not mint is still a 404, and so is one its client ended or
 * one whose tools or instructions have changed since.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { HttpSessions, MCP_ENDED_SESSIONS_KEPT } from "../dist/http-sessions.js";
import { replayHandshake } from "../dist/mcp-http.js";
import { startHttpEndpoint } from "../dist/server.js";
import { SessionIds, sessionIds } from "../dist/session-id.js";
import { registerTools } from "../dist/tools.js";
import { offlineConfig, stubAccountSource } from "./helpers.mjs";

const wa = { getStatus: () => ({ status: "connected", status_since: new Date().toISOString() }) };
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "revival", version: "1" } },
};
const ping = { jsonrpc: "2.0", id: 2, method: "ping" };
const toolsList = { jsonrpc: "2.0", id: 3, method: "tools/list" };

async function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** A data dir that outlives the servers started on it, the way a restart finds it. */
function dataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "wazap-revival-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function start(t, dir, { port = 0, openRead = false, readOnly = false, source = wa, ...bounds } = {}) {
  const stop = new AbortController();
  t.after(() => stop.abort());
  const bound = await startHttpEndpoint(stubAccountSource(source), offlineConfig("wazap-revival-cfg-", { dataDir: dir, readOnly }), {
    host: "127.0.0.1",
    port,
    openRead,
    signal: stop.signal,
    credentials: [
      { token: "writer", write: true },
      { token: "reader", write: false },
    ],
    ...bounds,
  });
  const call = async (token, sid, body = ping, method = "POST") => {
    const res = await fetch(`http://127.0.0.1:${bound}/mcp`, {
      method,
      headers: {
        accept: method === "GET" ? "text/event-stream" : "application/json, text/event-stream",
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(sid ? { "mcp-session-id": sid } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5_000),
    });
    const text = method === "GET" && res.status === 200 ? (await res.body.cancel(), "") : await res.text();
    return { status: res.status, sid: res.headers.get("mcp-session-id"), text };
  };
  return { port: bound, stop: () => stop.abort(), call };
}

test("a tool whose schema or description changed within one version gets the 404, never the stale catalogue", async (t) => {
  // A single account's name is not in the instructions, but it is in the
  // session-shape cache's key: each start below works its shape out afresh, as
  // a new process would, with the same version and the same instructions.
  const named = (name) => ({ getStatus: () => ({ status: "connected", status_since: new Date().toISOString(), account_name: name }) });
  const dir = dataDir(t);
  const before = await start(t, dir, { source: named("catalogue-before") });
  const writer = await before.call("writer", undefined, initialize);
  const reader = await before.call("reader", undefined, initialize);
  before.stop();

  // The same catalogue: revived.
  const same = await start(t, dir, { source: named("catalogue-same") });
  assert.equal((await same.call("reader", reader.sid, toolsList)).status, 200);
  same.stop();

  // get_media described otherwise (as when it gained detail and pages): the client's catalogue is stale.
  const real = registerTools.catalogue;
  registerTools.catalogue = (opts) => real(opts).map((tool) => (tool.name === "get_media" ? { ...tool, description: `${tool.description} Changed.` } : tool));
  t.after(() => {
    registerTools.catalogue = real;
  });
  const after = await start(t, dir, { source: named("catalogue-after") });
  assert.equal((await after.call("writer", writer.sid, toolsList)).status, 404);
  assert.equal((await after.call("reader", reader.sid, toolsList)).status, 404);
  assert.equal((await after.call("reader", undefined, initialize)).status, 200, "a fresh initialize is served");
});

test("the catalogue a session id is signed with is the one tools/list answers, get_media's detail and pages included", async (t) => {
  const server = await start(t, dataDir(t));
  const session = await server.call("reader", undefined, initialize);
  const listed = await server.call("reader", session.sid, toolsList);
  const tools = JSON.parse(/^data: (.*)$/m.exec(listed.text)?.[1] ?? listed.text).result.tools;
  assert.deepEqual(tools, JSON.parse(JSON.stringify(registerTools.catalogue({ allowWrite: false, legacyReads: true, allowLocalFiles: false }))));
  const getMedia = tools.find((tool) => tool.name === "get_media");
  assert.ok(getMedia.inputSchema.properties.detail && getMedia.inputSchema.properties.pages);
});

test("session ids carry their owner's mark, and the key that signs them is the owner's alone to read", async (t) => {
  const dir = dataDir(t);
  const server = await start(t, dir);
  const session = await server.call("writer", undefined, initialize);
  assert.equal(session.status, 200);
  assert.match(session.sid, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{22}$/);
  assert.equal(statSync(join(dir, "session.key")).mode & 0o777, 0o600);
});

test("after a restart, the session's own credential is served under the id it holds, with its own tools", async (t) => {
  const dir = dataDir(t);
  const before = await start(t, dir);
  const session = await before.call("writer", undefined, initialize);
  const reader = await before.call("reader", undefined, initialize);
  before.stop();

  const after = await start(t, dir);
  const revived = await after.call("writer", session.sid, toolsList);
  assert.equal(revived.status, 200);
  assert.equal(revived.sid, session.sid, "the client keeps the id it holds");
  assert.match(revived.text, /"name":"send_message"/);
  assert.equal((await after.call("writer", session.sid)).status, 200, "and keeps it from then on");
  const read = await after.call("reader", reader.sid, toolsList);
  assert.equal(read.status, 200);
  assert.doesNotMatch(read.text, /"name":"send_message"/, "a read credential's revived session still has no write tools");
});

test("a session is revived only while wazap would hand its client the same tools and instructions", async (t) => {
  const dir = dataDir(t);
  const before = await start(t, dir);
  const writer = await before.call("writer", undefined, initialize);
  const reader = await before.call("reader", undefined, initialize);
  assert.match((await before.call("writer", writer.sid, toolsList)).text, /"name":"send_message"/);
  before.stop();
  // Writes switched off for the restart: the writer's session would come back
  // without its write tools and with other instructions, which its client would
  // never learn of. It gets the 404 that has it initialize again and read them.
  const after = await start(t, dir, { readOnly: true });
  assert.equal((await after.call("writer", writer.sid, toolsList)).status, 404);
  const fresh = await after.call("writer", undefined, initialize);
  assert.equal(fresh.status, 200);
  assert.doesNotMatch((await after.call("writer", fresh.sid, toolsList)).text, /"name":"send_message"/);
  // The reader was handed the same read tools and instructions either way.
  assert.equal((await after.call("reader", reader.sid, toolsList)).status, 200);
});

test("an id verifies only for the owner and the shape it was minted with", () => {
  const ids = new SessionIds(Buffer.alloc(32, 3));
  const id = ids.mint("write:remote:abc", "shape-1");
  assert.equal(ids.verify(id, "write:remote:abc", "shape-1"), true);
  assert.equal(ids.verify(id, "write:remote:abc", "shape-2"), false, "other tools or instructions");
  assert.equal(ids.verify(id, "read:remote:abc", "shape-1"), false, "another owner");
});

test("another credential presenting a lost session's id gets 404, and cannot spoil it for its owner", async (t) => {
  const dir = dataDir(t);
  const before = await start(t, dir);
  const session = await before.call("writer", undefined, initialize);
  before.stop();
  const after = await start(t, dir, { openRead: true });
  for (const [token, method] of [["reader", "POST"], ["reader", "GET"], [undefined, "POST"], ["reader", "DELETE"]]) {
    assert.equal((await after.call(token, session.sid, ping, method)).status, 404, `${token ?? "anonymous"} ${method}`);
  }
  assert.equal((await after.call("writer", session.sid)).status, 200);
  // Now live again under its owner, the id is foreign to everyone else as before.
  assert.equal((await after.call("reader", session.sid)).status, 404);
});

test("a session its client ended with DELETE stays ended for that credential too, whether this process held it or lost it", async (t) => {
  const dir = dataDir(t);
  const server = await start(t, dir);
  const session = await server.call("writer", undefined, initialize);
  assert.equal((await server.call("writer", session.sid, ping, "DELETE")).status, 200);
  assert.equal((await server.call("writer", session.sid)).status, 404, "a POST after the DELETE");
  assert.equal((await server.call("writer", session.sid, ping, "GET")).status, 404, "a GET after the DELETE");

  // Ended after a restart lost it: the DELETE is a 404 (nothing here to end), and the id stays dead.
  const lost = await server.call("writer", undefined, initialize);
  server.stop();
  const after = await start(t, dir);
  assert.equal((await after.call("writer", lost.sid, ping, "DELETE")).status, 404);
  assert.equal((await after.call("writer", lost.sid)).status, 404, "never revived");
  // Another credential's DELETE ends nothing.
  const kept = await after.call("writer", undefined, initialize);
  after.stop();
  const again = await start(t, dir);
  assert.equal((await again.call("reader", kept.sid, ping, "DELETE")).status, 404);
  assert.equal((await again.call("writer", kept.sid)).status, 200);
});

test("a DELETE that races the revival of its lost session still ends it for good", { timeout: 20_000 }, async (t) => {
  const dir = dataDir(t);
  const before = await start(t, dir);
  const lost = [];
  for (let i = 0; i < 12; i++) lost.push((await before.call("writer", undefined, initialize)).sid);
  before.stop();
  const after = await start(t, dir);
  for (const sid of lost) {
    // The POST starts a revival; the DELETE lands while it is under way.
    await Promise.all([after.call("writer", sid), after.call("writer", sid, ping, "DELETE")]);
    assert.equal((await after.call("writer", sid)).status, 404, "ended, whichever came first");
  }
});

test("the ended ids kept are bounded, oldest forgotten first", () => {
  const sessions = new HttpSessions(4);
  for (let i = 0; i <= MCP_ENDED_SESSIONS_KEPT; i++) sessions.end(`id-${i}`);
  assert.equal(sessions.ended("id-0"), false);
  assert.equal(sessions.ended("id-1"), true);
  assert.equal(sessions.ended(`id-${MCP_ENDED_SESSIONS_KEPT}`), true);
});

test("ids wazap did not mint for this credential stay 404: random, altered, or signed by another install", async (t) => {
  const dir = dataDir(t);
  const server = await start(t, dir);
  const session = await server.call("writer", undefined, initialize);
  const [uuid, mac] = session.sid.split(".");
  const flipped = `${uuid}.${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
  const otherInstall = new SessionIds(Buffer.alloc(32, 7)).mint("anything", "any shape");
  for (const forged of [randomUUID(), `${randomUUID()}.${mac}`, flipped, otherInstall, `${session.sid}x`, "lost-in-restart-123"]) {
    assert.equal((await server.call("writer", forged)).status, 404, forged);
  }
});

test("an anonymous loopback session is not revived: every anonymous reader shares one identity", async (t) => {
  const dir = dataDir(t);
  const before = await start(t, dir, { openRead: true });
  const session = await before.call(undefined, undefined, initialize);
  assert.equal(session.status, 200);
  before.stop();
  const after = await start(t, dir, { openRead: true });
  assert.equal((await after.call(undefined, session.sid)).status, 404);
});

test("a session the idle sweep dropped comes back, and revivals count against the caps", async (t) => {
  const dir = dataDir(t);
  const server = await start(t, dir, { sessionTtlMs: 50, sessionSweepMs: 20, sessionMax: 2 });
  const first = await server.call("writer", undefined, initialize);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const revived = await server.call("writer", first.sid);
  assert.equal(revived.status, 200, "swept for idling, served again on its next call");
  assert.equal(revived.sid, first.sid);
});

test("revived sessions are bounded like new ones: past the cap the idlest goes", async (t) => {
  const dir = dataDir(t);
  const before = await start(t, dir);
  const sids = [];
  for (let i = 0; i < 3; i++) sids.push((await before.call("writer", undefined, initialize)).sid);
  before.stop();
  const after = await start(t, dir, { sessionMax: 2 });
  const lines = await stderrOf(async () => {
    for (const sid of sids) assert.equal((await after.call("writer", sid)).status, 200);
    // Three revivals into two places: the first one revived was the idlest and was evicted, so it revives once more.
    assert.equal((await after.call("writer", sids[0])).status, 200);
  });
  const live = [...lines.matchAll(/session revived for a token credential \((\d+) live\)/g)].map((match) => Number(match[1]));
  assert.equal(live.length, 4);
  assert.ok(live.every((count) => count <= 2), `live sessions after each revival: ${live.join(", ")}`);
});

/** What `work` wrote to stderr, where wazap logs. */
async function stderrOf(work) {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk, encoding, callback) {
    lines.push(String(chunk));
    const done = typeof encoding === "function" ? encoding : callback;
    done?.();
    return true;
  };
  try {
    await work();
  } finally {
    process.stderr.write = original;
  }
  return lines.join("");
}

test("concurrent calls on one lost session share a single revival", async (t) => {
  const dir = dataDir(t);
  const before = await start(t, dir);
  const session = await before.call("writer", undefined, initialize);
  before.stop();
  let answers;
  const lines = await stderrOf(async () => {
    const after = await start(t, dir);
    answers = await Promise.all(Array.from({ length: 5 }, () => after.call("writer", session.sid)));
  });
  for (const answer of answers) assert.equal(answer.status, 200);
  const revivals = lines.match(/session revived/g) ?? [];
  assert.equal(revivals.length, 1);
  assert.match(lines, /session revived for a token credential/);
  assert.ok(!lines.includes(session.sid.split(".")[0]), "the log never names the session");
});

test("an SDK client keeps calling tools across a server restart, without initializing again", { timeout: 20_000 }, async (t) => {
  const dir = dataDir(t);
  const port = await freePort();
  const before = await start(t, dir, { port });
  const client = new Client({ name: "survivor", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: "Bearer writer" } },
  });
  const errors = [];
  await client.connect(transport);
  client.onerror = (err) => errors.push(err);
  t.after(() => client.close());
  const sid = transport.sessionId;
  assert.ok((await client.listTools()).tools.length > 0);
  before.stop();
  await start(t, dir, { port });
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "send_message"));
  const learned = await client.callTool({ name: "learn", arguments: {} });
  assert.notEqual(learned.isError, true);
  assert.equal(transport.sessionId, sid, "the same session, not a new one");
});

test("the handshake replay works on this SDK: it fails loudly instead of serving a half-made session", async () => {
  const sid = sessionIds(join(mkdtempSync(join(tmpdir(), "wazap-replay-")), "session.key")).mint("owner", "shape");
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => sid });
  const server = new McpServer({ name: "replay", version: "1" });
  server.registerTool("echo", { description: "echo" }, async () => ({ content: [{ type: "text", text: "still here" }] }));
  await server.connect(transport);
  await replayHandshake(transport, sid, "2025-06-18");
  assert.equal(transport.sessionId, sid);
  const answer = await transport.handleRequest(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid },
    }),
    { parsedBody: { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "echo", arguments: {} } } }
  );
  assert.equal(answer.status, 200);
  assert.match(await answer.text(), /still here/);
  // A transport that already has a session cannot be handed the handshake again.
  await assert.rejects(replayHandshake(transport, sid, "2025-06-18"), /session revival: initialize answered 400/);
  await transport.close();
});
