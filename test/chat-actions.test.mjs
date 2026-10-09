/**
 * Chat and message actions: pinning and starring a message, clearing, deleting
 * and blocking a chat, deleting a message for the linked account only, joining
 * a group from an invite, the blocklist read at connect, and @-mentions both
 * ways. Mocked at the socket; no live WhatsApp call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { proto } from "baileys";
import { z } from "zod";

import { withMentionTokens } from "../dist/drafts.js";
import { registerTools } from "../dist/tools.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { asToolSource, connectedService } from "./helpers.mjs";

const ME = "40700000000@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const DAN_LID = "987654321012345@lid";
const GROUP = "120363414132891692@g.us";
const CODE = "AbCdEfGhIjKlMnOpQrStUv";
const LINK = `https://chat.whatsapp.com/${CODE}`;

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, meta, handler) {
      tools.set(name, { meta, handler });
    },
  };
}

function writableService() {
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-chat-actions-",
    id: ME,
    name: "Răzvan",
    // No write bucket: a test that walks several actions would otherwise run out of it.
    config: { readOnly: false, rateLimitPerMinute: 0 },
  });
  sock.ev.emit("contacts.upsert", [
    { id: ANA, name: "Ana" },
    { id: DAN, name: "Dan" },
  ]);
  sock.groupMetadata = async (id) => ({
    id,
    subject: "Bloc 12",
    participants: [
      { id: ME, admin: null },
      { id: ANA, admin: null },
      { id: DAN, admin: null },
    ],
  });
  sock.fetchStatus = async () => [];
  sock.profilePictureUrl = async () => undefined;
  return { svc, sock };
}

/** Every Baileys call the chat actions may make, recorded in order. */
function recordCalls(sock) {
  const calls = [];
  sock.chatModify = async (...args) => void calls.push(["chatModify", ...args]);
  sock.updateBlockStatus = async (...args) => void calls.push(["updateBlockStatus", ...args]);
  sock.sendMessage = async (...args) => {
    calls.push(["sendMessage", ...args]);
    return { key: { id: "SENT" } };
  };
  // A confirmed draft is built here and relayed: what is recorded is what goes out.
  sock.relayMessage = async (...args) => void calls.push(["relayMessage", ...args]);
  return calls;
}

/** Whether nothing of the message is left in the database, not even a tombstone: a clear purges. */
function purged(svc, sid) {
  return svc.db.messages.get(sid, { includeHidden: true }) === null;
}

let seq = 0;

/** A message stored the way a live one arrives; returns its message_id. */
function arrive(sock, chat, { fromMe = false, participant, ageSeconds = 3600, message } = {}) {
  const id = `C${++seq}`;
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) },
        message: message ?? { conversation: "salut" },
        messageTimestamp: Math.floor(Date.now() / 1000) - ageSeconds,
      },
    ],
  });
  return `${fromMe}_${chat}_${id}`;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("pin_message and unpin_message send a pin for everyone with the message's key; 168 hours by default", async () => {
  const { svc, sock } = writableService();
  const calls = recordCalls(sock);
  const messageId = arrive(sock, ANA);
  const stanza = messageId.split("_").at(-1);

  const pinned = await svc.manageChat(ANA, "pin_message", { messageId });
  assert.deepEqual(pinned, { chat_id: ANA, action: "pin_message", applied: "pin_message for 168h", message_id: messageId });
  await svc.manageChat(ANA, "pin_message", { messageId, pinHours: 24 });
  await svc.manageChat(ANA, "pin_message", { messageId, pinHours: 720 });
  const unpinned = await svc.manageChat(ANA, "unpin_message", { messageId });
  assert.equal(unpinned.applied, "unpin_message");

  assert.equal(calls.length, 4);
  const expected = [
    [proto.PinInChat.Type.PIN_FOR_ALL, 604_800],
    [proto.PinInChat.Type.PIN_FOR_ALL, 86_400],
    [proto.PinInChat.Type.PIN_FOR_ALL, 2_592_000],
    [proto.PinInChat.Type.UNPIN_FOR_ALL, 604_800],
  ];
  calls.forEach(([method, jid, content], index) => {
    assert.equal(method, "sendMessage");
    assert.equal(jid, ANA);
    assert.equal(content.pin.id, stanza);
    assert.equal(content.pin.remoteJid, ANA);
    assert.equal(content.pin.fromMe, false);
    assert.deepEqual([content.type, content.time], expected[index], `call ${index}`);
  });
  assert.equal(proto.PinInChat.Type.PIN_FOR_ALL, 1);
  assert.equal(proto.PinInChat.Type.UNPIN_FOR_ALL, 2);

  await assert.rejects(
    () => svc.manageChat(ANA, "pin_message", { messageId, pinHours: 48 }),
    (err) => err.code === "INVALID_ID" && /24, 168 or 720/.test(err.message)
  );
  assert.equal(calls.length, 4);
  await svc.stop();
});

