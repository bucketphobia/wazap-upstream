/**
 * Recall where it meets WhatsApp: live ingest feeds the embeddings in the
 * account database, edits and revokes rewrite them, a boot embeds whatever was
 * left unembedded, the search fuses words and meaning, and the feature stays
 * off unless asked for. The embedding backend is a stub /embedding server with
 * a word-concept table — enough for a paraphrase to share a concept and hit —
 * so llama.cpp and its model stay out of CI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proto } from "baileys";

import { WhatsAppService } from "../dist/whatsapp.js";
import { registerTools } from "../dist/tools.js";
import { EMBED_MODELS, readRecallSettings } from "../dist/recall/index.js";
import { asToolSource, connectedService, schemaCheckedTools } from "./helpers.mjs";
import { accountPaths } from "../dist/config.js";

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const DIMS = 768;
const MODEL = "embeddinggemma-300m";
const PROMPTS = EMBED_MODELS[MODEL].prompts;

const RECALL_ENV = [
  "WAZAP_RECALL",
  "WAZAP_EMBED_MODEL",
  "WAZAP_EMBED_BIN",
  "WAZAP_EMBED_URL",
  "WAZAP_RECALL_MIN_SIMILARITY",
];

/**
 * Words that mean the same thing share one slot, so a query can hit a message
 * that never repeats its words. Diacritics are folded first: „factură" and
 * "factura" are one token, and a paraphrase through English still lands.
 */
const CONCEPTS = [
  ["factura", "invoice", "bill"],
  ["chiria", "rent", "renta"],
  ["platit", "paid", "payment", "plata"],
  ["doctor", "medic", "appointment", "programare"],
  ["masina", "car", "auto"],
  ["aeroport", "airport", "terminal"],
];

function conceptOf(word) {
  const folded = word
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  for (const group of CONCEPTS) if (group.includes(folded)) return `c${CONCEPTS.indexOf(group)}`;
  return folded;
}

function vectorFor(text) {
  const vector = new Array(DIMS).fill(0);
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
    if (word === "") continue;
    const concept = conceptOf(word);
    let hash = 0;
    for (const ch of concept) hash = (hash * 31 + ch.codePointAt(0)) % 9973;
    vector[hash % DIMS] += 1;
  }
  return vector;
}

/**
 * A stand-in llama-server: POST /embedding → [{index, embedding: [[dims]]}].
 * `answer(texts, res)` may take a request over (answer it itself, or hold it)
 * by returning true.
 */
function stubEmbedServer({ answer } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/embedding") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const texts = [JSON.parse(body).content].flat();
      seen.push(...texts);
      if (answer?.(texts, res) === true) return;
      const reply = texts.map((_, index) => ({ index, embedding: [vectorFor(texts[index])] }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/**
 * The recall environment is read once, in the constructor — set around it.
 * bootStorage runs what start() runs before the socket: the import of any
 * legacy files, then a walk of the backlog the embedding feed owes.
 */
async function serviceWith(env, config = {}) {
  const saved = RECALL_ENV.map((key) => [key, process.env[key]]);
  for (const key of RECALL_ENV) delete process.env[key];
  // The stub's word-concept vectors sit far under the production cosine floor.
  Object.assign(process.env, { WAZAP_RECALL_MIN_SIMILARITY: "0" }, env);
  try {
    const connected = await connectedService(WhatsAppService, {
      prefix: "wazap-recall-",
      id: ME,
      name: "Răzvan",
      config: { persistHistory: true, ...config },
    });
    await connected.svc.bootStorage();
    return connected;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const text = (id, body, over = {}) => ({
  key: { remoteJid: PEER, fromMe: false, id },
  messageTimestamp: Math.floor(Date.now() / 1000),
  message: { conversation: body },
  ...over,
});

const deliver = (sock, messages) => sock.ev.emit("messages.upsert", { type: "notify", messages });

/** One history line the store loader accepts — the shape appendHistory writes. */
const historyLine = (raw, sid) => `${JSON.stringify({ sid, ts: raw.messageTimestamp, raw: encodeRaw(raw) })}\n`;
const encodeRaw = (raw) => Buffer.from(proto.WebMessageInfo.encode(raw).finish()).toString("base64");

test("live messages land in the index; placeholders do not", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [
      text("M1", "ți-am trimis factura pe e-mail ieri"),
      text("M2", "la ce ora e programarea la doctor?"),
      { ...text("M3"), message: { stickerMessage: { mimetype: "image/webp" } } },
      text("M4", "🥰🥰😘"),
      text("M5", "Da"),
    ]);
    await svc.recallIdle();
    assert.equal(svc.db.vectors.count(MODEL), 2);
    assert.ok(svc.db.vectors.get(`false_${PEER}_M1`));
    assert.ok(stub.seen.includes(`${PROMPTS.document}ți-am trimis factura pe e-mail ieri`));
    assert.ok(
      stub.seen.every((t) => t.startsWith(PROMPTS.document)),
      "documents are embedded under the model's document prompt"
    );
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("an edit re-embeds the message under its new text", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [text("M1", "ne vedem la aeroport la șase")]);
    await svc.recallIdle();
    const sid = `false_${PEER}_M1`;
    assert.ok(svc.db.vectors.get(sid));
    sock.ev.emit("messages.update", [
      { key: { remoteJid: PEER, fromMe: false, id: "M1" }, update: { message: { editedMessage: { message: { conversation: "ne vedem la aeroport la șapte" } } } } },
    ]);
    await svc.recallIdle();
    assert.equal(svc.db.vectors.count(MODEL), 1);
    assert.ok(svc.db.vectors.get(sid), "the new words have their vector");
    assert.equal(stub.seen.at(-1), `${PROMPTS.document}ne vedem la aeroport la șapte`);
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a revoke takes the vector of the message it takes back", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [text("M1", "parola de la masina e 1234"), text("M2", "ignora ce am scris")]);
    await svc.recallIdle();
    assert.equal(svc.db.vectors.count(MODEL), 2);
    deliver(sock, [
      {
        key: { remoteJid: PEER, fromMe: false, id: "R1" },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.REVOKE,
            key: { remoteJid: PEER, fromMe: false, id: "M1" },
          },
        },
      },
    ]);
    await svc.recallIdle();
    assert.equal(svc.db.vectors.get(`false_${PEER}_M1`), null);
    assert.equal(svc.db.vectors.count(MODEL), 1);
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a boot embeds what the database holds without a vector, once; a restart embeds only what is new", async () => {
  const stub = await stubEmbedServer();
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-recall-"));
  const historyDir = join(accountPaths(dataDir, "default").root, "history");
  mkdirSync(historyDir, { recursive: true });
  const file = join(historyDir, `${PEER}.jsonl`);
  writeFileSync(file, [
    historyLine(text("M1", "am plătit chiria pe toată luna"), `false_${PEER}_M1`),
    historyLine(text("M2", "factura vine săptămâna viitoare"), `false_${PEER}_M2`),
  ].join(""));
  try {
    // History existed before this wazap booted — the import brings it, the feed owes it vectors.
    const first = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url }, { dataDir });
    await first.svc.recallIdle();
    assert.equal(first.svc.db.vectors.count(MODEL), 2);
    const seenAfterFirst = stub.seen.length;
    await first.svc.stop();

    // A second boot over the same data dir finds every vector in place.
    const second = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url }, { dataDir });
    await second.svc.recallIdle();
    assert.equal(second.svc.db.vectors.count(MODEL), 2);
    assert.equal(stub.seen.length, seenAfterFirst, "nothing is embedded twice");

    // What arrives after the restart is the only new work.
    deliver(second.sock, [text("M3", "doctorul mi-a dat programare luni")]);
    await second.svc.recallIdle();
    assert.equal(second.svc.db.vectors.count(MODEL), 3);
    assert.equal(stub.seen.length, seenAfterFirst + 1, "the new message reached the embedder, and only it");
    await second.svc.stop();
  } finally {
    stub.server.close();
  }
});

