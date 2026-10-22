/** Adversarial MCP action tests. Synthetic contacts/socket only; no real WhatsApp writes. */
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpEndpoint } from "../dist/server.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools, asToolSource } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";

function fixture(t, options = {}) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-chat-confirm-", id: ME, name: "Owner",
    config: { readOnly: false, rateLimitPerMinute: 0 } });
  t.after(() => svc.stop());
  sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Ana" }, { id: DAN, name: "Dan" }]);
  sock.fetchStatus = async () => [];
  sock.profilePictureUrl = async () => undefined;
  const effects = [];
  sock.chatModify = async (...args) => effects.push(["chatModify", ...args]);
  sock.updateBlockStatus = async (...args) => effects.push(["block", ...args]);
  sock.readMessages = async (...args) => effects.push(["read", ...args]);
  sock.sendMessage = async (...args) => { effects.push(["send", ...args]); return { key: { id: "SENT" } }; };
  const hub = asToolSource(svc);
  const client = (extra = {}) => schemaCheckedTools(hub, { allowWrite: true, ...options, ...extra });
  const { call, tools } = client();
  const preview = (action = "archive", extra = {}) => call("manage_chat", { chat_id: ANA, action, ...extra });
  const confirmation = (p) => ({ chat_id: p.structuredContent.chat_id, action: p.structuredContent.action, confirmation_id: p.structuredContent.confirmation_id });
  return { svc, sock, hub, client, call, tools, effects, preview, confirmation };
}

for (const action of ["archive", "unarchive", "clear", "delete", "block", "unblock", "pin", "unpin", "mute", "unmute", "mark_unread"]) {
  test(`${action}: first call is a preview; a confirmation performs exactly one mutation`, async (t) => {
    const f = fixture(t);
    const p = await f.preview(action);
    assert.equal(p.isError, undefined);
    assert.equal(p.structuredContent.status, "preview");
    assert.equal(typeof p.structuredContent.confirmation_id, "string");
    assert.match(p.structuredContent.preview, /Ana/);
    assert.match(p.structuredContent.preview, /Chat: Ana \(\+40 700 000 002\)\nAction:/);
    assert.ok(!p.structuredContent.preview.includes(ANA));
    assert.equal(p.structuredContent.target.chat_id, ANA, "display formatting never changes the frozen address");
    assert.match(p.structuredContent.preview, /default/);
    assert.equal(f.effects.length, 0, "a preview may not call a mutation socket method");
    const result = await f.call("manage_chat", f.confirmation(p));
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.action, action);
    assert.equal(f.effects.length, 1);
    const again = await f.call("manage_chat", f.confirmation(p));
    assert.equal(again.isError, undefined);
    assert.deepEqual(again.structuredContent, result.structuredContent);
    assert.equal(f.effects.length, 1, "replay returns the same outcome");
  });
}

test("confirm:true without the server's identifier cannot bypass the preview", async (t) => {
  const f = fixture(t);
  const p = await f.preview("delete", { confirm: true, force: true });
  assert.equal(p.structuredContent.status, "preview");
  assert.equal(f.effects.length, 0);
});

test("a preview with no revealed phone retains a separate target reference, never a made-up phone", async (t) => {
  const f = fixture(t);
  const lid = "123456789012345@lid";
  f.sock.ev.emit("contacts.upsert", [{ id: lid, name: "Ana" }]);
  const p = await f.preview("archive", { chat_id: lid });
  assert.ok(!p.isError, JSON.stringify(p));
  assert.match(p.structuredContent.preview, /Chat: Ana\nChat reference: 123456789012345@lid\n/);
  assert.ok(!p.structuredContent.preview.includes("+123456789012345"));
  assert.equal(p.structuredContent.chat_id, lid);
  assert.equal(f.effects.length, 0);
});

test("a guessed identifier cannot execute a chat action", async (t) => {
  const f = fixture(t);
  const result = await f.call("manage_chat", { chat_id: ANA, action: "delete", confirmation_id: "ca_guessed" });
  assert.equal(result.structuredContent.error, "CHAT_ACTION_NOT_FOUND");
  assert.equal(f.effects.length, 0);
});

test("another registration cannot confirm a preview or consume it", async (t) => {
  const f = fixture(t);
  const p = await f.preview("block");
  const result = await f.client().call("manage_chat", f.confirmation(p));
  assert.equal(result.structuredContent.error, "CHAT_ACTION_NOT_FOUND");
  assert.equal(f.effects.length, 0);
  assert.equal((await f.call("manage_chat", f.confirmation(p))).isError, undefined);
  assert.equal(f.effects.length, 1);
});

test("a stable credential can confirm over a reinitialized session; a foreign credential cannot", async (t) => {
  const f = fixture(t);
  const owner = f.client({ draftIdentity: "cred-a" });
  const p = await owner.call("manage_chat", { chat_id: ANA, action: "archive" });
  assert.equal((await f.client({ draftIdentity: "cred-b" }).call("manage_chat", f.confirmation(p))).structuredContent.error, "CHAT_ACTION_NOT_FOUND");
  assert.equal((await f.client({ draftIdentity: "cred-a" }).call("manage_chat", f.confirmation(p))).isError, undefined);
  assert.equal(f.effects.length, 1);
});

