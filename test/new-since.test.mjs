/**
 * new_since: the messages that arrived or changed after a cursor, across every
 * chat, in the order they changed (messages.change_seq). Driven through the
 * registered tool, each answer checked against its output schema the way an
 * SDK client checks it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const STATUS = "status@broadcast";
const MINUTE = 60_000;

function account({ allowWrite = false } = {}) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-newsince-", id: ME, name: "Răzvan" });
  sock.ev.emit("contacts.upsert", [
    { id: ANA, name: "Ana" },
    { id: DAN, name: "Dan" },
  ]);
  sock.ev.emit("chats.upsert", [{ id: GROUP, name: "Echipa" }]);
  const { call, tools } = schemaCheckedTools(svc, { allowWrite });
  let seq = 0;
  const event = (chat, content, { fromMe = false, participant, at, key = `M${++seq}` } = {}) => ({
    key: { remoteJid: chat, fromMe, id: key, ...(participant ? { participant } : {}) },
    message: typeof content === "string" ? { conversation: content } : content,
    messageTimestamp: Math.floor((at ?? Date.now()) / 1000),
  });
  const arrive = (chat, content, options = {}) => {
    const message = event(chat, content, options);
    sock.ev.emit("messages.upsert", { type: "notify", messages: [message] });
    return `${message.key.fromMe}_${chat}_${message.key.id}`;
  };
  return { svc, sock, call, tools, arrive, event };
}

const ids = (result) => result.structuredContent.messages.map((m) => m.message_id);

test("messages come in the order they reached the account, not the time they were sent", async () => {
  const { call, arrive } = account();
  const now = Date.now();
  const first = arrive(ANA, "sosit primul, trimis mai târziu", { at: now - MINUTE });
  const second = arrive(ANA, "sosit al doilea, trimis mai devreme", { at: now - 30 * MINUTE });
  const result = await call("new_since", {});
  assert.deepEqual(ids(result), [first, second]);
  assert.deepEqual([result.structuredContent.after, result.structuredContent.more, result.structuredContent.count], [0, false, 2]);
  assert.equal(result.structuredContent.through, result.structuredContent.top, "an exhausted window ends at the top");
  assert.match(result.content[0].text, /sosit al doilea/);
});

test("limit pages the window: through is the last number listed while more remain, then the top, with no overlap and no gap", async () => {
  const { call, arrive } = account();
  const sent = [1, 2, 3, 4, 5].map((n) => arrive(n % 2 ? ANA : GROUP, `mesaj ${n}`, { participant: n % 2 ? undefined : DAN }));
  const seen = [];
  let after = 0;
  const pages = [];
  for (;;) {
    const page = await call("new_since", { after, limit: 2 });
    pages.push([page.structuredContent.count, page.structuredContent.more]);
    seen.push(...ids(page));
    assert.equal(page.structuredContent.after, after);
    if (!page.structuredContent.more) {
      assert.equal(page.structuredContent.through, page.structuredContent.top);
      break;
    }
    assert.ok(page.structuredContent.through > after && page.structuredContent.through < page.structuredContent.top);
    after = page.structuredContent.through;
  }
  assert.deepEqual(pages, [[2, true], [2, true], [1, false]]);
  assert.deepEqual(seen, sent);
  const nothing = await call("new_since", { after: after + 100 });
  assert.deepEqual([nothing.structuredContent.count, nothing.structuredContent.more], [0, false]);
});

test("an edit, a deletion for everyone and a late transcript list the message again, in its current state; the same message stored again does not", async () => {
  const { svc, sock, call, arrive, event } = account();
  const sentAt = Date.now() - MINUTE;
  const text = arrive(ANA, "prima versiune", { at: sentAt });
  const note = arrive(ANA, { audioMessage: { ptt: true, seconds: 4 } });
  const doomed = arrive(DAN, "va dispărea");
  const checkpoint = async () => (await call("new_since", {})).structuredContent.through;

  let mark = await checkpoint();
  // The same message again changes nothing a reader sees.
  sock.ev.emit("messages.upsert", { type: "notify", messages: [event(ANA, "prima versiune", { key: "M1", at: sentAt })] });
  const replay = await call("new_since", { after: mark });
  assert.deepEqual(ids(replay), [], "a replay is not a change");

  sock.ev.emit("messages.update", [{ key: { remoteJid: ANA, fromMe: false, id: "M1" }, update: { message: { editedMessage: { message: { conversation: "a doua versiune" } } } } }]);
  const edited = await call("new_since", { after: mark });
  assert.deepEqual(edited.structuredContent.messages.map((m) => [m.message_id, m.text, m.edited]), [[text, "a doua versiune", true]]);
  assert.ok(edited.structuredContent.through > mark);
  mark = edited.structuredContent.through;

  svc.db.messages.setTranscript(note, "am uitat umbrela");
  const transcribed = await call("new_since", { after: mark });
  assert.deepEqual(transcribed.structuredContent.messages.map((m) => [m.message_id, m.transcript]), [[note, "am uitat umbrela"]]);
  mark = transcribed.structuredContent.through;

  sock.ev.emit("messages.update", [{ key: { remoteJid: DAN, fromMe: false, id: "M3" }, update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE } }]);
  const revoked = await call("new_since", { after: mark });
  assert.deepEqual(revoked.structuredContent.messages.map((m) => [m.message_id, m.deleted, m.text]), [[doomed, true, "[deleted]"]]);
  assert.match(revoked.content[0].text, /\[deleted\]/);
  assert.ok(!JSON.stringify(revoked.structuredContent).includes("va dispărea"), "the words are gone");
  assert.equal(revoked.structuredContent.messages[0].private, undefined);

  // From the start, each message comes once, in the state it is in now.
  const all = await call("new_since", {});
  assert.deepEqual(
    all.structuredContent.messages.map((m) => [m.message_id, m.deleted ?? false]),
    [[text, false], [note, false], [doomed, true]],
    "ordered by the last time each changed"
  );
});

test("stories, expired messages and a cleared chat are not listed, and a hidden tail still moves through to the top", async () => {
  const { svc, call, arrive } = account();
  const visible = arrive(ANA, "rămâne");
  const expiring = arrive(DAN, "expiră");
  arrive(STATUS, "o poveste", { participant: DAN });
  const cleared = arrive(GROUP, "dispare cu ștergerea", { participant: DAN });
  const before = await call("new_since", {});
  assert.deepEqual(ids(before), [visible, expiring, cleared], "the story is no chat's message");

  svc.db.messages.setExpiry(expiring, Date.now() - 1000);
  await svc.db.messages.clearChat(GROUP, Date.now() + MINUTE);
  const after = await call("new_since", {});
  assert.deepEqual(ids(after), [visible]);

  const tail = await call("new_since", { after: before.structuredContent.through - 1 });
  assert.deepEqual([tail.structuredContent.count, tail.structuredContent.more], [0, false], "everything left past the cursor is hidden");
  assert.equal(tail.structuredContent.through, tail.structuredContent.top);
  assert.ok(tail.structuredContent.through > 0);
});

test("a message that changes after the call started waits for the next call", async () => {
  const { svc, call, arrive } = account();
  const first = arrive(ANA, "unu");
  const top = svc.db.messages.changeTop();
  arrive(ANA, "doi");
  // What the service reads is bounded by the top fixed at the start of the call.
  assert.deepEqual(svc.db.messages.changedSince(0, top, 100).map((entry) => entry.message.sid), [first]);
  const next = await call("new_since", { after: top });
  assert.equal(next.structuredContent.count, 1);
});

test("someone tagged #private is listed without words and marked private, in their chat and in a group, a deletion too; a quote of theirs loses its words", async () => {
  const { svc, sock, call, arrive } = account();
  svc.db.identity.updateFields(ANA, { addTags: ["private"] });
  const direct = arrive(ANA, "rezultatele de la analize");
  const inGroup = arrive(GROUP, "nu spuneți nimănui", { participant: ANA });
  const reply = arrive(
    GROUP,
    { extendedTextMessage: { text: "te sun diseară", contextInfo: { stanzaId: "M2", participant: ANA, quotedMessage: { conversation: "nu spuneți nimănui" } } } },
    { participant: DAN }
  );
  const open = arrive(DAN, "salut");
  const result = await call("new_since", {});
  const byId = new Map(result.structuredContent.messages.map((m) => [m.message_id, m]));
  assert.deepEqual([...byId.keys()], [direct, inGroup, reply, open], "every message stays listed");
  assert.deepEqual([direct, inGroup].map((id) => [byId.get(id).text, byId.get(id).private]), [["[private]", true], ["[private]", true]]);
  assert.deepEqual([byId.get(reply).text, byId.get(reply).private, byId.get(reply).quoted.text], ["te sun diseară", undefined, "[private]"]);
  assert.equal(byId.get(open).text, "salut");
  for (const words of ["analize", "nimănui"]) assert.ok(!JSON.stringify(result.structuredContent).includes(words), words);
  assert.ok(!result.content[0].text.includes("analize"));

  sock.ev.emit("messages.update", [{ key: { remoteJid: ANA, fromMe: false, id: "M1" }, update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE } }]);
  const gone = await call("new_since", { after: result.structuredContent.through });
  assert.deepEqual(gone.structuredContent.messages.map((m) => [m.message_id, m.text, m.private, m.deleted]), [[direct, "[private]", true, true]]);
});

test("a session without writes can call it, and it is a read tool", async () => {
  const { tools, call, arrive } = account({ allowWrite: false });
  assert.ok(tools.has("new_since"));
  assert.equal(tools.get("new_since").meta.annotations.readOnlyHint, true);
  assert.ok(tools.get("new_since").meta.inputSchema.account_id);
  assert.deepEqual(Object.keys(tools.get("new_since").meta.inputSchema).sort(), ["account_id", "after", "limit"]);
  arrive(ANA, "salut");
  assert.equal((await call("new_since", { limit: 200 })).structuredContent.count, 1);
  await assert.rejects(call("new_since", { limit: 201 }));
  await assert.rejects(call("new_since", { after: -1 }));
});

// ------------------------------------------------------------ review fixes

const LID = "555666777888999@lid";

/** A consumer: pages from `after` to the end and keeps each message by its `key`; returns the cursor. */
async function syncInto(call, store, after) {
  for (;;) {
    const page = (await call("new_since", { after, limit: 2 })).structuredContent;
    for (const message of page.messages) store.set(message.key, message);
    after = page.through;
    if (!page.more) return after;
  }
}

