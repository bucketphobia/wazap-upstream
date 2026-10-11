/**
 * The shared llama-server sidecar: every account in the process whose recall
 * resolves to the same binary and model file embeds through one spawn, held
 * alive by a refcount — the last release kills it. The sidecarFactory seam
 * stands in for the child process; the stub /embedding server stands in for
 * the API, so "same server" is provable as "same port".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { WhatsAppService } from "../dist/whatsapp.js";
import { EmbedEngine, sidecarFactory } from "../dist/recall/engine.js";
import { EMBED_MODELS } from "../dist/recall/index.js";
import { connectedService, waitFor } from "./helpers.mjs";

const SPEC = EMBED_MODELS["embeddinggemma-300m"];
const DIMS = SPEC.dims;
const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const WORK = "40700000003@s.whatsapp.net";

const RECALL_ENV = [
  "WAZAP_RECALL",
  "WAZAP_EMBED_MODEL",
  "WAZAP_EMBED_BIN",
  "WAZAP_EMBED_URL",
  "WAZAP_RECALL_MIN_SIMILARITY",
];

/** What readRecallSettings produces, without the env dance. */
function recallSettings(modelsDir, embedBin = process.execPath, embedIdleMs = 0) {
  return {
    enabled: true,
    model: SPEC.alias,
    embedBin,
    embedUrl: null,
    modelsDir,
    embedIdleMs,
    maxRows: 1000,
    minSimilarity: 0,
  };
}

/** A stand-in llama-server: POST /embedding → [{index, embedding: [[dims]]}]. */
function stubEmbedServer() {
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
      const reply = texts.map((_, index) => ({ index, embedding: [vectorFor(texts[index])] }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function vectorFor(text) {
  const vector = new Array(DIMS).fill(0);
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
    if (word === "") continue;
    let hash = 0;
    for (const ch of word.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) % 9973;
    vector[hash % DIMS] += 1;
  }
  return vector;
}

/**
 * The seam's fake: every open() hands back a target pointed at the stub, with
 * starts and stops counted per spawn. `gate` keeps start() pending so a second
 * acquirer can be caught mid-spawn; `failStart` rejects it.
 */
function fakeSidecars(url, { gate, failStart } = {}) {
  const original = sidecarFactory.open;
  const spawned = [];
  sidecarFactory.open = (bin, model) => {
    const fake = {
      bin,
      model,
      base: url,
      starts: 0,
      stops: 0,
      // The seam's contract: requests carry whatever auth the backend needs; the stub wants none.
      authHeaders: () => ({}),
      async start() {
        this.starts++;
        if (failStart?.()) throw new Error("llama-server would not start");
        await gate;
      },
      waitReady: () => Promise.resolve(),
      async stop() {
        this.stops++;
      },
    };
    spawned.push(fake);
    return fake;
  };
  return { spawned, restore: () => (sidecarFactory.open = original) };
}

function modelsDir() {
  const dir = mkdtempSync(join(tmpdir(), "wazap-sidecar-"));
  mkdirSync(join(dir, "models"), { recursive: true });
  return join(dir, "models");
}

test("two engines on one target share a single spawn; the last release stops it", async () => {
  const stub = await stubEmbedServer();
  const { spawned, restore } = fakeSidecars(stub.url);
  try {
    const settings = recallSettings(modelsDir());
    const a = await EmbedEngine.start(settings, SPEC);
    const b = await EmbedEngine.start(settings, SPEC);
    assert.equal(spawned.length, 1, "one spawn for two engines");
    assert.equal(spawned[0].starts, 1);

    await a.embed(["factura"], "document");
    await b.embed(["chiria"], "document");
    assert.equal(stub.seen.length, 2, "both engines embed through the same port");

    await a.stop();
    assert.equal(spawned[0].stops, 0, "one release keeps the server alive");
    await b.embed(["doctor"], "document");
    assert.equal(stub.seen.length, 3, "the surviving engine still embeds");

    await b.stop();
    assert.equal(spawned[0].stops, 1, "the last release stopped it");

    const c = await EmbedEngine.start(settings, SPEC);
    assert.equal(spawned.length, 2, "an acquire after the last release spawns fresh");
    await c.stop();
    assert.equal(spawned[1].stops, 1);
  } finally {
    restore();
    stub.server.close();
  }
});

test("an acquirer mid-spawn joins the same start, never a second spawn", async () => {
  const stub = await stubEmbedServer();
  let release;
  const gate = new Promise((done) => (release = done));
  const { spawned, restore } = fakeSidecars(stub.url, { gate });
  try {
    const settings = recallSettings(modelsDir());
    // Two accounts backfilling at boot: the second must not spawn again while
    // the first start is still pending.
    const pa = EmbedEngine.start(settings, SPEC);
    const pb = EmbedEngine.start(settings, SPEC);
    await sleep(20);
    assert.equal(spawned.length, 1, "one spawn while the first start is still pending");
    release();
    const [a, b] = await Promise.all([pa, pb]);
    await a.stop();
    await b.stop();
    assert.equal(spawned[0].stops, 1);
  } finally {
    restore();
    stub.server.close();
  }
});

test("a different model dir or binary is a different sidecar", async () => {
  const stub = await stubEmbedServer();
  const { spawned, restore } = fakeSidecars(stub.url);
  const dirA = modelsDir();
  const dirB = modelsDir();
  const otherBin = join(dirB, "other-llama");
  writeFileSync(otherBin, "#!/bin/sh\nexit 0\n");
  chmodSync(otherBin, 0o755);
  try {
    const a = await EmbedEngine.start(recallSettings(dirA), SPEC);
    const b = await EmbedEngine.start(recallSettings(dirB), SPEC); // different model path
    const c = await EmbedEngine.start(recallSettings(dirA, otherBin), SPEC); // different binary
    assert.equal(spawned.length, 3, "each distinct pair spawned its own server");
    await a.stop();
    await b.stop();
    await c.stop();
    assert.deepEqual(
      spawned.map((fake) => fake.stops),
      [1, 1, 1]
    );
  } finally {
    restore();
    stub.server.close();
  }
});

test("a failed start rejects every waiter, frees the slot and cleans up the half-spawn", async () => {
  const stub = await stubEmbedServer();
  let failing = true;
  const { spawned, restore } = fakeSidecars(stub.url, { failStart: () => failing });
  try {
    const settings = recallSettings(modelsDir());
    const pa = EmbedEngine.start(settings, SPEC);
    const pb = EmbedEngine.start(settings, SPEC);
    await assert.rejects(pa, /would not start/);
    await assert.rejects(pb, /would not start/);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].stops, 1, "the last waiter out stopped the child");

    failing = false;
    const engine = await EmbedEngine.start(settings, SPEC);
    assert.equal(spawned.length, 2, "the next acquire spawned fresh rather than joining the dead start");
    await engine.stop();
  } finally {
    restore();
    stub.server.close();
  }
});

