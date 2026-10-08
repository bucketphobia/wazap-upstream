// Synthetic E2E only: real HTTP MCP SDK/registry/service/database; fake WhatsApp socket and loopback provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { startHttpEndpoint } from "../dist/server.js";
import { asToolSource, connectedService } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";

async function fixture(t, respond) {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-synthetic-mcp-"));
  const seen = [];
  const sessions = [];
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { path: req.url, headers: req.headers, bytes: Buffer.concat(chunks) };
    seen.push(call);
    res.setHeader("content-type", "application/json");
    respond(call, res);
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const session of sessions) await session.close();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });
  async function boot(env) {
    const names = [...new Set([...Object.keys(process.env).filter((k) => k.startsWith("WAZAP_") || k === "OPENAI_API_KEY"), ...Object.keys(env)])];
    const saved = names.map((k) => [k, process.env[k]]);
    let connected;
    try {
      for (const k of names) delete process.env[k];
      for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
      connected = connectedService(WhatsAppService, { prefix: "wazap-synthetic-config-", id: ME, name: "Synthetic",
        config: { dataDir, readOnly: true, persistHistory: true } });
    } finally {
      for (const [k, value] of saved) {
        if (value === undefined) delete process.env[k];
        else process.env[k] = value;
      }
    }
    const { svc, sock } = connected;
    // Bytes are synthetic; the actual transcriber and embedding engine remain intact.
    svc.mediaBuffer = async () => Buffer.from("OggS synthetic audio");
    await svc.bootStorage();
    const stop = new AbortController();
    const port = await startHttpEndpoint(asToolSource(svc), svc.config, { host: "127.0.0.1", port: 0,
      openRead: false, signal: stop.signal, credentials: [{ token: "synthetic-mcp-reader", write: false }] });
    const client = new Client({ name: "synthetic-e2e", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: "Bearer synthetic-mcp-reader" } },
    }));
    let closed = false;
    const session = { svc, sock, client, call: (name, args) => client.callTool({ name, arguments: args }),
      async close() { if (closed) return; closed = true; await client.close(); stop.abort(); await svc.stop(); } };
    sessions.push(session);
    return session;
  }
  return { dataDir, seen, boot, url: `http://127.0.0.1:${provider.address().port}/openai` };
}

function deliver(sock, id, message) {
  sock.ev.emit("messages.upsert", { type: "notify", messages: [{
    key: { remoteJid: PEER, fromMe: false, id }, messageTimestamp: Math.floor(Date.now() / 1000), message,
  }] });
}

const settings = (url, overrides = {}) => ({ WAZAP_RECALL: "openai", WAZAP_EMBED_API_URL: url,
  WAZAP_EMBED_API_KEY: "synthetic-embedding-key", WAZAP_EMBED_API_MODEL: "provider/synthetic-3",
  WAZAP_EMBED_API_DIMS: "3", WAZAP_EMBED_API_MIN_SIMILARITY: "0.6",
  WAZAP_EMBED_API_INPUT_TYPE: "extra_params", ...overrides });

// These vectors are deterministic synthetic responses, not evidence of model retrieval quality.
// Detailed malformed-response, redaction, timeout/redirect, batching and retry cases live in recall-api.test.mjs.
test("synthetic HTTP MCP: meaning/words search, invalid vectors and provider outage fall back safely", async (t) => {
  let response = "good";
  const f = await fixture(t, (call, res) => {
    call.body = JSON.parse(call.bytes);
    if (response === "outage") return res.writeHead(503).end("synthetic-embedding-key private provider content");
    const vector = response === "dimensions" ? [1, 0] : response === "zero" ? [0, 0, 0] : [1, 0, 0];
    res.end(JSON.stringify({ data: call.body.input.map((_, index) => ({ index, embedding: vector })) }));
  });
  const s = await f.boot(settings(f.url));
  assert.ok((await s.client.listTools()).tools.some((tool) => tool.name === "search"));
  deliver(s.sock, "BANK", { conversation: "IBAN synthetic retained bank details" });
  await s.svc.recallIdle();
  assert.equal(s.svc.getStatus().recall.indexed, 1);
  assert.equal(f.seen[0].body.extra_params.input_type, "document");
  const meaning = (await s.call("search", { query: "bank account coordinates" })).structuredContent;
  assert.equal(meaning.mode, "hybrid");
  assert.equal(meaning.messages.length, 1, "synthetic vector finds text without lexical overlap");
  assert.equal(f.seen.at(-1).body.extra_params.input_type, "query");
  for (const upload of f.seen) {
    assert.equal(upload.path, "/openai/embeddings");
    assert.equal(upload.headers.authorization, "Bearer synthetic-embedding-key");
    assert.equal(upload.headers["x-bf-passthrough-extra-params"], "true");
    assert.equal(upload.body.model, "provider/synthetic-3");
  }
  const beforeWords = f.seen.length;
  const words = (await s.call("search", { query: "IBAN", match: "words" })).structuredContent;
  assert.equal(words.mode, "words");
  assert.equal(words.messages.length, 1);
  assert.equal(f.seen.length, beforeWords, "words search never uploads a query");
  for (response of ["dimensions", "zero", "outage"]) {
    const fallback = (await s.call("search", { query: "IBAN" })).structuredContent;
    assert.equal(fallback.mode, "keyword_fallback");
    assert.equal(fallback.messages.length, 1);
    assert.equal(fallback.recall_unavailable.code, "RECALL_FAILED");
    assert.doesNotMatch(JSON.stringify(fallback.recall_unavailable), /synthetic-embedding-key|private provider content/);
  }
});