test("star_message and unstar_message modify the chat with the message's id and fromMe", async () => {
  const { svc, sock } = writableService();
  const calls = recordCalls(sock);
  const theirs = arrive(sock, GROUP, { participant: ANA });
  const mine = arrive(sock, GROUP, { fromMe: true });

  const starred = await svc.manageChat(GROUP, "star_message", { messageId: theirs });
  assert.deepEqual(starred, { chat_id: GROUP, action: "star_message", applied: "star_message", message_id: theirs });
  await svc.manageChat(GROUP, "unstar_message", { messageId: mine });
  assert.deepEqual(calls, [
    ["chatModify", { star: { messages: [{ id: theirs.split("_").at(-1), fromMe: false }], star: true } }, GROUP],
    ["chatModify", { star: { messages: [{ id: mine.split("_").at(-1), fromMe: true }], star: false } }, GROUP],
  ]);
  await svc.stop();
});

test("a message from another chat, or none at all, is refused before any socket call", async () => {
  const { svc, sock } = writableService();
  const calls = recordCalls(sock);
  const inDan = arrive(sock, DAN);

  for (const action of ["pin_message", "unpin_message", "star_message", "unstar_message"]) {
    await assert.rejects(
      () => svc.manageChat(ANA, action, { messageId: inDan }),
      (err) =>
        err.code === "MESSAGE_NOT_FOUND" &&
        err.message.includes(`is not in ${ANA}`) &&
        err.message.includes(DAN) &&
        /chat_id the message belongs to/.test(err.fix ?? ""),
      action
    );
    await assert.rejects(
      () => svc.manageChat(ANA, action),
      (err) => err.code === "INVALID_ID" && err.message.includes(`"${action}"`) && /message_id/.test(err.message),
      `${action} without message_id`
    );
  }
  assert.deepEqual(calls, []);
  await svc.stop();
});

test("clearing a chat, by manage_chat or by the phone's messages.delete, empties it and keeps it listed", async () => {
  const { svc, sock } = writableService();
  const calls = recordCalls(sock);
  sock.ev.emit("chats.upsert", [{ id: ANA }, { id: DAN }, { id: GROUP }]);
  const first = arrive(sock, ANA, { ageSeconds: 7200 });
  const last = arrive(sock, ANA);
  const fromPhone = arrive(sock, DAN);
  const kept = arrive(sock, GROUP, { participant: ANA });

  const result = await svc.manageChat(ANA, "clear");
  assert.deepEqual(result, { chat_id: ANA, action: "clear", applied: "clear" });
  assert.equal(calls.length, 1);
  const [method, mod, jid] = calls[0];
  assert.equal(method, "chatModify");
  assert.equal(jid, ANA);
  assert.equal(mod.clear, true);
  assert.equal(mod.lastMessages.length, 1);
  assert.equal(mod.lastMessages[0].key.id, last.split("_").at(-1));
  assert.equal(purged(svc, first) && purged(svc, last), true, "manage_chat clear waits for the purge");

  sock.ev.emit("messages.delete", { jid: DAN, all: true });
  assert.notEqual(svc.db.identity.chat(DAN).clearedThroughTs, null, "messages.delete all stores the barrier at once");

  for (const sid of [first, last, fromPhone]) assert.equal(svc.hasMessage(sid), false, sid);
  await svc.storageIdle();
  for (const sid of [first, last, fromPhone]) assert.equal(purged(svc, sid), true, `${sid} and its vector are purged`);
  assert.equal(svc.hasMessage(kept), true);
  const listed = (await svc.listChats("all", 50)).data;
  for (const cleared of [ANA, DAN]) {
    const chat = listed.find((entry) => entry.chat_id === cleared);
    assert.ok(chat, `a cleared chat stays listed: ${cleared}`);
    assert.equal(chat.last_message, null);
  }
  await svc.stop();
});

