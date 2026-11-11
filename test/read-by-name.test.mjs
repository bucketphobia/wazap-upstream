/**
 * read_messages and search take a chat by name, over the evaluation world
 * through the real HTTP endpoint: "mama", "Ana Vasile" or "Bloc 12" read the
 * one chat find_contact resolves them to, on its account, and the answer says
 * whom; a name that could be several chats, or none, is refused with the
 * candidates and nothing read. Ids and numbers pass through untouched, and
 * send_message never resolves a name.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { controlClient, mcpSession } from "../scripts/eval/client.mjs";
import { isChatName } from "../dist/chat-name.js";
import { childEnv } from "./helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let server;
let ready;
let control;
let s;
let refs;

before(async () => {
  const child = spawn(process.execPath, [join(ROOT, "scripts", "eval", "server.mjs"), "--quiet"], { cwd: ROOT, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const exited = new Promise((done) => child.once("exit", done));
  ready = await new Promise((done, fail) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith("READY ")) done(JSON.parse(line.slice(6)));
    });
    exited.then((code) => fail(new Error(`eval server exited ${code}: ${stderr.join("")}`)));
  });
  server = { child, exited };
  control = controlClient(ready.control_url, ready.control_token);
  await control.reset({});
  refs = await control.refs();
  s = await mcpSession(ready.mcp_url, ready.tokens.write);
});

after(async () => {
  await s?.close();
  await control?.stop().catch(() => server.child.kill("SIGTERM"));
  await server?.exited;
});

/** An error from a tool with an output schema: its JSON text. */
function refusal(result) {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return JSON.parse(result.content[0].text);
}

test("what reads as a name, and what stays an id or a number", () => {
  for (const name of ["mama", "Ana", "Bloc 12", "Mișu", "AP-123"]) assert.equal(isChatName(name), true, name);
  for (const id of ["40711111111@s.whatsapp.net", "120363000000000088@g.us", "+40 733 333 333", "0733333333", "status", "STATUS", " ", "123"]) {
    assert.equal(isChatName(id), false, id);
  }
});