test("every message carries a key that survives a lid pairing, which renames its chat or folds it into the number's", async () => {
  for (const folds of [false, true]) {
    const { svc, call, arrive, sock } = account();
    if (folds) arrive(ANA, "pe număr");
    const lidMessage = arrive(LID, "pe lid");
    const store = new Map();
    const seen = new Set();
    let cursor = await syncInto(call, store, 0);
    for (const message of store.values()) seen.add(message.message_id);
    assert.ok(seen.has(lidMessage));

    await svc.db.learnLidPhone(LID, ANA);
    cursor = await syncInto(call, store, cursor);
    const moved = [...store.values()].find((message) => message.key === "false_M" + (folds ? 2 : 1));
    assert.notEqual(moved.message_id, lidMessage, `the id now reads under the number (folds: ${folds})`);
    assert.equal(moved.chat_id, ANA);
    assert.equal(store.size, folds ? 2 : 1, "keyed by key, one record for it");

    sock.ev.emit("messages.update", [{ key: { remoteJid: ANA, fromMe: false, id: moved.key.slice("false_".length) }, update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE } }]);
    cursor = await syncInto(call, store, cursor);
    const final = store.get(moved.key);
    assert.equal(final.deleted, true, `the revoke reaches the one record (folds: ${folds})`);
    assert.equal(store.size, folds ? 2 : 1);
    assert.equal(typeof cursor, "number");
  }
});

