import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBED_MODELS, EmbedEngine, EmbedFeed, embedReady, readRecallSettings } from "../dist/recall/index.js";
import { ME, PEER, T0, openTemp, textMessage } from "./db-fixtures.mjs";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools } from "./helpers.mjs";

const baseEnv = {
  WAZAP_RECALL: "openai", WAZAP_EMBED_API_URL: "https://example.invalid/v1",
  WAZAP_EMBED_API_KEY: "synthetic-private-key", WAZAP_EMBED_API_MODEL: "provider/exact-model",
  WAZAP_EMBED_API_DIMS: "3", WAZAP_EMBED_API_MIN_SIMILARITY: "0.6",
};
const settings = (env = {}) => readRecallSettings({ ...baseEnv, ...env }, "/unused");
const engineFor = (config) => EmbedEngine.start(config, EMBED_MODELS[config.model]);

async function stub(t, answer) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const call = { path: req.url, headers: req.headers, body: JSON.parse(body) };
    seen.push(call);
    answer(call, res, seen.length);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { seen, url: `http://127.0.0.1:${server.address().port}/v1` };
}
function good(call, res) {
  res.end(JSON.stringify({ data: call.body.input.map((_, index) => ({ index, embedding: [1, index + 1, 0] })).reverse() }));
}

test("optional API input-type modes preserve the default index and isolate retrieval semantics", () => {
  const original = settings();
  const oldIdentity = createHash("sha256").update(JSON.stringify([original.api.url, original.api.model, original.api.dims])).digest("hex");
  assert.equal(original.indexModel, `openai:${oldIdentity}`, "default keeps the existing durable vector space");
  assert.equal(original.indexModel, settings({ WAZAP_EMBED_API_INPUT_TYPE: "none" }).indexModel);
  const direct = settings({ WAZAP_EMBED_API_INPUT_TYPE: "direct" });
  const extra = settings({ WAZAP_EMBED_API_INPUT_TYPE: "extra_params" });
  assert.notEqual(direct.indexModel, original.indexModel);
  assert.notEqual(extra.indexModel, original.indexModel);
  assert.notEqual(extra.indexModel, direct.indexModel);
  assert.equal(direct.indexModel, settings({ WAZAP_EMBED_API_INPUT_TYPE: "direct", WAZAP_EMBED_API_KEY: "rotated" }).indexModel);
  assert.throws(() => settings({ WAZAP_EMBED_API_INPUT_TYPE: "unsupported-private-value" }), (err) => {
    assert.equal(err.code, "INVALID_ID");
    assert.doesNotMatch(err.message, /unsupported-private-value/);
    return true;
  });
});

test("optional API input-type distinguishes retained documents and service search queries", async (t) => {
  const server = await stub(t, good);
  const { svc, sock } = await serviceWith(t, { ...baseEnv, WAZAP_EMBED_API_URL: server.url, WAZAP_EMBED_API_INPUT_TYPE: "extra_params" });
  deliver(sock, "PURPOSE", "IBAN retained synthetic text");
  await svc.recallIdle();
  assert.equal(svc.getStatus().recall.indexed, 1);
  assert.equal(server.seen[0].body.extra_params?.input_type, "document");
  await svc.recall("IBAN", undefined, 5);
  assert.equal(server.seen.at(-1).body.extra_params?.input_type, "query");
});

test("optional API input-type wires document/query purpose through direct or extra_params transport", async (t) => {
  const server = await stub(t, good);
  for (const mode of ["none", "direct", "extra_params"]) {
    const config = settings({ WAZAP_EMBED_API_URL: server.url, WAZAP_EMBED_API_INPUT_TYPE: mode });
    const engine = await engineFor(config);
    t.after(() => engine.stop());
    for (const kind of ["document", "query"]) {
      await engine.embed(["raw synthetic words"], kind);
      const call = server.seen.at(-1);
      const expected = { model: baseEnv.WAZAP_EMBED_API_MODEL, input: ["raw synthetic words"], encoding_format: "float" };
      if (mode === "direct") expected.input_type = kind;
      if (mode === "extra_params") expected.extra_params = { input_type: kind };
      assert.deepEqual(call.body, expected);
      assert.equal(call.headers["x-bf-passthrough-extra-params"], mode === "extra_params" ? "true" : undefined);
      assert.equal(call.headers.authorization, `Bearer ${baseEnv.WAZAP_EMBED_API_KEY}`);
      assert.equal(call.headers["x-bf-vk"], undefined);
    }
  }
});

