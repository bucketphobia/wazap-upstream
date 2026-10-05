/**
 * The webhook allowlist: which chats are posted, #private, groups, an empty
 * filter, a per-account override, and cancelling a burst that is no longer
 * allowed. The last test drives the real CLI and a local receiver.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parse } from "dotenv";

import { WhatsAppService } from "../dist/whatsapp.js";
import { webhookAllowsMessage } from "../dist/webhook-filter.js";
import { WebhookSink, readWebhookSettings, webhookSignature } from "../dist/webhook.js";
import { GROUP, PEER, PEER_LID, T0, openTemp, sid, textMessage } from "./db-fixtures.mjs";
import { BINARY, childEnv, connectedService, storageRows, waitFor } from "./helpers.mjs";

const SECRET = "filter-test-secret";
const TOKEN = "cursor-automation-token";
const BUSINESS = PEER;
const STRANGER = "40700000003@s.whatsapp.net";
const PRIVATE = "40700000004@s.whatsapp.net";
const ME = "40700000001@s.whatsapp.net";

function store(db, chat, key, extra = {}) {
  const result = db.messages.upsert(textMessage(chat, key, T0, `text ${key}`, extra));
  const message = db.messages.get(result.sid);
  if (message === null) throw new Error(`no stored message for ${result.sid}`);
  return message;
}

function allows(db, filter, message) {
  return webhookAllowsMessage(db, filter, message);
}

test("no filter posts every chat, an empty one posts none, and a tag or a number posts only those", () => {
  const { db } = openTemp();
  try {
    db.identity.updateFields(BUSINESS, { addTags: ["autopeloc"] });
    db.identity.updateFields(STRANGER, { addTags: ["other"] });
    const business = store(db, BUSINESS, "B");
    const stranger = store(db, STRANGER, "S");
    const group = store(db, GROUP, "G", { senderJid: BUSINESS });
    assert.equal(allows(db, null, business), true);
    assert.equal(allows(db, null, stranger), true);
    assert.equal(allows(db, null, group), true);

    const empty = { chats: [], tag: null };
    assert.equal(allows(db, empty, business), false);
    assert.equal(allows(db, empty, group), false);

    const tag = { chats: [], tag: "autopeloc" };
    assert.equal(allows(db, tag, business), true);
    assert.equal(allows(db, tag, stranger), false, "a different tag does not match");
    assert.equal(allows(db, tag, group), false, "a member's tag does not include the group");

    const listed = { chats: ["40700000003"], tag: null };
    assert.equal(allows(db, listed, stranger), true, "a phone number matches the direct chat");
    assert.equal(allows(db, listed, business), false);
    assert.equal(allows(db, { chats: [GROUP], tag: null }, group), true);
    assert.equal(allows(db, { chats: [GROUP], tag: "autopeloc" }, business), true, "a tag and a list combine");
  } finally {
    db.close();
  }
});

test("a contact tagged #private is excluded even when listed or tagged, including what they write in a listed group", () => {
  const { db } = openTemp();
  try {
    db.identity.updateFields(PRIVATE, { addTags: ["autopeloc", "private"] });
    db.identity.updateFields(BUSINESS, { addTags: ["autopeloc"] });
    const direct = store(db, PRIVATE, "P");
    const own = store(db, PRIVATE, "ME", { fromMe: true });
    const inGroup = store(db, GROUP, "GP", { senderJid: PRIVATE });
    const ownerInGroup = store(db, GROUP, "GO", { fromMe: true });
    const filter = { chats: [PRIVATE, GROUP], tag: "autopeloc" };
    assert.equal(allows(db, filter, direct), false);
    assert.equal(allows(db, filter, own), false, "the owner's messages in that chat stay out too");
    assert.equal(allows(db, filter, inGroup), false);
    assert.equal(allows(db, filter, ownerInGroup), true, "the owner's own messages in a listed group still go");
    assert.equal(allows(db, null, direct), true, "with no filter, #private changes nothing");
  } finally {
    db.close();
  }
});

test("a phone number matches a lid chat once the number is known", async () => {
  const { db } = openTemp();
  try {
    await db.learnLidPhone(PEER_LID, PEER);
    db.identity.updateFields(PEER, { addTags: ["autopeloc"] });
    const message = store(db, PEER_LID, "L");
    assert.equal(allows(db, { chats: ["40700000002"], tag: null }, message), true);
    assert.equal(allows(db, { chats: [], tag: "autopeloc" }, message), true);
  } finally {
    db.close();
  }
});

test("readWebhookSettings treats a missing filter as off and an empty chat list as empty", () => {
  const base = { WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_URL: "http://127.0.0.1:9/hook", WAZAP_WEBHOOK_SECRET: SECRET };
  assert.equal(readWebhookSettings(base).filter, null);
  assert.equal(readWebhookSettings({ ...base, WAZAP_WEBHOOK_CHATS: "" }).filter.tag, null);
  assert.deepEqual(readWebhookSettings({ ...base, WAZAP_WEBHOOK_CHATS: "" }).filter.chats, []);
  assert.equal(readWebhookSettings({ ...base, WAZAP_WEBHOOK_TAG: "#Autopeloc" }).filter.tag, "autopeloc");
  const account = readWebhookSettings(
    { ...base, WAZAP_WEBHOOK_TAG: "global", WAZAP_WEBHOOK_CHATS: "40700000009" },
    { filter: { chats: [], tag: "autopeloc" } }
  );
  assert.deepEqual(account.filter, { chats: [], tag: "autopeloc" });
  assert.equal(readWebhookSettings({ ...base, WAZAP_WEBHOOK_COALESCE: "90" }).coalesce.capMs, 180_000);
  assert.equal(readWebhookSettings({ ...base }, { coalesce: 0 }).coalesce, null);
  assert.equal(readWebhookSettings(base).retryUnauthorized, false);
  assert.equal(readWebhookSettings({ ...base, WAZAP_WEBHOOK_RETRY_401: "on" }).retryUnauthorized, true);
  assert.equal(readWebhookSettings({ ...base, WAZAP_WEBHOOK_CHATS: "hello" }).kind, "invalid");
  assert.equal(readWebhookSettings({ ...base, WAZAP_WEBHOOK_COALESCE: "301" }).kind, "invalid");
});

/** The sink the service constructed reads process.env. These tests hand it the env under test instead. */
function useEnv(svc, env, account) {
  svc.webhook = new WebhookSink(env, account === undefined ? {} : { account });
}