test("a replay that differs only in status, receipts or push name is not a change; a quote scrub and an edit are", async () => {
  const { call, arrive, event, sock } = account();
  const at = Date.now() - MINUTE;
  const mine = arrive(ANA, "al meu", { fromMe: true, at });
  const quoted = arrive(ANA, "citat", { at: at + 1000 });
  const reply = arrive(
    ANA,
    { extendedTextMessage: { text: "răspuns", contextInfo: { stanzaId: "M2", participant: ANA, quotedMessage: { conversation: "citat" } } } },
    { at: at + 2000 }
  );
  const mark = (await call("new_since", {})).structuredContent.through;
  const replay = (extra) => sock.ev.emit("messages.upsert", { type: "notify", messages: [{ ...event(ANA, "al meu", { fromMe: true, key: "M1", at }), ...extra }] });
  replay({ status: 3 });
  replay({ userReceipt: [{ userJid: ANA, receiptTimestamp: Math.floor(at / 1000) + 5 }] });
  replay({ pushName: "Ana Nouă" });
  assert.deepEqual(ids(await call("new_since", { after: mark })), [], "none of them changes what a reader sees");

  sock.ev.emit("messages.update", [{ key: { remoteJid: ANA, fromMe: false, id: "M2" }, update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE } }]);
  const scrubbed = await call("new_since", { after: mark });
  assert.deepEqual(ids(scrubbed).sort(), [quoted, reply].sort(), "the deleted message, and the reply that lost its embedded copy");
  assert.ok(mine);
});

