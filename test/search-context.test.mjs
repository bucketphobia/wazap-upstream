import test from "node:test";
import assert from "node:assert/strict";
import { WhatsAppService } from "../dist/whatsapp.js";
import { assessSearch, planSearch } from "../dist/search-query.js";
import { startEmbedStub } from "../scripts/eval/embed-stub.mjs";
import { contextExcerpt } from "../dist/service/search-context.js";
import { connectedService, schemaCheckedTools } from "./helpers.mjs";
import { openTemp, textMessage, PEER, PEER_LID, T0, sid } from "./db-fixtures.mjs";

const ME = "40700000001@s.whatsapp.net";
const OTHER = "40700000003@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";

async function setup(t, recall = true) {
  const stub = recall ? await startEmbedStub() : null;
  const keys = ["WAZAP_RECALL", "WAZAP_EMBED_URL", "WAZAP_EMBED_MODEL", "WAZAP_RECALL_MIN_SIMILARITY"];
  const saved = keys.map((key) => [key, process.env[key]]);
  const env = {
    WAZAP_RECALL: recall ? "local" : "off",
    WAZAP_EMBED_MODEL: "embeddinggemma-300m",
    WAZAP_RECALL_MIN_SIMILARITY: "0.3",
  };
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env, stub ? { WAZAP_EMBED_URL: stub.url } : {});
  let f;
  try {
    f = connectedService(WhatsAppService, {
      prefix: "wazap-context-",
      id: ME,
      name: "Owner",
      config: { persistHistory: true },
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  t.after(async () => {
    await f.svc.stop();
    await stub?.close();
  });
  await f.svc.bootStorage();
  let seq = 0;
  const arrive = (chat, body, over = {}) => {
    const key = {
      remoteJid: chat,
      fromMe: false,
      id: `C${++seq}`,
      ...(chat === GROUP ? { participant: PEER } : {}),
      ...over.key,
    };
    const raw = {
      messageTimestamp: Math.floor(Date.now() / 1000) - 600 + seq * 5,
      message: typeof body === "string" ? { conversation: body } : body,
      ...over,
      key,
    };
    f.sock.ev.emit("messages.upsert", { type: "notify", messages: [raw] });
    return `${Boolean(key.fromMe)}_${chat}_${key.id}`;
  };
  return { ...f, arrive, ...schemaCheckedTools(f.svc, { allowWrite: false, legacyReads: true }) };
}

test("cached connector searches a paraphrase by meaning and reports the actual mode", async (t) => {
  const f = await setup(t);
  const expected = f.arrive(PEER, "Factura este pe email.");
  await f.svc.recallIdle();
  const answer = (await f.call("search_messages", { query: "invoice", limit: 3 })).structuredContent;
  assert.equal(answer.mode, "hybrid");
  assert.equal(answer.messages[0].message_id, expected);
  assert.equal(answer.next_before, null);
  assert.equal(answer.accounts[0].mode, "hybrid");
  assert.equal(answer.contexts[0].account_id, "default");
});

test("one search includes the answer in a later message and the subsequent correction, with exact chronological sources", async (t) => {
  const f = await setup(t);
  const question = f.arrive(PEER, "Unde descărcăm transportul de câini pentru Alba?");
  const old = f.arrive(PEER, "Strada Florilor 12.");
  const corrected = f.arrive(PEER, "Corectez: Strada Lalelelor 18, intrarea din spate.");
  await f.svc.recallIdle();
  // A broad read must not be needed to collect the evidence.
  f.svc.readMessages = () => {
    throw new Error("unexpected chat rescan");
  };
  const result = await f.call("search", { query: "transport caini Alba", limit: 3 });
  assert.equal(result.isError, undefined);
  const context = result.structuredContent.contexts.find((c) => c.anchor_id === question);
  assert.deepEqual(
    context.messages.map((m) => m.message_id),
    [question, old, corrected]
  );
  assert.match(result.content[0].text, /Corectez: Strada Lalelelor 18/);
  assert.equal(result.structuredContent.assessment.state, "candidates");
});

test("context obeys explicit dates, bounds its size and exposes truncation", async (t) => {
  const f = await setup(t, false);
  const now = Math.floor(Date.now() / 1000);
  f.arrive(PEER, "OUTSIDE-PAST", { messageTimestamp: now - 4000 });
  const anchor = f.arrive(PEER, "EXACT-ANCHOR", { messageTimestamp: now - 100 });
  for (let i = 0; i < 12; i++) f.arrive(PEER, `${i} ${"long ".repeat(200)}`, { messageTimestamp: now - 90 + i });
  f.arrive(PEER, "OUTSIDE-FUTURE", { messageTimestamp: now - 50 });
  const result = await f.call("search", {
    query: "EXACT-ANCHOR",
    match: "words",
    since: new Date((now - 100) * 1000).toISOString(),
    until: new Date((now - 80) * 1000).toISOString(),
  });
  const context = result.structuredContent.contexts.find((c) => c.anchor_id === anchor);
  assert.ok(context.messages.length <= 7);
  assert.equal(context.messages[1].text.length, 600);
  assert.equal(context.messages[1].text_truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /OUTSIDE-PAST|OUTSIDE-FUTURE/);
  const plain = await f.call("search", { query: "EXACT-ANCHOR", match: "words", include_context: false });
  assert.equal(plain.structuredContent.contexts, undefined);
});

test("a quoted source outside the nearby window is read only when visible and within explicit dates", async (t) => {
  const f = await setup(t, false);
  const now = Math.floor(Date.now() / 1000);
  const original = f.arrive(PEER, "Adresa pentru transport este Strada Iasomiei 9.", { messageTimestamp: now - 7200 });
  const reply = f.arrive(
    PEER,
    {
      extendedTextMessage: {
        text: "Confirm transportul de vineri",
        contextInfo: {
          stanzaId: original.split("_").pop(),
          participant: PEER,
          quotedMessage: { conversation: "Adresa pentru transport este Strada Iasomiei 9." },
        },
      },
    },
    { messageTimestamp: now - 100 }
  );
  const result = await f.call("search", { query: "Confirm transportul", match: "words" });
  assert.deepEqual(
    result.structuredContent.contexts.find((c) => c.anchor_id === reply).messages.map((m) => m.message_id),
    [original, reply]
  );
  f.sock.ev.emit("messages.delete", { keys: [{ remoteJid: PEER, fromMe: false, id: original.split("_").pop() }] });
  const after = await f.call("search", { query: "Confirm transportul", match: "words" });
  assert.doesNotMatch(JSON.stringify(after), /Iasomiei/);
});

test("private neighbours and their quotes never leak; a named private author authorizes only that author", async (t) => {
  const f = await setup(t, false);
  f.arrive(GROUP, "ANCHOR public transport", { key: { participant: OTHER } });
  const secret = f.arrive(GROUP, "SECRET-ALPHA transport", { key: { participant: PEER } });
  f.arrive(GROUP, "SECRET-BETA", { key: { participant: ME } });
  f.svc.db.identity.updateFields(PEER, { addTags: ["private"] });
  f.svc.db.identity.updateFields(ME, { addTags: ["private"] });
  const broad = await f.call("search", { query: "ANCHOR", match: "words" });
  assert.doesNotMatch(JSON.stringify(broad), /SECRET-ALPHA|SECRET-BETA/);
  const named = await f.call("search", { query: "SECRET-ALPHA", match: "words", from: PEER });
  assert.equal(named.structuredContent.messages[0].message_id, secret);
  assert.match(JSON.stringify(named.structuredContent.contexts), /SECRET-ALPHA/);
  assert.doesNotMatch(JSON.stringify(named), /SECRET-BETA/);
  const whole = await f.call("search", { query: "ANCHOR", match: "words", chat_id: GROUP });
  assert.match(JSON.stringify(whole), /SECRET-BETA/);
});

test("context is fresh after edit, deletion, expiry and private-tag changes", async (t) => {
  const f = await setup(t, false);
  f.arrive(PEER, "ANCHOR");
  const id = f.arrive(PEER, "OLD-WORDS");
  assert.match(JSON.stringify(await f.call("search", { query: "ANCHOR", match: "words" })), /OLD-WORDS/);
  f.sock.ev.emit("messages.update", [
    {
      key: { remoteJid: PEER, fromMe: false, id: id.split("_").pop() },
      update: { message: { editedMessage: { message: { conversation: "NEW-WORDS" } } } },
    },
  ]);
  const edited = await f.call("search", { query: "ANCHOR", match: "words" });
  assert.doesNotMatch(JSON.stringify(edited), /OLD-WORDS/);
  assert.match(JSON.stringify(edited), /NEW-WORDS/);
  f.svc.db.messages.setExpiry(id, Date.now() - 1);
  assert.doesNotMatch(JSON.stringify(await f.call("search", { query: "ANCHOR", match: "words" })), /NEW-WORDS/);
  f.svc.db.identity.updateFields(PEER, { addTags: ["private"] });
  assert.equal((await f.call("search", { query: "ANCHOR", match: "words" })).structuredContent.count, 0);
});

test("literal planning avoids embeddings; explicit hybrid and lexical cursors remain explicit", async (t) => {
  const f = await setup(t, false);
  f.arrive(PEER, "Factura INV-2026-104 este achitată.");
  f.svc.recall = () => {
    throw new Error("literal started the model");
  };
  for (const query of ["INV-2026-104", '"INV-2026-104"', "  INV-2026-104  "]) {
    const answer = await f.call("search_messages", { query });
    assert.equal(answer.structuredContent.mode, "words");
    assert.equal(answer.structuredContent.count, 1);
  }
  assert.equal(planSearch("unde era adresa?", "auto").match, "hybrid");
  assert.equal(planSearch("INV-2026-104", "hybrid").match, "hybrid");
  assert.throws(() => planSearch("invoice", "hybrid", "id"), /cursor requires match words/);
});

test("automatic identifiers cannot match a different value's prefix; quoted pages retain their literal", async (t) => {
  const f = await setup(t, false);
  const first = f.arrive(PEER, "Factura INV-2026-104 este achitată.");
  const second = f.arrive(PEER, "Factura INV-2026-104 a fost trimisă.");
  f.arrive(PEER, "Factura INV-2026-1040 este alta.");
  const found = await f.call("search_messages", { query: '"INV-2026-104"', limit: 1 });
  assert.equal(found.structuredContent.messages[0].message_id, second);
  const older = await f.call("search_messages", {
    query: '"INV-2026-104"',
    before: found.structuredContent.next_before,
    limit: 1,
  });
  assert.equal(older.structuredContent.messages[0].message_id, first);
  const substring = await f.call("search", { query: "INV-2026-104", match: "words", limit: 5 });
  assert.equal(substring.structuredContent.count, 3, "explicit words still supports fragments");
});

test("vague questions with several chats ask for clarification without pretending cosine is confidence", () => {
  const hits = [
    { chat_id: PEER, message_id: "a" },
    { chat_id: OTHER, message_id: "b" },
  ];
  assert.equal(assessSearch("unde era adresa?", hits).state, "ambiguous");
  assert.equal(assessSearch("adresa transportului Alba", hits).state, "candidates");
  assert.equal(assessSearch("unde era adresa?", hits.slice(0, 1)).state, "candidates");
  assert.equal(assessSearch("unde era adresa?", []).state, "ambiguous");
  assert.equal(assessSearch("unde era adresa?", [], true).state, "no_matches");
  assert.equal(assessSearch("cod ZXQ-123", []).state, "no_matches");
});

test("conversation windows cannot revive a live LID twin of a retracted canonical message during a fold", async () => {
  const { db } = openTemp({ chunkSize: 1 });
  try {
    db.messages.upsert(textMessage(PEER, "A", T0, "ANCHOR"));
    db.messages.upsert(textMessage(PEER, "D", T0 + 1000, "RETRACTED"));
    db.messages.upsert(textMessage(PEER_LID, "D", T0 + 1000, "RETRACTED"));
    db.messages.delete(sid(false, PEER, "D"));
    const folding = db.learnLidPhone(PEER_LID, PEER);
    assert.ok(db.messages.around(sid(false, PEER, "A")).every((m) => m.keyId !== "D"));
    await folding;
    assert.ok(db.messages.around(sid(false, PEER, "A")).every((m) => m.keyId !== "D"));
  } finally {
    db.close();
  }
});

test("long context excerpts keep the relevant contiguous source span and its offset", () => {
  const text =
    "Introducere fără legătură. ".repeat(60) +
    "Important: transport Alba, descărcarea este pe Strada Lalelelor 18." +
    " Restul discuției. ".repeat(60);
  const excerpt = contextExcerpt(text, "transport Alba");
  assert.ok(excerpt.text_offset > 0);
  assert.equal(excerpt.text, text.slice(excerpt.text_offset, excerpt.text_offset + 600));
  assert.match(excerpt.text, /Strada Lalelelor 18/);
});

test("named evidence rejects a different subject but preserves translated months and title-case questions", async (t) => {
  const f = await setup(t);
  const id = f.arrive(PEER, "Doctorul a operat-o pe Luna. Factura pentru chiria din septembrie este achitată.");
  await f.svc.recallIdle();
  const message = f.svc.db.messages.get(id);
  f.svc.db.vectors.hybrid = () => ({
    hits: [{ message, score: 1, lexicalRank: null, semanticRank: 1, similarity: 0.99 }],
    semantic: true,
    lexicalCapped: false,
  });
  assert.equal((await f.call("search", { query: "doza de insulină pentru Rex" })).structuredContent.count, 0);
  for (const query of ["ce tratament este pentru Luna", "invoice for September", "Invoice For Rent"]) {
    assert.equal((await f.call("search", { query })).structuredContent.count, 1, query);
  }
});

test("search renders returned context only once, after identity work, for modern and cached clients", async (t) => {
  const f = await setup(t);
  f.arrive(PEER, "Unde descărcăm transportul de câini pentru Alba?");
  f.arrive(PEER, "Strada Florilor 12.");
  f.arrive(PEER, "Corectez: Strada Lalelelor 18.");
  await f.svc.recallIdle();
  const view = f.svc.views.viewOfStored.bind(f.svc.views);
  let rendered = 0;
  f.svc.views.viewOfStored = (...args) => {
    rendered++;
    return view(...args);
  };
  for (const tool of ["search", "search_messages"]) {
    rendered = 0;
    const answer = (await f.call(tool, { query: "transport caini Alba", limit: 1 })).structuredContent;
    const context = answer.contexts.reduce((n, c) => n + c.messages.length, 0);
    assert.equal(rendered, 2 * answer.count + context, tool);
  }
});

test("many rejected literal prefixes stop within a bounded candidate budget and report partial coverage", async (t) => {
  const f = await setup(t, false);
  const now = Date.now();
  f.svc.db.transaction(() =>
    f.svc.db.messages.upsertMany(
      Array.from({ length: 3000 }, (_, i) => ({
        chatJid: PEER,
        keyId: `PREFIX${i}`,
        fromMe: false,
        ts: now - 4000 + i,
        type: "text",
        text: `Other invoice INV-10${String(i).padStart(4, "0")}`,
      }))
    )
  );
  const search = f.svc.db.search.text.bind(f.svc.db.search);
  let scans = 0;
  f.svc.db.search.text = (...args) => {
    scans++;
    return search(...args);
  };
  for (const tool of ["search", "search_messages"]) {
    scans = 0;
    const answer = (await f.call(tool, { query: "INV-10", limit: 1 })).structuredContent;
    assert.equal(answer.count, 0);
    assert.ok(scans <= 40, `${tool} made ${scans} candidate queries`);
    assert.ok(
      answer.scan_capped === true || answer.partial === true,
      "a bounded miss must declare its incomplete coverage"
    );
  }
});
