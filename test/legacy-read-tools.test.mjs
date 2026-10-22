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

test("remote HTTP hides compatibility names but cached SDK calls remain validated", async (t) => {
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
  for (const name of LEGACY) assert.ok(!names.includes(name), `${name} stays out of the catalogue`);
  for (const name of ["search", "catch_up", "find_contact", "get_media"]) assert.ok(names.includes(name), name);
  assert.ok(!names.includes("send_message"));
  assert.equal(names.length, 15, "remote catalogue has no extra compatibility tools");
  assert.ok(!names.includes("list_accounts"));
  assert.ok((await client.callTool({ name: "list_accounts", arguments: {} })).structuredContent.accounts.length > 0);
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
  const found = await f.call("search_messages", { query: "sedinta", match: "words", chat_id: ANA, from: ANA, since: new Date(Date.now() - 86400000).toISOString() });
  assert.equal(found.structuredContent.messages[0].message_id, id);
  assert.equal(found.structuredContent.mode, "words");
  const exact = await f.call("get_message", { message_id: id });
  assert.equal(exact.structuredContent.text, found.structuredContent.messages[0].text);
  const newest = await f.call("search_messages", { query: "transport", match: "words", limit: 1 });
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

test("recent pagination constructs only each page's views and never rescans on continuation", async (t) => {
  const f = fixture(t);
  const now = Date.now();
  f.svc.db.transaction(() => f.svc.db.messages.upsertMany(Array.from({ length: 3000 }, (_, i) => ({
    chatJid: i % 2 ? ANA : DAN, keyId: `PAGE${i}`, fromMe: false, ts: now - 4000 + i,
    type: "text", text: `Synthetic message ${i}`,
  }))));
  const view = f.svc.views.viewOfStored.bind(f.svc.views);
  let views = 0;
  f.svc.views.viewOfStored = (...args) => { views++; return view(...args); };
  const first = await f.call("get_recent_messages", { limit: 25 });
  assert.equal(first.structuredContent.message_count, 25);
  assert.equal(views, 25, "the first page must not render the entire window");
  const cursor = first.structuredContent.next_cursor;
  assert.ok(cursor);
  f.svc.recentMessageRefs = async () => { throw new Error("cursor rescanned recent history"); };
  f.svc.db.messages.chatPage = () => { throw new Error("cursor scanned a chat instead of its ids"); };
  views = 0;
  const next = await f.call("get_recent_messages", { cursor, limit: 25 });
  assert.equal(next.isError, undefined);
  assert.equal(next.structuredContent.message_count, 25);
  assert.equal(views, 25);
  const firstIds = new Set(first.structuredContent.conversations.flatMap((c) => c.messages.map((m) => m.message_id)));
  assert.ok(next.structuredContent.conversations.flatMap((c) => c.messages).every((m) => !firstIds.has(m.message_id)));
});

test("recent pages preserve full-read ordering, metadata and type/system filters", async (t) => {
  const f = fixture(t);
  f.arrive(ANA, "First question?");
  f.arrive(GROUP, "Group question?", false, DAN);
  f.arrive(ANA, { imageMessage: { mimetype: "image/jpeg", caption: "Named picture" } });
  f.arrive(DAN, "A reply", true);
  f.arrive(ANA, "Last message");
  f.svc.db.messages.upsert({ chatJid: DAN, keyId: "SYSTEM", fromMe: false, ts: Date.now() - 1000, type: "system", text: "A system entry" });
  for (const args of [{}, { types: ["text"] }, { include_system: true }, { filter: "groups" }, { filter: "individual" }]) {
    const expected = (await f.svc.getRecentMessages(24, args.filter ?? "all", args.include_system ?? false, args.types)).data;
    const pending = expected.map((row) => ({ ...row, account_id: "default", messages: [...row.messages].reverse() }));
    let cursor;
    do {
      const answer = await f.call("get_recent_messages", cursor ? { cursor, limit: 2 } : { ...args, limit: 2 });
      assert.equal(answer.isError, undefined);
      let left = 2;
      const page = [];
      for (const row of pending) {
        const take = row.messages.splice(0, left);
        left -= take.length;
        if (take.length) page.push({ ...row, messages: take.reverse() });
      }
      assert.deepEqual(answer.structuredContent.conversations, page);
      cursor = answer.structuredContent.next_cursor;
      assert.equal(cursor !== null, pending.some((row) => row.messages.length));
    } while (cursor);
  }
});

test("recent cursors fill deletion and expiry gaps without adding newly arrived messages", async (t) => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const f = fixture(t);
  f.svc.db.transaction(() => f.svc.db.messages.upsertMany([
    { chatJid: DAN, keyId: "OTHER", fromMe: false, ts: now - 6000, type: "text", text: "Other conversation" },
    { chatJid: ANA, keyId: "KEEP", fromMe: false, ts: now - 5000, type: "text", text: "Keep this" },
    { chatJid: ANA, keyId: "EXPIRE", fromMe: false, ts: now - 4000, type: "text", text: "Expires soon", expiresAt: now + 5000 },
    { chatJid: ANA, keyId: "DELETE", fromMe: false, ts: now - 3000, type: "text", text: "Delete this" },
    { chatJid: ANA, keyId: "FIRST", fromMe: false, ts: now - 2000, type: "text", text: "First page" },
  ]));
  const first = await f.call("get_recent_messages", { limit: 1 });
  const cursor = first.structuredContent.next_cursor;
  assert.ok(cursor);
  f.sock.ev.emit("messages.delete", { keys: [{ remoteJid: ANA, fromMe: false, id: "DELETE" }] });
  now += 10_000;
  f.svc.db.messages.upsert({ chatJid: ANA, keyId: "NEW", fromMe: false, ts: now, type: "text", text: "New arrival" });
  const next = await f.call("get_recent_messages", { cursor, limit: 2 });
  assert.equal(next.structuredContent.message_count, 2);
  assert.deepEqual(next.structuredContent.conversations.flatMap((row) => row.messages.map((m) => m.message_id)), [
    `false_${ANA}_KEEP`, `false_${DAN}_OTHER`,
  ]);
  assert.equal(next.structuredContent.next_cursor, null);
  assert.doesNotMatch(allText(next), /Expires soon|Delete this|New arrival/);
  assert.deepEqual((await f.call("get_recent_messages", { cursor, limit: 2 })).structuredContent.conversations, next.structuredContent.conversations);
});

test("recent cursors skip long deleted runs in batches without consuming the following page", async (t) => {
  const f = fixture(t);
  const now = Date.now();
  f.svc.db.messages.upsertMany(Array.from({ length: 100 }, (_, i) => ({
    chatJid: ANA, keyId: `GAP${i}`, fromMe: false, ts: now - 1000 - (100 - i) * 1000, type: "text", text: `Message ${i}`,
  })));
  const first = await f.call("get_recent_messages", { limit: 1 });
  f.sock.ev.emit("messages.delete", { keys: Array.from({ length: 49 }, (_, i) => ({ remoteJid: ANA, fromMe: false, id: `GAP${50 + i}` })) });
  const byIds = f.svc.db.messages.byIds.bind(f.svc.db.messages);
  let queries = 0;
  f.svc.db.messages.byIds = (...args) => { queries++; return byIds(...args); };
  const next = await f.call("get_recent_messages", { cursor: first.structuredContent.next_cursor, limit: 1 });
  assert.equal(next.structuredContent.conversations[0].messages[0].message_id, `false_${ANA}_GAP49`);
  assert.ok(queries < 10, "a long gap must not require one query per deleted message");
  const last = await f.call("get_recent_messages", { cursor: next.structuredContent.next_cursor, limit: 1 });
  assert.equal(last.structuredContent.conversations[0].messages[0].message_id, `false_${ANA}_GAP48`);
});

test("recent cursors apply new private tags to group senders and embedded quotes", async (t) => {
  const f = fixture(t);
  f.arrive(GROUP, "SECRET-AUTHOR", false, ANA);
  f.arrive(GROUP, { extendedTextMessage: { text: "Public answer", contextInfo: { stanzaId: "QUOTE", participant: ANA, quotedMessage: { conversation: "SECRET-QUOTE" } } } }, false, DAN);
  f.arrive(GROUP, "Newest", false, DAN);
  const first = await f.call("get_recent_messages", { limit: 1 });
  f.svc.db.identity.updateFields(ANA, { addTags: ["private"] });
  const next = await f.call("get_recent_messages", { cursor: first.structuredContent.next_cursor, limit: 2 });
  assert.equal(next.structuredContent.message_count, 2);
  assert.equal(next.structuredContent.conversations[0].messages[0].private, true);
  assert.match(allText(next), /Public answer/);
  assert.doesNotMatch(allText(next), /SECRET-AUTHOR|SECRET-QUOTE/);
});

test("recent cursors retain partial sync metadata for accounts outside the selected page", async (t) => {
  const home = fixture(t), work = fixture(t);
  home.arrive(ANA, "Home question?");
  work.arrive(DAN, "Work question?");
  work.arrive(DAN, "Work follow-up?");
  const status = home.svc.getStatus.bind(home.svc);
  home.svc.getStatus = () => ({ ...status(), sync: "pending" });
  const bindings = [{ id: "home", wa: home.svc }, { id: "work", wa: work.svc }];
  const hub = { ...asToolSource(home.svc), bindings: () => bindings, defaultBinding: () => bindings[0],
    binding: (id) => bindings.find((b) => b.id === id), record: (id) => ({ id, enabled: true }), records: () => bindings.map((b) => ({ id: b.id, enabled: true })) };
  const { call } = schemaCheckedTools(hub, { allowWrite: false, legacyReads: true });
  const first = await call("get_recent_messages", { all_accounts: true, limit: 1 });
  const next = await call("get_recent_messages", { cursor: first.structuredContent.next_cursor, limit: 1 });
  assert.equal(next.structuredContent.conversations[0].account_id, "work");
  assert.equal(next.structuredContent.sync, "pending");
  assert.equal(next.structuredContent.partial, true);
});

test("recent cursors recheck archived/unread filters and cursor expiry", async (t) => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const f = fixture(t);
  f.arrive(ANA, "One");
  f.arrive(ANA, "Two");
  f.arrive(DAN, "Three");
  f.arrive(DAN, "Four");
  f.svc.db.identity.upsertChat({ jid: ANA, unread: 2 });
  f.svc.db.identity.upsertChat({ jid: DAN, unread: 2 });
  const first = await f.call("get_recent_messages", { filter: "unread", limit: 1 });
  const cursor = first.structuredContent.next_cursor;
  f.svc.db.identity.upsertChat({ jid: DAN, unread: 0 });
  f.svc.db.identity.upsertChat({ jid: ANA, archived: true });
  const next = await f.call("get_recent_messages", { cursor, limit: 2 });
  assert.equal(next.structuredContent.message_count, 0);
  assert.equal(next.structuredContent.next_cursor, null);
  now += 16 * 60_000;
  assert.equal(JSON.parse((await f.call("get_recent_messages", { cursor })).content[0].text).error, "CURSOR_EXPIRED");
});