test("persistHistory off keeps recall off — vectors would outlive their source", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith(
    { WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url },
    { persistHistory: false }
  );
  try {
    deliver(sock, [text("M1", "ceva ce nu trebuie indexat")]);
    await svc.recallIdle();
    assert.equal(svc.getStatus().recall.state, "off");
    assert.equal(svc.db.vectors.count(), 0);
    assert.deepEqual(stub.seen, []);
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a recall setting wazap does not know degrades to a line, not a crash", async () => {
  const { svc } = await serviceWith({ WAZAP_RECALL: "cloud-please" });
  try {
    const recall = svc.getStatus().recall;
    assert.equal(recall.state, "degraded");
    assert.match(recall.detail, /Unknown recall mode/);
    assert.equal(svc.status, "connected");
  } finally {
    await svc.stop();
  }
});

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

test("recall answers a Romanian paraphrase, ranked by score, with the date on the hit", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [
      text("M1", "ți-am trimis factura pe e-mail ieri"),
      text("M2", "la ce ora e programarea la doctor?"),
    ]);
    await svc.recallIdle();
    const { data } = await svc.recall("when did she send the invoice?", undefined, 10);
    assert.ok(
      stub.seen.at(-1).startsWith(PROMPTS.query),
      "the query is embedded under the model's query prompt"
    );
    assert.equal(data.hits[0].message.message_id, `false_${PEER}_M1`);
    assert.equal(data.hits[0].from_index, false);
    assert.ok(data.hits[0].similarity > 0);
    assert.match(data.hits[0].message.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(data.index.state, "ready");
    assert.equal(data.index.indexed, 2);
    const only = await svc.recall("invoice", undefined, 1);
    assert.equal(only.data.hits.length, 1, "limit caps the ranked list");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("chat, since/until and from narrow recall the way they narrow search_messages", async () => {
  const OTHER = "40700000003@s.whatsapp.net";
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    const nowS = Math.floor(Date.now() / 1000);
    deliver(sock, [
      text("M1", "factura pe e-mail"),
      text("M2", "factura veche", { messageTimestamp: nowS - 10 * 86_400 }),
      { ...text("X1", "factura de la altcineva"), key: { remoteJid: OTHER, fromMe: false, id: "X1" } },
      { ...text("ME1", "factura trimisa de mine"), key: { remoteJid: PEER, fromMe: true, id: "ME1" } },
    ]);
    await svc.recallIdle();
    assert.equal(svc.db.vectors.count(MODEL), 4);

    const inChat = await svc.recall("invoice", PEER, 10);
    assert.equal(inChat.data.hits.length, 3);
    assert.ok(inChat.data.hits.every((h) => h.message.chat_id === PEER));

    const since = await svc.recall("invoice", undefined, 10, { sinceMs: Date.now() - 86_400_000 });
    assert.ok(!since.data.hits.some((h) => h.message.message_id === `false_${PEER}_M2`), "the old one is before since");

    const until = await svc.recall("invoice", undefined, 10, { untilMs: Date.now() - 86_400_000 });
    assert.deepEqual(until.data.hits.map((h) => h.message.message_id), [`false_${PEER}_M2`]);

    const mine = await svc.recall("invoice", undefined, 10, { from: "me" });
    assert.deepEqual(mine.data.hits.map((h) => h.message.message_id), [`true_${PEER}_ME1`]);
    for (const self of [ME, ME.split("@")[0], `+${ME.split("@")[0]}`]) {
      const spelled = await svc.recall("invoice", undefined, 10, { from: self });
      assert.deepEqual(spelled.data.hits.map((h) => h.message.message_id), [`true_${PEER}_ME1`], `from ${self}`);
    }
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

/** A row the database holds only as text, the way the import files what only the old recall index still had. */
function textOnly(svc, id, words, over = {}) {
  svc.db.messages.upsert({ chatJid: PEER, keyId: id, fromMe: false, ts: Date.now() - 86_400_000, type: "text", text: words, raw: null, ...over });
}

test("a message the database holds only as text still answers, marked as from the index", async () => {
  const stub = await stubEmbedServer();
  const { svc } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    textOnly(svc, "M1", "factura din august, plătită integral");
    await svc.bootStorage();
    svc.recallIndex.embedFeed.kick(true);
    await svc.recallIdle();
    const sid = `false_${PEER}_M1`;
    const { data } = await svc.recall("the paid invoice", undefined, 5);
    const hit = data.hits.find((h) => h.message.message_id === sid);
    assert.ok(hit, "the database still holds it");
    assert.equal(hit.from_index, true);
    assert.equal(hit.message.text, "factura din august, plătită integral");
    assert.equal(hit.message.chat_id, PEER);
    assert.equal(hit.message.sender.id, PEER);
    assert.match(hit.message.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    // The same row answers keyword search and get_message with its text; it has no media to download.
    const words = await svc.searchMessages("plătită integral", undefined, 5);
    assert.deepEqual(words.data.map((m) => m.message_id), [sid]);
    assert.equal((await svc.getMessage(sid)).text, "factura din august, plătită integral");
    await assert.rejects(svc.downloadMedia(sid), (err) => err.code === "MEDIA_UNAVAILABLE");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a message held only as text cannot be quoted or forwarded, and says so before WhatsApp is asked", async () => {
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "off" }, { readOnly: false, rateLimitPerMinute: 0 });
  try {
    textOnly(svc, "OLD", "factura din august, plătită integral");
    const sent = [];
    // What Baileys does with a quote or a forward that has no content: it reads the missing message and throws.
    sock.sendMessage = async (jid, content, options = {}) => {
      if (options.quoted && !options.quoted.message) throw new TypeError("Cannot read properties of undefined (reading 'conversation')");
      if (content.forward && !content.forward.message) throw new TypeError("Cannot read properties of undefined (reading 'viewOnceMessage')");
      sent.push(jid);
      return { key: { remoteJid: jid, fromMe: true, id: `S${sent.length}` }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: content.text ?? "" } };
    };
    const sid = `false_${PEER}_OLD`;
    const refused = (err) => err.code === "MESSAGE_NOT_FOUND" && /only as text/.test(err.message) && typeof err.fix === "string";
    await assert.rejects(svc.sendMessage(PEER, "da, am plătit-o", sid), refused);
    await assert.rejects(svc.forwardMessage(sid, PEER), refused);
    await assert.rejects(svc.draft({ kind: "forward", chatId: PEER, messageId: sid }), refused);
    assert.deepEqual(sent, [], "nothing reached WhatsApp");
    await svc.sendMessage(PEER, "fără citat");
    assert.equal(sent.length, 1, "a send without the quote still goes");
  } finally {
    await svc.stop();
  }
});

test("recall off answers RECALL_UNAVAILABLE with the fix, and search falls back to the words", async () => {
  const { svc } = await serviceWith({});
  try {
    await assert.rejects(() => svc.recall("anything", undefined, 5), (err) => {
      assert.equal(err.code, "RECALL_UNAVAILABLE");
      assert.match(err.fix, /wazap config recall local/);
      return true;
    });
    const { call } = schemaCheckedTools(svc, { allowWrite: true });
    // The tool does not dead-end: it answers from the local history and says
    // semantic recall is off, with the command that turns it on.
    const result = await call("search", { query: "anything" });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.mode, "keyword_fallback");
    assert.match(result.structuredContent.recall_unavailable.fix, /wazap config recall local/);
    assert.match(result.content[0].text, /Meaning search is unavailable .*match the words only/);
    assert.match((result.structuredContent.notes ?? []).join(" "), /words only/, "said in the structured content too");
  } finally {
    await svc.stop();
  }
});

