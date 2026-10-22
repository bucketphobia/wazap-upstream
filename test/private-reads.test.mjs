/**
 * `#private` in the broad reads (src/private-contacts.ts): someone the user
 * tagged so has their words reach the assistant only when a call names them —
 * their chat, a message of theirs, them as the author — and a group named by
 * chat_id reads whole. Driven through the registered tools, each answer
 * checked against its output schema the way an SDK client checks it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const ELA = "40700000004@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const MINUTE = 60_000;

function account({ id = ME, name = "Răzvan", record } = {}) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-private-", id, name, ...(record ? { account: record } : {}) });
  sock.ev.emit("contacts.upsert", [
    { id: ANA, name: "Ana" },
    { id: DAN, name: "Dan" },
    { id: ELA, name: "Ela" },
  ]);
  sock.ev.emit("chats.upsert", [{ id: GROUP, name: "Echipa" }]);
  let seq = 0;
  const arrive = (chat, content, { fromMe = false, participant, at } = {}) => {
    const key = `M${++seq}`;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: chat, fromMe, id: key, ...(participant ? { participant } : {}) },
          message: typeof content === "string" ? { conversation: content } : content,
          messageTimestamp: Math.floor(at / 1000),
        },
      ],
    });
    return `${fromMe}_${chat}_${key}`;
  };
  return { svc, sock, arrive };
}

const everything = (result) => `${result.content.map((block) => block.text ?? "").join("\n")}\n${JSON.stringify(result.structuredContent)}`;
const keyOf = (id) => id.split("_").pop();

test("search without a chat leaves out a #private person's chat and what they write in groups before its limit, counts them, and names them on request", async () => {
  const { svc, arrive } = account();
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  const at = Date.now() - 60 * MINUTE;
  // Newest first: private, public, private, public, public, private, public, public, then two older public ones.
  const theirs = arrive(ANA, "factura pentru terapie", { at: at + 10 * MINUTE });
  arrive(DAN, "factura de la service", { at: at + 9 * MINUTE });
  arrive(ANA, "factura ți-o trimit mâine", { fromMe: true, at: at + 8 * MINUTE });
  arrive(GROUP, "factura comună e plătită", { participant: DAN, at: at + 7 * MINUTE });
  const reply = arrive(
    GROUP,
    { extendedTextMessage: { text: "am văzut factura", contextInfo: { stanzaId: "Q1", participant: ANA, quotedMessage: { conversation: "diagnosticul meu, pe scurt" } } } },
    { participant: ELA, at: at + 6 * MINUTE }
  );
  const inGroup = arrive(GROUP, "factura de la clinică o plătesc eu", { participant: ANA, at: at + 5 * MINUTE });
  arrive(ELA, "factura la curent", { at: at + 4 * MINUTE });
  arrive(DAN, "factura veche", { at: at + 3 * MINUTE });
  arrive(ELA, "factura din august", { at: at + 2 * MINUTE });
  arrive(DAN, "factura din iulie", { at: at + MINUTE });
  svc.db.identity.updateFields(ANA, { addTags: ["private"] });

  const broad = await call("search", { query: "factura", match: "words", limit: 5 });
  assert.equal(broad.structuredContent.count, 5, "the limit counts what is shown");
  assert.equal(broad.structuredContent.private_omitted, 3);
  assert.ok(broad.structuredContent.messages.every((m) => m.chat_id !== ANA && m.sender.id !== ANA), "no entry of hers, not even without words");
  for (const words of ["terapie", "mâine", "clinică", "diagnosticul"]) assert.ok(!everything(broad).includes(words), words);
  const quoted = broad.structuredContent.messages.find((m) => m.message_id === reply);
  assert.deepEqual([quoted.text, quoted.quoted.text, quoted.quoted.sender], ["am văzut factura", "[private]", ANA], "a quote of hers keeps who, not what");
  assert.match(broad.content[0].text, /3 matches from people tagged #private left out: name the chat \(chat_id\) or the person \(from\) to search them\./);
  assert.match((broad.structuredContent.notes ?? []).join(" "), /3 matches from people tagged #private left out/, "said in the structured content too");
  const fallback = await call("search", { query: "factura", limit: 5 });
  assert.equal(fallback.structuredContent.mode, "keyword_fallback", "meaning search is off here");
  assert.deepEqual([fallback.structuredContent.count, fallback.structuredContent.private_omitted], [5, 3], "the fallback holds the same rule");
  assert.match((fallback.structuredContent.notes ?? []).join(" "), /words only[\s\S]*#private left out/);

  const chat = await call("search", { query: "factura", match: "words", chat_id: ANA });
  assert.deepEqual(chat.structuredContent.messages.map((m) => m.text).sort(), ["factura pentru terapie", "factura ți-o trimit mâine"]);
  assert.equal(chat.structuredContent.private_omitted, undefined);
  assert.doesNotMatch((chat.structuredContent.notes ?? []).join(" "), /#private/);
  const author = await call("search", { query: "factura", match: "words", from: ANA });
  assert.deepEqual(author.structuredContent.messages.map((m) => m.message_id).sort(), [inGroup, theirs].sort());
  assert.equal(author.structuredContent.private_omitted, undefined);
  const group = await call("search", { query: "factura", match: "words", chat_id: GROUP });
  assert.ok(group.structuredContent.messages.some((m) => m.message_id === inGroup), "a group named by chat_id reads whole");
  assert.equal(group.structuredContent.messages.find((m) => m.message_id === reply).quoted.text, "diagnosticul meu, pe scurt");

  svc.db.identity.updateFields(ANA, { removeTags: ["private"] });
  const untagged = await call("search", { query: "factura", match: "words", limit: 5 });
  assert.deepEqual(untagged.structuredContent.messages.map((m) => keyOf(m.message_id)), ["M1", "M2", "M3", "M4", "M5"]);
  assert.equal(untagged.structuredContent.private_omitted, undefined);
});

test("search from one #private person shows what they wrote, and a quote of another one still without its words", async () => {
  const { svc, arrive } = account();
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  const at = Date.now() - 10 * MINUTE;
  const asked = arrive(GROUP, "am nevoie de un împrumut pentru chirie", { participant: ELA, at });
  arrive(
    GROUP,
    { extendedTextMessage: { text: "chiria o plătesc eu luna asta", contextInfo: { stanzaId: keyOf(asked), participant: ELA, quotedMessage: { conversation: "am nevoie de un împrumut pentru chirie" } } } },
    { participant: ANA, at: at + MINUTE }
  );
  arrive(
    GROUP,
    { extendedTextMessage: { text: "chiria rămâne cum am zis", contextInfo: { stanzaId: "Q2", participant: ANA, quotedMessage: { conversation: "am vorbit cu proprietarul" } } } },
    { participant: ANA, at: at + 2 * MINUTE }
  );
  svc.db.identity.updateFields(ANA, { addTags: ["private"] });
  svc.db.identity.updateFields(ELA, { addTags: ["private"] });

  const result = await call("search", { query: "chiria", match: "words", from: ANA });
  assert.deepEqual(
    result.structuredContent.messages.map((m) => [m.text, m.quoted.sender, m.quoted.text]),
    [
      ["chiria rămâne cum am zis", ANA, "am vorbit cu proprietarul"],
      ["chiria o plătesc eu luna asta", ELA, "[private]"],
    ],
    "hers are named, Ela's are not"
  );
  assert.ok(!everything(result).includes("împrumut"));
});

test("wait_for_messages without a chat keeps what arrived from someone #private without their words, in their chat and in a group; waiting on a chat, theirs or a group's, reads it whole", async () => {
  const { svc, arrive } = account();
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  svc.db.identity.updateFields(ANA, { addTags: ["private"] });
  const { cursor } = (await call("wait_for_messages", { timeout_seconds: 1 })).structuredContent;
  const at = Date.now();
  const direct = arrive(ANA, "rezultatele de la analize au ieșit prost", { at: at - 4000 });
  const photo = arrive(ANA, { imageMessage: { mimetype: "image/jpeg", caption: "radiografia mea", fileLength: 2048 } }, { at: at - 3000 });
  const inGroup = arrive(GROUP, "nu spuneți nimănui de divorț", { participant: ANA, at: at - 2000 });
  const reply = arrive(
    GROUP,
    { extendedTextMessage: { text: "te sun diseară", contextInfo: { stanzaId: keyOf(inGroup), participant: ANA, quotedMessage: { conversation: "nu spuneți nimănui de divorț" } } } },
    { participant: DAN, at: at - 1000 }
  );

  const broad = await call("wait_for_messages", { timeout_seconds: 1, cursor });
  const all = everything(broad);
  for (const words of ["analize", "radiografia", "divorț"]) assert.ok(!all.includes(words), words);
  const byId = new Map(broad.structuredContent.messages.map((m) => [m.message_id, m]));
  assert.deepEqual([...byId.keys()], [direct, photo, inGroup, reply], "every arrival stays: something came from her");
  assert.deepEqual(
    [direct, photo, inGroup].map((id) => [byId.get(id).text, byId.get(id).private, byId.get(id).sender.name]),
    [
      ["[private]", true, "Ana"],
      ["[private]", true, "Ana"],
      ["[private]", true, "Ana"],
    ]
  );
  assert.deepEqual([byId.get(photo).type, byId.get(photo).media], ["image", { mime: "image/jpeg", size: 2048 }], "what kind stays");
  assert.deepEqual([byId.get(reply).text, byId.get(reply).private, byId.get(reply).quoted.text], ["te sun diseară", undefined, "[private]"]);
  assert.match(broad.content[0].text, /Ana: \[private\]/);

  const group = await call("wait_for_messages", { timeout_seconds: 1, cursor, chat_id: GROUP });
  assert.deepEqual(
    group.structuredContent.messages.map((m) => [m.message_id, m.text, m.private, m.quoted?.text]),
    [
      [inGroup, "nu spuneți nimănui de divorț", undefined, undefined],
      [reply, "te sun diseară", undefined, "nu spuneți nimănui de divorț"],
    ],
    "a group named by chat_id reads whole, her words included"
  );
  const theirs = await call("wait_for_messages", { timeout_seconds: 1, cursor, chat_id: ANA });
  assert.deepEqual(
    theirs.structuredContent.messages.map((m) => [m.text, m.private]),
    [
      ["rezultatele de la analize au ieșit prost", undefined],
      ["[image] radiografia mea", undefined],
    ],
    "waiting on her chat asks for her by name"
  );
});

test("list_chats shows the last message of a #private person's chat, and theirs in a group, without its words; reading the chat by name shows them", async () => {
  const { svc, sock, arrive } = account();
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  sock.ev.emit("chats.upsert", [{ id: "120363000000000002@g.us", name: "Vecini" }]);
  const at = Date.now() - 10 * MINUTE;
  arrive(ANA, "ai găsit avocat?", { at });
  arrive(ANA, "îți trimit banii pentru avocat mâine", { fromMe: true, at: at + MINUTE });
  arrive(GROUP, "ok, vin", { participant: DAN, at: at + 2 * MINUTE });
  arrive(GROUP, "am pierdut sarcina, nu mai vin", { participant: ANA, at: at + 3 * MINUTE });
  arrive("120363000000000002@g.us", "cine a lăsat ușa deschisă?", { participant: ANA, at: at + 4 * MINUTE });
  arrive("120363000000000002@g.us", "eu, scuze", { participant: ELA, at: at + 5 * MINUTE });
  arrive(DAN, "factura e plătită", { at: at + 6 * MINUTE });
  svc.db.identity.updateFields(ANA, { addTags: ["private"] });

  const listed = await call("list_chats", {});
  const all = everything(listed);
  for (const words of ["avocat", "sarcina"]) assert.ok(!all.includes(words), words);
  const last = new Map(listed.structuredContent.chats.map((chat) => [chat.chat_id, chat.last_message]));
  assert.deepEqual(last.get(ANA), { text: "[private]", timestamp: last.get(ANA).timestamp, from_me: true, private: true }, "her chat, the user's own words in it too");
  assert.deepEqual([last.get(GROUP).text, last.get(GROUP).private], ["[private]", true], "what she wrote last in a group");
  assert.deepEqual([last.get("120363000000000002@g.us").text, last.get("120363000000000002@g.us").private], ["eu, scuze", undefined]);
  assert.deepEqual([last.get(DAN).text, last.get(DAN).private], ["factura e plătită", undefined]);
  assert.match(listed.content[0].text, /## Ana \(\+40 700 000 002\) · #private\n- \*\*chat_id\*\*: `40700000002@s\.whatsapp\.net`\n- \*\*last\*\*: me: \[private\] \(/);

  const read = await call("read_messages", { chat_id: ANA });
  assert.deepEqual(read.structuredContent.messages.map((m) => m.text), ["ai găsit avocat?", "îți trimit banii pentru avocat mâine"], "named, her chat reads whole");
  const group = await call("read_messages", { chat_id: GROUP });
  assert.ok(group.structuredContent.messages.some((m) => m.text === "am pierdut sarcina, nu mai vin"), "a group named reads whole");
});

test("the stories of someone #private keep their author, time and kind, without text, caption or preview", async () => {
  const { svc, sock } = account();
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
  let seq = 0;
  const story = (author, message, at) =>
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{ key: { remoteJid: "status@broadcast", fromMe: false, id: `S${++seq}`, participant: author }, message, messageTimestamp: Math.floor(at / 1000) }],
    });
  const at = Date.now() - 30 * MINUTE;
  story(ANA, { extendedTextMessage: { text: "prima zi după operație" } }, at);
  story(ANA, { imageMessage: { mimetype: "image/jpeg", caption: "salonul de la oncologie", jpegThumbnail: jpeg } }, at + MINUTE);
  story(DAN, { imageMessage: { mimetype: "image/jpeg", caption: "la munte", jpegThumbnail: jpeg } }, at + 2 * MINUTE);
  svc.db.identity.updateFields(ANA, { addTags: ["private"] });

  const result = await call("read_messages", { chat_id: "status", include_previews: true });
  const all = everything(result);
  for (const words of ["operație", "oncologie"]) assert.ok(!all.includes(words), words);
  assert.deepEqual(
    result.structuredContent.messages.map((m) => [m.sender.name, m.type, m.text, m.private]),
    [
      ["Dan", "image", "[image] la munte", undefined],
      ["Ana", "image", "[private]", true],
      ["Ana", "text", "[private]", true],
    ]
  );
  assert.equal(result.structuredContent.preview_count, 1, "Dan's photo only");
  assert.equal(result.content.filter((block) => block.type === "image").length, 1);
  assert.match(result.content[0].text, /1 preview attached/);
  assert.doesNotMatch(result.content[0].text, /without a preview/, "hers is not a photo that failed");
  assert.match(result.content[0].text, /## Ana \(\+40 700 000 002\)\n- \d+m ago · \[private\] · id: /);
  const images = await call("read_messages", { chat_id: "status", types: ["image"] });
  assert.equal(images.structuredContent.count, 2, "what kind stays: types still finds hers");
});

function hubOf(...accounts) {
  const bindings = accounts.map(({ id, svc }) => ({ id, wa: svc }));
  const records = accounts.map(({ id, name }) => ({ id, name, enabled: true, owner: null }));
  return {
    binding: (id) => bindings.find((binding) => binding.id === id),
    defaultBinding: () => bindings[0],
    bindings: () => bindings,
    findByChat: (jid) => bindings.filter((binding) => binding.wa.hasChat(jid)),
    findByMessage: (id) => bindings.filter((binding) => binding.wa.hasMessage(id)),
    findByDraft: () => [],
    record: (id) => records.find((record) => record.id === id),
    records: () => records,
    recordOnDisk: (id) => records.find((record) => record.id === id),
    reload: () => {},
    noteOwner: () => {},
  };
}

test("with several accounts, #private filed on one account holds in every broad read of another, by number or by lid", async () => {
  const personal = account({ record: { id: "personal", name: "Personal", enabled: true, owner: null } });
  const work = account({ id: "40700000099@s.whatsapp.net", name: "Andrei", record: { id: "work", name: "Business", enabled: true, owner: null } });
  const { call } = schemaCheckedTools(hubOf({ id: "personal", name: "Personal", svc: personal.svc }, { id: "work", name: "Business", svc: work.svc }), { allowWrite: false });
  const LID = "555666777888999@lid";
  personal.svc.db.identity.updateFields(ANA, { addTags: ["private"] });
  personal.svc.db.identity.updateFields(LID, { addTags: ["private"] });
  // The business account knows that lid as Dan's.
  await work.svc.db.learnLidPhone(LID, DAN);
  const { cursor } = (await call("wait_for_messages", { account_id: "work", timeout_seconds: 1 })).structuredContent;
  const at = Date.now() - 10 * MINUTE;
  work.arrive(ANA, "factura pentru avocat", { at });
  work.arrive(GROUP, "factura de la psiholog", { participant: DAN, at: at + MINUTE });
  work.arrive(ELA, "factura de curent", { at: at + 2 * MINUTE });
  work.sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: "status@broadcast", fromMe: false, id: "S1", participant: ANA }, message: { conversation: "concediu medical" }, messageTimestamp: Math.floor((at + 3 * MINUTE) / 1000) }],
  });

  const found = await call("search", { account_id: "work", query: "factura", match: "words" });
  assert.equal(found.structuredContent.account_id, "work");
  assert.deepEqual([found.structuredContent.messages.map((m) => m.chat_id), found.structuredContent.private_omitted], [[ELA], 2]);
  const chats = await call("list_chats", { account_id: "work" });
  const last = new Map(chats.structuredContent.chats.map((chat) => [chat.chat_id, chat.last_message]));
  assert.deepEqual([last.get(ANA).private, last.get(GROUP).private, last.get(ELA).private], [true, true, undefined]);
  const waited = await call("wait_for_messages", { account_id: "work", timeout_seconds: 1, cursor });
  assert.deepEqual(waited.structuredContent.messages.map((m) => [m.chat_id, m.private]), [[ANA, true], [GROUP, true], [ELA, undefined]]);
  const stories = await call("read_messages", { account_id: "work", chat_id: "status" });
  assert.deepEqual(stories.structuredContent.messages.map((m) => [m.text, m.private]), [["[private]", true]]);
  for (const result of [found, chats, waited, stories]) {
    for (const words of ["avocat", "psiholog", "medical"]) assert.ok(!everything(result).includes(words), words);
  }

  const named = await call("search", { account_id: "work", query: "factura", match: "words", from: DAN });
  assert.deepEqual(named.structuredContent.messages.map((m) => m.text), ["factura de la psiholog"], "from names him");
});
