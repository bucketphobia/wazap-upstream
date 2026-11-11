/**
 * One rendering per assistant session. A client that puts answers in front of
 * a model (Claude Code, claude.ai, Codex, Cursor, ChatGPT, Gemini CLI, by the
 * name it gives) gets each answer as its text and image blocks alone, and a
 * catalogue with no outputSchema, whatever its credential; a program, or a
 * client wazap does not know, keeps the text and the structured content
 * docs/stability.md promises, on a static token or over OAuth.
 * WAZAP_ANSWER_FORMAT holds every session to one.
 * Decided at initialize, kept by a revival, reached over stdio and the bridge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { answerFormatFor, isAssistantName, possibleFormats } from "../dist/client-name.js";
import { answerFormatSetting } from "../dist/config.js";
import { readDaemon } from "../dist/daemon.js";
import { startHttpEndpoint } from "../dist/server.js";
import { mcpClient, offlineConfig, spawnWazap, stubAccountSource, waitFor } from "./helpers.mjs";

test("assistants' clients get text; programs and unknown clients keep full, over OAuth too; the setting overrides both", () => {
  for (const name of ["claude-code", "claude-ai", "Claude Desktop", "claude.ai", "codex-mcp-client", "codex", "cursor-vscode", "Cursor", "openai-mcp", "ChatGPT", "gemini-cli-mcp-client"]) {
    assert.equal(isAssistantName(name), true, name);
    assert.equal(answerFormatFor("auto", name), "text", name);
    assert.equal(answerFormatFor(undefined, name), "text", `${name}, the setting unset`);
  }
  for (const name of ["acme-crm", "mcp-inspector", "n8n-mcp-client", "wazap-bridge", "claudette", "node", "", undefined, 7]) {
    assert.equal(isAssistantName(name), false, String(name));
    assert.equal(answerFormatFor("auto", name), "full", String(name));
  }
  assert.equal(answerFormatFor("full", "claude-code"), "full");
  assert.equal(answerFormatFor("text", "acme-crm"), "text");
  assert.deepEqual(possibleFormats("auto"), ["text", "full"]);
  assert.deepEqual(possibleFormats("full"), ["full"]);
  assert.deepEqual(possibleFormats("text"), ["text"]);
});

test("WAZAP_ANSWER_FORMAT reads auto, full and text, and refuses anything else", () => {
  assert.equal(answerFormatSetting(undefined), "auto");
  assert.equal(answerFormatSetting(""), "auto");
  assert.equal(answerFormatSetting(" Text "), "text");
  assert.equal(answerFormatSetting("FULL"), "full");
  assert.throws(() => answerFormatSetting("json"), /WAZAP_ANSWER_FORMAT must be auto, full or text/);
});

// ------------------------------------------------------------------ HTTP

const wa = {
  getStatus: () => ({ status: "connected", status_since: new Date().toISOString() }),
  listReminders: async () => [
    { reminder_id: "r_1", state: "pending", chat_id: "40711111111@s.whatsapp.net", chat_name: "Elena", note: "Sună-o", due_at: "2026-11-11T09:00:00+02:00", time_zone: "Europe/Bucharest", condition: "always" },
  ],
  addReminder: async () => {
    throw new Error("not in this test");
  },
  cancelReminder: async () => {
    throw new Error("not in this test");
  },
};

function dataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "wazap-answers-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function start(t, dir, answerFormat) {
  const stop = new AbortController();
  t.after(() => stop.abort());
  const config = offlineConfig("wazap-answers-cfg-", { dataDir: dir, readOnly: false, ...(answerFormat === undefined ? {} : { answerFormat }) });
  const port = await startHttpEndpoint(stubAccountSource(wa), config, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    signal: stop.signal,
    credentials: [{ token: "program", write: true }],
  });
  let id = 0;
  const post = async (sid, method, params) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json", authorization: "Bearer program", ...(sid ? { "mcp-session-id": sid } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params === undefined ? {} : { params }) }),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await res.text();
    const data = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).at(-1);
    return { status: res.status, sid: res.headers.get("mcp-session-id"), body: data ? JSON.parse(data) : null };
  };
  const open = async (name) => {
    const init = await post(undefined, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } });
    assert.equal(init.status, 200);
    return init.sid;
  };
  return { stop: () => stop.abort(), post, open };
}

/** tools/list and two calls on one session: a list with a shape, and a refusal. */
async function answers(server, sid) {
  const listed = await server.post(sid, "tools/list", {});
  const reminders = await server.post(sid, "tools/call", { name: "reminder", arguments: { action: "list" } });
  const refused = await server.post(sid, "tools/call", { name: "reminder", arguments: { action: "cancel" } });
  return { status: listed.status, tools: listed.body?.result?.tools ?? [], reminders: reminders.body.result, refused: refused.body.result };
}

