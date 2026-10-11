/**
 * The everyday tools: a note on a person, "I handled that", and a search with
 * a time or a sender.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, databaseHolds, offlineConfig, openService, schemaCheckedTools, textError } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const hour = 3_600_000;

function setup(config = {}) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-daily-", id: ME, name: "Răzvan", config });
  const { tools, call } = schemaCheckedTools(svc, { allowWrite: false, allowLocalEdits: true });
  let seq = 0;
  const arrive = (chat, text, { fromMe = false, participant, at = Date.now() } = {}) => {
    const id = `M${++seq}`;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) },
          message: typeof text === "string" ? { conversation: text } : text,
          messageTimestamp: Math.floor(at / 1000),
        },
      ],
    });
    return id;
  };
  sock.ev.emit("contacts.upsert", [
    { id: ANA, name: "Ana" },
    { id: DAN, name: "Dan" },
  ]);
  sock.fetchStatus = async () => [];
  sock.profilePictureUrl = async () => null;
  return { svc, sock, call, arrive, tools };
}

test("a note on a contact rides along wherever the person shows, and lives in the account database", async () => {
  const { svc, call, arrive } = setup();
  arrive(DAN, "salut");
  const noted = await call("remember", { chat_id: "+40 700 000 003", note: "Hermi, my own agent" });
  assert.match(noted.content[0].text, /Noted for Dan: Hermi, my own agent/);
  const found = await call("find_contact", { name: "Dan" });
  assert.equal(found.structuredContent.contact.note, "Hermi, my own agent");
  assert.match(found.content[0].text, /note: Hermi, my own agent/);
  assert.match((await call("list_chats", {})).content[0].text, /## Dan · Hermi, my own agent/);
  assert.equal(svc.db.identity.notes(DAN).note, "Hermi, my own agent");

  const again = openService(WhatsAppService, { ...offlineConfig("x"), dataDir: svc.config.dataDir });
  assert.equal(again.db.identity.notes(DAN).note, "Hermi, my own agent", "a restart reads it back");
  await again.stop();

  await call("remember", { chat_id: DAN, note: "" });
  assert.doesNotMatch((await call("find_contact", { name: "Dan" })).content[0].text, /Hermi/);
});

test("remember files a note, tags and details in one call, and a refused edit files none of them", async () => {
  const { svc, call, arrive } = setup();
  arrive(DAN, "salut");
  const filed = await call("remember", { chat_id: DAN, note: "colegul de birou", add_tags: ["#Echipa"], fields: { role: "contabil" } });
  assert.equal(filed.structuredContent.chat_id, DAN);
  assert.equal(filed.structuredContent.note, "colegul de birou");
  assert.deepEqual(filed.structuredContent.tags, ["echipa"]);
  assert.deepEqual(filed.structuredContent.fields, { role: "contabil" });
  assert.match(filed.content[0].text, /Noted for Dan: colegul de birou/);
  assert.match(filed.content[0].text, /\*\*role\*\*: contabil/);

  const refused = await call("remember", { chat_id: DAN, note: "altceva", add_tags: ["#"] });
  assert.equal(textError(refused).error, "INVALID_ID");
  assert.equal(svc.db.identity.notes(DAN).note, "colegul de birou", "the note waits on the details it came with");

  assert.equal(textError(await call("remember", { chat_id: DAN })).error, "INVALID_ID");
});

test("remember handled: true takes a chat off the waiting list until the other side writes again", async () => {
  const { call, arrive } = setup();
  arrive(ANA, "poți să mă suni?", { at: Date.now() - 2 * hour });
  const waiting = async () => (await call("catch_up", { hours: 24 })).structuredContent.waiting;
  assert.deepEqual(
    (await waiting()).map((entry) => entry.name),
    ["Ana"]
  );

  const marked = await call("remember", { chat_id: ANA, handled: true });
  assert.match(marked.content[0].text, /Ana is off the waiting list until they write again/);
  assert.equal(marked.structuredContent.handled.ask_text, "poți să mă suni?");
  assert.deepEqual(await waiting(), []);

  arrive(ANA, "și mâine?", { at: Date.now() - hour });
  assert.deepEqual(
    (await waiting()).map((entry) => entry.q),
    ["și mâine?"],
    "a new ask reopens it"
  );

  const nothing = await call("remember", { chat_id: DAN, handled: true });
  assert.match(nothing.content[0].text, /had nothing open/);
});

test("search_messages narrows by time and by sender", async () => {
  const { call, arrive } = setup();
  const day = 24 * hour;
  arrive(ANA, "RCA expiră luni", { at: Date.now() - 10 * day });
  arrive(ANA, "RCA e gata", { at: Date.now() - 2 * day });
  arrive(ANA, "am plătit RCA", { fromMe: true, at: Date.now() - day });
  const since = new Date(Date.now() - 3 * day).toISOString().slice(0, 10);

  const recent = await call("search", { match: "words", query: "rca", since });
  assert.deepEqual(
    recent.structuredContent.messages.map((m) => m.text),
    ["am plătit RCA", "RCA e gata"]
  );
  const theirs = await call("search", { match: "words", query: "rca", from: ANA });
  assert.deepEqual(
    theirs.structuredContent.messages.map((m) => m.text),
    ["RCA e gata", "RCA expiră luni"]
  );
  const mine = await call("search", { match: "words", query: "rca", from: "me" });
  assert.deepEqual(
    mine.structuredContent.messages.map((m) => m.text),
    ["am plătit RCA"]
  );
  // The account's own number, however it is spelled, is "me" too.
  for (const self of [ME, ME.split("@")[0], `+${ME.split("@")[0]}`]) {
    const spelled = await call("search", { match: "words", query: "rca", from: self });
    assert.deepEqual(spelled.structuredContent.messages.map((m) => m.text), ["am plătit RCA"], `from ${self}`);
  }
  const until = await call("search", { match: "words", query: "rca", until: new Date(Date.now() - 5 * day).toISOString() });
  assert.deepEqual(
    until.structuredContent.messages.map((m) => m.text),
    ["RCA expiră luni"]
  );
  assert.match(recent.content[0].text, new RegExp(`since ${since}`));

  const bad = await call("search", { match: "words", query: "rca", since: "luni" });
  assert.equal(textError(bad).error, "INVALID_ID");
});

test("search follows an edit and a late transcript, not the words it cached first", async () => {
  const { svc, sock, call, arrive } = setup();
  arrive(ANA, "RCA expiră luni");
  const before = await call("search", { match: "words", query: "zebra" });
  assert.deepEqual(before.structuredContent.messages, []);

  sock.ev.emit("messages.update", [
    {
      key: { remoteJid: ANA, fromMe: false, id: "M1" },
      update: { message: { editedMessage: { message: { conversation: "zebra e a mea" } } } },
    },
  ]);
  const after = await call("search", { match: "words", query: "zebra" });
  assert.deepEqual(
    after.structuredContent.messages.map((m) => m.text),
    ["zebra e a mea"],
    "the edit replaces what the search matches"
  );
  assert.deepEqual(
    (await call("search", { match: "words", query: "rca" })).structuredContent.messages,
    [],
    "and the words it replaced no longer match"
  );

  const vid = arrive(ANA, { audioMessage: { ptt: true, seconds: 4 } });
  const sid = `false_${ANA}_${vid}`;
  assert.deepEqual((await call("search", { match: "words", query: "umbrela" })).structuredContent.messages, []);
  svc.db.messages.setTranscript(sid, "am uitat umbrela");
  assert.deepEqual(
    (await call("search", { match: "words", query: "umbrela" })).structuredContent.messages.map((m) => m.message_id),
    [sid],
    "a transcript that lands after the first search is still found"
  );
});

test("an edit rewrites the edited message's stored protobuf and leaves its neighbours as they were", async () => {
  const { svc, sock, arrive } = setup();
  arrive(ANA, "prima versiune");
  arrive(DAN, "nemișcat");
  const sid = `false_${ANA}_M1`;
  const still = `false_${DAN}_M2`;

  const first = { edited: Buffer.from(svc.db.messages.get(sid).raw), neighbour: Buffer.from(svc.db.messages.get(still).raw) };
  sock.ev.emit("messages.update", [
    {
      key: { remoteJid: ANA, fromMe: false, id: "M1" },
      update: { message: { editedMessage: { message: { conversation: "a doua versiune" } } } },
    },
  ]);
  const edited = svc.db.messages.get(sid);
  assert.notDeepEqual(Buffer.from(edited.raw), first.edited, "the edit re-encodes");
  assert.deepEqual(Buffer.from(svc.db.messages.get(still).raw), first.neighbour, "the neighbour is not rewritten");
  assert.equal(proto.WebMessageInfo.decode(edited.raw).message.conversation, "a doua versiune");
  assert.notEqual(edited.editedAt, null);
});

test("a revoked message leaves the database, the search, and a restart", async () => {
  const { svc, sock, call, arrive } = setup({ persistHistory: true });
  const id = arrive(ANA, "parola e hunter2");
  const sid = `false_${ANA}_${id}`;
  assert.ok(svc.hasMessage(sid));

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: ANA, fromMe: false, id: "R1" },
        message: {
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.REVOKE,
            key: { remoteJid: ANA, fromMe: false, id },
          },
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
  });

  assert.equal(svc.hasMessage(sid), false, "the target is gone");
  assert.deepEqual((await call("search", { match: "words", query: "hunter2" })).structuredContent.messages, []);
  const read = (await call("read_messages", { chat_id: ANA })).content[0].text;
  assert.doesNotMatch(read, /hunter2/);
  assert.match(read, /\[deleted\]/, "the placeholder stays, the way the phone shows it");

  // Cleanup takes the words off the disk at once. A content-free barrier
  // must still win if an older copy is replayed later.
  await svc.storageIdle();
  assert.equal(databaseHolds(svc, "hunter2"), false);
  const again = openService(WhatsAppService, { ...offlineConfig("x"), dataDir: svc.config.dataDir, persistHistory: true });
  await again.bootStorage();
  assert.equal(again.hasMessage(sid), false, "a restart honours the tombstone");
  assert.deepEqual(
    again.db.messages.chatPage(ANA, { limit: 10 }).items.map((m) => [m.keyId, m.type]),
    [["R1", "deleted"]],
    "the revoke stays as the placeholder; the target keeps only a content-free tombstone"
  );
  assert.equal(again.db.messages.get(sid, { includeHidden: true }).text, null);
  await again.stop();

  const second = arrive(ANA, "al doilea secret");
  sock.ev.emit("messages.delete", { keys: [{ remoteJid: ANA, fromMe: false, id: second }] });
  assert.equal(svc.hasMessage(`false_${ANA}_${second}`), false, "messages.delete drops it too");
});

test("a creds save that fails is logged, not left as an unhandled rejection", async () => {
  const { svc, sock } = setup();
  svc.saveCreds = () => Promise.reject(new Error("ENOSPC"));
  let unhandled = false;
  const spy = () => (unhandled = true);
  process.on("unhandledRejection", spy);
  try {
    sock.ev.emit("creds.update", {});
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(unhandled, false, "the rejection is caught and logged");
  } finally {
    process.off("unhandledRejection", spy);
  }
});

test("a storage failure inside a contact fold is logged, not thrown into the handler", async () => {
  const { svc, sock } = setup();
  const lid = "808080808080808@lid";
  const phone = "40700000008@s.whatsapp.net";
  svc.db.identity.setNote(lid, "nota sub lid");
  // A database that stopped answering: every write the handler tries fails.
  svc.storage.accountDb.close();
  let unhandled = false;
  const spy = () => (unhandled = true);
  process.on("unhandledRejection", spy);
  try {
    assert.doesNotThrow(() => sock.ev.emit("contacts.upsert", [{ id: phone, lid }]));
    assert.doesNotThrow(() => sock.ev.emit("lid-mapping.update", { lid, pn: phone }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled, false, "nothing rejects behind the handler either");
  } finally {
    process.off("unhandledRejection", spy);
  }
});

test("get_media refuses a file over the cap before touching the network", async () => {
  const { call, arrive } = setup();
  const id = arrive(ANA, {
    documentMessage: { mimetype: "video/mp4", fileLength: 250_000_000, fileName: "big.mp4" },
  });
  const res = await call("get_media", { message_id: `false_${ANA}_${id}` });
  assert.equal(textError(res).error, "FILE_TOO_LARGE");
});

test("in a group the note introduces the sender once, then the name alone", async () => {
  const { call, arrive } = setup();
  await call("remember", { chat_id: DAN, note: "Hermi" });
  const t = Date.now() - hour;
  arrive(GROUP, "sunt aici", { participant: DAN, at: t });
  arrive(GROUP, "și tu?", { participant: ANA, at: t + 10 * 60_000 });
  arrive(GROUP, "tot aici", { participant: DAN, at: t + 20 * 60_000 });
  const read = (await call("read_messages", { chat_id: GROUP })).content[0].text;
  assert.equal((read.match(/\*\*Dan · Hermi\*\*/g) || []).length, 1, "introduced once");
  assert.equal((read.match(/\*\*Dan\*\* ·/g) || []).length, 1, "then the name alone");
});