test("recent cursors recheck the rolling window before quoting stored ids", async (t) => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const f = fixture(t);
  f.svc.db.messages.upsert({ chatJid: ANA, keyId: "BOUNDARY", fromMe: false, ts: now - 3_600_000 + 1000, type: "text", text: "Falls outside window" });
  f.arrive(ANA, "Newest");
  const first = await f.call("get_recent_messages", { hours: 1, limit: 1 });
  assert.ok(first.structuredContent.next_cursor);
  now += 2000;
  const next = await f.call("get_recent_messages", { cursor: first.structuredContent.next_cursor });
  assert.equal(next.structuredContent.message_count, 0);
  assert.equal(next.structuredContent.next_cursor, null);
  assert.doesNotMatch(allText(next), /Falls outside window/);
});

test("recent pagination isolates account-local ids and merges account pages in activity order", async (t) => {
  const home = fixture(t);
  const work = fixture(t);
  const now = Date.now();
  const seed = (svc, chat, label, ages) => svc.db.messages.upsertMany(ages.map((age, i) => ({
    chatJid: chat, keyId: `SHARED${i}`, fromMe: false, ts: now - age, type: "text", text: `${label} ${i}`,
  })));
  seed(home.svc, ANA, "HOME", [4000, 2000]);
  seed(work.svc, DAN, "WORK", [4000, 1000]);
  const bindings = [{ id: "home", wa: home.svc }, { id: "work", wa: work.svc }];
  const hub = { ...asToolSource(home.svc), bindings: () => bindings,
    defaultBinding: () => bindings[0], binding: (id) => bindings.find((b) => b.id === id),
    record: (id) => ({ id, enabled: true }), records: () => bindings.map((b) => ({ id: b.id, enabled: true })) };
  const { call } = schemaCheckedTools(hub, { allowWrite: false, legacyReads: true });
  const first = await call("get_recent_messages", { all_accounts: true, limit: 1 });
  assert.equal(first.structuredContent.conversations[0].account_id, "work");
  const next = await call("get_recent_messages", { cursor: first.structuredContent.next_cursor, limit: 2 });
  assert.deepEqual(next.structuredContent.conversations.map((c) => [c.account_id, c.messages.map((m) => m.text)]), [
    ["work", ["WORK 0"]], ["home", ["HOME 1"]],
  ]);
  work.svc.db.identity.updateFields(ANA, { addTags: ["private"] });
  const last = await call("get_recent_messages", { cursor: next.structuredContent.next_cursor, limit: 10 });
  assert.equal(last.structuredContent.conversations[0].account_id, "home");
  assert.equal(last.structuredContent.message_count, 1);
  assert.doesNotMatch(allText(last), /HOME 0/);
  assert.equal(last.structuredContent.conversations[0].messages[0].private, true);
  assert.equal(last.structuredContent.next_cursor, null);
});