test("API recall is explicit, validates private settings and isolates index identity", () => {
  assert.equal(readRecallSettings({ ...baseEnv, WAZAP_RECALL: undefined }, "/unused").enabled, false);
  const config = settings();
  assert.equal(config.api.model, "provider/exact-model");
  assert.equal(config.minSimilarity, 0.6);
  assert.equal(config.indexModel, settings({ WAZAP_EMBED_API_KEY: "different-key" }).indexModel);
  for (const override of [
    { WAZAP_EMBED_API_MODEL: "another" }, { WAZAP_EMBED_API_DIMS: "4" },
    { WAZAP_EMBED_API_URL: "https://other.invalid/v1" },
  ]) assert.notEqual(config.indexModel, settings(override).indexModel);
  for (const name of ["URL", "KEY", "MODEL", "DIMS", "MIN_SIMILARITY"])
    assert.throws(() => settings({ [`WAZAP_EMBED_API_${name}`]: "" }));
  for (const url of ["http://192.168.1.2/v1", "http://127.0.0.1.evil/v1", "https://user:secret@example.invalid", "https://example.invalid/?key=secret"])
    assert.throws(() => settings({ WAZAP_EMBED_API_URL: url }), (err) => !err.message.includes(url));
  for (const dims of ["0", "4097", "1.5", "NaN"]) assert.throws(() => settings({ WAZAP_EMBED_API_DIMS: dims }));
  for (const floor of ["-1", "1.1", "NaN"]) assert.throws(() => settings({ WAZAP_EMBED_API_MIN_SIMILARITY: floor }));
  assert.throws(() => settings({ WAZAP_EMBED_AUTH_HEADER: "x-other" }));
});

test("authenticated API sends exact raw model/text and sorts vectors without a local model", async (t) => {
  const server = await stub(t, good);
  for (const header of ["Authorization", "x-bf-vk"]) {
    const config = settings({ WAZAP_EMBED_API_URL: server.url, WAZAP_EMBED_AUTH_HEADER: header });
    assert.equal((await embedReady(config, EMBED_MODELS[config.model])).ok, true);
    const engine = await engineFor(config);
    t.after(() => engine.stop());
    assert.deepEqual(await engine.embed(["query words", "retained text"], "query"), [[1, 1, 0], [1, 2, 0]]);
    const call = server.seen.at(-1);
    assert.equal(call.path, "/v1/embeddings");
    assert.equal(call.headers[header.toLowerCase()], header === "Authorization" ? "Bearer synthetic-private-key" : "synthetic-private-key");
    assert.deepEqual(call.body, { model: "provider/exact-model", input: ["query words", "retained text"], encoding_format: "float" });
  }
});

test("API refuses malformed responses, raw provider errors and redirects privately", async (t) => {
  let reply;
  const server = await stub(t, (_, res) => {
    if (reply === "redirect") res.writeHead(307, { location: "/leaked" }).end();
    else if (reply === "error") res.writeHead(401).end("synthetic-private-key retained text");
    else res.end(typeof reply === "string" ? reply : JSON.stringify(reply));
  });
  const engine = await engineFor(settings({ WAZAP_EMBED_API_URL: server.url }));
  t.after(() => engine.stop());
  for (reply of [
    {}, { data: [] }, { data: [{ index: 1, embedding: [1, 2, 3] }] },
    { data: [{ index: 0, embedding: [1, 2] }] }, { data: [{ index: 0, embedding: [1, null, 3] }] },
    { data: [{ index: 0, embedding: [0, 0, 0] }] }, "{broken", "x".repeat(4 * 1024 * 1024 + 1), "error", "redirect",
  ]) await assert.rejects(() => engine.embed(["retained text"], "document"), (err) => {
    assert.equal(err.code, "RECALL_FAILED");
    assert.doesNotMatch(err.message, /synthetic-private-key|retained text|broken/);
    return true;
  });
  assert.equal(server.seen.length, 10, "redirect target was never requested");
  reply = { data: [{ index: 0, embedding: [1, 2, 3] }, { index: 0, embedding: [1, 2, 3] }] };
  await assert.rejects(() => engine.embed(["a", "b"], "document"));
});

test("stopping API recall aborts a stalled provider request privately", async (t) => {
  let received;
  const arrived = new Promise((resolve) => { received = resolve; });
  const server = await stub(t, () => received());
  const engine = await engineFor(settings({ WAZAP_EMBED_API_URL: server.url }));
  const pending = engine.embed(["retained private message"], "document");
  const rejected = assert.rejects(pending, (err) => err.code === "RECALL_FAILED" && !err.message.includes("retained private message"));
  await arrived;
  await engine.stop();
  await rejected;
});

test("API rejects finite vectors whose squared norms overflow or underflow", async (t) => {
  let vector;
  const server = await stub(t, (_, res) => res.end(JSON.stringify({ data: [{ index: 0, embedding: vector }] })));
  const engine = await engineFor(settings({ WAZAP_EMBED_API_URL: server.url }));
  t.after(() => engine.stop());
  for (vector of [[1e308, 1, 0], [1e-200, 0, 0]]) {
    await assert.rejects(() => engine.embed(["synthetic"], "document"), { code: "RECALL_FAILED" });
  }
  vector = [0.25, -0.5, 0.75];
  assert.deepEqual(await engine.embed(["synthetic"], "document"), [vector]);
});