test("read_messages takes a relationship, a name or a group's name, reads that one chat on its account, and says whom", async () => {
  const mama = await s.call("read_messages", { chat_id: "mama" });
  assert.notEqual(mama.isError, true, mama.content[0].text);
  const out = mama.structuredContent;
  assert.equal(out.chat_id, refs.contacts.elena.jid);
  assert.equal(out.account_id, "personal");
  assert.deepEqual(out.resolved, { from: "mama", name: out.resolved.name, kind: "person" });
  assert.match(out.resolved.name, /Elena/);
  assert.ok(out.messages.some((m) => /Ai ajuns cu bine/.test(m.text)));
  assert.match(mama.content[0].text, /^# Messages in Elena[^\n]*\(40711111111@s\.whatsapp\.net\), whom "mama" names/m);

  const vasile = await s.call("read_messages", { chat_id: "Ana Vasile", types: ["image"] });
  assert.equal(vasile.structuredContent.chat_id, refs.contacts.ana_vasile.jid);
  assert.deepEqual(vasile.structuredContent.messages.map((m) => m.message_id), [refs.messages.meter_photo.id]);

  const group = await s.call("read_messages", { chat_id: "Bloc 12", limit: 3 });
  assert.equal(group.structuredContent.chat_id, refs.groups.bloc12.jid);
  assert.equal(group.structuredContent.resolved.kind, "group");
});

test("a name several chats answer to is refused with the candidates, on every account, and nothing is read", async () => {
  const ana = refusal(await s.call("read_messages", { chat_id: "Ana" }));
  assert.equal(ana.error, "CHAT_NOT_FOUND");
  assert.match(ana.message, /^"Ana" could be \d chats: .*Nothing was read\.$/);
  assert.match(ana.fix, /Ask the user which one they mean.*never pick one yourself/);
  const ids = ana.candidates.map((c) => c.chat_id);
  for (const jid of [refs.contacts.ana_vasile.jid, refs.contacts.ana_ionescu.jid]) assert.ok(ids.includes(jid), `${jid} in ${ids}`);
  assert.ok(ana.candidates.every((c) => typeof c.name === "string" && ["personal", "work"].includes(c.account_id)), "several accounts: each candidate names its own");
  assert.doesNotMatch(JSON.stringify(ana), /extras|contor|Bună ziua/, "no message's words");

  const onPersonal = refusal(await s.call("read_messages", { chat_id: "Ana", account_id: "personal" }));
  assert.ok(onPersonal.candidates.length >= 2);
  assert.ok(onPersonal.candidates.every((c) => c.account_id === undefined), "one account: nothing to label");

  const nobody = refusal(await s.call("read_messages", { chat_id: "Zorica Lungu" }));
  assert.equal(nobody.error, "CHAT_NOT_FOUND");
  assert.match(nobody.message, /^No chat is named "Zorica Lungu"/);
});

test("search takes a chat by name the same way; ids and numbers are read as they always were", async () => {
  const found = await s.call("search", { query: "contorul", chat_id: "Ana Vasile", match: "words" });
  assert.notEqual(found.isError, true, found.content[0].text);
  assert.equal(found.structuredContent.resolved.from, "Ana Vasile");
  assert.ok(found.structuredContent.messages.some((m) => m.message_id === refs.messages.meter_photo.id));
  assert.equal(refusal(await s.call("search", { query: "x", chat_id: "Ana" })).error, "CHAT_NOT_FOUND");

  const number = `+${refs.contacts.ana_vasile.jid.split("@")[0]}`;
  const byNumber = await s.call("read_messages", { chat_id: number, limit: 2 });
  assert.equal(byNumber.structuredContent.resolved, undefined);
  assert.equal(byNumber.structuredContent.chat_id, number, "echoed as given, as before");
  assert.equal(byNumber.structuredContent.count, 2);
});

test("the old search_messages takes a name as search does: the one chat, on the account it is on, searched once", async () => {
  // Ana Marin is on the business account, not the session's own: her chat is searched there, its hits judged there.
  const canonical = await s.call("search", { query: "oferta", chat_id: "Ana Marin", match: "words" });
  const ids = canonical.structuredContent.messages.map((m) => m.message_id);
  assert.equal(canonical.structuredContent.account_id, "work");
  assert.ok(ids.length > 0);
  for (const args of [{}, { all_accounts: true }, { account_ids: ["personal", "work"] }]) {
    const legacy = await s.call("search_messages", { query: "oferta", chat_id: "Ana Marin", match: "words", ...args });
    const out = legacy.structuredContent;
    assert.notEqual(legacy.isError, true, legacy.content[0].text);
    assert.deepEqual(out.messages.map((m) => [m.account_id, m.message_id]), ids.map((id) => ["work", id]), JSON.stringify(args));
    assert.deepEqual(out.accounts.map((a) => a.account_id), ["work"], "searched once, on her account");
    assert.equal(out.changed_during_read, undefined);
    assert.equal(out.chat_id, refs.contacts.ana_marin.jid);
    assert.deepEqual(out.resolved, { from: "Ana Marin", name: "Ana Marin", kind: "person" });
  }
  const elsewhere = refusal(await s.call("search_messages", { query: "oferta", chat_id: "Ana Marin", match: "words", account_ids: ["personal"] }));
  assert.equal(elsewhere.error, "CHAT_NOT_FOUND");
  assert.match(elsewhere.message, /account "work", which account_ids does not name/);
  assert.equal(refusal(await s.call("search_messages", { query: "x", chat_id: "Ana", all_accounts: true })).error, "CHAT_NOT_FOUND");
});

test("send_message never resolves a name: a recipient is an id or a number, found with find_contact first", async () => {
  const sent = await s.call("send_message", { chat_id: "mama", text: "Ajung la 7" });
  assert.equal(sent.isError, true);
  assert.equal(sent.structuredContent?.draft_id, undefined);
  assert.notEqual(JSON.parse(sent.content[0].text).error, undefined);
});
