/** Cached connector calls must remain real, schema-checked reads after a catalogue migration. */
import test from "node:test";
import assert from "node:assert/strict";
import jpeg from "jpeg-js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { startHttpEndpoint } from "../dist/server.js";
import { tinyThumbnail } from "../dist/previews.js";
import { connectedService, schemaCheckedTools, asToolSource, textError } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const LEGACY = ["search_messages", "search_contacts", "get_recent_messages", "get_unanswered", "download_media", "transcribe_audio"];

function fixture(t) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-compat-", id: ME, name: "Owner" });
  t.after(() => svc.stop());
  sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Angela A" }, { id: DAN, name: "Angela B" }]);
  let sequence = 0;
  const arrive = (chat, text, fromMe = false, participant) => {
    const key = { remoteJid: chat, fromMe, id: `M${++sequence}`, ...(participant ? { participant } : {}) };
    sock.ev.emit("messages.upsert", { type: "notify", messages: [{ key,
      messageTimestamp: Math.floor(Date.now() / 1000) - 60 + sequence,
      message: typeof text === "string" ? { conversation: text } : text }] });
    return `${fromMe}_${chat}_${key.id}`;
  };
  const options = { allowWrite: false, allowLocalFiles: false, legacyReads: true, client: "oauth:compat-test" };
  return { svc, sock, arrive, ...schemaCheckedTools(svc, options) };
}

const allText = (answer) => JSON.stringify(answer);
const photo = (width, height) => Buffer.from(jpeg.encode({ width, height, data: Buffer.alloc(width * height * 4, 220) }, 60).data);

test("remote HTTP lists every cached read name and the advertised SDK schema can call each", async (t) => {
  const f = fixture(t);
  const sid = f.arrive(ANA, "Poți trimite lista de pasageri?");
  const image = f.arrive(DAN, { imageMessage: { mimetype: "image/jpeg", fileLength: 100 } });
  const voice = f.arrive(DAN, { audioMessage: { mimetype: "audio/ogg", ptt: true } });
  f.svc.mediaBuffer = async () => photo(80, 50);
  f.svc.transcribeAudio = async () => ({ text: "lista pentru transport", provider: "local", cached: true });
  const stop = new AbortController();
  t.after(() => stop.abort());
  const port = await startHttpEndpoint(asToolSource(f.svc), f.svc.config, {
    host: "127.0.0.1", port: 0, openRead: false, signal: stop.signal, credentials: [{ token: "synthetic-reader", write: false }],
  });
  const client = new Client({ name: "cached-connector", version: "0.23" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: "Bearer synthetic-reader" } } }));
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of LEGACY) assert.ok(names.includes(name), name);
  assert.ok(!names.includes("send_message"));
  const calls = [
    ["search_messages", { query: "pasageri" }], ["search_contacts", { query: "Angela" }],
    ["get_recent_messages", { hours: 24, limit: 3, compact: true }], ["get_unanswered", { max_age_hours: 72, limit: 5 }],
    ["download_media", { message_id: image }], ["transcribe_audio", { message_id: voice }],
  ];
  for (const [name, args] of calls) {
    const answer = await client.callTool({ name, arguments: args });
    assert.ok(!answer.isError, `${name}: ${allText(answer)}`);
    if (name === "search_messages") assert.equal(answer.structuredContent.messages[0].message_id, sid);
    if (name === "transcribe_audio") assert.equal(answer.structuredContent.text, "lista pentru transport");
    if (name === "download_media") assert.ok(answer.content.some((block) => block.type === "image"));
  }
  const blocked = await client.callTool({ name: "download_media", arguments: { message_id: image, save_to: "/unused" } });
  assert.equal(textError(blocked).error, "MEDIA_ACCESS_DENIED");
});

test("contact search returns ambiguous candidates; exact message search ignores accents and obeys author/date", async (t) => {
  const f = fixture(t);
  const id = f.arrive(ANA, "Ședință despre transport");
  f.arrive(DAN, "Alt transport");
  const contacts = await f.call("search_contacts", { query: "Angela" });
  assert.equal(contacts.structuredContent.count, 2);
  const found = await f.call("search_messages", { query: "sedinta", chat_id: ANA, from: ANA, since: new Date(Date.now() - 86400000).toISOString() });
  assert.equal(found.structuredContent.messages[0].message_id, id);
  assert.equal(found.structuredContent.mode, "words");
  const exact = await f.call("get_message", { message_id: id });
  assert.equal(exact.structuredContent.text, found.structuredContent.messages[0].text);
  const newest = await f.call("search_messages", { query: "transport", limit: 1 });
  const older = await f.call("search_messages", { query: "transport", limit: 1, before: newest.structuredContent.next_before });
  assert.equal(older.structuredContent.messages[0].message_id, id);
  assert.notEqual(newest.structuredContent.messages[0].message_id, id);
});

