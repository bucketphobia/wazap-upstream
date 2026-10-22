/**
 * The daemon.json sidecar: the record a bridge reads to find the loopback MCP
 * endpoint of a running `wazap serve`. Every case runs against a throwaway data
 * dir, never the real ~/.wazap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { paths } from "../dist/config.js";
import { daemonHealthy, decideRole, readDaemon, removeDaemon, writeDaemon } from "../dist/daemon.js";
import { startHttpEndpoint } from "../dist/server.js";
import { BINARY, READ_TOOL_COUNT, TOOL_COUNT, childEnv, mcpClient, offlineConfig, spawnWazap, stubAccountSource, waitFor } from "./helpers.mjs";

const SAMPLE = { pid: 4242, port: 51515, token: "deadbeef", version: "9.9.9" };

function tempDir() {
  return mkdtempSync(join(tmpdir(), "wazap-daemon-"));
}

function mode(file) {
  return statSync(file).mode & 0o777;
}

const run = promisify(execFile);

/**
 * Budgets for the two waits every live-daemon test makes. A spawned child pays
 * Node boot plus the whole module graph (baileys, the MCP SDK, express) before
 * it can bind and write daemon.json — under a second idle, but the suite runs
 * test files and their children in parallel, so a starved child needs room.
 * SHUTDOWN_MS must outlast the daemon's own 3s forced-exit fallback, or the
 * wait loses the race against the very exit it is watching for.
 */
const STARTUP_MS = 30_000;
const SHUTDOWN_MS = 10_000;

/** The binary's own `status` against a data dir: human lines on stderr, `--json` on stdout. */
function status(dataDir, args = []) {
  return run(process.execPath, [BINARY, "status", "--data-dir", dataDir, ...args], {
    env: childEnv(),
  });
}

/** Run `fn` against a live `wazap serve` child, then make sure it is gone. */
async function withDaemon(env, fn, args = []) {
  const dataDir = tempDir();
  const { child, stderr } = spawnWazap({ dataDir, args, env });
  let alive = true;
  const exited = new Promise((resolve) => {
    child.once("exit", (code) => {
      alive = false;
      resolve(code);
    });
  });
  try {
    return await fn({
      child,
      stderr,
      dataDir,
      hasExited: () => !alive,
      daemonFile: join(dataDir, "daemon.json"),
      lockFile: join(dataDir, "server.lock"),
    });
  } catch (err) {
    // A timeout that says only what the parent waited for is undebuggable; the
    // child's own last lines say where it actually was.
    if (err instanceof Error) {
      const tail = stderr.join("").trimEnd().split("\n").slice(-15).join("\n");
      err.message += `\nchild pid ${child.pid} ${alive ? "still running" : "exited"}; last stderr:\n${tail || "(silent)"}`;
    }
    throw err;
  } finally {
    child.kill("SIGKILL");
    await exited;
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function mcpPost(port, token, id = 1) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "wazap-daemon-test", version: "0" },
      },
    }),
    signal: AbortSignal.timeout(5_000),
  });
}

/** A port nobody is listening on, so a health probe has to fail. */
async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** One Streamable HTTP MCP session: initialize, then ask what tools it was given. */
async function httpToolCount(port, token) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  let sessionId = null;
  const post = async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: sessionId === null ? headers : { ...headers, "mcp-session-id": sessionId },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    sessionId ??= res.headers.get("mcp-session-id");
    const text = await res.text();
    // The transport answers over SSE, so the payload arrives as data: lines.
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return line === undefined ? null : JSON.parse(line.slice(6));
  };

  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "wazap-daemon-test", version: "0" },
    },
  });
  assert.equal(init.result.serverInfo.name, "wazap");
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  return list.result.tools.length;
}

