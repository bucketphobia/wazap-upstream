/**
 * list_chats pages off chats_activity (schema v7) instead of decoding and
 * sorting every chat: the same chats, in the same order, behind the same
 * cursors as the list 1.6.0 built in memory, for every filter and page size;
 * the order key stays in step with every write of a chat's description; a
 * file from before v7 has its descriptions' times read once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { proto } from "baileys";

import { AccountDb } from "../dist/db/index.js";
import { MIGRATIONS } from "../dist/db/schema.js";
import { sqlite } from "../dist/db/sqlite.js";
import { protoNumber } from "../dist/messages.js";
import { chatActivity } from "../dist/service/util.js";
import { decodeChat } from "../dist/store.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService } from "./helpers.mjs";
import { tempDir } from "./db-fixtures.mjs";

const ME = "40700000000@s.whatsapp.net";
const FILTERS = ["all", "unread", "groups", "individual", "archived"];
const NOW_S = Math.floor(Date.now() / 1000);

/** The list as 1.6.0 built it: every chat read, its description decoded, all sorted, then sliced past the cursor. */
function listedBefore(svc, filter, tagged = null) {
  const views = svc.views;
  const entries = svc.db.identity
    .listChats()
    .filter((chat) => views.listed(chat) && views.matchesChatFilter(chat, filter) && (tagged === null || tagged.has(chat.id)))
    .map((chat) => ({ chat, proto: chat.proto === null ? null : decodeChat(Buffer.from(chat.proto).toString("base64")) }));
  const activity = (entry) => {
    const described = protoNumber(entry.proto?.conversationTimestamp);
    if (described !== undefined && described !== null) return described;
    return entry.chat.lastTs === null ? 0 : Math.floor(entry.chat.lastTs / 1000);
  };
  const key = (entry) => [activity(entry), entry.chat.lastMessageId ?? 0, entry.chat.id];
  return entries
    .sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
    })
    .map((entry) => entry.chat.jid);
}

async function pagesOf(svc, filter, limit, tag) {
  const seen = [];
  let cursor;
  for (let page = 0; page < 200; page++) {
    const result = await svc.listChats(filter, limit, { ...(cursor === undefined ? {} : { cursor }), ...(tag === undefined ? {} : { tag }) });
    seen.push(...result.data.map((chat) => chat.chat_id));
    assert.ok(result.data.length <= limit);
    if (result.nextCursor === null) return seen;
    cursor = result.nextCursor;
  }
  return assert.fail("the cursor never ended");
}

