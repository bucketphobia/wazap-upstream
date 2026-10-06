/**
 * list_contacts: the phone's address book a page at a time — who is in it
 * (a saved name and a number, never a push name alone, a lid, a group, the
 * account or someone #private), the two orders, pages that neither skip nor
 * repeat anyone, several accounts, and an address book that has not arrived.
 * The integration's view of the same tool is test/integration-contract.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AccountHub } from "../dist/account-hub.js";
import { AccountRegistry } from "../dist/accounts.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, fakeSocket, offlineConfig, schemaCheckedTools } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const WORK_ME = "40700000002@s.whatsapp.net";
const ANA = "40722000001@s.whatsapp.net";
const BOGDAN = "40722000002@s.whatsapp.net";
const CARMEN = "40722000003@s.whatsapp.net";
const DAN = "40722000004@s.whatsapp.net";
const ELENA = "40722000005@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const LID = "123456789012345@lid";

const MINUTE = 60_000;

function service(prefix = "wazap-list-contacts-") {
  const { svc, sock } = connectedService(WhatsAppService, { prefix, id: ME, name: "Andrei" });
  svc.db.bindOwner(ME);
  return { svc, sock };
}

/** A message as the service stores it: `ago` minutes back, each its own key. */
let keys = 0;
function say(svc, chatJid, { fromMe = false, ago = 1, text = "salut", senderJid } = {}) {
  svc.db.messages.upsert({
    chatJid,
    keyId: `K${++keys}`,
    fromMe,
    ...(senderJid === undefined ? {} : { senderJid }),
    ts: Date.now() - ago * MINUTE,
    type: "text",
    text,
  });
}

/** The address book as WhatsApp delivers it after linking: one contact event per person, in this order. */
function addressBook(sock, entries) {
  sock.ev.emit("contacts.upsert", entries.map(([id, name]) => ({ id, name })));
}

async function everyPage(svc, query) {
  const seen = [];
  let cursor;
  for (let pages = 0; pages < 50; pages++) {
    const page = await svc.listContacts({ ...query, ...(cursor === undefined ? {} : { cursor }) });
    seen.push(...page.contacts.map((c) => c.chat_id));
    if (page.next === null) return seen;
    cursor = page.next;
  }
  assert.fail("the listing never ended");
}

test("only people the address book saved with a name and a number are listed: not a push name alone, a lid, a group, the account or someone #private", async (t) => {
  const { svc, sock } = service();
  t.after(() => svc.stop());
  addressBook(sock, [
    [ANA, "Ana Pop"],
    [ME, "Eu"],
    [LID, "Fara Numar"],
    [BOGDAN, "Bogdan"],
    [CARMEN, "+40 722 000 003"],
    [DAN, "Dan Privat"],
  ]);
  // Someone who only wrote, with a push name: WhatsApp's own contact event names them too.
  sock.ev.emit("contacts.update", [{ id: ELENA, notify: "Elena Pushname" }]);
  say(svc, ELENA, { text: "bună ziua" });
  // A group the account is in, with a message from Ana in it.
  say(svc, GROUP, { senderJid: ANA, text: "în grup" });
  await svc.updateContactDetails(DAN, { addTags: ["private"] });

  const page = await svc.listContacts({ order: "address_book", limit: 100 });
  assert.deepEqual(
    page.contacts.map((c) => c.chat_id),
    [ANA, BOGDAN],
    "Ana and Bogdan; not the account, a lid, a name that is only a number, someone #private, a push name or a group"
  );
  assert.equal(page.total, 2);
  assert.equal(page.address_book_synced, true);
  assert.deepEqual(page.contacts[0], {
    name: "Ana Pop",
    phone: "+40722000001",
    chat_id: ANA,
    contact_id: svc.db.identity.contactIdOf(ANA),
    last_message: null,
  });
  assert.equal(page.contacts[0].last_message, null, "a group message from her is not a direct chat");
});

