/**
 * The legacy import against an account main's own persistence code wrote (see
 * legacy-fixtures.mjs): the database must show what the legacy service shows,
 * keep what the legacy files lost, and never bring back what they deleted —
 * whether the import runs once, again, or is cut off in the middle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { proto } from "baileys";

import { AccountDb, contentHash } from "../dist/db/index.js";
import { sqlite } from "../dist/db/sqlite.js";
import { importBetaArchive, importLegacyAccount, verifyLegacyImport, scrubQuote, IMPORT_PHASES } from "../dist/legacy-import/index.js";
import { ANA, BOGDAN, BOGDAN_LID, CRISTI, DIMS, GROUP, ME, MODEL, buildLegacyAccount, roles, vectorRow } from "./legacy-fixtures.mjs";

const r = roles();

/** The fixture's files were written at fx.now: every clock here reads that moment. */
function openDb(fx, options = {}) {
  return AccountDb.open(join(fx.dataDir, "accounts", "default", options.file ?? "wazap.sqlite"), {
    scrubQuote,
    checkpointDelayMs: 0,
    now: () => fx.now,
    ...options.db,
  });
}

function run(fx, db, options = {}) {
  return importLegacyAccount({
    dataDir: fx.dataDir,
    accountId: "default",
    accountPaths: fx.paths,
    db,
    options: { now: () => fx.now, ...options },
  });
}

/** Every file under the legacy paths, hashed: the import must leave each byte as it was. */
function legacyDigest(fx) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (!name.startsWith("wazap") && !name.startsWith(".legacy-verify")) files.push(path);
    }
  };
  walk(fx.dataDir);
  return Object.fromEntries(
    files
      .filter((path) => !path.includes("wazap.sqlite") && !path.includes("-crash") && !path.includes("-clean"))
      .sort()
      .map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")])
  );
}

const IMPORT_CLOCK_COLUMNS = { contacts: ["updated_at"], lid_phones: ["learned_at"], contact_notes: ["updated_at"], pending_unlinks: ["queued_at"] };

/** Every row of every table, minus the timestamps the import itself stamps and its own bookkeeping in meta. */
function dump(path) {
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'messages_fts%' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    const out = {};
    for (const table of tables) {
      const skip = new Set(IMPORT_CLOCK_COLUMNS[table] ?? []);
      out[table] = db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .filter((row) => table !== "meta" || !/^(import_|migrated_|created_at|change_epoch|owner)/.test(row.key))
        .map((row) =>
          JSON.stringify(
            Object.fromEntries(
              Object.entries(row)
                .filter(([column]) => !skip.has(column))
                .map(([column, value]) => [column, value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value])
            )
          )
        )
        .sort();
    }
    return out;
  } finally {
    db.close();
  }
}

test("a legacy account imports and verifies against the legacy service with no unexpected difference", async () => {
  const fx = await buildLegacyAccount();
  const before = legacyDigest(fx);
  const db = openDb(fx);
  try {
    const report = await run(fx, db);
    assert.equal(report.state, "done");
    assert.equal(report.owner, ME);
    assert.deepEqual(report.verification.unexpected, {}, JSON.stringify(report.verification.samples));
    assert.equal(report.verification.ok, true);
    assert.equal(report.verification.expected.betaOnly, 3, "two beta messages and a text-only view-once");
    assert.equal(report.verification.expected.indexOnly, 1);
    assert.equal(report.verification.expected.betaDeleted, 1);
    assert.equal(report.verification.expected.futureTimestamp, 1);
    assert.ok(report.verification.messages.matched >= 15);
    assert.equal(report.verification.handled.db, 1);
    assert.equal(report.verification.notes.db, 2);
    assert.equal(report.verification.fields.db, 1);
    assert.deepEqual(Object.keys(report.phases), [...IMPORT_PHASES]);
    assert.deepEqual(legacyDigest(fx), before, "no legacy file changed");
    assert.equal(existsSync(join(fx.dataDir, "archive.sqlite-shm")), false, "the beta archive opened immutable");
    assert.equal(
      readdirSync(join(fx.dataDir, "accounts", "default")).some((name) => name.startsWith(".legacy-verify")),
      false,
      "the verification copy is gone"
    );
    assert.equal(db.integrityCheck().ok, true);
  } finally {
    db.close();
  }
});

