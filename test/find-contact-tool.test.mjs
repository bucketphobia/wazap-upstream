/**
 * find_contact inside one process, where an end-to-end world cannot reach:
 * the address book asked for once per boot when it looks empty, an account
 * that may not send getting no draft context in a session that may, an
 * account that cannot answer, and a stand-in without the service behind it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AccountHub } from "../dist/account-hub.js";
import { AccountRegistry } from "../dist/accounts.js";
import { registerTools } from "../dist/tools.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { IMPORT_META } from "../dist/legacy-import/index.js";
import { asToolSource, connectedService, fakeSocket, offlineConfig } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const WORK_ME = "40700000002@s.whatsapp.net";
const ANA = "40722000001@s.whatsapp.net";
const DAN = "40722000002@s.whatsapp.net";
const COLLECTIONS = ["critical_block", "critical_unblock_low", "regular_high", "regular_low", "regular"];

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) };
}

function connect(svc, id) {
  const sock = fakeSocket();
  svc.sockClient = sock;
  svc.wireEvents(sock, ++svc.generation);
  svc.account = { id, name: "Andrei", number: id.split("@")[0] };
  svc.status = "connected";
  svc.initialSyncDone = true;
  return sock;
}

/** A person with a saved name and a short exchange, both ways. */
function seed(svc, jid, name) {
  svc.db.identity.upsertContact({ jid, name, listed: true });
  const now = Date.now();
  svc.db.messages.upsert({ chatJid: jid, keyId: `${name}1`, fromMe: false, ts: now - 60_000, type: "text", text: `Salut de la ${name}` });
  svc.db.messages.upsert({ chatJid: jid, keyId: `${name}2`, fromMe: true, ts: now - 30_000, type: "text", text: "hai ca vin" });
}

