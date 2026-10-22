/**
 * Group administration: join requests, group settings, the settings get_group_info
 * reports, and deleting someone else's message as a group admin. Mocked at the
 * socket; no live WhatsApp call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { z } from "zod";

import { isoWithOffset } from "../dist/messages.js";
import { registerTools } from "../dist/tools.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { asToolSource, connectedService, schemaCheckedTools, textError } from "./helpers.mjs";

const ME = "40700000000@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const GROUP = "120363414132891692@g.us";
const PARENT = "120363000000000777@g.us";
const REQUESTED = 1_757_000_000;

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
    prefix: "wazap-group-admin-",
    id: ME,
    name: "Răzvan",
    // No write bucket: a test that walks every action would otherwise run out of it.
    config: { readOnly: false, rateLimitPerMinute: 0 },
  });
  sock.ev.emit("contacts.upsert", [
    { id: ANA, name: "Ana" },
    { id: DAN, name: "Dan" },
  ]);
  return { svc, sock };
}

/** A group the linked account is in, as an admin or as a plain member; `extra` lands on the metadata. */
function inGroup(sock, admin, extra = {}) {
  const lookups = [];
  sock.groupMetadata = async (id) => {
    lookups.push(id);
    return {
      id,
      subject: "Bloc 12",
      participants: [
        { id: ME, admin: admin ? "admin" : null },
        { id: ANA, admin: null },
      ],
      ...extra,
    };
  };
  return lookups;
}

/** Every Baileys group call the new actions may make, recorded in order. */
function recordSettings(sock) {
  const calls = [];
  sock.groupSettingUpdate = async (...args) => void calls.push(["groupSettingUpdate", ...args]);
  sock.groupMemberAddMode = async (...args) => void calls.push(["groupMemberAddMode", ...args]);
  sock.groupJoinApprovalMode = async (...args) => void calls.push(["groupJoinApprovalMode", ...args]);
  sock.groupToggleEphemeral = async (...args) => void calls.push(["groupToggleEphemeral", ...args]);
  sock.groupRequestParticipantsList = async (...args) => {
    calls.push(["groupRequestParticipantsList", ...args]);
    return [];
  };
  sock.groupRequestParticipantsUpdate = async (...args) => {
    calls.push(["groupRequestParticipantsUpdate", ...args]);
    return args[1].map((jid) => ({ status: "200", jid }));
  };
  return calls;
}

const SETTINGS = [
  ["set_announcement_only", "on", ["groupSettingUpdate", GROUP, "announcement"], "only admins can send messages"],
  ["set_announcement_only", "off", ["groupSettingUpdate", GROUP, "not_announcement"], "every member can send messages"],
  ["set_info_locked", "on", ["groupSettingUpdate", GROUP, "locked"], "only admins can edit the group info"],
  ["set_info_locked", "off", ["groupSettingUpdate", GROUP, "unlocked"], "every member can edit the group info"],
  ["set_add_mode", "admins", ["groupMemberAddMode", GROUP, "admin_add"], "only admins can add members"],
  ["set_add_mode", "all", ["groupMemberAddMode", GROUP, "all_member_add"], "every member can add members"],
  ["set_join_approval", "on", ["groupJoinApprovalMode", GROUP, "on"], "admins approve new members"],
  ["set_join_approval", "off", ["groupJoinApprovalMode", GROUP, "off"], "new members join without approval"],
  ["set_disappearing", "off", ["groupToggleEphemeral", GROUP, 0], "disappearing messages off"],
  ["set_disappearing", "24h", ["groupToggleEphemeral", GROUP, 86_400], "disappearing messages set to 24h"],
  ["set_disappearing", "7d", ["groupToggleEphemeral", GROUP, 604_800], "disappearing messages set to 7d"],
  ["set_disappearing", "90d", ["groupToggleEphemeral", GROUP, 7_776_000], "disappearing messages set to 90d"],
];

test("each setting value calls the matching Baileys method with its argument, and drops the cached metadata", async () => {
  const { svc, sock } = writableService();
  const lookups = inGroup(sock, true);
  const calls = recordSettings(sock);
  // Fills the cache, so each round below starts from cached metadata.
  await svc.manageGroup(GROUP, "list_join_requests");

  for (const [action, value, call, applied] of SETTINGS) {
    calls.length = 0;
    const before = lookups.length;
    const result = await svc.manageGroup(GROUP, action, undefined, value);
    assert.deepEqual(calls, [call], `${action} ${value}`);
    assert.deepEqual(result, { group_id: GROUP, action, applied });
    // The next action finds nothing cached and asks WhatsApp again.
    await svc.manageGroup(GROUP, "list_join_requests");
    assert.equal(lookups.length, before + 1, `${action} ${value} leaves the metadata cache empty`);
  }
  await svc.stop();
});

