import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbedEngine, embedReady, sidecarFactory } from "../dist/recall/engine.js";
import { readRecallSettings } from "../dist/recall/settings.js";
import { EMBED_MODELS } from "../dist/recall/models.js";

const SECRET = "SYNTHETIC-EMBEDDING-PRIVATE-TEXT";
const spec = EMBED_MODELS["embeddinggemma-300m"];
const settings = (url = "http://127.0.0.1:9") => readRecallSettings({ WAZAP_RECALL: "local", WAZAP_EMBED_URL: url }, "/synthetic");
const vector = () => new Array(spec.dims).fill(0.5);
const safeError = (err) => { assert.match(err.code, /^RECALL_(FAILED|BAD_INPUT)$/); assert.ok(!err.message.includes(SECRET)); return true; };
async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

for (const status of [301, 302, 303, 307, 308]) test(`embedding refuses HTTP ${status} redirects`, async (t) => {
  let leaked = 0;
  const receiver = await listen(t, (_req, res) => { leaked++; res.end(JSON.stringify([{ embedding: [vector()] }])); });
  const source = await listen(t, (_req, res) => res.writeHead(status, { location: receiver }).end());
  const engine = await EmbedEngine.start(settings(source), spec);
  await assert.rejects(engine.embed([SECRET], "document"), safeError);
  assert.equal(leaked, 0);
});

for (const status of [400, 500]) test(`embedding HTTP ${status} does not read private error bodies`, async (t) => {
  let cancelled = false; let chunks = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    pull(controller) { if (chunks++ < 2) controller.enqueue(new TextEncoder().encode(SECRET)); else controller.close(); }, cancel() { cancelled = true; },
  }), { status }));
  const engine = await EmbedEngine.start(settings(), spec);
  await assert.rejects(engine.embed([SECRET], "document"), safeError);
  assert.equal(cancelled, true);
});

for (const body of ["null", JSON.stringify({ error: { message: SECRET } }), `[${SECRET}`, JSON.stringify([null]),
  JSON.stringify([{ embedding: [[SECRET]] }]), JSON.stringify([{ embedding: [[1, 2]] }]),
  '[{"embedding":[[1e999]]}]']) test(`invalid embedding reply is a safe typed failure: ${body.slice(0, 24)}`, async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(body));
  const engine = await EmbedEngine.start(settings(), spec);
  await assert.rejects(engine.embed([SECRET], "document"), safeError);
});

test("embedding JSON is bounded by actual bytes and cancels overflow", async (t) => {
  let cancelled = false; let chunks = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    pull(controller) { if (chunks++ < 6) controller.enqueue(new Uint8Array(1024 * 1024).fill(32)); else controller.close(); },
    cancel() { cancelled = true; },
  }), { headers: { "content-length": "1" } }));
  const engine = await EmbedEngine.start(settings(), spec);
  await assert.rejects(engine.embed([SECRET], "document"), safeError);
  assert.equal(cancelled, true);
});

test("embedding transport errors do not echo text or URLs", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error(SECRET); });
  const engine = await EmbedEngine.start(settings(), spec);
  await assert.rejects(engine.embed([SECRET], "query"), safeError);
});

test("valid dimensioned finite embeddings retain prefixes and POST semantics", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    assert.equal(url, "http://127.0.0.1:9/embedding");
    assert.equal(opts.redirect, "error");
    assert.equal(opts.method, "POST");
    assert.equal(JSON.parse(opts.body).content, spec.prompts.query + SECRET);
    return new Response(JSON.stringify([{ embedding: [vector()] }]));
  });
  const engine = await EmbedEngine.start(settings(), spec);
  assert.deepEqual(await engine.embed([SECRET], "query"), [vector()]);
});

for (const url of [`http://u:${SECRET}@localhost`, `http://localhost/?key=${SECRET}`, `http://localhost/#${SECRET}`, `file:///${SECRET}`]) {
  test("embedding override refuses secret-bearing/non-HTTP URLs without echo", () => {
    assert.throws(() => settings(url), (err) => { assert.equal(err.code, "INVALID_ID"); assert.ok(!err.message.includes(SECRET)); return true; });
  });
}

test("embedding readiness reports only the operator endpoint host", async () => {
  const ready = await embedReady(settings(`http://127.0.0.1:9/${SECRET}`), spec);
  assert.ok(ready.detail.includes("127.0.0.1:9"));
  assert.ok(!ready.detail.includes(SECRET));
});