test("API feed retries 429, batches retained messages, and refills on model identity changes", async (t) => {
  const server = await stub(t, (call, res, attempt) => attempt === 1 ? res.writeHead(429).end("private error") : good(call, res));
  const { db } = openTemp();
  t.after(() => db.close());
  for (let i = 0; i < 70; i++) db.messages.upsert(textMessage(PEER, `M${i}`, T0 + i * 1000, "retained text ".repeat(100)));
  for (const model of ["first", "second"]) {
    const config = settings({ WAZAP_EMBED_API_URL: server.url, WAZAP_EMBED_API_MODEL: model });
    const engine = await engineFor(config);
    const feed = new EmbedFeed({ db: () => db, model: config.indexModel, words: (m) => m.text,
      embed: (texts) => engine.embed(texts, "document"), retry: { initMs: 1, maxMs: 1 } });
    feed.kick();
    await feed.idle();
    assert.equal(feed.failing, null);
    assert.equal(db.vectors.count(config.indexModel), 70);
    await feed.stop();
    await engine.stop();
  }
  for (const call of server.seen) {
    assert.ok(call.body.input.length <= 32);
    assert.ok(call.body.input.join("").length <= 8192);
  }
  assert.ok(server.seen.some((call) => call.body.model === "second"));
});

async function serviceWith(t, env, config = {}) {
  const saved = Object.keys(env).map((key) => [key, process.env[key]]);
  Object.assign(process.env, env);
  let connected;
  try {
    connected = await connectedService(WhatsAppService, { prefix: "wazap-recall-api-", id: ME, name: "Synthetic", config: { persistHistory: true, ...config } });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  t.after(() => connected.svc.stop());
  await connected.svc.bootStorage();
  return connected;
}

const deliver = (sock, id, body) => sock.ev.emit("messages.upsert", { type: "notify", messages: [{
  key: { remoteJid: PEER, fromMe: false, id }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: body },
}] });

test("default mode does not upload even with API credentials present", async (t) => {
  const server = await stub(t, good);
  const { svc, sock } = await serviceWith(t, { ...baseEnv, WAZAP_RECALL: "", WAZAP_EMBED_API_URL: server.url });
  deliver(sock, "OFF", "retained private message");
  await svc.recallIdle();
  assert.equal(svc.getStatus().recall.state, "off");
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  const result = await call("search", { query: "private" });
  assert.equal(result.structuredContent.mode, "keyword_fallback");
  assert.equal(server.seen.length, 0);
});

test("API service restarts keep credentials independent and refill retained text for changed vector spaces", async (t) => {
  const server = await stub(t, (call, res) => res.end(JSON.stringify({ data: call.body.input.map((_, index) => ({
    index, embedding: call.body.model === "four" ? [1, 1, 1, 1] : [1, 1, 1],
  })) })));
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-api-restart-"));
  const original = { ...baseEnv, WAZAP_EMBED_API_URL: server.url };
  const first = await serviceWith(t, original, { dataDir });
  deliver(first.sock, "BEFORE", "retained before changing models");
  await first.svc.recallIdle();
  await first.svc.stop();
  assert.equal(server.seen.length, 1);
  const same = await serviceWith(t, { ...original, WAZAP_EMBED_API_KEY: "rotated-synthetic-key" }, { dataDir });
  await same.svc.recallIdle();
  await same.svc.stop();
  assert.equal(server.seen.length, 1, "credential rotation does not resend retained text");
  for (const env of [
    { ...original, WAZAP_EMBED_API_MODEL: "second" },
    { ...original, WAZAP_EMBED_API_URL: `${server.url}/other` },
    { ...original, WAZAP_EMBED_API_MODEL: "four", WAZAP_EMBED_API_DIMS: "4" },
  ]) {
    const previous = server.seen.length;
    const next = await serviceWith(t, env, { dataDir });
    await next.svc.recallIdle();
    assert.equal(next.svc.getStatus().recall.indexed, 1);
    assert.equal(server.seen.length, previous + 1, "changed vector space refills retained history");
    await next.svc.stop();
  }
});

test("API index and query use the same identity, and query outages give keyword fallback", async (t) => {
  let failed = false;
  const server = await stub(t, (call, res) => failed ? res.writeHead(503).end("synthetic-private-key retained private message") : good(call, res));
  const env = { ...baseEnv, WAZAP_EMBED_API_URL: server.url };
  const { svc, sock } = await serviceWith(t, env);
  deliver(sock, "API", "IBAN retained private message");
  await svc.recallIdle();
  assert.equal(svc.getStatus().recall.indexed, 1);
  const answer = await svc.recall("IBAN", undefined, 5);
  assert.equal(answer.data.hits.length, 1);
  failed = true;
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  const result = await call("search", { query: "IBAN" });
  assert.equal(result.structuredContent.mode, "keyword_fallback");
  assert.equal(result.structuredContent.recall_unavailable.code, "RECALL_FAILED");
  assert.doesNotMatch(result.structuredContent.recall_unavailable.message, /synthetic-private-key|retained private message/);
  assert.equal(result.structuredContent.messages.length, 1);
});