test("the answer names its epoch, and a cursor past the top comes back to the top", async () => {
  const { call, arrive } = account();
  arrive(ANA, "salut");
  const first = (await call("new_since", {})).structuredContent;
  assert.match(first.epoch, /^[0-9a-f]{16}$/);
  const ahead = (await call("new_since", { after: first.top + 50 })).structuredContent;
  assert.equal(ahead.epoch, first.epoch);
  assert.deepEqual([ahead.count, ahead.more, ahead.through, ahead.top], [0, false, first.top, first.top]);
});

test("a change that lands while the call learns names waits for the next call", async () => {
  const { svc, sock, call, arrive } = account();
  const edited = arrive(ANA, "prima versiune");
  const other = arrive(DAN, "alt mesaj");
  const learn = svc.identity.learnLidPhones.bind(svc.identity);
  let once = true;
  svc.identity.learnLidPhones = async (jids) => {
    if (once) {
      once = false;
      sock.ev.emit("messages.update", [{ key: { remoteJid: ANA, fromMe: false, id: "M1" }, update: { message: { editedMessage: { message: { conversation: "a doua versiune" } } } } }]);
    }
    return learn(jids);
  };
  const during = await call("new_since", {});
  assert.deepEqual(ids(during), [other], "its old number is gone and its new one lies past the top");
  const next = await call("new_since", { after: during.structuredContent.through });
  assert.deepEqual(next.structuredContent.messages.map((m) => [m.message_id, m.text]), [[edited, "a doua versiune"]]);
});

test("the content hash ignores what varies between copies of a message and sees what a reader would", async () => {
  const { contentHashOf } = await import("../dist/message-content-hash.js");
  const encode = (message) => proto.WebMessageInfo.encode({ key: { id: "X" }, message }).finish();
  const plain = { extendedTextMessage: { text: "salut", contextInfo: { stanzaId: "Q", quotedMessage: { conversation: "citat" } } } };
  const same = { ...plain, messageContextInfo: { deviceListMetadata: { senderTimestamp: 7 } } };
  const refreshed = { imageMessage: { mimetype: "image/jpeg", fileLength: 4, url: "https://a", directPath: "/a", mediaKey: new Uint8Array([1]), jpegThumbnail: new Uint8Array([9]) } };
  const relinked = { imageMessage: { mimetype: "image/jpeg", fileLength: 4, url: "https://b", directPath: "/b", mediaKey: new Uint8Array([2]) } };
  const scrubbed = { extendedTextMessage: { text: "salut", contextInfo: { stanzaId: "Q" } } };
  assert.equal(contentHashOf(encode(plain)), contentHashOf(encode(same)));
  assert.equal(contentHashOf(encode(refreshed)), contentHashOf(encode(relinked)));
  assert.notEqual(contentHashOf(encode(plain)), contentHashOf(encode(scrubbed)));
  assert.equal(contentHashOf(new Uint8Array([0xff, 0xff])), null);
});

