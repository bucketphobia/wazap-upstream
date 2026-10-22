/**
 * Working by tag: what remember files shows wherever the person does, a tag
 * narrows list_chats and search to the people filed under it, several people
 * are filed in one call (all or none), and a detail's whole value finds its
 * person.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools, textError } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const ION = "40700000004@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const minute = 60_000;

function setup() {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-tags-", id: ME, name: "Răzvan" });
  const { call } = schemaCheckedTools(svc, { allowWrite: false, allowLocalEdits: true });
  let seq = 0;
  const arrive = (chat, text, { fromMe = false, participant, at = Date.now() } = {}) => {
    const id = `M${++seq}`;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) },
          message: { conversation: text },
          messageTimestamp: Math.floor(at / 1000),
        },
      ],
    });
    return id;
  };
  sock.ev.emit("contacts.upsert", [
    { id: ANA, name: "Ana" },
    { id: DAN, name: "Dan" },
    { id: ION, name: "Ion" },
  ]);
  return { svc, call, arrive };
}

test("remember files the same tags and details on several people in one call, or on none of them", async () => {
  const { svc, call, arrive } = setup();
  arrive(ANA, "salut");
  arrive(DAN, "salut");
  const filed = await call("remember", { chat_id: [ANA, "+40 700 000 003"], add_tags: ["#Client"], fields: { sursa: "crm" } });
  assert.equal(filed.isError, undefined);
  assert.deepEqual(filed.structuredContent.people.map((person) => person.chat_id), [ANA, DAN]);
  assert.match(filed.content[0].text, /Filed 2 people:\n- Ana \(\+40 700 000 002\) · #client\n- Dan \(\+40 700 000 003\) · #client/);
  assert.deepEqual(svc.db.identity.notes(DAN).fields, { sursa: "crm" });

  const refused = await call("remember", { chat_id: [ION, GROUP], add_tags: ["client"] });
  assert.equal(textError(refused).error, "INVALID_ID");
  assert.equal(svc.db.identity.notes(ION), null, "a group in the list files nobody");

  const noted = await call("remember", { chat_id: [ANA, DAN], note: "amândoi" });
  assert.equal(textError(noted).error, "INVALID_ID", "a note is for one person");
  assert.equal(svc.db.identity.notes(ANA).note, null);
});

test("a person's tags ride along in list_chats, read_messages, search and catch_up", async () => {
  const { call, arrive } = setup();
  arrive(ANA, "unde e mașina de schimb?", { at: Date.now() - 5 * minute });
  arrive(GROUP, "și eu aștept mașina", { participant: ANA, at: Date.now() - 4 * minute });
  await call("remember", { chat_id: ANA, add_tags: ["client", "autoturism"], note: "dosar deschis" });

  const chats = await call("list_chats", { filter: "individual" });
  assert.deepEqual(chats.structuredContent.chats[0].tags, ["autoturism", "client"]);
  assert.match(chats.content[0].text, /## Ana \(\+40 700 000 002\) · #autoturism #client · dosar deschis/);

  const read = await call("read_messages", { chat_id: ANA });
  assert.deepEqual(read.structuredContent.messages[0].sender.tags, ["autoturism", "client"]);
  assert.match(read.content[0].text, /Ana · #autoturism #client · dosar deschis/);

  const found = await call("search", { query: "mașina", match: "words" });
  assert.ok(found.structuredContent.messages.every((message) => message.sender.tags?.includes("client")));

  const caught = await call("catch_up", { hours: 24 });
  const waiting = caught.structuredContent.waiting.find((entry) => entry.chat === ANA);
  assert.deepEqual(waiting.tags, ["autoturism", "client"]);
  assert.match(caught.content[0].text, /Ana #autoturism #client \(dosar deschis\)/);
});

test("a tag narrows list_chats, newest first and paged, and its cursor holds on to that tag", async () => {
  const { call, arrive } = setup();
  arrive(ANA, "unu", { at: Date.now() - 30 * minute });
  arrive(DAN, "doi", { at: Date.now() - 20 * minute });
  arrive(ION, "trei", { at: Date.now() - 10 * minute });
  await call("remember", { chat_id: [ANA, ION], add_tags: ["client"] });

  const first = await call("list_chats", { tag: "#Client", limit: 1 });
  assert.deepEqual(first.structuredContent.chats.map((chat) => chat.chat_id), [ION]);
  assert.equal(first.structuredContent.tag, "#Client");
  assert.match(first.content[0].text, /# WhatsApp chats — all, tagged #Client \(1\)/);
  const second = await call("list_chats", { tag: "client", limit: 1, cursor: first.structuredContent.next_cursor });
  assert.deepEqual(second.structuredContent.chats.map((chat) => chat.chat_id), [ANA]);
  assert.equal(second.structuredContent.next_cursor, null);

  assert.equal(textError(await call("list_chats", { tag: "furnizor", cursor: first.structuredContent.next_cursor })).error, "INVALID_ID");
  assert.equal(textError(await call("list_chats", { cursor: first.structuredContent.next_cursor })).error, "INVALID_ID");
  assert.deepEqual((await call("list_chats", { tag: "furnizor" })).structuredContent.chats, []);
});

test("a tag narrows search to the direct chats of the people filed under it", async () => {
  const { call, arrive } = setup();
  arrive(ANA, "factura pentru dosar");
  arrive(DAN, "factura de la service");
  arrive(GROUP, "factura în grup", { participant: ANA });
  arrive(ANA, "am trimis factura", { fromMe: true });
  await call("remember", { chat_id: ANA, add_tags: ["client"] });

  const found = await call("search", { query: "factura", match: "words", tag: "client" });
  assert.deepEqual(found.structuredContent.messages.map((message) => message.text).sort(), ["am trimis factura", "factura pentru dosar"]);
  assert.match(found.content[0].text, /with people tagged client/);
  assert.equal(found.structuredContent.coverage.chats, 1);

  const nobody = await call("search", { query: "factura", match: "words", tag: "furnizor" });
  assert.deepEqual(nobody.structuredContent.messages, []);
});

test("find_contact resolves a detail's whole value, and lists a tag newest conversation first", async () => {
  const { call, arrive } = setup();
  arrive(ANA, "unu", { at: Date.now() - 30 * minute });
  arrive(DAN, "doi", { at: Date.now() - 10 * minute });
  arrive(ION, "trei", { at: Date.now() - 20 * minute });
  await call("remember", { chat_id: ION, fields: { caz: "AP-123" } });
  await call("remember", { chat_id: [ANA, DAN, ION], add_tags: ["client"] });

  const byCase = await call("find_contact", { name: "ap 123" });
  assert.equal(byCase.structuredContent.status, "resolved");
  assert.equal(byCase.structuredContent.contact.chat_id, ION);
  assert.equal(byCase.structuredContent.contact.matched.source, "field");
  assert.equal((await call("find_contact", { name: "AP" })).structuredContent.status, "not_found", "part of a value is not the value");

  const listed = await call("find_contact", { tag: "client" });
  assert.deepEqual(listed.structuredContent.contacts.map((person) => person.chat_id), [DAN, ION, ANA]);
});