test("a sidecar round-trips and is readable only by its owner", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "nested", "daemon.json");
    writeDaemon(file, SAMPLE);
    assert.deepEqual(readDaemon(file), SAMPLE);
    assert.equal(mode(file), 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rewriting over a world-readable sidecar tightens it back to 0600", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "daemon.json");
    writeFileSync(file, "{}", { mode: 0o644 });
    writeDaemon(file, SAMPLE);
    assert.equal(mode(file), 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing, unparsable or mis-shaped sidecar reads as null", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "daemon.json");
    assert.equal(readDaemon(file), null, "missing");

    writeFileSync(file, "{not json");
    assert.equal(readDaemon(file), null, "garbage");

    for (const bad of [
      null,
      [SAMPLE],
      { ...SAMPLE, pid: "4242" },
      { ...SAMPLE, pid: 0 },
      { ...SAMPLE, port: 1.5 },
      { ...SAMPLE, token: "" },
      { ...SAMPLE, version: 9 },
      { pid: 1, port: 2 },
    ]) {
      writeFileSync(file, JSON.stringify(bad));
      assert.equal(readDaemon(file), null, `wrong shape: ${JSON.stringify(bad)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remove takes our own sidecar and is idempotent", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "daemon.json");
    writeDaemon(file, { ...SAMPLE, pid: process.pid });
    removeDaemon(file);
    assert.equal(existsSync(file), false);
    removeDaemon(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remove leaves another process's sidecar alone", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "daemon.json");
    writeDaemon(file, SAMPLE);
    removeDaemon(file);
    assert.equal(existsSync(file), true, "we must never delete a sidecar we do not own");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a served session publishes a loopback endpoint only its token opens", async () => {
  await withDaemon({}, async ({ child, stderr, daemonFile }) => {
    const info = await waitFor(() => readDaemon(daemonFile), STARTUP_MS, "daemon.json to appear");
    assert.equal(info.pid, child.pid);
    assert.ok(info.port > 0, `port ${info.port}`);
    assert.match(info.token, /^[0-9a-f]{64}$/);
    assert.equal(mode(daemonFile), 0o600);

    const health = await fetch(`http://127.0.0.1:${info.port}/healthz`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    assert.equal(await daemonHealthy(info.port, 5_000), true, "the live port is healthy");
    assert.equal(await daemonHealthy(await closedPort(), 2_000), false, "nothing is listening there");

    assert.equal((await mcpPost(info.port, null)).status, 401, "no bearer token");
    assert.equal((await mcpPost(info.port, "0".repeat(64))).status, 401, "wrong bearer token");

    const authed = await mcpPost(info.port, info.token, 2);
    assert.equal(authed.status, 200);
    // The transport answers an initialize as SSE, so read the payload as text.
    assert.match(await authed.text(), /"serverInfo":\{"name":"wazap"/);

    assert.ok(!stderr.join("").includes(info.token), "the token must never reach a log line");
  });
});

test("--http publishes its own port and takes the internal token as a full-access bearer", async () => {
  await withDaemon(
    {},
    async ({ daemonFile }) => {
      const info = await waitFor(() => readDaemon(daemonFile), STARTUP_MS, "daemon.json to appear");
      assert.ok(info.port > 0, `port ${info.port}`);

      const health = await fetch(`http://127.0.0.1:${info.port}/healthz`, { signal: AbortSignal.timeout(5_000) });
      assert.equal((await health.json()).ok, true);

      // No read token, so the endpoint is open; the internal token is what unlocks writes.
      assert.equal(await httpToolCount(info.port, null), READ_TOOL_COUNT, "remote readers see only the current catalogue");
      assert.equal(await httpToolCount(info.port, info.token), TOOL_COUNT, "the internal token gets everything");
    },
    ["serve", "--http", "--port", "0"]
  );
});

test("SIGTERM clears the sidecar and the lock", async () => {
  await withDaemon({}, async ({ child, hasExited, daemonFile, lockFile }) => {
    await waitFor(() => readDaemon(daemonFile), STARTUP_MS, "daemon.json to appear");
    child.kill("SIGTERM");
    await waitFor(hasExited, SHUTDOWN_MS, "the daemon to exit");
    assert.equal(existsSync(daemonFile), false, "daemon.json outlived the daemon");
    assert.equal(existsSync(lockFile), false, "server.lock outlived the daemon");
  });
});

test("closing the client's stdin ends the daemon rather than leaving it listening", async () => {
  await withDaemon({}, async ({ child, hasExited, daemonFile, lockFile }) => {
    await waitFor(() => readDaemon(daemonFile), STARTUP_MS, "daemon.json to appear");
    child.stdin.end();
    await waitFor(hasExited, SHUTDOWN_MS, "the daemon to exit");
    assert.equal(existsSync(daemonFile), false, "daemon.json outlived the daemon");
    assert.equal(existsSync(lockFile), false, "server.lock outlived the daemon");
  });
});

test("status names the endpoint a served session is shared on, and never its token", async () => {
  await withDaemon({}, async ({ child, dataDir, daemonFile }) => {
    const info = await waitFor(() => readDaemon(daemonFile), STARTUP_MS, "daemon.json to appear");

    const human = await status(dataDir);
    assert.equal(
      human.stderr.split("\n").find((line) => line.startsWith("server:")),
      `server: running (pid ${child.pid}, sharing on 127.0.0.1:${info.port})`
    );

    const { stdout } = await status(dataDir, ["--json"]);
    const report = JSON.parse(stdout);
    assert.equal(report.daemon.pid, child.pid);
    assert.equal(report.daemon.port, info.port);
    assert.ok(!stdout.includes(info.token), "the token must never reach the report");
  });
});

test("status leaves the sharing suffix off a session that is not shared", async () => {
  await withDaemon({ WAZAP_NO_SHARE: "1" }, async ({ child, dataDir, lockFile }) => {
    await waitFor(() => existsSync(lockFile), STARTUP_MS, "server.lock to appear");
    const { stderr } = await status(dataDir);
    assert.equal(
      stderr.split("\n").find((line) => line.startsWith("server:")),
      `server: running (pid ${child.pid})`
    );
  });
});

function silentHub() {
  return stubAccountSource({
    getStatus: () => ({ status: "not_linked", status_since: new Date().toISOString(), account_id: "default" }),
  });
}

test("a taken listen port rejects instead of hanging", async () => {
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen({ port: 0, host: "127.0.0.1", exclusive: true }, resolve));
  const { address, port } = blocker.address();
  try {
    await assert.rejects(
      startHttpEndpoint(silentHub(), offlineConfig("wazap-listen-"), {
        host: address,
        port,
        credentials: [],
        openRead: false,
      }),
      (err) => err.code === "EADDRINUSE"
    );
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test("a taken listen port rejects across address families", async () => {
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen({ port: 0, exclusive: true }, resolve));
  const { port } = blocker.address();
  try {
    await assert.rejects(
      startHttpEndpoint(silentHub(), offlineConfig("wazap-listen-family-"), {
        host: "127.0.0.1",
        port,
        credentials: [],
        openRead: false,
      }),
      (err) => err.code === "EADDRINUSE"
    );
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test("an already-aborted signal does not leave a listener", async () => {
  const port = await closedPort();
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(
    startHttpEndpoint(silentHub(), offlineConfig("wazap-listen-abort-"), {
      host: "127.0.0.1",
      port,
      credentials: [],
      openRead: false,
      signal: stop.signal,
    })
  );
  const live = new AbortController();
  await startHttpEndpoint(silentHub(), offlineConfig("wazap-listen-abort-live-"), {
    host: "127.0.0.1",
    port,
    credentials: [],
    openRead: false,
    signal: live.signal,
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5_000) });
    const body = await res.json();
    assert.equal(body.status, "not_linked");
  } finally {
    live.abort();
  }
});

test("an abandoned MCP session is reaped, and over the cap the idlest is", async () => {
  const port = await closedPort();
  const stop = new AbortController();
  await startHttpEndpoint(silentHub(), offlineConfig("wazap-sessions-"), {
    host: "127.0.0.1",
    port,
    credentials: [],
    openRead: true,
    signal: stop.signal,
    sessionTtlMs: 60,
    sessionSweepMs: 20,
    sessionMax: 2,
  });
  const open = async () => (await mcpPost(port)).headers.get("mcp-session-id");
  const ping = (sid) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sid,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping", params: {} }),
      signal: AbortSignal.timeout(5_000),
    }).then((res) => res.status);
  try {
    const s1 = await open();
    await open();
    const s3 = await open(); // the third over a cap of 2 evicts s1, the idlest
    assert.equal(await ping(s3), 200, "the newest session lives");
    await waitFor(async () => (await ping(s1)) === 404, 5_000, "the evicted session to answer 404");
    // TTL: left untouched past 60ms, the sweep closes s3 too.
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(await ping(s3), 404, "an idle session is reaped by the sweep");
  } finally {
    stop.abort();
  }
});

const PING = { jsonrpc: "2.0", id: 9, method: "ping", params: {} };
const SESSION_NOT_FOUND = { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null };

/** An open endpoint for the session cases; `stop` tears it down. */
async function sessionEndpoint(prefix, bounds = {}) {
  const port = await closedPort();
  const stop = new AbortController();
  await startHttpEndpoint(silentHub(), offlineConfig(prefix), {
    host: "127.0.0.1",
    port,
    credentials: [],
    openRead: true,
    signal: stop.signal,
    ...bounds,
  });
  return { port, stop: () => stop.abort() };
}

/** One call to /mcp, carrying `sid` the way a client that holds a session does. */
function mcpCall(port, method, sid, body) {
  const headers = { accept: "application/json, text/event-stream" };
  if (sid !== undefined) headers["mcp-session-id"] = sid;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
}

test("a session id the server does not hold is a 404 on POST, GET and DELETE; no id at all stays a 400", async () => {
  const { port, stop } = await sessionEndpoint("wazap-unknown-session-");
  try {
    const stale = randomUUID();
    for (const [method, body] of [["POST", PING], ["GET"], ["DELETE"]]) {
      const lost = await mcpCall(port, method, stale, body);
      assert.equal(lost.status, 404, `${method} with a session id nobody holds`);
      assert.deepEqual(await lost.json(), SESSION_NOT_FOUND, method);
      const bare = await mcpCall(port, method, undefined, body);
      assert.equal(bare.status, 400, `${method} with no session id and no initialize`);
      assert.equal((await bare.json()).error.code, -32000, method);
    }
  } finally {
    stop();
  }
});

test("a client told 404 starts over with initialize and carries on", async () => {
  const { port, stop } = await sessionEndpoint("wazap-reinit-");
  try {
    const stale = randomUUID();
    assert.equal((await mcpCall(port, "POST", stale, PING)).status, 404);

    const init = await mcpPost(port);
    assert.equal(init.status, 200);
    const fresh = init.headers.get("mcp-session-id");
    await init.text();
    assert.ok(fresh && fresh !== stale, "a new session, not the lost one");
    const pong = await mcpCall(port, "POST", fresh, PING);
    assert.equal(pong.status, 200);
    assert.match(await pong.text(), /"result":\{\}/);

    // A client that still sends the dead id along with its initialize is not held to it.
    const stubborn = await mcpCall(port, "POST", stale, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "wazap-daemon-test", version: "0" },
      },
    });
    assert.equal(stubborn.status, 200);
    await stubborn.text();
  } finally {
    stop();
  }
});

