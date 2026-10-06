/**
 * Tools that declare an outputSchema, through the SDK's own Client: the client
 * checks structured content against the schema on every answer, errors
 * included, so an error from such a tool carries its `{ error, message, fix }`
 * as text only. A tool without an outputSchema keeps its structured error.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AccountHub } from "../dist/account-hub.js";
import { AccountRegistry } from "../dist/accounts.js";
import { registerTools } from "../dist/tools.js";
import { asToolSource, fakeSocket, offlineConfig } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40722001111@s.whatsapp.net";

let hub;
let home;
let client;
let tools;

before(async () => {
  const config = offlineConfig("wazap-output-schema-", { readOnly: false });
  hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  home = hub.get("default");
  const sock = fakeSocket();
  home.sockClient = sock;
  home.wireEvents(sock, ++home.generation);
  home.account = { id: ME, name: "Andrei", number: "40700000001" };
  home.status = "connected";
  home.initialSyncDone = true;
  home.db.identity.upsertContact({ jid: ANA, name: "Ana Pop", listed: true });
  home.db.identity.upsertContact({ jid: "40722002222@s.whatsapp.net", name: "Ana Ionescu", listed: true });
  home.db.messages.upsert({ chatJid: ANA, keyId: "K1", fromMe: false, ts: Date.now() - 60_000, type: "text", text: "Salut" });
  home.db.messages.upsert({ chatJid: ANA, keyId: "K2", fromMe: true, ts: Date.now() - 30_000, type: "text", text: "hai ca vin" });
  home.db.messages.upsert({ chatJid: "40722002222@s.whatsapp.net", keyId: "K3", fromMe: true, ts: Date.now() - 20_000, type: "text", text: "vă trimit factura" });

  const server = new McpServer({ name: "wazap-test", version: "1" });
  registerTools(server, asToolSource(hub), { allowWrite: true });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "sdk-client", version: "1" });
  await client.connect(clientSide);
  tools = (await client.listTools()).tools;
});

after(async () => {
  await client?.close();
  await hub?.stop();
});

test("every answer find_contact gives passes the SDK client's schema check, the draft context included", async () => {
  const resolved = await client.callTool({ name: "find_contact", arguments: { name: "Ana Pop" } });
  assert.equal(resolved.structuredContent.status, "resolved");
  assert.ok(resolved.structuredContent.context.recent.length > 0);
  const ambiguous = await client.callTool({ name: "find_contact", arguments: { name: "Ana" } });
  assert.equal(ambiguous.structuredContent.status, "ambiguous");
  const missing = await client.callTool({ name: "find_contact", arguments: { name: "Xyzzy" } });
  assert.equal(missing.structuredContent.status, "not_found");
});

test("a find_contact error reaches an SDK client as an error result, not a schema failure", async () => {
  home.storage.storageState = "preparing";
  try {
    const result = await client.callTool({ name: "find_contact", arguments: { name: "Ana" } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined, "no structured content to check against the schema");
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.error, "NOT_CONNECTED");
    assert.ok(body.message && body.fix);
  } finally {
    home.storage.storageState = "ready";
  }
});

test("a tool without an outputSchema keeps its structured error", async () => {
  home.status = "disconnected";
  try {
    const result = await client.callTool({ name: "manage_chat", arguments: { chat_id: ANA, action: "mark_read" } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error, "NOT_CONNECTED");
    assert.equal(result.structuredContent.account_id, "default");
  } finally {
    home.status = "connected";
  }
});

test("the six tools of the integration contract declare no outputSchema", () => {
  // An integration (test/integration-contract.test.mjs) reads structuredContent.error on these
  // tools' failures. A tool with an outputSchema answers errors as text only, so
  // giving any of them one would break its error handling: that needs a major.
  for (const name of ["send_message", "confirm_send", "manage_chat", "link_account", "get_status", "list_contacts"]) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool, `${name} is registered`);
    assert.equal(tool.outputSchema, undefined, `${name} must not declare an outputSchema`);
  }
});

test("every tool with an output schema answers in its declared shape, through an SDK client", async () => {
  const GROUP = "120363000000000009@g.us";
  const sock = home.sockClient;
  sock.sendMessage = async () => ({ key: { id: "SENT" } });
  sock.chatModify = async () => {};
  sock.groupMetadata = async (id) => ({
    id,
    subject: "Bloc 12",
    owner: ME,
    creation: 1_700_000_000,
    participants: [{ id: ME, admin: "superadmin" }, { id: ANA }],
  });
  sock.groupInviteCode = async () => "CODE";
  sock.groupCreate = async (subject, ids) => ({ id: GROUP, subject, participants: [{ id: ME, admin: "superadmin" }, ...ids.map((id) => ({ id }))] });
  let seq = 0;
  const arrive = (chat, message, { fromMe = false, participant } = {}) => {
    const id = `S${++seq}`;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{ key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) }, message, messageTimestamp: Math.floor(Date.now() / 1000) }],
    });
    return `${fromMe}_${chat}_${id}`;
  };
  const theirs = arrive(ANA, { conversation: "ne vedem la 7?" });
  const mine = arrive(ANA, { conversation: "da, la 7" }, { fromMe: true });
  arrive(GROUP, { conversation: "salutare" }, { participant: ANA });
  const photo = arrive(ANA, { imageMessage: { mimetype: "image/jpeg", fileLength: 4, caption: "meniul" } });
  home.mediaBuffer = async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  const calls = [
    ["list_chats", {}],
    ["read_messages", { chat_id: ANA }],
    ["read_messages", { chat_id: "status" }],
    ["get_message", { message_id: theirs }],
    ["get_group_info", { group_id: GROUP }],
    ["wait_for_messages", { timeout_seconds: 1 }],
    ["search", { query: "vedem" }],
    ["search", { query: "vedem", match: "words" }],
    ["find_contact", { tag: "client" }],
    ["remember", { chat_id: ANA, note: "vecina", add_tags: ["client"], handled: true }],
    ["get_media", { message_id: photo }],
    ["react_to_message", { message_id: theirs, emoji: "👍" }],
    ["edit_message", { message_id: mine, text: "da, la 7 fix" }],
    ["delete_message", { message_id: mine, for_everyone: false }],
    ["manage_group", { action: "create", value: "Bloc 12", participant_ids: [ANA] }],
    ["manage_group", { action: "get_invite_link", group_id: GROUP }],
  ];
  for (const [name, args] of calls) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool.outputSchema, `${name} declares an output schema`);
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, `${name}: ${result.content?.[0]?.text}`);
    assert.ok(result.structuredContent, `${name} answers structured content`);
  }
});

test("a search whose coverage could not be counted still reaches an SDK client, with coverage null", async () => {
  const db = home.db;
  const coverage = db.search.coverage;
  db.search.coverage = () => {
    throw new Error("SQLITE_BUSY: database is locked");
  };
  try {
    const result = await client.callTool({ name: "search", arguments: { query: "factura", match: "words" } });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    assert.equal(result.structuredContent.coverage, null);
    assert.equal(result.structuredContent.count, 1, "the messages found are still the answer");
  } finally {
    db.search.coverage = coverage;
  }
});

test("only the six tools of the integration contract and learn go without an output schema", () => {
  assert.deepEqual(
    tools.filter((tool) => tool.outputSchema === undefined).map((tool) => tool.name).sort(),
    ["confirm_send", "get_status", "learn", "link_account", "list_contacts", "manage_chat", "send_message"]
  );
});