test("a setting value is read case-insensitively and trimmed", async () => {
  const { svc, sock } = writableService();
  inGroup(sock, true);
  const calls = recordSettings(sock);
  await svc.manageGroup(GROUP, "set_add_mode", undefined, " Admins ");
  await svc.manageGroup(GROUP, "set_disappearing", undefined, "7D");
  assert.deepEqual(calls, [
    ["groupMemberAddMode", GROUP, "admin_add"],
    ["groupToggleEphemeral", GROUP, 604_800],
  ]);
  await svc.stop();
});

test("an invalid or missing setting value is INVALID_ID listing the values, before any socket call", async () => {
  const { svc, sock } = writableService();
  const lookups = inGroup(sock, true);
  const calls = recordSettings(sock);
  const cases = [
    ["set_announcement_only", "yes", '"on", "off"'],
    ["set_info_locked", undefined, '"on", "off"'],
    ["set_add_mode", "everyone", '"admins", "all"'],
    ["set_join_approval", "", '"on", "off"'],
    ["set_disappearing", "30d", '"off", "24h", "7d", "90d"'],
    ["set_disappearing", "86400", '"off", "24h", "7d", "90d"'],
    ["set_add_mode", "constructor", '"admins", "all"'],
  ];
  for (const [action, value, listed] of cases) {
    await assert.rejects(
      () => svc.manageGroup(GROUP, action, undefined, value),
      (err) => err.code === "INVALID_ID" && err.fix === `Pass value as one of ${listed}`,
      `${action} ${JSON.stringify(value)}`
    );
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(lookups, [], "not even the admin lookup ran");
  await svc.stop();
});

test("every new action needs admin: NOT_ADMIN with a fix, and nothing reaches the setting or request calls", async () => {
  const { svc, sock } = writableService();
  inGroup(sock, false);
  const calls = recordSettings(sock);
  const attempts = [
    ...SETTINGS.map(([action, value]) => [action, undefined, value]),
    ["list_join_requests", undefined, undefined],
    ["approve_join_requests", [ANA], undefined],
    ["reject_join_requests", [ANA], undefined],
  ];
  for (const [action, ids, value] of attempts) {
    await assert.rejects(
      () => svc.manageGroup(GROUP, action, ids, value),
      (err) =>
        err.code === "NOT_ADMIN" &&
        err.message.includes(`"${action}"`) &&
        /make the linked account an admin/.test(err.fix ?? ""),
      action
    );
  }
  assert.deepEqual(calls, []);
  await svc.stop();
});

test("list_join_requests returns each requester with a resolved name, the time and the method", async () => {
  const { svc, sock } = writableService();
  inGroup(sock, true);
  const asked = [];
  sock.groupRequestParticipantsList = async (jid) => {
    asked.push(jid);
    return [
      { jid: ANA, request_time: String(REQUESTED), request_method: "invite_link" },
      { jid: DAN, request_method: "linked_group_join" },
      { jid: "40700000009@s.whatsapp.net" },
      { request_time: String(REQUESTED) },
    ];
  };

  const result = await svc.manageGroup(GROUP, "list_join_requests");
  assert.deepEqual(asked, [GROUP]);
  assert.deepEqual(result, {
    group_id: GROUP,
    action: "list_join_requests",
    applied: "3 pending join request(s)",
    join_requests: [
      { id: ANA, name: "Ana", requested_at: isoWithOffset(REQUESTED * 1000), method: "invite_link" },
      { id: DAN, name: "Dan", requested_at: null, method: "linked_group_join" },
      { id: "40700000009@s.whatsapp.net", name: "40700000009", requested_at: null, method: null },
    ],
  });
  await svc.stop();
});

test("approve and reject send the resolved ids with the verdict, and report each participant", async () => {
  const { svc, sock } = writableService();
  inGroup(sock, true);
  const calls = [];
  sock.groupRequestParticipantsUpdate = async (jid, participants, action) => {
    calls.push([jid, participants, action]);
    return [
      { status: "200", jid: participants[0] },
      { status: "403", jid: participants[1] },
    ];
  };

  const approved = await svc.manageGroup(GROUP, "approve_join_requests", ["+40700000002", DAN]);
  assert.deepEqual(approved, {
    group_id: GROUP,
    action: "approve_join_requests",
    applied: "approve 2 join request(s)",
    participants: [
      { id: ANA, status: "ok" },
      { id: DAN, status: "failed", reason: "403" },
    ],
  });
  const rejected = await svc.manageGroup(GROUP, "reject_join_requests", [ANA, DAN]);
  assert.equal(rejected.applied, "reject 2 join request(s)");
  assert.deepEqual(calls, [
    [GROUP, [ANA, DAN], "approve"],
    [GROUP, [ANA, DAN], "reject"],
  ]);

  await assert.rejects(
    () => svc.manageGroup(GROUP, "approve_join_requests", []),
    (err) => err.code === "INVALID_ID" && /at least one participant id/.test(err.message)
  );
  assert.equal(calls.length, 2);
  await svc.stop();
});

test("get_group_info reports the settings and the community from the metadata; the old fields stay", async () => {
  const { svc, sock } = writableService();
  sock.groupInviteCode = async () => "CODE";
  inGroup(sock, true, {
    desc: "Asociația",
    announce: true,
    restrict: true,
    memberAddMode: true,
    joinApprovalMode: true,
    ephemeralDuration: 604_800,
    linkedParent: PARENT,
  });
  const info = await svc.getGroupInfo(GROUP);
  assert.equal(info.chat_id, GROUP);
  assert.equal(info.name, "Bloc 12");
  assert.equal(info.description, "Asociația");
  assert.equal(info.participant_count, 2);
  assert.equal(info.announcement_only, true);
  assert.equal(info.i_am_admin, true);
  assert.equal(info.invite_link, "https://chat.whatsapp.com/CODE");
  assert.equal(info.info_locked, true);
  assert.equal(info.member_add_mode, "all");
  assert.equal(info.join_approval, true);
  assert.equal(info.disappearing_seconds, 604_800);
  assert.deepEqual(info.community, { is_community: false, parent_group_id: PARENT });

  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: false });
  const text = (await server.tools.get("get_group_info").handler({ group_id: GROUP })).content[0].text;
  assert.match(text, /\*\*who can add members\*\*: all/);
  assert.match(text, /\*\*disappearing messages\*\*: 7d/);
  assert.match(text, new RegExp(`\\*\\*in community\\*\\*: \`${PARENT}\``));
  await svc.stop();
});