function text(id, body, chat = BUSINESS) {
  return {
    key: { remoteJid: chat, fromMe: false, id },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: body },
  };
}

async function listen() {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    received.push({
      raw,
      body: JSON.parse(raw.toString("utf8")),
      signature: req.headers["x-wazap-signature"],
      authorization: req.headers.authorization,
      event: req.headers["x-wazap-event"],
    });
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("the service posts an allowlisted chat, skips the rest, and cancels a pending event when the tag is removed", async (t) => {
  const server = await listen();
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-filter-",
    id: ME,
    name: "Răzvan",
    config: { readOnly: false },
  });
  useEnv(svc, {
    WAZAP_WEBHOOK: "on",
    WAZAP_WEBHOOK_URL: server.url,
    WAZAP_WEBHOOK_SECRET: SECRET,
    WAZAP_WEBHOOK_EVENTS: "all",
    WAZAP_WEBHOOK_TAG: "autopeloc",
    WAZAP_WEBHOOK_CHATS: GROUP,
    WAZAP_WEBHOOK_COALESCE: "60",
  });
  t.after(async () => {
    await svc.stop();
    await server.close();
  });
  await svc.updateContactDetails(BUSINESS, { addTags: ["autopeloc"] });
  await svc.updateContactDetails(PRIVATE, { addTags: ["autopeloc", "private"] });

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      text("B1", "programare"),
      text("S1", "personal", STRANGER),
      {
        key: { remoteJid: STRANGER, fromMe: true, id: "SO" },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: "reply to a friend" },
      },
      text("P1", "secret", PRIVATE),
      {
        key: { remoteJid: GROUP, fromMe: false, id: "GP", participant: PRIVATE },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: "from the private member" },
      },
      {
        key: { remoteJid: GROUP, fromMe: true, id: "GO" },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: "from me in the group" },
      },
    ],
  });
  await svc.outbox.idle();
  const pending = storageRows(svc, "SELECT kind, state FROM events ORDER BY seq");
  assert.deepEqual(
    pending.map((row) => row.kind),
    ["message_received", "message_sent"],
    "the stranger, the #private chat and the #private group message were not queued"
  );
  assert.equal(server.received.length, 0, "the 60s window has not elapsed");

  await svc.updateContactDetails(BUSINESS, { removeTags: ["autopeloc"] });
  await svc.outbox.idle();
  const after = storageRows(svc, "SELECT kind, state, last_error FROM events ORDER BY seq");
  assert.equal(after[0].state, "cancelled");
  assert.match(after[0].last_error, /allowlist/);
  assert.equal(after[1].state, "pending", "the listed group is still allowed");
  assert.equal(server.received.length, 0);

  const status = svc.getStatus().webhook;
  assert.equal(status.allowlist, "tag autopeloc, 1 chat");
  assert.equal(status.coalesce_seconds, 60);
  assert.equal(status.retry_unauthorized, undefined);
});

test("an empty filter posts no message and still posts a connection event", async (t) => {
  const server = await listen();
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-filter-empty-",
    id: ME,
    name: "Răzvan",
    config: { readOnly: false },
  });
  useEnv(svc, {
    WAZAP_WEBHOOK: "on",
    WAZAP_WEBHOOK_URL: server.url,
    WAZAP_WEBHOOK_SECRET: SECRET,
    WAZAP_WEBHOOK_EVENTS: "all",
    WAZAP_WEBHOOK_CHATS: "",
  });
  t.after(async () => {
    await svc.stop();
    await server.close();
  });
  sock.ev.emit("messages.upsert", { type: "notify", messages: [text("E1", "nope")] });
  svc.setStatus("disconnected");
  await waitFor(() => server.received.length > 0, 3_000, "the connection event");
  assert.deepEqual(
    server.received.map((hit) => hit.body.event),
    ["connection"]
  );
  assert.equal(storageRows(svc, "SELECT count(*) AS n FROM events WHERE kind != 'connection'")[0].n, 0);
  assert.equal(svc.getStatus().webhook.allowlist, "empty");
});

