/**
 * How far the account's own messages got: the status a one-to-one receipt
 * reports, each member's receipt in a group, what a synced message already
 * carried, and all of it back after a restart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { proto } from "baileys";
import { z } from "zod";

import { isoWithOffset } from "../dist/messages.js";
import { registerTools } from "../dist/tools.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { asToolSource, connectedService, storedMarks } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ME_LID = "900000000000001@lid";
const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";
const ELA = "40700000004@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const STATUS = proto.WebMessageInfo.Status;
/** An hour ago, in the seconds WhatsApp stamps messages and receipts with. */
const T0 = Math.floor(Date.now() / 1000) - 3600;
const at = (seconds) => isoWithOffset(seconds * 1000);

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, meta, handler) {
      tools.set(name, { meta, handler });
    },
  };
}

function setup(config = {}) {
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-receipts-",
    id: ME,
    name: "Răzvan",
    config,
  });
  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: false });
  sock.ev.emit("contacts.upsert", [
    { id: ANA, name: "Ana" },
    { id: DAN, name: "Dan" },
    { id: ELA, name: "Ela" },
  ]);
  const call = (name, args = {}) => {
    const { meta, handler } = server.tools.get(name);
    return handler(z.object(meta.inputSchema).parse(args));
  };
  let seq = 0;
  /** A message in `chat`, the user's own unless said otherwise; `status` is what its proto carries, as a send's does. */
  const arrive = (chat, text, { fromMe = true, participant, status } = {}) => {
    const id = `R${++seq}`;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) },
          message: { conversation: text },
          messageTimestamp: T0,
          ...(status === undefined ? {} : { status }),
        },
      ],
    });
    return id;
  };
  /** A one-to-one receipt, the way Baileys reports it. */
  const status = (chat, id, value, { fromMe = true } = {}) =>
    sock.ev.emit("messages.update", [{ key: { remoteJid: chat, fromMe, id }, update: { status: value } }]);
  /** One group member's receipt, the way Baileys reports it. */
  const receipt = (id, user, fields, { fromMe = true } = {}) =>
    sock.ev.emit("message-receipt.update", [
      { key: { remoteJid: GROUP, fromMe, id, participant: user }, receipt: { userJid: user, ...fields } },
    ]);
  const view = async (chat, id, { fromMe = true } = {}) =>
    (await svc.readMessages(chat, 50)).data.find((m) => m.message_id === `${fromMe}_${chat}_${id}`);
  return { svc, sock, call, arrive, status, receipt, view };
}

test("a one-to-one message climbs from sent to delivered to read, and a late receipt never takes it back", async () => {
  const { arrive, status, view } = setup();
  const id = arrive(ANA, "ajung la 6");
  assert.equal((await view(ANA, id)).delivery, undefined, "nothing confirmed yet");

  status(ANA, id, STATUS.SERVER_ACK);
  assert.deepEqual((await view(ANA, id)).delivery, { status: "sent" });
  status(ANA, id, STATUS.DELIVERY_ACK);
  assert.deepEqual((await view(ANA, id)).delivery, { status: "delivered" });
  status(ANA, id, STATUS.READ);
  assert.deepEqual((await view(ANA, id)).delivery, { status: "read" });

  status(ANA, id, STATUS.DELIVERY_ACK);
  status(ANA, id, STATUS.SERVER_ACK);
  assert.deepEqual((await view(ANA, id)).delivery, { status: "read" }, "a delayed receipt does not lower it");
  status(ANA, id, STATUS.ERROR);
  assert.deepEqual((await view(ANA, id)).delivery, { status: "read" }, "nor does an error after it");
  status(ANA, id, STATUS.PLAYED);
  assert.deepEqual((await view(ANA, id)).delivery, { status: "played" });
});

