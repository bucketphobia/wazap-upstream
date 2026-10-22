/**
 * The address book. WhatsApp sends it as an app state sync snapshot, once per
 * stored collection version, and for a long time the socket that paired ate
 * that one delivery. These pin the recovery: when wazap decides the address
 * book is missing, and what it does about it.
 */
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

import { needsContactResync } from "../dist/service/contacts.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { asToolSource, connectedService, openService, schemaCheckedTools, textError } from "./helpers.mjs";
import { registerTools } from "../dist/tools.js";

/** Stand-in for McpServer: records what got registered and lets us call it. */
function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, meta, handler) {
      tools.set(name, { meta, handler });
    },
  };
}

const ME = "40700000001@s.whatsapp.net";
const COLLECTIONS = ["critical_block", "critical_unblock_low", "regular_high", "regular_low", "regular"];
const DAY = 24 * 3_600_000;
const NOW = 1_800_000_000_000;

const makeService = () => connectedService(WhatsAppService, { prefix: "wazap-contacts-", id: ME, name: "Răzvan" });

/** A socket that records what the resync asked WhatsApp and the auth state for. */
function syncableSocket(sock, { versions = COLLECTIONS } = {}) {
  const stored = Object.fromEntries(versions.map((name) => [name, { version: 21 }]));
  const asked = [];
  sock.authState = {
    keys: {
      get: async (type, ids) => Object.fromEntries(ids.map((id) => [id, stored[id]])),
      set: async (data) => {
        for (const [id, value] of Object.entries(data["app-state-sync-version"] ?? {})) {
          if (value === null) delete stored[id];
          else stored[id] = value;
        }
      },
    },
  };
  sock.resyncAppState = async (collections, isInitialSync) => asked.push({ collections, isInitialSync });
  return { stored, asked };
}

test("the resync decision reads the same four facts every time", () => {
  const cases = [
    [
      "no names and versions stored: the delivery went somewhere else",
      { named: 0, storedVersions: true, resyncedAt: null },
      true,
    ],
    ["names in hand: nothing to heal", { named: 217, storedVersions: true, resyncedAt: null }, false],
    [
      "no stored version: this connection is already doing the sync",
      { named: 0, storedVersions: false, resyncedAt: null },
      false,
    ],
    [
      "asked yesterday: the account really has no contacts",
      { named: 0, storedVersions: true, resyncedAt: NOW - DAY },
      false,
    ],
    ["asked eight days ago: worth one more try", { named: 0, storedVersions: true, resyncedAt: NOW - 8 * DAY }, true],
    ["one name is enough to stop asking", { named: 1, storedVersions: true, resyncedAt: NOW - 8 * DAY }, false],
  ];
  for (const [label, input, expected] of cases) {
    assert.equal(needsContactResync({ ...input, now: NOW }), expected, label);
  }
});

test("a resync forgets every stored version before it asks", async () => {
  const { svc, sock } = makeService();
  const { stored, asked } = syncableSocket(sock);

  await svc.contacts.resyncContacts(sock);

  assert.deepEqual(Object.keys(stored), [], "a version left behind would make WhatsApp send patches, not the snapshot");
  assert.deepEqual(asked, [{ collections: COLLECTIONS, isInitialSync: true }]);
  assert.ok(Number.isFinite(svc.contacts.contactsResyncedAt()), "the stamp is written before the request");
});

test("the resync stamp survives a restart, so a restart does not repeat it", async () => {
  const { svc, sock } = makeService();
  syncableSocket(sock);
  await svc.contacts.resyncContacts(sock);
  const stamped = svc.contacts.contactsResyncedAt();
  const revived = openService(WhatsAppService, svc.config);
  assert.equal(revived.contacts.contactsResyncedAt(), stamped);
  await revived.stop();
});