test("recent puts the latest direct chat first and the rest in the address book's order; address_book is that order alone", async (t) => {
  const { svc, sock } = service();
  t.after(() => svc.stop());
  addressBook(sock, [
    [ANA, "Ana"],
    [BOGDAN, "Bogdan"],
    [CARMEN, "Carmen"],
    [DAN, "Dan"],
    [ELENA, "Elena"],
  ]);
  say(svc, CARMEN, { ago: 60 });
  say(svc, DAN, { ago: 5, fromMe: true, text: "te aștept" });
  say(svc, DAN, { ago: 30 });

  const recent = await svc.listContacts({ order: "recent", limit: 100 });
  assert.deepEqual(recent.contacts.map((c) => c.chat_id), [DAN, CARMEN, ANA, BOGDAN, ELENA]);
  const dan = recent.contacts[0];
  assert.equal(dan.last_message.direction, "out", "the newest message decides the direction");
  assert.match(dan.last_message.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, "ISO 8601 with the offset, as every other time");
  assert.ok(Math.abs(Date.parse(dan.last_message.at) - (Date.now() - 5 * MINUTE)) < 5_000, "the newest message's time");
  assert.equal(recent.contacts[1].last_message.direction, "in");

  const book = await svc.listContacts({ order: "address_book", limit: 100 });
  assert.deepEqual(book.contacts.map((c) => c.chat_id), [ANA, BOGDAN, CARMEN, DAN, ELENA]);
  assert.equal(book.contacts[3].last_message.direction, "out", "the same last message, in either order");
});

test("pages give everyone once, in order, and someone who writes between two pages is not skipped", async (t) => {
  const { svc, sock } = service();
  t.after(() => svc.stop());
  const people = Array.from({ length: 11 }, (_, i) => [`4072210${String(i).padStart(4, "0")}@s.whatsapp.net`, `Client ${i}`]);
  addressBook(sock, people);
  // Half of them talked, at distinct times; the others never did.
  people.forEach(([jid], i) => {
    if (i % 2 === 0) say(svc, jid, { ago: 100 - i });
  });
  for (const order of ["recent", "address_book"]) {
    const whole = (await svc.listContacts({ order, limit: 500 })).contacts.map((c) => c.chat_id);
    assert.equal(whole.length, 11);
    assert.deepEqual(await everyPage(svc, { order, limit: 3 }), whole, `${order}: the pages are the whole list, in order`);
  }

  // Page one of recent, then the oldest talker writes: they would jump to the front, past the cursor.
  const first = await svc.listContacts({ order: "recent", limit: 3 });
  assert.equal(first.total, 11);
  const wholeBefore = (await svc.listContacts({ order: "recent", limit: 500 })).contacts.map((c) => c.chat_id);
  const oldest = wholeBefore[5];
  assert.ok(!first.contacts.some((c) => c.chat_id === oldest));
  say(svc, oldest, { ago: 0 });
  const rest = [];
  let cursor = first.next;
  while (cursor !== null) {
    const page = await svc.listContacts({ order: "recent", limit: 3, cursor });
    rest.push(...page.contacts);
    cursor = page.next;
  }
  const seen = [...first.contacts, ...rest].map((c) => c.chat_id);
  assert.deepEqual(seen, wholeBefore, "the pages read the conversations as the first page saw them");
  const late = rest.find((c) => c.chat_id === oldest);
  assert.ok(Date.parse(late.last_message.at) < Date.now() - 50 * MINUTE, "the message after the first page does not count in this listing");
  const fresh = await svc.listContacts({ order: "recent", limit: 1 });
  assert.equal(fresh.contacts[0].chat_id, oldest, "a new listing puts them first");
});

test("a cursor from another order, another account or nowhere is refused as INVALID_ID", async (t) => {
  const { svc, sock } = service();
  t.after(() => svc.stop());
  addressBook(sock, [
    [ANA, "Ana"],
    [BOGDAN, "Bogdan"],
  ]);
  const first = await svc.listContacts({ order: "recent", limit: 1 });
  await assert.rejects(svc.listContacts({ order: "address_book", limit: 1, cursor: first.next }), (err) => err.code === "INVALID_ID" && /order recent/.test(err.message));
  await assert.rejects(svc.listContacts({ order: "recent", limit: 1, cursor: "not-a-cursor" }), (err) => err.code === "INVALID_ID");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(first.next, "base64url").toString()), a: "work" })).toString("base64url");
  await assert.rejects(svc.listContacts({ order: "recent", limit: 1, cursor: forged }), (err) => err.code === "INVALID_ID" && /account work/.test(err.message));
});

test("an address book that has not arrived says so, and push names alone do not count as its arrival", async (t) => {
  const { svc, sock } = service();
  t.after(() => svc.stop());
  say(svc, ANA, { text: "salut" });
  sock.ev.emit("contacts.update", [{ id: ANA, notify: "Ana" }]);
  const none = await svc.listContacts({ order: "recent", limit: 10 });
  assert.deepEqual(none, { contacts: [], total: 0, next: null, address_book_synced: false, sync: "done" });

  const { call } = schemaCheckedTools(svc);
  const answer = await call("list_contacts", {});
  assert.equal(answer.structuredContent.address_book_synced, false);
  assert.match(answer.content[0].text, /has not reached wazap yet/);

  addressBook(sock, [[ANA, "Ana Pop"]]);
  const arrived = await svc.listContacts({ order: "recent", limit: 10 });
  assert.equal(arrived.address_book_synced, true);
  assert.equal(arrived.contacts[0].last_message.direction, "in");
});

