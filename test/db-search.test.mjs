/**
 * Substring search the way search_messages promises it — case-insensitive,
 * now also diacritic-insensitive — newest first, filtered, paged without
 * loss, blind to deleted and replaced words, and honest when a bounded scan
 * stopped before it could prove absence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { foldText } from "../dist/db/index.js";
import { GROUP, PEER, PEER_LID, T0, openTemp, sid, textMessage } from "./db-fixtures.mjs";

const OTHER = "40700000003@s.whatsapp.net";

test("substrings match across case and diacritics, in text and in transcripts", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "F", T0, "Trimit factură mâine"));
  db.messages.upsert(textMessage(PEER, "S", T0 + 1000, "Ședința e la 17:30"));
  db.messages.upsert({ ...textMessage(PEER, "V", T0 + 2000, "[voice message]"), type: "audio", transcript: "Șoferul întârzie la depozit" });
  db.messages.upsert(textMessage(PEER, "N", T0 + 3000, "nimic relevant"));
  const find = (query) => db.search.text({ query, limit: 10 }).items.map((m) => m.keyId);
  assert.deepEqual(find("ctur"), ["F"]);
  assert.deepEqual(find("SEDINT"), ["S"]);
  assert.deepEqual(find("ședință"), ["S"]);
  assert.deepEqual(find("intarzie"), ["V"]);
  assert.deepEqual(find("17:30"), ["S"]);
  assert.deepEqual(find("mâine"), ["F"]);
  assert.equal(db.search.text({ query: "ctur", limit: 10 }).mode, "trigram");
  assert.equal(foldText("Ședință ȚARĂ"), "sedinta tara");
  db.close();
});

test("hits come newest first and page with a cursor, losing and repeating nothing", () => {
  const { db } = openTemp();
  const expected = [];
  for (let i = 0; i < 40; i++) {
    const match = i % 3 !== 1;
    db.messages.upsert(textMessage(i % 2 ? PEER : OTHER, `M${i}`, T0 + (i % 4 === 0 ? i - 1 : i) * 1000, match ? `plată ${i}` : `altceva ${i}`));
    if (match) expected.push(`M${i}`);
  }
  const seen = [];
  let before;
  for (;;) {
    const page = db.search.text({ query: "plata", limit: 7, ...(before === undefined ? {} : { before }) });
    seen.push(...page.items.map((m) => m.keyId));
    assert.equal(page.scanCapped, false);
    if (!page.hasMore) break;
    before = page.nextBefore;
  }
  const byTime = [...expected].sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  assert.deepEqual(seen, byTime);
  db.close();
});

test("filters: chat in any spelling, from me, from a sender in any spelling, since and until inclusive", async () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "A", T0, "comanda nouă"));
  db.messages.upsert(textMessage(PEER, "B", T0 + 1000, "comanda trimisă", { fromMe: true }));
  db.messages.upsert(textMessage(GROUP, "C", T0 + 2000, "comanda de grup", { senderJid: PEER }));
  db.messages.upsert(textMessage(GROUP, "D", T0 + 3000, "comanda altcuiva", { senderJid: OTHER }));
  await db.learnLidPhone(PEER_LID, PEER);
  const keys = (filter) => db.search.text({ query: "comanda", limit: 10, ...filter }).items.map((m) => m.keyId);
  assert.deepEqual(keys({}), ["D", "C", "B", "A"]);
  assert.deepEqual(keys({ chat: PEER_LID }), ["B", "A"]);
  assert.deepEqual(keys({ from: "me" }), ["B"]);
  assert.deepEqual(keys({ from: PEER_LID }), ["C", "A"]);
  assert.deepEqual(keys({ since: T0 + 1000, until: T0 + 2000 }), ["C", "B"]);
  assert.deepEqual(keys({ since: T0 + 1001 }), ["D", "C"]);
  assert.deepEqual(keys({ until: T0 + 999 }), ["A"]);
  assert.deepEqual(keys({ chat: "40799999999@s.whatsapp.net" }), []);
  assert.deepEqual(keys({ from: "40799999999@s.whatsapp.net" }), []);
  db.close();
});

test("deleted, edited-away and expired words leave the index, new words and transcripts join it", () => {
  const { db, clock } = openTemp();
  db.messages.upsert(textMessage(PEER, "DEL", T0, "parola wifi este secretă"));
  db.messages.upsert(textMessage(PEER, "EDIT", T0 + 1000, "întâlnire luni"));
  db.messages.upsert(textMessage(PEER, "EXP", T0 + 2000, "mesaj efemer", { expiresAt: clock.now + 1000 }));
  db.messages.upsert({ ...textMessage(PEER, "VOICE", T0 + 3000, "[voice]"), type: "audio" });
  const find = (query) => db.search.text({ query, limit: 10 }).items.map((m) => m.keyId);

  db.messages.delete(sid(false, PEER, "DEL"));
  assert.deepEqual(find("parola"), []);
  db.messages.upsert(textMessage(PEER, "EDIT", T0 + 1000, "întâlnire marți", { editedAt: T0 + 60_000 }));
  assert.deepEqual(find("luni"), []);
  assert.deepEqual(find("marti"), ["EDIT"]);
  db.messages.setTranscript(sid(false, PEER, "VOICE"), "adu pâine");
  assert.deepEqual(find("paine"), ["VOICE"]);
  clock.now += 1000;
  assert.deepEqual(find("efemer"), []);
  assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] });
  db.close();
});

test("a query under three characters scans recent messages and reports when the cap stopped it", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "OLD", T0, "Ședință"));
  for (let i = 1; i <= 100; i++) db.messages.upsert(textMessage(PEER, `N${i}`, T0 + i * 1000, `mesaj ${i}`));
  const capped = db.search.text({ query: "șe", limit: 5, scanCap: 50 });
  assert.equal(capped.mode, "scan");
  assert.deepEqual(capped.items, []);
  assert.equal(capped.scanCapped, true, "no hit within the cap is not proof of absence");
  assert.equal(capped.hasMore, true);
  const rest = db.search.text({ query: "șe", limit: 5, scanCap: 1000, before: capped.nextBefore });
  assert.deepEqual(rest.items.map((m) => m.keyId), ["OLD"]);
  assert.equal(rest.scanCapped, false);
  assert.equal(rest.hasMore, false);
  assert.deepEqual(db.search.text({ query: "SE", limit: 5 }).items.map((m) => m.keyId), ["OLD"]);
  db.close();
});

test("the trigram path reports its cap too, when filters reject most candidates", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(OTHER, "WANTED", T0, "raport lunar"));
  for (let i = 1; i <= 600; i++) db.messages.upsert(textMessage(PEER, `R${i}`, T0 + i * 1000, `raport ${i}`));
  const capped = db.search.text({ query: "raport", from: OTHER, limit: 5, scanCap: 300 });
  assert.deepEqual([capped.items.length, capped.scanCapped, capped.hasMore], [0, true, true]);
  const found = db.search.text({ query: "raport", from: OTHER, limit: 5, before: capped.nextBefore });
  assert.deepEqual(found.items.map((m) => m.keyId), ["WANTED"]);
  db.close();
});

test("quotes and operators in a query are literal", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "Q", T0, 'a spus "da" OR nu'));
  db.messages.upsert(textMessage(OTHER, "X", T0 + 1000, "altceva"));
  assert.deepEqual(db.search.text({ query: '"da" OR', limit: 5 }).items.map((m) => m.keyId), ["Q"]);
  assert.deepEqual(db.search.text({ query: "NEAR(", limit: 5 }).items, []);
  db.close();
});

test("a small chat searches only its own rows, with bounded resumable scans", async () => {
  const { db, clock } = openTemp();
  try {
    db.messages.upsert(textMessage(OTHER, "WANTED", T0, "Ședință OR raport"));
    db.messages.upsert(textMessage(OTHER, "VOICE", T0 + 1000, "[voice]", { transcript: "ședință nouă", fromMe: true }));
    db.messages.upsert(textMessage(OTHER, "GONE", T0 + 2000, "ședință", { expiresAt: clock.now + 1 }));
    db.messages.upsert(textMessage(OTHER, "UNRELATED", T0 + 3000, "altceva"));
    for (let i = 1; i <= 600; i++) db.messages.upsert(textMessage(PEER, `R${i}`, T0 + (i + 4) * 1000, "ședință"));
    clock.now++;
    const search = (extra = {}) => db.search.text({ query: "SEDINTA", chat: OTHER, limit: 1, ...extra });
    const capped = search({ scanCap: 1 });
    assert.deepEqual([capped.items.length, capped.scanCapped, capped.hasMore], [0, true, true]);
    const first = search({ before: capped.nextBefore });
    assert.deepEqual(first.items.map((m) => m.keyId), ["VOICE"]);
    const last = search({ before: first.nextBefore });
    assert.deepEqual(last.items.map((m) => m.keyId), ["WANTED"]);
    assert.equal(last.hasMore, false);
    assert.deepEqual(search({ from: "me" }).items.map((m) => m.keyId), ["VOICE"]);
    assert.deepEqual(search({ since: T0, until: T0 }).items.map((m) => m.keyId), ["WANTED"]);
    assert.deepEqual(search({ query: "OR raport" }).items.map((m) => m.keyId), ["WANTED"]);
    assert.deepEqual(search({ query: '" OR ' }).items, []);
    assert.equal(search({ query: "absent" }).hasMore, false);
    await db.learnLidPhone("456789012345@lid", OTHER);
    assert.deepEqual(search({ chat: "456789012345@lid" }).items.map((m) => m.keyId), ["VOICE"]);
    db.messages.delete(sid(true, OTHER, "VOICE"));
    assert.deepEqual(search().items.map((m) => m.keyId), ["WANTED"]);
  } finally {
    db.close();
  }
});

test("finding 12a: an empty or whitespace-only query names nothing and returns nothing", () => {
  const { db } = openTemp();
  db.messages.upsert(textMessage(PEER, "Q", T0, "orice"));
  for (const query of ["", "   ", "\t\n"]) {
    const result = db.search.text({ query, chat: PEER, limit: 5 });
    assert.deepEqual([result.items, result.hasMore, result.scanCapped], [[], false, false], JSON.stringify(query));
  }
  db.close();
});

test("small chats keep sender-filtered queries on FTS instead of an account-wide sender scan", async () => {
  const { db } = openTemp();
  try {
    db.messages.upsert(textMessage(GROUP, "PEER", T0, "raretoken", { senderJid: PEER }));
    db.messages.upsert(textMessage(GROUP, "ME", T0 + 1000, "raretoken", { fromMe: true }));
    await db.learnLidPhone(PEER_LID, PEER);
    let scans = 0;
    const scanIds = db.search.scanIds.bind(db.search);
    db.search.scanIds = (...args) => { scans++; return scanIds(...args); };
    const find = (extra = {}) => db.search.text({ query: "raretoken", chat: GROUP, limit: 10, ...extra }).items.map((m) => m.keyId);
    assert.deepEqual(find(), ["ME", "PEER"]);
    assert.equal(scans, 1, "unfiltered small chats retain their local scan");
    assert.deepEqual(find({ from: PEER }), ["PEER"]);
    assert.deepEqual(find({ from: PEER_LID }), ["PEER"]);
    assert.deepEqual(find({ from: "me" }), ["ME"]);
    assert.deepEqual(find({ from: PEER, query: "absent" }), []);
    assert.deepEqual(find({ from: OTHER }), []);
    assert.equal(scans, 1, "sender filters never enter the local trigram scan");
  } finally {
    db.close();
  }
});

test("scoped scans agree with FTS for decomposed and precomposed diacritics in both directions", async () => {
  const { db } = openTemp();
  const { foldText, foldedIncludes } = await import("../dist/db/fold.js");
  try {
    for (const [i, text] of ["câine", "ca\u0302ine", "câine", "ca\u0302ine"].entries()) {
      db.messages.upsert(textMessage(PEER, `D${i}`, T0 + i * 1000, i < 2 ? text : "[voice]", i < 2 ? {} : { transcript: text }));
    }
    for (const query of ["câine", "ca\u0302ine", "CAINE"]) {
      const indexed = db.search.text({ query, limit: 10 }).items.map((m) => m.keyId);
      const scoped = db.search.text({ query, chat: PEER, limit: 10 }).items.map((m) => m.keyId);
      assert.deepEqual(indexed, ["D3", "D2", "D1", "D0"]);
      assert.deepEqual(scoped, indexed, query);
      for (const text of ["câine", "ca\u0302ine"]) assert.equal(foldedIncludes(text, foldText(query)), true);
    }
    assert.equal(foldText("\u0302"), "\u0302");
    assert.deepEqual(db.search.text({ query: "\u0302", chat: PEER, limit: 10 }).items, []);
    for (const query of ["ca\u0302", "c\u0302\u0302"]) {
      assert.deepEqual(db.search.text({ query, limit: 10 }).items, []);
      assert.deepEqual(db.search.text({ query, chat: PEER, limit: 10 }).items, [], "a folded query too short for a trigram keeps FTS semantics");
    }
  } finally {
    db.close();
  }
});

test("scan folding removes exactly the combining marks removed by the trigram tokenizer", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { foldSearchText, foldedIncludes } = await import("../dist/db/fold.js");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE t USING fts5(text, tokenize = 'trigram remove_diacritics 1')");
    const insert = db.prepare("INSERT INTO t(rowid, text) VALUES (?, ?)");
    for (let cp = 0x0300; cp < 0x0370; cp++) insert.run(cp, `a${String.fromCodePoint(cp)}bc`);
    const removed = new Set(db.prepare("SELECT rowid FROM t WHERE t MATCH ?").all('"abc"').map((r) => r.rowid));
    for (let cp = 0x0300; cp < 0x0370; cp++) {
      const text = `a${String.fromCodePoint(cp)}bc`;
      assert.equal(foldSearchText(text) === "abc", removed.has(cp), `U+${cp.toString(16)}`);
      assert.equal(foldedIncludes(text, "abc"), removed.has(cp), `U+${cp.toString(16)}`);
    }
  } finally {
    db.close();
  }
});

test("finding 12a: a short query folds exactly like the trigram index, in Greek and Cyrillic as in Romanian", () => {
  const { db } = openTemp();
  ["Αθήνα ταξίδι", "Привет Ёлка", "ȘEDINȚĂ"].forEach((text, i) => db.messages.upsert(textMessage(PEER, `K${i}`, T0 + i * 1000, text)));
  const find = (query) => db.search.text({ query, limit: 10 }).items.map((m) => m.keyId);
  // What the index does with three letters, the scan must do with two.
  assert.deepEqual([find("θήν"), find("θην")], [["K0"], []], "the index keeps the Greek tonos");
  assert.deepEqual([find("θή"), find("θη")], [["K0"], []]);
  assert.deepEqual([find("ёлк"), find("елк")], [["K1"], []], "the index keeps ё distinct from е");
  assert.deepEqual([find("Ёл"), find("ел")], [["K1"], []]);
  assert.deepEqual([find("sed"), find("șe"), find("SE")], [["K2"], ["K2"], ["K2"]]);
  db.close();
});

test("the short-query scan matches folded text without folding each message into a new string, and agrees with the fold", async () => {
  const { foldText, foldedIncludes } = await import("../dist/db/fold.js");
  let seed = 11;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const alphabet = ["a", "A", "s", "Ș", "ș", "e", "É", "t", "Ț", "ё", "Ё", "θ", "ή", "𝒜", "😀", " ", "§", "x", "X", "1"];
  const pick = (length) => Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
  for (let i = 0; i < 5_000; i++) {
    const haystack = pick(Math.floor(random() * 30));
    const needle = foldText(pick(1 + Math.floor(random() * 3)));
    assert.equal(foldedIncludes(haystack, needle), foldText(haystack).includes(needle), JSON.stringify([haystack, needle]));
  }
  assert.equal(foldedIncludes("Ședința", "sedinta"), true);
  assert.equal(foldedIncludes("abc", ""), true);
});

test("finding 12a: the JavaScript fold is the trigram index's fold for every code point up to U+1FFFF", async () => {
  const { foldTableFromSqlite } = await import("../dist/db/fold-probe.js");
  const { foldCodePoint } = await import("../dist/db/fold.js");
  const sqliteFolds = new Map(foldTableFromSqlite(0x20, 0x20000));
  const drift = [];
  for (let cp = 0x20; cp < 0x20000; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const expected = sqliteFolds.get(cp) ?? cp;
    if (foldCodePoint(cp) !== expected) drift.push(`U+${cp.toString(16)}`);
  }
  assert.deepEqual(drift.slice(0, 20), [], "rerun scripts/gen-fold-table.mjs: the bundled SQLite folds differently");
});

test("coverage without a time or sender filter reads kept counts, which agree with a full count through every change, at a fraction of its cost", async () => {
  const { db, clock } = openTemp({ chunkSize: 7 });
  const STATUS = "status@broadcast";
  const exact = (filter) => db.search.coverage({ ...filter, exact: true });
  const agree = (label) => {
    for (const filter of [{}, { excludeKinds: ["status"] }, { chat: PEER }, { chat: PEER_LID }, { chat: OTHER }, { chat: GROUP }]) {
      assert.deepEqual(db.search.coverage(filter), exact(filter), `${label}: ${JSON.stringify(filter)}`);
    }
    assert.deepEqual(db.integrityCheck(), { ok: true, problems: [] }, label);
  };
  for (let i = 0; i < 30; i++) {
    db.messages.upsert(textMessage([PEER, PEER_LID, OTHER, GROUP][i % 4], `M${i}`, T0 + i * 1000, `mesaj ${i}`, i % 4 === 3 ? { senderJid: OTHER } : {}));
  }
  db.messages.upsert(textMessage(STATUS, "S1", T0 + 40_000, "story", { senderJid: OTHER, expiresAt: T0 + 86_400_000 }));
  db.messages.upsert(textMessage(OTHER, "SOON", T0 + 41_000, "expiră", { expiresAt: clock.now + 1000 }));
  agree("inserted");
  db.messages.upsert(textMessage(PEER, "M0", T0, "mesaj 0, editat", { editedAt: T0 + 50_000 }));
  db.messages.delete(sid(false, OTHER, "M2"));
  db.messages.delete(sid(false, PEER, "NEVER"), { ts: T0 + 3000 });
  agree("edited, deleted, retracted");
  clock.now += 2000;
  agree("expired, not yet swept");
  await db.messages.expireDue();
  agree("swept");
  await db.messages.clearChat(GROUP, T0 + 20_000);
  agree("cleared");
  await db.learnLidPhone(PEER_LID, PEER);
  agree("folded");
  await db.messages.deleteChat(OTHER, T0 + 60_000);
  agree("chat deleted");
  await db.messages.purgeLive();
  agree("purged");

  const { db: big } = openTemp();
  for (let batch = 0; batch < 15; batch++) {
    big.messages.upsertMany(Array.from({ length: 2000 }, (_, i) => textMessage([PEER, OTHER, GROUP][i % 3], `B${batch}_${i}`, T0 + (batch * 2000 + i) * 1000, `rând ${i}`)));
  }
  const cost = (fn) => {
    let best = Infinity;
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      fn();
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };
  assert.deepEqual(big.search.coverage({ excludeKinds: ["status"] }), big.search.coverage({ excludeKinds: ["status"], exact: true }));
  const kept = cost(() => big.search.coverage({ excludeKinds: ["status"] }));
  const counted = cost(() => big.search.coverage({ excludeKinds: ["status"], exact: true }));
  assert.ok(kept * 4 < counted, `kept counts ${kept.toFixed(2)} ms against a full count of ${counted.toFixed(2)} ms`);
  db.close();
  big.close();
});