test("an evicted session leaves the map before it closes, so a racing request sees 200 or 404 and nothing else", async () => {
  const { port, stop } = await sessionEndpoint("wazap-evict-race-", { sessionMax: 1 });
  const open = async () => {
    const res = await mcpPost(port);
    await res.text();
    return res.headers.get("mcp-session-id");
  };
  const ping = async (sid) => {
    const res = await mcpCall(port, "POST", sid, PING);
    await res.text();
    return res.status;
  };
  try {
    const s1 = await open();
    // The initialize that evicts s1 over a cap of 1 races a burst of pings on it.
    const [s2, ...racing] = await Promise.all([open(), ...Array.from({ length: 8 }, () => ping(s1))]);
    for (const status of racing) assert.ok(status === 200 || status === 404, `a racing ping answered ${status}`);
    assert.equal(await ping(s1), 404, "evicted, and told so on the very next request");
    assert.equal(await ping(s2), 200, "the session that evicted it lives");
  } finally {
    stop();
  }
});

test("without OAuth, a refused token is told invalid_token and a missing one gets no challenge", async () => {
  const port = await closedPort();
  const stop = new AbortController();
  await startHttpEndpoint(silentHub(), offlineConfig("wazap-refused-"), {
    host: "127.0.0.1",
    port,
    credentials: [{ token: "right", write: false }],
    openRead: false,
    signal: stop.signal,
  });
  try {
    const none = await mcpPost(port, null);
    assert.equal(none.status, 401);
    assert.equal(none.headers.get("www-authenticate"), null, "no token, no OAuth: nothing to say");
    const wrong = await mcpPost(port, "wrong");
    assert.equal(wrong.status, 401);
    assert.equal(
      wrong.headers.get("www-authenticate"),
      'Bearer error="invalid_token", error_description="The bearer token is unknown or has expired"'
    );
    assert.equal((await mcpPost(port, "right")).status, 200);
  } finally {
    stop.abort();
  }
});