/** Whether a request to the stub embeds a search query, not a stored message. */
const isQuery = (texts) => texts.every((text) => text.startsWith(PROMPTS.query));

test("an embedding server that fails or refuses the query leaves search answering by words, and saying why", async () => {
  for (const [status, code] of [
    [500, "RECALL_FAILED"],
    [400, "RECALL_BAD_INPUT"],
  ]) {
    const stub = await stubEmbedServer({ answer: (texts, res) => isQuery(texts) && (res.writeHead(status).end(), true) });
    const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
    try {
      deliver(sock, [text("M1", "IBAN RO49AAAA1B31007593840000")]);
      await svc.recallIdle();
      await assert.rejects(() => svc.recall("IBAN", undefined, 5), { code });
      const { call } = schemaCheckedTools(svc, { allowWrite: false });
      const result = await call("search", { query: "IBAN" });
      assert.equal(result.isError, undefined, `HTTP ${status}`);
      assert.equal(result.structuredContent.mode, "keyword_fallback");
      assert.equal(result.structuredContent.recall_unavailable.code, code);
      assert.match(result.structuredContent.recall_unavailable.message, new RegExp(`HTTP ${status}`));
      assert.deepEqual(result.structuredContent.messages.map((m) => m.message_id), [`false_${PEER}_M1`]);
      assert.match(result.content[0].text, /Meaning search is unavailable .*match the words only/);
    } finally {
      await svc.stop();
      stub.server.close();
    }
  }
});