test("recent cursors never substitute a different message after an account database replacement", async (t) => {
  const original = fixture(t), replacement = fixture(t);
  const now = Date.now();
  original.svc.db.messages.upsertMany([
    { chatJid: ANA, keyId: "ORIGINAL", fromMe: false, ts: now - 2000, type: "text", text: "Original history" },
    { chatJid: ANA, keyId: "NEWEST", fromMe: false, ts: now - 1000, type: "text", text: "First page" },
  ]);
  replacement.svc.db.messages.upsert({ chatJid: ANA, keyId: "UNRELATED", fromMe: false, ts: now - 2000, type: "text", text: "Different history" });
  assert.equal(original.svc.db.messages.get(`false_${ANA}_ORIGINAL`).id, replacement.svc.db.messages.get(`false_${ANA}_UNRELATED`).id);
  let current = original.svc;
  const hub = { ...asToolSource(original.svc), bindings: () => [{ id: "default", wa: current }],
    defaultBinding: () => ({ id: "default", wa: current }), binding: (id) => id === "default" ? { id, wa: current } : undefined };
  const { call } = schemaCheckedTools(hub, { allowWrite: false, legacyReads: true });
  const first = await call("get_recent_messages", { limit: 1 });
  current = replacement.svc;
  const next = await call("get_recent_messages", { cursor: first.structuredContent.next_cursor, limit: 1 });
  assert.equal(textError(next).error, "CURSOR_EXPIRED");
  assert.doesNotMatch(allText(next), /Different history/);
});

