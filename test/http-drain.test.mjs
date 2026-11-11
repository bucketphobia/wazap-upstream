/**
 * Shutting down (SIGTERM, SIGINT, `wazap update`) drains HTTP first: the
 * listener closes and nothing new is taken, a wait answers at once with what
 * it has, other calls under way (one whose client left included) get up to
 * ten seconds, and only then are the connections closed. A call its client
 * cancelled holds nothing up. A restart no longer cuts a tool call off
 * mid-answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { request } from "node:http";
import { gunzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { drainHttpEndpoints, HTTP_DRAIN_MS, startHttpEndpoint } from "../dist/server.js";
import { asToolSource, offlineConfig } from "./helpers.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CHAT = "40722123456@s.whatsapp.net";

async function boot(t, wa) {
  const config = offlineConfig("wazap-drain-", { readOnly: false });
  const stop = new AbortController();
  t.after(() => {
    stop.abort();
    rmSync(config.dataDir, { recursive: true, force: true });
  });
  const port = await startHttpEndpoint(asToolSource({ getStatus: () => ({ status: "connected", status_since: new Date().toISOString(), read_only: false }), ...wa }), config, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    credentials: [{ token: "w", write: true }],
    signal: stop.signal,
  });
  /** A POST and its answer; `headers` adds to the request's, `sent` gets the request itself, `path` replaces /mcp. */
  const post = (body, sid, { headers = {}, sent, path = "/mcp" } = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: "Bearer w",
            ...(sid ? { "mcp-session-id": sid } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks);
            const text = (res.headers["content-encoding"] === "gzip" && raw.length > 0 ? gunzipSync(raw, { finishFlush: 2 }) : raw).toString();
            resolve({ status: res.statusCode, sid: res.headers["mcp-session-id"], encoding: res.headers["content-encoding"], text, at: Date.now() });
          });
          res.on("error", reject);
        }
      );
      req.on("error", reject);
      sent?.(req);
      req.end(JSON.stringify(body));
    });
  const session = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "drain", version: "1" } } });
  const tool = (id, name, args, options) => post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, session.sid, options);
  return { port, tool, post, sid: session.sid };
}

/** What get_media's openMedia gives a remote session for a file it shows nothing of: no path, its facts. */
const OPENED = { mime: "text/plain", size: 4, source: "kept", rendition: { kind: "none", note: "No view or text is made of x.txt: only its facts." } };

/** A wait_for_messages stub that honours the call's signal and the shutdown's. */
function waitStub(reached) {
  return (opts) => {
    reached?.fire();
    return new Promise((resolve) => {
      const end = () => resolve({ messages: [], cursor: "boot:0", timed_out: true, cursor_reset: false });
      const timer = setTimeout(end, opts.timeoutMs);
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        end();
      });
    });
  };
}

/** A promise and the function that resolves it: a stub says it has been reached. */
function reachable() {
  let fire;
  const reached = new Promise((resolve) => {
    fire = resolve;
  });
  return { reached, fire: () => fire() };
}

test("a drain lets the call under way answer, ends a wait at once, refuses new work, then closes", { timeout: 20_000 }, async (t) => {
  let downloadFinished = null;
  const downloading = reachable();
  const waiting = reachable();
  const { port, tool, post, sid } = await boot(t, {
    openMedia: async () => {
      downloading.fire();
      await sleep(600);
      downloadFinished = Date.now();
      return OPENED;
    },
    waitForMessages: (opts) => {
      waiting.fire();
      return new Promise((resolve) => {
        const end = () => resolve({ messages: [], cursor: "boot:0", timed_out: true, cursor_reset: false });
        const timer = setTimeout(end, opts.timeoutMs);
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          end();
        });
      });
    },
  });
  // Settled into values at once: a request that fails early is an assertion
  // below, never an unhandled rejection.
  const download = tool(2, "get_media", { message_id: `false_${CHAT}_M1` }).catch((err) => ({ error: err.code }));
  const wait = tool(3, "wait_for_messages", { timeout_seconds: 30 }).catch((err) => ({ error: err.code }));
  // Both handlers are running, so neither request is still in the accept
  // backlog, where closing the listener would reset it.
  await Promise.all([downloading.reached, waiting.reached]);
  const drainStarted = Date.now();
  const drained = drainHttpEndpoints();
  const refused = await post({ jsonrpc: "2.0", id: 4, method: "ping" }, sid).catch((err) => ({ status: err.code }));
  assert.ok([503, "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(refused.status), `a new request during the drain: ${refused.status}`);

  const waited = await wait;
  assert.equal(waited.status, 200, `the wait: ${waited.error ?? waited.status}`);
  assert.match(waited.text, /"timed_out":true/);
  assert.ok(waited.at - drainStarted < 500, "the wait answered at once, with what it had");

  const downloaded = await download;
  assert.equal(downloaded.status, 200, `the call under way was answered, not cut off: ${downloaded.error ?? downloaded.status}`);
  assert.match(downloaded.text, /x\.txt/);
  await drained;
  assert.ok(Date.now() >= downloadFinished, "the drain waited for it");
  assert.ok(Date.now() - drainStarted < HTTP_DRAIN_MS);
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_000) }),
    "the listener is closed afterwards"
  );
});