test("get_group_info with no settings in the metadata reads as the defaults, and names a community", async () => {
  const { svc, sock } = writableService();
  inGroup(sock, false);
  const plain = await svc.getGroupInfo(GROUP);
  assert.equal(plain.info_locked, false);
  assert.equal(plain.member_add_mode, "admins");
  assert.equal(plain.join_approval, false);
  assert.equal(plain.disappearing_seconds, 0);
  assert.equal("community" in plain, false);

  inGroup(sock, false, { isCommunity: true });
  const community = await svc.getGroupInfo(GROUP);
  assert.deepEqual(community.community, { is_community: true, parent_group_id: null });
  await svc.stop();
});

let seq = 0;

/** A text message in `chat`, stored the way a live one arrives; returns its message_id. */
function arrive(sock, chat, { fromMe = false, participant, ageSeconds = 3600 } = {}) {
  const id = `G${++seq}`;
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) },
        message: { conversation: "reclamă" },
        messageTimestamp: Math.floor(Date.now() / 1000) - ageSeconds,
      },
    ],
  });
  return `${fromMe}_${chat}_${id}`;
}

function recordSends(sock) {
  const sent = [];
  sock.sendMessage = async (jid, content) => {
    sent.push([jid, content]);
    return { key: { id: "X" } };
  };
  return sent;
}

test("an admin deletes someone else's group message: the key sent names the original sender", async () => {
  const { svc, sock } = writableService();
  inGroup(sock, true);
  const sent = recordSends(sock);
  // Older than the 2-day window that holds for the account's own messages.
  const messageId = arrive(sock, GROUP, { participant: ANA, ageSeconds: 3 * 86_400 });

  const result = await svc.deleteMessage(messageId, true);
  assert.deepEqual(result, { message_id: messageId, for_everyone: true });
  assert.equal(sent.length, 1);
  const [jid, content] = sent[0];
  assert.equal(jid, GROUP);
  assert.equal(content.delete.remoteJid, GROUP);
  assert.equal(content.delete.fromMe, false);
  assert.equal(content.delete.participant, ANA);
  assert.equal(content.delete.id, messageId.split("_").at(-1));
  await svc.stop();
});

test("deleting someone else's group message without admin is NOT_ADMIN, and nothing is sent", async () => {
  const { svc, sock } = writableService();
  inGroup(sock, false);
  const sent = recordSends(sock);
  const messageId = arrive(sock, GROUP, { participant: ANA });
  await assert.rejects(
    () => svc.deleteMessage(messageId, true),
    (err) => err.code === "NOT_ADMIN" && /make the linked account an admin/.test(err.fix ?? "")
  );
  assert.deepEqual(sent, []);
  await svc.stop();
});

