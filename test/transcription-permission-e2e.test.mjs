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
const mutationTools = ["send_message", "confirm_send", "edit_message", "delete_message", "react_to_message", "manage_chat", "manage_group"];

// PR1 behavior: permission, manual default, and durable cache. The custom URL is a synthetic test endpoint.
test("synthetic HTTP MCP: read-only permission gates uploads; opt-in manual transcription persists across restart", async (t) => {
  const f = await fixture(t, (_, res) => res.end(JSON.stringify({ text: "نص اصطناعي", language: "ar", duration: 6 })));
  const env = { WAZAP_TRANSCRIBE: "openai", WAZAP_TRANSCRIBE_API_KEY: "synthetic-transcription-key",
    WAZAP_TRANSCRIBE_URL: f.url, WAZAP_TRANSCRIBE_AUTO: "0" };
  const denied = await f.boot(env);
  deliver(denied.sock, "VOICE", voice);
  await denied.svc.transcribeIdle();
  const refusal = (await denied.call("get_media", { message_id: sid("VOICE"), language: "ar" })).structuredContent;
  assert.equal(refusal.transcript_unavailable.code, "READ_ONLY");
  assert.equal(f.seen.length, 0, "permission is checked before any provider upload");
  await denied.close();

  const allowed = await f.boot({ ...env, WAZAP_TRANSCRIBE_ALLOW_API: "1", WAZAP_TRANSCRIBE_AUTO: undefined });
  await allowed.svc.transcribeIdle();
  assert.equal(allowed.svc.voice.autoTranscribe, false);
  assert.equal(f.seen.length, 0, "permission alone defaults to manual");
  const names = (await allowed.client.listTools()).tools.map((tool) => tool.name);
  for (const name of mutationTools) assert.equal(names.includes(name), false, name);
  const first = (await allowed.call("get_media", { message_id: sid("VOICE"), language: "ar" })).structuredContent.transcript;
  assert.equal(first.text, "نص اصطناعي");
  assert.equal(first.cached, false);
  const cached = (await allowed.call("get_media", { message_id: sid("VOICE"), language: "ar" })).structuredContent.transcript;
  assert.equal(cached.cached, true);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].headers.authorization, "Bearer synthetic-transcription-key");
  assert.equal(allowed.svc.db.messages.get(sid("VOICE")).transcript, "نص اصطناعي");
  await allowed.close();

  const restart = await f.boot({ ...env, WAZAP_TRANSCRIBE_ALLOW_API: "1" });
  const persisted = (await restart.call("get_media", { message_id: sid("VOICE"), language: "ar" })).structuredContent.transcript;
  assert.equal(persisted.cached, true);
  assert.equal(persisted.text, "نص اصطناعي");
  assert.equal(f.seen.length, 1, "restart does not upload cached audio");
});
