/**
 * `wazap proxy`: stdio served from whichever server holds the session, across
 * its restarts, and never the holder itself. Every case runs against a
 * throwaway data dir, never the real ~/.wazap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { readDaemon } from "../dist/daemon.js";
import { sessionLost } from "../dist/proxy.js";
import { mcpClient, spawnWazap, waitFor } from "./helpers.mjs";

function scene() {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-proxy-"));
  const started = [];
  const start = (args = [], env = {}) => {
    const { child, stderr } = spawnWazap({ dataDir, args, env });
    const wazap = { child, stderr, code: undefined };
    wazap.exited = new Promise((resolve) => {
      child.once("exit", (code) => {
        wazap.code = code;
        resolve(code);
      });
    });
    wazap.hasExited = () => wazap.code !== undefined;
    started.push(wazap);
    return wazap;
  };
  const close = async () => {
    for (const wazap of started) wazap.child.kill("SIGKILL");
    await Promise.all(started.map((wazap) => wazap.exited));
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { dataDir, start, close, daemonFile: join(dataDir, "daemon.json"), lockFile: join(dataDir, "server.lock") };
}

async function session(child) {
  const { request, notify } = mcpClient(child);
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "wazap-proxy-test", version: "0" },
  });
  assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
  notify("notifications/initialized");
  return { init: init.result, request };
}

/** A holder that owns the session: a stdio server, which publishes its loopback endpoint for others. */
async function holder(s) {
  const a = s.start();
  await waitFor(() => readDaemon(s.daemonFile)?.pid === a.child.pid, 15_000, "the holder to publish daemon.json");
  return a;
}

test("the proxy serves the holder's tools and get_status, and never takes the lock", async () => {
  const s = scene();
  try {
    const a = await holder(s);
    const p = s.start(["proxy"]);
    const mcp = await session(p.child);
    assert.equal(mcp.init.serverInfo.name, "wazap");
    const tools = await mcp.request("tools/list", {});
    assert.ok(tools.result.tools.some((tool) => tool.name === "get_status"));
    const status = await mcp.request("tools/call", { name: "get_status", arguments: {} });
    assert.equal(status.result.structuredContent.status, "not_linked");
    assert.equal(readFileSync(s.lockFile, "utf8").trim(), String(a.child.pid), "the proxy must never own the session");
    assert.ok(!p.stderr.join("").includes(readDaemon(s.daemonFile).token), "the token must never reach a log line");
  } finally {
    await s.close();
  }
});

test("the proxy outlives a restart of the holder and answers from the new one", async () => {
  const s = scene();
  try {
    const a = await holder(s);
    const p = s.start(["proxy"]);
    const mcp = await session(p.child);
    assert.equal((await mcp.request("tools/call", { name: "get_status", arguments: {} })).result.isError, undefined);

    a.child.kill("SIGKILL");
    await a.exited;
    // The holder is gone: the proxy waits rather than exiting, so its client keeps the connection.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(p.hasExited(), false, "the proxy must not exit when the holder goes");
    assert.equal(existsSync(s.lockFile) && readFileSync(s.lockFile, "utf8").trim() === String(p.child.pid), false);

    const b = s.start();
    await waitFor(() => readDaemon(s.daemonFile)?.pid === b.child.pid, 15_000, "the new holder to publish itself");
    const after = await mcp.request("tools/call", { name: "get_status", arguments: {} });
    assert.equal(after.result.structuredContent.status, "not_linked");
    assert.match(p.stderr.join(""), new RegExp(`held by pid ${b.child.pid}`));
  } finally {
    await s.close();
  }
});

test("with no holder, a call says the server is not running instead of hanging or owning the session", async () => {
  const s = scene();
  try {
    const p = s.start(["proxy"], { WAZAP_PROXY_WAIT_MS: "500" });
    const mcp = await session(p.child);
    const status = await mcp.request("tools/call", { name: "get_status", arguments: {} });
    assert.equal(status.result.isError, true);
    assert.equal(JSON.parse(status.result.content[0].text).error, "NOT_CONNECTED");
    assert.equal(existsSync(s.lockFile), false, "a proxy with no holder must not become one");
  } finally {
    await s.close();
  }
});

test("a plain stdio start beside an installed service reconnects like the proxy instead of exiting", async () => {
  const s = scene();
  try {
    const a = await holder(s);
    writeFileSync(
      join(s.dataDir, "service.json"),
      JSON.stringify({ supervisor: "launchd", label: "com.wazap.test", unitFile: join(s.dataDir, "unit.plist"), port: 1, logDir: s.dataDir, installedVersion: "0.0.0" })
    );
    const bridge = s.start();
    const mcp = await session(bridge.child);
    await mcp.request("tools/list", {});
    a.child.kill("SIGKILL");
    await a.exited;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(bridge.hasExited(), false, "beside a service, the bridge waits for the holder to come back");
  } finally {
    await s.close();
  }
});

test("only a 404 from the holder counts as a forgotten session, the one answer that is safe to send again", () => {
  assert.equal(sessionLost(new StreamableHTTPError(404, "Session not found")), true);
  assert.equal(sessionLost(new StreamableHTTPError(500, "boom")), false);
  assert.equal(sessionLost(new Error("socket hang up")), false);
});

test("a proxy started before any holder tells its client to list the tools once one comes up", async () => {
  const s = scene();
  try {
    const p = s.start(["proxy"], { WAZAP_PROXY_WAIT_MS: "300" });
    let out = "";
    p.child.stdout.on("data", (chunk) => (out += chunk.toString()));
    const mcp = await session(p.child);
    assert.deepEqual((await mcp.request("tools/list", {})).result.tools, [], "no holder yet: no tools, and no hang");
    const a = await holder(s);
    await waitFor(() => out.includes("notifications/tools/list_changed"), 15_000, "the proxy to announce the tools");
    assert.ok((await mcp.request("tools/list", {})).result.tools.some((tool) => tool.name === "get_status"));
    assert.notEqual(readFileSync(s.lockFile, "utf8").trim(), String(p.child.pid));
    assert.equal(readDaemon(s.daemonFile).pid, a.child.pid);
  } finally {
    await s.close();
  }
});
