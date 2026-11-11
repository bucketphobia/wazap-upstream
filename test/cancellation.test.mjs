/**
 * A tool call the client cancels, or whose session closes, stops waiting:
 * wait_for_messages answers at once, a media download stops at its next
 * chunk (or its wait for a slot, or for the phone to upload expired media),
 * a document read ends its worker, a native helper's queue lets it go, a
 * read's previews stop, and a run several callers share goes on until every
 * one has left.
 * The in-flight slot is given back when the handler settles, never before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { PassThrough, Readable } from "node:stream";
import { setImmediate as turn } from "node:timers/promises";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { orCancelled, SharedRun } from "../dist/cancel.js";
import { documentText } from "../dist/documents.js";
import { DownloadBudget, downloadBudget } from "../dist/media-budget.js";
import { Slots } from "../dist/native-run.js";
import { downloadToMemory } from "../dist/service/media-download.js";
import { startHttpEndpoint } from "../dist/server.js";
import { createToolRegistrar } from "../dist/tool-runtime.js";
import { registerTools } from "../dist/tools.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { asToolSource, connectedService, offlineConfig, stubAccountSource } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function service() {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-cancel-", id: ME, name: "Răzvan" });
  const tools = new Map();
  registerTools({ registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) }, asToolSource(svc), { allowWrite: false });
  const call = (name, args, extra) => {
    const { meta, handler } = tools.get(name);
    return handler(z.object(meta.inputSchema).parse(args), extra);
  };
  return { svc, sock, call };
}

test("wait_for_messages answers as soon as its call is cancelled, not at its timeout", async () => {
  const { svc, call } = service();
  const cancel = new AbortController();
  const started = Date.now();
  const waiting = call("wait_for_messages", { timeout_seconds: 30 }, { signal: cancel.signal });
  await sleep(50);
  cancel.abort();
  const result = await waiting;
  assert.ok(Date.now() - started < 1_000, `answered after ${Date.now() - started} ms`);
  assert.equal(result.structuredContent.timed_out, true);
  assert.deepEqual(result.structuredContent.messages, []);
  await svc.stop();
});

test("a wait cancelled while it settles a burst still answers with what arrived", async () => {
  const { svc, sock, call } = service();
  const cancel = new AbortController();
  const waiting = call("wait_for_messages", { timeout_seconds: 30 }, { signal: cancel.signal });
  await sleep(20);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: ANA, fromMe: false, id: "M1" }, message: { conversation: "salut" }, messageTimestamp: Math.floor(Date.now() / 1000) }],
  });
  await sleep(20);
  cancel.abort();
  const result = await waiting;
  assert.deepEqual(result.structuredContent.messages.map((m) => m.text), ["salut"]);
  await svc.stop();
});

test("a media download stops at its next chunk when its call is cancelled", async (t) => {
  const { svc, sock } = service();
  let pulls = 0;
  const original = globalThis.fetch;
  // WhatsApp's CDN as a body that never ends: 64 KiB every 20 ms.
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        async pull(controller) {
          await sleep(20);
          pulls++;
          controller.enqueue(new Uint8Array(64 * 1024));
        },
      }),
      { status: 200 }
    );
  t.after(() => {
    globalThis.fetch = original;
  });
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: ANA, fromMe: false, id: "VID1" },
        message: {
          videoMessage: { url: "https://mmg.whatsapp.net/v/t62/x.enc", directPath: "/v/t62/x.enc", mediaKey: Buffer.alloc(32, 1), mimetype: "video/mp4", fileLength: 50_000_000 },
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
  });
  const cancel = new AbortController();
  const started = Date.now();
  const download = svc.downloadMedia(`false_${ANA}_VID1`, undefined, { signal: cancel.signal });
  await sleep(150);
  cancel.abort();
  await assert.rejects(download, (err) => err.code === "TIMEOUT" && /cancelled/.test(err.message));
  assert.ok(Date.now() - started < 1_000);
  const atCancel = pulls;
  await sleep(300);
  // Nothing reads the CDN any more: at most what was already in flight lands.
  assert.ok(pulls - atCancel <= 3, `${pulls - atCancel} more chunks pulled after the cancel`);
  await svc.stop();
});

test("a caller that cancels stops waiting on a run another call started, which goes on", async () => {
  let finish;
  const work = new Promise((resolve) => {
    finish = resolve;
  });
  const cancel = new AbortController();
  const mine = orCancelled(work, cancel.signal);
  const theirs = orCancelled(work, undefined);
  cancel.abort();
  await assert.rejects(mine, /cancelled/);
  finish("transcript");
  assert.equal(await theirs, "transcript");
});

/** A shared run whose work the test finishes, and whose stop it can see. */
function sharedRun() {
  let finish;
  let commit;
  let signal;
  const run = new SharedRun((runSignal, runCommit) => {
    signal = runSignal;
    commit = runCommit;
    return new Promise((resolve, reject) => {
      finish = resolve;
      runSignal.addEventListener("abort", () => reject(runSignal.reason), { once: true });
    });
  });
  return { run, finish: (value) => finish(value), commit: () => commit(), signal: () => signal };
}

