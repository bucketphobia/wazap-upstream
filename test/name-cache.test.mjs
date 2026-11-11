/**
 * The names, notes and tags every read tool shows come from a cache in front
 * of the account database, emptied by every write that could change one: a
 * contact or chat renamed, `remember`, a lid paired with its number, a
 * rollback, another database taking over. A read never shows a stale name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const BOGDAN = "40700000003@s.whatsapp.net";
const BOGDAN_LID = "111222333444555@lid";
const GROUP = "120363000000000009@g.us";

const makeService = () => connectedService(WhatsAppService, { prefix: "wazap-name-cache-", id: ME, name: "Răzvan" });

test("a name, a note and tags are read from the database once, then from memory", (t) => {
  const { svc, sock } = makeService();
  t.after(() => svc.stop());
  sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Ana" }]);
  svc.db.identity.updateFields(ANA, { addTags: ["client", "acte"] });
  svc.db.identity.setNote(ANA, "dosar deschis");
  const contact = t.mock.method(svc.db.identity, "contact");
  const notes = t.mock.method(svc.db.identity, "notes");
  for (let i = 0; i < 5; i++) {
    assert.equal(svc.identity.displayName(ANA), "Ana");
    assert.equal(svc.identity.noteFor(ANA), "dosar deschis");
    assert.deepEqual(svc.identity.tagsFor(ANA), ["acte", "client"]);
  }
  assert.equal(contact.mock.callCount(), 1, "one contact read for five names");
  assert.equal(notes.mock.callCount(), 1, "one notes read for five notes and five tag lists");
  // A hint (the pushName on a message) only fills in where the database names nobody.
  assert.equal(svc.identity.displayName(ANA, "ana-wa"), "Ana");
  assert.equal(svc.identity.displayName("40700000009@s.whatsapp.net", "Necunoscut"), "Necunoscut");
  assert.equal(svc.identity.displayName("40700000009@s.whatsapp.net"), "40700000009");
});

test("every write that renames, notes or tags someone shows at once", (t) => {
  const { svc, sock } = makeService();
  t.after(() => svc.stop());
  sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Ana" }]);
  sock.ev.emit("chats.upsert", [{ id: GROUP, name: "Familia" }]);
  assert.equal(svc.identity.displayName(ANA), "Ana");
  assert.equal(svc.identity.displayName(GROUP), "Familia");
  assert.equal(svc.identity.noteFor(ANA), undefined);
  assert.equal(svc.identity.tagsFor(ANA), undefined);

  sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Ana Popescu" }]);
  assert.equal(svc.identity.displayName(ANA), "Ana Popescu", "an address-book rename");
  sock.ev.emit("chats.update", [{ id: GROUP, name: "Familia mare" }]);
  assert.equal(svc.identity.displayName(GROUP), "Familia mare", "a group renamed");
  svc.db.identity.setNote(ANA, "contabilă");
  assert.equal(svc.identity.noteFor(ANA), "contabilă", "remember: a note");
  svc.db.identity.updateFields(ANA, { addTags: ["contabilitate"] });
  assert.deepEqual(svc.identity.tagsFor(ANA), ["contabilitate"], "remember: a tag");
  svc.db.identity.updateFields(ANA, { removeTags: ["contabilitate"] });
  assert.equal(svc.identity.tagsFor(ANA), undefined, "remember: a tag taken off");

  // A stranger names themselves on a message, then turns out to be a lid paired with a saved number.
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: BOGDAN_LID, fromMe: false, id: "L1" }, message: { conversation: "salut" }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: "B." }],
  });
  assert.equal(svc.identity.displayName(BOGDAN_LID), "B.");
  sock.ev.emit("contacts.upsert", [{ id: BOGDAN, name: "Bogdan", lid: BOGDAN_LID }]);
  assert.equal(svc.identity.displayName(BOGDAN_LID), "Bogdan", "the pairing names the lid by the saved contact");
});

test("a write rolled back takes back the name a read saw inside it", (t) => {
  const { svc, sock } = makeService();
  t.after(() => svc.stop());
  sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Ana" }]);
  assert.equal(svc.identity.displayName(ANA), "Ana");
  assert.throws(() =>
    svc.db.transaction(() => {
      svc.db.identity.upsertContact({ jid: ANA, name: "Provizoriu" });
      assert.equal(svc.identity.displayName(ANA), "Provizoriu");
      throw new Error("rollback");
    })
  );
  assert.equal(svc.identity.displayName(ANA), "Ana");
});

test("names are cached per database: another one taking over starts empty", (t) => {
  const { svc, sock } = makeService();
  t.after(() => svc.stop());
  sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Ana" }]);
  assert.equal(svc.identity.displayName(ANA), "Ana");
  const other = { ...svc.db, namesVersion: svc.db.namesVersion, identity: { contact: () => ({ name: "Alta" }), chat: () => null } };
  t.mock.method(svc.storage, "readyDb", () => other);
  assert.equal(svc.identity.displayName(ANA), "Alta");
});
