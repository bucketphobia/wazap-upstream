/**
 * A media download into memory (src/service/media-download.ts) inside the
 * process's budget (src/media-budget.ts): how many run at once and how many
 * bytes they hold, the idle and overall clocks, the in-memory cap, and the
 * slot always given back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";

import { DownloadBudget } from "../dist/media-budget.js";
import { downloadToMemory } from "../dist/service/media-download.js";

const limits = (overrides = {}) => ({ concurrent: 3, bytes: 1_000, waitMs: 200, idleMs: 100, totalMs: 1_000, ...overrides });
const source = (chunks, { stillThere = () => {} } = {}) => ({ open: async () => Readable.from(chunks), stillThere });

test("at most `concurrent` downloads hold a slot; the next waits its turn, in order", async () => {
  const budget = new DownloadBudget(limits());
  const held = await Promise.all([budget.acquire(10), budget.acquire(10), budget.acquire(10)]);
  assert.deepEqual(budget.usage, { running: 3, reserved: 30, waiting: 0 });
  let fourth = false;
  const waiting = budget.acquire(10).then((release) => {
    fourth = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fourth, false, "the fourth waits");
  held[0]();
  const release = await waiting;
  assert.equal(fourth, true);
  release();
  held[1]();
  held[2]();
  assert.deepEqual(budget.usage, { running: 0, reserved: 0, waiting: 0 });
});

test("the byte budget holds a download back until room is made, and one alone always runs", async () => {
  const budget = new DownloadBudget(limits({ bytes: 100 }));
  const first = await budget.acquire(60);
  const second = budget.acquire(60);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(budget.usage.waiting, 1);
  first();
  (await second)();
  const huge = await budget.acquire(10_000);
  assert.equal(budget.usage.running, 1, "a download bigger than the budget still runs alone");
  huge();
});

test("a download that waits past waitMs is told to retry, and leaves the queue", async () => {
  const budget = new DownloadBudget(limits({ concurrent: 1, waitMs: 30 }));
  const held = await budget.acquire(1);
  await assert.rejects(budget.acquire(1), (err) => err.code === "RATE_LIMITED" && /busy/.test(err.message));
  assert.equal(budget.usage.waiting, 0);
  held();
});

test("a caller with less time left waits for a slot only that long, and leaves the queue to the others", async () => {
  // A read's previews have 20 s in all: behind other downloads they no longer wait the budget's own 30 s.
  const budget = new DownloadBudget(limits({ concurrent: 1, waitMs: 5_000 }));
  const held = await budget.acquire(1);
  const patient = budget.acquire(1);
  const started = Date.now();
  await assert.rejects(budget.acquire(1, undefined, 40), (err) => err.code === "RATE_LIMITED");
  assert.ok(Date.now() - started < 1_000, `gave up after ${Date.now() - started} ms, not waitMs`);
  await assert.rejects(downloadToMemory("M", source([Buffer.from("x")]), { cap: 100, budget, waitMs: 40 }), (err) => err.code === "RATE_LIMITED");
  assert.equal(budget.usage.waiting, 1, "only the patient caller still waits");
  held();
  (await patient)();
  assert.deepEqual(budget.usage, { running: 0, reserved: 0, waiting: 0 });
});

test("the bytes come back whole, whether the envelope's size was right, short or missing", async () => {
  const budget = new DownloadBudget(limits());
  const chunks = [Buffer.from("abc"), Buffer.from("defg"), Buffer.from("h")];
  for (const declared of [8, 5, undefined]) {
    const out = await downloadToMemory("M", source(chunks), { declared, cap: 100, budget });
    assert.equal(out.toString(), "abcdefgh", `declared ${declared}`);
  }
  const fewer = await downloadToMemory("M", source([Buffer.from("ab")]), { declared: 10, cap: 100, budget });
  assert.equal(fewer.toString(), "ab", "a file shorter than declared is not padded");
  assert.deepEqual(budget.usage, { running: 0, reserved: 0, waiting: 0 });
});

test("a file over the in-memory cap is refused before and while it downloads, saying why", async () => {
  const budget = new DownloadBudget(limits());
  let opened = 0;
  const counting = { open: async () => (opened++, Readable.from([Buffer.alloc(60), Buffer.alloc(60)])), stillThere: () => {} };
  await assert.rejects(downloadToMemory("M1", counting, { declared: 150_000_000, cap: 100_000_000, budget }), (err) => {
    assert.equal(err.code, "FILE_TOO_LARGE");
    assert.match(err.message, /is 150 MB; wazap holds a download in memory and takes at most 100 MB/);
    return true;
  });
  assert.equal(opened, 0, "nothing fetched for a file declared too big");
  await assert.rejects(downloadToMemory("M2", counting, { declared: 10, cap: 100, budget }), { code: "FILE_TOO_LARGE" });
  assert.equal(budget.usage.running, 0);
});

test("a CDN that goes quiet is stopped by the idle clock, and one that never answers by the overall clock", async () => {
  const budget = new DownloadBudget(limits({ idleMs: 60, totalMs: 300 }));
  const quiet = new PassThrough();
  quiet.write(Buffer.from("first"));
  const started = Date.now();
  await assert.rejects(downloadToMemory("Q", { open: async () => quiet, stillThere: () => {} }, { cap: 100, budget }), (err) => {
    assert.equal(err.code, "TIMEOUT");
    assert.match(err.message, /stalled: WhatsApp sent nothing for 0\.06 s/);
    return true;
  });
  assert.ok(Date.now() - started < 250, "stopped by the idle clock, not the overall one");
  assert.ok(quiet.destroyed, "the stream is closed");

  const never = { open: () => new Promise(() => {}), stillThere: () => {} };
  await assert.rejects(downloadToMemory("N", never, { cap: 100, budget: new DownloadBudget(limits({ idleMs: 1_000, totalMs: 80 })) }), (err) => {
    assert.equal(err.code, "TIMEOUT");
    assert.match(err.message, /took over 0\.08 s/);
    return true;
  });
  assert.deepEqual(budget.usage, { running: 0, reserved: 0, waiting: 0 });
});

test("a message deleted while its media lands stops the download and gives the slot back", async () => {
  const budget = new DownloadBudget(limits());
  let chunks = 0;
  const gone = source([Buffer.from("a"), Buffer.from("b")], {
    stillThere: () => {
      if (++chunks > 1) throw Object.assign(new Error("gone"), { code: "MESSAGE_NOT_FOUND" });
    },
  });
  await assert.rejects(downloadToMemory("D", gone, { cap: 100, budget }), { code: "MESSAGE_NOT_FOUND" });
  assert.equal(budget.usage.running, 0);
});