test("a shared run stops only when every caller has left, never while one without a signal waits", async () => {
  const lone = sharedRun();
  const cancel = new AbortController();
  const mine = lone.run.join(cancel.signal);
  cancel.abort();
  await assert.rejects(mine, /cancelled/);
  assert.equal(lone.signal().aborted, true);
  assert.equal(lone.run.abandoned, true);
  await assert.rejects(lone.run.work, /cancelled/);

  const pinned = sharedRun();
  const leaving = new AbortController();
  const theirs = pinned.run.join(undefined);
  void pinned.run.join(leaving.signal).catch(() => {});
  leaving.abort();
  assert.equal(pinned.signal().aborted, false, "the queue's caller has no signal and keeps the run");
  pinned.finish("transcript");
  assert.equal(await theirs, "transcript");

  const already = sharedRun();
  await assert.rejects(already.run.join(AbortSignal.abort()), /cancelled/);
  assert.equal(already.run.abandoned, true, "a caller that arrives cancelled leaves at once");
});

test("past its commit a shared run goes on when every caller leaves, and a commit after they left throws", async () => {
  const committed = sharedRun();
  const cancel = new AbortController();
  const mine = committed.run.join(cancel.signal);
  committed.commit();
  cancel.abort();
  await assert.rejects(mine, /cancelled/);
  assert.equal(committed.signal().aborted, false);
  assert.equal(committed.run.abandoned, false, "a new caller joins it rather than paying twice");
  committed.finish("transcript");
  assert.equal(await committed.run.join(undefined), "transcript");

  const late = sharedRun();
  const gone = new AbortController();
  void late.run.join(gone.signal).catch(() => {});
  gone.abort();
  assert.throws(() => late.commit(), /cancelled/);
  await assert.rejects(late.run.work, /cancelled/);
});

const wa = { getStatus: () => ({ status: "connected", status_since: new Date().toISOString() }) };

test("the slot comes back when the handler settles: an abort alone gives nothing back early", async () => {
  let release;
  const stubborn = new Promise((resolve) => {
    release = resolve;
  });
  const register = createToolRegistrar([
    {
      name: "polite",
      title: "Polite",
      description: "Stops on abort",
      schema: {},
      write: false,
      hints: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: (_args, ctx) =>
        new Promise((resolve) => ctx.signal?.addEventListener("abort", () => resolve({ content: [{ type: "text", text: "stopped" }] }))),
    },
    {
      name: "stubborn",
      title: "Stubborn",
      description: "Ignores abort",
      schema: {},
      write: false,
      hints: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async () => {
        await stubborn;
        return { content: [] };
      },
    },
  ]);
  const handlers = new Map();
  register({ registerTool: (name, _meta, handler) => handlers.set(name, handler) }, stubAccountSource(wa), { allowWrite: false, maxInFlight: 1 });
  const polite = new AbortController();
  const first = handlers.get("polite")({}, { signal: polite.signal });
  polite.abort();
  assert.equal((await first).content[0].text, "stopped", "the handler saw the call's signal");
  const busy = new AbortController();
  const second = handlers.get("stubborn")({}, { signal: busy.signal });
  busy.abort();
  await turn();
  assert.equal((await handlers.get("polite")({})).structuredContent?.error, "RATE_LIMITED", "still running, still holding its slot");
  release();
  await second;
  const third = new AbortController();
  const again = handlers.get("polite")({}, { signal: third.signal });
  third.abort();
  assert.equal((await again).content[0].text, "stopped");
});