test("search waits for the query's meaning only so long, then answers by words; the next search has meaning again", async () => {
  let held = null;
  const stub = await stubEmbedServer({
    // The first query waits the way a sidecar starting cold would; the ones after it are answered at once.
    answer: (texts, res) => {
      if (!isQuery(texts) || held !== null) return false;
      held = res;
      return true;
    },
  });
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [text("M1", "ți-am trimis factura pe e-mail ieri")]);
    await svc.recallIdle();
    svc.recallIndex.recallQueryWaitMs = 150;
    const { call } = schemaCheckedTools(svc, { allowWrite: false });
    const started = Date.now();
    const cold = await call("search", { query: "factura" });
    assert.ok(Date.now() - started < 5_000, "the answer did not wait for the embedding");
    assert.equal(cold.structuredContent.mode, "keyword_fallback");
    assert.equal(cold.structuredContent.recall_unavailable.code, "TIMEOUT");
    assert.equal(cold.structuredContent.count, 1);
    held.destroy();
    const warm = await call("search", { query: "the invoice" });
    assert.equal(warm.structuredContent.mode, "hybrid");
    assert.equal(warm.structuredContent.count, 1);
  } finally {
    held?.destroy();
    await svc.stop();
    stub.server.close();
  }
});

test("while the index catches up, search by meaning and words still finds every message the words alone find", async () => {
  const held = [];
  // Stored messages are never embedded here: the index stays at none, catching up.
  const stub = await stubEmbedServer({ answer: (texts, res) => !isQuery(texts) && (held.push(res), true) });
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [
      text("VERBATIM", "programarea la dentist pentru copil e joi"),
      text("TWO", "am mutat programarea la dentist pe vineri"),
      text("OTHER", "nimic de spus aici"),
    ]);
    await svc.storageIdle();
    assert.equal(svc.getStatus().recall.state, "indexing");
    assert.equal(svc.db.vectors.count(MODEL), 0);
    const { call } = schemaCheckedTools(svc, { allowWrite: false });
    const keys = (result) => result.structuredContent.messages.map((m) => m.message_id.split("_").pop()).sort();
    for (const query of ["programarea la dentist pentru copil", "programarea la dentist"]) {
      const hybrid = await call("search", { query });
      const words = await call("search", { query, match: "words" });
      assert.equal(hybrid.structuredContent.mode, "hybrid");
      for (const key of keys(words)) assert.ok(keys(hybrid).includes(key), `${query}: ${key} is found by words but not by the default search`);
    }
  } finally {
    for (const res of held) res.destroy();
    await svc.stop();
    stub.server.close();
  }
});

