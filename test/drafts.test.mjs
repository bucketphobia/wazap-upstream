import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountDb } from "../dist/db/index.js";
import { DraftStore, formatDraftPreview, formatToLine, looksUnnamed, renderDraft } from "../dist/drafts.js";
import { registerTools } from "../dist/tools.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { asToolSource, connectedService, draftStub, offlineConfig, openService } from "./helpers.mjs";

const ANA = { chat_id: "40722@s.whatsapp.net", name: "Ana", number: "40722123456" };
const BLOC = { chat_id: "120363@g.us", name: "Bloc 12" };

/** The store over a throwaway account database, on a clock the test moves. */
function storeAt(t, ttlMs = 15 * 60_000, cap = 20, accountCap = 200) {
  let now = 1_700_000_000_000;
  const dir = mkdtempSync(join(tmpdir(), "wazap-drafts-"));
  const db = AccountDb.open(join(dir, "wazap.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const store = new DraftStore(() => now, ttlMs, cap, accountCap);
  let keys = 0;
  return {
    store,
    sends: db.sends,
    put: (to, payload, owner) => store.put(db.sends, to, payload, `KEY${++keys}`, owner),
    advance: (ms) => (now += ms),
  };
}

const textPayload = { kind: "text", chatId: ANA.chat_id, text: "Joi la 10 e perfect." };
const RECEIPT = { message_id: `true_${ANA.chat_id}_KEY1`, chat_id: ANA.chat_id, text: "Joi la 10 e perfect.", timestamp: "now" };

test("put returns a preview; a claim takes it once, a release gives it back, a settled one answers its receipt", (t) => {
  const { store, sends, put } = storeAt(t);
  const draft = put(ANA, textPayload, "session-a");
  assert.match(draft.id, /^d_[0-9a-f]{16}$/);
  assert.equal(draft.keyId, "KEY1");
  assert.equal(draft.preview, `To: Ana (+40 722 123 456)\n"Joi la 10 e perfect."`);
  const view = store.view(draft);
  assert.equal(view.status, "draft");
  assert.equal(view.kind, "text");
  assert.equal(view.draft_id, draft.id);
  assert.equal(store.has(sends, draft.id), true);

  const claim = store.claim(sends, draft.id, "session-a");
  assert.equal(claim.state, "claimed");
  assert.deepEqual(claim.draft, draft, "the draft comes back as it was frozen");
  assert.throws(() => store.claim(sends, draft.id, "session-a"), { code: "SEND_OUTCOME_UNKNOWN" });
  store.release(sends, draft.id);
  assert.equal(store.claim(sends, draft.id, "session-a").state, "claimed");
  store.settle(sends, draft.id, RECEIPT);
  assert.deepEqual(store.claim(sends, draft.id, "session-a"), { state: "sent", receipt: { ...RECEIPT, already_sent: true } });
  assert.deepEqual(store.claim(sends, draft.id, "session-a"), { state: "sent", receipt: { ...RECEIPT, already_sent: true } });
  assert.throws(() => store.claim(sends, draft.id, "session-b"), { code: "DRAFT_NOT_FOUND" });
  assert.throws(() => store.claim(sends, draft.id), { code: "DRAFT_NOT_FOUND" });
});

test("an expired draft is DRAFT_EXPIRED, not NOT_FOUND, and only for its owner", (t) => {
  const { store, sends, put, advance } = storeAt(t, 1_000);
  const draft = put(ANA, textPayload, "session-a");
  advance(1_001);
  assert.throws(() => store.claim(sends, draft.id, "session-b"), { code: "DRAFT_NOT_FOUND" });
  assert.throws(
    () => store.claim(sends, draft.id, "session-a"),
    (err) => err.code === "DRAFT_EXPIRED" && /show the new preview and wait for a new yes: the yes given to the expired draft does not carry over/.test(err.fix)
  );
  assert.throws(
    () => store.claim(sends, draft.id, "session-a"),
    (err) => err.code === "DRAFT_NOT_FOUND" && /wait for a new yes/.test(err.fix)
  );
});

test("put sweeps expired drafts and evicts the owner's oldest at the cap, never another owner's or a send", (t) => {
  const { store, sends, put, advance } = storeAt(t, 10_000, 2);
  const first = put(ANA, textPayload, "a");
  const other = put(ANA, textPayload, "b");
  advance(1);
  const sending = put(ANA, { ...textPayload, text: "claimed" }, "a");
  assert.equal(store.claim(sends, sending.id, "a").state, "claimed");
  advance(1);
  put(ANA, { ...textPayload, text: "second" }, "a");
  advance(1);
  put(ANA, { ...textPayload, text: "third" }, "a");
  assert.equal(store.has(sends, first.id), false, "the owner's oldest draft made room");
  assert.equal(store.has(sends, other.id), true, "another session's draft is not the owner's to evict");
  assert.equal(store.has(sends, sending.id), true, "a send under way is never evicted");

  advance(10_000);
  put(ANA, { ...textPayload, text: "fresh" }, "c");
  assert.equal(store.has(sends, other.id), false, "an expired draft is swept");
  assert.equal(store.has(sends, sending.id), true, "a send under way is never swept");
});

test("the account keeps at most its cap of drafts across sessions: the oldest goes, never a send", (t) => {
  const { store, sends, put, advance } = storeAt(t, 10_000, 2, 3);
  const oldest = put(ANA, textPayload, "a");
  advance(1);
  const claimed = put(ANA, textPayload, "b");
  assert.equal(store.claim(sends, claimed.id, "b").state, "claimed");
  advance(1);
  const second = put(ANA, textPayload, "c");
  advance(1);
  const third = put(ANA, textPayload, "d");
  advance(1);
  const fourth = put(ANA, textPayload, "e");
  assert.equal(store.has(sends, oldest.id), false, "the account's oldest draft made room, whoever drafted it");
  assert.equal(store.has(sends, claimed.id), true, "a send under way is not a draft to evict");
  for (const kept of [second, third, fourth]) assert.equal(store.has(sends, kept.id), true);
});

test("To: line names a group without a number, and a nameless jid without parens", () => {
  assert.equal(formatToLine(BLOC), "To: Bloc 12 (group)");
  assert.equal(formatToLine({ chat_id: "x@s.whatsapp.net", name: "unknown" }), "To: unknown");
});

test("preview bodies cover every draft kind", () => {
  assert.equal(formatDraftPreview(ANA, textPayload), `To: Ana (+40 722 123 456)\n"Joi la 10 e perfect."`);
  assert.equal(
    formatDraftPreview(ANA, {
      kind: "media",
      chatId: ANA.chat_id,
      source: { file_path: "/tmp/contract.pdf" },
      asDocument: true,
      asVoice: false,
      caption: "actele",
    }),
    `To: Ana (+40 722 123 456)\n[document] contract.pdf\n"actele"`
  );
  assert.equal(
    formatDraftPreview(BLOC, {
      kind: "poll",
      chatId: BLOC.chat_id,
      question: "Pizza or pasta?",
      options: ["Pizza", "Pasta"],
      multiSelect: false,
    }),
    "To: Bloc 12 (group)\n[poll] Pizza or pasta?\nPizza / Pasta"
  );
  assert.equal(
    formatDraftPreview(ANA, {
      kind: "location",
      chatId: ANA.chat_id,
      latitude: 44.4,
      longitude: 26.1,
      name: "Notar",
      address: "Str. Lunii 14",
    }),
    "To: Ana (+40 722 123 456)\n[location] Notar\nStr. Lunii 14"
  );
  assert.equal(
    formatDraftPreview(ANA, { kind: "forward", chatId: ANA.chat_id, messageId: "m1", text: "factura" }),
    `To: Ana (+40 722 123 456)\nForward: "factura"`
  );
});

test("looksUnnamed trips on digits and unresolved lids, not on real names", () => {
  assert.equal(looksUnnamed({ chat_id: "40700999888@s.whatsapp.net", name: "40700999888" }), true);
  assert.equal(looksUnnamed({ chat_id: "40700999888@s.whatsapp.net", name: "+40 700 999 888" }), true);
  assert.equal(looksUnnamed({ chat_id: "x@lid", name: "unknown (lid …1234)" }), true);
  assert.equal(looksUnnamed({ chat_id: "x@s.whatsapp.net", name: "unknown" }), true);
  assert.equal(looksUnnamed({ chat_id: "x@s.whatsapp.net", name: "flormidable15" }), false);
  assert.equal(looksUnnamed({ chat_id: "x@g.us", name: "Bloc 12" }), false);
});

test("renderDraft says it is not sent, when it expires, shows the preview, and ends with the notes and the next step it is given", () => {
  const store = draftStub();
  const draft = store.put(ANA, textPayload);
  const text = renderDraft(store.view(draft), ["A note."], "The next step.");
  assert.match(text, new RegExp(`^Draft ${draft.id}\\. Not sent\\. Expires at \\d{2}:\\d{2}\\.`));
  assert.match(text, /To: Ana \(\+40 722 123 456\)\n"Joi la 10 e perfect\."/);
  assert.match(text, /\n\nA note\.\nThe next step\.$/);
});

test("a draft's text carries its notes and its next step word for word, an unnamed recipient's note included", async () => {
  const server = fakeServer();
  const nobody = { chat_id: "40700999888@s.whatsapp.net", name: "40700999888", number: "40700999888" };
  registerTools(server, asToolSource(previewApi(nobody)), { allowWrite: true });
  const drafted = await server.tools.get("send_message").handler({ chat_id: nobody.chat_id, text: "hi" });
  const { notes, next } = drafted.structuredContent;
  assert.match(notes.join(" "), /not a saved contact/);
  for (const line of [...notes, next]) assert.ok(drafted.content[0].text.includes(line), line);
  // One approval rule, whichever rendering a client reads.
  assert.match(next, /a send asked in the same request that gave the text is that approval/);
});

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

/**
 * A wa stub that plays the service's side of the draft contract: the payload
 * is stored against the resolved recipient, and a forward carries the original
 * message's text the way WhatsAppService.draft fills it.
 */
function previewApi(to, store = draftStub()) {
  return {
    store,
    draft: async (payload) =>
      store.view(store.put(to, payload.kind === "forward" ? { ...payload, text: "factura de plătit" } : payload)),
    confirm: async (id) => {
      const draft = store.take(id);
      const text = draft.payload.kind === "text" ? draft.payload.text : "";
      return { message_id: "mid", chat_id: draft.to.chat_id, text, timestamp: "now" };
    },
  };
}

test("every kind of draft renders the resolved recipient and the exact body", async () => {
  const server = fakeServer();
  registerTools(server, asToolSource(previewApi(ANA)), { allowWrite: true });
  const call = (name, args) => server.tools.get(name).handler(args);

  const text = await call("send_message", { chat_id: ANA.chat_id, text: "Joi la 10." });
  assert.match(text.content[0].text, /^Draft d_[0-9a-f]{16}\. Not sent\./);
  assert.match(text.content[0].text, /To: Ana \(\+40 722 123 456\)\n"Joi la 10\."/);
  assert.equal(text.structuredContent.kind, "text");
  assert.equal(text.structuredContent.to.number, "40722123456");

  const media = await call("send_message", {
    chat_id: ANA.chat_id,
    file_path: "/tmp/acte finale.pdf",
    text: "contract",
  });
  assert.match(media.content[0].text, /\[media\] acte finale\.pdf\n"contract"/);
  assert.equal(media.structuredContent.kind, "media");

  const poll = await call("send_message", {
    chat_id: ANA.chat_id,
    text: "Pizza sau paste?",
    options: ["Pizza", "Paste"],
    multi_select: true,
  });
  assert.match(poll.content[0].text, /\[poll\] Pizza sau paste\? \(multiple answers\)\nPizza \/ Paste/);
  assert.equal(poll.structuredContent.kind, "poll");

  const location = await call("send_message", {
    chat_id: ANA.chat_id,
    latitude: 44.4,
    longitude: 26.1,
    text: "Notar",
    address: "Str. Lunii 14",
  });
  assert.match(location.content[0].text, /\[location\] Notar\nStr\. Lunii 14/);
  assert.equal(location.structuredContent.kind, "location");

  const forward = await call("send_message", { chat_id: ANA.chat_id, text: "", forward: "m-1" });
  assert.match(forward.content[0].text, /To: Ana \(\+40 722 123 456\)\nForward: "factura de plătit"/);
  assert.equal(forward.structuredContent.kind, "forward");
});

test("a group draft names the group, with no number in the To line", async () => {
  const server = fakeServer();
  registerTools(server, asToolSource(previewApi(BLOC)), { allowWrite: true });
  const result = await server.tools.get("send_message").handler({ chat_id: BLOC.chat_id, text: "ne vedem" });
  assert.match(result.content[0].text, /To: Bloc 12 \(group\)/);
});

test("confirm_send on a missing draft says to draft again first", async () => {
  const server = fakeServer();
  registerTools(server, asToolSource(previewApi(ANA)), { allowWrite: true });
  const result = await server.tools.get("confirm_send").handler({ draft_id: "d_nope" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "DRAFT_NOT_FOUND");
  assert.match(result.structuredContent.fix, /send_message/);
  assert.match(result.structuredContent.fix, /confirm_send/);
});

test("confirm_send on an expired draft says to show the new preview", async () => {
  let now = 0;
  const api = previewApi(ANA, draftStub(() => now, 1_000));
  const server = fakeServer();
  registerTools(server, asToolSource(api), { allowWrite: true });

  const drafted = await server.tools.get("send_message").handler({ chat_id: ANA.chat_id, text: "hi" });
  now += 2_000;
  const result = await server.tools.get("confirm_send").handler({ draft_id: drafted.structuredContent.draft_id });
  assert.equal(result.structuredContent.error, "DRAFT_EXPIRED");
  assert.match(result.structuredContent.fix, /show the new preview/);
});

const PEER = "40722123456@s.whatsapp.net";

test("draft rejects a missing local file before it touches the socket", async () => {
  const svc = openService(WhatsAppService, offlineConfig("wazap-draft-media-"));
  await assert.rejects(
    () =>
      svc.draft({
        kind: "media",
        chatId: PEER,
        source: { file_path: "/no/such/wazap-media.bin" },
        asDocument: false,
        asVoice: false,
      }),
    (err) => err.code === "FILE_NOT_FOUND"
  );
  await svc.stop();
});

test("a confirm that fails before the send leaves gives the draft back; one that fails after it is never sent again", async () => {
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-draft-putback-",
    id: "40700000000@s.whatsapp.net",
    name: "Răzvan",
    config: { readOnly: false },
  });
  sock.onWhatsApp = async () => [{ exists: true }];
  let calls = 0;
  sock.relayMessage = async () => {
    calls++;
    throw new Error("Connection Closed");
  };
  const view = await svc.draft({ kind: "text", chatId: PEER, text: "hi" });
  svc.status = "connecting";
  await assert.rejects(() => svc.confirm(view.draft_id), { code: "NOT_CONNECTED" });
  assert.equal(calls, 0);
  svc.status = "connected";
  await assert.rejects(() => svc.confirm(view.draft_id), { code: "SEND_OUTCOME_UNKNOWN" });
  await assert.rejects(() => svc.confirm(view.draft_id), { code: "SEND_OUTCOME_UNKNOWN" });
  assert.equal(calls, 1, "a send that reached the socket is not tried again");
  await svc.stop();
});

test("beginWrite spends the session write bucket", async () => {
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-write-bucket-",
    id: "40700000000@s.whatsapp.net",
    name: "Răzvan",
    config: { readOnly: false, rateLimitPerMinute: 2 },
  });
  sock.chatModify = async () => {};
  await svc.manageChat(PEER, "pin");
  await svc.manageChat(PEER, "unpin");
  await assert.rejects(
    () => svc.manageChat(PEER, "pin"),
    (err) => err.code === "RATE_LIMITED"
  );
  await svc.stop();
});
