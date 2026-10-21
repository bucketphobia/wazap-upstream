/**
 * Who wrote it. A group sender used to surface as a bare LID — fifteen digits
 * that read as a phone number and are not one — and an agent could not tell a
 * saved contact's name from the name a stranger publishes. These pin the
 * sender contract the read tools report: id, phone, contact_name, pushname.
 */
import { test } from "node:test";
import assert from "node:assert/strict";


import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools, textError } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const VLAD = "40700000004@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
// LIDs the group's metadata pairs with numbers, and one it never does.
const LID_DAN = "999888777666555@lid";
const LID_VLAD = "111000111000111@lid";
const LID_NOBODY = "4226298167515@lid";

function setup() {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-senderid-", id: ME, name: "Răzvan" });
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  let seq = 0;
  const arrive = (chat, text, { fromMe = false, participant, pushName, at = Date.now() } = {}) => {
    const id = `M${++seq}`;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) },
          message: { conversation: text },
          messageTimestamp: Math.floor(at / 1000),
          ...(pushName ? { pushName } : {}),
        },
      ],
    });
    return id;
  };
  return { svc, sock, call, arrive };
}

/** A group whose metadata pairs two lids and leaves a third unpaired. */
function stubGroupMetadata(svc) {
  let fetches = 0;
  svc.sockClient.groupMetadata = async (id) => {
    fetches++;
    return {
      id,
      subject: "Echipa",
      participants: [
        { id: ME },
        { id: LID_DAN, phoneNumber: DAN },
        { id: LID_VLAD, phoneNumber: VLAD },
        { id: LID_NOBODY },
      ],
    };
  };
  return () => fetches;
}

test("search resolves a group's senders — number, address-book name, pushname — and never a bare lid", async () => {
  const { svc, sock, call, arrive } = setup();
  sock.ev.emit("contacts.upsert", [
    { id: ANA, name: "Ana" },
    { id: DAN, name: "Dan" },
  ]);
  const fetches = stubGroupMetadata(svc);
  arrive(GROUP, "rulajul e gata", { participant: LID_DAN, pushName: "danu" });
  arrive(GROUP, "rulaj și la mine", { participant: LID_VLAD, pushName: "Vlăduț" });
  arrive(GROUP, "rulaj de la nimeni", { participant: LID_NOBODY });

  const result = await call("search", { match: "words", query: "rulaj", chat_id: GROUP });
  const byText = new Map(result.structuredContent.messages.map((m) => [m.text, m.sender]));
  assert.equal(result.structuredContent.count, 3);

  const dan = byText.get("rulajul e gata");
  assert.equal(dan.id, DAN, "the lid resolved to the person once the metadata paired it");
  assert.equal(dan.phone, "40700000003");
  assert.equal(dan.name, "Dan");
  assert.equal(dan.is_saved, true);
  assert.equal(dan.name_source, "contact");
  assert.equal(dan.contact_name, "Dan", "the saved address-book name");
  assert.equal(dan.pushname, null, "a saved contact's own pushname stays out of the way");

  const vlad = byText.get("rulaj și la mine");
  assert.equal(vlad.id, VLAD);
  assert.equal(vlad.phone, "40700000004");
  assert.equal(vlad.is_saved, false, "not in the address book — the name is his claim");
  assert.equal(vlad.name_source, "pushname");
  assert.equal(vlad.contact_name, null, "not in the address book");
  assert.equal(vlad.pushname, "Vlăduț", "the name he publishes is what shows");

  const nobody = byText.get("rulaj de la nimeni");
  assert.equal(nobody.id, LID_NOBODY, "WhatsApp never paired this lid — the id stays honest about it");
  assert.equal(nobody.phone, null);
  assert.equal(nobody.name, "unknown (lid …7515)", "reads as unknown, not as digits posing as a number");
  assert.equal(nobody.is_saved, false);
  assert.equal(nobody.name_source, "none");
  assert.equal(nobody.contact_name, null);
  assert.equal(nobody.pushname, null);

  assert.equal(fetches(), 1, "one metadata fetch taught every sender in the group");
  assert.equal(result.structuredContent.freshness.sync, "done", "the freshness block rides along");
});

test("get_message reports the same identity fields", async () => {
  const { sock, call, arrive } = setup();
  sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Ana" }]);
  const id = arrive(ANA, "mesajul cu pricina");
  const result = await call("get_message", { message_id: `false_${ANA}_${id}` });
  const sender = result.structuredContent.sender;
  assert.equal(sender.id, ANA);
  assert.equal(sender.phone, "40700000002");
  assert.equal(sender.contact_name, "Ana");
  assert.equal(sender.pushname, null);
});

test("a lid that resolves only after the search still comes back as the person", async () => {
  const { svc, sock, call, arrive } = setup();
  sock.ev.emit("contacts.upsert", [{ id: DAN, name: "Dan" }]);
  stubGroupMetadata(svc);
  // The message landed under the lid before anything paired it.
  const id = arrive(GROUP, "cine mai vine?", { participant: LID_DAN });

  const result = await call("get_message", { message_id: `false_${GROUP}_${id}` });
  const sender = result.structuredContent.sender;
  assert.equal(sender.id, DAN);
  assert.equal(sender.contact_name, "Dan");
});