test("barriers hold: deleted, revoked, cleared and beta-deleted messages stay gone, and a revoked quote loses its copy", async () => {
  const fx = await buildLegacyAccount();
  const db = openDb(fx);
  try {
    const report = await run(fx, db, { verify: false });
    assert.equal(db.messages.get(r.a3), null, "deleted for me");
    assert.notEqual(db.messages.get(r.a3, { includeHidden: true })?.deletedAt, null, "as a tombstone, over the beta's live copy");
    assert.equal(db.messages.get(r.g2), null, "revoked");
    assert.equal(db.messages.get(r.b2), null, "deleted in the beta archive");
    assert.equal(db.messages.get(r.betaGone), null);
    assert.notEqual(db.messages.get(r.betaGone, { includeHidden: true }), null, "a beta tombstone for a message nobody else has");
    assert.ok(db.messages.get(r.ghost), "an expiry the beta applied is not a deletion while retention is off");
    assert.equal(report.phases.beta.skipped.retentionOff, 1);

    assert.deepEqual(db.messages.chatPage(CRISTI, { limit: 50 }).items, [], "the cleared chat stays empty");
    assert.equal(db.messages.get(r.k1), null, "the index's copy of a cleared message is not a way back");
    assert.equal(report.phases.recall.skipped.barrier, 1);

    const quoting = db.messages.get(r.g4);
    const decoded = proto.WebMessageInfo.decode(quoting.raw);
    assert.equal(decoded.message.extendedTextMessage.contextInfo.quotedMessage, null, "the quote of the revoked message is scrubbed");
    assert.equal(quoting.text, "Perfect, mulțumesc Ana");

    const deleted = db.messages.get(r.revoke);
    assert.equal(deleted?.type, "deleted", "the revoke itself reads as the service shows it");
    assert.equal(report.phases.history.details.revokes, 1);
  } finally {
    db.close();
  }
});

test("the newest edit wins, lids fold into their number, notes and marks carry over", async () => {
  const fx = await buildLegacyAccount();
  const db = openDb(fx);
  try {
    await run(fx, db, { verify: false });
    const edited = db.messages.get(r.a2);
    assert.equal(edited.text, "Bine, mulțumesc frumos, tu?");
    assert.notEqual(edited.editedAt, null);
    const original = proto.WebMessageInfo.fromObject({
      key: { remoteJid: ANA, fromMe: true, id: "A2" },
      messageTimestamp: Math.floor(edited.ts / 1000),
      message: { conversation: "Bine, mulțumesc frumos" },
    });
    const replay = db.messages.upsert({
      chatJid: ANA,
      keyId: "A2",
      fromMe: true,
      ts: edited.ts,
      type: "text",
      text: "Bine, mulțumesc frumos",
      raw: proto.WebMessageInfo.encode(original).finish(),
    });
    assert.equal(replay.outcome, "stale", "a replay of the original cannot win the edit back");
    assert.equal(db.messages.get(r.a2).text, "Bine, mulțumesc frumos, tu?");
    assert.equal(edited.status, 4, "read, as its receipt said");

    assert.equal(db.identity.chat(BOGDAN_LID).jid, BOGDAN);
    assert.deepEqual(
      db.messages.chatPage(BOGDAN, { limit: 10 }).items.map((m) => m.sid).sort(),
      [r.b1, r.b2, r.b3].filter((sid) => sid !== r.b2).sort(),
      "the lid's messages and the number's are one chat (B2 was deleted in the beta)"
    );
    const bogdan = db.identity.notes(BOGDAN_LID);
    assert.equal(bogdan.note, "Bogdan de la depozit", "a note filed under the lid moved to the person");
    assert.deepEqual(bogdan.tags, ["furnizor"]);
    assert.deepEqual(bogdan.fields, { oras: "Cluj" });
    assert.equal(db.identity.notes(ANA).note, "Colegă de proiect");
    // The address book's names and order, and the push name a message carried, each where the service kept them.
    const named = (jid) => {
      const { name, notify, pushName, listed } = db.identity.contact(jid);
      return { name, notify, pushName, listed };
    };
    assert.deepEqual(named(ANA), { name: "Ana Pop", notify: null, pushName: "Ana", listed: 1 });
    assert.deepEqual(named("40700000005@s.whatsapp.net"), { name: null, notify: "Dana", pushName: null, listed: 3 });
    assert.equal(named(BOGDAN).listed, 2);
    assert.equal(db.identity.handled(ANA).askSid, r.a4);

    assert.deepEqual(db.messages.reactions(r.g1).map((x) => [x.jid, x.emoji]), [[ANA, "👍"]]);
    assert.deepEqual(db.messages.reactions(r.beta2).map((x) => [x.jid, x.emoji]), [[ANA, "❤️"]], "the beta's reactions come with its rows");
    assert.deepEqual(db.messages.votes(r.poll).map((x) => JSON.parse(x.choice)), [["Cluj"]]);
    assert.equal(db.messages.get(r.orphanVote)?.text, "[vote on a poll that is not loaded]", "a vote no poll opens stays a line, as in the service");
    assert.equal(db.messages.receipts(r.g3).length, 2);
    const voice = db.messages.get(r.voice);
    assert.equal(voice.transcript, "Te sun mai târziu");
    assert.deepEqual(voice.transcriptInfo, { provider: "local", at: 1789582271446 }, "the transcript's details come with it");
    assert.equal(voice.text, "[voice message · 0:42]");
    assert.equal(db.messages.get(r.callPlaceholder), null, "the call placeholder folds into the call log");
    assert.ok(db.messages.get(r.callLog));
    assert.ok(db.messages.get(r.synced), "a history-sync line imports like any other");
    assert.deepEqual(
      db.messages.receipts(r.syncedReceipts).map((x) => [x.jid, x.readAt]),
      [["40700000005@s.whatsapp.net", (fx.T - 70) * 1000]],
      "the receipts a synced message carries, the account's own device left out"
    );

    const story = db.messages.get(r.story);
    assert.equal(story.expiresAt, story.ts + 24 * 3_600_000, "a story lives a day");
    assert.equal(db.identity.chat(GROUP).name, "Echipa");
    assert.equal(db.identity.contact(ANA).name, "Ana Pop");
  } finally {
    db.close();
  }
});