test("WAZAP_NO_SHARE serves stdio with no sidecar at all", async () => {
  await withDaemon({ WAZAP_NO_SHARE: "1" }, async ({ child, daemonFile, lockFile }) => {
    await waitFor(() => existsSync(lockFile), STARTUP_MS, "server.lock to appear");
    const { request } = mcpClient(child);
    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "wazap-daemon-test", version: "0" },
    });
    assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
    assert.equal(existsSync(daemonFile), false, "sharing was off, so nothing may be published");
  });
});

/** A server whose only job is to answer /healthz from a status we dictate. */
async function withHealth(status, sinceMsAgo, fn) {
  const port = await closedPort();
  const stop = new AbortController();
  const wa = {
    getStatus: () => ({
      status,
      status_since: new Date(Date.now() - sinceMsAgo).toISOString(),
      account_id: "default",
    }),
  };
  await startHttpEndpoint(stubAccountSource(wa), offlineConfig("wazap-health-"), {
    host: "127.0.0.1",
    port,
    credentials: [],
    openRead: false,
    signal: stop.signal,
  });
  try {
    return await fn(port);
  } finally {
    stop.abort();
  }
}

async function healthOf(status, sinceMsAgo) {
  return withHealth(status, sinceMsAgo, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5_000) });
    return { code: res.status, body: await res.json() };
  });
}

