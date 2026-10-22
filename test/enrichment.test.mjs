/**
 * Contact enrichment (friction B2). A stranger's first message brings only a
 * pushName — captured into the store and shown as the sender's name — but the
 * address book is the only proof a person is a saved contact, so a draft to
 * them flags `unnamed_recipient` until the phone's address book files them
 * under a real name. These pin that loop end to end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { registerTools } from "../dist/tools.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { asToolSource, connectedService } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";

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

const message = (chat, { pushName, text = "hi", id = "M1" } = {}) => ({
  key: { remoteJid: chat, fromMe: false, id },
  message: { conversation: text },
  messageTimestamp: Math.floor(Date.now() / 1000),
  ...(pushName ? { pushName } : {}),
});

/** A connected service allowed to write, with the socket answers a send path needs. */
function writableService() {
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-enrich-",
    id: ME,
    name: "Răzvan",
    config: { readOnly: false },
  });
  sock.onWhatsApp = async () => [{ exists: true }];
  sock.addOrEditContact = async () => {};
  return { svc, sock };
}

test("a stranger's pushName is captured, the draft flags it, and saving them on the phone clears the flag", async () => {
  const { svc, sock } = writableService();
  const peer = "40700000042@s.whatsapp.net";
  sock.ev.emit("messages.upsert", { type: "notify", messages: [message(peer, { pushName: "flormidable15" })] });
  assert.equal(svc.identity.displayName(peer), "flormidable15");

  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: true });
  const sendMessage = server.tools.get("send_message").handler;

  const flagged = await sendMessage({ chat_id: peer, text: "Salut!" });
  assert.equal(flagged.structuredContent.unnamed_recipient, true);
  assert.match(flagged.content[0].text, /To: flormidable15 \(\+40 700 000 042\)/);
  assert.match(flagged.content[0].text, /not a saved contact/);
  assert.match((flagged.structuredContent.notes ?? []).join(" "), /not a saved contact/, "said in the structured content too");

  // The user saves her on the phone; the address book reaches wazap as a contacts event.
  sock.ev.emit("contacts.upsert", [{ id: peer, name: "Florentina M" }]);

  const clean = await sendMessage({ chat_id: peer, text: "Salut!" });
  assert.equal(clean.structuredContent.unnamed_recipient, undefined);
  assert.equal(clean.structuredContent.notes, undefined);
  assert.match(clean.content[0].text, /To: Florentina M \(\+40 700 000 042\)/);
  await svc.stop();
});

test("a saved contact's draft carries no flag", async () => {
  const { svc, sock } = writableService();
  const peer = "40700000061@s.whatsapp.net";
  sock.ev.emit("contacts.upsert", [{ id: peer, name: "Ionut" }]);

  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: true });
  const drafted = await server.tools.get("send_message").handler({ chat_id: peer, text: "hi" });
  assert.equal(drafted.structuredContent.unnamed_recipient, undefined);
  assert.match(drafted.content[0].text, /To: Ionut \(\+40 700 000 061\)/);
  await svc.stop();
});

test("a contact known only by its public name is still flagged", async () => {
  const { svc, sock } = writableService();
  const peer = "40700000062@s.whatsapp.net";
  sock.ev.emit("contacts.upsert", [{ id: peer, notify: "ana-on-wa" }]);

  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: true });
  const drafted = await server.tools.get("send_message").handler({ chat_id: peer, text: "hi" });
  assert.equal(drafted.structuredContent.unnamed_recipient, true);
  assert.match(drafted.content[0].text, /To: ana-on-wa/);
  await svc.stop();
});

test("a group draft is never flagged, and the address book is not consulted", async () => {
  const { svc, sock } = writableService();
  const group = "120363000000000042@g.us";
  sock.groupMetadata = async (id) => ({
    id,
    subject: "Bloc 12",
    participants: [{ id: ME, phoneNumber: ME }],
    announce: false,
  });
  let lookups = 0;
  svc.searchContacts = async () => {
    lookups++;
    return [];
  };

  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: true });
  const drafted = await server.tools.get("send_message").handler({ chat_id: group, text: "hi" });
  assert.equal(drafted.structuredContent.unnamed_recipient, undefined);
  assert.match(drafted.content[0].text, /To: Bloc 12 \(group\)/);
  assert.equal(lookups, 0, "the flag check must not run for a group");
  await svc.stop();
});

test("a draft to the account's own number is not flagged either", async () => {
  const { svc, sock } = writableService();
  const self = "40700000001@s.whatsapp.net";
  sock.onWhatsApp = async () => [{ exists: true, jid: self }];
  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: true });
  const drafted = await server.tools.get("send_message").handler({ chat_id: self, text: "nota pentru mine" });
  assert.equal(drafted.structuredContent.unnamed_recipient, undefined);
  await svc.stop();
});

test("get_group_info marks participants whose names are only digits or an unresolved lid", async () => {
  const server = fakeServer();
  registerTools(
    server,
    asToolSource({
      getGroupInfo: async () => ({
        chat_id: "120363000000000099@g.us",
        name: "Bloc",
        description: null,
        owner: null,
        created_at: null,
        participant_count: 3,
        announcement_only: false,
        i_am_admin: false,
        participants: [
          { contact_id: "40700000061@s.whatsapp.net", name: "Ionut", is_admin: true },
          { contact_id: "40700000099@s.whatsapp.net", name: "40700000099", is_admin: false },
          { contact_id: "123123123123123@lid", name: "unknown (lid …3123)", is_admin: false },
        ],
      }),
    }),
    { allowWrite: false }
  );

  const result = await server.tools.get("get_group_info").handler({ group_id: "120363000000000099@g.us" });
  const text = result.content[0].text;
  assert.match(text, /- Ionut \(\+40 700 000 061\) \(admin\)\n {2}contact_id: 40700000061@s\.whatsapp\.net/);
  assert.match(text, /- \+40 700 000 099 \[unnamed\]\n {2}contact_id: 40700000099@s\.whatsapp\.net/);
  assert.match(text, /- unknown \(lid …3123\) \[unnamed\]\n {2}contact_id: 123123123123123@lid/);
});