for (const override of [{ chat_id: DAN }, { action: "delete" }, { mute_hours: 3 }, { account_id: "other" }]) {
  test(`a confirm cannot retarget or override the frozen action: ${JSON.stringify(override)}`, async (t) => {
    const f = fixture(t);
    const p = await f.preview("archive");
    const result = await f.call("manage_chat", { ...f.confirmation(p), ...override });
    assert.equal(result.isError, true);
    assert.equal(f.effects.length, 0);
  });
}

test("the talk moving past a preview invalidates its confirmation", async (t) => {
  const f = fixture(t);
  const p = await f.preview();
  await f.call("learn");
  const result = await f.call("manage_chat", f.confirmation(p));
  assert.equal(result.structuredContent.error, "CHAT_ACTION_STALE");
  assert.equal(f.effects.length, 0);
});

test("expired previews cannot run", async (t) => {
  const f = fixture(t);
  const p = await f.preview();
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 16 * 60_000);
  const result = await f.call("manage_chat", f.confirmation(p));
  assert.equal(result.structuredContent.error, "CHAT_ACTION_EXPIRED");
  assert.equal(f.effects.length, 0);
});

test("a relinked owner cannot inherit an existing preview", async (t) => {
  const f = fixture(t);
  const p = await f.preview();
  f.svc.account = { id: DAN, name: "Other owner", number: DAN.split("@")[0] };
  const result = await f.call("manage_chat", f.confirmation(p));
  assert.equal(result.structuredContent.error, "CHAT_ACTION_STALE");
  assert.equal(f.effects.length, 0);
});

test("a target renamed while the preview waited needs a new preview", async (t) => {
  const f = fixture(t);
  const p = await f.preview();
  f.sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Someone Else" }]);
  const result = await f.call("manage_chat", f.confirmation(p));
  assert.equal(result.structuredContent.error, "CHAT_ACTION_STALE");
  assert.equal(f.effects.length, 0);
});

test("writes disabled while the preview waited refuse the confirmation", async (t) => {
  const f = fixture(t);
  const p = await f.preview();
  f.svc.effectiveReadOnly = true;
  const result = await f.call("manage_chat", f.confirmation(p));
  assert.equal(result.structuredContent.error, "READ_ONLY");
  assert.equal(f.effects.length, 0);
});

test("a relink during asynchronous target verification is checked again before dispatch", async (t) => {
  const f = fixture(t);
  const p = await f.preview();
  const get = f.svc.getContact.bind(f.svc);
  f.svc.getContact = async (...args) => {
    const contact = await get(...args);
    f.svc.account = { id: DAN, name: "Other owner", number: DAN.split("@")[0] };
    return contact;
  };
  const result = await f.call("manage_chat", f.confirmation(p));
  assert.equal(result.structuredContent.error, "CHAT_ACTION_STALE");
  assert.equal(f.effects.length, 0);
});

test("concurrent confirmations coalesce into one execution", async (t) => {
  const f = fixture(t);
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const get = f.svc.getContact.bind(f.svc);
  const p = await f.preview();
  f.svc.getContact = async (...args) => { await wait; return get(...args); };
  const a = f.call("manage_chat", f.confirmation(p));
  const b = f.call("manage_chat", f.confirmation(p));
  release();
  const results = await Promise.all([a, b]);
  assert.ok(results.every((r) => !r.isError), JSON.stringify(results));
  assert.equal(f.effects.length, 1);
});

test("a failed dispatched action stays unknown and cannot be automatically replayed", async (t) => {
  const f = fixture(t);
  const p = await f.preview();
  let attempts = 0;
  f.svc.manageChat = async () => { attempts++; throw new Error("socket reply lost"); };
  const first = await f.call("manage_chat", f.confirmation(p));
  assert.equal(first.structuredContent.error, "CHAT_ACTION_OUTCOME_UNKNOWN");
  await f.call("learn");
  const again = await f.call("manage_chat", f.confirmation(p));
  assert.equal(again.structuredContent.error, "CHAT_ACTION_OUTCOME_UNKNOWN");
  assert.equal(attempts, 1);
});

test("blocking a group cannot even create an actionable preview", async (t) => {
  const f = fixture(t);
  const p = await f.preview("block", { chat_id: GROUP });
  assert.equal(p.structuredContent.error, "INVALID_ID");
  assert.equal(f.effects.length, 0);
});

test("a read credential never exposes manage_chat", (t) => {
  const f = fixture(t);
  assert.equal(f.client({ allowWrite: false }).tools.has("manage_chat"), false);
});