test("a default search whose words fill more messages than it ranks says scan_capped, and tells how to narrow it", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    const at = Math.floor(Date.now() / 1000) - 3_600;
    deliver(sock, Array.from({ length: 105 }, (_, i) => text(`F${i}`, `factura numărul ${i}`, { messageTimestamp: at + i })));
    deliver(sock, [text("R1", "chiria pe septembrie", { messageTimestamp: at + 200 })]);
    await svc.recallIdle();
    const { call } = schemaCheckedTools(svc, { allowWrite: false });

    const common = await call("search", { query: "factura" });
    assert.equal(common.structuredContent.mode, "hybrid");
    assert.equal(common.structuredContent.scan_capped, true);
    assert.match(common.content[0].text, /older matches may be missing: narrow it with chat_id or since\/until, or pass match: "words"/);
    assert.match((common.structuredContent.notes ?? []).join(" "), /narrow it with chat_id or since\/until/, "said in the structured content too");

    const rare = await call("search", { query: "chiria" });
    assert.equal(rare.structuredContent.scan_capped, false);
    assert.doesNotMatch(rare.content[0].text, /older matches may be missing/);
    assert.doesNotMatch((rare.structuredContent.notes ?? []).join(" "), /narrow/);
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("the default search leaves the stories out, by words and by meaning", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    const at = Math.floor(Date.now() / 1000) - 60;
    deliver(sock, [
      { key: { remoteJid: "status@broadcast", fromMe: false, id: "S1", participant: PEER }, messageTimestamp: at, message: { conversation: "factura la mare 🌊" }, pushName: "Ana" },
      text("M1", "ți-am trimis factura", { messageTimestamp: at + 1 }),
    ]);
    await svc.recallIdle();
    const { call } = schemaCheckedTools(svc, { allowWrite: false });
    for (const query of ["factura", "the invoice"]) {
      const result = await call("search", { query });
      assert.equal(result.structuredContent.mode, "hybrid");
      assert.deepEqual(result.structuredContent.messages.map((m) => m.chat_id), [PEER], `${query}: the chat message, never the story`);
    }
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("the default search leaves a #private person out before its limit and counts them, by meaning and words as by words alone, and names them on request", async () => {
  const ANA = "40700000005@s.whatsapp.net";
  const GROUP = "120363000000000009@g.us";
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    const at = Math.floor(Date.now() / 1000) - 3_600;
    const from = (chat, id, body, ts, key = {}) => ({ key: { remoteJid: chat, fromMe: false, id, ...key }, messageTimestamp: ts, message: { conversation: body } });
    // Hers rank first: the newest, and the closest to the query. Six public ones follow, each in its own chat.
    deliver(sock, [
      from(ANA, "A1", "factura terapie", at + 30),
      from(ANA, "A2", "factura mâine", at + 29, { fromMe: true }),
      from(GROUP, "A3", "factura clinică", at + 28, { participant: ANA }),
      ...["service auto de ieri", "la curent pe luna august", "comună a blocului nostru", "de la grădiniță pentru copii", "pentru chirie și utilități", "la telefon din iulie trecut"].map((rest, i) =>
        from(i === 2 ? GROUP : `4070000010${i}@s.whatsapp.net`, `P${i}`, `factura ${rest}`, at + 20 - i, i === 2 ? { participant: PEER } : {})
      ),
    ]);
    await svc.recallIdle();
    svc.db.identity.updateFields(ANA, { addTags: ["private"] });
    const { call } = schemaCheckedTools(svc, { allowWrite: false });
    for (const match of ["hybrid", "words"]) {
      const broad = await call("search", { query: "factura", match, limit: 5 });
      assert.equal(broad.structuredContent.mode, match);
      assert.equal(broad.structuredContent.count, 5, `${match}: the limit counts what is shown`);
      assert.equal(broad.structuredContent.private_omitted, 3, match);
      assert.ok(broad.structuredContent.messages.every((m) => !m.message_id.includes(ANA) && m.message_id.split("_").pop() !== "A3"), match);
      for (const words of ["terapie", "mâine", "clinică"]) assert.ok(!broad.content[0].text.includes(words), `${match}: ${words}`);
      assert.match(broad.content[0].text, /3 matches from people tagged #private left out/);

      const chat = await call("search", { query: "factura", match, chat_id: ANA });
      assert.deepEqual(chat.structuredContent.messages.map((m) => m.message_id.split("_").pop()).sort(), ["A1", "A2"], match);
      const author = await call("search", { query: "factura", match, from: ANA });
      assert.deepEqual(author.structuredContent.messages.map((m) => m.message_id.split("_").pop()).sort(), ["A1", "A3"], match);
      assert.equal(author.structuredContent.private_omitted, undefined, match);
    }
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("someone tagged #private who does not match leaves the default search's ranking as it was: the variety rules walk the same window", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    const at = Math.floor(Date.now() / 1000) - 3_600;
    const busy = "40700000101@s.whatsapp.net";
    const quiet = "40700000102@s.whatsapp.net";
    const sids = [];
    for (const [chat, count] of [[busy, 100], [quiet, 50]]) {
      for (let i = 0; i < count; i++) {
        deliver(sock, [{ key: { remoteJid: chat, fromMe: false, id: `${chat.slice(10, 12)}${i}` }, messageTimestamp: at - sids.length, message: { conversation: `factura ${sids.length}` } }]);
        sids.push(`false_${chat}_${chat.slice(10, 12)}${i}`);
      }
    }
    // The ranking itself is not under test: the busy chat's hundred first, then the quiet one's fifty, as many as asked for.
    const rows = sids.map((sid) => svc.db.messages.get(sid));
    svc.db.vectors.hybrid = (input) => ({
      hits: rows.slice(0, input.limit).map((message, i) => ({ message, score: 1 - i / 1000, lexicalRank: i + 1, semanticRank: null, similarity: null })),
      semantic: true,
      lexicalCapped: false,
    });
    const { call } = schemaCheckedTools(svc, { allowWrite: false });
    const ranked = async () => (await call("search", { query: "factura", limit: 5 })).structuredContent.messages.map((m) => m.chat_id);
    const before = await ranked();
    assert.deepEqual(before, [busy, busy, busy, busy, busy], "three slots to the busy chat, then its overflow: the quiet chat is past the window");
    svc.db.identity.updateFields("40700000103@s.whatsapp.net", { addTags: ["private"] });
    assert.deepEqual(await ranked(), before);
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a revoked message leaves the default search, by words and by meaning", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    const at = Math.floor(Date.now() / 1000) - 60;
    deliver(sock, [text("M1", "factura cu parola hunter2", { messageTimestamp: at }), text("M2", "altă factura", { messageTimestamp: at + 1 })]);
    await svc.recallIdle();
    const { call } = schemaCheckedTools(svc, { allowWrite: false });
    const found = async (query) => (await call("search", { query })).structuredContent.messages.map((m) => m.message_id.split("_").pop()).sort();
    assert.deepEqual(await found("factura"), ["M1", "M2"]);
    deliver(sock, [
      {
        key: { remoteJid: PEER, fromMe: false, id: "R1" },
        messageTimestamp: at + 2,
        message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { remoteJid: PEER, fromMe: false, id: "M1" } } },
      },
    ]);
    await svc.recallIdle();
    assert.deepEqual(await found("factura"), ["M2"], "by words");
    assert.deepEqual(await found("the invoice"), ["M2"], "by meaning");
    assert.deepEqual(await found("hunter2"), [], "not even its own words");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("when even the keyword fallback cannot run, search stays a hard error", async () => {
  const { svc } = await serviceWith({});
  // Nothing linked: recall refuses NOT_LINKED before the index question ever
  // comes up, and the fallback's own search would refuse the same way.
  svc.status = "not_linked";
  try {
    const server = fakeServer();
    registerTools(server, asToolSource(svc), { allowWrite: true });
    const dead = await server.tools.get("search").handler({ query: "anything" });
    assert.equal(dead.isError, true);
    assert.equal(JSON.parse(dead.content[0].text).error, "NOT_LINKED");
    assert.equal(dead.structuredContent, undefined, "no fallback was claimed");
  } finally {
    await svc.stop();
  }
});

test("a fallback that itself fails stays a hard error, not a crash", async () => {
  const { svc } = await serviceWith({});
  try {
    const server = fakeServer();
    registerTools(server, asToolSource(svc), { allowWrite: true });
    // Recall is off; the fallback then meets the same bad chat_id.
    const result = await server.tools.get("search").handler({ query: "x", chat_id: "x@nope.invalid" });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, "INVALID_ID");
    assert.equal(result.structuredContent, undefined);
    assert.doesNotMatch(result.content[0].text, /keyword_fallback/);
  } finally {
    await svc.stop();
  }
});

test("recall on but history off names the missing piece, not the feature", async () => {
  const stub = await stubEmbedServer();
  const { svc } = await serviceWith(
    { WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url },
    { persistHistory: false }
  );
  try {
    await assert.rejects(() => svc.recall("x", undefined, 5), (err) => {
      assert.equal(err.code, "RECALL_UNAVAILABLE");
      assert.match(err.fix, /WAZAP_PERSIST_HISTORY/);
      return true;
    });
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a recall env wazap cannot parse answers RECALL_UNAVAILABLE, not a crash", async () => {
  const { svc } = await serviceWith({ WAZAP_RECALL: "cloud-please" });
  try {
    await assert.rejects(() => svc.recall("x", undefined, 5), (err) => {
      assert.equal(err.code, "RECALL_UNAVAILABLE");
      assert.match(err.message, /Unknown recall mode/);
      return true;
    });
  } finally {
    await svc.stop();
  }
});

test("recall settings that stop parsing keep no embedding queue that nothing would drain", async () => {
  const stub = await stubEmbedServer();
  const first = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  const dataDir = first.svc.config.dataDir;
  try {
    deliver(first.sock, [text("A", "primul mesaj")]);
    await first.svc.recallIdle();
  } finally {
    await first.svc.stop();
  }
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url, WAZAP_EMBED_MODEL: "no-such-model" }, { dataDir });
  try {
    assert.equal(svc.getStatus().recall.state, "degraded");
    deliver(sock, Array.from({ length: 50 }, (_, i) => text(`M${i}`, `mesaj ${i}`)));
    await svc.storageIdle();
    assert.equal(svc.db.vectors.queueSize(), 0, "nothing is queued for a feed that does not run");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("the tool renders each hit with its date, score, what matched and the index-only mark", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [text("M1", "ți-am trimis factura pe e-mail ieri")]);
    // M2 is a row only the old index still had: the database keeps its words, not its protobuf.
    textOnly(svc, "M2", "factura veche din index");
    svc.recallIndex.embedFeed.kick(true);
    await svc.recallIdle();

    const { call } = schemaCheckedTools(svc, { allowWrite: false });
    const result = await call("search", { query: "the invoice" });
    assert.equal(result.isError, undefined);
    const out = result.content[0].text;
    assert.match(out, /# Search results for "the invoice" \(2\)/);
    assert.match(out, /score \d\.\d{3}, meaning/);
    assert.match(out, /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    assert.match(out, /index only/);
    assert.match(out, /factura veche din index/);
    assert.equal(result.structuredContent.count, 2);
    assert.equal(result.structuredContent.index.state, "ready");
    assert.equal(result.structuredContent.mode, "hybrid");
    const evicted = result.structuredContent.messages.find((m) => m.from_index);
    assert.equal(evicted.message_id, `false_${PEER}_M2`);
    assert.equal(evicted.text, "factura veche din index");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("an over-cap message re-delivered is not re-embedded, and the embedder only ever sees the capped text", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    const long = `factura ${"pe e-mail ".repeat(400)}`; // ~3.6k chars, over the index cap
    deliver(sock, [text("M1", long)]);
    await svc.recallIdle();
    const seenAfterFirst = stub.seen.length;
    const embedded = stub.seen.at(-1).slice(PROMPTS.document.length);
    assert.ok(embedded.length < long.length, "the embedder sees the capped text");
    assert.equal(embedded, long.slice(0, embedded.length));
    // A reconnect or history re-sync delivers the same raw again.
    deliver(sock, [text("M1", long)]);
    await svc.recallIdle();
    assert.equal(stub.seen.length, seenAfterFirst, "same words are not fresh work");
    assert.equal(svc.db.vectors.count(MODEL), 1);
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("the similarity floor drops noise hits instead of listing them", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({
    WAZAP_RECALL: "local",
    WAZAP_EMBED_URL: stub.url,
    WAZAP_RECALL_MIN_SIMILARITY: "0.9",
  });
  try {
    deliver(sock, [text("M1", "ți-am trimis factura pe e-mail ieri")]);
    await svc.recallIdle();
    const { data } = await svc.recall("when did she send the invoice?", undefined, 10);
    assert.equal(data.hits.length, 0, "a stub-strength match sits under a real floor");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("the floor defaults to the model's own, and the env override wins over both", () => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-recall-"));
  assert.equal(
    readRecallSettings({}, dir).minSimilarity,
    EMBED_MODELS["embeddinggemma-300m"].defaultMinSimilarity
  );
  const e5 = readRecallSettings({ WAZAP_EMBED_MODEL: "e5-base-multilingual" }, dir);
  assert.equal(e5.minSimilarity, EMBED_MODELS["e5-base-multilingual"].defaultMinSimilarity);
  assert.notEqual(e5.minSimilarity, 0.35, "e5 must not silently inherit gemma's floor");
  const bge = readRecallSettings({ WAZAP_EMBED_MODEL: "bge-m3" }, dir);
  assert.equal(bge.model, "bge-m3");
  assert.equal(bge.minSimilarity, 0.55, "bge-m3 prices similarity higher than gemma");
  for (const model of ["embeddinggemma-300m", "e5-base-multilingual", "bge-m3"]) {
    const env = { WAZAP_EMBED_MODEL: model, WAZAP_RECALL_MIN_SIMILARITY: "0.5" };
    assert.equal(readRecallSettings(env, dir).minSimilarity, 0.5, model);
  }
});

test("a min-similarity outside 0..1 is refused at parse, whichever model is picked", () => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-recall-"));
  for (const bad of ["2", "-0.1", "soon"]) {
    assert.throws(
      () => readRecallSettings({ WAZAP_RECALL_MIN_SIMILARITY: bad }, dir),
      (err) => {
        assert.equal(err.code, "INVALID_ID");
        assert.match(err.message, /MIN_SIMILARITY/);
        return true;
      },
      bad
    );
  }
});

test("the idle window is fixed at 30 minutes, whatever the retired setting says", () => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-recall-"));
  assert.equal(readRecallSettings({}, dir).embedIdleMs, 30 * 60_000);
  for (const retired of ["0", "1.5", "soon"]) {
    assert.equal(readRecallSettings({ WAZAP_EMBED_IDLE_MINUTES: retired }, dir).embedIdleMs, 30 * 60_000, retired);
  }
  assert.equal(readRecallSettings({ WAZAP_RECALL_MAX: "junk" }, dir).enabled, false, "a retired cap no longer refuses to start");
});

test("weak matches are flagged, not sold as answers", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [text("M1", "ți-am trimis factura pe e-mail ieri")]);
    await svc.recallIdle();
    const server = fakeServer();
    registerTools(server, asToolSource(svc), { allowWrite: false });
    const result = await server.tools.get("search").handler({ query: "the invoice" });
    assert.match(result.content[0].text, /Weak matches only/);
    assert.match((result.structuredContent.notes ?? []).join(" "), /Weak matches only/, "said in the structured content too");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a min-similarity wazap cannot parse degrades to a line, not a crash", async () => {
  const stub = await stubEmbedServer();
  const { svc } = await serviceWith({
    WAZAP_RECALL: "local",
    WAZAP_EMBED_URL: stub.url,
    WAZAP_RECALL_MIN_SIMILARITY: "2",
  });
  try {
    const recall = svc.getStatus().recall;
    assert.equal(recall.state, "degraded");
    assert.match(recall.detail, /MIN_SIMILARITY/);
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a bad since is INVALID_ID, the same with meaning as with words", async () => {
  const stub = await stubEmbedServer();
  const { svc } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    const server = fakeServer();
    registerTools(server, asToolSource(svc), { allowWrite: true });
    const result = await server.tools.get("search").handler({ query: "x", since: "last Tuesdayish" });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, "INVALID_ID");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("words and meaning fuse: a hit both sides find outranks one only its meaning found", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [text("WORDS", "factura de la gaz"), text("MEANING", "bill pentru curent")]);
    await svc.recallIdle();
    const { data } = await svc.recall("factura", undefined, 10);
    assert.deepEqual(
      data.hits.map((h) => [h.message.message_id, h.matched]),
      [
        [`false_${PEER}_WORDS`, "both"],
        [`false_${PEER}_MEANING`, "meaning"],
      ]
    );
    assert.ok(data.hits[0].score > data.hits[1].score);
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a hit under the floor is listed only when its words match the query", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({
    WAZAP_RECALL: "local",
    WAZAP_EMBED_URL: stub.url,
    WAZAP_RECALL_MIN_SIMILARITY: "0.3",
  });
  try {
    deliver(sock, [
      text("GOOD", "cata medic"),
      // Both words, far apart in a long list: listed for its words, though its meaning is under the floor.
      text("NOISE", "cata pelerina rucsac munte cort saci medic"),
      text("FAR", "doctor pelerina rucsac munte cort saci lanterna"),
    ]);
    await svc.recallIdle();
    assert.equal(svc.db.vectors.count(MODEL), 3);
    const { data } = await svc.recall("cata medic", undefined, 10);
    assert.deepEqual(
      data.hits.map((h) => h.message.message_id),
      [`false_${PEER}_GOOD`, `false_${PEER}_NOISE`],
      "the meaning-only neighbour under the floor is dropped"
    );
    const noise = data.hits[1];
    assert.ok(noise.similarity < 0.3, "the one listed under the floor is there for its words");
    assert.notEqual(noise.matched, "meaning");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a Romanian question of three words or more: a paraphrase or two shared words answer it, one shared word does not", async () => {
  const stub = await stubEmbedServer();
  // Over every one-word neighbour's stub similarity (≤ 0.19) and under the paraphrase's (0.27).
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url, WAZAP_RECALL_MIN_SIMILARITY: "0.25" });
  try {
    deliver(sock, [
      // A paraphrase: no word of the question, its meaning through the concept table.
      text("PARA", "Rent paid azi"),
      // Two words of the question in a long message the stub finds far in meaning.
      text("LEX", "Am sunat cabinetul: programarea la dentist s-a mutat pe joi după-amiază, fiindcă doamna are o urgență și nu mai primește pe nimeni dimineață până vineri"),
      // Long messages carrying one word of some question each.
      text("PLASMA", "Am citit azi un articol lung despre donarea de plasma la centrul de transfuzii, apoi am trecut pe la piață după roșii și brânză pentru cina de sâmbătă seara"),
      text("CONTAIN", "Echipa de la bloc a pus un containment provizoriu în jurul țevii sparte din subsol, dar apa tot a ajuns în boxele vecinilor până a venit instalatorul spre seară"),
      text("FIELD", "Meciul copiilor s-a mutat pe field-ul din spatele școlii, fiindcă terenul mare e închis toată săptămâna pentru gazon nou și un gard refăcut de primărie"),
      text("CALIB", "Tehnicianul vine mâine dimineață pentru calibration la imprimanta cea nouă de la birou, deci ajung mai târziu și nu mai prind ședința de la nouă"),
      text("PROC", "Procedure-ul băncii pentru cardul nou durează două săptămâni, așa că le-am cerut să mi-l trimită prin curier acasă, nu la sucursala din centru"),
      text("CHIRIA", "Proprietarul ne-a scris că de anul viitor chiria o să crească puțin, dar ne lasă să plătim la fel până în martie dacă semnăm contractul pe încă doi ani"),
      text("COPIL", "Am dus copilul la bunici o săptămână, iar noi plecăm la mare cu prietenii din facultate dacă prindem vreme bună"),
    ]);
    await svc.recallIdle();
    assert.equal(svc.db.vectors.count(MODEL), 9);
    const answer = async (query) => (await svc.recall(query, undefined, 10)).data.hits;
    const keys = (hits) => hits.map((h) => h.message.message_id.split("_").pop());

    const paraphrase = await answer("Ai plătit chiria lunii asta?");
    assert.deepEqual(keys(paraphrase), ["PARA"], "CHIRIA shares one word and nothing else");
    assert.equal(paraphrase[0].matched, "meaning");
    const words = await answer("Când e programarea la dentist pentru copil?");
    assert.deepEqual(keys(words), ["LEX"], "the one-word neighbours through „pentru” and „copil” are dropped");
    assert.ok(words[0].similarity < 0.25, "LEX is there for its two words, not its meaning");
    assert.deepEqual(keys(await answer("plasma containment field calibration procedure")), []);
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a forwarded copy with the same words is listed once", async () => {
  const OTHER = "40700000003@s.whatsapp.net";
  const THIRD = "40700000004@s.whatsapp.net";
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    const forwarded = "Petrecerea de sâmbătă e la Ana acasă, adresa e strada Florilor 12, etajul 3, interfon 7; aduceți ceva de băut și veniți după ora opt";
    deliver(sock, [
      { ...text("X1", forwarded), key: { remoteJid: OTHER, fromMe: false, id: "X1" } },
      { ...text("Y1", forwarded), key: { remoteJid: THIRD, fromMe: false, id: "Y1" } },
    ]);
    await svc.recallIdle();
    const { data } = await svc.recall("Care e adresa pentru petrecerea de sâmbătă?", undefined, 10);
    assert.deepEqual(data.hits.map((h) => h.message.text), [forwarded], "the second copy says nothing the first did not");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a one-chat cluster cannot fill the list — another chat's relevant hit surfaces", async () => {
  const OTHER = "40700000003@s.whatsapp.net";
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    // Four PEER hits all outrank the OTHER one; the chat's cap of three leading slots keeps the fourth from taking its place.
    deliver(sock, [
      text("M1", "medicamentul copilului dimineata"),
      text("M2", "medicamentul copilului la pranz"),
      text("M3", "medicamentul copilului seara"),
      text("M4", "medicamentul copilului in weekend"),
      { ...text("X1", "medicamentul e in dulap"), key: { remoteJid: OTHER, fromMe: false, id: "X1" } },
    ]);
    await svc.recallIdle();
    const { data } = await svc.recall("medicamentul copilului", undefined, 10);
    assert.deepEqual(
      data.hits.map((h) => h.message.chat_id),
      [PEER, PEER, PEER, OTHER, PEER],
      "the chat cap demotes the fourth cluster hit below the other chat's"
    );
    assert.equal(data.hits.length, 5, "demotion keeps every relevant hit reachable");
    const scoped = await svc.recall("medicamentul copilului", PEER, 10);
    assert.equal(scoped.data.hits.length, 4, "a search scoped to one chat is not capped");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a near-duplicate in a second chat trails the list instead of taking a slot", async () => {
  const OTHER = "40700000003@s.whatsapp.net";
  const THIRD = "40700000004@s.whatsapp.net";
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    deliver(sock, [
      text("M1", "confirmat petrecerea de sambata"),
      { ...text("X1", "Confirmat petrecerea de sâmbătă"), key: { remoteJid: OTHER, fromMe: false, id: "X1" } },
      { ...text("Y1", "confirmat intalnirea de luni dimineata"), key: { remoteJid: THIRD, fromMe: false, id: "Y1" } },
    ]);
    await svc.recallIdle();
    const { data } = await svc.recall("confirmat petrecerea", undefined, 10);
    const chats = data.hits.map((h) => h.message.chat_id);
    assert.equal(chats.length, 3);
    assert.equal(chats[1], THIRD, "the forwarded copy yields to the distinct answer");
    assert.deepEqual([chats[0], chats[2]].sort(), [OTHER, PEER].sort());
  } finally {
    await svc.stop();
    stub.server.close();
  }
});

test("a match found by meaning fades with age: a two-month-old, slightly closer match ranks below a fresh one", async () => {
  const stub = await stubEmbedServer();
  const { svc, sock } = await serviceWith({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: stub.url });
  try {
    const day = 86_400;
    deliver(sock, [
      text("OLD", "factura", { messageTimestamp: Math.floor(Date.now() / 1000) - 60 * day }),
      text("NEW", "factura noua"),
    ]);
    await svc.recallIdle();
    const { data } = await svc.recall("invoice", undefined, 10);
    assert.deepEqual(data.hits.map((h) => [h.message.message_id, h.matched]), [
      [`false_${PEER}_NEW`, "meaning"],
      [`false_${PEER}_OLD`, "meaning"],
    ]);
    assert.ok(data.hits[1].similarity > data.hits[0].similarity, "the older one is the closer match, and still ranks second");
  } finally {
    await svc.stop();
    stub.server.close();
  }
});