test("sidecar health probes refuse redirects and cancel ignored response bodies", async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    assert.equal(opts.redirect, "error");
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  });
  const target = sidecarFactory.open("synthetic", "synthetic", () => {});
  target.base = "http://127.0.0.1:9";
  target.readyPromise = Promise.resolve();
  await target.waitReady();
  assert.equal(cancelled, true);
  await target.stop();
});

test("a failed sidecar spawn is safe and leaves no child for shutdown to wait on", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wazap-missing-embedding-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logs = [];
  const target = sidecarFactory.open(join(dir, SECRET), "synthetic", line => logs.push(line));
  target.base = "http://127.0.0.1:9";
  target.spawnChild();
  await assert.rejects(target.readyPromise, safeError);
  assert.equal(target.child, null);
  assert.ok(logs.every(line => !line.includes(SECRET)));
  await target.stop();
});

test("embedding child diagnostics never include raw decoder stderr", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wazap-embedding-child-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "fake-llama");
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' '${SECRET}' >&2\nexit 2\n`, { mode: 0o700 });
  const child = sidecarFactory.open(bin, "synthetic-model", () => {});
  child.base = "http://127.0.0.1:9";
  child.spawnChild();
  try { await assert.rejects(child.readyPromise, safeError); }
  finally { await child.stop(); }
});

test("a llama-server that dies while starting logs why, and only while starting", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wazap-embedding-boot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const boot = join(dir, "boot-llama");
  await writeFile(boot, "#!/bin/sh\nprintf 'error: failed to load model synthetic-model\\n' >&2\nexit 1\n", { mode: 0o700 });
  const logs = [];
  const failing = sidecarFactory.open(boot, "synthetic-model", (line) => logs.push(line));
  failing.base = "http://127.0.0.1:9";
  failing.spawnChild();
  try {
    await assert.rejects(failing.readyPromise, (err) => { assert.doesNotMatch(err.message, /failed to load/); return true; });
  } finally { await failing.stop(); }
  assert.ok(logs.some((line) => line.includes("failed to load model synthetic-model")), "the boot reason reaches the log");

  const later = join(dir, "later-llama");
  await writeFile(later, `#!/bin/sh\nsleep 0.3\nprintf '%s\\n' '${SECRET}' >&2\nexit 2\n`, { mode: 0o700 });
  const ready = [];
  const serving = sidecarFactory.open(later, "synthetic-model", (line) => ready.push(line));
  serving.base = "http://127.0.0.1:9";
  serving.spawnChild();
  serving.readyResolve();
  const exited = new Promise((resolve) => serving.child.once("exit", resolve));
  try { await exited; } finally { await serving.stop(); }
  assert.ok(ready.every((line) => !line.includes(SECRET)), "output after ready is never retained");
});

test("the spawned sidecar gates its API on a per-run key the engine sends", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wazap-embedding-auth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const argvFile = join(dir, "argv.json");
  const reqFile = join(dir, "requests.log");
  // A fake llama-server: serves /health and /embedding, and refuses an
  // embedding request that does not carry the api key it was launched with.
  const bin = join(dir, "fake-llama.mjs");
  await writeFile(bin, `#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(argv));
const port = argv[argv.indexOf("--port") + 1];
const key = argv[argv.indexOf("--api-key") + 1];
http.createServer((req, res) => {
  const authed = req.headers.authorization === \`Bearer \${key}\`;
  fs.appendFileSync(${JSON.stringify(reqFile)}, \`\${req.method} \${req.url} authed=\${authed}\\n\`);
  if (req.url === "/health") return res.end("ok");
  if (!authed) { res.writeHead(401); return res.end(); }
  req.resume();
  req.on("end", () => res.end(JSON.stringify([{ embedding: [new Array(${spec.dims}).fill(0.5)] }])));
}).listen(port, "127.0.0.1");
`, { mode: 0o700 });

  const settings = readRecallSettings({ WAZAP_RECALL: "local", WAZAP_EMBED_BIN: bin }, dir);
  const engine = await EmbedEngine.start(settings, spec, () => {});
  t.after(() => engine.stop());

  assert.deepEqual(await engine.embed(["salut"], "document"), [new Array(spec.dims).fill(0.5)]);
  const argv = JSON.parse(await readFile(argvFile, "utf8"));
  assert.ok(argv.includes("--api-key"), "the spawn passes the key flag");
  const key = argv[argv.indexOf("--api-key") + 1];
  assert.equal(typeof key, "string");
  assert.ok(key.length >= 24, "the key is long enough to be unguessable");
  const reqs = await readFile(reqFile, "utf8");
  assert.ok(reqs.includes("/embedding authed=true"), "the engine authenticates its embed calls");
  assert.ok(!reqs.includes("authed=false"), "no request went out unauthenticated");
});
