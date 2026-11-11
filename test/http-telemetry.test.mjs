/**
 * What the owner reads in the log to learn which cloud clients connect and
 * what crosses the tunnel: at initialize the client's name and version, its
 * protocol, the kind of credential and the public host it came through; per
 * request the bytes sent, their encoding and what became of the session. All
 * bounded labels: never a token, a session id or a raw header.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { request } from "node:http";
import { startHttpEndpoint } from "../dist/server.js";
import { offlineConfig, stubAccountSource } from "./helpers.mjs";

const wa = { getStatus: () => ({ status: "connected", status_since: new Date().toISOString() }) };

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
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    process.stderr.write = original;
  }
  return lines.join("");
}

function post(port, body, { sid, host, encoding } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer SECRET-TOKEN-VALUE",
          ...(host ? { host } : {}),
          ...(sid ? { "mcp-session-id": sid } : {}),
          ...(encoding ? { "accept-encoding": encoding } : {}),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, sid: res.headers["mcp-session-id"] }));
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

test("initialize names the client, protocol, credential kind and public host; each request its bytes, encoding and session", async (t) => {
  const config = offlineConfig("wazap-telemetry-", { readOnly: false });
  const stop = new AbortController();
  t.after(() => {
    stop.abort();
    rmSync(config.dataDir, { recursive: true, force: true });
  });
  const port = await startHttpEndpoint(stubAccountSource(wa), config, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    credentials: [{ token: "SECRET-TOKEN-VALUE", write: true, label: "token:cloud" }],
    signal: stop.signal,
  });
  let sid;
  const logs = await stderrOf(async () => {
    const session = await post(
      port,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: 'claude-ai"\nFORGED', version: "0.1.0" } },
      },
      { host: "wazap.example.com" }
    );
    sid = session.sid;
    await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { sid, encoding: "gzip" });
    await post(port, { jsonrpc: "2.0", id: 3, method: "ping" }, { sid: `${sid.split(".")[0]}.AAAAAAAAAAAAAAAAAAAAAA` });
  });
  assert.match(logs, /MCP initialize: client="claude-aiFORGED 0\.1\.0" protocol=2025-06-18 credential=token host=wazap\.example\.com/);
  assert.match(logs, /HTTP POST \/mcp rpc=initialize .* -> 200 \(\d+ms\) bytes=\d+ enc=gzip session=new|HTTP POST \/mcp rpc=initialize .* -> 200 \(\d+ms\) bytes=\d+ enc=identity session=new/);
  const list = /HTTP POST \/mcp rpc=tools\/list .* -> 200 \(\d+ms\) bytes=(\d+) enc=gzip session=reused/.exec(logs);
  assert.ok(list, logs);
  assert.ok(Number(list[1]) > 1000 && Number(list[1]) < 20_000, `tools/list crossed as ${list[1]} compressed bytes`);
  assert.match(logs, /rpc=ping .* -> 404 \(\d+ms\) bytes=\d+ enc=identity session=lost/);
  for (const secret of ["SECRET-TOKEN-VALUE", sid, sid.split(".")[0], "\nFORGED"]) assert.ok(!logs.includes(secret), `the log leaked ${JSON.stringify(secret)}`);
});
