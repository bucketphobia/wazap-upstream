/**
 * A messages.update batch commits once, and each of its entries is a part of
 * its own: one the database refuses is logged and undone alone, and costs no
 * other entry its revoke, edit or status. A sender can put any time on an
 * edit, so an edit time the database cannot file is taken as now.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService } from "./helpers.mjs";
import { openTemp } from "./db-fixtures.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const BOB = "40700000003@s.whatsapp.net";
const REVOKE = proto.WebMessageInfo.StubType.REVOKE;

function seeded(t) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-update-batch-", id: ME, name: "Owner", config: { persistHistory: true } });
  t.after(() => svc.stop());
  const now = Math.floor(Date.now() / 1000);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      { key: { remoteJid: ANA, fromMe: false, id: "A1" }, message: { conversation: "secret de la Ana" }, messageTimestamp: now - 10 },
      { key: { remoteJid: BOB, fromMe: false, id: "B1" }, message: { conversation: "mesaj Bob" }, messageTimestamp: now - 5 },
      { key: { remoteJid: BOB, fromMe: true, id: "M1" }, message: { conversation: "al meu" }, messageTimestamp: now - 4 },
    ],
  });
  for (const sid of [`false_${ANA}_A1`, `false_${BOB}_B1`, `true_${BOB}_M1`]) assert.ok(svc.hasMessage(sid), sid);
  return { svc, sock };
}

test("a revoke holds when an edit in the same batch carries a time the database cannot file", (t) => {
  const { svc, sock } = seeded(t);
  const before = Date.now();
  sock.ev.emit("messages.update", [
    { key: { remoteJid: ANA, fromMe: false, id: "A1" }, update: { message: null, messageStubType: REVOKE } },
    { key: { remoteJid: BOB, fromMe: false, id: "B1" }, update: { message: { editedMessage: { message: { conversation: "editat" } } }, messageTimestamp: 9.2e15 } },
  ]);
  assert.equal(svc.hasMessage(`false_${ANA}_A1`), false, "deleted for everyone stays deleted");
  const edited = svc.db.messages.get(`false_${BOB}_B1`);
  assert.equal(edited.text, "editat", "the edit itself is kept");
  assert.ok(edited.editedAt >= before && edited.editedAt <= Date.now(), `an edit time past what can be filed is now, got ${edited.editedAt}`);
});

test("an edit dated days ahead is filed as edited now; one dated plausibly keeps its time", (t) => {
  const { svc, sock } = seeded(t);
  const now = Math.floor(Date.now() / 1000);
  const before = Date.now();
  sock.ev.emit("messages.update", [
    { key: { remoteJid: BOB, fromMe: false, id: "B1" }, update: { message: { editedMessage: { message: { conversation: "din viitor" } } }, messageTimestamp: now + 30 * 86_400 } },
  ]);
  const ahead = svc.db.messages.get(`false_${BOB}_B1`).editedAt;
  assert.ok(ahead >= before && ahead <= Date.now(), `a clock gone wrong is now, got ${ahead}`);
  sock.ev.emit("messages.update", [
    { key: { remoteJid: ANA, fromMe: false, id: "A1" }, update: { message: { editedMessage: { message: { conversation: "la timp" } } }, messageTimestamp: now - 2 } },
  ]);
  assert.equal(svc.db.messages.get(`false_${ANA}_A1`).editedAt, (now - 2) * 1000);
});

test("an entry the database refuses is undone alone; the entries around it are applied", (t) => {
  const { svc, sock } = seeded(t);
  const messages = svc.db.messages;
  const setStatus = messages.setStatus;
  // The status write lands, then the entry fails: its savepoint must take the write back.
  messages.setStatus = function (sid, status) {
    setStatus.call(this, sid, status);
    if (sid === `true_${BOB}_M1`) throw new Error("synthetic refusal");
  };
  t.after(() => (messages.setStatus = setStatus));
  const names = svc.db.namesVersion;
  sock.ev.emit("messages.update", [
    { key: { remoteJid: ANA, fromMe: false, id: "A1" }, update: { message: null, messageStubType: REVOKE } },
    { key: { remoteJid: BOB, fromMe: true, id: "M1" }, update: { status: proto.WebMessageInfo.Status.READ } },
    { key: { remoteJid: BOB, fromMe: false, id: "B1" }, update: { message: { editedMessage: { message: { conversation: "dupa" } } } } },
  ]);
  assert.equal(svc.hasMessage(`false_${ANA}_A1`), false, "the revoke before the refused entry");
  assert.equal(svc.db.messages.get(`false_${BOB}_B1`).text, "dupa", "the edit after it");
  assert.notEqual(svc.db.messages.get(`true_${BOB}_M1`).status, proto.WebMessageInfo.Status.READ, "the refused entry's own write is undone");
  assert.ok(svc.db.namesVersion > names, "an undone part moves the names version, as a rollback does");
});

test("attempt: a failed part is undone alone inside a transaction, and is its own write outside one", () => {
  const { db } = openTemp();
  const failures = [];
  const failed = (err) => failures.push(err.message);
  db.transaction(() => {
    db.attempt(() => db.setMeta("one", "1"), failed);
    db.attempt(() => {
      db.setMeta("two", "2");
      // A part inside a part: its failure takes back only what it wrote.
      db.attempt(() => {
        db.setMeta("inner", "x");
        throw new Error("inner");
      }, failed);
      db.setMeta("two-after", "2");
    }, failed);
    db.attempt(() => {
      db.setMeta("three", "3");
      throw new Error("three");
    }, failed);
    db.attempt(() => db.setMeta("four", "4"), failed);
  });
  assert.deepEqual(failures, ["inner", "three"]);
  assert.deepEqual(
    ["one", "two", "inner", "two-after", "three", "four"].map((key) => db.getMeta(key)),
    ["1", "2", null, "2", null, "4"]
  );

  db.attempt(() => {
    db.setMeta("alone", "a");
    db.setMeta("alone-2", "b");
    throw new Error("alone");
  }, failed);
  assert.deepEqual(failures, ["inner", "three", "alone"]);
  assert.equal(db.getMeta("alone"), null, "outside a transaction the part is a transaction of its own, rolled back whole");
  db.attempt(() => db.setMeta("alone", "kept"), failed);
  assert.equal(db.getMeta("alone"), "kept");
  db.close();
});