test("adversarial: a recent cursor cannot cross to a replacement service with matching message keys", async (t) => {
  const original = fixture(t), replacement = fixture(t);
  const now = Date.now();
  for (const [f, text] of [[original, "Original account"], [replacement, "REPLACEMENT-CONTENT"]]) {
    f.svc.db.messages.upsertMany([
      { chatJid: ANA, keyId: "SAME", fromMe: false, ts: now - 2000, type: "text", text },
      { chatJid: ANA, keyId: "TOP", fromMe: false, ts: now - 1000, type: "text", text: "Top" },
    ]);
  }
  let current = original.svc;
  const hub = { ...asToolSource(original.svc), bindings: () => [{ id: "default", wa: current }],
    defaultBinding: () => ({ id: "default", wa: current }), binding: (id) => id === "default" ? { id, wa: current } : undefined };
  const { call } = schemaCheckedTools(hub, { allowWrite: false, legacyReads: true });
  const first = await call("get_recent_messages", { limit: 1 });
  current = replacement.svc;
  const next = await call("get_recent_messages", { cursor: first.structuredContent.next_cursor });
  assert.doesNotMatch(allText(next), /REPLACEMENT-CONTENT/);
  assert.equal(textError(next).error, "CURSOR_EXPIRED");
});

test("adversarial: changing the linked owner invalidates a cursor on the same service", async (t) => {
  const f = fixture(t);
  f.arrive(ANA, "Older");
  f.arrive(ANA, "Newest");
  const first = await f.call("get_recent_messages", { limit: 1 });
  f.svc.account = { id: DAN, number: DAN.split("@")[0], name: "Different owner" };
  assert.equal(textError(await f.call("get_recent_messages", { cursor: first.structuredContent.next_cursor })).error, "CURSOR_EXPIRED");
});