test("deleting a chat, by manage_chat or by the phone's chats.delete, takes it, its messages and their index entries out", async () => {
  const { svc, sock } = writableService();
  const calls = recordCalls(sock);
  sock.ev.emit("chats.upsert", [{ id: ANA }, { id: DAN }, { id: GROUP }]);
  const only = arrive(sock, ANA);
  const fromPhone = arrive(sock, DAN);
  const kept = arrive(sock, GROUP, { participant: ANA });

  const result = await svc.manageChat(ANA, "delete");
  assert.deepEqual(result, { chat_id: ANA, action: "delete", applied: "delete" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].delete, true);
  assert.equal(calls[0][1].lastMessages[0].key.id, only.split("_").at(-1));
  assert.equal(calls[0][2], ANA);
  assert.equal(purged(svc, only), true, "manage_chat delete waits for the purge");

  sock.ev.emit("chats.delete", [DAN]);
  assert.notEqual(svc.db.identity.chat(DAN).clearedThroughTs, null, "chats.delete stores the barrier at once");

  for (const [chat, sid] of [
    [ANA, only],
    [DAN, fromPhone],
  ]) {
    assert.deepEqual(svc.db.messages.chatPage(chat, { limit: 10 }).items, [], chat);
    assert.equal(svc.hasChat(chat), false, chat);
    assert.equal(svc.hasMessage(sid), false, sid);
  }
  await svc.storageIdle();
  assert.equal(purged(svc, fromPhone), true);
  assert.deepEqual(
    (await svc.listChats("all", 50)).data.map((chat) => chat.chat_id),
    [GROUP]
  );
  assert.equal(svc.hasMessage(kept), true);
  await svc.stop();
});

test("a refused clear or delete leaves the store as it was", async () => {
  const { svc, sock } = writableService();
  sock.ev.emit("chats.upsert", [{ id: ANA }]);
  const kept = arrive(sock, ANA);
  sock.chatModify = async () => {
    throw new Error("bad-request");
  };
  for (const action of ["clear", "delete"]) {
    await assert.rejects(
      () => svc.manageChat(ANA, action),
      (err) => err.code === "WHATSAPP_ERROR"
    );
  }
  assert.equal(svc.hasMessage(kept), true);
  assert.equal(svc.hasChat(ANA), true);
  assert.equal(svc.db.identity.chat(ANA).clearedThroughTs, null, "no barrier was stored");
  await svc.stop();
});

test("block and unblock a person update WhatsApp and is_blocked at once; a group is refused", async () => {
  const { svc, sock } = writableService();
  const calls = recordCalls(sock);

  assert.deepEqual(await svc.manageChat("+40700000002", "block"), { chat_id: ANA, action: "block", applied: "block" });
  assert.equal((await svc.getContact(ANA)).is_blocked, true);
  assert.equal((await svc.getContact(DAN)).is_blocked, false);
  await svc.manageChat(ANA, "unblock");
  assert.equal((await svc.getContact(ANA)).is_blocked, false);
  assert.deepEqual(calls, [
    ["updateBlockStatus", ANA, "block"],
    ["updateBlockStatus", ANA, "unblock"],
  ]);

  for (const action of ["block", "unblock"]) {
    await assert.rejects(
      () => svc.manageChat(GROUP, action),
      (err) => err.code === "INVALID_ID" && /one-to-one chat/.test(err.message),
      action
    );
  }
  assert.equal(calls.length, 2);
  await svc.stop();
});