test("a call POSTed to /mcp/ or /MCP, which Express serves as /mcp, holds the drain until its answer is written", { timeout: 20_000 }, async (t) => {
  // A connector set up with a trailing slash, or in another case, is served
  // in full; its answer used to be cut off by a restart, the call itself
  // done (a send sent) and its receipt lost.
  for (const [id, path, headers] of [
    [2, "/mcp/", {}],
    [3, "/MCP", { "accept-encoding": "gzip" }],
  ]) {
    const downloading = reachable();
    const { tool } = await boot(t, {
      openMedia: async () => {
        downloading.fire();
        await sleep(300);
        return OPENED;
      },
    });
    const answer = tool(id, "get_media", { message_id: `false_${CHAT}_M1` }, { path, headers }).catch((err) => ({ error: err.code }));
    await downloading.reached;
    const drained = drainHttpEndpoints(5_000);
    const answered = await answer;
    await drained;
    assert.equal(answered.status, 200, `${path}: ${answered.error ?? answered.status}`);
    assert.match(answered.text, /x\.txt/, `${path}: the answer arrived whole`);
  }
});

test("a call that outlasts the drain's bound is closed when the bound runs out", { timeout: 20_000 }, async (t) => {
  const downloading = reachable();
  const { tool } = await boot(t, {
    openMedia: () => {
      downloading.fire();
      return new Promise(() => {});
    },
  });
  const stuck = tool(2, "get_media", { message_id: `false_${CHAT}_M1` }).catch((err) => ({ error: err.code }));
  await downloading.reached;
  const started = Date.now();
  await drainHttpEndpoints(300);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 280 && elapsed < 2_000, `closed after ${elapsed} ms`);
  const outcome = await stuck;
  assert.ok(outcome.error !== undefined || outcome.status !== undefined);
});

test("a call its client cancelled holds neither its answer's stream nor the drain", { timeout: 20_000 }, async (t) => {
  // The SDK never answers a cancelled request; its POST stream used to stay
  // open, keep-alives and all, until the client left, and every restart then
  // waited out the drain's whole bound for it.
  const waiting = reachable();
  const { port } = await boot(t, { waitForMessages: waitStub(waiting) });
  const client = new Client({ name: "esc", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: "Bearer w" } } }));
  t.after(() => client.close());
  const esc = new AbortController();
  const call = client.callTool({ name: "wait_for_messages", arguments: { timeout_seconds: 50 } }, undefined, { signal: esc.signal });
  await waiting.reached;
  esc.abort("the user pressed Esc");
  await assert.rejects(call, /pressed Esc/);
  await sleep(100);
  const started = Date.now();
  await drainHttpEndpoints();
  assert.ok(Date.now() - started < 1_000, `the drain took ${Date.now() - started} ms`);
});

test("a cancelled call's answer stream ends, compressed or not", { timeout: 20_000 }, async (t) => {
  const { tool, post, sid } = await boot(t, { waitForMessages: waitStub() });
  for (const [id, headers] of [[2, {}], [3, { "accept-encoding": "gzip" }]]) {
    const answer = tool(id, "wait_for_messages", { timeout_seconds: 50 }, { headers });
    await sleep(150);
    const cancelled = Date.now();
    assert.equal((await post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "test" } }, sid)).status, 202);
    const ended = await answer;
    assert.equal(ended.status, 200);
    assert.ok(ended.at - cancelled < 1_000, `ended ${ended.at - cancelled} ms after the cancel`);
    assert.doesNotMatch(ended.text, /"result"/, "a cancelled request is never answered");
    if (headers["accept-encoding"]) assert.equal(ended.encoding, "gzip");
  }
});

test("a cancel inside a batch leaves the batch's stream to the other answers", { timeout: 20_000 }, async (t) => {
  const waiting = reachable();
  const { port, post, sid } = await boot(t, { waitForMessages: waitStub(waiting) });
  const batch = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer w",
      "mcp-session-id": sid,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "wait_for_messages", arguments: { timeout_seconds: 1 } } },
      { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "wait_for_messages", arguments: { timeout_seconds: 50 } } },
    ]),
  });
  await waiting.reached;
  await post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 21, reason: "test" } }, sid);
  // Request 20 still owes its answer on the stream it shares with 21.
  const reader = batch.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5_000;
  while (!text.includes('"id":20') && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  assert.match(text, /"timed_out":true[\s\S]*"id":20/, "the other request in the batch was answered");
});

test("a call whose client left still holds the drain until it settles", { timeout: 20_000 }, async (t) => {
  let sendFinished = null;
  const downloading = reachable();
  const { tool } = await boot(t, {
    openMedia: async () => {
      downloading.fire();
      await sleep(600);
      sendFinished = Date.now();
      return OPENED;
    },
  });
  let req;
  const left = tool(2, "get_media", { message_id: `false_${CHAT}_M1` }, { sent: (sent) => (req = sent) }).catch((err) => ({ error: err.code }));
  await downloading.reached;
  req.destroy();
  await left;
  await sleep(50);
  const started = Date.now();
  await drainHttpEndpoints();
  assert.ok(sendFinished !== null && Date.now() >= sendFinished, "the drain waited for the call its client left");
  assert.ok(Date.now() - started < HTTP_DRAIN_MS);
});

test("a drain with nothing under way closes at once", async (t) => {
  await boot(t, {});
  const started = Date.now();
  await drainHttpEndpoints();
  assert.ok(Date.now() - started < 500);
});

test("the warm-up after the bind runs a handshake through a session nobody can reach", async (t) => {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk, encoding, callback) {
    lines.push(String(chunk));
    const done = typeof encoding === "function" ? encoding : callback;
    done?.();
    return true;
  };
  let booted;
  try {
    booted = await boot(t, {});
    await sleep(300);
  } finally {
    process.stderr.write = original;
  }
  assert.doesNotMatch(lines.join(""), /warm-up failed/);
  const reached = await booted.post({ jsonrpc: "2.0", id: 9, method: "ping" }, "warm-up");
  assert.equal(reached.status, 404);
  assert.equal((await booted.post({ jsonrpc: "2.0", id: 10, method: "ping" }, booted.sid)).status, 200);
});