test("someone else's message in a one-to-one chat is still NOT_OWN_MESSAGE, before any socket call", async () => {
  const { svc, sock } = writableService();
  const lookups = inGroup(sock, true);
  const sent = recordSends(sock);
  const messageId = arrive(sock, ANA);
  await assert.rejects(
    () => svc.deleteMessage(messageId, true),
    (err) => err.code === "NOT_OWN_MESSAGE"
  );
  assert.deepEqual(sent, []);
  assert.deepEqual(lookups, []);
  await svc.stop();
});

test("the account's own messages keep the 2-day window, in a group too, and go with their own key", async () => {
  const { svc, sock } = writableService();
  inGroup(sock, true);
  const sent = recordSends(sock);
  const old = arrive(sock, GROUP, { fromMe: true, ageSeconds: 3 * 86_400 });
  await assert.rejects(
    () => svc.deleteMessage(old, true),
    (err) => err.code === "RETRACT_WINDOW_EXPIRED"
  );
  const fresh = arrive(sock, ANA, { fromMe: true });
  await svc.deleteMessage(fresh, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].delete.fromMe, true);
  assert.equal("participant" in sent[0][1].delete, false);
  await svc.stop();
});

test("the manage_group schema accepts every new action and carries value and participant_ids through", async () => {
  const { svc, sock } = writableService();
  inGroup(sock, true);
  const calls = recordSettings(sock);
  sock.groupRequestParticipantsList = async () => [
    { jid: ANA, request_time: String(REQUESTED), request_method: "invite_link" },
  ];
  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: true });
  const { meta, handler } = server.tools.get("manage_group");
  const call = (args) => handler(z.object(meta.inputSchema).parse(args));

  for (const [action, value] of SETTINGS) {
    const result = await call({ group_id: GROUP, action, value });
    assert.equal(result.isError, undefined, `${action} ${value}`);
  }
  const listed = await call({ group_id: GROUP, action: "list_join_requests" });
  assert.match(listed.content[0].text, /- Ana \(\+40 700 000 002\) \(asked .+, via invite_link\)/);
  assert.equal(listed.structuredContent.join_requests[0].name, "Ana");
  await call({ group_id: GROUP, action: "approve_join_requests", participant_ids: [ANA] });
  await call({ group_id: GROUP, action: "reject_join_requests", participant_ids: [DAN] });
  assert.deepEqual(calls.slice(-2), [
    ["groupRequestParticipantsUpdate", GROUP, [ANA], "approve"],
    ["groupRequestParticipantsUpdate", GROUP, [DAN], "reject"],
  ]);
  assert.throws(() => z.object(meta.inputSchema).parse({ group_id: GROUP, action: "join_via_link" }));

  const bad = JSON.parse((await call({ group_id: GROUP, action: "set_disappearing", value: "1y" })).content[0].text);
  assert.equal(bad.error, "INVALID_ID");
  assert.match(bad.fix, /"24h", "7d", "90d"/);

  for (const action of ["list_join_requests", "set_join_approval", "set_disappearing"]) {
    assert.ok(meta.inputSchema.action.options.includes(action), action);
  }
  assert.match(meta.description, /shows to all members at once/);
  assert.match(server.tools.get("get_group_info").meta.description, /disappearing_seconds/);
  assert.match(server.tools.get("delete_message").meta.description, /admin/);
  const guide = (await server.tools.get("learn").handler({})).content[0].text;
  assert.match(guide, /list_join_requests/);
  assert.match(guide, /delete_message takes someone else's message/);
  await svc.stop();
});

test("manage_group creates a group from value and participant_ids, and asks for group_id on every other action", async () => {
  const { svc, sock } = writableService();
  const created = [];
  sock.groupCreate = async (subject, ids) => {
    created.push([subject, ids]);
    return { id: GROUP, subject, participants: ids.map((id) => ({ id })) };
  };
  const { call } = schemaCheckedTools(svc, { allowWrite: true });

  const made = await call("manage_group", { action: "create", value: "Bloc 12", participant_ids: [ANA] });
  assert.equal(made.structuredContent.group_id, GROUP);
  assert.deepEqual(made.structuredContent.participants, [{ id: ANA, status: "ok" }]);
  assert.match(made.content[0].text, /Group "Bloc 12" created/);
  assert.deepEqual(created, [["Bloc 12", [ANA]]]);

  assert.equal(textError(await call("manage_group", { action: "create", participant_ids: [ANA] })).error, "INVALID_ID");
  const missing = textError(await call("manage_group", { action: "leave" }));
  assert.equal(missing.error, "INVALID_ID");
  assert.match(missing.message, /leave needs group_id/);
  await svc.stop();
});