test("delete_message for the linked account only: anyone's message at any age, removed here too", async () => {
  const { svc, sock } = writableService();
  const calls = recordCalls(sock);
  const lookups = [];
  sock.groupMetadata = async (id) => {
    lookups.push(id);
    return { id, subject: "Bloc 12", participants: [] };
  };
  const theirs = arrive(sock, GROUP, { participant: ANA, ageSeconds: 5 * 86_400 });
  const mine = arrive(sock, DAN, { fromMe: true, ageSeconds: 30 * 86_400 });

  assert.deepEqual(await svc.deleteMessage(theirs, false), { message_id: theirs, for_everyone: false });
  assert.deepEqual(await svc.deleteMessage(mine, false), { message_id: mine, for_everyone: false });

  assert.equal(calls.length, 2);
  const [method, mod, jid] = calls[0];
  assert.equal(method, "chatModify");
  assert.equal(jid, GROUP);
  assert.equal(mod.deleteForMe.deleteMedia, false);
  assert.equal(mod.deleteForMe.key.id, theirs.split("_").at(-1));
  assert.equal(mod.deleteForMe.key.fromMe, false);
  assert.equal(mod.deleteForMe.key.participant, ANA);
  assert.equal(typeof mod.deleteForMe.timestamp, "number");
  assert.ok(Math.abs(mod.deleteForMe.timestamp - (Math.floor(Date.now() / 1000) - 5 * 86_400)) <= 2);
  assert.equal(calls[1][2], DAN);
  assert.equal(calls[1][1].deleteForMe.key.fromMe, true);

  assert.equal(svc.hasMessage(theirs), false);
  assert.equal(svc.hasMessage(mine), false);
  for (const sid of [theirs, mine]) {
    assert.notEqual(svc.db.messages.get(sid, { includeHidden: true }).deletedAt, null, `${sid} is a tombstone`);
  }
  assert.deepEqual(lookups, [], "no admin rights are needed to delete for the account alone");

  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: true });
  const again = arrive(sock, DAN);
  const { meta, handler } = server.tools.get("delete_message");
  assert.throws(() => z.object(meta.inputSchema).parse({ message_id: again }), /for_everyone/);
  const result = await handler(z.object(meta.inputSchema).parse({ message_id: again, for_everyone: false }));
  assert.equal(result.content[0].text, `Deleted ${again} for the linked account only`);
  assert.match(meta.description, /for_everyone: false/);
  assert.match(meta.description, /admin/);
  await svc.stop();
});

test("the blocklist is read when the socket opens, so is_blocked is right before WhatsApp pushes a change", async () => {
  const { svc, sock } = writableService();
  svc.healContacts = async () => {};
  sock.ev.emit("lid-mapping.update", { lid: DAN_LID, pn: DAN });
  let asked = 0;
  sock.fetchBlocklist = async () => {
    asked++;
    return [ANA, undefined, DAN_LID];
  };
  sock.ev.emit("connection.update", { connection: "open" });
  await settle();
  assert.equal(asked, 1);
  assert.equal((await svc.getContact(ANA)).is_blocked, true);
  assert.equal((await svc.getContact(DAN)).is_blocked, true, "a lid on the list names the person behind it");
  assert.equal((await svc.getContact("40700000009@s.whatsapp.net")).is_blocked, false);
  await svc.stop();
});

/** The lines the service logs while `work` runs; they go to stderr, since stdout is the protocol. */
async function logged(work) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => void lines.push(args.join(" "));
  try {
    await work();
  } finally {
    console.error = original;
  }
  return lines;
}

test("a blocklist WhatsApp will not give is logged, not thrown, and the connection still comes up", async () => {
  const { svc, sock } = writableService();
  svc.healContacts = async () => {};
  sock.fetchBlocklist = async () => {
    throw new Error("timed out");
  };
  const lines = await logged(async () => {
    sock.ev.emit("connection.update", { connection: "open" });
    await settle();
  });
  assert.ok(lines.some((line) => line.includes("ERROR (blocklist)") && line.includes("timed out")), lines.join("\n"));
  assert.equal(svc.getStatus().status, "connected");
  assert.equal((await svc.getContact(ANA)).is_blocked, false);
  await svc.stop();
});