test("recall vectors import only where the words still match, index-only rows become text-only messages", async () => {
  const fx = await buildLegacyAccount();
  const db = openDb(fx);
  try {
    const report = await run(fx, db, { verify: false });
    const recall = report.phases.recall;
    assert.equal(recall.imported, 5, "a1, g1, the index-only row, the voice note and the lid-spelled b1");
    assert.equal(recall.skipped.vectorMismatch, 1, "a2 was embedded before its edit");
    assert.equal(recall.skipped.hidden, 2, "a deleted and a revoked message");
    assert.equal(recall.skipped.malformed, 1);
    assert.equal(recall.details.indexOnlyRows, 1);

    const a1 = db.vectors.get(r.a1);
    assert.equal(a1.model, MODEL);
    assert.deepEqual([...a1.vector], [...vectorRow(0)]);
    assert.equal(db.vectors.get(r.a2), null);
    assert.ok(db.vectors.get(r.voice), "text and transcript together are what the index embedded");
    assert.ok(db.vectors.get(r.b1), "a lid spelling of the sid still finds the message");
    assert.equal(db.messages.get(r.dropped), null, "a del op takes the row out");

    const indexOnly = db.messages.get(r.indexOnly);
    assert.equal(indexOnly.raw, null);
    assert.equal(indexOnly.text, "Mesaj vechi rămas doar în index");
    assert.ok(db.vectors.get(r.indexOnly));
    const backlog = db.vectors.backlog({ model: MODEL, limit: 100 });
    assert.ok(backlog.items.some((item) => item.sid === r.a2), "the mismatched message waits in the backlog to be embedded again");
    assert.equal(backlog.items.some((item) => item.sid === r.a1), false);
    assert.equal(contentHash(indexOnly.text, indexOnly.transcript), contentHash("Mesaj vechi rămas doar în index", null));
  } finally {
    db.close();
  }
});

for (const [label, tear] of [
  // Vectors appended and meta not: every later row would pair with its neighbour's vector.
  ["vectors.bin one row longer than meta.jsonl says", (dir) => appendFileSync(join(dir, "vectors.bin"), Buffer.alloc(DIMS, 1))],
  // A rewrite that got as far as the meta: a row points past the vectors.
  ["a meta row past the end of vectors.bin", (dir) => appendFileSync(join(dir, "meta.jsonl"), `${JSON.stringify({ op: "put", sid: r.a4, jid: ANA, ts: 1, sender: ANA, type: "text", text: "x", model: MODEL, row: 99 })}\n`)],
  ["vectors.bin cut in the middle of a row", (dir) => {
    const path = join(dir, "vectors.bin");
    writeFileSync(path, readFileSync(path).subarray(0, -3));
  }],
]) {
  test(`a torn recall index — ${label} — imports its text rows and no vector, and says so`, async () => {
    const fx = await buildLegacyAccount();
    tear(join(fx.paths.root, "recall"));
    const db = openDb(fx);
    try {
      const report = await run(fx, db, { verify: false });
      assert.equal(db.vectors.count(), 0, "no vector is trusted when meta and vectors disagree");
      assert.equal(report.phases.recall.imported, 0);
      assert.equal(report.phases.recall.details.vectorsDiscarded, 1);
      assert.equal(db.messages.get(r.indexOnly).text, "Mesaj vechi rămas doar în index", "the words only the index had still come");
      assert.ok(db.vectors.backlog({ model: MODEL, limit: 100 }).items.some((item) => item.sid === r.a1), "everything waits to be embedded again");
    } finally {
      db.close();
    }
  });
}

