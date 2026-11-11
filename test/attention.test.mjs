/**
 * What turns a catch-up into attention: waiting for what arrives, seeing what
 * was sent, and knowing who is still waiting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { z } from "zod";

import { WhatsAppService } from "../dist/whatsapp.js";
import { registerTools } from "../dist/tools.js";
import { asToolSource, connectedService, schemaCheckedTools } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, meta, handler) {
      tools.set(name, { meta, handler });
    },
  };
}

function setup() {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-attention-", id: ME, name: "Răzvan" });
  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: false });
  sock.ev.emit("contacts.upsert", [
    { id: ANA, name: "Ana" },
    { id: DAN, name: "Dan" },
  ]);
  // Through the schema, so defaults apply the way they do over MCP.
  const call = (name, args = {}) => {
    const { meta, handler } = server.tools.get(name);
    return handler(z.object(meta.inputSchema).parse(args));
  };
  let seq = 0;
  const arrive = (chat, content, { fromMe = false, participant, at = Date.now() } = {}) => {
    const id = `M${++seq}`;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) },
          message: typeof content === "string" ? { conversation: content } : content,
          messageTimestamp: Math.floor(at / 1000),
        },
      ],
    });
    return id;
  };
  return { svc, sock, call, arrive };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("read_messages past the oldest held message asks the phone, and an answer with nothing says so instead of reading as the chat's start", async () => {
  const { svc, sock, arrive } = setup();
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  const at = Date.now() - 3_600_000;
  arrive(ANA, "a doua zi", { at });
  arrive(ANA, "a treia zi", { at: at + 60_000 });
  const asked = [];
  // The phone answers each ask with a history batch: first with nothing for this chat, then with one older message.
  let batch = [];
  sock.fetchMessageHistory = async (count, key) => {
    asked.push(key.id);
    setImmediate(() => sock.ev.emit("messaging-history.set", { chats: [], contacts: [], messages: batch, isLatest: false }));
    return `history-${asked.length}`;
  };

  const newest = (await call("read_messages", { chat_id: ANA, limit: 5 })).structuredContent;
  assert.equal(newest.older, undefined, "a page the store holds asks nobody");
  const oldest = newest.messages[0].message_id;
  const held = (await call("read_messages", { chat_id: ANA, limit: 5, before: newest.messages[1].message_id })).structuredContent;
  assert.deepEqual([held.count, held.older, asked.length], [1, undefined, 0]);

  const none = (await call("read_messages", { chat_id: ANA, limit: 5, before: oldest })).structuredContent;
  assert.equal(asked.length, 1, "past the oldest held message, the phone is asked");
  assert.equal(none.count, 0);
  assert.deepEqual(none.older, { asked_phone: true, received: 0 });
  assert.match((none.notes ?? []).join(" "), /The phone was asked for older messages and sent none: older history may still exist there\. Say so; do not say there are none\./);

  batch = [{ key: { remoteJid: ANA, fromMe: false, id: "OLD1" }, message: { conversation: "prima zi" }, messageTimestamp: Math.floor((at - 86_400_000) / 1000) }];
  const found = (await call("read_messages", { chat_id: ANA, limit: 5, before: oldest })).structuredContent;
  assert.equal(asked.length, 2);
  assert.deepEqual(found.messages.map((m) => m.text), ["prima zi"]);
  assert.deepEqual(found.older, { asked_phone: true, received: 1 });
  assert.equal(found.notes, undefined, "what came back needs no caveat");
  await svc.stop();
});

test("wait_for_messages returns the message that lands while it waits, and nothing of the user's own", async () => {
  const { call, arrive } = setup();
  const waiting = call("wait_for_messages", { timeout_seconds: 5 });
  await sleep(30);
  arrive(ANA, "mâine la 10?", { fromMe: true });
  arrive(ANA, "ești liber mâine la 10?");
  const result = await waiting;
  assert.equal(result.structuredContent.timed_out, false);
  assert.deepEqual(
    result.structuredContent.messages.map((m) => [m.sender.name, m.text]),
    [["Ana", "ești liber mâine la 10?"]]
  );
  assert.match(result.content[0].text, /1 new message/);
  assert.match(result.content[0].text, /cursor: \S+ \(pass it to the next wait_for_messages\)/);
});

test("a burst that follows the first message comes back in the same answer", async () => {
  const { call, arrive } = setup();
  const waiting = call("wait_for_messages", { timeout_seconds: 5 });
  await sleep(20);
  arrive(ANA, "salut");
  await sleep(200);
  arrive(ANA, "ai o secundă?");
  const result = await waiting;
  assert.deepEqual(
    result.structuredContent.messages.map((m) => m.text),
    ["salut", "ai o secundă?"]
  );
});

test("the cursor replays what landed between two calls, and a timeout comes back empty", async () => {
  const { call, arrive } = setup();
  const first = await call("wait_for_messages", { timeout_seconds: 1 });
  assert.equal(first.structuredContent.timed_out, true);
  assert.deepEqual(first.structuredContent.messages, []);
  assert.match(first.content[0].text, /Nothing arrived/);

  arrive(DAN, "poți să mă suni?");
  const started = Date.now();
  const second = await call("wait_for_messages", { timeout_seconds: 30, cursor: first.structuredContent.cursor });
  assert.ok(Date.now() - started < 3_000, "did not block: the message was already there");
  assert.deepEqual(
    second.structuredContent.messages.map((m) => m.text),
    ["poți să mă suni?"]
  );

  const third = await call("wait_for_messages", { timeout_seconds: 1, cursor: second.structuredContent.cursor });
  assert.deepEqual(third.structuredContent.messages, [], "nothing is replayed twice");
});

test("a cursor from another run of wazap starts the wait from now and says so", async () => {
  const { call, arrive } = setup();
  arrive(ANA, "before");
  const result = await call("wait_for_messages", { timeout_seconds: 1, cursor: "deadbeef:1" });
  assert.equal(result.structuredContent.cursor_reset, true);
  assert.deepEqual(result.structuredContent.messages, []);
  assert.match(result.content[0].text, /another run/);
});

test("addressed_to_me wakes for a direct message, a mention and a reply, not for group chatter", async () => {
  const { call, arrive } = setup();
  const waiting = call("wait_for_messages", { timeout_seconds: 3, addressed_to_me: true });
  await sleep(20);
  arrive(GROUP, "cineva vine la 12?", { participant: DAN });
  await sleep(100);
  arrive(
    GROUP,
    { extendedTextMessage: { text: "@Răzvan poți?", contextInfo: { mentionedJid: [ME] } } },
    { participant: DAN }
  );
  const result = await waiting;
  assert.deepEqual(
    result.structuredContent.messages.map((m) => m.text),
    ["@Răzvan poți?"],
    "only the mention"
  );

  const chatOnly = call("wait_for_messages", {
    timeout_seconds: 3,
    chat_id: ANA,
    cursor: result.structuredContent.cursor,
  });
  await sleep(20);
  arrive(DAN, "ignored, wrong chat");
  arrive(ANA, "și eu");
  assert.deepEqual(
    (await chatOnly).structuredContent.messages.map((m) => m.text),
    ["și eu"]
  );
});

test("include_previews attaches the preview WhatsApp shipped with a photo and labels its line", async () => {
  const { call, arrive } = setup();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  arrive(ANA, { imageMessage: { mimetype: "image/jpeg", jpegThumbnail: jpeg, caption: "chitanța" } });
  arrive(ANA, "gata");

  const plain = await call("read_messages", { chat_id: ANA });
  assert.equal(plain.content.length, 1, "no image block unless asked");

  const read = await call("read_messages", { chat_id: ANA, include_previews: true });
  assert.equal(read.structuredContent.preview_count, 1);
  assert.equal(read.content.length, 2);
  assert.deepEqual(read.content[1], {
    type: "image",
    data: Buffer.from(jpeg).toString("base64"),
    mimeType: "image/jpeg",
  });
  assert.match(read.content[0].text, /1 preview attached/);
  // The line says which message the preview is of; "[image]" opens its text, so no tag repeats it.
  assert.match(read.content[0].text, /\[preview 1\] · false_/);
});

test("a read attaches at most six previews, names each one's message, and counts the photos left without", async () => {
  const { call, arrive } = setup();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const photos = Array.from({ length: 8 }, (_, i) => arrive(ANA, { imageMessage: { mimetype: "image/jpeg", jpegThumbnail: jpeg, caption: `poza ${i + 1}` } }, { at: Date.now() - (8 - i) * 60_000 }));
  const read = await call("read_messages", { chat_id: ANA, include_previews: true });
  assert.equal(read.structuredContent.preview_count, 6);
  assert.equal(read.content.filter((block) => block.type === "image").length, 6);
  // Newest first, each named by its message_id in the text and in `previews`.
  const ids = photos.map((id) => `false_${ANA}_${id}`).reverse().slice(0, 6);
  assert.deepEqual(read.structuredContent.previews, ids);
  const text = read.content[0].text;
  ids.forEach((id, i) => {
    assert.ok(text.includes(`preview ${i + 1} is ${id}`), `preview ${i + 1}`);
    assert.match(text, new RegExp(`\\[preview ${i + 1}\\] · ${id}`));
  });
  assert.match(text, /2 photos without a preview \(over 6 per call/);
  assert.ok(read.structuredContent.notes.some((note) => text.includes(note)), "the note, word for word");
});

test("a photo that shipped no preview is downloaded once, shrunk here, and remembered", async () => {
  const { svc, call, arrive } = setup();
  const { encode } = await import("jpeg-js");
  const width = 640;
  const height = 480;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([200, 30, 30, 255], i * 4);
  const photo = encode({ data, width, height }, 90).data;
  let downloads = 0;
  svc.mediaBuffer = async () => {
    downloads++;
    return photo;
  };
  arrive(ANA, { imageMessage: { mimetype: "image/jpeg", fileLength: photo.length, caption: "poza" } });
  arrive(DAN, { imageMessage: { mimetype: "image/jpeg", url: "https://x/expired" } });
  svc.mediaBuffer = async (_sock, sid) => {
    downloads++;
    if (sid.includes(DAN)) throw new Error("410 gone");
    return photo;
  };

  const first = await call("read_messages", { chat_id: ANA, include_previews: true });
  const expired = await call("read_messages", { chat_id: DAN, include_previews: true });
  assert.equal(downloads, 2, "each photo fetched once");
  assert.equal(expired.structuredContent.preview_count, 0, "the expired one goes without");
  assert.match(expired.content[0].text, /1 photo without a preview/);
  assert.match((expired.structuredContent.notes ?? []).join(" "), /1 photo without a preview/, "said in the structured content too");
  assert.equal(first.structuredContent.notes, undefined);
  assert.equal(first.structuredContent.preview_count, 1);
  const block = first.content[1];
  assert.equal(block.type, "image");
  const { decode } = await import("jpeg-js");
  const small = decode(Buffer.from(block.data, "base64"));
  assert.deepEqual([small.width, small.height], [320, 240], "shrunk to the preview edge");
  assert.ok(block.data.length < 20_000, `a preview stays small: ${block.data.length} b64 chars`);

  const again = await call("read_messages", { chat_id: ANA, include_previews: true });
  assert.equal(downloads, 2, "the second time it comes from the cache");
  assert.equal(again.structuredContent.preview_count, 1);
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  assert.ok(existsSync(join(svc.paths.previewsDir, `false_${ANA}_M1.jpg`)), "and lives on disk, outside the database");
  assert.deepEqual(
    svc.db.messages.media(`false_${ANA}_M1`).map((m) => [m.kind, m.path]),
    [["preview", join(svc.paths.previewsDir, `false_${ANA}_M1.jpg`)]],
    "the database records the file against its message, so a delete takes it too"
  );
});

test("a video gets one frame as its preview when ffmpeg is there", async (t) => {
  const { which } = await import("../dist/transcribe/local.js");
  const ffmpeg = which("ffmpeg");
  if (ffmpeg === null) return t.skip("ffmpeg not installed");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wazap-frame-test-"));
  const clip = join(dir, "clip.mp4");
  await promisify(execFile)(ffmpeg, [
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=640x360:rate=10",
    "-t",
    "2",
    "-pix_fmt",
    "yuv420p",
    clip,
  ]);
  const mp4 = readFileSync(clip);

  const { svc, call, arrive } = setup();
  svc.mediaBuffer = async () => mp4;
  arrive(ANA, { videoMessage: { mimetype: "video/mp4", fileLength: mp4.length, seconds: 2, caption: "uite" } });
  const result = await call("read_messages", { chat_id: ANA, include_previews: true });
  assert.equal(result.structuredContent.preview_count, 1);
  const { decode } = await import("jpeg-js");
  const frame = decode(Buffer.from(result.content[1].data, "base64"));
  assert.deepEqual([frame.width, frame.height], [320, 180], "one frame, shrunk to the preview edge");
});

test("the recent-messages read fetches the metadata of the groups that spoke, so their senders have names", async () => {
  const { svc, arrive } = setup();
  const lid = "777888999000111@lid";
  let fetches = 0;
  svc.sockClient.groupMetadata = async (id) => {
    fetches++;
    return {
      id,
      subject: "Meniul zilei",
      participants: [{ id: lid, phoneNumber: "40700000040@s.whatsapp.net", name: "Rodica" }],
    };
  };
  arrive(GROUP, "meniul de azi", { participant: lid });
  const recent = await svc.getRecentMessages(1, "all");
  assert.equal(fetches, 1);
  assert.deepEqual(
    recent.data[0].messages.map((m) => m.sender.name),
    ["Rodica"]
  );
  await svc.getRecentMessages(1, "all");
  assert.equal(fetches, 1, "and asks once");
});

test("catch_up's waiting lists the people whose ask is still open, people first, and nobody else", async () => {
  const { call, arrive } = setup();
  const hour = 3_600_000;
  arrive(ANA, "poți să-mi trimiți contractul?", { at: Date.now() - 50 * hour });
  arrive(DAN, "mersi", { at: Date.now() - 3 * hour });
  arrive(DAN, "ok", { at: Date.now() - 2 * hour });
  const ELA = "40700000004@s.whatsapp.net";
  arrive(ELA, "când ajungi?", { at: Date.now() - 5 * hour });
  arrive(ELA, "la 6", { fromMe: true, at: Date.now() - 4 * hour });
  const VLAD = "40700000005@s.whatsapp.net";
  arrive(VLAD, "ai o clipă", { at: Date.now() - 4 * hour });
  arrive(VLAD, "?", { at: Date.now() - 4 * hour + 1000 });
  arrive(GROUP, "cine vine la 12?", { participant: DAN, at: Date.now() - hour });
  arrive(
    GROUP,
    { extendedTextMessage: { text: "@Răzvan tu?", contextInfo: { mentionedJid: [ME] } } },
    { participant: DAN, at: Date.now() - hour }
  );
  const LINK = "40700000006@s.whatsapp.net";
  arrive(LINK, "https://youtu.be/abc?si=xyz", { at: Date.now() - hour });
  const OLD = "40700000007@s.whatsapp.net";
  arrive(OLD, "mai ești interesat?", { at: Date.now() - 20 * 24 * hour });

  const all = await call("catch_up", { hours: 24 });
  assert.deepEqual(
    all.structuredContent.waiting.map((entry) => [entry.name, entry.group === true, entry.q, entry.n ?? 1]),
    [
      ["Ana", false, "poți să-mi trimiți contractul?", 1],
      ["40700000005", false, "?", 2],
      ["120363000000000001@g.us", true, "@Răzvan tu?", 2],
    ],
    "thanks, an answered ask, a link's query string and a 20-day-old ask wait on nobody"
  );
  assert.match(all.content[0].text, /## Waiting on you \(3\)/);
  assert.match(all.content[0].text, /"poți să-mi trimiți contractul\?"/);
});

test("a voice note nobody has heard is an ask; a transcribed one is judged on its words", async () => {
  const { svc, call, arrive } = setup();
  const voice = { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: 12 } };
  const id = arrive(ANA, voice);
  let result = await call("catch_up", { hours: 24 });
  assert.deepEqual(
    result.structuredContent.waiting.map((entry) => entry.type),
    ["voice"]
  );

  svc.db.messages.setTranscript(`false_${ANA}_${id}`, "gata, am rezolvat, mersi");
  result = await call("catch_up", { hours: 24 });
  assert.deepEqual(result.structuredContent.waiting, [], "the words say nothing was asked");
});

test("a reaction lands on the message it answers, never as a line of its own, and a withdrawal takes it off", async () => {
  const { svc, call, arrive } = setup();
  const target = arrive(ANA, "am ajuns");
  const react = (text, { fromMe = false } = {}) =>
    arrive(ANA, { reactionMessage: { key: { remoteJid: ANA, fromMe: false, id: target }, text } }, { fromMe });
  react("❤️");
  react("👍", { fromMe: true });

  let read = await call("read_messages", { chat_id: ANA });
  assert.deepEqual(
    read.structuredContent.messages.map((m) => m.text),
    ["am ajuns"],
    "no [reaction] line"
  );
  assert.deepEqual(
    read.structuredContent.messages[0].reactions.map((r) => [r.emoji, r.sender]),
    [
      ["❤️", ANA],
      ["👍", ME],
    ]
  );
  assert.match(read.content[0].text, /\[❤️ 👍\]/);

  react("");
  read = await call("read_messages", { chat_id: ANA });
  assert.deepEqual(
    read.structuredContent.messages[0].reactions.map((r) => r.emoji),
    ["👍"],
    "Ana took hers back"
  );

  const recent = await call("wait_for_messages", { timeout_seconds: 1 });
  assert.equal(recent.structuredContent.timed_out, true, "a reaction wakes no wait");
  assert.deepEqual(
    svc.db.messages.reactions(`false_${ANA}_${target}`).map((r) => [r.jid, r.emoji]),
    [[ME, "👍"]],
    "and it is stored"
  );
});

test("in a group, read_messages counts the reactions and get_message says who left each one", async () => {
  const { call, arrive } = setup();
  const photo = arrive(GROUP, { imageMessage: { mimetype: "image/jpeg" } }, { participant: ANA });
  // Every reaction in the same second, so their order is the order they arrived even when a slow run crosses a second.
  const at = Date.now();
  const react = (text, from) =>
    arrive(
      GROUP,
      { reactionMessage: { key: { remoteJid: GROUP, fromMe: false, id: photo, participant: ANA }, text } },
      from === ME ? { fromMe: true, at } : { participant: from, at }
    );
  react("❤️", ANA);
  react("😍", DAN);
  react("❤️", ME);

  const read = await call("read_messages", { chat_id: GROUP });
  assert.match(read.content[0].text, /\[❤️×2 😍\]/);

  const id = `false_${GROUP}_${photo}`;
  let one = await call("get_message", { message_id: id });
  assert.match(one.content[0].text, /reactions: ❤️ Ana, 😍 Dan, ❤️ Răzvan/);
  assert.deepEqual(
    one.structuredContent.reactions.map((r) => [r.emoji, r.name]),
    [
      ["❤️", "Ana"],
      ["😍", "Dan"],
      ["❤️", "Răzvan"],
    ]
  );

  react("👍", DAN);
  react("", ANA);
  one = await call("get_message", { message_id: id });
  assert.deepEqual(
    one.structuredContent.reactions.map((r) => [r.emoji, r.name]),
    [
      ["👍", "Dan"],
      ["❤️", "Răzvan"],
    ],
    "a changed reaction updates in place, a withdrawn one is gone"
  );
});
