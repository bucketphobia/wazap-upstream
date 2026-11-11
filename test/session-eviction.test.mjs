/**
 * Past a cap the idlest HTTP session goes, but making room never closes a
 * session that is answering a request while an idle one could go, and a
 * revival never closes one at all: it is refused instead. A GET reconnect
 * revives only into a free place, so clients over the cap do not evict one
 * another round and round, cutting every call under way on the way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HttpSessions, MCP_SESSIONS_PER_OWNER } from "../dist/http-sessions.js";
import { startHttpEndpoint } from "../dist/server.js";
import { asToolSource, offlineConfig } from "./helpers.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A transport stand-in that records being closed. */
function transport(name, closed) {
  return { name, close: async () => closed.push(name) };
}

test("making room closes the idlest session answering nothing, before any answering a request", () => {
  const closed = [];
  const sessions = new HttpSessions(2);
  const a = transport("a", closed);
  const b = transport("b", closed);
  sessions.add("a", a, "owner");
  sessions.add("b", b, "owner");
  const release = sessions.hold("a", a);
  sessions.add("c", transport("c", closed), "other");
  assert.deepEqual(closed, ["b"], "a is the idlest, but it is answering a request");
  release();
  sessions.close();
});

test("an initialize past the cap still closes the idlest when every session is answering a request", () => {
  const closed = [];
  const sessions = new HttpSessions(2);
  const a = transport("a", closed);
  const b = transport("b", closed);
  sessions.add("a", a, "owner");
  sessions.add("b", b, "owner");
  sessions.hold("a", a);
  sessions.hold("b", b);
  assert.equal(sessions.add("c", transport("c", closed), "owner"), true);
  assert.deepEqual(closed, ["a"]);
  sessions.close();
});

test("a revival is refused rather than close a session answering a request", () => {
  const closed = [];
  const sessions = new HttpSessions(2);
  const a = transport("a", closed);
  const b = transport("b", closed);
  const c = transport("c", closed);
  sessions.add("a", a, "owner");
  sessions.add("b", b, "other");
  sessions.hold("a", a);
  sessions.hold("b", b);
  assert.equal(sessions.canAdmit("owner"), false);
  assert.equal(sessions.add("c", c, "owner", true), false);
  assert.deepEqual(closed, [], "nobody was closed for it");
  assert.equal(sessions.holds("c", c), false);
  assert.equal(sessions.size, 2);
  sessions.close();
});

test("the per-credential cap spares a busy session the same way", () => {
  const closed = [];
  const sessions = new HttpSessions(MCP_SESSIONS_PER_OWNER * 4);
  const mine = [];
  for (let i = 0; i < MCP_SESSIONS_PER_OWNER; i++) {
    const own = transport(`s${i}`, closed);
    sessions.add(`s${i}`, own, "owner");
    mine.push(own);
  }
  assert.equal(sessions.hasRoom("owner"), false, "the credential is at its cap");
  assert.equal(sessions.hasRoom("other"), true);
  mine.forEach((own, i) => sessions.hold(`s${i}`, own));
  assert.equal(sessions.canAdmit("owner"), false);
  assert.equal(sessions.add("new", transport("new", closed), "owner", true), false);
  assert.deepEqual(closed, []);
  sessions.close();
});

test("the end of a request counts as use, and the sweep leaves a session answering one", async () => {
  const closed = [];
  const sessions = new HttpSessions(2);
  const a = transport("a", closed);
  const b = transport("b", closed);
  sessions.add("a", a, "owner");
  const release = sessions.hold("a", a);
  await sleep(5);
  sessions.add("b", b, "owner");
  sessions.sweep(Date.now() + 1);
  assert.deepEqual(closed, ["b"], "a is answering a request");
  sessions.add("b", b, "owner");
  await sleep(5);
  release();
  sessions.add("c", transport("c", closed), "owner");
  assert.deepEqual(closed, ["b", "b"], "a finished a request after b was last used");
  sessions.close();
});

test("clients over the cap do not evict one another: every call under way is answered or refused at once", { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-eviction-"));
  const stop = new AbortController();
  t.after(() => {
    stop.abort();
    rmSync(dir, { recursive: true, force: true });
  });
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk, encoding, callback) {
    lines.push(String(chunk));
    const done = typeof encoding === "function" ? encoding : callback;
    done?.();
    return true;
  };
  t.after(() => {
    process.stderr.write = original;
  });
  const revivals = () => lines.filter((line) => line.includes("session revived")).length;
  const wa = {
    getStatus: () => ({ status: "connected", status_since: new Date().toISOString(), read_only: false }),
    waitForMessages: (opts) =>
      new Promise((resolve) => {
        const end = () => resolve({ messages: [], cursor: "boot:0", timed_out: true, cursor_reset: false });
        const timer = setTimeout(end, opts.timeoutMs);
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          end();
        });
      }),
  };
  const port = await startHttpEndpoint(asToolSource(wa), offlineConfig("wazap-eviction-cfg-", { dataDir: dir, readOnly: false }), {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    credentials: [{ token: "w", write: true }],
    sessionMax: 2,
    signal: stop.signal,
  });
  // Three SDK clients, each with its notification stream, on a cap of two:
  // the third's initialize evicts the first. Their GET reconnects come fast.
  const clients = [];
  for (let i = 0; i < 3; i++) {
    const client = new Client({ name: `c${i}`, version: "1" });
    client.onerror = () => {};
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { authorization: "Bearer w" } },
        reconnectionOptions: { initialReconnectionDelay: 50, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1, maxRetries: 40 },
      })
    );
    t.after(() => client.close().catch(() => {}));
    clients.push(client);
    await sleep(30);
  }
  await sleep(1_500);
  assert.equal(revivals(), 0, "an evicted client's GET reconnect took nobody's place");

  const started = Date.now();
  const outcomes = await Promise.all(
    clients.map((client) =>
      client.callTool({ name: "wait_for_messages", arguments: { timeout_seconds: 2 } }, undefined, { timeout: 10_000 }).then(
        (result) => ({ answered: result.structuredContent?.timed_out === true, at: Date.now() - started }),
        (err) => ({ error: String(err), at: Date.now() - started })
      )
    )
  );
  const answered = outcomes.filter((outcome) => outcome.answered);
  const refused = outcomes.filter((outcome) => outcome.error !== undefined);
  assert.equal(answered.length + refused.length, 3, JSON.stringify(outcomes));
  assert.ok(answered.length >= 2, `answered: ${JSON.stringify(outcomes)}`);
  for (const outcome of refused) {
    assert.match(outcome.error, /404|Session not found/, "refused with the 404 a client recovers from");
    assert.ok(outcome.at < 1_000, `refused at once, not cut off later: ${outcome.at} ms`);
  }
  const settled = revivals();
  await sleep(1_500);
  assert.equal(revivals(), settled, "nothing keeps reviving once the calls are answered");
});