test("a socket with no fetchBlocklist is skipped quietly at connect", async () => {
  const { svc, sock } = writableService();
  svc.healContacts = async () => {};
  assert.equal(typeof sock.fetchBlocklist, "undefined");
  const lines = await logged(async () => {
    sock.ev.emit("connection.update", { connection: "open" });
    await settle();
  });
  assert.deepEqual(
    lines.filter((line) => line.includes("ERROR")),
    []
  );
  assert.equal(svc.getStatus().status, "connected");
  await svc.stop();
});

test("a message's pushName names its sender only: a mentioned or reacting person with no known name reads as their number", async () => {
  const { svc, sock } = writableService();
  const MARIA = "40700000005@s.whatsapp.net";
  const NOBODY = "40700000006@s.whatsapp.net";
  const STRANGER = "40700000007@s.whatsapp.net";
  const key = { remoteJid: GROUP, fromMe: false, id: "NAMES1", participant: MARIA };
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key,
        pushName: "Maria",
        message: { extendedTextMessage: { text: "@40700000006 ai văzut?", contextInfo: { mentionedJid: [NOBODY] } } },
        messageTimestamp: Math.floor(Date.now() / 1000) - 60,
      },
    ],
  });
  sock.ev.emit("messages.reaction", [
    { key, reaction: { text: "👍", key: { remoteJid: GROUP, fromMe: false, participant: STRANGER } } },
  ]);

  const view = await svc.getMessage(`false_${GROUP}_NAMES1`);
  assert.equal(view.sender.name, "Maria");
  assert.deepEqual(view.mentions, [{ id: NOBODY, name: "40700000006" }]);
  assert.deepEqual(
    view.reactions.map((reaction) => [reaction.sender, reaction.name]),
    [[STRANGER, "40700000007"]]
  );
  await svc.stop();
});

/** The invite calls join_group may make, recorded; `joined` is what an accept answers, null for nothing. */
function recordInvites(sock, { joined = GROUP, info } = {}) {
  const calls = [];
  sock.groupGetInviteInfo = async (code) => {
    calls.push(["groupGetInviteInfo", code]);
    if (info instanceof Error) throw info;
    return (
      info ?? {
        id: GROUP,
        subject: "Bloc 12",
        desc: "Asociația",
        size: 42,
        participants: [{ id: ANA }],
        joinApprovalMode: true,
      }
    );
  };
  sock.groupAcceptInvite = async (code) => {
    calls.push(["groupAcceptInvite", code]);
    // Baileys answers undefined when WhatsApp names no group.
    return joined ?? undefined;
  };
  sock.groupAcceptInviteV4 = async (key, message) => {
    calls.push(["groupAcceptInviteV4", key, message]);
    return GROUP;
  };
  return calls;
}

function inviteMessage(sock, { expiresInSeconds = 3 * 86_400, code = "V4c0deFromTheMessage" } = {}) {
  return arrive(sock, ANA, {
    message: {
      groupInviteMessage: {
        groupJid: GROUP,
        inviteCode: code,
        inviteExpiration: Math.floor(Date.now() / 1000) + expiresInSeconds,
        groupName: "Familia",
        caption: "Hai în grup",
      },
    },
  });
}

test("manage_group join without confirm only looks the group up: no accept call, and the code is not in the answer", async () => {
  const { svc, sock } = writableService();
  const calls = recordInvites(sock);
  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: true });
  const { meta, handler } = server.tools.get("manage_group");

  for (const invite of [LINK, CODE, ` ${LINK}/?utm=x `, `chat.whatsapp.com/invite/${CODE}`]) {
    calls.length = 0;
    const result = await handler(z.object(meta.inputSchema).parse({ action: "join", invite }));
    assert.equal(result.isError, undefined, invite);
    assert.deepEqual(calls, [["groupGetInviteInfo", CODE]], invite);
    const { account_id: _account, next, ...answer } = result.structuredContent;
    assert.match(next, /after their yes, call manage_group again with action "join", the same invite or message_id and confirm: true/, invite);
    assert.deepEqual(answer, {
      action: "join",
      status: "preview",
      group_id: GROUP,
      name: "Bloc 12",
      description: "Asociația",
      participant_count: 42,
      join_approval: true,
    });
    const text = result.content[0].text;
    assert.match(text, /Group invite: "Bloc 12" \(42 members, an admin must approve new members\)\. Not joined\./);
    assert.match(text, /confirm: true/);
    assert.ok(!text.includes(CODE) && !JSON.stringify(result.structuredContent).includes(CODE));
  }
  assert.equal(meta.annotations.readOnlyHint, false);
  assert.match(meta.description, /preview first, then confirm: true/);
  await svc.stop();
});

