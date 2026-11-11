/**
 * Account database benchmark: builds a synthetic account (many chats, a
 * skewed distribution, Romanian text with diacritics, protobuf-sized raw
 * blobs) through the storage module's own API, then times the hot paths.
 * Run `npm run build` first — this imports dist/, like the tests.
 *
 *   npm run bench:db                                  # 100k messages, vectors at 13k and 100k
 *   node scripts/bench-db.mjs --messages 1000000 --vectors 1000000
 *   node scripts/bench-db.mjs --check                 # exit 1 when a generous budget is blown
 *   node scripts/bench-db.mjs --llama                 # also time a cold llama-server start
 *
 * Options: --messages N, --vectors a,b,c (0 skips), --dir <path> (kept),
 * --json <file>, --check, --llama [--llama-bin <path>] [--model <gguf>], --runs N.
 * Timings are p50/p99 over repeated calls, in milliseconds; "stall" rows are
 * the longest pauses the event loop saw while a chunked operation ran.
 */
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

const DIST_DB = new URL("../dist/db/index.js", import.meta.url).href;
const { AccountDb, contentHash, quantizeVector } = await import(DIST_DB);
const { sqlite: sqliteModule } = await import(new URL("../dist/db/sqlite.js", import.meta.url).href);
const { findInAccount } = await import(new URL("../dist/find-contact.js", import.meta.url).href);
const { draftContextFor, styleCheckFor } = await import(new URL("../dist/draft-style.js", import.meta.url).href);
const { quotesOf, scanCatchup } = await import(new URL("../dist/catchup-scan.js", import.meta.url).href);
const { runCatchUp } = await import(new URL("../dist/catchup.js", import.meta.url).href);

const { values: args } = parseArgs({
  options: {
    messages: { type: "string", default: "100000" },
    vectors: { type: "string", default: "13000,100000" },
    dir: { type: "string" },
    json: { type: "string" },
    check: { type: "boolean", default: false },
    llama: { type: "boolean", default: false },
    "llama-bin": { type: "string", default: "llama-server" },
    model: { type: "string", default: join(homedir(), ".wazap", "models", "embeddinggemma-300M-Q8_0.gguf") },
    runs: { type: "string", default: "3" },
  },
});

const N = Number(args.messages);
const VECTOR_SIZES = args.vectors.split(",").map(Number).filter((n) => n > 0);
const CHATS = 600;
const GROUPS = 150;
const CONTACTS = 3000;
const DIMS = 768;
const MODEL = "embeddinggemma-300m";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const workDir = args.dir ?? mkdtempSync(join(tmpdir(), "wazap-bench-db-"));

const results = { node: process.version, messages: N, timings: {}, stalls: {}, facts: {} };
const log = (...parts) => console.error(...parts);

// ---------------------------------------------------------------- data

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (list) => list[Math.floor(rnd() * list.length)];
const WORDS = (
  "mâine la ședință contract factură plată întârzii ajung acasă mulțumesc ok da nu poate unde ești sună-mă " +
  "programare frizerie tuns barbă preț lei euro adresa strada vineri sâmbătă copii școală mama tata pizza cafea " +
  "birou proiect termen întâlnire mulțumim chirie curier livrare revizie mașină service ofertă avans rest " +
  "concediu avion bilet hotel grădiniță doctor programul țară București Iași Cluj vreau trebuie poți"
).split(" ");
const VOCAB = [...WORDS];
for (let i = 0; VOCAB.length < 20_000; i++) VOCAB.push(`c${i.toString(36)}ă`);
const zipf = () => VOCAB[Math.min(VOCAB.length - 1, Math.floor(Math.exp(rnd() * Math.log(VOCAB.length))) - 1)];
const sentence = () => Array.from({ length: 2 + Math.floor(rnd() * 14) }, () => (rnd() < 0.4 ? pick(WORDS) : zipf())).join(" ");
const rawBlob = () => {
  const bytes = new Uint8Array(300 + Math.floor(rnd() * 600));
  for (let i = 0; i < bytes.length; i++) bytes[i] = (rnd() * 256) | 0;
  return bytes;
};
const phone = (i) => `4070${String(i).padStart(7, "0")}@s.whatsapp.net`;
const chatJid = (i) => (i < GROUPS ? `1203630000${String(i).padStart(8, "0")}@g.us` : phone(i));
const TYPES = ["text", "text", "text", "text", "text", "text", "image", "audio", "document", "sticker"];
/** 30% of messages in the last week, the rest over a year; a few busy chats hold most of them. */
const tsFor = () => NOW - Math.floor((rnd() < 0.3 ? rnd() * 7 : rnd() * 365) * DAY);