/** A socket that stores app state versions and answers a resync with the address book, after `delayMs`. */
function syncable(sock, { versions = true, delayMs = 0 } = {}) {
  const stored = versions ? Object.fromEntries(COLLECTIONS.map((name) => [name, { version: 3 }])) : {};
  sock.authState = {
    keys: {
      get: async (_type, ids) => Object.fromEntries(ids.map((id) => [id, stored[id]])),
      set: async (data) => {
        for (const id of Object.keys(data["app-state-sync-version"] ?? {})) delete stored[id];
      },
    },
  };
  const asked = [];
  sock.resyncAppState = async (collections) => {
    asked.push(collections);
    setTimeout(() => sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Ana Pop" }]), delayMs);
  };
  return asked;
}

test("an empty address book is asked for once, and every find waiting on it answers from the names that came back", async () => {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-find-sync-", id: ME, name: "Andrei" });
  const asked = syncable(sock, { delayMs: 200 });
  const [first, second] = await Promise.all([svc.findContact({ name: "Ana" }), svc.findContact({ name: "Ana" })]);
  assert.equal(asked.length, 1, "one ask for two finds at once");
  assert.equal(first.verdict, "resolved", "the first answer reads the names that came back");
  assert.equal(second.verdict, "resolved", "and so does the one that came in during the wait");
  assert.equal(first.candidates[0].candidate.jid, ANA);
  await svc.findContact({ name: "Ana" });
  assert.equal(asked.length, 1, "once per boot");
  await svc.stop();

  // Another boot, whose account asked for its address book yesterday: the 7-day cooldown holds, and nothing waits.
  const again = connectedService(WhatsAppService, { prefix: "wazap-find-sync-", id: ME, name: "Andrei" });
  const askedAgain = syncable(again.sock);
  again.svc.db.setMeta(IMPORT_META.contactsResyncedAt, String(Date.now() - 86_400_000));
  const started = Date.now();
  await again.svc.findContact({ name: "Ana" });
  assert.equal(askedAgain.length, 0);
  assert.ok(Date.now() - started < 5_000);
  await again.svc.stop();

  // No stored versions: the connection is already syncing, nothing to ask.
  const fresh = connectedService(WhatsAppService, { prefix: "wazap-find-sync-", id: ME, name: "Andrei" });
  const askedFresh = syncable(fresh.sock, { versions: false });
  await fresh.svc.findContact({ name: "Ana" });
  assert.equal(askedFresh.length, 0);
  await fresh.svc.stop();

  const named = connectedService(WhatsAppService, { prefix: "wazap-find-sync-", id: ME, name: "Andrei" });
  named.sock.resyncAppState = async () => assert.fail("an address book with names is not asked for");
  named.sock.ev.emit("contacts.upsert", [{ id: DAN, name: "Dan Radu" }]);
  assert.equal((await named.svc.findContact({ name: "Dan" })).verdict, "resolved");
  await named.svc.stop();
});

test("a failed ask for the address book still answers from what is stored", async () => {
  const { svc } = connectedService(WhatsAppService, { prefix: "wazap-find-sync-", id: ME, name: "Andrei" });
  svc.db.identity.upsertContact({ jid: ANA, pushName: "Ana" });
  const found = await svc.findContact({ name: "Ana" });
  assert.equal(found.verdict, "resolved");
  assert.equal(found.accountId, "default");
  await svc.stop();
});

test("a session that may write gets no draft context for an account that may not; the account that may keeps it", async () => {
  const config = offlineConfig("wazap-find-hub-", { readOnly: false });
  const registry = AccountRegistry.load(config.dataDir);
  registry.add("work", "Work");
  registry.setWrites("work", false);
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  const home = hub.get("default");
  const work = hub.get("work");
  connect(home, ME);
  connect(work, WORK_ME);
  seed(home, ANA, "Ana Pop");
  seed(work, DAN, "Dan Radu");
  const server = fakeServer();
  registerTools(server, asToolSource(hub), { allowWrite: true });
  const find = (args) => server.tools.get("find_contact").handler(args);

  const dan = (await find({ name: "Dan Radu" })).structuredContent;
  assert.deepEqual([dan.status, dan.contact.account_id, dan.context], ["resolved", "work", undefined]);
  const ana = (await find({ name: "Ana Pop" })).structuredContent;
  assert.deepEqual([ana.status, ana.contact.account_id], ["resolved", "default"]);
  assert.deepEqual(
    ana.context.recent.map((line) => [line.from_me, line.text]),
    [
      [false, "Salut de la Ana Pop"],
      [true, "hai ca vin"],
    ]
  );

  const readServer = fakeServer();
  registerTools(readServer, asToolSource(hub), { allowWrite: false });
  assert.ok(readServer.tools.has("find_contact"), "a read session has the tool");
  assert.equal((await readServer.tools.get("find_contact").handler({ name: "Ana Pop" })).structuredContent.context, undefined);

  await hub.stop();
});

test("find_contact reads what an account stores without a connection, and never resolves while an account could not be searched", async () => {
  const config = offlineConfig("wazap-find-down-", { readOnly: false });
  const registry = AccountRegistry.load(config.dataDir);
  registry.add("work", "Work");
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  const home = hub.get("default");
  const work = hub.get("work");
  connect(home, ME);
  connect(work, WORK_ME);
  seed(home, ANA, "Ana Pop");
  seed(work, DAN, "Dan Radu");
  const server = fakeServer();
  registerTools(server, asToolSource(hub), { allowWrite: true });
  const find = (args) => server.tools.get("find_contact").handler(args);

  // Disconnected, or still connecting: the database answers.
  home.status = "connecting";
  work.status = "disconnected";
  const offline = (await find({ name: "Ana Pop" })).structuredContent;
  assert.deepEqual([offline.status, offline.contact?.chat_id, offline.accounts_unavailable], ["resolved", ANA, undefined]);

  // An account whose database cannot answer: the one match elsewhere is only a candidate, to confirm.
  work.storage.storageState = "preparing";
  try {
    const partial = await find({ name: "Ana Pop" });
    const body = partial.structuredContent;
    assert.equal(body.status, "ambiguous");
    assert.equal(body.contact, undefined);
    assert.deepEqual(body.candidates.map((c) => [c.account_id, c.name]), [["default", "Ana Pop"]]);
    assert.deepEqual(body.accounts_unavailable, [{ account_id: "work", error: "NOT_CONNECTED" }]);
    assert.match(body.fix, /work could not be searched/);
    assert.match(body.fix, /confirm with the user/);
    assert.match(partial.content[0].text, /Not searched: work \(NOT_CONNECTED\)/);

    const missing = await find({ name: "Xyzzy" });
    assert.match(missing.content[0].text, /Not searched: work/);
    assert.match(missing.structuredContent.fix, /work could not be searched/);
    seed(home, "40722000003@s.whatsapp.net", "Ana Marin");
    const many = await find({ name: "Ana" });
    assert.equal(many.structuredContent.status, "ambiguous");
    assert.equal(many.structuredContent.candidates.length, 2);
    assert.match(many.content[0].text, /Not searched: work/);
    assert.match(many.structuredContent.fix, /Ask the user which one[\s\S]*work could not be searched/);

    // Named, the account that answers resolves.
    assert.equal((await find({ name: "Ana Pop", account_id: "default" })).structuredContent.status, "resolved");

    home.storage.storageState = "preparing";
    const down = await find({ name: "Ana Pop" });
    assert.equal(down.isError, true);
    assert.equal(JSON.parse(down.content[0].text).error, "NOT_CONNECTED");
  } finally {
    home.storage.storageState = "ready";
    work.storage.storageState = "ready";
  }
  await hub.stop();
});

test("a stand-in without the service behind it answers SERVICE_ERROR, never a crash", async () => {
  const server = fakeServer();
  registerTools(server, asToolSource({}), { allowWrite: false });
  const result = await server.tools.get("find_contact").handler({ name: "Ana" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined, "a tool with an output schema answers errors as text");
  assert.equal(JSON.parse(result.content[0].text).error, "SERVICE_ERROR");
});

test("an account with the draft context off gets no style_check on its drafts either", async () => {
  const config = offlineConfig("wazap-find-style-off-", { readOnly: false });
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  const home = hub.get("default");
  connect(home, ME);
  home.db.identity.upsertContact({ jid: ANA, name: "Ana Pop", listed: true });
  ["ce faci, esti acasa?", "hai ca te sun", "poti sa vii maine?", "iti zic diseara ce facem", "tu ai vorbit cu el?"].forEach((text, i) =>
    home.db.messages.upsert({ chatJid: ANA, keyId: `E${i}`, fromMe: true, ts: Date.now() - 50_000 + i, type: "text", text })
  );
  const server = fakeServer();
  registerTools(server, asToolSource(hub), { allowWrite: true });
  const draft = () => server.tools.get("send_message").handler({ chat_id: ANA, text: "Bună ziua, vă trimit documentele mâine." });

  const on = await draft();
  assert.notEqual(on.isError, true, JSON.stringify(on.structuredContent));
  assert.ok(on.structuredContent.style_check, "on by default");
  AccountRegistry.load(config.dataDir).setDraftContext("default", false);
  const off = await draft();
  assert.notEqual(off.isError, true, JSON.stringify(off.structuredContent));
  assert.equal(off.structuredContent.style_check, undefined, "no style statistics once the account turned the draft context off");
  assert.doesNotMatch(off.content[0].text, /Style check/);
  await hub.stop();
});

test("an answer over several accounts that is not one contact names no account", async () => {
  const config = offlineConfig("wazap-find-null-account-", { readOnly: false });
  const registry = AccountRegistry.load(config.dataDir);
  registry.add("work", "Work");
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  const home = hub.get("default");
  const work = hub.get("work");
  connect(home, ME);
  connect(work, WORK_ME);
  seed(home, ANA, "Ana Pop");
  seed(work, DAN, "Ana Ionescu");
  const server = fakeServer();
  registerTools(server, asToolSource(hub), { allowWrite: true });
  const find = async (args) => (await server.tools.get("find_contact").handler(args)).structuredContent;

  const both = await find({ name: "Ana" });
  assert.deepEqual([both.status, both.account_id], ["ambiguous", null], "not the default account's answer");
  const nobody = await find({ name: "Xyzzy" });
  assert.deepEqual([nobody.status, nobody.account_id], ["not_found", null]);
  const one = await find({ name: "Ana Ionescu" });
  assert.deepEqual([one.status, one.account_id], ["resolved", "work"]);
  const named = await find({ name: "Ana", account_id: "default" });
  assert.equal(named.account_id, "default", "one account asked, that account");
  await hub.stop();
});

test("a number, however it is written, or an id resolves to who it is, with what the user filed; an unknown one is not_found", async () => {
  const config = offlineConfig("wazap-find-number-", { readOnly: false });
  const registry = AccountRegistry.load(config.dataDir);
  registry.add("work", "Work");
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  const home = hub.get("default");
  const work = hub.get("work");
  const homeSock = connect(home, ME);
  connect(work, WORK_ME);
  seed(home, ANA, "Ana Pop");
  seed(work, DAN, "Dan Radu");
  const GROUP = "120363000000000031@g.us";
  homeSock.ev.emit("chats.upsert", [{ id: GROUP, name: "Bloc 12" }]);
  const server = fakeServer();
  registerTools(server, asToolSource(hub), { allowWrite: true });
  const find = async (args) => (await server.tools.get("find_contact").handler(args)).structuredContent;
  await server.tools.get("remember").handler({ chat_id: ANA, add_tags: ["client"], fields: { rol: "contabil" }, account_id: "default" });

  for (const [name, source] of [
    ["+40 722 000 001", "number"],
    ["40722000001", "number"],
    ["0722-000-001", "number"],
    ["0040722000001", "number"],
    [ANA, "id"],
  ]) {
    const found = await find({ name });
    assert.equal(found.status, "resolved", name);
    assert.equal(found.contact.chat_id, ANA, name);
    assert.equal(found.contact.account_id, "default", name);
    assert.equal(found.contact.matched.source, source, name);
    assert.equal(found.contact.number, "40722000001", name);
    assert.deepEqual([found.contact.tags, found.contact.fields], [["client"], { rol: "contabil" }], name);
    assert.ok(found.context, `${name}: a write session gets the context on the usual rules`);
  }
  assert.equal((await find({ name: "+40722000001", include_context: false })).context, undefined);
  const dan = await find({ name: "+40 722 000 002" });
  assert.deepEqual([dan.status, dan.contact.account_id, dan.contact.name], ["resolved", "work", "Dan Radu"]);
  const group = await find({ name: GROUP });
  assert.deepEqual([group.status, group.contact.kind, group.contact.name], ["resolved", "group", "Bloc 12"]);

  const nobody = await find({ name: "+40 733 000 999" });
  assert.equal(nobody.status, "not_found");
  assert.match(nobody.fix, /check the number/);
  assert.equal(nobody.closest.length, 0);

  // The same person on both accounts is a question of which account, never a guess.
  seed(work, ANA, "Ana Pop");
  const twice = await find({ name: "0722 000 001" });
  assert.equal(twice.status, "ambiguous");
  assert.deepEqual(twice.candidates.map((c) => c.account_id).sort(), ["default", "work"]);
  assert.match(twice.fix, /account_id/);

  const readServer = fakeServer();
  registerTools(readServer, asToolSource(hub), { allowWrite: false });
  const read = (await readServer.tools.get("find_contact").handler({ name: DAN })).structuredContent;
  assert.deepEqual([read.status, read.context], ["resolved", undefined], "a read session gets no context, as for a name");
  await hub.stop();
});

test("a tag listed over two accounts shares the limit between them and counts what it left out on each", async () => {
  const config = offlineConfig("wazap-find-tag-share-", { readOnly: false });
  const registry = AccountRegistry.load(config.dataDir);
  registry.add("work", "Work");
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  const home = hub.get("default");
  const work = hub.get("work");
  connect(home, ME);
  connect(work, WORK_ME);
  const server = fakeServer();
  registerTools(server, asToolSource(hub), { allowWrite: false, allowLocalEdits: true });
  const call = async (name, args) => (await server.tools.get(name).handler(args)).structuredContent;
  for (const [svc, account, first] of [
    [home, "default", 40722100000],
    [work, "work", 40722200000],
  ]) {
    for (let i = 1; i <= 4; i++) {
      const jid = `${first + i}@s.whatsapp.net`;
      svc.db.identity.upsertContact({ jid, name: `Client ${account} ${i}`, listed: true });
      await call("remember", { chat_id: jid, add_tags: ["client"], account_id: account });
    }
  }

  const cut = await call("find_contact", { tag: "client", limit: 5 });
  assert.equal(cut.status, "listed");
  const per = (account) => cut.contacts.filter((c) => c.account_id === account).length;
  assert.deepEqual([per("default"), per("work")], [3, 2], "neither account's list crowds out the other's");
  assert.deepEqual(cut.omitted, [
    { account_id: "default", count: 1 },
    { account_id: "work", count: 2 },
  ]);
  const text = (await server.tools.get("find_contact").handler({ tag: "client", limit: 5 })).content[0].text;
  assert.match(text, /3 more not shown \(1 on default, 2 on work\)/);
  assert.match((cut.notes ?? []).join(" "), /3 more not shown \(1 on default, 2 on work\): raise limit/, "said in the structured content too");

  const whole = await call("find_contact", { tag: "client" });
  assert.equal(whole.contacts.length, 8);
  assert.equal(whole.omitted, undefined, "nothing left out, nothing said");
  assert.equal(whole.notes, undefined);
  const one = await call("find_contact", { tag: "client", limit: 3, account_id: "work" });
  assert.deepEqual([one.contacts.length, one.omitted], [3, [{ account_id: "work", count: 1 }]]);
  await hub.stop();
});

test("find_contact's limit says ambiguous answers list at most five people from each account", () => {
  const server = fakeServer();
  registerTools(server, asToolSource({}), { allowWrite: false });
  const { limit } = server.tools.get("find_contact").meta.inputSchema;
  assert.match(limit.description, /at most 5 per account/);
  assert.equal(limit.safeParse(51).success, false);
});

test("a name with nothing to look up is refused with what to pass instead", async () => {
  const { svc } = connectedService(WhatsAppService, { prefix: "wazap-find-empty-", id: ME, name: "Andrei" });
  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: false });
  for (const name of ["   ", "🙂", "!!"]) {
    const result = await server.tools.get("find_contact").handler({ name });
    assert.equal(result.isError, true, name);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.error, "INVALID_ID", name);
    assert.match(body.fix, /find_contact\(\{ name: "Ana" \}\)/);
  }
  await svc.stop();
});

test("no draft context for a contact the account's send rules refuse", async () => {
  const config = offlineConfig("wazap-find-send-rules-", { readOnly: false });
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  const home = hub.get("default");
  connect(home, ME);
  seed(home, ANA, "Ana Pop");
  seed(home, DAN, "Dan Radu");
  const server = fakeServer();
  registerTools(server, asToolSource(hub), { allowWrite: true });
  const find = async (name) => (await server.tools.get("find_contact").handler({ name })).structuredContent;
  const rules = (edit) => AccountRegistry.load(config.dataDir).setSendRules("default", edit);

  assert.ok((await find("Ana Pop")).context, "no rules: context");
  rules({ deny: ["+40 722 000 001"] });
  const denied = await find("Ana Pop");
  assert.deepEqual([denied.status, denied.context], ["resolved", undefined], "denied");
  assert.ok((await find("Dan Radu")).context, "someone the deny list does not name");
  rules({ deny: null, allow: [DAN] });
  assert.equal((await find("Ana Pop")).context, undefined, "not on the allowlist");
  assert.ok((await find("Dan Radu")).context, "on the allowlist");
  await hub.stop();
});