test("synthetic HTTP MCP: persisted model spaces refill, credential rotation and duplicate delivery do not", async (t) => {
  const f = await fixture(t, (call, res) => {
    call.body = JSON.parse(call.bytes);
    const vector = call.body.model === "provider/synthetic-4" ? [1, 0, 0, 0] : [1, 0, 0];
    res.end(JSON.stringify({ data: call.body.input.map((_, index) => ({ index, embedding: vector })) }));
  });
  const original = settings(f.url);
  const first = await f.boot(original);
  deliver(first.sock, "PERSIST", { conversation: "IBAN persisted synthetic message" });
  await first.svc.recallIdle();
  assert.equal(f.seen.length, 1);
  deliver(first.sock, "PERSIST", { conversation: "IBAN persisted synthetic message" });
  await first.svc.recallIdle();
  assert.equal(f.seen.length, 1, "duplicate delivery reuses the text hash");
  await first.close();
  const rotated = await f.boot({ ...original, WAZAP_EMBED_API_KEY: "rotated-synthetic-key" });
  await rotated.svc.recallIdle();
  assert.equal(f.seen.length, 1, "key rotation preserves persisted vector identity");
  assert.equal((await rotated.call("search", { query: "IBAN" })).structuredContent.messages.length, 1);
  assert.equal(f.seen.at(-1).headers.authorization, "Bearer rotated-synthetic-key");
  await rotated.close();
  for (const override of [
    { WAZAP_EMBED_API_MODEL: "provider/synthetic-new" },
    { WAZAP_EMBED_API_MODEL: "provider/synthetic-4", WAZAP_EMBED_API_DIMS: "4" },
    { WAZAP_EMBED_API_URL: `${f.url}/other` },
    { WAZAP_EMBED_API_INPUT_TYPE: "direct" },
  ]) {
    const previous = f.seen.length;
    const next = await f.boot({ ...original, ...override });
    await next.svc.recallIdle();
    assert.equal(f.seen.length, previous + 1, "changed model/dimensions/URL/purpose transport refills retained text");
    assert.equal(next.svc.getStatus().recall.indexed, 1);
    const answer = (await next.call("search", { query: "IBAN" })).structuredContent;
    assert.equal(answer.mode, "hybrid");
    assert.equal(answer.messages.length, 1);
    if (override.WAZAP_EMBED_API_INPUT_TYPE === "direct") {
      assert.equal(f.seen[previous].body.input_type, "document");
      assert.equal(f.seen.at(-1).body.input_type, "query");
      assert.equal(f.seen.at(-1).headers["x-bf-passthrough-extra-params"], undefined);
    }
    await next.close();
  }
});

test("synthetic HTTP MCP: default recall remains keyword-only without provider uploads", async (t) => {
  const f = await fixture(t, (_, res) => res.end("{}"));
  const s = await f.boot(settings(f.url, { WAZAP_RECALL: "off" }));
  deliver(s.sock, "OFF", { conversation: "IBAN synthetic text" });
  await s.svc.recallIdle();
  assert.equal((await s.call("search", { query: "IBAN" })).structuredContent.mode, "keyword_fallback");
  assert.equal(f.seen.length, 0);
});