test("recent pages are bounded, repeatable, isolated by client and recheck deletion/private tags", async (t) => {
  const f = fixture(t);
  f.arrive(ANA, "PRIVATE-ONE?");
  f.arrive(ANA, "PRIVATE-TWO?");
  const gone = f.arrive(DAN, "DELETE-ME");
  const first = await f.call("get_recent_messages", { limit: 1 });
  assert.equal(first.structuredContent.message_count, 1);
  const cursor = first.structuredContent.next_cursor;
  assert.ok(cursor);
  const other = schemaCheckedTools(f.svc, { allowWrite: false, legacyReads: true, client: "oauth:other" });
  assert.equal(JSON.parse((await other.call("get_recent_messages", { cursor })).content[0].text).error, "CURSOR_EXPIRED");
  f.svc.db.identity.updateFields(ANA, { addTags: ["private"] });
  f.sock.ev.emit("messages.delete", { keys: [{ remoteJid: DAN, fromMe: false, id: gone.split("_").pop() }] });
  const next = await f.call("get_recent_messages", { cursor, limit: 20 });
  assert.doesNotMatch(allText(next), /PRIVATE-ONE|PRIVATE-TWO|DELETE-ME/);
  const again = await f.call("get_recent_messages", { cursor, limit: 20 });
  assert.deepEqual(again.structuredContent.conversations, next.structuredContent.conversations);
});

test("private direct messages, group authors and their quoted words stay private in both compatibility summaries", async (t) => {
  const f = fixture(t);
  f.arrive(ANA, "SECRET-DIRECT poți trimite?");
  f.arrive(GROUP, "SECRET-GROUP", false, ANA);
  f.arrive(GROUP, { extendedTextMessage: { text: "public reply", contextInfo: { stanzaId: "Q", participant: ANA, quotedMessage: { conversation: "SECRET-QUOTE" } } } }, false, DAN);
  f.svc.db.identity.updateFields(ANA, { addTags: ["private"] });
  for (const name of ["get_recent_messages", "get_unanswered"])
    assert.doesNotMatch(allText(await f.call(name)), /SECRET-DIRECT|SECRET-GROUP|SECRET-QUOTE/);
  assert.equal((await f.call("search_messages", { query: "SECRET" })).structuredContent.count, 0);
});

test("a reply closes a candidate and a closing thanks does not create one", async (t) => {
  const f = fixture(t);
  f.arrive(ANA, "Ai loc pentru bagaje?");
  f.arrive(ANA, "Da, lejer", true);
  f.arrive(DAN, "ok, mersi");
  assert.equal((await f.call("get_unanswered")).structuredContent.count, 0);
  f.arrive(DAN, "Poți trimite lista?");
  const waiting = await f.call("get_unanswered");
  assert.equal(waiting.structuredContent.count, 1);
  assert.equal(waiting.structuredContent.chats[0].chat_id, DAN);
});

test("tiny thumbnails are upgraded once from the original and remain available if it expired", async (t) => {
  const f = fixture(t);
  const tiny = photo(60, 32);
  assert.equal(tinyThumbnail(tiny), true);
  let downloads = 0;
  f.svc.mediaBuffer = async () => { downloads++; return photo(1200, 800); };
  const id = f.arrive(ANA, { imageMessage: { mimetype: "image/jpeg", fileLength: 12000, jpegThumbnail: tiny } });
  const first = await f.svc.previews([id], 1);
  const decoded = jpeg.decode(Buffer.from(first[0].base64, "base64"));
  assert.equal(decoded.width, 320);
  await f.svc.previews([id], 1);
  assert.equal(downloads, 1);
  const expired = f.arrive(ANA, { imageMessage: { mimetype: "image/jpeg", jpegThumbnail: tiny } });
  f.svc.mediaBuffer = async () => { throw new Error("expired"); };
  assert.equal((await f.svc.previews([expired], 1))[0].base64, tiny.toString("base64"));
});

test("local and compatibility sessions share the same process-wide work budget", async (t) => {
  const f = fixture(t);
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  f.svc.readMessages = async () => { await gate; return { data: [], sync: "done" }; };
  const local = schemaCheckedTools(f.svc, { allowWrite: false, maxInFlightTotal: 1 });
  const remote = schemaCheckedTools(f.svc, { allowWrite: false, legacyReads: true, maxInFlightTotal: 1 });
  const first = local.call("read_messages", { chat_id: ANA });
  const second = remote.call("read_messages", { chat_id: ANA });
  finish();
  await first;
  const overflow = await second;
  assert.equal(overflow.isError, true);
  assert.equal(JSON.parse(overflow.content[0].text).error, "RATE_LIMITED");
});

test("cached search honours account_ids and all_accounts instead of silently searching only the default", async (t) => {
  const home = fixture(t);
  const work = fixture(t);
  home.arrive(ANA, "shared invoice HOME");
  work.arrive(DAN, "shared invoice WORK");
  const bindings = [{ id: "home", wa: home.svc }, { id: "work", wa: work.svc }];
  const hub = { ...asToolSource(home.svc), bindings: () => bindings,
    defaultBinding: () => bindings[0], binding: (id) => bindings.find((b) => b.id === id),
    record: (id) => ({ id, enabled: true }), records: () => bindings.map((b) => ({ id: b.id, enabled: true })) };
  const { call } = schemaCheckedTools(hub, { allowWrite: false, legacyReads: true });
  for (const selection of [{ account_ids: ["work"] }, { all_accounts: true }]) {
    const result = await call("search_messages", { query: "shared invoice", ...selection });
    assert.equal(result.isError, undefined);
    const messages = result.structuredContent.messages;
    assert.ok(messages.some((m) => m.text.includes("WORK")));
    assert.equal(messages.length, selection.all_accounts ? 2 : 1);
    assert.ok(messages.every((m) => ["home", "work"].includes(m.account_id)));
  }
});
