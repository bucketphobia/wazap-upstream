import test from "node:test";
import assert from "node:assert/strict";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools } from "./helpers.mjs";

test("list_chats pages beyond 100 chats with stable ties and unchanged first-page ordering", async (t) => {
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-pagination-",
    id: "40700000000@s.whatsapp.net",
    name: "Owner",
  });
  t.after(() => svc.stop());
  for (let i = 0; i < 107; i++)
    svc.db.messages.upsert({
      chatJid: `40700${String(i).padStart(6, "0")}@s.whatsapp.net`,
      keyId: `key${i}`,
      fromMe: false,
      ts: Date.now() - 10000,
      type: "text",
      text: "fixture",
    });
  const expected = (await svc.listChats("all", 200)).data.map((c) => c.chat_id);
  const first = await svc.listChats("all", 100);
  assert.deepEqual(
    first.data.map((c) => c.chat_id),
    expected.slice(0, 100)
  );
  assert.ok(first.nextCursor);
  const second = await svc.listChats("all", 100, { cursor: first.nextCursor });
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    [...first.data, ...second.data].map((c) => c.chat_id),
    expected
  );
  await assert.rejects(svc.listChats("archived", 100, { cursor: first.nextCursor }), /cursor/i);
  await assert.rejects(svc.listChats("all", 100, { cursor: "bad" }), /cursor/i);
  const { call } = schemaCheckedTools(svc);
  const result = await call("list_chats", { limit: 100 });
  assert.equal(typeof result.structuredContent.next_cursor, "string");
  const next = await call("list_chats", { limit: 100, cursor: result.structuredContent.next_cursor });
  assert.equal(next.structuredContent.next_cursor, null);
});
