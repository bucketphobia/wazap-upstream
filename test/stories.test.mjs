/**
 * Stories (status updates) arrive on `status@broadcast` with the author as
 * the participant. They are shown in one place, kept apart from the chats,
 * and let go after a day.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools, textError } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const STATUS = "status@broadcast";

function setup(config = {}) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-stories-", id: ME, name: "Răzvan", config });
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  let seq = 0;
  const story = (author, content, { at = Date.now(), pushName } = {}) =>
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: STATUS, fromMe: false, id: `S${++seq}`, participant: author },
          message: typeof content === "string" ? { extendedTextMessage: { text: content } } : content,
          messageTimestamp: Math.floor(at / 1000),
          ...(pushName ? { pushName } : {}),
        },
      ],
    });
  sock.ev.emit("contacts.upsert", [{ id: ANA, name: "Ana" }]);
  return { svc, sock, call, story };
}

test("stories are listed by author, newest first, and show nowhere else", async () => {
  const { call, story } = setup();
  const hour = 3_600_000;
  story(ANA, "la mare 🌊", { at: Date.now() - 3 * hour });
  story(DAN, { imageMessage: { mimetype: "image/jpeg", caption: "apus" } }, { at: Date.now() - hour, pushName: "Dan" });
  story(ANA, "a doua", { at: Date.now() - 25 * hour });

  const result = await call("read_messages", { chat_id: "status" });
  assert.deepEqual(
    result.structuredContent.messages.map((s) => [s.sender.name, s.text]),
    [
      ["Dan", "[image] apus"],
      ["Ana", "la mare 🌊"],
    ],
    "the day-old one is gone, the rest newest first"
  );
  assert.match(result.content[0].text, /## Dan \(\+40 700 000 003\)/);
  assert.ok(!result.content[0].text.split("\n").filter((line) => line.startsWith("## ")).some((line) => line.includes("@")));
  assert.equal(result.structuredContent.messages[0].sender.id, DAN, "the machine address stays available");
  assert.match(result.content[0].text, /- 3h ago · la mare 🌊/);

  const chats = await call("list_chats", {});
  assert.equal(chats.structuredContent.count, 0, "not a chat");
  const wait = await call("wait_for_messages", { timeout_seconds: 1 });
  assert.equal(wait.structuredContent.timed_out, true, "not something a wait wakes for");

  const narrow = await call("read_messages", { chat_id: "status@broadcast", hours: 2 });
  assert.deepEqual(
    narrow.structuredContent.messages.map((s) => s.sender.name),
    ["Dan"]
  );
  const one = await call("read_messages", { chat_id: "status", limit: 1 });
  assert.equal(one.structuredContent.omitted, 1, "a limit says what it left out");
  assert.match(one.content[0].text, /1 older stories left out/);
  assert.match((one.structuredContent.notes ?? []).join(" "), /1 older stories left out: raise limit/, "said in the structured content too");
  assert.equal(textError(await call("read_messages", { chat_id: "status", before: "false_x@s.whatsapp.net_Y" })).error, "INVALID_ID");
});

test("a story never leaks into search either", async () => {
  const { sock, call, story } = setup();
  story(ANA, "la mare 🌊");
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: DAN, fromMe: false, id: "D1" },
        message: { conversation: "ne vedem la mare" },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
  });

  const result = await call("search", { match: "words", query: "mare" });
  assert.deepEqual(
    result.structuredContent.messages.map((m) => m.chat_id),
    [DAN],
    "the chat message hits, the status pseudo-chat does not"
  );
});

test("a story's photo gets a preview and its message id works with the media tools", async () => {
  const { svc, call, story } = setup();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
  story(ANA, { imageMessage: { mimetype: "image/jpeg", jpegThumbnail: jpeg } });
  const result = await call("read_messages", { chat_id: "status", include_previews: true });
  assert.equal(result.structuredContent.preview_count, 1);
  assert.equal(result.content[1].type, "image");
  const id = result.structuredContent.messages[0].message_id;
  const one = await call("get_message", { message_id: id });
  assert.equal(one.structuredContent.sender.name, "Ana");
  assert.equal(svc.db.messages.get(id).chatJid, STATUS);
});

test("stories survive a restart through the database, go after their day, and the user's own are not kept", async () => {
  const { svc, story, sock } = setup({ persistHistory: true });
  story(ANA, "ieri");
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: STATUS, fromMe: true, id: "MINE" },
        message: { conversation: "a mea" },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
  });
  const stored = svc.db.messages.chatPage(STATUS, { limit: 10 }).items;
  assert.deepEqual(stored.map((m) => m.sid), [`false_${STATUS}_S1`]);
  assert.equal(stored[0].expiresAt, stored[0].ts + 24 * 3_600_000, "a story carries its day as its deadline");

  const { svc: again } = connectedService(WhatsAppService, { prefix: "wazap-stories-", id: ME, name: "Răzvan", config: { dataDir: svc.config.dataDir, persistHistory: true } });
  const back = (await again.getStories(24)).data;
  assert.deepEqual(
    back.map((s) => s.text),
    ["ieri"]
  );
  await again.stop();
});