const MINUTE = 60_000;

test("a connected socket is healthy however long it has been connected", async () => {
  const { code, body } = await healthOf("connected", 30 * MINUTE);
  assert.equal(code, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, "connected");
});

test("a reconnect in progress is not yet an outage", async () => {
  const { code, body } = await healthOf("disconnected", MINUTE);
  assert.equal(code, 200, "a monitor must not page on a socket that is coming back");
  assert.equal(body.ok, true);
});

test("two minutes off the air answers 503, with the status and since a monitor can read", async () => {
  const { code, body } = await healthOf("disconnected", 3 * MINUTE);
  assert.equal(code, 503);
  assert.equal(body.ok, false);
  assert.equal(body.status, "disconnected");
  assert.ok(Date.now() - Date.parse(body.since) >= 3 * MINUTE, `since: ${body.since}`);
});

test("a not_linked owner that has been up for minutes is still a bridge, not an older version", async () => {
  await withHealth("not_linked", 3 * MINUTE, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5_000) });
    const body = await res.json();
    assert.equal(res.status, 503, "a monitor still sees the outage");
    assert.equal(body.ok, false);
    assert.equal(body.status, "not_linked");
    assert.equal(await daemonHealthy(port, 2_000), true, "the sidecar is reachable");

    const dataDir = tempDir();
    const p = paths(dataDir);
    writeFileSync(p.lockFile, `${process.pid}\n`, { mode: 0o600 });
    writeDaemon(p.daemonFile, { pid: process.pid, port, token: "ab", version: "0.11.0" });
    const role = await decideRole({ ...offlineConfig("wazap-role-"), dataDir, share: true, transport: "stdio" }, p);
    assert.equal(role.kind, "bridge");
    if (role.kind === "bridge") assert.equal(role.daemon.port, port);
  });
});