test("an assistant's session lists no outputSchema and answers in text alone; a program's keeps both", async (t) => {
  const server = await start(t, dataDir(t));
  const assistant = await answers(server, await server.open("claude-code"));
  assert.equal(assistant.tools.length, 23);
  assert.deepEqual(assistant.tools.filter((tool) => tool.outputSchema !== undefined).map((tool) => tool.name), []);
  assert.equal(assistant.reminders.structuredContent, undefined);
  assert.match(assistant.reminders.content[0].text, /r_1/);
  assert.equal(assistant.refused.isError, true);
  assert.equal(assistant.refused.structuredContent, undefined);
  assert.deepEqual(Object.keys(JSON.parse(assistant.refused.content[0].text)).sort(), ["account_id", "error", "fix", "message"]);

  const program = await answers(server, await server.open("acme-crm"));
  assert.equal(program.tools.filter((tool) => tool.outputSchema !== undefined).length, 16);
  assert.equal(program.reminders.structuredContent.reminders[0].reminder_id, "r_1");
  assert.match(program.reminders.content[0].text, /r_1/, "the same text block rides beside it");
  assert.equal(program.refused.isError, true);
});

test("WAZAP_ANSWER_FORMAT holds every session to one format", async (t) => {
  const full = await start(t, dataDir(t), "full");
  const assistant = await answers(full, await full.open("claude-code"));
  assert.equal(assistant.reminders.structuredContent.reminders.length, 1);
  assert.equal(assistant.tools.filter((tool) => tool.outputSchema !== undefined).length, 16);
  const text = await start(t, dataDir(t), "text");
  const program = await answers(text, await text.open("acme-crm"));
  assert.equal(program.reminders.structuredContent, undefined);
  assert.deepEqual(program.tools.filter((tool) => tool.outputSchema !== undefined), []);
});

test("a revived session keeps the format it was opened with, found from its id's signature", async (t) => {
  const dir = dataDir(t);
  const before = await start(t, dir);
  const assistantSid = await before.open("claude-code");
  const programSid = await before.open("acme-crm");
  before.stop();

  // A restart: neither id says which client holds it; each is revived as what it was.
  const after = await start(t, dir);
  const assistant = await answers(after, assistantSid);
  assert.equal(assistant.status, 200);
  assert.equal(assistant.reminders.structuredContent, undefined);
  assert.deepEqual(assistant.tools.filter((tool) => tool.outputSchema !== undefined), []);
  const program = await answers(after, programSid);
  assert.equal(program.status, 200);
  assert.equal(program.reminders.structuredContent.reminders.length, 1);
  after.stop();

  // The owner holds every session to full now: the assistant's id is for a catalogue it no longer gets.
  const forced = await start(t, dir, "full");
  assert.equal((await forced.post(assistantSid, "tools/list", {})).status, 404);
  assert.equal((await forced.post(programSid, "tools/list", {})).status, 200);
});

// ------------------------------------------------------------------ stdio and the bridge

async function stdioSession(child, name) {
  const { request, notify } = mcpClient(child);
  const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } });
  assert.equal(init.error, undefined, JSON.stringify(init.error));
  notify("notifications/initialized");
  const list = await request("tools/list", {});
  const status = await request("tools/call", { name: "get_status", arguments: {} });
  return { tools: list.result.tools, status: status.result };
}

test("over stdio and through the bridge, the format is the client's own", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-answers-stdio-"));
  const children = [];
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });
  const daemon = spawnWazap({ dataDir: dir });
  children.push(daemon.child);
  const local = await stdioSession(daemon.child, "claude-code");
  assert.deepEqual(local.tools.filter((tool) => tool.outputSchema !== undefined), []);
  assert.equal(local.status.structuredContent, undefined);
  assert.match(local.status.content[0].text, /not_linked/);
  await waitFor(() => readDaemon(join(dir, "daemon.json")), 15_000, "daemon.json to appear");

  // A second start bridges to the first, under the name of the client it serves.
  const bridged = spawnWazap({ dataDir: dir });
  children.push(bridged.child);
  const assistant = await stdioSession(bridged.child, "codex-mcp-client");
  assert.deepEqual(assistant.tools.filter((tool) => tool.outputSchema !== undefined), []);
  assert.equal(assistant.status.structuredContent, undefined);

  const third = spawnWazap({ dataDir: dir });
  children.push(third.child);
  const program = await stdioSession(third.child, "acme-crm");
  assert.equal(program.tools.filter((tool) => tool.outputSchema !== undefined).length, 16);
  assert.equal(program.status.structuredContent.status, "not_linked");
});