test("malformed lines and a torn tail are reported, not fatal; a timestamp days ahead is left out", async () => {
  const fx = await buildLegacyAccount();
  const db = openDb(fx);
  try {
    const report = await run(fx, db, { verify: false });
    assert.equal(report.phases.history.skipped.malformed, 2);
    assert.equal(report.phases.history.details.partialTails, 1);
    assert.deepEqual(
      report.malformedFiles.map((entry) => [entry.file, entry.lines, entry.partialTail]).sort(),
      [
        [`${BOGDAN}.jsonl`, 1, false],
        [`${GROUP}.jsonl`, 1, true],
      ].sort()
    );
    assert.equal(report.phases.history.skipped.futureTs, 1);
    assert.equal(db.messages.get(r.future, { includeHidden: true }), null);
  } finally {
    db.close();
  }
});

test("a verification copy a crash left behind is removed before the next one", async () => {
  const fx = await buildLegacyAccount();
  const stale = join(fx.dataDir, "accounts", "default", ".legacy-verify-stale");
  mkdirSync(join(stale, "accounts", "default", "history"), { recursive: true });
  writeFileSync(join(stale, "accounts", "default", "store.json"), "{}");
  const db = openDb(fx);
  try {
    const report = await run(fx, db);
    assert.equal(report.state, "done");
    assert.equal(existsSync(stale), false);
  } finally {
    db.close();
  }
});

test("a finished import is a no-op the second time", async () => {
  const fx = await buildLegacyAccount();
  const db = openDb(fx);
  try {
    const first = await run(fx, db);
    assert.equal(first.state, "done");
    const rows = dump(db.path);
    const again = await run(fx, db);
    assert.equal(again.alreadyDone, true);
    assert.equal(again.state, "done");
    assert.deepEqual(dump(db.path), rows);
  } finally {
    db.close();
  }
});

test("an import cut off at any chunk resumes into the same database", async () => {
  const fx = await buildLegacyAccount();
  const options = { verify: false, chunkSize: 2 };
  const dbOptions = {};

  const phases = [];
  const clean = openDb(fx, { file: "wazap-clean.sqlite", db: dbOptions });
  try {
    await run(fx, clean, { ...options, afterChunk: ({ phase }) => void phases.push(phase) });
  } finally {
    clean.close();
  }
  const expected = dump(join(fx.dataDir, "accounts", "default", "wazap-clean.sqlite"));

  // The first chunk of every phase, one in the middle of each phase with several, and the very last.
  const points = new Set([phases.length]);
  for (const phase of IMPORT_PHASES) {
    const at = phases.flatMap((name, i) => (name === phase ? [i + 1] : []));
    if (at.length > 0) points.add(at[0]);
    if (at.length > 2) points.add(at[Math.floor(at.length / 2)]);
  }
  for (const point of [...points].sort((a, b) => a - b)) {
    const file = `wazap-crash-${point}.sqlite`;
    let db = openDb(fx, { file, db: dbOptions });
    await assert.rejects(
      run(fx, db, {
        ...options,
        afterChunk: ({ chunks }) => {
          if (chunks === point) db.close();
        },
      }),
      /closed/i,
      `cut at chunk ${point}`
    );
    db = openDb(fx, { file, db: dbOptions });
    try {
      // The resumed run keeps the first run's rules even when told otherwise.
      const report = await run(fx, db, { ...options, retention: true });
      assert.equal(report.runs, 2);
      assert.equal(report.state, "imported");
    } finally {
      db.close();
    }
    assert.deepEqual(dump(join(fx.dataDir, "accounts", "default", file)), expected, `resumed after chunk ${point} (${phases[point - 1]})`);
  }
});

test("a beta archive of another account is left alone, and so is one no linked account can claim", async () => {
  for (const variant of [{ betaOwner: "40799999999@s.whatsapp.net" }, { linked: false }]) {
    const fx = await buildLegacyAccount(variant);
    const db = openDb(fx);
    try {
      const report = await run(fx, db);
      assert.equal(report.phases.beta.imported, 0);
      assert.equal(report.phases.beta.skipped.ownerMismatch, report.phases.beta.read);
      assert.ok(report.phases.beta.read > 0);
      assert.equal(db.messages.get(r.beta1), null);
      assert.ok(db.messages.get(r.b2), "the beta's deletions do not apply either");
      assert.equal(report.state, "done", JSON.stringify(report.verification.samples));
      assert.equal(report.owner, variant.linked === false ? null : ME);
      assert.equal(db.getMeta("owner"), variant.linked === false ? null : ME);
    } finally {
      db.close();
    }
  }
});