test("an account that never asked, or an older snapshot written before the stamp existed, reads as never asked", async () => {
  const { svc } = makeService();
  assert.equal(svc.contacts.contactsResyncedAt(), null);
  const imported = connectedService(WhatsAppService, { prefix: "wazap-contacts-", id: ME, name: "Răzvan", config: { persistHistory: true } });
  mkdirSync(imported.svc.paths.root, { recursive: true });
  writeFileSync(imported.svc.paths.storeFile, JSON.stringify({ v: 1, chats: {}, contacts: {}, messages: {}, byChat: {} }));
  await imported.svc.bootStorage();
  assert.equal(imported.svc.contacts.contactsResyncedAt(), null);
  await imported.svc.stop();
});

test("a connection that came up without the address book asks for it, once", async () => {
  const { svc, sock } = makeService();
  const { asked } = syncableSocket(sock);
  svc.contacts.waitForNames = async () => svc.namedContacts();

  await svc.healContacts(sock, svc.generation);
  assert.equal(asked.length, 1);

  await svc.healContacts(sock, svc.generation);
  assert.equal(asked.length, 1, "at most once per process, whatever reconnects");
});

test("a connection that already has names leaves WhatsApp alone", async () => {
  const { svc, sock } = makeService();
  const { asked } = syncableSocket(sock);
  sock.ev.emit("contacts.upsert", [{ id: "40700000061@s.whatsapp.net", name: "Ionut" }]);

  await svc.healContacts(sock, svc.generation);
  assert.deepEqual(asked, []);
  assert.equal(svc.contacts.contactsResyncedAt(), null);
});

test("a connection with no stored version is already syncing, so it is left to it", async () => {
  const { svc, sock } = makeService();
  const { asked } = syncableSocket(sock, { versions: [] });
  svc.contacts.waitForNames = async () => svc.namedContacts();

  await svc.healContacts(sock, svc.generation);
  assert.deepEqual(asked, []);
});

test("the open connection is what starts it", () => {
  const { svc, sock } = makeService();
  let calls = 0;
  svc.healContacts = async () => {
    calls++;
  };
  sock.ev.emit("connection.update", { connection: "open" });
  assert.equal(calls, 1);
});

test("names arriving on either contact event reach the database, and a restart reads them back", async () => {
  const { svc, sock } = makeService();
  sock.ev.emit("contacts.upsert", [{ id: "40700000051@s.whatsapp.net", name: "Ionut" }]);
  assert.equal(svc.db.identity.contact("40700000051@s.whatsapp.net").name, "Ionut", "contacts.upsert");

  sock.ev.emit("contacts.update", [{ id: "40700000051@s.whatsapp.net", name: "Ionut Fox" }]);
  assert.equal(svc.db.identity.contact("40700000051@s.whatsapp.net").name, "Ionut Fox", "contacts.update");
  assert.equal(svc.identity.displayName("40700000051@s.whatsapp.net"), "Ionut Fox");
  const revived = openService(WhatsAppService, svc.config);
  assert.equal(revived.identity.displayName("40700000051@s.whatsapp.net"), "Ionut Fox");
  await revived.stop();
});

test("a contact lookup answers within a deadline when WhatsApp never replies for the number", async () => {
  const { svc, sock } = makeService();
  sock.fetchStatus = () => new Promise(() => {});
  sock.profilePictureUrl = () => new Promise(() => {});
  const started = Date.now();
  const contact = await svc.getContact("+40 700 000 099");
  assert.ok(Date.now() - started < 12_000, "did not wait for the MCP request timeout");
  assert.equal(contact.number, "40700000099");
  assert.equal(contact.about, null);
  assert.equal(contact.profile_pic_url, null);
});

test("the address book search finds a number typed with the national leading zero", async () => {
  const { svc, sock } = makeService();
  sock.ev.emit("contacts.upsert", [{ id: "40734000111@s.whatsapp.net", name: "Ana" }]);
  const found = await svc.searchContacts("0734 000 111", 10);
  assert.deepEqual(
    found.map((c) => c.name),
    ["Ana"]
  );
  const stillFound = await svc.searchContacts("40734", 10);
  assert.deepEqual(
    stillFound.map((c) => c.name),
    ["Ana"]
  );
});