test("manage_group join with confirm joins by link, by bare code and by invite message, and returns the group's chat_id", async () => {
  const { svc, sock } = writableService();
  const calls = recordInvites(sock);

  assert.deepEqual(await svc.joinGroup({ invite: LINK, confirm: true }), {
    status: "joined",
    group_id: GROUP,
    name: null,
    description: null,
    participant_count: null,
    join_approval: null,
  });
  assert.equal((await svc.joinGroup({ invite: CODE, confirm: true })).group_id, GROUP);
  assert.deepEqual(calls, [
    ["groupAcceptInvite", CODE],
    ["groupAcceptInvite", CODE],
  ]);

  calls.length = 0;
  const messageId = inviteMessage(sock);
  const joined = await svc.joinGroup({ messageId, confirm: true });
  assert.deepEqual(joined, {
    status: "joined",
    group_id: GROUP,
    name: "Familia",
    description: null,
    participant_count: null,
    join_approval: null,
  });
  assert.equal(calls.length, 1);
  const [method, key, message] = calls[0];
  assert.equal(method, "groupAcceptInviteV4");
  assert.equal(key.id, messageId.split("_").at(-1));
  assert.equal(key.remoteJid, ANA);
  assert.equal(message.inviteCode, "V4c0deFromTheMessage");
  assert.equal(message.groupJid, GROUP);
  await svc.stop();
});

test("an invite message previews through WhatsApp, or from the message itself when WhatsApp will not describe it", async () => {
  const { svc, sock } = writableService();
  const messageId = inviteMessage(sock);

  const calls = recordInvites(sock);
  const described = await svc.joinGroup({ messageId, confirm: false });
  assert.equal(described.status, "preview");
  assert.equal(described.participant_count, 42);
  assert.deepEqual(calls, [["groupGetInviteInfo", "V4c0deFromTheMessage"]]);

  const refused = recordInvites(sock, { info: new Error("not-acceptable") });
  assert.deepEqual(await svc.joinGroup({ messageId, confirm: false }), {
    status: "preview",
    group_id: GROUP,
    name: "Familia",
    description: null,
    participant_count: null,
    join_approval: null,
  });
  assert.equal(refused.length, 1);
  await svc.stop();
});

test("a group that needs approval leaves the request waiting, and says so", async () => {
  const { svc, sock } = writableService();
  recordInvites(sock, { joined: null });
  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: true });
  const result = await server.tools.get("manage_group").handler({ action: "join", invite: LINK, confirm: true });
  assert.equal(result.structuredContent.status, "pending_approval");
  assert.equal(result.structuredContent.group_id, null);
  assert.match(result.content[0].text, /admin of the group must approve the request/);
  await svc.stop();
});

test("a join takes exactly one of invite or message_id, and refuses a bad one without repeating it or calling WhatsApp", async () => {
  const { svc, sock } = writableService();
  const calls = recordInvites(sock);
  const plain = arrive(sock, ANA);
  const used = inviteMessage(sock, { code: "" });
  const expired = inviteMessage(sock, { expiresInSeconds: -60 });

  for (const confirm of [false, true]) {
    await assert.rejects(
      () => svc.joinGroup({ confirm }),
      (err) => err.code === "INVALID_ID" && /exactly one of invite or message_id/.test(err.message)
    );
    await assert.rejects(
      () => svc.joinGroup({ invite: LINK, messageId: plain, confirm }),
      (err) => err.code === "INVALID_ID" && /exactly one of invite or message_id/.test(err.message)
    );
    const odd = "https://example.com/SecretCode1234567";
    await assert.rejects(
      () => svc.joinGroup({ invite: odd, confirm }),
      (err) => err.code === "INVALID_ID" && !err.message.includes("SecretCode") && !(err.fix ?? "").includes("SecretCode")
    );
    await assert.rejects(
      () => svc.joinGroup({ messageId: plain, confirm }),
      (err) => err.code === "INVALID_ID" && /not a group invite/.test(err.message)
    );
    for (const messageId of [used, expired]) {
      await assert.rejects(
        () => svc.joinGroup({ messageId, confirm }),
        (err) => err.code === "WHATSAPP_ERROR" && /expired or was already used/.test(err.message)
      );
    }
  }
  assert.deepEqual(calls, []);

  sock.groupAcceptInvite = async () => {
    throw new Error("gone");
  };
  await assert.rejects(
    () => svc.joinGroup({ invite: LINK, confirm: true }),
    (err) => err.code === "WHATSAPP_ERROR" && /refused the invite: gone/.test(err.message) && !err.message.includes(CODE)
  );
  await svc.stop();
});