test("a per-account tag replaces the global chat list", async (t) => {
  const server = await listen();
  const account = { id: "work", name: "Work", enabled: true, owner: null, webhook_tag: "autopeloc" };
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-filter-account-",
    id: ME,
    name: "Work",
    config: { readOnly: false },
    account,
  });
  useEnv(
    svc,
    {
      WAZAP_WEBHOOK: "on",
      WAZAP_WEBHOOK_URL: server.url,
      WAZAP_WEBHOOK_SECRET: SECRET,
      WAZAP_WEBHOOK_TAG: "other",
      WAZAP_WEBHOOK_CHATS: STRANGER,
    },
    account
  );
  t.after(async () => {
    await svc.stop();
    await server.close();
  });
  await svc.updateContactDetails(BUSINESS, { addTags: ["autopeloc"] });
  await svc.updateContactDetails(STRANGER, { addTags: ["other"] });
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [text("B1", "business"), text("S1", "stranger", STRANGER)],
  });
  await waitFor(() => server.received.length === 1, 3_000, "the tagged chat");
  assert.equal(server.received[0].body.chat_id, BUSINESS);
  assert.equal(server.received[0].body.text, "business");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(server.received.length, 1);
});

function wazap(dir, args, { input = "", env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BINARY, ...args, "--data-dir", dir], { env: childEnv(env) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== "") child.stdin.end(input);
    else child.stdin.end();
  });
}

test("CLI filter and coalesce: one signed POST for the allowlisted burst, nothing for the rest, and webhook test", async (t) => {
  const server = await listen();
  const dir = mkdtempSync(join(tmpdir(), "wazap-filter-e2e-"));
  t.after(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const on = await wazap(dir, ["config", "webhook", "on"], {
    input: `${SECRET}\n`,
    env: { WAZAP_WEBHOOK_URL: server.url },
  });
  assert.equal(on.code, 0, on.stderr);
  const auth = await wazap(dir, ["config", "webhook", "auth"], { input: `Bearer ${TOKEN}\n` });
  assert.equal(auth.code, 0, auth.stderr);
  const chats = await wazap(dir, ["config", "webhook", "chats", "40700000004"]);
  assert.equal(chats.code, 0, chats.stderr);
  const tag = await wazap(dir, ["config", "webhook", "tag", "autopeloc"]);
  assert.equal(tag.code, 0, tag.stderr);
  const window = await wazap(dir, ["config", "webhook", "coalesce", "1"]);
  assert.equal(window.code, 0, window.stderr);
  const shown = await wazap(dir, ["config"]);
  assert.match(shown.stderr, /filter: tag autopeloc, 1 chat/);
  assert.match(shown.stderr, /coalesce: 1s quiet, by 2s/);
  assert.match(shown.stderr, /auth: Authorization/);

  const configured = parse(readFileSync(join(dir, ".env"), "utf8"));
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-filter-e2e-",
    id: ME,
    name: "Răzvan",
    config: { dataDir: dir, readOnly: false },
  });
  useEnv(svc, configured);
  t.after(() => svc.stop());
  await svc.updateContactDetails(BUSINESS, { addTags: ["autopeloc"] });
  await svc.updateContactDetails(PRIVATE, { addTags: ["autopeloc", "private"] });

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      text("B1", "first line"),
      text("B2", "second line"),
      text("S1", "not a customer", STRANGER),
      text("P1", "family", PRIVATE),
    ],
  });
  await waitFor(() => server.received.length === 1, 5_000, "the coalesced POST");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(server.received.length, 1, "the stranger and the #private chat posted nothing");
  const hit = server.received[0];
  assert.equal(hit.event, "message_received");
  assert.equal(hit.authorization, `Bearer ${TOKEN}`);
  assert.equal(hit.signature, webhookSignature(hit.raw.toString("utf8"), SECRET));
  assert.equal(hit.body.chat_id, BUSINESS);
  assert.equal(hit.body.count, 2);
  assert.deepEqual(hit.body.texts, ["first line", "second line"]);
  assert.deepEqual(hit.body.message_ids, [sid(false, BUSINESS, "B1"), sid(false, BUSINESS, "B2")]);
  assert.equal(hit.body.text, "second line");
  assert.equal(hit.body.message_id, sid(false, BUSINESS, "B2"));
  assert.ok(hit.body.first_timestamp);

  const probe = await wazap(dir, ["webhook", "test"]);
  assert.equal(probe.code, 0, probe.stderr);
  assert.match(probe.stderr, /test delivered/);
  assert.equal(server.received.length, 2);
  assert.equal(server.received[1].body.text, "wazap webhook test");
  assert.equal(server.received[1].authorization, `Bearer ${TOKEN}`);
  assert.equal(server.received[1].signature, webhookSignature(server.received[1].raw.toString("utf8"), SECRET));
});