test("updateContactDetails files tags and details, normalized to lowercase tokens", async () => {
  const { svc } = makeService();
  const c = await svc.updateContactDetails("40700000061@s.whatsapp.net", {
    addTags: ["#Client", "Echipa  Ro"],
    fields: { Role: "contabil", "  Oras ": "Cluj" },
  });
  assert.deepEqual(c.tags, ["client", "echipa-ro"]);
  assert.deepEqual(c.fields, { oras: "Cluj", role: "contabil" });
});

test("the filing survives in the database and reloads with it", async () => {
  const { svc } = makeService();
  await svc.updateContactDetails("40700000061@s.whatsapp.net", {
    addTags: ["client"],
    fields: { role: "contabil" },
  });
  const revived = openService(WhatsAppService, svc.config);
  const stored = revived.db.identity.notes("40700000061@s.whatsapp.net");
  assert.deepEqual(stored.tags, ["client"]);
  assert.deepEqual(stored.fields, { role: "contabil" });
  await revived.stop();
});

test("the address book search resolves a role and a tag word, not just names", async () => {
  const { svc, sock } = makeService();
  sock.ev.emit("contacts.upsert", [{ id: "40700000061@s.whatsapp.net", name: "Ionut" }]);
  await svc.updateContactDetails("40700000061@s.whatsapp.net", {
    addTags: ["furnizori"],
    fields: { role: "contabil" },
  });

  assert.deepEqual((await svc.searchContacts("contabil", 10)).map((c) => c.name), ["Ionut"]);
  assert.deepEqual((await svc.searchContacts("furnizor", 10)).map((c) => c.name), ["Ionut"]);
  assert.deepEqual((await svc.searchContacts("role", 10)).map((c) => c.name), ["Ionut"], "the key hits too");
  assert.deepEqual(await svc.searchContacts("necunoscut", 10), []);
});

test("the address book search with only a tag lists everyone filed under it", async () => {
  const { svc, sock } = makeService();
  sock.ev.emit("contacts.upsert", [
    { id: "40700000061@s.whatsapp.net", name: "Ionut" },
    { id: "40700000062@s.whatsapp.net", name: "Ana" },
    { id: "40700000063@s.whatsapp.net", name: "Mara" },
  ]);
  await svc.updateContactDetails("40700000061@s.whatsapp.net", { addTags: ["furnizori"] });
  await svc.updateContactDetails("40700000062@s.whatsapp.net", { addTags: ["#Furnizori", "client"] });

  const found = await svc.searchContacts("", 10, { tag: "furnizori" });
  assert.deepEqual(
    found.map((c) => c.name).sort(),
    ["Ana", "Ionut"]
  );
  assert.deepEqual(await svc.searchContacts("", 10, { tag: "client" }).then((r) => r.map((c) => c.name)), ["Ana"]);
});

test("a person known only through the local filing is still found", async () => {
  const { svc } = makeService();
  await svc.updateContactDetails("40700000099@s.whatsapp.net", { fields: { role: "curier" } });
  const found = await svc.searchContacts("curier", 10);
  assert.equal(found.length, 1);
  assert.equal(found[0].contact_id, "40700000099@s.whatsapp.net");
  assert.equal(found[0].is_my_contact, false, "never saved on WhatsApp");
});

test("removals take keys and tags off; a person left bare loses the entry", async () => {
  const { svc } = makeService();
  const jid = "40700000061@s.whatsapp.net";
  await svc.updateContactDetails(jid, { addTags: ["client", "vip"], fields: { role: "contabil", oras: "Cluj" } });

  let c = await svc.updateContactDetails(jid, { removeTags: ["vip"], removeFields: ["oras"] });
  assert.deepEqual(c.tags, ["client"]);
  assert.deepEqual(c.fields, { role: "contabil" });

  c = await svc.updateContactDetails(jid, { fields: { role: "" }, removeTags: ["client"] });
  assert.equal(c.tags, undefined);
  assert.equal(c.fields, undefined);
  assert.equal(svc.db.identity.notes(jid), null, "nothing left, nothing stored");
});