test("the `from` filter takes a name when it picks out exactly one person", async () => {
  const { sock, call, arrive } = setup();
  sock.ev.emit("contacts.upsert", [
    { id: ANA, name: "Ana" },
    { id: DAN, name: "Dan" },
  ]);
  arrive(ANA, "salut de la ana");
  arrive(DAN, "salut de la dan");

  const result = await call("search", { match: "words", query: "salut", from: "ana" });
  assert.equal(result.structuredContent.from_resolved, ANA);
  assert.deepEqual(
    result.structuredContent.messages.map((m) => m.sender.id),
    [ANA]
  );
});

test("the `from` filter also finds a person only ever known by pushname", async () => {
  const { call, arrive } = setup();
  // Carmen never landed in the address book — the pushname her messages carry
  // is all wazap has, and it is what her one-to-one chat is called.
  const CARMEN = "40700000005@s.whatsapp.net";
  arrive(CARMEN, "salut de la carmen", { pushName: "Carmen" });
  arrive(ANA, "salut de la ana");

  const result = await call("search", { match: "words", query: "salut", from: "carmen" });
  assert.equal(result.structuredContent.from_resolved, CARMEN);
  assert.deepEqual(
    result.structuredContent.messages.map((m) => m.sender.id),
    [CARMEN]
  );
});

test("an ambiguous `from` names its candidates, an unknown one says so", async () => {
  const { sock, call, arrive } = setup();
  sock.ev.emit("contacts.upsert", [
    { id: ANA, name: "Maria Pop" },
    { id: DAN, name: "Maria Ion" },
  ]);
  arrive(ANA, "salut");

  const ambiguous = await call("search", { match: "words", query: "salut", from: "maria" });
  assert.equal(textError(ambiguous).error, "INVALID_ID");
  assert.match(textError(ambiguous).message, /Maria Pop/);
  assert.match(textError(ambiguous).message, /Maria Ion/);

  const unknown = await call("search", { match: "words", query: "salut", from: "Nimeni" });
  assert.equal(textError(unknown).error, "CONTACT_NOT_FOUND");
});

test("a sender with no name at all shows the number, source none", async () => {
  const { call, arrive } = setup();
  const STRANGER = "40700000009@s.whatsapp.net";
  arrive(STRANGER, "cine e asta");
  const result = await call("search", { match: "words", query: "cine e asta" });
  const sender = result.structuredContent.messages[0].sender;
  assert.equal(sender.name, "40700000009", "the digits are a number, not a name");
  assert.equal(sender.phone, "40700000009");
  assert.equal(sender.is_saved, false);
  assert.equal(sender.name_source, "none");
  assert.equal(sender.contact_name, null);
  assert.equal(sender.pushname, null);
});

test("the user's own messages carry the same triplet, honestly unnamed", async () => {
  const { call, arrive } = setup();
  arrive(ANA, "salut", { fromMe: true });
  const result = await call("search", { match: "words", query: "salut" });
  const sender = result.structuredContent.messages[0].sender;
  assert.equal(sender.name, "Răzvan", "the account's own name");
  assert.equal(sender.is_saved, false, "the user is not a saved contact of themselves");
  assert.equal(sender.name_source, "none", "an account name is neither contact nor pushname");
});

test("find_contact reports name_source alongside saved", async () => {
  const { sock, call } = setup();
  sock.ev.emit("contacts.upsert", [
    { id: ANA, name: "Ana" },
    { id: DAN, notify: "danu" },
  ]);

  const saved = (await call("find_contact", { name: "Ana" })).structuredContent;
  assert.equal(saved.status, "resolved");
  assert.equal(saved.contact.saved, true);
  assert.equal(saved.contact.name_source, "contact");

  const unsaved = (await call("find_contact", { name: "danu" })).structuredContent;
  const dan = unsaved.contact ?? unsaved.candidates[0];
  assert.equal(dan.name_source, "pushname", "a notify name is what the person publishes");
  if (unsaved.contact) assert.equal(unsaved.contact.saved, false);
});

test("a sender's entry is read by number, with the address-book scan's own answer", async () => {
  const { svc, sock, call, arrive } = setup();
  const FILED = "40700000005@s.whatsapp.net";
  const STRANGER = "40700000006@s.whatsapp.net";
  sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Ana" }]);
  arrive(FILED, "nota mea");
  arrive(STRANGER, "nu ma stii");
  svc.db.identity.setNote(FILED, "contabila");

  // The scan: the first ten address-book matches of the digits, then the one with exactly this number.
  const scanned = async (phone) => (await svc.searchContacts(phone, 10)).find((c) => c.number === phone);
  for (const jid of [ANA, FILED, STRANGER, "40700000099@s.whatsapp.net"]) {
    const phone = jid.split("@")[0];
    assert.deepEqual(await svc.contactByNumber(phone), await scanned(phone), phone);
  }

  const searchContacts = svc.searchContacts.bind(svc);
  let scans = 0;
  svc.searchContacts = (...args) => (scans++, searchContacts(...args));
  for (const jid of [ANA, FILED, STRANGER]) arrive(jid, "rulaj comun");
  const result = await call("search", { match: "words", query: "rulaj comun" });
  assert.equal(result.structuredContent.count, 3);
  assert.equal(result.structuredContent.messages.find((m) => m.sender.id === ANA).sender.contact_name, "Ana");
  assert.equal(scans, 0, "no sender costs a pass over the address book");
});