test("a receipt's time is when it was read, and never becomes the message's own time", async () => {
  const { arrive, sock, view } = setup();
  const mine = arrive(ANA, "am plecat");
  sock.ev.emit("messages.update", [
    { key: { remoteJid: ANA, fromMe: true, id: mine }, update: { status: STATUS.DELIVERY_ACK, messageTimestamp: T0 + 600 } },
  ]);
  const sent = await view(ANA, mine);
  assert.equal(sent.delivery.status, "delivered");
  assert.equal(sent.timestamp, at(T0), "a delivery receipt does not move the user's message");

  const theirs = arrive(ANA, "bine", { fromMe: false });
  sock.ev.emit("messages.update", [
    { key: { remoteJid: ANA, fromMe: false, id: theirs }, update: { status: STATUS.READ, messageTimestamp: T0 + 900 } },
  ]);
  assert.equal((await view(ANA, theirs, { fromMe: false })).timestamp, at(T0), "reading it on the phone does not move it");

  sock.ev.emit("messages.update", [
    { key: { remoteJid: ANA, fromMe: false, id: theirs }, update: { messageTimestamp: T0 + 60 } },
  ]);
  assert.equal(
    (await view(ANA, theirs, { fromMe: false })).timestamp,
    at(T0 + 60),
    "an update that is not a receipt still sets the time, as before"
  );
});

test("an error stands only while nothing else was reported", async () => {
  const { arrive, status, view } = setup();
  const failed = arrive(ANA, "unu");
  status(ANA, failed, STATUS.ERROR);
  assert.deepEqual((await view(ANA, failed)).delivery, { status: "error" });
  status(ANA, failed, STATUS.SERVER_ACK);
  assert.deepEqual((await view(ANA, failed)).delivery, { status: "sent" }, "a later confirmation replaces it");

  const pending = arrive(ANA, "doi", { status: STATUS.PENDING });
  assert.deepEqual(
    (await view(ANA, pending)).delivery,
    { status: "pending" },
    "a send carries pending until the server answers"
  );
  status(ANA, pending, STATUS.ERROR);
  assert.deepEqual((await view(ANA, pending)).delivery, { status: "error" }, "and a failure is the answer");

  const delivered = arrive(ANA, "trei");
  status(ANA, delivered, STATUS.DELIVERY_ACK);
  status(ANA, delivered, STATUS.ERROR);
  assert.deepEqual(
    (await view(ANA, delivered)).delivery,
    { status: "delivered" },
    "an error after a confirmation is ignored"
  );
});

test("only the user's own messages carry a delivery", async () => {
  const { arrive, status, receipt, view } = setup();
  const theirs = arrive(ANA, "ce faci?", { fromMe: false });
  // Another device of the user's read it: Baileys reports that as READ on the incoming message.
  status(ANA, theirs, STATUS.READ, { fromMe: false });
  assert.equal((await view(ANA, theirs, { fromMe: false })).delivery, undefined);

  const inGroup = arrive(GROUP, "cine vine?", { fromMe: false, participant: DAN });
  receipt(inGroup, ANA, { readTimestamp: T0 + 60 }, { fromMe: false });
  assert.equal((await view(GROUP, inGroup, { fromMe: false })).delivery, undefined);
});

test("in a group each member's receipt is kept apart, the latest moment wins, and the message is as far as its furthest member", async () => {
  const { svc, arrive, receipt, view } = setup();
  const id = arrive(GROUP, "cine vine?");

  receipt(id, ANA, { receiptTimestamp: T0 + 60 });
  assert.deepEqual((await view(GROUP, id)).delivery, {
    status: "delivered",
    delivered_to: [{ id: ANA, name: "Ana", at: at(T0 + 60) }],
  });

  receipt(id, DAN, { readTimestamp: T0 + 120 });
  receipt(id, ANA, { receiptTimestamp: T0 + 30 });
  assert.deepEqual(
    (await view(GROUP, id)).delivery,
    {
      status: "read",
      read_by: [{ id: DAN, name: "Dan", at: at(T0 + 120) }],
      delivered_to: [{ id: ANA, name: "Ana", at: at(T0 + 60) }],
    },
    "one reader is enough, and the older delivery receipt that came late did not replace the newer one"
  );

  receipt(id, ANA, { readTimestamp: T0 + 180 });
  receipt(id, ANA, { readTimestamp: T0 + 150 });
  assert.deepEqual(
    (await view(GROUP, id)).delivery,
    {
      status: "read",
      read_by: [
        { id: DAN, name: "Dan", at: at(T0 + 120) },
        { id: ANA, name: "Ana", at: at(T0 + 180) },
      ],
    },
    "a member who read it is no longer listed as only delivered to"
  );
  assert.deepEqual(
    svc.db.messages.receipts(`true_${GROUP}_${id}`).find((r) => r.jid === ANA),
    { contactId: svc.db.identity.contact(ANA).id, jid: ANA, deliveredAt: (T0 + 60) * 1000, readAt: (T0 + 180) * 1000, playedAt: null }
  );
});