test("an idle sidecar is reaped under live claims; the next embed spawns fresh", async () => {
  const stub = await stubEmbedServer();
  const { spawned, restore } = fakeSidecars(stub.url);
  try {
    const settings = recallSettings(modelsDir(), process.execPath, 60);
    const engine = await EmbedEngine.start(settings, SPEC);
    await engine.embed(["factura"], "document");
    assert.equal(spawned.length, 1);

    // The engine still holds its claim — only the child is gone.
    await waitFor(() => spawned[0].stops === 1, 5_000, "the idle sidecar to be reaped");

    const vectors = await engine.embed(["chiria"], "document");
    assert.equal(vectors.length, 1, "the stale claim re-acquired a server");
    assert.equal(spawned.length, 2, "a fresh spawn, not the reaped child");
    assert.equal(stub.seen.length, 2, "the request reached the new server");

    await engine.stop();
    assert.equal(spawned[0].stops, 1, "the reaped child is not stopped twice");
    assert.equal(spawned[1].stops, 1, "the release stops the replacement");
  } finally {
    restore();
    stub.server.close();
  }
});

test("embed calls keep resetting the idle clock, so a busy sidecar is never reaped", async () => {
  const stub = await stubEmbedServer();
  const { spawned, restore } = fakeSidecars(stub.url);
  try {
    const settings = recallSettings(modelsDir(), process.execPath, 80);
    const engine = await EmbedEngine.start(settings, SPEC);
    for (let i = 0; i < 4; i++) {
      await engine.embed([`text ${i}`], "document");
      await sleep(40);
    }
    assert.equal(spawned[0].stops, 0, "a call every 40ms outran the 80ms window");
    await waitFor(() => spawned[0].stops === 1, 5_000, "the sidecar to be reaped once calls stop");
    await engine.stop();
    assert.equal(spawned[0].stops, 1);
  } finally {
    restore();
    stub.server.close();
  }
});