test("a note and the filing live side by side without touching each other", async () => {
  const { svc, sock } = makeService();
  sock.fetchStatus = async () => [];
  sock.profilePictureUrl = async () => undefined;
  const jid = "40700000061@s.whatsapp.net";
  await svc.updateContactDetails(jid, { addTags: ["client"] });
  await svc.setContactNote(jid, "răspunde rar");
  const c = await svc.getContact(jid);
  assert.equal(c.note, "răspunde rar");
  assert.deepEqual(c.tags, ["client"]);
  await svc.setContactNote(jid, "");
  assert.deepEqual((await svc.getContact(jid)).tags, ["client"], "clearing the note keeps the filing");
});

test("the filing follows the person when a lid turns out to be their number", async () => {
  const { svc } = makeService();
  await svc.updateContactDetails("12345678901234@lid", { addTags: ["client"], fields: { role: "contabil" } });
  svc.identity.learnLid("12345678901234@lid", "40700000077@s.whatsapp.net");
  assert.deepEqual(svc.db.identity.notes("40700000077@s.whatsapp.net").tags, ["client"]);
  assert.deepEqual(
    svc.db.identity.notes("12345678901234@lid"),
    svc.db.identity.notes("40700000077@s.whatsapp.net"),
    "both spellings are one person with one filing"
  );
  const found = await svc.searchContacts("contabil", 10);
  assert.deepEqual(found.map((c) => c.contact_id), ["40700000077@s.whatsapp.net"]);
});

test("a group id cannot be filed as a person", async () => {
  const { svc } = makeService();
  await assert.rejects(
    () => svc.updateContactDetails("12345@g.us", { addTags: ["echipa"] }),
    (err) => err.code === "INVALID_ID"
  );
});

test("empty edits and unusable labels are refused before anything is filed", async () => {
  const { svc } = makeService();
  const jid = "40700000061@s.whatsapp.net";
  await assert.rejects(() => svc.updateContactDetails(jid, {}), (err) => err.code === "INVALID_ID");
  await assert.rejects(
    () => svc.updateContactDetails(jid, { addTags: ["  # "] }),
    (err) => err.code === "INVALID_ID"
  );
  await assert.rejects(
    () => svc.updateContactDetails(jid, { fields: { "   ": "x" } }),
    (err) => err.code === "INVALID_ID"
  );
  assert.equal(svc.db.identity.notes(jid), null, "nothing was filed");
});

test("the filing is capped, like a note, not a document", async () => {
  const { svc } = makeService();
  const jid = "40700000061@s.whatsapp.net";
  await assert.rejects(
    () =>
      svc.updateContactDetails(jid, {
        addTags: Array.from({ length: 31 }, (_, i) => `t${i}`),
      }),
    (err) => err.code === "TEXT_TOO_LONG"
  );
  await assert.rejects(
    () => svc.updateContactDetails(jid, { fields: { bio: "x".repeat(201) } }),
    (err) => err.code === "TEXT_TOO_LONG"
  );
});

test("remember is a local tool: registered without writes, off WhatsApp entirely", async () => {
  const calls = [];
  const server = fakeServer();
  registerTools(
    server,
    asToolSource({
      updateContactDetails: async (...args) => {
        calls.push(args);
        return {
          contact_id: "40700000061@s.whatsapp.net",
          name: "Ionut",
          number: "40700000061",
          tags: ["client"],
          fields: { role: "contabil" },
          is_my_contact: true,
          is_business: false,
        };
      },
    }),
    { allowWrite: false, allowLocalEdits: true }
  );
  const tool = server.tools.get("remember");
  assert.ok(tool, "local tools register in read-only sessions");
  assert.equal(tool.meta.annotations.openWorldHint, false, "it reaches nothing outside this machine");

  const result = await tool.handler({
    chat_id: "40700000061@s.whatsapp.net",
    add_tags: ["#Client"],
    fields: { role: "contabil" },
  });
  assert.deepEqual(calls[0], [
    "40700000061@s.whatsapp.net",
    { addTags: ["#Client"], removeTags: undefined, fields: { role: "contabil" }, removeFields: undefined },
  ]);
  assert.match(result.content[0].text, /#client/);
  assert.match(result.content[0].text, /\*\*role\*\*: contabil/);
});

test("remember stays registered for a read credential but refuses to file anything", async () => {
  let touched = 0;
  const server = fakeServer();
  registerTools(
    server,
    asToolSource({ updateContactDetails: async () => (touched++, {}) }),
    { allowWrite: false, allowLocalEdits: false }
  );
  const tool = server.tools.get("remember");
  assert.ok(tool, "a read session still sees the tool");
  const result = await tool.handler({ chat_id: "40700000061@s.whatsapp.net", add_tags: ["#private"] });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error, "READ_ONLY");
  assert.equal(touched, 0, "nothing reached the account");
});