function message(i) {
  const chat = Math.floor(rnd() * rnd() * CHATS);
  const jid = chatJid(chat);
  const fromMe = rnd() < 0.35;
  // A call now and then, and a group message that mentions the account: what catch_up reads off partial indexes.
  const type = i % 97 === 0 ? (pick(TYPES), "call") : pick(TYPES);
  const key = `3EB0${i.toString(16).toUpperCase().padStart(16, "0")}`;
  return {
    sid: `${fromMe}_${jid}_${key}`,
    chatJid: jid,
    keyId: key,
    fromMe,
    senderJid: fromMe ? null : chat < GROUPS ? phone(1000 + Math.floor(rnd() * CONTACTS)) : undefined,
    ts: tsFor(),
    type,
    text: type === "sticker" ? "[sticker]" : type === "audio" ? "[voice message · 0:24]" : sentence(),
    transcript: type === "audio" && rnd() < 0.7 ? sentence() : null,
    raw: rawBlob(),
    status: fromMe ? 3 : null,
    expiresAt: rnd() < 0.02 ? NOW + Math.floor(rnd() * 7 * DAY) : null,
    flags: !fromMe && chat < GROUPS && i % 50 === 0 ? 1 : 0,
  };
}

let centroidSeed = 99;
const centroidRnd = () => ((centroidSeed = (centroidSeed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const centroids = Array.from({ length: 64 }, () => Array.from({ length: DIMS }, () => centroidRnd() * 2 - 1));
/** Clustered directions, so similarities spread the way real embeddings do instead of all sitting near zero. */
function embedding() {
  const c = centroids[Math.floor(rnd() * centroids.length)];
  return quantizeVector(c.map((x) => x + (rnd() * 2 - 1) * 1.2));
}

function build(path, count, { vectors = false } = {}) {
  const started = performance.now();
  const db = AccountDb.open(path, { now: () => NOW, checkpointDelayMs: 0 });
  const batch = 2000;
  for (let i = 0; i < count; i += batch) {
    const rows = [];
    for (let j = i; j < Math.min(count, i + batch); j++) rows.push(message(j));
    db.transaction(() => {
      const stored = db.messages.upsertMany(rows);
      if (vectors) {
        stored.forEach((result, index) => {
          if (result.sid !== null) db.vectors.put(result.sid, MODEL, embedding(), contentHash(rows[index].text, rows[index].transcript));
        });
      }
    });
    if (i % 100_000 === 0 && i > 0) log(`  … ${i} rows`);
  }
  db.checkpoint();
  db.close();
  return performance.now() - started;
}

// ---------------------------------------------------------------- timing

function summarize(samples) {
  samples.sort((a, b) => a - b);
  const at = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  return { p50: +at(0.5).toFixed(3), p99: +at(0.99).toFixed(3), max: +samples[samples.length - 1].toFixed(3), n: samples.length };
}

function time(name, reps, fn, warmup = 2) {
  for (let i = 0; i < warmup; i++) fn(i);
  const samples = [];
  let out;
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    out = fn(i);
    samples.push(performance.now() - t);
  }
  results.timings[name] = summarize(samples);
  return out;
}

async function timeAsync(name, reps, fn, warmup = 2) {
  for (let i = 0; i < warmup; i++) await fn(i);
  const samples = [];
  let out;
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    out = await fn(i);
    samples.push(performance.now() - t);
  }
  results.timings[name] = summarize(samples);
  return out;
}

/** Runs a chunked operation and records how long the event loop stayed blocked each time it was. */
async function stalls(name, work) {
  const gaps = [];
  let last = performance.now();
  let running = true;
  const tick = () => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  const started = performance.now();
  const out = await work();
  running = false;
  results.stalls[name] = { ...summarize(gaps.length ? gaps : [0]), total_ms: +(performance.now() - started).toFixed(1) };
  return out;
}

const mb = (bytes) => +(bytes / 1048576).toFixed(1);
const fileSize = (path) => [path, `${path}-wal`].reduce((sum, file) => sum + (existsSync(file) ? statSync(file).size : 0), 0);

// ---------------------------------------------------------------- main account

async function mainPhase() {
  const path = join(workDir, "main", "wazap.sqlite");
  log(`building ${N} messages in ${path}`);
  const buildMs = build(path, N);
  results.facts.import_ms = Math.round(buildMs);
  results.facts.import_per_sec = Math.round(N / (buildMs / 1000));
  results.facts.file_mb = mb(fileSize(path));

  time("open (writable, migrated)", 20, () => AccountDb.open(path).close(), 1);
  time("open (read-only)", 20, () => AccountDb.open(path, { readOnly: true }).close(), 1);

  results.facts.rss_serving_mb = rssProbe(path);

  const clock = { now: NOW };
  const db = AccountDb.open(path, { now: () => clock.now, checkpointDelayMs: 0 });
  seed = 42;
  const sample = Array.from({ length: 2000 }, (_, i) => message(i));
  // The skew puts the most messages in the lowest chat indexes.
  const busy = Array.from({ length: 20 }, (_, i) => chatJid(i));
  results.facts.busiest_chat_rows = db.messages.countInChat(busy[0]).messages;

  time("get by sid", 500, (i) => db.messages.get(sample[i % sample.length].sid));
  time("chat page (50)", 200, (i) => db.messages.chatPage(busy[i % busy.length], { limit: 50 }));
  const firstPage = db.messages.chatPage(busy[0], { limit: 50 });
  time("chat page 2 (cursor)", 200, () => db.messages.chatPage(busy[0], { limit: 50, before: firstPage.nextBefore }));
  results.facts.recent_24h_rows = time("recent 24h (500)", 50, () => db.messages.recent({ since: NOW - DAY, limit: 500 })).items.length;
  time("recent 7d (50)", 50, () => db.messages.recent({ since: NOW - 7 * DAY, limit: 50 }));
  time("list chats (50)", 50, () => db.messages.listChats({ limit: 50 }));
  time("chat list page by activity (21)", 50, () => db.identity.chatsByActivity({ after: null, archived: false, limit: 21 }));
  time("waiting 14d", 50, () => db.messages.waiting({ since: NOW - 14 * DAY, until: NOW, limit: 100 }));
  time("coverage (account)", 50, () => db.messages.coverage());
  time("counts", 10, () => db.counts(), 1);

  const search = (query, extra = {}) => db.search.text({ query, limit: 20, ...extra });
  results.facts.search_common_hits = time("search common word (factur)", 50, () => search("factur")).items.length;
  time("search common, page 2", 50, () => search("factur", { before: search("factur").nextBefore }));
  time("search rare word", 50, () => search("c1a2bă"));
  time("search mid-word substring (edin)", 50, () => search("edin"));
  time("search diacritics folded (SEDINTA)", 50, () => search("SEDINTA"));
  time("search common in one chat", 50, (i) => search("plat", { chat: busy[5 + (i % 10)] }));
  time("search since 30d", 50, () => search("cafea", { since: NOW - 30 * DAY }));
  const short = time("short query (ok), default cap", 10, () => search("ok"), 1);
  results.facts.short_query_capped = short.scanCapped;
  const absent = time("short query absent (§x), default cap", 10, () => search("§x"), 1);
  results.facts.short_absent_capped = absent.scanCapped;

  catchUpPhase(db, path);
  await catchUpDigestPhase(db);
  findPhase(db);
  // What an upgraded account walks once after the v5 migration; the service's detector decodes each protobuf on top.
  db.messages.requestFlagsBackfill();
  const backfill = await stalls("flags backfill, 14 days (no decode)", () => db.messages.backfillFlags(() => 0));
  results.facts.flags_backfill_scanned = backfill.scanned;

  let n = 0;
  time("single insert (autocommit, FULL)", 500, () => {
    const m = message(10_000_000 + n++);
    db.messages.upsert({ ...m, ts: NOW - 1000, expiresAt: null });
  });
  let t = 0;
  time("tombstone single", 200, () => db.messages.delete(sample[t++ % sample.length].sid));


  const big = [chatJid(0), chatJid(1)];
  const cleared = await stalls("clear busiest chat", () => db.messages.clearChat(big[0], NOW));
  results.facts.clear_rows = cleared.count;
  clock.now = NOW + 8 * DAY;
  const expired = await stalls("expiry sweep (2% ephemeral)", () => db.messages.expireDue());
  results.facts.expired_rows = expired.count;

  const lid = "987650000000001@lid";
  const lidRows = Array.from({ length: 5000 }, (_, i) => ({ ...message(20_000_000 + i), chatJid: lid, senderJid: undefined, fromMe: false, expiresAt: null }));
  for (const row of lidRows) row.sid = `false_${lid}_${row.keyId}`;
  for (let i = 0; i < lidRows.length; i += 1000) db.messages.upsertMany(lidRows.slice(i, i + 1000));
  const merged = await stalls("lid/phone merge (5k rows)", () => db.learnLidPhone(lid, chatJid(400)));
  results.facts.merge_moved = merged.movedMessages;

  const optimized = await stalls("FTS optimize (incremental merge)", () => db.optimize());
  results.facts.fts_optimize_steps = optimized.steps;
  const clearedAfter = await stalls("clear 2nd chat after FTS optimize", () => db.messages.clearChat(big[1], NOW));
  results.facts.clear_after_optimize_rows = clearedAfter.count;

  db.close();
  results.facts.file_mb_after = mb(fileSize(path));
}

/**
 * The reads catch_up is planned on (F2-2), over the v5 columns and indexes:
 * the chats active in a window, then one aggregate per chat over its id range
 * — messages, senders, media, newest — above the chat's own last word and its
 * read mark; the window's mentions, calls and polls off their partial indexes.
 */
function catchUpPhase(db, path) {
  const reader = new (sqliteModule().DatabaseSync)(path, { readOnly: true });
  const MEDIA = "('image', 'video', 'audio', 'voice', 'document', 'sticker')";
  const active = reader.prepare(
    `SELECT id, last_message_id, last_own_id, read_through_id FROM chats INDEXED BY chats_recent
     WHERE last_ts >= ? AND merged_into IS NULL ORDER BY last_ts DESC`
  );
  const perChat = reader.prepare(
    `SELECT count(*) AS n, count(DISTINCT m.sender_id) AS senders, sum(m.type IN ${MEDIA}) AS media, max(m.id) AS newest
     FROM messages m WHERE m.chat_id = ? AND m.id > ? AND m.id <= ? AND m.from_me = 0 AND m.deleted_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > ?)`
  );
  const grouped = reader.prepare(
    `SELECT m.chat_id, count(*) AS n, count(DISTINCT m.sender_id) AS senders, sum(m.type IN ${MEDIA}) AS media, max(m.id) AS newest
     FROM messages m WHERE m.id > ? AND m.id <= ? AND m.from_me = 0 AND m.deleted_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > ?) GROUP BY m.chat_id`
  );
  const mentions = reader.prepare("SELECT m.id, m.chat_id FROM messages m WHERE (m.flags & 1) <> 0 AND m.id > ? AND m.id <= ?");
  const calls = reader.prepare("SELECT m.id, m.chat_id FROM messages m WHERE m.type = 'call' AND m.id > ? AND m.id <= ?");
  const ownCount = reader.prepare(
    "SELECT count(*) AS n FROM messages m WHERE m.chat_id = ? AND m.from_me = 1 AND m.deleted_at IS NULL AND m.id >= ?"
  );
  const idFloor = (ms) => Math.floor(ms / 1000) * 1048576;
  const top = idFloor(NOW + 1000);
  for (const [label, hours] of [["24h", 24], ["7d", 168]]) {
    const since = NOW - hours * 3_600_000;
    const lower = idFloor(since);
    const rows = time(`catch_up: aggregate per active chat ${label}`, 20, () => {
      const out = [];
      for (const chat of active.all(since)) {
        const floor = Math.max(lower, chat.last_own_id ?? 0, chat.read_through_id ?? 0);
        const agg = perChat.get(chat.id, floor, top, NOW);
        if (agg.n > 0) out.push(agg);
      }
      return out;
    }, 1);
    results.facts[`catch_up_chats_${label}`] = rows.length;
    time(`catch_up: aggregate grouped by chat ${label}`, 20, () => grouped.all(lower, top, NOW), 1);
    time(`catch_up: mentions + calls ${label}`, 50, () => [mentions.all(lower, top), calls.all(lower, top)]);
  }
  const busiest = db.messages.listChats({ limit: 1 }).items[0].chat;
  time("own messages in a chat, 90d (count)", 200, () => ownCount.get(busiest.id, idFloor(NOW - 90 * DAY)).n);
  time("draft context: style of a chat (90d)", 50, () => db.messages.styleFor(busiest.jid));
  time("draft context: style, account-wide fallback", 50, () => db.messages.styleFor(chatJid(CHATS - 1)));
  time("draft context: recent exchange (8)", 200, () => db.messages.recentExchange(busiest.jid));
  reader.close();
}

/**
 * catch_up itself (F2-2) on the 100k-message account: one account's scan of
 * a window (every section, no names to fetch), and the whole digest — scan,
 * the budget pass with its quotes read back by id, the rendering — for the
 * last day and the last week, and since a client's mark.
 */
async function catchUpDigestPhase(db) {
  const host = {
    now: () => NOW,
    ownJid: () => "40700000000@s.whatsapp.net",
    nameOf: (jid) => jid.split("@")[0],
    noteOf: () => undefined,
    isNoise: () => false,
    leftGroup: () => false,
    prepareNames: async () => {},
    connection: () => ({ status: "connected", since: null, sync: "done", mentionsIndexing: false }),
  };
  const account = { id: "bench", name: "Bench" };
  const include = ["waiting", "addressed", "calls", "direct", "groups", "stories"];
  const source = {
    getStatus: () => ({ status: "connected", account_id: "bench" }),
    catchUpScan: (request) => scanCatchup(db, host, request, account),
    catchUpQuotes: async (ids) => quotesOf(db, ids),
    catchUpAdvance: async () => ({ advanced: false }),
  };
  const binding = { id: "bench", wa: source };
  const hub = {
    binding: () => binding,
    defaultBinding: () => binding,
    bindings: () => [binding],
    record: () => ({ id: "bench", name: "Bench", enabled: true, owner: null }),
  };
  const ctx = { hub, wa: source, accountId: "bench", client: "bench", now: () => NOW };
  // Since a client's mark: what the last 5,000 messages stored brought, off stored_seq, whenever they were sent.
  db.catchup.advance("bench-mark", Math.max(0, db.digest.storedTop() - 5000), { at: NOW - DAY });
  const sinceMark = await timeAsync("catch_up: digest since a mark (5k stored), 2500 tokens", 20, () => runCatchUp({ budget_tokens: 2500 }, { ...ctx, client: "bench-mark" }), 1);
  results.facts.catch_up_digest_mark_2500 = { approx_tokens: sinceMark.structuredContent.approx_tokens, more: sinceMark.structuredContent.more?.remaining ?? null };
  for (const [label, hours] of [["24h", 24], ["7d", 168]]) {
    const scan = await timeAsync(`catch_up: scan ${label}`, 20, () => scanCatchup(db, host, { client: "bench", include, window: { kind: "hours", hours } }, account), 1);
    results.facts[`catch_up_entries_${label}`] = {
      waiting: scan.waiting.length,
      addressed: scan.addressed.length,
      calls: scan.calls.length,
      direct: scan.direct.length,
      groups: scan.groups.length,
      muted_groups: scan.mutedGroups?.groups ?? 0,
    };
    for (const budget of [2500, 8000]) {
      const digest = await timeAsync(`catch_up: digest ${label}, ${budget} tokens`, 20, () => runCatchUp({ hours, budget_tokens: budget }, ctx), 1);
      results.facts[`catch_up_digest_${label}_${budget}`] = {
        approx_tokens: digest.structuredContent.approx_tokens,
        more: digest.structuredContent.more?.remaining ?? null,
        structured_to_text: +(JSON.stringify(digest.structuredContent).length / digest.content[0].text.length).toFixed(2),
      };
    }
  }
}

/**
 * find_contact over an address book of 10k people (names Romanian and
 * English, a tenth with notes, tags or details) on the 100k-message account:
 * a common first name, a full name, a relationship, a diminutive, a
 * qualifier, and a name nobody has (the near-spelling pass over everyone).
 */
function findPhase(db) {
  const FIRST = ["Ana", "Andrei", "Maria", "Mihai", "Elena", "Alexandru", "Ioana", "Cristian", "Gabriela", "Ștefan", "Daniel", "Andreea", "John", "Sarah", "Michael", "Emma"];
  const LAST = ["Popescu", "Ionescu", "Popa", "Dumitru", "Stan", "Stoica", "Gheorghe", "Matei", "Ciobanu", "Rusu", "Smith", "Brown", "Marin", "Tudor", "Dobre", "Barbu"];
  const PEOPLE = 10_000;
  db.transaction(() => {
    for (let i = 0; i < PEOPLE; i++) {
      const jid = phone(i);
      db.identity.upsertContact({ jid, name: i % 7 === 0 ? null : `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`, pushName: FIRST[(i * 3) % FIRST.length], listed: true });
      if (i % 10 === 0) db.identity.updateFields(jid, { addTags: [i % 20 === 0 ? "contabilitate" : "client"], set: { oras: "Iași" } });
    }
    db.identity.upsertContact({ jid: phone(PEOPLE + 1), name: "Mama" });
  });
  results.facts.find_contacts = PEOPLE;
  for (const [label, input] of [
    ["find: common first name (Ana)", { name: "Ana" }],
    ["find: full name (Andrei Matei)", { name: "Andrei Matei" }],
    ["find: relationship (mamei)", { name: "mamei" }],
    ["find: diminutive (Cristi)", { name: "Cristi" }],
    ["find: qualifier (Ana, contabilitate)", { name: "Ana", qualifier: "contabilitate" }],
    ["find: nobody (Zzyzx, near-spelling pass)", { name: "Zzyzx" }],
  ]) {
    const found = time(label, 20, () => db.contacts.find(input), 2);
    results.facts[`find_${input.name}`] = `${found.verdict}/${found.candidates.length + found.closest.length}`;
  }
  // The tool's side (F2-3): the same finds with each candidate's note, a number's tail, then what a resolved contact carries.
  for (const [label, input] of [
    ["find_contact: Ana, with notes", { name: "Ana" }],
    ["find_contact: number tail (Ana, 0030)", { name: "Ana", qualifier: "0030" }],
  ]) {
    const found = time(label, 20, () => findInAccount(db, "default", input), 2);
    results.facts[`find_contact_${input.qualifier ?? input.name}`] = `${found.verdict}/${found.candidates.length + found.closest.length}`;
  }
  const direct = chatJid(GROUPS);
  time("find_contact: draft context (style, 8 recent)", 50, () => draftContextFor(db, direct, { recent: true, senderName: (jid) => jid }));
  const checked = time("send_message: style_check", 50, () => styleCheckFor(db, direct, "Bună, ajung în zece minute și te sun când plec de acasă."));
  results.facts.style_check_basis = checked === null ? "too little" : `${checked.basis.own_messages} own`;
}

/**
 * RSS of a fresh process that opens the account and serves typical reads —
 * the builder above leaves garbage behind that says nothing about serving.
 * Reported next to the same process before it opens anything.
 */
function rssProbe(path) {
  const script = `
    const mb = () => +(process.memoryUsage().rss / 1048576).toFixed(1);
    const { AccountDb } = await import(${JSON.stringify(DIST_DB)});
    const baseline = mb();
    const db = AccountDb.open(${JSON.stringify(path)});
    const chats = db.messages.listChats({ limit: 50 }).items.map((item) => item.chat.jid);
    for (let i = 0; i < 200; i++) {
      db.messages.chatPage(chats[i % chats.length], { limit: 50 });
      db.search.text({ query: ["factur", "sedint", "chirie", "ok"][i % 4], limit: 20 });
    }
    db.messages.recent({ since: ${NOW - DAY}, limit: 500 });
    db.messages.waiting({ since: ${NOW - 14 * DAY}, until: ${NOW}, limit: 100 });
    console.log(JSON.stringify({ baseline_mb: baseline, serving_mb: mb() }));
    db.close();
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
}

// ---------------------------------------------------------------- vectors

async function vectorPhase(size) {
  const path = join(workDir, `vectors-${size}`, "wazap.sqlite");
  log(`building ${size} messages with embeddings in ${path}`);
  seed = 7_000 + size;
  const buildMs = build(path, size, { vectors: true });
  const db = AccountDb.open(path, { now: () => NOW, checkpointDelayMs: 0 });
  const query = Array.from(centroids[3], (x) => x + (rnd() * 2 - 1) * 0.8);
  const chat = db.messages.listChats({ limit: 12 }).items[10].chat.jid;
  const prefix = `@${size}`;
  const reps = size >= 1_000_000 ? 5 : 15;
  const embeddings = time(`embeddings count ${prefix}`, reps, () => db.vectors.count(MODEL), 1);
  time(`vector search ${prefix}`, reps, () => db.vectors.vectorSearch({ model: MODEL, vector: query, limit: 20 }), 1);
  time(`vector search, one chat ${prefix}`, reps, () => db.vectors.vectorSearch({ model: MODEL, vector: query, limit: 20, chat }), 1);
  time(`vector search, last 30d ${prefix}`, reps, () => db.vectors.vectorSearch({ model: MODEL, vector: query, limit: 20, since: NOW - 30 * DAY }), 1);
  const hybrid = time(
    `hybrid search ${prefix}`,
    reps,
    () => db.vectors.hybrid({ query: "unde e factura de chirie", vector: query, model: MODEL, limit: 20, minSimilarity: 0.35 }),
    1
  );
  db.close();
  const probe = `
    const { AccountDb } = await import(${JSON.stringify(DIST_DB)});
    const baseline = +(process.memoryUsage().rss / 1048576).toFixed(1);
    const db = AccountDb.open(${JSON.stringify(path)}, { readOnly: true });
    const query = ${JSON.stringify(query)};
    for (let i = 0; i < 3; i++) db.vectors.vectorSearch({ model: "${MODEL}", vector: query, limit: 20 });
    console.log(JSON.stringify({ baseline_mb: baseline, after_vector_search_mb: +(process.memoryUsage().rss / 1048576).toFixed(1) }));
  `;
  const rss = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8" }));
  results.facts[`vectors_${size}`] = {
    build_ms: Math.round(buildMs),
    file_mb: mb(fileSize(path)),
    embeddings,
    hybrid_hits: hybrid.hits.length,
    rss: rss,
  };
}

// ---------------------------------------------------------------- llama-server

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  probe.close();
  await once(probe, "close");
  return port;
}

async function llamaColdStart() {
  if (!existsSync(args.model)) {
    results.facts.llama = `model not found at ${args.model}`;
    return;
  }
  const runs = [];
  for (let run = 0; run < Number(args.runs); run++) {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const started = performance.now();
    // The flags the recall engine spawns it with.
    const child = spawn(
      args["llama-bin"],
      ["-m", args.model, "--host", "127.0.0.1", "--port", String(port), "--embedding", "-c", "8192", "-b", "8192", "-ub", "8192"],
      { stdio: "ignore" }
    );
    const exited = once(child, "exit");
    let healthy = null;
    let embedded;
    try {
      for (let i = 0; i < 1200 && healthy === null; i++) {
        try {
          const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
          if (response.ok) healthy = performance.now() - started;
          await response.arrayBuffer();
        } catch {
          // not listening yet
        }
        if (healthy === null) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const response = await fetch(`${base}/embedding`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "task: search result | query: unde e factura de chirie" }),
      });
      await response.json();
      embedded = performance.now() - started;
    } finally {
      process.kill(child.pid, "SIGTERM");
      await exited;
    }
    runs.push({ health_ms: healthy === null ? null : Math.round(healthy), first_embedding_ms: Math.round(embedded) });
  }
  results.facts.llama_cold_start = runs;
}

// ---------------------------------------------------------------- budgets

/** Generous on purpose: they catch a query that lost its index, not a slow laptop. Checked at ≤ 100k only. */
const BUDGETS_P99 = {
  "open (writable, migrated)": 50,
  "get by sid": 5,
  "chat page (50)": 25,
  "chat page 2 (cursor)": 25,
  "recent 24h (500)": 60,
  "list chats (50)": 25,
  "waiting 14d": 25,
  counts: 10,
  "search common word (factur)": 50,
  "search mid-word substring (edin)": 50,
  "search rare word": 50,
  "short query (ok), default cap": 400,
  "single insert (autocommit, FULL)": 60,
  "tombstone single": 60,
  "catch_up: aggregate per active chat 24h": 200,
  "catch_up: digest 24h, 2500 tokens": 200,
  "catch_up: digest 7d, 8000 tokens": 1000,
  "catch_up: digest since a mark (5k stored), 2500 tokens": 200,
  "catch_up: aggregate grouped by chat 7d": 1000,
  "find: common first name (Ana)": 50,
  "find: nobody (Zzyzx, near-spelling pass)": 100,
  "find_contact: Ana, with notes": 50,
  "find_contact: draft context (style, 8 recent)": 50,
  "send_message: style_check": 50,
};
const STALL_BUDGET_P99 = 100;

function check() {
  const failures = [];
  for (const [name, budget] of Object.entries(BUDGETS_P99)) {
    const measured = results.timings[name];
    if (measured !== undefined && measured.p99 > budget) failures.push(`${name}: p99 ${measured.p99} ms > ${budget} ms`);
  }
  for (const [name, measured] of Object.entries(results.stalls)) {
    if (measured.p99 > STALL_BUDGET_P99) failures.push(`${name}: stall p99 ${measured.p99} ms > ${STALL_BUDGET_P99} ms`);
  }
  return failures;
}

// ---------------------------------------------------------------- run

if (N > 0) await mainPhase();
for (const size of VECTOR_SIZES) await vectorPhase(size);
if (args.llama) await llamaColdStart();

const rows = [
  ...Object.entries(results.timings).map(([name, t]) => `${name.padEnd(44)} ${String(t.p50).padStart(9)} ${String(t.p99).padStart(9)}`),
  "",
  "chunked operations: event-loop stalls (p50 / p99 / max, total)",
  ...Object.entries(results.stalls).map(
    ([name, s]) => `${name.padEnd(44)} ${String(s.p50).padStart(9)} ${String(s.p99).padStart(9)} ${String(s.max).padStart(9)}  total ${s.total_ms}`
  ),
];
console.log(`node ${results.node}, ${N} messages\n${"operation".padEnd(44)} ${"p50 ms".padStart(9)} ${"p99 ms".padStart(9)}`);
console.log(rows.join("\n"));
console.log(JSON.stringify(results.facts, null, 1));
if (args.json) writeFileSync(args.json, `${JSON.stringify(results, null, 1)}\n`);
if (args.dir === undefined) rmSync(workDir, { recursive: true, force: true });

if (args.check) {
  const failures = N <= 100_000 ? check() : [];
  if (failures.length > 0) {
    console.error(`\nbudget check failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.error(N <= 100_000 ? "\nbudget check: all within budget" : "\nbudget check: skipped above 100k messages");
}