test("over HTTP, a cancelled call and a closed session both end the wait behind them", { timeout: 15_000 }, async (t) => {
  const waits = [];
  const waiting = {
    ...wa,
    waitForMessages: (opts) =>
      new Promise((resolve) => {
        const entry = { signal: opts.signal, endedAt: null };
        waits.push(entry);
        const end = () => {
          entry.endedAt = Date.now();
          resolve({ messages: [], cursor: "boot:0", timed_out: true, cursor_reset: false });
        };
        if (opts.signal === undefined) setTimeout(end, opts.timeoutMs);
        else opts.signal.addEventListener("abort", end, { once: true });
      }),
  };
  const config = offlineConfig("wazap-cancel-http-", { readOnly: false });
  const stop = new AbortController();
  t.after(() => {
    stop.abort();
    rmSync(config.dataDir, { recursive: true, force: true });
  });
  const port = await startHttpEndpoint(asToolSource(waiting), config, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    credentials: [{ token: "w", write: true }],
    signal: stop.signal,
  });
  const connect = async () => {
    const client = new Client({ name: "canceller", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: "Bearer w" } } });
    await client.connect(transport);
    t.after(() => client.close());
    return { client, transport };
  };

  const { client } = await connect();
  const cancel = new AbortController();
  const call = client.callTool({ name: "wait_for_messages", arguments: { timeout_seconds: 30 } }, undefined, { signal: cancel.signal });
  while (waits.length < 1) await sleep(10);
  const cancelledAt = Date.now();
  cancel.abort();
  await assert.rejects(call);
  while (waits[0].endedAt === null && Date.now() - cancelledAt < 2_000) await sleep(10);
  assert.ok(waits[0].endedAt !== null && waits[0].endedAt - cancelledAt < 1_000, "notifications/cancelled reached the wait");

  const closing = await connect();
  const held = closing.client.callTool({ name: "wait_for_messages", arguments: { timeout_seconds: 30 } }).catch(() => "closed");
  while (waits.length < 2) await sleep(10);
  const closedAt = Date.now();
  await closing.transport.terminateSession();
  while (waits[1].endedAt === null && Date.now() - closedAt < 2_000) await sleep(10);
  assert.ok(waits[1].endedAt !== null && waits[1].endedAt - closedAt < 1_000, "closing the session ended its wait");
  await closing.client.close();
  await held;
});

const cancelledCall = (err) => err.code === "TIMEOUT" && /cancelled/.test(err.message);

test("a download cancelled while it waits for a slot leaves the line, and the next in line takes its turn", async () => {
  const budget = new DownloadBudget({ concurrent: 1, bytes: 1_000, waitMs: 5_000, idleMs: 1_000, totalMs: 5_000 });
  const held = await budget.acquire(10);
  const cancel = new AbortController();
  const mine = budget.acquire(10, cancel.signal);
  const next = budget.acquire(10);
  const at = Date.now();
  cancel.abort();
  await assert.rejects(mine, cancelledCall);
  assert.ok(Date.now() - at < 100, "at once, not after waitMs");
  assert.equal(budget.usage.waiting, 1);
  held();
  (await next)();
  assert.deepEqual(budget.usage, { running: 0, reserved: 0, waiting: 0 });
  await assert.rejects(budget.acquire(10, cancel.signal), cancelledCall, "an already cancelled call never queues");
});

