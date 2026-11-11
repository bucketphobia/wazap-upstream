/**
 * A history batch is stored in transactions of a bounded duration, and the
 * bound is checked before every message: a chunk ends as soon as its budget is
 * spent, not at the next multiple of 32 messages.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";

const history = (n) =>
  Array.from({ length: n }, (_, i) => ({
    key: { remoteJid: `4071000000${i % 3}@s.whatsapp.net`, fromMe: false, id: `H${i}` },
    message: { conversation: `istoric ${i}` },
    messageTimestamp: Math.floor(Date.now() / 1000) - 3600 + i,
  }));

test("a spent budget ends the chunk at the next message", (t) => {
  const { svc } = connectedService(WhatsAppService, { prefix: "wazap-chunks-", id: ME, name: "Owner", config: { persistHistory: true } });
  t.after(() => svc.stop());
  const messages = history(40);
  // No time at all: one message, the first, then the check stops it.
  assert.equal(svc.db.transaction(() => svc.ingest.storeMessages(messages, 0, 0)), 1);
  assert.equal(svc.db.transaction(() => svc.ingest.storeMessages(messages, 5, 0)), 6, "from anywhere in the batch");
  // All the time in the world: the rest of the batch.
  assert.equal(svc.db.transaction(() => svc.ingest.storeMessages(messages, 6, Infinity)), 40);
  assert.equal(svc.db.counts().messages, 1 + 1 + 34);
});
