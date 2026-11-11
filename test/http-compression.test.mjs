/**
 * /mcp answers are compressed at the origin, because no tunnel in front of
 * wazap does it for SSE: gzip when the client asks for it, never when it does
 * not, never for a body too small to gain, and with a flush after every SSE
 * event, so a streamed answer arrives as promptly as an uncompressed one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { createGunzip, gunzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { acceptsGzip, COMPRESS_MIN_BYTES } from "../dist/http-compress.js";
import { COMPRESS_HOLD_MS, writeResponse } from "../dist/mcp-http.js";
import { startHttpEndpoint } from "../dist/server.js";
import { asToolSource, offlineConfig } from "./helpers.mjs";

test("Accept-Encoding: gzip by name, alias or wildcard, never at q=0", () => {
  for (const header of ["gzip", "gzip, deflate", "deflate, gzip, br, zstd", "x-gzip", "*", "br;q=1, gzip;q=0.5", ["deflate", "gzip"]]) {
    assert.equal(acceptsGzip(header), true, JSON.stringify(header));
  }
  for (const header of [undefined, "", "identity", "br", "deflate", "gzip;q=0", "gzip;q=0, *", "*;q=0", "gzip;q=junk"]) {
    assert.equal(acceptsGzip(header), false, JSON.stringify(header));
  }
});

const wa = {
  getStatus: () => ({ status: "connected", status_since: new Date().toISOString(), read_only: false }),
  // A wait that answers after a while: headers held for compression must not hold the answer.
  waitForMessages: async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { messages: [], cursor: "boot:0", timed_out: true, cursor_reset: false };
  },
};

async function boot(t) {
  const config = offlineConfig("wazap-compress-", { readOnly: false });
  const stop = new AbortController();
  t.after(() => {
    stop.abort();
    rmSync(config.dataDir, { recursive: true, force: true });
  });
  const port = await startHttpEndpoint(asToolSource(wa), config, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    credentials: [{ token: "w", write: true }],
    signal: stop.signal,
  });
  return port;
}

/** One raw request: the bytes exactly as they crossed the wire, and the headers. */
function raw(port, { method = "POST", body, sid, encoding } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method,
        headers: {
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
          accept: method === "POST" ? "application/json, text/event-stream" : "text/event-stream",
          authorization: "Bearer w",
          ...(sid ? { "mcp-session-id": sid } : {}),
          ...(encoding ? { "accept-encoding": encoding } : {}),
        },
      },
      (res) => {
        const chunks = [];
        if (method === "GET") {
          // The standalone stream never ends; its headers are what matter.
          res.destroy();
          resolve({ status: res.statusCode, headers: res.headers, wire: Buffer.alloc(0) });
          return;
        }
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, wire: Buffer.concat(chunks) }));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gzip", version: "1" } } };
const decoded = (answer) => (answer.headers["content-encoding"] === "gzip" ? gunzipSync(answer.wire) : answer.wire).toString("utf8");

test("tools/list is gzip on the wire for a client that asks, the same text decoded, and identity for one that does not", async (t) => {
  const port = await boot(t);
  const session = await raw(port, { body: initialize });
  const sid = session.headers["mcp-session-id"];
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const plain = await raw(port, { body: list, sid });
  const packed = await raw(port, { body: list, sid, encoding: "gzip, deflate" });
  assert.equal(plain.headers["content-encoding"], undefined, "never compressed for a client that did not ask");
  assert.equal(packed.headers["content-encoding"], "gzip");
  assert.equal(packed.headers.vary, "Accept-Encoding");
  assert.equal(plain.headers.vary, "Accept-Encoding");
  assert.equal(decoded(packed), decoded(plain));
  assert.ok(packed.wire.length * 3 < plain.wire.length, `tools/list ${plain.wire.length} B -> ${packed.wire.length} B`);
  assert.match(decoded(packed), /"name":"send_message"/);
});

const curl = spawnSync("curl", ["--version"], { encoding: "utf8" });
test("curl --compressed gets gzip on the wire and the same answer decoded", { skip: curl.status !== 0 && "no curl here", timeout: 15_000 }, async (t) => {
  const port = await boot(t);
  const sid = (await raw(port, { body: initialize })).headers["mcp-session-id"];
  const run = (extra) =>
    new Promise((resolve, reject) => {
      execFile(
        "curl",
        ["-s", "-D", "-", "-X", "POST", `http://127.0.0.1:${port}/mcp`, "-H", "content-type: application/json", "-H", "accept: application/json, text/event-stream",
          "-H", "authorization: Bearer w", "-H", `mcp-session-id: ${sid}`, "--data", JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }), "-w", "\nwire=%{size_download}", ...extra],
        { encoding: "utf8", maxBuffer: 1 << 22 },
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      );
    });
  const packed = await run(["--compressed"]);
  const plain = await run([]);
  assert.match(packed, /content-encoding: gzip/i);
  assert.doesNotMatch(plain, /content-encoding/i);
  const body = (text) => text.slice(text.indexOf("event: message"), text.lastIndexOf("\nwire="));
  assert.equal(body(packed), body(plain));
  const wire = (text) => Number(/wire=(\d+)/.exec(text)[1]);
  assert.ok(wire(packed) * 3 < wire(plain), `curl saw ${wire(packed)} B compressed against ${wire(plain)} B`);
});