test("the import records the beta archive it took, and a number that links afterwards imports it on its own", async () => {
  const linked = await buildLegacyAccount();
  const db = openDb(linked);
  try {
    await run(linked, db);
    const [recorded] = JSON.parse(db.getMeta("beta_imported"));
    assert.equal(recorded.owner, ME);
    assert.ok(recorded.rows > 0);
  } finally {
    db.close();
  }

  const fx = await buildLegacyAccount({ linked: false });
  const late = openDb(fx);
  try {
    assert.equal((await run(fx, late)).state, "done");
    assert.equal(late.getMeta("beta_imported"), null, "skipped as nobody's: nothing proves it was imported");
    const archive = join(fx.dataDir, "archive.sqlite");
    const args = { dataDir: fx.dataDir, accountId: "default", accountPaths: fx.paths, db: late, betaArchive: archive, options: { now: () => fx.now } };
    assert.deepEqual(await importBetaArchive(args), { outcome: "unlinked" });
    mkdirSync(fx.paths.authDir, { recursive: true });
    writeFileSync(join(fx.paths.authDir, "creds.json"), JSON.stringify({ me: { id: "40799999999:3@s.whatsapp.net" } }));
    assert.deepEqual(await importBetaArchive(args), { outcome: "other-owner" });
    writeFileSync(join(fx.paths.authDir, "creds.json"), JSON.stringify({ me: { id: "40700000001:3@s.whatsapp.net" } }));
    const result = await importBetaArchive(args);
    assert.equal(result.outcome, "imported");
    assert.ok(result.phases.beta.imported > 0);
    assert.equal(late.messages.get(r.beta1).text, "Mesaj din arhiva beta");
    assert.equal(late.messages.get(r.a3), null, "the barriers the first import stored still hold");
    assert.equal(JSON.parse(late.getMeta("beta_imported"))[0].owner, ME);
    assert.equal(late.getMeta("import_beta_progress"), null);
    assert.equal(late.getMeta("owner"), ME);
    assert.equal(late.getMeta("import_state"), "done", "the account's import is not reopened");
    assert.deepEqual(await importBetaArchive(args), { outcome: "already" });
  } finally {
    late.close();
  }
});

test("with WAZAP_RETENTION on, deadlines carry over and a message past its own never enters", async () => {
  const fx = await buildLegacyAccount({ retention: true });
  const db = openDb(fx);
  try {
    const report = await run(fx, db, { retention: true });
    assert.equal(report.state, "done", JSON.stringify(report.verification.samples));
    const ephemeral = db.messages.get(r.ephemeral);
    assert.equal(ephemeral.expiresAt, ephemeral.ts + 7 * 86_400_000);
    assert.equal(db.messages.get(r.expired), null);
    assert.equal(db.messages.get(r.ghost), null, "with retention on, the beta's expiry is honoured");
  } finally {
    db.close();
  }
  const off = await buildLegacyAccount();
  const plain = openDb(off);
  try {
    await run(off, plain, { verify: false });
    assert.equal(plain.messages.get(r.ephemeral).expiresAt, null, "without it, nothing expires, as in the service");
    assert.ok(plain.messages.get(r.expired));
  } finally {
    plain.close();
  }
});

test("verification names the keys of a difference nothing explains", async () => {
  const fx = await buildLegacyAccount();
  const db = openDb(fx);
  try {
    await run(fx, db, { verify: false });
    db.messages.delete(r.a1);
    db.identity.setNote(ANA, "altceva");
    const report = await verifyLegacyImport({
      dataDir: fx.dataDir,
      accountId: "default",
      accountPaths: fx.paths,
      db,
      options: { now: () => fx.now },
    });
    assert.equal(report.ok, false);
    assert.equal(report.unexpected.missingInDb, 1);
    assert.deepEqual(report.samples.missingInDb, [r.a1]);
    assert.equal(report.unexpected.notesMismatch, 1);
    assert.deepEqual(report.samples.notesMismatch, [ANA]);
    assert.equal(JSON.stringify(report).includes("Salut, ce mai faci"), false, "keys and counts, never words");
  } finally {
    db.close();
  }
});
