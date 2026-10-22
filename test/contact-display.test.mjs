import test from "node:test";
import assert from "node:assert/strict";
import { contactLabel, formatPhone } from "../dist/contact-display.js";
import { renderFindContact } from "../dist/find-contact.js";
import { skillInstructions } from "../dist/skills.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools } from "./helpers.mjs";

const PN = "40722123456@s.whatsapp.net";
const LID = "123456789012345@lid";
const GROUP = "120363000000000001@g.us";

test("known numbers format consistently without treating another numbering plan as Romanian", () => {
  assert.equal(formatPhone("40722123456"), "+40 722 123 456");
  assert.equal(formatPhone("+40 (722) 123-456"), "+40 722 123 456");
  assert.equal(formatPhone("+447700900123"), "+44 7700 900 123");
  assert.equal(formatPhone("+12025550123"), "+1 202 555 0123");
  assert.equal(formatPhone("+81312345678"), "+81312345678");
});

test("only real phone JIDs or known paired numbers can supply the phone", () => {
  assert.equal(contactLabel("Ana", PN), "Ana (+40 722 123 456)");
  assert.equal(contactLabel("Ana", LID, "+40722123456"), "Ana (+40 722 123 456)");
  for (const id of [LID, "40722123456@lid", "status@broadcast", "40722123456:3@s.whatsapp.net"]) {
    assert.equal(contactLabel("Ana", id), "Ana", id);
  }
  assert.equal(contactLabel("Bloc", GROUP, "40722123456"), "Bloc (group)");
  assert.equal(formatPhone(LID), LID);
  assert.equal(contactLabel("Ana", LID, LID), "Ana");
});

test("a phone or placeholder name is not repeated as if it were a saved name", () => {
  for (const name of ["40722123456", "+40 722 123 456", PN, "unknown (lid …2345)", "unknown", ""]) {
    assert.equal(contactLabel(name, LID, "40722123456"), "+40 722 123 456");
  }
  assert.equal(contactLabel("unknown (lid …2345)", LID), "unknown (lid …2345)");
  assert.equal(contactLabel(LID, LID), "Unknown (number unavailable)");
  assert.equal(contactLabel("Ana 123", PN), "Ana 123 (+40 722 123 456)");
});

test("resolved contacts show the phone beside the name and keep an explicit address for text-only clients", () => {
  const contact = { name: "Ana", chat_id: LID, number: "40722123456", account_id: "default", matched: { source: "name", value: "Ana", class: "exact" } };
  const structured = { status: "resolved", query: { name: "Ana" }, contact };
  const text = renderFindContact(structured);
  assert.match(text.split("\n")[0], /Ana \(\+40 722 123 456\)/);
  assert.ok(!text.split("\n")[0].includes(LID));
  assert.ok(text.includes(`\nchat_id: ${LID}`));
  assert.equal(structured.contact.chat_id, LID);
  assert.equal(structured.contact.number, "40722123456");
  const listed = renderFindContact({ status: "listed", query: { tag: "client" }, contacts: [contact] });
  assert.ok(listed.includes("- Ana (+40 722 123 456)"));
  assert.ok(listed.includes(`\n  chat_id: ${LID}`));
});

test("actual chat and group reads preserve structured ids while their person labels use phones", async (t) => {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-display-", id: "40700000001@s.whatsapp.net" });
  t.after(() => svc.stop());
  sock.ev.emit("contacts.upsert", [{ id: PN, name: "Ana" }]);
  svc.db.messages.upsert({ chatJid: PN, keyId: "DISPLAY", fromMe: false, ts: Date.now(), type: "text", text: "salut" });
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  const chats = await call("list_chats", {});
  assert.match(chats.content[0].text, /## Ana \(\+40 722 123 456\)/);
  assert.equal(chats.structuredContent.chats[0].chat_id, PN);
  const person = { contact_id: PN, name: "Ana", is_admin: false };
  svc.getGroupInfo = async () => ({ chat_id: GROUP, name: "Bloc", participant_count: 2, participants: [person, { contact_id: LID, name: "Dan", is_admin: true }], description: null, owner: null, created_at: null, announcement_only: false, i_am_admin: false, info_locked: false, member_add_mode: "all", join_approval: false, disappearing_seconds: 0 });
  const group = await call("get_group_info", { group_id: GROUP });
  assert.ok(!group.isError, JSON.stringify(group));
  assert.match(group.content[0].text, /- Ana \(\+40 722 123 456\)\n {2}contact_id: 40722123456@s.whatsapp.net\n- Dan \(admin\)/);
  assert.deepEqual(group.structuredContent.participants[0], person);
});

test("structured-content clients receive the same display instruction on initialization", () => {
  for (const allowWrite of [true, false]) {
    const text = skillInstructions([], { allowWrite, legacyReads: true });
    assert.match(text, /Show people by name and formatted phone when known; internal ids are for tool calls/);
    assert.match(text, /Never turn LID or group ids into phone numbers/);
  }
});