test("adversarial: an owner change while a preview awaits cannot return the old page", async (t) => {
  const f = fixture(t);
  f.arrive(ANA, "Older page body");
  f.arrive(ANA, "Newest");
  const first = await f.call("get_recent_messages", { limit: 1 });
  f.svc.previews = async () => {
    f.svc.account = { id: DAN, number: DAN.split("@")[0], name: "New linked owner" };
    return [];
  };
  const next = await f.call("get_recent_messages", { cursor: first.structuredContent.next_cursor, include_previews: true });
  assert.equal(textError(next).error, "CURSOR_EXPIRED");
  assert.doesNotMatch(allText(next), /Older page body/);
});

test("adversarial: an in-progress address fold cannot resurrect a retracted twin through a recent cursor", async (t) => {
  const f = fixture(t);
  const lid = "900000000000002@lid", now = Date.now();
  f.svc.db.messages.upsertMany([
    { chatJid: lid, keyId: "TWIN", fromMe: false, ts: now - 3000, type: "text", text: "RETRACTED-LID-CONTENT" },
    { chatJid: ANA, keyId: "TWIN", fromMe: false, ts: now - 3000, type: "text", text: "Phone twin" },
    { chatJid: DAN, keyId: "TOP", fromMe: false, ts: now - 1000, type: "text", text: "First page" },
  ]);
  f.svc.db.messages.delete(`false_${ANA}_TWIN`);
  const first = await f.call("get_recent_messages", { limit: 1 });
  assert.ok(first.structuredContent.next_cursor);
  let release;
  const blocked = f.svc.db.connection.bulk(() => new Promise((resolve) => { release = resolve; }));
  // Let the bulk blocker start, then pause the asynchronous row movement.
  await Promise.resolve();
  f.svc.identity.lids.learn(lid, ANA);
  const folding = f.svc.db.learnLidPhone(lid, ANA);
  try {
    assert.equal(f.svc.db.messages.get(`false_${ANA}_TWIN`), null, "the canonical lookup already respects the retraction");
    const next = await f.call("get_recent_messages", { cursor: first.structuredContent.next_cursor });
    assert.doesNotMatch(allText(next), /RETRACTED-LID-CONTENT/);
    assert.equal(next.structuredContent.message_count, 0);
  } finally { release(); await blocked; await folding; }
});