test("a synced message brings the status and receipts it already had, and live receipts only raise them", async () => {
  const { sock, status, receipt, view } = setup();
  const synced = (fields) => proto.WebMessageInfo.fromObject({ messageTimestamp: T0, ...fields });
  sock.ev.emit("messaging-history.set", {
    chats: [],
    contacts: [],
    isLatest: true,
    messages: [
      synced({
        key: { remoteJid: ANA, fromMe: true, id: "H1" },
        message: { conversation: "vechi" },
        status: STATUS.READ,
      }),
      synced({
        key: { remoteJid: GROUP, fromMe: true, id: "H2" },
        message: { conversation: "vechi în grup" },
        status: STATUS.DELIVERY_ACK,
        userReceipt: [
          { userJid: ANA, receiptTimestamp: T0 + 10, readTimestamp: T0 + 20 },
          { userJid: DAN, receiptTimestamp: T0 + 15 },
        ],
      }),
      synced({
        key: { remoteJid: ANA, fromMe: false, id: "H3" },
        message: { conversation: "de la Ana" },
        status: STATUS.READ,
      }),
      synced({ key: { remoteJid: ANA, fromMe: true, id: "H4" }, message: { conversation: "fără nimic" } }),
    ],
  });

  assert.deepEqual((await view(ANA, "H1")).delivery, { status: "read" });
  status(ANA, "H1", STATUS.DELIVERY_ACK);
  assert.deepEqual(
    (await view(ANA, "H1")).delivery,
    { status: "read" },
    "a lower live status does not lower the synced one"
  );
  status(ANA, "H1", STATUS.PLAYED);
  assert.deepEqual((await view(ANA, "H1")).delivery, { status: "played" });

  assert.deepEqual((await view(GROUP, "H2")).delivery, {
    status: "read",
    read_by: [{ id: ANA, name: "Ana", at: at(T0 + 20) }],
    delivered_to: [{ id: DAN, name: "Dan", at: at(T0 + 15) }],
  });
  receipt("H2", DAN, { readTimestamp: T0 + 40 });
  receipt("H2", ANA, { readTimestamp: T0 + 5 });
  assert.deepEqual((await view(GROUP, "H2")).delivery, {
    status: "read",
    read_by: [
      { id: ANA, name: "Ana", at: at(T0 + 20) },
      { id: DAN, name: "Dan", at: at(T0 + 40) },
    ],
  });

  assert.equal((await view(ANA, "H3", { fromMe: false })).delivery, undefined);
  assert.equal((await view(ANA, "H4")).delivery, undefined, "a proto with no status is not an error");
});

test("the account's own devices are no recipients, and a one-to-one message names nobody even when its proto lists receipts", async () => {
  const { sock, receipt, view } = setup();
  sock.user = { id: ME, lid: ME_LID };
  const synced = (fields) => proto.WebMessageInfo.fromObject({ messageTimestamp: T0, ...fields });
  sock.ev.emit("messaging-history.set", {
    chats: [],
    contacts: [],
    isLatest: true,
    messages: [
      synced({
        key: { remoteJid: GROUP, fromMe: true, id: "S1" },
        message: { conversation: "în grup" },
        status: STATUS.SERVER_ACK,
        userReceipt: [
          { userJid: ME_LID, receiptTimestamp: T0 + 5, readTimestamp: T0 + 6 },
          { userJid: ME, receiptTimestamp: T0 + 5, readTimestamp: T0 + 6 },
          { userJid: ANA, receiptTimestamp: T0 + 10 },
        ],
      }),
      synced({
        key: { remoteJid: ANA, fromMe: true, id: "S2" },
        message: { conversation: "direct" },
        status: STATUS.SERVER_ACK,
        userReceipt: [{ userJid: ANA, receiptTimestamp: T0 + 10, readTimestamp: T0 + 20 }],
      }),
    ],
  });

  const onlyAna = { status: "delivered", delivered_to: [{ id: ANA, name: "Ana", at: at(T0 + 10) }] };
  assert.deepEqual(
    (await view(GROUP, "S1")).delivery,
    onlyAna,
    "the account reading its own message is not a member reading it"
  );
  receipt("S1", ME_LID, { readTimestamp: T0 + 30 });
  receipt("S1", ME, { readTimestamp: T0 + 30 });
  assert.deepEqual((await view(GROUP, "S1")).delivery, onlyAna, "live, either spelling of the account");

  assert.deepEqual(
    (await view(ANA, "S2")).delivery,
    { status: "read" },
    "the status climbs, but there is no list of one"
  );
});

