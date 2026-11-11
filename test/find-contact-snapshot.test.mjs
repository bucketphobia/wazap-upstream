/**
 * find_contact folds everyone's names once and reuses the whole list while
 * nothing about anyone changed; a contact written, a note or tag filed, a lid
 * paired, a rollback or another owner reads it again, so a find never misses
 * a change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { PEER, PEER_LID, openTemp } from "./db-fixtures.mjs";

const ANA = "40700000011@s.whatsapp.net";
const MIHAI = "40700000012@s.whatsapp.net";

function setup(t) {
  const { db } = openTemp();
  t.after(() => db.close());
  db.identity.upsertContact({ jid: ANA, name: "Ana Pop", listed: true });
  db.identity.upsertContact({ jid: MIHAI, name: "Mihai Ionescu", listed: true });
  const reads = t.mock.method(db.connection, "arrayStmt");
  const peopleReads = () => reads.mock.calls.filter((call) => /FROM contacts k LEFT JOIN contact_notes/.test(call.arguments[0])).length;
  return { db, peopleReads };
}

const names = (result) => [...result.candidates, ...result.closest].map((candidate) => candidate.displayName).sort();

test("the list of everyone is read once for many finds", (t) => {
  const { db, peopleReads } = setup(t);
  for (let i = 0; i < 5; i++) {
    assert.equal(db.contacts.find({ name: "Ana" }).verdict, "resolved");
    assert.deepEqual(names(db.contacts.find({ name: "Mihai" })), ["Mihai Ionescu"]);
  }
  assert.equal(peopleReads(), 1);
});

test("a contact written, a note or tag filed, a pairing or a rollback is seen by the next find", (t) => {
  const { db, peopleReads } = setup(t);
  assert.equal(db.contacts.find({ name: "Ana" }).verdict, "resolved");

  db.identity.upsertContact({ jid: ANA, name: "Ioana Pop" });
  assert.equal(db.contacts.find({ name: "Ana" }).verdict, "not_found", "renamed away");
  assert.equal(db.contacts.find({ name: "Ioana" }).verdict, "resolved");

  db.identity.upsertContact({ jid: "40700000013@s.whatsapp.net", name: "Ana Maria", listed: true });
  assert.deepEqual(names(db.contacts.find({ name: "Ana" })), ["Ana Maria"], "someone new");

  db.identity.updateFields(MIHAI, { set: { relatie: "frate" } });
  assert.equal(db.contacts.find({ name: "fratele" }).verdict, "resolved", "a detail filed");
  db.identity.setNote(MIHAI, "mama");
  db.identity.updateFields(MIHAI, { removeFields: ["relatie"] });
  assert.equal(db.contacts.find({ name: "fratele" }).verdict, "not_found", "and taken off");

  db.identity.upsertContact({ jid: PEER_LID, pushName: "Bogdan" });
  assert.equal(db.contacts.find({ name: "Bogdan" }).candidates[0]?.jid, PEER_LID);
  db.learnLidPhone(PEER_LID, PEER);
  assert.equal(db.contacts.find({ name: "Bogdan" }).candidates[0]?.jid, PEER, "a pairing moves them to their number");

  assert.throws(() =>
    db.transaction(() => {
      db.identity.upsertContact({ jid: MIHAI, name: "Provizoriu" });
      assert.equal(db.contacts.find({ name: "Provizoriu" }).verdict, "resolved");
      throw new Error("rollback");
    })
  );
  assert.equal(db.contacts.find({ name: "Provizoriu" }).verdict, "not_found", "a rolled-back name is gone");

  // The account itself is never a candidate: an owner set later is left out from the next find.
  db.setMeta("owner", ANA);
  assert.equal(db.contacts.find({ name: "Ioana" }).verdict, "not_found");
  assert.ok(peopleReads() >= 8, `read again after every change: ${peopleReads()}`);
});