test("adversarial: visible twins are returned only once while an address fold is paused", async (t) => {
  const f = fixture(t);
  const lid = "900000000000002@lid", now = Date.now();
  f.svc.db.messages.upsertMany([
    { chatJid: lid, keyId: "TWIN", fromMe: false, ts: now - 3000, type: "text", text: "Lid copy" },
    { chatJid: ANA, keyId: "TWIN", fromMe: false, ts: now - 3000, type: "text", text: "Phone copy" },
    { chatJid: DAN, keyId: "TOP", fromMe: false, ts: now - 1000, type: "text", text: "First page" },
  ]);
  const first = await f.call("get_recent_messages", { limit: 1 });
  let release;
  const blocked = f.svc.db.connection.bulk(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  f.svc.identity.lids.learn(lid, ANA);
  const folding = f.svc.db.learnLidPhone(lid, ANA);
  try {
    const next = await f.call("get_recent_messages", { cursor: first.structuredContent.next_cursor });
    assert.equal(next.structuredContent.message_count, 1);
    assert.equal(next.structuredContent.conversations[0].messages[0].text, "Phone copy");
    assert.equal(next.structuredContent.next_cursor, null);
  } finally { release(); await blocked; await folding; }
});

test("private direct messages, group authors and their quoted words stay private in both compatibility summaries", async (t) => {
  const f = fixture(t);
  f.arrive(ANA, "SECRET-DIRECT poți trimite?");
  f.arrive(GROUP, "SECRET-GROUP", false, ANA);
  f.arrive(GROUP, { extendedTextMessage: { text: "public reply", contextInfo: { stanzaId: "Q", participant: ANA, quotedMessage: { conversation: "SECRET-QUOTE" } } } }, false, DAN);
  f.svc.db.identity.updateFields(ANA, { addTags: ["private"] });
  for (const name of ["get_recent_messages", "get_unanswered"])
    assert.doesNotMatch(allText(await f.call(name)), /SECRET-DIRECT|SECRET-GROUP|SECRET-QUOTE/);
  assert.doesNotMatch(allText(await f.call("get_recent_messages", { compact: true })), /SECRET-DIRECT|SECRET-GROUP|SECRET-QUOTE/);
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

test("compact reads remove empty media and deleted messages in both representations, group adjacent text and keep source ids", async (t) => {
  const f = fixture(t);
  const first = f.arrive(ANA, "Prima parte");
  const second = f.arrive(ANA, "A doua parte");
  f.arrive(ANA, { imageMessage: { mimetype: "image/jpeg" } });
  f.arrive(ANA, { stickerMessage: { mimetype: "image/webp" } });
  f.arrive(ANA, "🐾");
  const gone = f.arrive(ANA, "NU MAI EXISTA");
  // Old synced/imported history may contain tombstones; live revokes remove the row.
  const viewOfStored = f.svc.views.viewOfStored.bind(f.svc.views);
  f.svc.views.viewOfStored = (...args) => {
    const m = viewOfStored(...args);
    return m.message_id === gone ? { ...m, type: "deleted", text: "[deleted]" } : m;
  };
  const caption = f.arrive(ANA, { imageMessage: { mimetype: "image/jpeg", caption: "Lista pentru joi" } });
  const document = f.arrive(ANA, { documentMessage: { mimetype: "application/pdf", fileName: "lista.pdf" } });
  const compact = await f.call("get_recent_messages", { compact: true, limit: 20 });
  const row = compact.structuredContent.conversations[0];
  assert.equal(row.messages.length, 3);
  assert.equal(row.messages[0].text, "Prima parte\nA doua parte");
  assert.deepEqual(row.messages[0].message_ids, [first, second]);
  assert.deepEqual(row.messages.slice(1).map((m) => m.message_id), [caption, document]);
  assert.deepEqual(row.omitted, { image: 1, sticker: 1, text: 1, deleted: 1 });
  assert.equal(compact.structuredContent.message_count, 8, "page budget still counts original messages");
  assert.equal(compact.structuredContent.shown_message_count, 4);
  assert.equal(compact.structuredContent.line_count, 3);
  assert.doesNotMatch(compact.content[0].text, /\[deleted\]|\[image\](?:\n|$)|🐾|NU MAI EXISTA/);
  assert.match(compact.content[0].text, /omitted:.*image/);
  const full = await f.call("get_recent_messages", { compact: false, limit: 20 });
  assert.equal(full.structuredContent.conversations[0].messages.length, 8);
  assert.equal(full.structuredContent.conversations[0].messages[0].text, "Prima parte", "compaction never mutates source messages");
});

test("compact cursors keep their mode; an all-media page reports omissions instead of claiming no history", async (t) => {
  const f = fixture(t);
  f.arrive(ANA, "Înainte");
  f.arrive(ANA, { imageMessage: { mimetype: "image/jpeg" } });
  f.arrive(ANA, { audioMessage: { mimetype: "audio/ogg", ptt: true } });
  const first = await f.call("get_recent_messages", { compact: true, limit: 1 });
  assert.equal(first.structuredContent.shown_message_count, 0);
  assert.deepEqual(first.structuredContent.conversations[0].omitted, { voice: 1 });
  assert.doesNotMatch(first.content[0].text, /No recent messages/);
  const next = await f.call("get_recent_messages", { cursor: first.structuredContent.next_cursor, limit: 10 });
  assert.equal(next.structuredContent.compact, true);
  assert.equal(next.structuredContent.shown_message_count, 1);
  assert.deepEqual(next.structuredContent.conversations[0].omitted, { image: 1 });
});

test("compact reads keep missed calls, bracketed words and quotes, without merging different group authors", async (t) => {
  const f = fixture(t);
  f.arrive(GROUP, "[URGENT]", false, ANA);
  const quoted = f.arrive(GROUP, { extendedTextMessage: { text: "Verifică mâine", contextInfo: {
    stanzaId: "QUOTED", participant: DAN, quotedMessage: { conversation: "La ora 10" },
  } } }, false, ANA);
  f.arrive(GROUP, "Confirm", false, DAN);
  const at = Date.now() - 10_000;
  for (const status of ["offer", "timeout"]) f.sock.ev.emit("call", [{
    chatId: ANA, from: ANA, id: "MISSED", date: new Date(at), status, offline: false,
  }]);
  const answer = await f.call("get_recent_messages", { compact: true, limit: 20 });
  const group = answer.structuredContent.conversations.find((row) => row.chat_id === GROUP);
  assert.equal(group.messages.length, 3);
  assert.equal(group.messages[0].text, "[URGENT]");
  const reply = group.messages.find((m) => m.message_id === quoted);
  assert.equal(reply.quoted.text, "La ora 10");
  const direct = answer.structuredContent.conversations.find((row) => row.chat_id === ANA);
  assert.equal(direct.messages[0].call.outcome, "missed");
});

test("remote learn and instructions prefer the current catalogue and explain callable cached fallbacks", async (t) => {
  const f = fixture(t);
  const guide = (await f.call("learn", {})).content[0].text;
  for (const name of LEGACY) assert.ok(guide.includes(name), name);
  assert.ok(Buffer.byteLength(guide) / 4 <= 2000, "remote learn stays within 2000 tokens");
  assert.match(guide, /catch_up/);
  assert.match(guide, /Compatibility names remain callable but are not advertised/);
  assert.match(guide, /words and meaning with contexts/i);
  assert.match(guide, /check corrections, clarify ambiguity/i);
  assert.match(guide, /get_unanswered/);
  const local = schemaCheckedTools(f.svc, { allowWrite: false });
  assert.match((await local.call("learn", {})).content[0].text, /catch_up/);
  const stop = new AbortController();
  t.after(() => stop.abort());
  const port = await startHttpEndpoint(asToolSource(f.svc), f.svc.config, {
    host: "127.0.0.1", port: 0, openRead: false, signal: stop.signal, credentials: [{ token: "synthetic-guide-reader", write: false }],
  });
  const client = new Client({ name: "cached-guide-connector", version: "0.23" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: "Bearer synthetic-guide-reader" } } }));
  const instructions = client.getInstructions();
  assert.match(instructions, /get_recent_messages/);
  assert.match(instructions, /catch_up/);
  for (const name of ["whatsapp-inbox", "whatsapp-recall", "whatsapp-groups"]) {
    const prompt = await client.getPrompt({ name });
    const body = prompt.messages[0].content.text;
    assert.match(body, /get_recent_messages/);
    assert.match(body, /Compatibility names remain callable but are not advertised/);
  }
});