test("service replacement cannot inherit a preview even with the same linked account", async (t) => {
  const f = fixture(t);
  const p = await f.preview();
  const previous = f.hub.binding.bind(f.hub);
  f.hub.binding = (id) => id === "default" ? { id, wa: { ...f.svc } } : previous(id);
  const result = await f.call("manage_chat", f.confirmation(p));
  assert.equal(result.structuredContent.error, "CHAT_ACTION_STALE");
  assert.equal(f.effects.length, 0);
});

test("policy disabled during asynchronous contact verification is checked again", async (t) => {
  const f = fixture(t);
  const p = await f.preview();
  const get = f.svc.getContact.bind(f.svc);
  f.svc.getContact = async (...args) => {
    const contact = await get(...args);
    const record = f.hub.recordOnDisk("default");
    f.hub.recordOnDisk = () => ({ ...record, writes: false });
    return contact;
  };
  const result = await f.call("manage_chat", f.confirmation(p));
  assert.equal(result.structuredContent.error, "READ_ONLY");
  assert.equal(f.effects.length, 0);
});

test("expiry during asynchronous contact verification still prevents dispatch", async (t) => {
  const f = fixture(t);
  const p = await f.preview();
  const get = f.svc.getContact.bind(f.svc);
  const now = Date.now();
  f.svc.getContact = async (...args) => {
    const contact = await get(...args);
    t.mock.method(Date, "now", () => now + 16 * 60_000);
    return contact;
  };
  const result = await f.call("manage_chat", f.confirmation(p));
  assert.equal(result.structuredContent.error, "CHAT_ACTION_EXPIRED");
  assert.equal(f.effects.length, 0);
});

test("pinning an edited message needs a new preview of the actual text", async (t) => {
  const f = fixture(t);
  const id = `false_${ANA}_PIN1`;
  const make = (text) => ({ chat_id: ANA, message_id: id, text, timestamp: new Date().toISOString() });
  f.svc.getMessage = async () => make("Original message");
  const p = await f.preview("pin_message", { message_id: id, pin_hours: 24 });
  assert.equal(p.structuredContent.status, "preview");
  f.svc.getMessage = async () => make("Changed after approval");
  const result = await f.call("manage_chat", f.confirmation(p));
  assert.equal(result.structuredContent.error, "CHAT_ACTION_STALE");
  assert.equal(f.effects.length, 0);
});

test("evicted pending previews cannot execute after the owner's bounded queue fills", async (t) => {
  const f = fixture(t, { draftIdentity: "bounded-owner" });
  const first = await f.preview();
  for (let i = 0; i < 20; i++) await f.preview();
  const result = await f.client({ draftIdentity: "bounded-owner" }).call("manage_chat", f.confirmation(first));
  assert.equal(result.structuredContent.error, "CHAT_ACTION_NOT_FOUND");
  assert.equal(f.effects.length, 0);
});


test("real HTTP SDK: clean catalogues, preview without effects, same-credential reconnect and one execution", async (t) => {
  const f = fixture(t);
  const stop = new AbortController();
  t.after(() => stop.abort());
  const port = await startHttpEndpoint(f.hub, f.svc.config, { host: "127.0.0.1", port: 0, openRead: false, signal: stop.signal,
    credentials: [{ token: "synthetic-write", write: true }, { token: "synthetic-read", write: false }] });
  async function connect(token) {
    const c = new Client({ name: "chat-action-http-test", version: "1" });
    t.after(() => c.close());
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return c;
  }
  const owner = await connect("synthetic-write");
  const reader = await connect("synthetic-read");
  const names = (await owner.listTools()).tools.map((x) => x.name);
  assert.equal(names.length, 23);
  for (const old of ["get_recent_messages", "search_messages", "download_media", "transcribe_audio"]) assert.ok(!names.includes(old));
  const readTools = (await reader.listTools()).tools;
  assert.equal(readTools.length, 15);
  assert.ok(!readTools.some((x) => x.name === "manage_chat"));
  const p = await owner.callTool({ name: "manage_chat", arguments: { chat_id: ANA, action: "archive" } });
  assert.equal(p.structuredContent.status, "preview");
  assert.equal(f.effects.length, 0);
  const reconnected = await connect("synthetic-write");
  const result = await reconnected.callTool({ name: "manage_chat", arguments: f.confirmation(p) });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent.action, "archive");
  const replay = await owner.callTool({ name: "manage_chat", arguments: f.confirmation(p) });
  assert.deepEqual(replay.structuredContent, result.structuredContent);
  assert.equal(f.effects.length, 1);
});


test("changing the returned preview object cannot change the server's frozen target", async (t) => {
  const f = fixture(t);
  const p = await f.preview("archive");
  p.structuredContent.target.chat_id = DAN;
  p.structuredContent.target.name = "Dan";
  p.structuredContent.target.number = DAN.split("@")[0];
  const result = await f.call("manage_chat", f.confirmation(p));
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent.chat_id, ANA);
  assert.equal(f.effects.length, 1);
});