test("a body under the threshold goes as it is, whatever the client accepts", async (t) => {
  const port = await boot(t);
  const session = await raw(port, { body: initialize, encoding: "gzip" });
  const sid = session.headers["mcp-session-id"];
  const ping = await raw(port, { body: { jsonrpc: "2.0", id: 3, method: "ping" }, sid, encoding: "gzip" });
  assert.equal(ping.headers["content-encoding"], undefined);
  assert.ok(ping.wire.length < COMPRESS_MIN_BYTES);
  assert.equal(Number(ping.headers["content-length"]), ping.wire.length, "a held answer is sent whole, with its length");
  const accepted = await raw(port, { body: { jsonrpc: "2.0", method: "notifications/initialized" }, sid, encoding: "gzip" });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers["content-encoding"], undefined);
});

test("the standalone GET stream is never compressed: an encoder held open for a session's life costs memory for nothing", async (t) => {
  const port = await boot(t);
  const session = await raw(port, { body: initialize });
  const stream = await raw(port, { method: "GET", sid: session.headers["mcp-session-id"], encoding: "gzip" });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers["content-type"], "text/event-stream");
  assert.equal(stream.headers["content-encoding"], undefined);
});

test("the SDK client (Node fetch sends gzip, deflate) lists tools and waits through compressed SSE", { timeout: 15_000 }, async (t) => {
  const port = await boot(t);
  const client = new Client({ name: "gzip-client", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: "Bearer w" } } }));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "send_message"));
  const started = Date.now();
  const waited = await client.callTool({ name: "wait_for_messages", arguments: { timeout_seconds: 1 } });
  assert.equal(waited.structuredContent.timed_out, true);
  assert.ok(Date.now() - started < 1_000, "the held headers did not hold the answer");
});

/** An SSE answer whose events the test releases one at a time, written by wazap's writer onto a real socket. */
async function streamed(t, encoding) {
  let controller;
  const body = new ReadableStream({ start: (c) => { controller = c; } });
  const server = createServer((req, res) => {
    void writeResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }), res, encoding !== undefined);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const events = [];
  const answer = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.address().port, headers: encoding ? { "accept-encoding": encoding } : {} }, resolve);
    req.on("error", reject);
    req.end();
  });
  const text = answer.headers["content-encoding"] === "gzip" ? answer.pipe(createGunzip()) : answer;
  let buffered = "";
  text.on("data", (chunk) => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf("\n\n")) !== -1) {
      events.push({ at: Date.now(), text: buffered.slice(0, end) });
      buffered = buffered.slice(end + 2);
    }
  });
  const send = (text) => {
    controller.enqueue(new TextEncoder().encode(`${text}\n\n`));
    return Date.now();
  };
  const arrived = async (count) => {
    for (let i = 0; i < 200 && events.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    return events[count - 1];
  };
  return { answer, send, arrived, close: () => controller.close() };
}

test("every compressed SSE event, keep-alive comments included, arrives as it is written", { timeout: 15_000 }, async (t) => {
  const stream = await streamed(t, "gzip");
  // Past the hold, with nothing written yet: the headers go, committed to gzip.
  await new Promise((resolve) => setTimeout(resolve, COMPRESS_HOLD_MS + 30));
  assert.equal(stream.answer.headers["content-encoding"], "gzip");
  const timings = [];
  for (const text of [": keepalive", `event: message\ndata: ${JSON.stringify({ result: "x".repeat(4000) })}`, ": keepalive", 'event: message\ndata: {"result":{}}']) {
    const sent = stream.send(text);
    const event = await stream.arrived(timings.length + 1);
    assert.equal(event?.text, text);
    timings.push(event.at - sent);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  stream.close();
  // Unflushed, an event would wait for 16 KiB more or the end of the stream, which the test never sends.
  assert.ok(Math.max(...timings) < 150, `each event decoded within 150 ms of being written: ${timings.join(", ")} ms`);
});

test("an uncompressed SSE stream starts at once and streams the same way", { timeout: 15_000 }, async (t) => {
  const stream = await streamed(t, undefined);
  assert.equal(stream.answer.headers["content-encoding"], undefined);
  const sent = stream.send(": keepalive");
  const event = await stream.arrived(1);
  assert.equal(event?.text, ": keepalive");
  assert.ok(event.at - sent < 150);
  stream.close();
});

test("a compressed answer settles when its client stops reading and then leaves", { timeout: 15_000 }, async (t) => {
  // One event the size of get_media's largest inline image, base64: far more
  // than the encoder and the socket buffer between them, so the encoder waits
  // for room the paused client never makes.
  const event = `event: message\ndata: {"x":"${randomBytes(1_000_000).toString("base64")}"}\n\n`;
  let settled;
  const server = createServer((req, res) => {
    const body = new ReadableStream({
      start: (controller) => setTimeout(() => controller.enqueue(new TextEncoder().encode(event)), COMPRESS_HOLD_MS + 10),
    });
    settled = writeResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }), res, true).then(() => Date.now());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const answer = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.address().port, headers: { "accept-encoding": "gzip" } }, resolve);
    req.on("error", reject);
    req.end();
  });
  assert.equal(answer.headers["content-encoding"], "gzip");
  answer.pause();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const left = Date.now();
  answer.destroy();
  const at = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve(null), 3_000))]);
  assert.notEqual(at, null, "writeResponse never settled after the client left");
  assert.ok(at - left < 1_000, `settled ${at - left} ms after the client left`);
});