test("the content hash pins what it leaves out: each of those fields can change and the hash stays, while a caption or a poll option still moves it", async () => {
  const { contentHashOf } = await import("../dist/message-content-hash.js");
  const encode = (message) => proto.WebMessageInfo.encode({ key: { id: "X" }, message }).finish();
  const hash = (message) => contentHashOf(encode(message));
  const image = (extra = {}) => ({ imageMessage: { mimetype: "image/jpeg", fileLength: 4, caption: "meniul", ...extra } });
  const bytes = (...values) => new Uint8Array(values);
  const variants = {
    url: ["https://a", "https://b"],
    directPath: ["/a", "/b"],
    mediaKey: [bytes(1), bytes(2)],
    mediaKeyTimestamp: [1, 2],
    fileEncSha256: [bytes(1), bytes(2)],
    jpegThumbnail: [bytes(1), bytes(2)],
    thumbnailDirectPath: ["/a", "/b"],
    thumbnailSha256: [bytes(1), bytes(2)],
    thumbnailEncSha256: [bytes(1), bytes(2)],
    streamingSidecar: [bytes(1), bytes(2)],
    midQualityFileSha256: [bytes(1), bytes(2)],
    midQualityFileEncSha256: [bytes(1), bytes(2)],
    scansSidecar: [bytes(1), bytes(2)],
    scanLengths: [[1, 2], [3, 4]],
    firstScanSidecar: [bytes(1), bytes(2)],
    firstScanLength: [1, 2],
    mediaKeyDomain: [1, 2],
  };
  // streamingSidecar belongs to audio and video messages, the rest to the image message.
  const carrying = (field, value) => (field === "streamingSidecar" ? { videoMessage: { mimetype: "video/mp4", caption: "meniul", [field]: value } } : image({ [field]: value }));
  for (const [field, [one, two]] of Object.entries(variants)) {
    assert.notDeepEqual(encode(carrying(field, one)), encode(carrying(field, two)), `${field} is a field of its message`);
    assert.equal(hash(carrying(field, one)), hash(carrying(field, two)), field);
  }
  const outer = { messageContextInfo: { deviceListMetadata: { senderTimestamp: 1 } }, senderKeyDistributionMessage: { groupId: "g", axolotlSenderKeyDistributionMessage: bytes(1) } };
  const other = { messageContextInfo: { deviceListMetadata: { senderTimestamp: 2 } }, senderKeyDistributionMessage: { groupId: "h", axolotlSenderKeyDistributionMessage: bytes(2) } };
  assert.notDeepEqual(encode({ ...image(), ...outer }), encode({ ...image(), ...other }));
  assert.equal(hash({ ...image(), ...outer }), hash({ ...image(), ...other }), "the sender's envelope");

  assert.notEqual(hash(image()), hash(image({ caption: "alt meniu" })), "a caption");
  const poll = (...names) => ({ pollCreationMessage: { name: "Pizza?", options: names.map((optionName) => ({ optionName })), selectableOptionsCount: 1 } });
  assert.notEqual(hash(poll("da", "nu")), hash(poll("da", "poate")), "a poll option");
  assert.notEqual(hash({ extendedTextMessage: { text: "a", contextInfo: { stanzaId: "Q" } } }), hash({ extendedTextMessage: { text: "a", contextInfo: { stanzaId: "R" } } }), "a quote's own context info is content");

  // Wrappers the message view looks through are looked through here; one it shows (view once) is not.
  assert.equal(hash(image()), hash({ ephemeralMessage: { message: image() } }));
  assert.equal(hash(image()), hash({ documentWithCaptionMessage: { message: image() } }));
  assert.equal(hash(image()), hash({ deviceSentMessage: { destinationJid: "x@s.whatsapp.net", message: image() } }));
  assert.notEqual(hash(image()), hash({ viewOnceMessage: { message: image() } }), "view once is a difference a reader sees");
});