test("the tool answers metadata and no message words, with defaults, and the account it read", async (t) => {
  const { svc, sock } = service();
  t.after(() => svc.stop());
  addressBook(sock, [
    [ANA, "Ana Pop"],
    [BOGDAN, "Bogdan"],
  ]);
  say(svc, ANA, { text: "parola de la poartă e 4321" });
  const { call } = schemaCheckedTools(svc);
  const answer = await call("list_contacts", {});
  assert.equal(answer.isError, undefined);
  const body = answer.structuredContent;
  assert.equal(body.order, "recent");
  assert.equal(body.count, 2);
  assert.equal(body.total, 2);
  assert.equal(body.next, null);
  assert.equal(body.account_id, "default");
  const all = JSON.stringify(answer);
  assert.doesNotMatch(all, /parola|4321/, "never a word of a message");
  assert.match(answer.content[0].text, /^# Address book — recent \(2 of 2\)\n- Ana Pop — \+40722000001 · last in \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n- Bogdan — \+40722000002 · no chat$/);

  const refused = await call("list_contacts", { cursor: "nope" });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error, "INVALID_ID", "no output schema: a refusal keeps its structured error");
});

test("it reads the stored address book while the link is down, and an account that is not linked is told so", async (t) => {
  const { svc, sock } = service();
  t.after(() => svc.stop());
  addressBook(sock, [[ANA, "Ana"]]);
  svc.status = "disconnected";
  assert.equal((await svc.listContacts({ order: "recent", limit: 10 })).total, 1);
  svc.status = "not_linked";
  await assert.rejects(svc.listContacts({ order: "recent", limit: 10 }), (err) => err.code === "NOT_LINKED");
  svc.status = "logged_out";
  await assert.rejects(svc.listContacts({ order: "recent", limit: 10 }), (err) => err.code === "SESSION_EXPIRED");
});

test("with several accounts each lists its own address book, the default without account_id, and #private on one holds on the other", async (t) => {
  const config = offlineConfig("wazap-list-contacts-hub-", { readOnly: false });
  AccountRegistry.load(config.dataDir).add("work", "Work");
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  t.after(() => hub.stop());
  const connect = (svc, id) => {
    const sock = fakeSocket();
    svc.sockClient = sock;
    svc.wireEvents(sock, ++svc.generation);
    svc.account = { id, name: "Andrei", number: id.split("@")[0] };
    svc.status = "connected";
    svc.initialSyncDone = true;
    return sock;
  };
  const home = hub.get("default");
  const work = hub.get("work");
  addressBook(connect(home, ME), [
    [ANA, "Ana Pop"],
    [BOGDAN, "Bogdan"],
  ]);
  addressBook(connect(work, WORK_ME), [
    [CARMEN, "Carmen Contabil"],
    [BOGDAN, "Bogdan Furnizor"],
  ]);
  say(work, CARMEN, { fromMe: true });
  // Ana is #private on the work account: she stays out of the home account's list too.
  work.db.identity.upsertContact({ jid: ANA, pushName: "Ana" });
  await work.updateContactDetails(ANA, { addTags: ["private"] });

  const { call } = schemaCheckedTools(hub);
  const homeList = (await call("list_contacts", {})).structuredContent;
  assert.equal(homeList.account_id, "default");
  assert.deepEqual(homeList.contacts.map((c) => [c.name, c.chat_id]), [["Bogdan", BOGDAN]]);

  const workList = (await call("list_contacts", { account_id: "work", order: "recent", limit: 1 })).structuredContent;
  assert.equal(workList.account_id, "work");
  assert.equal(workList.total, 2);
  assert.deepEqual(workList.contacts.map((c) => [c.name, c.last_message?.direction]), [["Carmen Contabil", "out"]]);
  assert.equal(
    (await call("list_contacts", { account_id: "default", order: "recent", limit: 1, cursor: workList.next })).structuredContent.error,
    "INVALID_ID",
    "a cursor of another account"
  );
  const next = (await call("list_contacts", { account_id: "work", order: "recent", limit: 1, cursor: workList.next })).structuredContent;
  assert.deepEqual(next.contacts.map((c) => c.name), ["Bogdan Furnizor"]);
  assert.equal(next.next, null);
});