test("a download into memory stops at its next chunk on a cancel, with the cancellation and its slot back", async () => {
  const budget = new DownloadBudget({ concurrent: 1, bytes: 1_000_000, waitMs: 1_000, idleMs: 2_000, totalMs: 5_000 });
  const stream = new PassThrough();
  const pump = setInterval(() => stream.write(Buffer.alloc(1024)), 10);
  const cancel = new AbortController();
  const download = downloadToMemory("M1", { open: async () => stream, stillThere: () => {} }, { cap: 10_000_000, budget, signal: cancel.signal });
  await sleep(50);
  cancel.abort();
  await assert.rejects(download, cancelledCall);
  clearInterval(pump);
  assert.equal(stream.destroyed, true);
  assert.deepEqual(budget.usage, { running: 0, reserved: 0, waiting: 0 });
});

test("get_media cancelled while the phone is asked for expired media stops waiting at once and stores nothing", async (t) => {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-cancel-reupload-", id: ME, name: "Me" });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: ANA, fromMe: false, id: "OLD" },
        message: { documentMessage: { mimetype: "text/plain", fileName: "nota.txt", fileLength: 9, url: "https://mmg.whatsapp.net/old", directPath: "/old", mediaKey: Buffer.alloc(32, 7) } },
        messageTimestamp: Math.floor(Date.now() / 1000) - 90 * 86400,
      },
    ],
  });
  const sid = `false_${ANA}_OLD`;
  svc.openMediaStream = async () => {
    throw Object.assign(new Error("Failed to fetch stream"), { isBoom: true, output: { statusCode: 410 } });
  };
  let asked = 0;
  sock.updateMediaMessage = () => {
    asked++;
    return new Promise(() => {});
  };
  const cancel = new AbortController();
  const opened = svc.openMedia(sid, { noFile: true, signal: cancel.signal });
  while (asked === 0) await sleep(5);
  const at = Date.now();
  cancel.abort();
  await assert.rejects(opened, cancelledCall);
  assert.ok(Date.now() - at < 200, "not the 20 s the phone is given");
  assert.equal(svc.views.rawOf(svc.db.messages.get(sid)).message.documentMessage.directPath, "/old");
  await svc.stop();
});

test("a cancelled document read ends its worker, and a cancelled wait for a native slot leaves the line", async () => {
  const cancel = new AbortController();
  const read = documentText("text", Buffer.from("de citit\n".repeat(200_000)), { from: 1, to: null }, 12_000, cancel.signal);
  cancel.abort();
  await assert.rejects(read, cancelledCall);
  // The slots it held are free again: a read after it is not held up.
  const after = await documentText("text", Buffer.from("salut"), { from: 1, to: null });
  assert.match(after.text, /salut/);

  const slots = new Slots(1);
  let release;
  const holding = slots.run(() => new Promise((resolve) => (release = resolve)));
  const leaving = new AbortController();
  let ran = false;
  const waiting = slots.run(async () => {
    ran = true;
  }, leaving.signal);
  const next = slots.run(async () => "next");
  leaving.abort();
  await assert.rejects(waiting, cancelledCall);
  release();
  await holding;
  assert.equal(await next, "next");
  assert.equal(ran, false, "the cancelled run never started");
});