test("a message's @-mentions come back once each, canonical and named, and read as a tag", async () => {
  const { svc, sock } = writableService();
  sock.ev.emit("lid-mapping.update", { lid: DAN_LID, pn: DAN });
  const mentioning = arrive(sock, GROUP, {
    participant: ANA,
    message: {
      extendedTextMessage: {
        text: "@40700000003 @40700000000 vii?",
        contextInfo: { mentionedJid: [DAN_LID, ME, DAN, ""] },
      },
    },
  });
  const plain = arrive(sock, GROUP, { participant: ANA });

  const view = await svc.getMessage(mentioning);
  assert.deepEqual(view.mentions, [
    { id: DAN, name: "Dan" },
    { id: ME, name: "Răzvan" },
  ]);
  assert.equal("mentions" in (await svc.getMessage(plain)), false);

  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: false });
  const result = await server.tools.get("get_message").handler({ message_id: mentioning });
  assert.match(result.content[0].text, /\[.*mentions Dan, Răzvan.*\]/);
  assert.deepEqual(result.structuredContent.mentions, view.mentions);
  await svc.stop();
});

test("withMentionTokens adds each missing @<user> at the end and leaves the ones already written", () => {
  assert.equal(withMentionTokens("Vii?", [ANA]), "Vii? @40700000002");
  assert.equal(withMentionTokens("@40700000002 vii?", [ANA]), "@40700000002 vii?");
  assert.equal(withMentionTokens("Vii?\n", [ANA, DAN]), "Vii?\n@40700000002 @40700000003");
  assert.equal(withMentionTokens("@407000000021 vii?", [ANA]), "@407000000021 vii? @40700000002", "a longer number is not the token");
  assert.equal(withMentionTokens("Vii?", [ANA, ANA]), "Vii? @40700000002");
  assert.equal(withMentionTokens("Vii?", [DAN_LID]), "Vii? @987654321012345");
  assert.equal(withMentionTokens("Vii?", []), "Vii?");
});

test("send_message with mention_ids: the draft preview shows the final text, and that text and those jids are what is sent", async () => {
  const { svc, sock } = writableService();
  const calls = recordCalls(sock);
  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: true });
  const send = server.tools.get("send_message");
  assert.match(send.meta.inputSchema.mention_ids.description, /@<number>/);
  assert.doesNotMatch(send.meta.description, /include their names in the text yourself/);

  const drafted = await send.handler({ chat_id: GROUP, text: "@40700000003 vii mâine?", mention_ids: ["+40700000002", DAN] });
  assert.equal(drafted.isError, undefined, JSON.stringify(drafted.structuredContent));
  const finalText = "@40700000003 vii mâine? @40700000002";
  assert.equal(drafted.structuredContent.preview, `To: Bloc 12 (group)\n"${finalText}"`);
  assert.ok(drafted.content[0].text.includes(`"${finalText}"`));
  assert.deepEqual(calls, [], "a draft sends nothing");

  const confirmed = await server.tools.get("confirm_send").handler({ draft_id: drafted.structuredContent.draft_id });
  assert.equal(confirmed.isError, undefined, JSON.stringify(confirmed.structuredContent));
  assert.equal(calls.length, 1);
  const [method, jid, message] = calls[0];
  assert.equal(method, "relayMessage");
  assert.equal(jid, GROUP);
  const { text, contextInfo } = message.extendedTextMessage;
  assert.equal(text, finalText);
  assert.deepEqual(contextInfo.mentionedJid, [ANA, DAN]);
  for (const mentioned of contextInfo.mentionedJid) {
    assert.ok(text.includes(`@${mentioned.split("@")[0]}`), `the token for ${mentioned} is in the text`);
  }

  const untouched = await svc.draft({
    kind: "text",
    chatId: GROUP,
    text: "@40700000002 și @40700000003, vineri",
    mentionIds: [ANA, DAN],
  });
  assert.equal(untouched.preview, `To: Bloc 12 (group)\n"@40700000002 și @40700000003, vineri"`);
  const bare = await svc.draft({ kind: "text", chatId: GROUP, text: "fără mențiuni" });
  assert.equal(bare.preview, `To: Bloc 12 (group)\n"fără mențiuni"`);
  await svc.stop();
});