/** An account with every kind of chat list_chats has to order: described or not, ties, archived, unread, groups, lids, the status feed. */
function seed(sock, svc) {
  let rnd = 7;
  const next = () => (rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const chats = [];
  for (let i = 0; i < 90; i++) {
    const group = i % 5 === 0;
    const jid = group ? `1203630000000${String(i).padStart(5, "0")}@g.us` : `4071${String(i).padStart(7, "0")}@s.whatsapp.net`;
    const chat = { id: jid };
    // Some describe a time (several the same second), some none; some are archived or unread.
    if (i % 3 !== 0) chat.conversationTimestamp = NOW_S - (i % 4 === 0 ? 600 : Math.floor(next() * 86400 * 30));
    if (i % 11 === 0) chat.archived = true;
    if (i % 4 === 1) chat.unreadCount = 1 + (i % 3);
    if (group) chat.name = `Grup ${i}`;
    chats.push(chat);
  }
  sock.ev.emit("chats.upsert", chats);
  // Messages in two thirds of them, a few in chats nothing described; a lid chat; a story.
  const messages = [];
  for (let i = 0; i < 120; i++) {
    const n = Math.floor(next() * 100);
    const jid = n % 5 === 0 && n < 90 ? `1203630000000${String(n).padStart(5, "0")}@g.us` : `4071${String(n).padStart(7, "0")}@s.whatsapp.net`;
    messages.push({
      key: { remoteJid: jid, fromMe: next() < 0.3, id: `M${i}`, ...(jid.endsWith("@g.us") ? { participant: "40799999999@s.whatsapp.net" } : {}) },
      message: { conversation: `mesaj ${i}` },
      messageTimestamp: NOW_S - Math.floor(next() * 86400 * 20),
    });
  }
  messages.push({ key: { remoteJid: "123451234512345@lid", fromMe: false, id: "LID1" }, message: { conversation: "de pe lid" }, messageTimestamp: NOW_S - 50 });
  messages.push({ key: { remoteJid: "status@broadcast", fromMe: false, id: "ST1", participant: "40711111111@s.whatsapp.net" }, message: { conversation: "story" }, messageTimestamp: NOW_S - 5 });
  sock.ev.emit("messaging-history.set", { chats: [], contacts: [], messages, isLatest: true, progress: 100 });
  return svc.storageIdle();
}

test("every filter and page size lists the same chats in the same order as the list built in memory", async (t) => {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-list-index-", id: ME, name: "Owner", config: { persistHistory: true } });
  t.after(() => svc.stop());
  await seed(sock, svc);
  svc.db.identity.updateFields("40710000002@s.whatsapp.net", { addTags: ["client"] });
  svc.db.identity.updateFields("40710000007@s.whatsapp.net", { addTags: ["client"] });
  const all = listedBefore(svc, "all");
  assert.ok(all.length > 60, `a list worth paging: ${all.length}`);
  for (const filter of FILTERS) {
    const expected = listedBefore(svc, filter);
    for (const limit of [1, 3, 7, 20, 100]) {
      assert.deepEqual(await pagesOf(svc, filter, limit), expected, `${filter}, ${limit} a page`);
    }
  }
  const tagged = new Set(svc.db.identity.chatIdsTagged("client"));
  assert.deepEqual(await pagesOf(svc, "all", 1, "client"), listedBefore(svc, "all", tagged), "a tag scopes the same list");
});

test("a cursor from the list built in memory carries on where it left off", async (t) => {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-list-index-", id: ME, name: "Owner", config: { persistHistory: true } });
  t.after(() => svc.stop());
  await seed(sock, svc);
  const expected = listedBefore(svc, "all");
  // The 1.6.0 cursor: the listing, then the last chat's (activity, last message id, chat id).
  const cut = svc.db.identity.chat(expected[9]);
  const described = cut.proto === null ? null : protoNumber(decodeChat(Buffer.from(cut.proto).toString("base64"))?.conversationTimestamp);
  const activity = described ?? (cut.lastTs === null ? 0 : Math.floor(cut.lastTs / 1000));
  const cursor = Buffer.from(JSON.stringify(["all", activity, cut.lastMessageId ?? 0, cut.id])).toString("base64url");
  const page = await svc.listChats("all", 5, { cursor });
  assert.deepEqual(page.data.map((chat) => chat.chat_id), expected.slice(10, 15));
});

test("the order key follows every write of a chat's description: a new time, a delete, a fold", async (t) => {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-list-index-", id: ME, name: "Owner", config: { persistHistory: true } });
  t.after(() => svc.stop());
  await seed(sock, svc);
  const quiet = listedBefore(svc, "all").at(-1);
  sock.ev.emit("chats.update", [{ id: quiet, conversationTimestamp: NOW_S + 60 }]);
  assert.equal((await svc.listChats("all", 1)).data[0].chat_id, quiet, "described as newest: first");
  assert.deepEqual(await pagesOf(svc, "all", 10), listedBefore(svc, "all"));

  await svc.chats.forgetChat(quiet, true);
  await svc.storageIdle();
  assert.equal(svc.db.identity.chat(quiet)?.proto ?? null, null);
  assert.deepEqual(await pagesOf(svc, "all", 10), listedBefore(svc, "all"), "a deleted chat's description and its time go together");

  // A lid chat folding into its number's keeps the description of whichever had one.
  sock.ev.emit("chats.upsert", [{ id: "999888777666555@lid", conversationTimestamp: NOW_S + 120 }]);
  sock.ev.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: "999888777666555@lid", fromMe: false, id: "FOLD1" }, message: { conversation: "salut" }, messageTimestamp: NOW_S - 30 }] });
  svc.identity.learnLid("999888777666555@lid", "40712345678@s.whatsapp.net");
  await Promise.allSettled([...svc.folds]);
  await svc.db.idle();
  const folded = svc.db.identity.chat("40712345678@s.whatsapp.net");
  assert.ok(folded !== null);
  assert.equal(svc.db.connection.get("SELECT described_ts AS d FROM chats WHERE id = ?", folded.id).d, NOW_S + 120);
  assert.equal((await svc.listChats("all", 1)).data[0].chat_id, "40712345678@s.whatsapp.net");
  assert.deepEqual(await pagesOf(svc, "all", 10), listedBefore(svc, "all"));
});

test("a file from before v7 has its chats' described times read once, by the first open that can decode them", () => {
  const dir = join(tempDir("wazap-v7-"), "account");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "wazap.sqlite");
  const raw = new (sqlite().DatabaseSync)(path);
  raw.exec("BEGIN");
  for (const migration of MIGRATIONS) {
    if (migration.version > 6) break;
    raw.exec(migration.sql);
    raw.exec(`PRAGMA user_version = ${migration.version}`);
  }
  const described = proto.Conversation.encode({ id: "40700000002@s.whatsapp.net", conversationTimestamp: 1_790_000_000 }).finish();
  const bare = proto.Conversation.encode({ id: "40700000003@s.whatsapp.net" }).finish();
  raw.prepare("INSERT INTO chats(id, jid, kind, proto) VALUES (1, '40700000002@s.whatsapp.net', 'direct', ?)").run(described);
  raw.prepare("INSERT INTO chats(id, jid, kind, proto) VALUES (2, '40700000003@s.whatsapp.net', 'direct', ?)").run(bare);
  raw.prepare("INSERT INTO chats(id, jid, kind, proto) VALUES (3, '40700000004@s.whatsapp.net', 'direct', ?)").run(new Uint8Array([0xff, 0xff, 0xff]));
  raw.exec("INSERT INTO chats(id, jid, kind) VALUES (4, '40700000005@s.whatsapp.net', 'direct')");
  raw.exec("COMMIT");
  raw.close();

  const times = (db) => db.connection.all("SELECT id, described_ts FROM chats ORDER BY id").map((row) => row.described_ts);
  // An open with no decoder (a CLI command) migrates and leaves the read owed.
  const first = AccountDb.open(path, { checkpointDelayMs: 0, preMigrationBackup: false });
  assert.equal(first.getMeta("chat_activity_backfill"), "pending");
  assert.deepEqual(times(first), [null, null, null, null]);
  first.close();
  // The server's open reads them.
  const second = AccountDb.open(path, { checkpointDelayMs: 0, chatActivity });
  assert.equal(second.getMeta("chat_activity_backfill"), null);
  assert.deepEqual(times(second), [1_790_000_000, null, null, null], "a stated time; none stated; one that does not decode; no description");
  second.close();
});
