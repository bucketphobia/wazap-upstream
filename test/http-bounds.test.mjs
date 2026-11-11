/**
 * The listener's bounds against what a tunnel and a cloud agent do. cloudflared
 * keeps pooled origin connections idle for 90 s, so wazap must hold an idle
 * keep-alive socket longer than that, and headersTimeout must not cut a socket
 * for idling between requests. Sessions last a day, and the numbers the docs
 * give are the ones the code enforces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import {
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  HTTP_TIMEOUT_CHECK_MS,
  MCP_SESSION_MAX,
  MCP_SESSION_TTL_MS,
  MCP_SESSIONS_PER_OWNER,
  startHttpEndpoint,
} from "../dist/server.js";
import { offlineConfig, stubAccountSource } from "./helpers.mjs";

const wa = { getStatus: () => ({ status: "connected", status_since: new Date().toISOString() }) };

test("idle keep-alive sockets outlive cloudflared's 90 s origin pool, and the request bounds stay ordered", () => {
  assert.ok(HTTP_KEEP_ALIVE_MS > 90_000, "Node must not close a socket the tunnel still holds in its pool");
  // Node refuses headersTimeout > requestTimeout; both bound receipt only, never a streamed response.
  assert.ok(HTTP_HEADERS_TIMEOUT_MS <= HTTP_REQUEST_TIMEOUT_MS);
});

test("a keep-alive socket idle past Node's 5 s default and past headersTimeout serves its next request", { timeout: 30_000 }, async (t) => {
  const config = offlineConfig("wazap-keepalive-");
  const stop = new AbortController();
  t.after(() => {
    stop.abort();
    rmSync(config.dataDir, { recursive: true, force: true });
  });
  const port = await startHttpEndpoint(stubAccountSource(wa), config, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    credentials: [{ token: "reader", write: false }],
    signal: stop.signal,
  });
  const socket = connect(port, "127.0.0.1");
  t.after(() => socket.destroy());
  let received = "";
  let closed = false;
  socket.on("data", (chunk) => {
    received += chunk;
  });
  socket.on("close", () => {
    closed = true;
  });
  await new Promise((resolve) => socket.once("connect", resolve));
  const ask = () => socket.write("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
  const answers = () => (received.match(/HTTP\/1\.1 200/g) ?? []).length;
  const until = async (predicate) => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  };
  ask();
  await until(() => answers() === 1);
  assert.equal(answers(), 1);
  // Node 22 closes an idle socket at keepAliveTimeout + 1 s; the old default
  // was 5 s. Idle past headersTimeout and a timeout check after it too, which
  // must not count the wait between two requests as headers trickling in.
  await new Promise((resolve) => setTimeout(resolve, HTTP_HEADERS_TIMEOUT_MS + 2 * HTTP_TIMEOUT_CHECK_MS));
  assert.equal(closed, false, "the idle socket was closed under the tunnel");
  ask();
  await until(() => answers() === 2);
  assert.equal(answers(), 2);
});

test("headers that trickle in are cut at the headers bound, not at Node's 30 s check", { timeout: 30_000 }, async (t) => {
  const config = offlineConfig("wazap-slowloris-");
  const stop = new AbortController();
  t.after(() => {
    stop.abort();
    rmSync(config.dataDir, { recursive: true, force: true });
  });
  const port = await startHttpEndpoint(stubAccountSource(wa), config, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    credentials: [{ token: "reader", write: false }],
    signal: stop.signal,
  });
  const socket = connect(port, "127.0.0.1");
  t.after(() => socket.destroy());
  await new Promise((resolve) => socket.once("connect", resolve));
  const started = Date.now();
  socket.write("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n");
  let received = "";
  socket.on("data", (chunk) => {
    received += chunk;
  });
  // A drip that meets the closed socket resets it; the close is what counts.
  socket.on("error", () => {});
  const drip = setInterval(() => socket.write("X-Drip: 1\r\n"), 500);
  t.after(() => clearInterval(drip));
  await new Promise((resolve) => socket.once("close", resolve));
  clearInterval(drip);
  const elapsed = Date.now() - started;
  assert.ok(received === "" || received.startsWith("HTTP/1.1 408"), received.slice(0, 40));
  assert.ok(elapsed >= HTTP_HEADERS_TIMEOUT_MS - 100, `cut after ${elapsed} ms`);
  assert.ok(elapsed < HTTP_HEADERS_TIMEOUT_MS + HTTP_TIMEOUT_CHECK_MS + 1_500, `cut after ${elapsed} ms`);
});

test("the session bounds docs/self-host.md states are the ones the code enforces", () => {
  const doc = readFileSync(new URL("../docs/self-host.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.equal(MCP_SESSION_TTL_MS, 24 * 60 * 60 * 1000, "cloud agents come back to a conversation hours later");
  assert.match(doc, new RegExp(`holds at most ${MCP_SESSION_MAX} sessions overall and ${MCP_SESSIONS_PER_OWNER} per credential`));
  assert.match(doc, new RegExp(`nobody has used for ${MCP_SESSION_TTL_MS / 3_600_000} hours`));
  assert.match(doc, new RegExp(`stays open for ${HTTP_KEEP_ALIVE_MS / 1000} seconds`));
});