test("find_contact asks for a name or a tag, and lists a tag with each person's chat_id", async () => {
  const calls = [];
  const { call } = schemaCheckedTools(
    {
      searchContacts: async (...args) => {
        calls.push(args);
        return args[2].tag === "#Furnizori"
          ? [{ contact_id: "40700000061@s.whatsapp.net", name: "Ionut", number: "40700000061", tags: ["furnizori"], fields: { role: "contabil" }, is_my_contact: true, is_business: false }]
          : [];
      },
    },
    { allowWrite: false }
  );

  assert.equal(textError(await call("find_contact", {})).error, "INVALID_ID");

  const listed = await call("find_contact", { tag: "#Furnizori", limit: 10 });
  assert.deepEqual([calls[0][0], calls[0][2]], ["", { tag: "#Furnizori" }]);
  assert.ok(calls[0][1] > 10, "more than the limit is asked for, so what the limit leaves out can be counted");
  assert.equal(listed.structuredContent.status, "listed");
  assert.deepEqual(listed.structuredContent.contacts, [
    { chat_id: "40700000061@s.whatsapp.net", name: "Ionut", number: "40700000061", saved: true, tags: ["furnizori"], fields: { role: "contabil" } },
  ]);
  assert.match(listed.content[0].text, /Ionut \(\+40 700 000 061\) · saved · #furnizori · role: contabil\n {2}chat_id: 40700000061@s\.whatsapp\.net/);

  const none = await call("find_contact", { tag: "client" });
  assert.match(none.content[0].text, /Nobody is filed under #client/);
});

test("the address book search matches every name a person goes by, lists the address book in the order it arrived, the account too when it is in it, and leaves out strangers", async () => {
  const { svc, sock } = makeService();
  const BOGDAN = "40700000071@s.whatsapp.net";
  const ANA = "40700000072@s.whatsapp.net";
  const STRANGER = "40700000073@s.whatsapp.net";
  const say = (from, id, pushName) =>
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{ key: { remoteJid: from, fromMe: false, id }, pushName, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: "salut" } }],
    });
  // Bogdan writes before the address book arrives, under the name he publishes; a stranger only ever writes.
  say(BOGDAN, "B1", "Bogdan B.");
  say(STRANGER, "S1", "Elena Pushname");
  sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Ana Pop" }, { id: BOGDAN, notify: "Bogdan" }, { id: ME, notify: "Răzvan" }]);

  assert.deepEqual((await svc.searchContacts("Bogdan B.", 10)).map((c) => c.contact_id), [BOGDAN], "the name on his messages finds him");
  assert.deepEqual((await svc.searchContacts("Bogdan", 10)).map((c) => c.name), ["Bogdan"], "the address book's name is the one shown");
  assert.deepEqual((await svc.searchContacts("Elena", 10)).map((c) => c.contact_id), [], "someone who only wrote is not a contact");
  const everyone = (await svc.searchContacts("", 10)).map((c) => c.contact_id);
  assert.deepEqual(everyone, [ANA, BOGDAN, ME], "the address book in the order it arrived, the account's own entry included, as main listed it");
  assert.deepEqual((await svc.searchContacts("", 1)).map((c) => c.contact_id), [ANA], "a limit keeps the first ones");
});