test("statuses and receipts come back after a restart, and go with their message", async () => {
  const first = setup({ persistHistory: true });
  const oneToOne = first.arrive(ANA, "gata");
  first.status(ANA, oneToOne, STATUS.READ);
  const inGroup = first.arrive(GROUP, "poza");
  first.receipt(inGroup, DAN, { readTimestamp: T0 + 90 });
  const silent = first.arrive(ANA, "nimic");
  assert.equal(first.svc.db.messages.get(`true_${ANA}_${oneToOne}`).status, STATUS.READ);
  assert.equal(first.svc.db.messages.get(`true_${ANA}_${silent}`).status, null, "nothing written for a message nobody confirmed");

  const second = setup({ persistHistory: true, dataDir: first.svc.config.dataDir });
  assert.deepEqual((await second.view(ANA, oneToOne)).delivery, { status: "read" });
  assert.deepEqual((await second.view(GROUP, inGroup)).delivery, {
    status: "read",
    read_by: [{ id: DAN, name: "Dan", at: at(T0 + 90) }],
  });
  assert.equal(
    (await second.view(ANA, silent)).delivery,
    undefined,
    "read back from the database, a message with no status is not an error"
  );

  const sid = `true_${GROUP}_${inGroup}`;
  first.sock.ev.emit("messages.delete", { keys: [{ remoteJid: GROUP, fromMe: true, id: inGroup }] });
  assert.equal(storedMarks(first.svc, sid).receipts, 0, "a deleted message takes its receipt rows with it");
  await first.svc.stop();
  await second.svc.stop();
});

test("read_messages tags the user's own messages with how far they got, and get_message says who read them and when", async () => {
  const { call, arrive, status, receipt } = setup();
  arrive(ANA, "ce faci?", { fromMe: false });
  const mine = arrive(ANA, "bine");
  status(ANA, mine, STATUS.READ);
  const sent = arrive(ANA, "tu?");
  status(ANA, sent, STATUS.SERVER_ACK);
  arrive(ANA, "încă nimic");

  const read = await call("read_messages", { chat_id: ANA });
  const tags = read.content[0].text
    .split("\n")
    .filter((line) => /^- \d{2}:\d{2} /.test(line))
    .map((line) => line.match(/ \[([^\]]*)\] · (true|false)_/)?.[1] ?? null);
  assert.deepEqual(tags, [null, "read", "sent", null]);
  assert.deepEqual(
    read.structuredContent.messages.map((m) => m.delivery?.status ?? null),
    [null, "read", "sent", null]
  );

  const direct = await call("get_message", { message_id: `true_${ANA}_${mine}` });
  assert.match(direct.content[0].text, /\[read\]/);
  assert.doesNotMatch(direct.content[0].text, /read by:/, "a one-to-one receipt names nobody");

  const photo = arrive(GROUP, "poza de azi");
  receipt(photo, ANA, { readTimestamp: T0 + 120 });
  receipt(photo, DAN, { readTimestamp: T0 + 60 });
  receipt(photo, ELA, { receiptTimestamp: T0 + 30 });
  const group = await call("read_messages", { chat_id: GROUP });
  assert.match(group.content[0].text, /\[read by 2\]/);

  const one = await call("get_message", { message_id: `true_${GROUP}_${photo}` });
  const hhmm = (seconds) => at(seconds).slice(11, 16);
  assert.match(one.content[0].text, new RegExp(`\n  read by: Dan \\(${hhmm(T0 + 60)}\\), Ana \\(${hhmm(T0 + 120)}\\)`));
  assert.match(one.content[0].text, new RegExp(`\n  delivered to: Ela \\(${hhmm(T0 + 30)}\\)`));
  assert.deepEqual(one.structuredContent.delivery, {
    status: "read",
    read_by: [
      { id: DAN, name: "Dan", at: at(T0 + 60) },
      { id: ANA, name: "Ana", at: at(T0 + 120) },
    ],
    delivered_to: [{ id: ELA, name: "Ela", at: at(T0 + 30) }],
  });
});
