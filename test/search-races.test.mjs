/** Adversarial reads: asynchronous identity work must not freeze old source words or ownership. */
import test from "node:test";
import assert from "node:assert/strict";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools, asToolSource, textError } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net",
  PEER = "40700000002@s.whatsapp.net";
function setup(t) {
  const f = connectedService(WhatsAppService, { prefix: "wazap-search-race-", id: ME, name: "Owner" });
  t.after(() => f.svc.stop());
  let seq = 0;
  const arrive = (body) => {
    const key = { remoteJid: PEER, fromMe: false, id: `R${++seq}` };
    f.sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{ key, messageTimestamp: Math.floor(Date.now() / 1000) - 60 + seq, message: { conversation: body } }],
    });
    return `false_${PEER}_${key.id}`;
  };
  return { ...f, arrive, ...schemaCheckedTools(f.svc, { allowWrite: false, legacyReads: true }) };
}

test("a new private tag during sender identity lookup removes both source and context", async (t) => {
  for (const tool of ["search", "search_messages"]) {
    const f = setup(t);
    f.arrive("PRIVATE-RACE-NEEDLE");
    f.arrive("PRIVATE-RACE-CONTEXT");
    const lookup = f.svc.contactByNumber.bind(f.svc);
    f.svc.contactByNumber = async (...args) => {
      f.svc.db.identity.updateFields(PEER, { addTags: ["private"] });
      return lookup(...args);
    };
    const result = await f.call(tool, { query: "PRIVATE-RACE-NEEDLE", match: "words" });
    assert.equal(result.structuredContent.count, 0, tool);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-RACE-CONTEXT/);
    assert.equal(result.structuredContent.changed_during_read, true);
  }
});

test("a deletion during sender lookup cannot return a deleted hit or stale nearby words", async (t) => {
  const f = setup(t);
  const id = f.arrive("DELETE-RACE-NEEDLE");
  const lookup = f.svc.contactByNumber.bind(f.svc);
  f.svc.contactByNumber = async (...args) => {
    f.sock.ev.emit("messages.delete", { keys: [{ remoteJid: PEER, fromMe: false, id: id.split("_").pop() }] });
    return lookup(...args);
  };
  const result = await f.call("search_messages", { query: "DELETE-RACE-NEEDLE", match: "words" });
  assert.equal(result.structuredContent.count, 0);
  assert.deepEqual(result.structuredContent.contexts, []);
});

test("an owner change during sender lookup invalidates the search instead of returning the previous account", async (t) => {
  const f = setup(t);
  f.arrive("OWNER-RACE-NEEDLE");
  const lookup = f.svc.contactByNumber.bind(f.svc);
  f.svc.contactByNumber = async (...args) => {
    f.svc.account = { id: "40700000099@s.whatsapp.net", name: "Replacement", number: "40700000099" };
    return lookup(...args);
  };
  const result = await f.call("search_messages", { query: "OWNER-RACE-NEEDLE", match: "words" });
  assert.equal(textError(result).error, "NOT_CONNECTED");
  assert.doesNotMatch(JSON.stringify(result), /OWNER-RACE-NEEDLE/);
});

test("a replacement service with matching keys cannot supply another account's search context", async (t) => {
  const f = setup(t),
    replacement = setup(t);
  f.arrive("MATCHING-RACE-KEY");
  replacement.arrive("DIFFERENT-ACCOUNT-WORDS");
  let current = f.svc;
  const source = {
    ...asToolSource(f.svc),
    binding: (id) => (id === "default" ? { id, wa: current } : undefined),
    bindings: () => [{ id: "default", wa: current }],
    defaultBinding: () => ({ id: "default", wa: current }),
  };
  const lookup = f.svc.contactByNumber.bind(f.svc);
  f.svc.contactByNumber = async (...args) => {
    current = replacement.svc;
    return lookup(...args);
  };
  const { call } = schemaCheckedTools(source, { allowWrite: false, legacyReads: true });
  const result = await call("search_messages", { query: "MATCHING-RACE-KEY", match: "words" });
  assert.equal(textError(result).error, "NOT_CONNECTED");
  assert.doesNotMatch(JSON.stringify(result), /MATCHING-RACE-KEY|DIFFERENT-ACCOUNT-WORDS/);
});

test("multi-account search rechecks a tag added after the other account already finished", async (t) => {
  const home = setup(t),
    work = setup(t);
  home.arrive("SHARED-RACE-NEEDLE");
  work.arrive("SHARED-RACE-NEEDLE");
  const lookup = work.svc.contactByNumber.bind(work.svc);
  work.svc.contactByNumber = async (...args) => {
    await new Promise((resolve) => setImmediate(resolve));
    work.svc.db.identity.updateFields(PEER, { addTags: ["private"] });
    return lookup(...args);
  };
  const bindings = [
    { id: "home", wa: home.svc },
    { id: "work", wa: work.svc },
  ];
  const source = {
    ...asToolSource(home.svc),
    binding: (id) => bindings.find((b) => b.id === id),
    bindings: () => bindings,
    defaultBinding: () => bindings[0],
  };
  const { call } = schemaCheckedTools(source, { allowWrite: false, legacyReads: true });
  const result = await call("search_messages", { query: "SHARED-RACE-NEEDLE", match: "words", all_accounts: true });
  assert.equal(result.structuredContent.count, 0);
  assert.deepEqual(result.structuredContent.contexts, []);
});
