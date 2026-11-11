/**
 * tools/list, the skills and the instructions are built once per permission
 * key and shared by every session that has it. What a session is told must
 * not change for it: the cached answer equals a fresh build, and a session
 * with other permissions gets its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildToolCatalogue } from "../dist/tool-catalogue.js";
import { createToolRegistrar } from "../dist/tool-runtime.js";
import { registerTools } from "../dist/tools.js";
import { loadSkills } from "../dist/skills.js";
import { asToolSource, READ_TOOL_COUNT, TOOL_COUNT } from "./helpers.mjs";

const wa = { getStatus: () => ({ status: "connected", status_since: new Date().toISOString(), read_only: false }) };
const hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const handler = async () => ({ content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } });
const DEFS = [
  { name: "read_one", title: "Read", description: "Reads.", schema: { id: z.string() }, outputSchema: { ok: z.boolean() }, write: false, hints, handler },
  { name: "send_one", title: "Send", description: "Sends.", schema: { text: z.string(), file_path: z.string().optional() }, write: true, hints, handler },
  { name: "old_read", title: "Old", description: "Cached name.", schema: {}, write: false, legacyRead: true, hints, handler },
];

async function listed(register, opts, source = asToolSource(wa)) {
  const server = new McpServer({ name: "wazap-test", version: "1" });
  register(server, source, opts);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "catalogue", version: "1" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

const KEYS = [
  { allowWrite: true, allowLocalFiles: false, legacyReads: true },
  { allowWrite: false, allowLocalFiles: false, legacyReads: true },
  { allowWrite: true, allowLocalFiles: true },
];

test("a cached catalogue is the same answer as a fresh build, per permission key", async () => {
  const register = createToolRegistrar(DEFS);
  for (const opts of KEYS) {
    const registered = DEFS.filter((def) => (opts.allowWrite || !def.write) && (opts.legacyReads === true || !def.legacyRead));
    const fresh = JSON.parse(JSON.stringify(buildToolCatalogue(registered, opts.allowLocalFiles !== false)));
    const first = await listed(register, opts);
    const second = await listed(register, opts);
    assert.deepEqual(first, fresh, `first session for ${JSON.stringify(opts)}`);
    assert.deepEqual(second, fresh, `cached session for ${JSON.stringify(opts)}`);
    assert.ok(!first.some((tool) => tool.name === "old_read"), "legacy names stay out of tools/list");
  }
  const [write, read, local] = await Promise.all(KEYS.map((opts) => listed(register, opts)));
  assert.deepEqual(write.map((tool) => tool.name), ["read_one", "send_one"]);
  assert.deepEqual(read.map((tool) => tool.name), ["read_one"]);
  // A remote session is not shown the host file it would be refused; a local one is.
  assert.deepEqual(Object.keys(write[1].inputSchema.properties), ["text"]);
  assert.deepEqual(Object.keys(local[1].inputSchema.properties), ["text", "file_path"]);
  assert.equal(write[1].description, "Sends.");
});

test("the real catalogue: repeated sessions list the same tools, and read sessions never see write tools", async () => {
  const remoteWrite = { allowWrite: true, allowLocalFiles: false, legacyReads: true };
  const remoteRead = { allowWrite: false, allowLocalFiles: false, legacyReads: true };
  const a = await listed(registerTools, remoteWrite);
  const b = await listed(registerTools, remoteWrite);
  assert.equal(a.length, TOOL_COUNT);
  assert.deepEqual(b, a);
  const read = await listed(registerTools, remoteRead);
  assert.equal(read.length, READ_TOOL_COUNT);
  assert.ok(!read.some((tool) => tool.name === "send_message"));
  assert.deepEqual(await listed(registerTools, remoteRead), read);
});

test("the packaged skills are read once, and each caller gets its own array", () => {
  const first = loadSkills();
  const second = loadSkills();
  assert.ok(first.length > 0);
  assert.notEqual(first, second, "a caller sorting or filtering its copy cannot change another's");
  assert.deepEqual(first, second);
  first.pop();
  assert.equal(loadSkills().length, second.length);
});
