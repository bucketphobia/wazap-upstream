/**
 * A long message read back whole. Lists cut each text at 500 characters so a
 * page of chat stays small; get_message is the one message and never cuts,
 * and full_text on read_messages and search asks a list for every character.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";

// 2000 characters, the last ten distinct so a cut anywhere shows.
const LONG = `contract ${"x".repeat(1981)}SFARSIT-OK`;
assert.equal(LONG.length, 2000);

function setup() {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-fulltext-", id: ME, name: "Răzvan" });
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: ANA, fromMe: false, id: "LONG1" },
        message: { conversation: LONG },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
  });
  return { call, messageId: `false_${ANA}_LONG1` };
}

/** The rendered text holds the whole message, not a prefix with an ellipsis. */
function assertWhole(result) {
  const text = result.content[0].text;
  assert.ok(text.includes(LONG), "every one of the 2000 characters is in the text");
  assert.ok(!text.includes(`${LONG.slice(0, 500)}…`), "no cut at 500");
}

/** The rendered text holds the first 500 characters and an ellipsis, never the end. */
function assertCut(result) {
  const text = result.content[0].text;
  assert.ok(text.includes(`${LONG.slice(0, 500)}…`), "cut at 500 with an ellipsis");
  assert.ok(!text.includes("SFARSIT-OK"), "the tail is left out");
}

test("get_message returns a 2000-character message whole", async () => {
  const { call, messageId } = setup();
  const result = await call("get_message", { message_id: messageId });
  assertWhole(result);
  assert.equal(result.structuredContent.text, LONG);
});

test("read_messages cuts a long text by default and keeps it whole with full_text", async () => {
  const { call } = setup();
  const listed = await call("read_messages", { chat_id: ANA });
  assertCut(listed);
  assert.equal(listed.structuredContent.messages[0].text, LONG, "the structured content was never cut");

  assertCut(await call("read_messages", { chat_id: ANA, full_text: false }));
  assertWhole(await call("read_messages", { chat_id: ANA, full_text: true }));
});

test("search by words cuts a long text by default and keeps it whole with full_text", async () => {
  const { call } = setup();
  assertCut(await call("search", { query: "contract", match: "words" }));
  const whole = await call("search", { query: "contract", match: "words", full_text: true });
  assertWhole(whole);
  assert.equal(whole.structuredContent.messages[0].text, LONG);
});

test("search by meaning honours full_text the same way", async () => {
  const message = {
    message_id: `false_${ANA}_LONG1`,
    chat_id: ANA,
    sender: { id: ANA, name: "Ana" },
    from_me: false,
    timestamp: "2026-10-15T10:00:00+03:00",
    age: "now",
    type: "text",
    text: LONG,
  };
  const wa = {
    recall: async () => ({
      data: { hits: [{ message, score: 0.9, similarity: 0.9, matched: "both" }], index: { state: "ready", indexed: 1, pending: 0 } },
      sync: "done",
    }),
    resolveSender: async (m) => m,
  };
  const { tools } = schemaCheckedTools(wa, { allowWrite: false });
  const run = (args) => tools.get("search").handler({ query: "contract", match: "hybrid", limit: 20, ...args });
  assertCut(await run({}));
  assertWhole(await run({ full_text: true }));
});

test("stories cut a long text at 300 by default and keep it whole with full_text", async () => {
  const story = {
    message_id: `false_status@broadcast_S1`,
    chat_id: "status@broadcast",
    sender: { id: ANA, name: "Ana" },
    from_me: false,
    timestamp: "2026-10-15T10:00:00+03:00",
    age: "now",
    type: "text",
    text: LONG,
  };
  const wa = { getStories: async () => ({ data: [story], sync: "done" }) };
  const { tools } = schemaCheckedTools(wa, { allowWrite: false });
  const run = (args) => tools.get("read_messages").handler({ chat_id: "status", limit: 20, include_previews: false, ...args });
  const cut = (await run({})).content[0].text;
  assert.ok(cut.includes(`${LONG.slice(0, 300)}…`), "a story is cut at 300");
  assert.ok(!cut.includes("SFARSIT-OK"));
  assertWhole(await run({ full_text: true }));
});
