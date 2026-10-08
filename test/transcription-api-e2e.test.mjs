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
const sid = (id) => `false_${PEER}_${id}`;

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

const voice = { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: 6 } };

// PR2 behavior (depends on PR1): generic model and alternate single credential header, with Arabic multipart language.
test("synthetic HTTP MCP: gateway multipart model/language and x-bf-vk authentication", async (t) => {
  const f = await fixture(t, (_, res) => res.end(JSON.stringify({ text: "synthetic gateway transcript", language: "ar" })));
  const s = await f.boot({ WAZAP_TRANSCRIBE: "openai", WAZAP_TRANSCRIBE_ALLOW_API: "1",
    WAZAP_TRANSCRIBE_URL: f.url, WAZAP_TRANSCRIBE_MODEL: "provider/synthetic-audio-model",
    WAZAP_TRANSCRIBE_API_KEY: "synthetic-virtual-key", WAZAP_TRANSCRIBE_AUTH_HEADER: "x-bf-vk" });
  deliver(s.sock, "GATEWAY", voice);
  await s.svc.transcribeIdle();
  assert.equal(f.seen.length, 0);
  assert.equal((await s.call("get_media", { message_id: sid("GATEWAY"), language: "ar" })).structuredContent.transcript.cached, false);
  const upload = f.seen[0];
  assert.equal(upload.path, "/openai/audio/transcriptions");
  assert.equal(upload.headers["x-bf-vk"], "synthetic-virtual-key");
  assert.equal(upload.headers.authorization, undefined);
  const form = await new Response(upload.bytes, { headers: { "content-type": upload.headers["content-type"] } }).formData();
  assert.equal(form.get("model"), "provider/synthetic-audio-model");
  assert.equal(form.get("language"), "ar");
  assert.equal(form.get("response_format"), "json");
  assert.equal(await form.get("file").text(), "OggS synthetic audio");
  assert.equal(form.get("file").type, "audio/ogg");
});