test("an idle window of 0 keeps the sidecar resident until the last release", async () => {
  const stub = await stubEmbedServer();
  const { spawned, restore } = fakeSidecars(stub.url);
  try {
    const settings = recallSettings(modelsDir(), process.execPath, 0);
    const engine = await EmbedEngine.start(settings, SPEC);
    await engine.embed(["factura"], "document");
    await sleep(120);
    assert.equal(spawned[0].stops, 0, "no idle timer ran");
    await engine.stop();
    assert.equal(spawned[0].stops, 1);
  } finally {
    restore();
    stub.server.close();
  }
});

test("WAZAP_EMBED_URL mode never touches the registry", async () => {
  const stub = await stubEmbedServer();
  const { spawned, restore } = fakeSidecars(stub.url);
  try {
    const engine = await EmbedEngine.start({ ...recallSettings(modelsDir()), embedUrl: stub.url }, SPEC);
    await engine.embed(["factura"], "document");
    assert.equal(spawned.length, 0, "nothing was spawned for a URL target");
    assert.equal(stub.seen.length, 1);
    await engine.stop();
  } finally {
    restore();
    stub.server.close();
  }
});

const text = (id, body) => ({
  key: { remoteJid: PEER, fromMe: false, id },
  messageTimestamp: Math.floor(Date.now() / 1000),
  message: { conversation: body },
});

const deliver = (sock, messages) => sock.ev.emit("messages.upsert", { type: "notify", messages });

test("two accounts on one data dir share one llama-server; the last stop kills it", async () => {
  const stub = await stubEmbedServer();
  const { spawned, restore } = fakeSidecars(stub.url);
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-sidecar-hub-"));
  mkdirSync(join(dataDir, "models"), { recursive: true });
  // embedReady needs the file to exist; the faked sidecar never reads it.
  writeFileSync(join(dataDir, "models", SPEC.file), "stub-model");
  const saved = RECALL_ENV.map((key) => [key, process.env[key]]);
  for (const key of RECALL_ENV) delete process.env[key];
  Object.assign(process.env, {
    WAZAP_RECALL: "local",
    // Any executable passes findLlama; the factory never runs it.
    WAZAP_EMBED_BIN: process.execPath,
    WAZAP_RECALL_MIN_SIMILARITY: "0",
  });
  try {
    const home = await connectedService(WhatsAppService, {
      prefix: "wazap-sidecar-",
      id: ME,
      name: "Home",
      config: { dataDir, persistHistory: true },
    });
    const work = await connectedService(WhatsAppService, {
      prefix: "wazap-sidecar-",
      id: WORK,
      name: "Work",
      config: { dataDir, persistHistory: true },
      account: { id: "work", name: "Work", enabled: true, owner: null },
    });
    await home.svc.bootStorage();
    await work.svc.bootStorage();

    deliver(home.sock, [text("H1", "factura de acasă")]);
    deliver(work.sock, [text("W1", "factura de la muncă")]);
    await home.svc.recallIdle();
    await work.svc.recallIdle();

    assert.equal(spawned.length, 1, "one llama-server serves both accounts");
    assert.equal(spawned[0].starts, 1);
    assert.equal(home.svc.db.vectors.count(), 1);
    assert.equal(work.svc.db.vectors.count(), 1);

    await home.svc.stop();
    await sleep(20);
    assert.equal(spawned[0].stops, 0, "the surviving account keeps the server alive");

    deliver(work.sock, [text("W2", "chiria lunii")]);
    await work.svc.recallIdle();
    assert.equal(work.svc.db.vectors.count(), 2, "the other account still embeds");

    await work.svc.stop();
    // stopRecall releases the engine behind the stop() it does not await.
    await waitFor(() => spawned[0].stops === 1, 5_000, "the last release to stop the sidecar");
  } finally {
    restore();
    stub.server.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