test("a remote get_media cancelled mid-download answers with the cancellation at once, and the CDN is read no more", async (t) => {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-cancel-get-", id: ME, name: "Me" });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  const tools = new Map();
  registerTools({ registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) }, asToolSource(svc), { allowWrite: false, allowLocalFiles: false });
  let pulls = 0;
  svc.openMediaStream = async () =>
    new Readable({
      read() {
        setTimeout(() => {
          pulls++;
          this.push(Buffer.alloc(64 * 1024));
        }, 20);
      },
    });
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: ANA, fromMe: false, id: "VID2" },
        message: { videoMessage: { url: "https://mmg.whatsapp.net/v/x.enc", directPath: "/v/x.enc", mediaKey: Buffer.alloc(32, 1), mimetype: "video/mp4", fileLength: 50_000_000 } },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
  });
  const cancel = new AbortController();
  const { meta, handler } = tools.get("get_media");
  const answer = handler(z.object(meta.inputSchema).parse({ message_id: `false_${ANA}_VID2` }), { signal: cancel.signal });
  while (pulls < 2) await sleep(5);
  const at = Date.now();
  cancel.abort();
  const result = await answer;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /"error":"TIMEOUT"[\s\S]*cancelled/);
  assert.ok(Date.now() - at < 500);
  const atCancel = pulls;
  await sleep(200);
  assert.ok(pulls - atCancel <= 2, `${pulls - atCancel} more chunks read after the cancel`);
  await svc.stop();
});

test("a read's previews stop when its call is cancelled, mid-download or waiting for a download slot", async (t) => {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-cancel-previews-", id: ME, name: "Me" });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  const tools = new Map();
  registerTools({ registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) }, asToolSource(svc), { allowWrite: false, allowLocalFiles: false });
  let pulls = 0;
  svc.openMediaStream = async () =>
    new Readable({
      read() {
        setTimeout(() => {
          pulls++;
          this.push(Buffer.alloc(64 * 1024));
        }, 20);
      },
    });
  // What each preview download was given: the read's signal, and how long it may wait for a slot.
  const given = [];
  const download = svc.mediaBuffer.bind(svc);
  svc.mediaBuffer = (socket, id, raw, maxBytes, opts) => {
    given.push(opts);
    return download(socket, id, raw, maxBytes, opts);
  };
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: ANA, fromMe: false, id: "PIC1" },
        message: { imageMessage: { url: "https://mmg.whatsapp.net/v/p.enc", directPath: "/v/p.enc", mediaKey: Buffer.alloc(32, 1), mimetype: "image/jpeg", fileLength: 10_000_000 } },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
  });
  const { meta, handler } = tools.get("read_messages");
  const read = (signal) => handler(z.object(meta.inputSchema).parse({ chat_id: ANA, include_previews: true }), { signal });
  const cancelledAnswer = (result) => {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /"error":"TIMEOUT"[\s\S]*cancelled/);
  };

  const cancel = new AbortController();
  const answer = read(cancel.signal);
  while (pulls < 2) await sleep(5);
  const at = Date.now();
  cancel.abort();
  cancelledAnswer(await answer);
  assert.ok(Date.now() - at < 500, `answered ${Date.now() - at} ms after the cancel`);
  const atCancel = pulls;
  await sleep(200);
  assert.ok(pulls - atCancel <= 2, `${pulls - atCancel} more chunks read after the cancel`);
  assert.equal(given.length, 1);
  assert.equal(given[0].signal, cancel.signal);
  assert.ok(given[0].waitMs > 0 && given[0].waitMs <= 20_000, `waits at most what the 20 s budget has left: ${given[0].waitMs}`);
  assert.equal(given[0].reupload, undefined, "a preview never wakes the phone");

  // Every slot of the process's budget taken: the next read's preview waits in line, until its call is cancelled.
  const held = await Promise.all([downloadBudget.acquire(1), downloadBudget.acquire(1), downloadBudget.acquire(1)]);
  try {
    const leaving = new AbortController();
    const waiting = read(leaving.signal);
    while (downloadBudget.usage.waiting === 0) await sleep(5);
    const left = Date.now();
    leaving.abort();
    cancelledAnswer(await waiting);
    assert.ok(Date.now() - left < 500, `answered ${Date.now() - left} ms after the cancel, not after the wait`);
    assert.equal(downloadBudget.usage.waiting, 0, "it left the line");
  } finally {
    for (const release of held) release();
  }
  assert.deepEqual(downloadBudget.usage, { running: 0, reserved: 0, waiting: 0 });
  await svc.stop();
});