test("the manage_chat schema takes every new action, message_id and pin_hours, and is marked destructive", async () => {
  const { svc, sock } = writableService();
  const calls = recordCalls(sock);
  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: true });
  const { meta, handler } = server.tools.get("manage_chat");
  const call = (args) => handler(z.object(meta.inputSchema).parse(args));
  const messageId = arrive(sock, ANA);

  const pinned = await call({ chat_id: ANA, action: "pin_message", message_id: messageId, pin_hours: 24 });
  assert.equal(pinned.content[0].text, "pin_message for 24h");
  assert.equal(pinned.structuredContent.message_id, messageId);
  assert.equal(calls.at(-1)[2].time, 86_400);
  for (const action of ["unpin_message", "star_message", "unstar_message"]) {
    const result = await call({ chat_id: ANA, action, message_id: messageId });
    assert.equal(result.isError, undefined, action);
  }
  for (const action of ["block", "unblock", "clear", "delete"]) {
    const result = await call({ chat_id: ANA, action });
    assert.equal(result.isError, undefined, action);
  }
  assert.throws(() => z.object(meta.inputSchema).parse({ chat_id: ANA, action: "pin_message", pin_hours: 48 }));
  assert.equal(meta.annotations.destructiveHint, true);
  for (const action of ["pin_message", "star_message", "clear", "delete", "block"]) {
    assert.match(meta.description, new RegExp(action));
  }
  const guide = (await server.tools.get("learn").handler({})).content[0].text;
  assert.match(guide, /manage_group join/);
  assert.match(guide, /for_everyone: false/);
  assert.match(guide, /mentions: \[\{id, name\}\]/);
  await svc.stop();
});

test("mark_read clears the chat's unread count here, since WhatsApp sends no echo of the account's own read", async () => {
  const { svc, sock } = writableService();
  const read = [];
  sock.readMessages = async (keys) => void read.push(...keys);
  arrive(sock, ANA, { ageSeconds: 60 });
  sock.ev.emit("chats.update", [{ id: ANA, unreadCount: 1 }]);
  await settle();
  await svc.storageIdle?.();
  assert.equal(svc.db.identity.chat(ANA).unread, 1);

  await svc.manageChat(ANA, "mark_read");
  assert.equal(read.length, 1, "the read receipt still goes to WhatsApp");
  assert.equal(svc.db.identity.chat(ANA).unread, 0);
});

test("profile photos are asked of WhatsApp once and reused, a missing one is null", async () => {
  const { svc, sock } = writableService();
  const asked = [];
  sock.profilePictureUrl = async (jid) => {
    asked.push(jid);
    if (jid === DAN) throw new Error("item-not-found");
    return `https://pps.whatsapp.net/${jid}.jpg`;
  };
  const first = await svc.profilePictures([ANA, DAN, ANA]);
  assert.deepEqual(first, { [ANA]: `https://pps.whatsapp.net/${ANA}.jpg`, [DAN]: null });
  const again = await svc.profilePictures([ANA, DAN]);
  assert.deepEqual(again, first);
  assert.deepEqual(asked.sort(), [ANA, DAN].sort(), "each photo asked once");
});
