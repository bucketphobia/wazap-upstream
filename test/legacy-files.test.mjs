/**
 * The legacy files after the import: moved into legacy/ once the database
 * holds them (and again after a crash between two renames), deleted a week
 * later or at once under WAZAP_RETENTION=1, never when the import is
 * unverified, never what wazap did not move, never through a link; a beta
 * archive retired only once imported for its number, imported late when the
 * number links after the upgrade; set-aside databases given back to their
 * number and deleted only when nobody links it; a logout that binds the
 * database and deletes none of it; and what `wazap status` and `get_status`
 * say about all of it, with a server holding the database and without one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { renderGetStatus } from "../dist/account-resolve.js";
import { AccountRegistry } from "../dist/accounts.js";
import { accountPaths } from "../dist/config.js";
import { AccountDb } from "../dist/db/index.js";
import { sqlite } from "../dist/db/sqlite.js";
import {
  LEGACY_TTL_MS,
  legacySchedule,
  moveAccountLegacy,
  purgeAccountLegacy,
  purgePreviousOwners,
  settleBetaArchive,
} from "../dist/legacy-files.js";
import { accountStorage } from "../dist/storage-status.js";
import { logoutAccount } from "../dist/logout.js";
import { socketFactory } from "../dist/pairing.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { ANA, ME, buildLegacyAccount } from "./legacy-fixtures.mjs";
import { BINARY, childEnv, connectedService, fakeSocket, stubAccountSource } from "./helpers.mjs";

const run = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;
const OTHER = "40799999999@s.whatsapp.net";
const LEGACY_NAMES = ["history", "notes.json", "recall", "retention.json", "store.json"];
const A1 = `false_${ANA}_A1`;
const BETA1 = `false_${ANA}_BETA1`;

function serviceOn(dataDir, config = {}) {
  return connectedService(WhatsAppService, {
    prefix: "wazap-legacy-files-",
    id: ME,
    name: "Răzvan",
    config: { dataDir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0, ...config },
  }).svc;
}

/** Every file and folder under `path` dated `at`: the fixture written "at the clock it was written at". */
function dateTree(path, at) {
  if (!existsSync(path)) return;
  if (fs.lstatSync(path).isDirectory()) for (const name of readdirSync(path)) dateTree(join(path, name), at);
  utimesSync(path, at / 1000, at / 1000);
}

/** The legacy account, its files dated a minute before its clock. */
async function legacyAccount(options) {
  const fx = await buildLegacyAccount(options);
  for (const name of [...LEGACY_NAMES, "archive.sqlite"]) dateTree(join(fx.paths.root, name), fx.now - 60_000);
  dateTree(join(fx.dataDir, "archive.sqlite"), fx.now - 60_000);
  return fx;
}

const PREVIOUS_OWNER = /^wazap\.(\d+)\.previous-owner\.sqlite(?:-wal|-shm)?$/;

/**
 * Date the databases a boot set aside by the moment their own names carry. The
 * boot ran on `at`, but the filesystem stamped what it wrote with the machine's
 * clock, and a set-aside database's week is the later of its name and its mtime
 * — so once the machine passes the fixture's dates the week never ends.
 */
function dateAsides(root) {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const match = PREVIOUS_OWNER.exec(name);
    if (match === null) continue;
    utimesSync(join(root, name), Number(match[1]) / 1000, Number(match[1]) / 1000);
  }
}

/** Boots a service on the data dir at `at` and stops it: what one start of the server does to the files. */
async function bootAt(t, dataDir, at, config = {}, claim = undefined) {
  t.mock.method(Date, "now", () => at);
  const svc = serviceOn(dataDir, config);
  if (claim !== undefined) await svc.storage.claimDatabase(claim);
  await svc.bootStorage();
  await svc.stop();
  t.mock.restoreAll();
  dateAsides(accountPaths(dataDir, "default").root);
  return svc;
}

function withDb(dbPath, read) {
  const db = AccountDb.open(dbPath, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const readMeta = (dbPath, key) => withDb(dbPath, (db) => db.getMeta(key));

function link(paths, jid) {
  mkdirSync(paths.authDir, { recursive: true });
  writeFileSync(join(paths.authDir, "creds.json"), JSON.stringify({ me: { id: jid.replace("@", ":3@"), name: "R" } }));
}

/** A database set aside for `owner`, dated `at` by name and mtime. */
function setAside(root, owner, at) {
  const file = join(root, `wazap.${at}.previous-owner.sqlite`);
  const db = AccountDb.open(file);
  db.bindOwner(owner);
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`${file}${suffix}`)) utimesSync(`${file}${suffix}`, at / 1000, at / 1000);
  return file;
}

/**
 * A 0.15-beta archive with the tables its identity reads, dated `at` like every
 * other fixture file. An archive's week counts from its mtime, and the mtime a
 * write leaves is the machine's — so an archive written now and settled against
 * a fixed `now` is read on two clocks, and once the machine passes that date its
 * week never ends.
 */
function betaArchive(path, owner, rows, at) {
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE messages(sid TEXT PRIMARY KEY, ts INTEGER NOT NULL)");
  db.prepare("INSERT INTO meta VALUES('owner', ?)").run(owner);
  for (let i = 0; i < rows; i++) db.prepare("INSERT INTO messages VALUES(?, ?)").run(`s${i}`, 1_000 + i);
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`${path}${suffix}`)) utimesSync(`${path}${suffix}`, at / 1000, at / 1000);
  return { owner, rows, lastTs: rows === 0 ? null : 1_000 + rows - 1 };
}

function status(dataDir, env = {}) {
  return run(process.execPath, [BINARY, "status", "--json", "--data-dir", dataDir], {
    env: childEnv({ WAZAP_TRANSCRIBE: "off", WAZAP_WEBHOOK: "off", ...env }),
  }).then(({ stdout }) => JSON.parse(stdout));
}

function statusText(dataDir, env = {}) {
  return run(process.execPath, [BINARY, "status", "--data-dir", dataDir], {
    env: childEnv({ WAZAP_TRANSCRIBE: "off", WAZAP_WEBHOOK: "off", ...env }),
  }).then(({ stderr }) => stderr);
}

function unlinkSockets(t) {
  const original = socketFactory.open;
  socketFactory.open = () => {
    const sock = fakeSocket();
    sock.logout = async () => sock.end();
    setImmediate(() => sock.ev.emit("connection.update", { connection: "open" }));
    return sock;
  };
  t.after(() => (socketFactory.open = original));
}

test("the boot that imports an account moves its legacy files and the beta archive aside, deletes nothing, and a later boot moves nothing", async (t) => {
  const fx = await legacyAccount();
  const legacy = join(fx.paths.root, "legacy");
  await bootAt(t, fx.dataDir, fx.now);

  assert.deepEqual(readdirSync(legacy).sort(), LEGACY_NAMES);
  assert.equal(statSync(legacy).mode & 0o777, 0o700);
  for (const name of LEGACY_NAMES) assert.equal(existsSync(join(fx.paths.root, name)), false, `${name} left its place`);
  assert.equal(readdirSync(join(legacy, "history")).length > 0, true, "the history came whole");
  assert.equal(existsSync(join(fx.paths.authDir, "creds.json")), true, "the credentials are the service's own");
  assert.equal(existsSync(join(fx.dataDir, "archive.sqlite")), false);
  assert.equal(existsSync(join(fx.dataDir, "legacy", "archive.sqlite")), true, "the archive of the linked number moved aside");
  assert.equal(Math.round(statSync(join(fx.dataDir, "legacy", "archive.sqlite")).mtimeMs), fx.now, "its week counts from the move");
  const dbPath = join(fx.paths.root, "wazap.sqlite");
  assert.equal(readMeta(dbPath, "legacy_moved_at"), String(fx.now));
  assert.deepEqual(JSON.parse(readMeta(dbPath, "legacy_entries")), { dir: "legacy", names: ["store.json", "history", "retention.json", "notes.json", "recall"] });
  assert.equal(readMeta(dbPath, "legacy_keep"), null);
  assert.equal(readMeta(dbPath, "legacy_deleted_at"), null);
  assert.equal(JSON.parse(readMeta(dbPath, "beta_imported"))[0].owner, ME, "the import recorded the archive it took");

  const svc = serviceOn(fx.dataDir);
  t.after(() => svc.stop());
  await svc.bootStorage();
  assert.deepEqual(moveAccountLegacy(fx.paths.root, svc.db, fx.now + DAY), { moved: 0, recorded: false });
  assert.deepEqual(readdirSync(legacy).sort(), LEGACY_NAMES, "nothing doubled, nothing renamed");
  assert.equal(svc.db.getMeta("legacy_moved_at"), String(fx.now));
  assert.ok((await svc.readMessages(ANA, 10)).data.length > 0, "the database serves without them");
  assert.equal(svc.getStatus().storage.state, "ready");
  assert.match(svc.getStatus().storage.legacy_files.deleted_after, /^\d{4}-\d{2}-\d{2}T/);
  const rendered = renderGetStatus(svc.getStatus(), false, stubAccountSource(svc));
  assert.match(rendered.content[0].text, /- \*\*storage\*\*: ready; earlier message files deleted after \d{4}-\d{2}-\d{2}T/);
  assert.equal(svc.storage.legacyTimer.hasRef(), false, "the daily pass does not keep the process alive");
  await svc.stop();
  assert.equal(svc.storage.legacyTimer, null);
});

test("a stopped service's get_status repeats the storage it last reported, not a failure", async (t) => {
  const fx = await legacyAccount();
  t.mock.method(Date, "now", () => fx.now);
  const svc = serviceOn(fx.dataDir);
  await svc.bootStorage();
  const running = svc.getStatus().storage;
  await svc.stop();
  const stopped = svc.getStatus();
  assert.deepEqual(stopped.storage, running);
  assert.doesNotMatch(renderGetStatus(stopped, false, stubAccountSource(svc)).content[0].text, /storage\*\*: failed/);
});

test("a crash between two renames leaves every destination recorded, and the next pass moves the rest", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wazap-legacy-crash-"));
  mkdirSync(join(root, "history"));
  writeFileSync(join(root, "history", "chat.jsonl"), "{}\n");
  mkdirSync(join(root, "recall"));
  for (const name of ["store.json", "retention.json", "notes.json", "notes.json.tmp"]) writeFileSync(join(root, name), "{}");
  dateTree(root, 500);
  const db = AccountDb.open(join(root, "wazap.sqlite"));
  t.after(() => db.close());
  assert.deepEqual(moveAccountLegacy(root, db, 1_000), { moved: 0, recorded: false }, "nothing moves before the import is done");
  db.setMeta("import_state", "running");
  assert.deepEqual(moveAccountLegacy(root, db, 1_000), { moved: 0, recorded: false }, "nor while it runs: a resumed import reads them");
  db.setMeta("import_state", "skipped");
  assert.deepEqual(moveAccountLegacy(root, db, 1_000), { moved: 0, recorded: false }, "nor another number's files");
  db.setMeta("import_state", "done");

  const rename = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, "renameSync", function (...args) {
    if (++calls === 3) throw Object.assign(new Error("simulated crash"), { code: "EIO" });
    return rename.apply(this, args);
  });
  syncBuiltinESMExports();
  assert.throws(() => moveAccountLegacy(root, db, 2_000), { code: "EIO" });
  t.mock.restoreAll();
  syncBuiltinESMExports();

  assert.equal(readdirSync(join(root, "legacy")).length, 2, "two entries moved before the crash");
  assert.equal(db.getMeta("legacy_moved_at"), null, "the move is not recorded half-done");
  assert.equal(JSON.parse(db.getMeta("legacy_plan")).moves.length, 6, "but every destination is");
  assert.equal(purgeAccountLegacy(root, db, 2_000 + 30 * DAY, true), null, "and nothing half-moved is deleted");

  assert.deepEqual(moveAccountLegacy(root, db, 3_000), { moved: 4, recorded: true });
  assert.deepEqual(readdirSync(join(root, "legacy")).sort(), ["history", "notes.json", "notes.json.tmp", "recall", "retention.json", "store.json"]);
  assert.deepEqual(readdirSync(root).sort(), ["legacy", "wazap.sqlite", "wazap.sqlite-shm", "wazap.sqlite-wal"]);
  assert.equal(db.getMeta("legacy_moved_at"), "3000");
  assert.equal(JSON.parse(db.getMeta("legacy_entries")).names.length, 6, "the two moved before the crash are recorded too");
  assert.equal(db.getMeta("legacy_plan"), null);
  assert.equal(purgeAccountLegacy(root, db, 3_000 + LEGACY_TTL_MS, false), 6);
  assert.deepEqual(readdirSync(root).sort(), ["wazap.sqlite", "wazap.sqlite-shm", "wazap.sqlite-wal"]);
});

test("only what wazap moved is deleted: a legacy/ someone made keeps its own files, and a legacy that is not a folder is left alone", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wazap-legacy-mine-"));
  mkdirSync(join(root, "legacy"));
  writeFileSync(join(root, "legacy", "mine.txt"), "kept");
  writeFileSync(join(root, "store.json"), "{}");
  const db = AccountDb.open(join(root, "wazap.sqlite"));
  t.after(() => db.close());
  db.setMeta("import_state", "done");
  assert.deepEqual(moveAccountLegacy(root, db, 1_000), { moved: 1, recorded: true });
  assert.equal(purgeAccountLegacy(root, db, 1_000, true), 1);
  assert.deepEqual(readdirSync(join(root, "legacy")), ["mine.txt"], "the user's file and its folder stay");

  // Nothing moved into an existing folder: nothing is scheduled, and the folder is never deleted.
  const bare = mkdtempSync(join(tmpdir(), "wazap-legacy-mine-"));
  mkdirSync(join(bare, "legacy"));
  writeFileSync(join(bare, "legacy", "mine.txt"), "kept");
  const empty = AccountDb.open(join(bare, "wazap.sqlite"));
  t.after(() => empty.close());
  empty.setMeta("import_state", "done");
  assert.deepEqual(moveAccountLegacy(bare, empty, 2_000), { moved: 0, recorded: true });
  assert.equal(legacySchedule(empty).deletedAt, 2_000);
  assert.equal(purgeAccountLegacy(bare, empty, 2_000 + 30 * DAY, true), null);
  assert.deepEqual(readdirSync(join(bare, "legacy")), ["mine.txt"]);

  // `legacy` taken by a file: the move goes to legacy-1, and the file is untouched.
  const taken = mkdtempSync(join(tmpdir(), "wazap-legacy-mine-"));
  writeFileSync(join(taken, "legacy"), "a file of the user's");
  writeFileSync(join(taken, "store.json"), "{}");
  const third = AccountDb.open(join(taken, "wazap.sqlite"));
  t.after(() => third.close());
  third.setMeta("import_state", "done");
  assert.deepEqual(moveAccountLegacy(taken, third, 3_000), { moved: 1, recorded: true });
  assert.deepEqual(readdirSync(join(taken, "legacy-1")), ["store.json"]);
  assert.equal(fs.readFileSync(join(taken, "legacy"), "utf8"), "a file of the user's");
  assert.equal(purgeAccountLegacy(taken, third, 3_000, true), 1);
  assert.equal(existsSync(join(taken, "legacy-1")), false);
  assert.equal(existsSync(join(taken, "legacy")), true);
});

test("a legacy entry that is a link is never moved or deleted, and status names it", (t) => {
  const base = mkdtempSync(join(tmpdir(), "wazap-legacy-link-"));
  const outside = join(base, "outside-history");
  mkdirSync(outside);
  writeFileSync(join(outside, "chat.jsonl"), "{}\n");
  const dataDir = join(base, "data");
  const root = accountPaths(dataDir, "default").root;
  mkdirSync(root, { recursive: true });
  symlinkSync(outside, join(root, "history"));
  writeFileSync(join(root, "store.json"), "{}");
  const db = AccountDb.open(join(root, "wazap.sqlite"));
  db.setMeta("import_state", "done");
  assert.deepEqual(moveAccountLegacy(root, db, 1_000), { moved: 1, recorded: true });
  assert.equal(purgeAccountLegacy(root, db, 1_000, true), 1);
  db.close();
  assert.equal(fs.lstatSync(join(root, "history")).isSymbolicLink(), true, "the link stays where it is");
  assert.deepEqual(readdirSync(outside), ["chat.jsonl"], "and what it points at is untouched");
  const report = accountStorage(dataDir, "default", false);
  assert.deepEqual(report.links, ["history"]);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
});

test("the week counts from the later of the move and the entries' own mtimes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wazap-legacy-clock-"));
  mkdirSync(join(root, "history"));
  writeFileSync(join(root, "history", "chat.jsonl"), "{}\n");
  dateTree(join(root, "history"), 10 * DAY);
  utimesSync(join(root, "history", "chat.jsonl"), (20 * DAY) / 1000, (20 * DAY) / 1000);
  const db = AccountDb.open(join(root, "wazap.sqlite"));
  t.after(() => db.close());
  db.setMeta("import_state", "done");
  // A clock behind the files' own: the week starts at the newest file, not at the wrong now.
  moveAccountLegacy(root, db, 5 * DAY);
  assert.equal(db.getMeta("legacy_moved_at"), String(20 * DAY));
  assert.equal(purgeAccountLegacy(root, db, 5 * DAY + LEGACY_TTL_MS, false), null);
  assert.equal(purgeAccountLegacy(root, db, 20 * DAY + LEGACY_TTL_MS, false), 1);
});

test("an import a stop cut off keeps every legacy file where the next boot resumes from, and moves them once it is done", async (t) => {
  const fx = await legacyAccount();
  t.mock.method(Date, "now", () => fx.now);
  const first = serviceOn(fx.dataDir);
  const booting = first.bootStorage().catch(() => {});
  for (let turns = 0; first.storage.accountDb.getMeta("import_state") !== "running"; turns++) {
    assert.ok(turns < 10_000, "the import started");
    await new Promise((resolve) => setImmediate(resolve));
  }
  await first.stop();
  await booting;
  for (const name of LEGACY_NAMES) assert.equal(existsSync(join(fx.paths.root, name)), true, `${name} is still in place`);
  assert.equal(existsSync(join(fx.paths.root, "legacy")), false);
  assert.equal(existsSync(join(fx.dataDir, "archive.sqlite")), true);

  const next = serviceOn(fx.dataDir);
  t.after(() => next.stop());
  await next.bootStorage();
  assert.equal(next.db.getMeta("import_state"), "done");
  assert.deepEqual(readdirSync(join(fx.paths.root, "legacy")).sort(), LEGACY_NAMES);
  assert.equal(existsSync(join(fx.dataDir, "legacy", "archive.sqlite")), true);
});

test("a week after the move the legacy files and the beta archive are deleted, a day before nothing is, and a set-aside database waits for its own week", async (t) => {
  const fx = await legacyAccount();
  await bootAt(t, fx.dataDir, fx.now);
  const aside = setAside(fx.paths.root, OTHER, fx.now + 2 * DAY);

  await bootAt(t, fx.dataDir, fx.now + 6 * DAY);
  assert.deepEqual(readdirSync(join(fx.paths.root, "legacy")).sort(), LEGACY_NAMES);
  assert.equal(existsSync(join(fx.dataDir, "legacy", "archive.sqlite")), true);

  const logged = [];
  t.mock.method(process.stderr, "write", (chunk) => {
    logged.push(String(chunk));
    return true;
  });
  await bootAt(t, fx.dataDir, fx.now + 8 * DAY);
  assert.equal(existsSync(join(fx.paths.root, "legacy")), false);
  assert.equal(existsSync(join(fx.dataDir, "legacy")), false, "the archive and its folder are gone");
  assert.equal(existsSync(aside), true, "set aside two days later, it has five days left");
  assert.equal(existsSync(join(fx.paths.root, "wazap.sqlite")), true, "the database is not a legacy file");
  assert.equal(readMeta(join(fx.paths.root, "wazap.sqlite"), "legacy_deleted_at"), String(fx.now + 8 * DAY));
  const lines = logged.join("");
  assert.match(lines, /deleted 5 earlier message files from legacy\//);
  assert.match(lines, /deleted 1 beta archive\(s\)/);
  assert.equal(/Salut|40700000002/.test(lines), false, "counts, never contents or numbers");

  await bootAt(t, fx.dataDir, fx.now + 10 * DAY);
  assert.equal(existsSync(aside), false, "nobody links its number: gone after its week");

  const svc = serviceOn(fx.dataDir);
  t.after(() => svc.stop());
  await svc.bootStorage();
  assert.equal((await svc.getMessage(A1)).text, "Salut, ce mai faci azi?", "what was imported stays");
  assert.equal((await svc.getMessage(BETA1)).text, "Mesaj din arhiva beta");
  assert.equal(svc.getStatus().storage.legacy_files, undefined);
});

test("a set-aside database is kept past its week while its number is linked or its owner unreadable, and WAZAP_RETENTION does not shorten it", () => {
  const root = mkdtempSync(join(tmpdir(), "wazap-legacy-aside-"));
  const old = setAside(root, OTHER, 1_000_000);
  const linked = setAside(root, ME, 1_000_001);
  const touched = setAside(root, OTHER, 2_000_000);
  // Named long ago, written to recently: the recent write decides.
  utimesSync(touched, (2_000_000 + 5 * DAY) / 1000, (2_000_000 + 5 * DAY) / 1000);
  const unreadable = join(root, "wazap.1000002.previous-owner.sqlite");
  writeFileSync(unreadable, "not a database");
  utimesSync(unreadable, 1_000, 1_000);
  assert.equal(purgePreviousOwners(root, 1_000_000 + LEGACY_TTL_MS - 1, new Set()), 0);
  assert.equal(purgePreviousOwners(root, 2_000_000 + LEGACY_TTL_MS, new Set([ME])), 1);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(linked), true, "its number is linked to an enabled account");
  assert.equal(existsSync(unreadable), true, "whose it is cannot be read");
  assert.equal(existsSync(touched), true);
  assert.equal(purgePreviousOwners(root, 2_000_000 + 5 * DAY + LEGACY_TTL_MS, new Set()), 2);
  assert.deepEqual(readdirSync(root), ["wazap.1000002.previous-owner.sqlite"]);
});

test("with WAZAP_RETENTION=1 the legacy files and the beta archive go at the boot that moves them; a set-aside database does not", async (t) => {
  const fx = await legacyAccount({ retention: true });
  const aside = setAside(fx.paths.root, OTHER, fx.now);
  await bootAt(t, fx.dataDir, fx.now, { retention: true });
  assert.equal(existsSync(join(fx.paths.root, "legacy")), false);
  for (const name of LEGACY_NAMES) assert.equal(existsSync(join(fx.paths.root, name)), false);
  assert.equal(existsSync(join(fx.dataDir, "archive.sqlite")), false);
  assert.equal(existsSync(join(fx.dataDir, "legacy")), false);
  assert.equal(existsSync(aside), true);
  assert.equal(readMeta(join(fx.paths.root, "wazap.sqlite"), "import_state"), "done");
});

test("an unverified import's legacy files are moved and kept, whatever the clock and WAZAP_RETENTION say", async (t) => {
  const fx = await legacyAccount();
  t.mock.method(Date, "now", () => fx.now);
  const first = serviceOn(fx.dataDir);
  first.storage.accountDb.messages.upsert({ chatJid: ANA, keyId: "STRAY", fromMe: false, ts: fx.T * 1000, type: "text", text: "stray" });
  await first.bootStorage();
  assert.equal(first.db.getMeta("import_state"), "imported");
  assert.equal(first.db.getMeta("legacy_keep"), "unverified");
  assert.deepEqual(first.getStatus().storage, { state: "imported-unverified", legacy_files: { kept: "unverified" } });
  await first.stop();
  t.mock.restoreAll();
  assert.deepEqual(readdirSync(join(fx.paths.root, "legacy")).sort(), LEGACY_NAMES);
  assert.equal(existsSync(join(fx.dataDir, "archive.sqlite")), true, "the archive waits for a verified import");

  await bootAt(t, fx.dataDir, fx.now + 60 * DAY, { retention: true });
  assert.deepEqual(readdirSync(join(fx.paths.root, "legacy")).sort(), LEGACY_NAMES);
  assert.equal(existsSync(join(fx.dataDir, "archive.sqlite")), true);

  const report = await status(fx.dataDir);
  const account = report.storage.accounts[0];
  assert.equal(account.state, "imported-unverified");
  assert.deepEqual(account.unverified.unexpected, { extraInDb: 1 });
  assert.equal(account.legacy.state, "kept-unverified");
  assert.deepEqual(report.storage.beta_archive.waiting_for, ["default"]);
  const kept = report.checks.find((check) => check.name === "legacy files");
  assert.equal(kept.state, "warn");
  assert.equal(kept.fix, `once the account reads right, delete them yourself: \`rm -rf ${join(fx.paths.root, "legacy")}\``);
  assert.match(report.checks.find((check) => check.name === "storage").detail, /differences the check could not explain \(extraInDb 1\)/);
});

test("an account not linked at the upgrade imports the beta archive once its number links, and only then is the archive retired", async (t) => {
  const fx = await legacyAccount({ linked: false });
  await bootAt(t, fx.dataDir, fx.now);
  const dbPath = join(fx.paths.root, "wazap.sqlite");
  assert.equal(readMeta(dbPath, "import_state"), "done");
  assert.equal(readMeta(dbPath, "beta_imported"), null, "nothing proved the archive was this account's");
  assert.equal(existsSync(join(fx.dataDir, "archive.sqlite")), true, "so it stays where it is");

  link(fx.paths, ME);
  // Linked, not restarted yet: the daily pass still keeps an archive this database never imported.
  t.mock.method(Date, "now", () => fx.now + DAY);
  const running = serviceOn(fx.dataDir);
  running.storage.accountDb.setMeta("import_state", "done");
  assert.equal(settleBetaArchive(fx.dataDir, fx.now + DAY, true).moved, false);
  await running.stop();
  t.mock.restoreAll();

  await bootAt(t, fx.dataDir, fx.now + DAY);
  assert.equal(withDb(dbPath, (db) => db.messages.get(BETA1)?.text), "Mesaj din arhiva beta", "imported at the next start");
  assert.equal(JSON.parse(readMeta(dbPath, "beta_imported"))[0].owner, ME);
  assert.equal(readMeta(dbPath, "import_beta_progress"), null);
  assert.equal(existsSync(join(fx.dataDir, "archive.sqlite")), false);
  assert.equal(existsSync(join(fx.dataDir, "legacy", "archive.sqlite")), true);

  await bootAt(t, fx.dataDir, fx.now + 9 * DAY);
  assert.equal(existsSync(join(fx.dataDir, "legacy")), false);
  assert.equal(withDb(dbPath, (db) => db.messages.get(BETA1) !== null), true, "its rows outlive it");
});

test("a beta archive no enabled account is linked to stays where it is, and says so", async (t) => {
  const fx = await legacyAccount({ betaOwner: OTHER });
  await bootAt(t, fx.dataDir, fx.now);
  await bootAt(t, fx.dataDir, fx.now + 30 * DAY, { retention: true });
  assert.equal(existsSync(join(fx.dataDir, "archive.sqlite")), true);
  assert.equal(existsSync(join(fx.dataDir, "legacy")), false);

  const report = await status(fx.dataDir);
  assert.deepEqual(report.storage.beta_archive, {
    state: "in-place",
    path: join(fx.dataDir, "archive.sqlite"),
    bytes: report.storage.beta_archive.bytes,
    accounts: [],
    waiting_for: [],
    owner_readable: true,
    delete_after: null,
  });
  const check = report.checks.find((c) => c.name === "beta archive");
  assert.match(check.detail, /left in place: no enabled account is linked to its number/);
});

test("the beta archive waits for every enabled account linked to its number to have imported it, and no other", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-legacy-beta-"));
  const now = Date.UTC(2026, 8, 20);
  AccountRegistry.load(dataDir).save();
  for (const id of ["work", "spare"]) AccountRegistry.load(dataDir).add(id);
  const archive = join(dataDir, "archive.sqlite");
  const identity = betaArchive(archive, ME, 3, now);
  const account = (id, jid, meta) => {
    const paths = accountPaths(dataDir, id);
    link(paths, jid);
    const db = AccountDb.open(join(paths.root, "wazap.sqlite"));
    for (const [key, value] of Object.entries(meta)) db.setMeta(key, value);
    db.close();
  };
  account("default", ME, { import_state: "done", beta_imported: JSON.stringify([identity]) });
  account("work", OTHER, { import_state: "running" });
  account("spare", ME, { import_state: "done" });

  assert.deepEqual(settleBetaArchive(dataDir, now, false), { moved: false, deleted: 0 }, "spare is done but never took the archive");
  const spare = AccountDb.open(join(accountPaths(dataDir, "spare").root, "wazap.sqlite"));
  spare.setMeta("beta_imported", JSON.stringify([{ ...identity, rows: 2 }]));
  spare.close();
  assert.deepEqual(settleBetaArchive(dataDir, now, false), { moved: false, deleted: 0 }, "an archive with other rows is another archive");

  AccountRegistry.load(dataDir).disable("spare");
  assert.deepEqual(settleBetaArchive(dataDir, now, false), { moved: true, deleted: 0 }, "a disabled account is not waited for; work is another number");
  assert.equal(existsSync(join(dataDir, "legacy", "archive.sqlite")), true);
  assert.deepEqual(settleBetaArchive(dataDir, now + LEGACY_TTL_MS - 1, false), { moved: false, deleted: 0 });
  assert.deepEqual(settleBetaArchive(dataDir, now + LEGACY_TTL_MS, false), { moved: false, deleted: 1 });
  assert.equal(existsSync(join(dataDir, "legacy")), false);
});

test("an archive left in legacy/ does not block the next one: each moves under its own name and goes on its own week", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-legacy-leftover-"));
  const now = Date.UTC(2026, 8, 20);
  mkdirSync(join(dataDir, "legacy"));
  betaArchive(join(dataDir, "legacy", "archive.sqlite"), OTHER, 1, now - 3 * DAY);
  const identity = betaArchive(join(dataDir, "archive.sqlite"), ME, 2, now);
  link(accountPaths(dataDir, "default"), ME);
  const db = AccountDb.open(join(accountPaths(dataDir, "default").root, "wazap.sqlite"));
  db.setMeta("import_state", "done");
  db.setMeta("beta_imported", JSON.stringify([identity]));
  db.close();

  assert.deepEqual(settleBetaArchive(dataDir, now, false), { moved: true, deleted: 0 });
  assert.deepEqual(readdirSync(join(dataDir, "legacy")).sort(), [`archive.${now}.sqlite`, "archive.sqlite"]);
  assert.deepEqual(settleBetaArchive(dataDir, now + 4 * DAY, false), { moved: false, deleted: 1 }, "the old one's week is up");
  assert.deepEqual(readdirSync(join(dataDir, "legacy")), [`archive.${now}.sqlite`]);
  assert.deepEqual(settleBetaArchive(dataDir, now + LEGACY_TTL_MS, false), { moved: false, deleted: 1 });
  assert.equal(existsSync(join(dataDir, "legacy")), false);
});

test("a beta archive in the account folder is retired like the data dir's, once its account imported it", async (t) => {
  const fx = await legacyAccount();
  fs.renameSync(join(fx.dataDir, "archive.sqlite"), join(fx.paths.root, "archive.sqlite"));
  await bootAt(t, fx.dataDir, fx.now);
  const dbPath = join(fx.paths.root, "wazap.sqlite");
  assert.equal(withDb(dbPath, (db) => db.messages.get(BETA1) !== null), true);
  assert.equal(existsSync(join(fx.paths.root, "archive.sqlite")), false);
  assert.deepEqual(readdirSync(join(fx.paths.root, "legacy")).sort(), ["archive.sqlite", ...LEGACY_NAMES].sort());
  assert.equal(JSON.parse(readMeta(dbPath, "legacy_archives"))[0].name, "archive.sqlite");

  await bootAt(t, fx.dataDir, fx.now + 6 * DAY);
  assert.equal(existsSync(join(fx.paths.root, "legacy", "archive.sqlite")), true);
  await bootAt(t, fx.dataDir, fx.now + 8 * DAY);
  assert.equal(existsSync(join(fx.paths.root, "legacy")), false);
  assert.equal(readMeta(dbPath, "legacy_archives"), null);
});

test("the number linked before takes its set-aside database back, and the legacy week carries across both swaps", async (t) => {
  const fx = await legacyAccount();
  const root = fx.paths.root;
  const dbPath = join(root, "wazap.sqlite");
  await bootAt(t, fx.dataDir, fx.now);

  // Another number links by mistake: the history is set aside, the legacy record goes with the fresh database.
  await bootAt(t, fx.dataDir, fx.now + DAY, {}, OTHER);
  assert.equal(readMeta(dbPath, "owner"), OTHER);
  assert.equal(readMeta(dbPath, "import_state"), "skipped");
  assert.equal(readMeta(dbPath, "legacy_moved_at"), String(fx.now), "the week still counts from the move");
  assert.equal(withDb(dbPath, (db) => db.messages.get(A1)), null, "one person's history never shows under another's");
  assert.equal(readdirSync(root).filter((name) => name.endsWith(".previous-owner.sqlite")).length, 1);

  // The original number links again: its database is back, the other one set aside.
  await bootAt(t, fx.dataDir, fx.now + 2 * DAY, {}, ME);
  assert.equal(readMeta(dbPath, "owner"), ME);
  assert.equal(withDb(dbPath, (db) => db.messages.get(A1)?.text), "Salut, ce mai faci azi?");
  const asides = readdirSync(root).filter((name) => name.endsWith(".previous-owner.sqlite"));
  assert.deepEqual(asides, [`wazap.${fx.now + 2 * DAY}.previous-owner.sqlite`], "only the other number's database is set aside");
  assert.equal(readMeta(join(root, asides[0]), "owner"), OTHER);

  await bootAt(t, fx.dataDir, fx.now + 8 * DAY);
  assert.equal(existsSync(join(root, "legacy")), false, "deleted on the week the first move started");
  assert.equal(existsSync(join(root, asides[0])), true, "the other number's database has its own week");
  await bootAt(t, fx.dataDir, fx.now + 10 * DAY);
  assert.equal(existsSync(join(root, asides[0])), false);
  assert.equal(withDb(dbPath, (db) => db.messages.get(A1) !== null), true);
});

test("a database set aside in the same millisecond as an earlier one takes the next free name", async (t) => {
  const fx = await legacyAccount();
  await bootAt(t, fx.dataDir, fx.now);
  const earlier = setAside(fx.paths.root, "40788888888@s.whatsapp.net", fx.now + DAY);
  await bootAt(t, fx.dataDir, fx.now + DAY, {}, OTHER);
  assert.equal(readMeta(earlier, "owner"), "40788888888@s.whatsapp.net", "the earlier one is untouched");
  assert.equal(readMeta(join(fx.paths.root, `wazap.${fx.now + DAY + 1}.previous-owner.sqlite`), "owner"), ME);
});

test("a logout binds the database to its number before deleting the credentials, so a different number never imports its files", async (t) => {
  const fx = await legacyAccount({ beta: false });
  const dbPath = join(fx.paths.root, "wazap.sqlite");
  unlinkSockets(t);
  assert.equal(existsSync(dbPath), false, "the account never started on this version");
  assert.equal(await logoutAccount(fx.dataDir, "default", 2_000), "logged_out");
  assert.equal(existsSync(fx.paths.authDir), false);
  assert.equal(readMeta(dbPath, "owner"), ME);
  for (const name of LEGACY_NAMES) assert.equal(existsSync(join(fx.paths.root, name)), true, `${name} untouched`);

  link(fx.paths, OTHER);
  await bootAt(t, fx.dataDir, fx.now, {}, OTHER);
  assert.equal(readMeta(dbPath, "owner"), OTHER);
  assert.equal(readMeta(dbPath, "import_state"), "skipped");
  assert.equal(withDb(dbPath, (db) => db.counts().messages), 0, "none of the earlier number's messages");
  for (const name of LEGACY_NAMES) assert.equal(existsSync(join(fx.paths.root, name)), true, `${name} stays for its number`);
  assert.equal((await status(fx.dataDir)).checks.find((check) => check.name === "legacy files").detail.includes("imported if it links again"), true);

  link(fx.paths, ME);
  await bootAt(t, fx.dataDir, fx.now + DAY, {}, ME);
  assert.equal(readMeta(dbPath, "import_state"), "done", "the number back imports its own files");
  assert.equal(withDb(dbPath, (db) => db.messages.get(A1)?.text), "Salut, ce mai faci azi?");
  assert.deepEqual(readdirSync(join(fx.paths.root, "legacy")).sort(), LEGACY_NAMES);
});

test("a logout deletes the credentials only: the database and every legacy file stay untouched", async (t) => {
  const fx = await legacyAccount();
  await bootAt(t, fx.dataDir, fx.now);
  const dbPath = join(fx.paths.root, "wazap.sqlite");
  const before = { messages: withDb(dbPath, (db) => db.counts().messages), legacy: readdirSync(join(fx.paths.root, "legacy")).sort() };

  unlinkSockets(t);
  const watched = [join(fx.paths.root, "legacy"), join(fx.dataDir, "legacy")];
  const touched = [];
  for (const name of ["rmSync", "renameSync", "unlinkSync", "writeFileSync", "readFileSync", "openSync"]) {
    const fn = fs[name];
    t.mock.method(fs, name, function (path, ...rest) {
      if (typeof path === "string" && watched.some((prefix) => path.startsWith(prefix))) touched.push(`${name} ${path}`);
      return fn.call(this, path, ...rest);
    });
  }
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  assert.equal(await logoutAccount(fx.dataDir, "default", 2_000), "logged_out");
  t.mock.restoreAll();
  syncBuiltinESMExports();
  assert.deepEqual(touched, []);
  assert.equal(existsSync(fx.paths.authDir), false, "credentials deleted");
  assert.equal(withDb(dbPath, (db) => db.counts().messages), before.messages);
  assert.deepEqual(readdirSync(join(fx.paths.root, "legacy")).sort(), before.legacy);
  assert.equal(existsSync(join(fx.dataDir, "legacy", "archive.sqlite")), true);
});

test("status reports each account's storage read-only, with a server holding the database and with none, and creates nothing beside a closed one", async (t) => {
  const fx = await legacyAccount();
  await bootAt(t, fx.dataDir, fx.now);
  setAside(fx.paths.root, OTHER, fx.now);
  const sideFiles = () => readdirSync(fx.paths.root).filter((name) => /^wazap\.sqlite-(wal|shm)$/.test(name));
  assert.deepEqual(sideFiles(), [], "the stopped service closed its database cleanly");

  const stopped = await status(fx.dataDir, { WAZAP_RECALL: "local" });
  assert.deepEqual(sideFiles(), [], "status left no -wal or -shm beside it");
  assert.equal(stopped.server_pid, null);
  const account = stopped.storage.accounts[0];
  assert.equal(account.account, "default");
  assert.equal(account.state, "ready");
  assert.ok(account.counts.messages > 0 && account.counts.chats > 0);
  assert.ok(account.db_bytes > 0);
  assert.equal(typeof account.embedding_queue, "number", "recall on counts the queue");
  assert.equal(account.legacy.state, "moved");
  assert.equal(account.legacy.path, join(fx.paths.root, "legacy"));
  assert.equal(Date.parse(account.legacy.delete_after), fx.now - (fx.now % 1000) + LEGACY_TTL_MS);
  assert.deepEqual(account.previous_owner.map((db) => db.file), [`wazap.${fx.now}.previous-owner.sqlite`]);
  assert.equal(stopped.storage.beta_archive.state, "moved");
  assert.deepEqual(
    stopped.checks.filter((check) => ["storage", "legacy files", "previous owner", "beta archive"].includes(check.name)).map((check) => [check.name, check.state]),
    [["storage", "ok"], ["legacy files", "info"], ["previous owner", "info"], ["beta archive", "info"]]
  );
  const text = await statusText(fx.dataDir);
  assert.match(text, new RegExp(`✓ storage: ${account.counts.messages} messages in ${account.counts.chats} chats, \\d+ (KiB|MiB)`));
  assert.match(text, /– legacy files: kept in .*legacy until \d{4}-\d{2}-\d{2}, then deleted/);
  assert.equal(/Salut|mulțumesc/.test(text), false);

  // This process plays the running server: it holds the lock and the database, writable, mid-use.
  const svc = serviceOn(fx.dataDir);
  t.after(() => svc.stop());
  await svc.bootStorage();
  writeFileSync(join(fx.dataDir, "server.lock"), `${process.pid}\n`);
  t.after(() => fs.rmSync(join(fx.dataDir, "server.lock"), { force: true }));
  svc.db.messages.upsert({ chatJid: ANA, keyId: "WHILE", fromMe: false, ts: Date.now(), type: "text", text: "în timp ce rulează" });
  const running = await status(fx.dataDir);
  assert.equal(running.server_pid, process.pid);
  assert.equal(running.storage.accounts[0].state, "ready");
  assert.equal(running.storage.accounts[0].counts.messages, account.counts.messages + 1, "the read sees the server's commit");
  assert.equal(running.storage.accounts[0].embedding_queue, null, "recall off: no queue");
  svc.db.messages.upsert({ chatJid: ANA, keyId: "AFTER", fromMe: false, ts: Date.now(), type: "text", text: "după status" });
  assert.equal(svc.db.getMeta("import_state"), "done", "the server's connection is unharmed");
  assert.equal(svc.db.counts().messages, account.counts.messages + 2, "and it kept every row the read passed over");
});

test("status tells a preparing import, running or waiting for the next start, a database it cannot open, and an account with nothing yet", async () => {
  const fx = await legacyAccount();
  const dbPath = join(fx.paths.root, "wazap.sqlite");
  const db = AccountDb.open(dbPath);
  db.setMeta("import_state", "running");
  db.setMeta("import_progress", JSON.stringify({ phase: 2, cursor: null }));
  db.close();

  const waiting = await status(fx.dataDir);
  assert.equal(waiting.storage.accounts[0].state, "preparing");
  assert.deepEqual(waiting.storage.accounts[0].progress, { phase: "history", step: 3, steps: 9 });
  assert.deepEqual(waiting.storage.accounts[0].legacy, { state: "in-place", entries: 5 });
  assert.equal(
    waiting.checks.find((check) => check.name === "storage").detail,
    "the earlier message files are imported at the next start, resuming (history, step 3 of 9)"
  );
  assert.deepEqual(waiting.storage.beta_archive.waiting_for, ["default"]);

  writeFileSync(join(fx.dataDir, "server.lock"), `${process.pid}\n`);
  const importing = await status(fx.dataDir);
  fs.rmSync(join(fx.dataDir, "server.lock"));
  assert.equal(importing.checks.find((check) => check.name === "storage").detail, "importing the earlier message files (history, step 3 of 9)");

  const broken = mkdtempSync(join(tmpdir(), "wazap-legacy-broken-"));
  const root = accountPaths(broken, "default").root;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "wazap.sqlite"), "not a database at all, not even close to one");
  const failed = await status(broken);
  assert.equal(failed.storage.accounts[0].state, "error");
  assert.equal(failed.checks.find((check) => check.name === "storage").state, "fail");

  const fresh = await status(mkdtempSync(join(tmpdir(), "wazap-legacy-fresh-")));
  assert.equal(fresh.storage.accounts[0].state, "absent");
  assert.equal(fresh.storage.beta_archive, null);
  assert.equal(fresh.checks.some((check) => ["storage", "legacy files", "previous owner", "beta archive"].includes(check.name)), false);
});

test("status says when legacy files are back at their old place after the import, which nothing reads", async (t) => {
  const fx = await legacyAccount();
  await bootAt(t, fx.dataDir, fx.now);
  fs.renameSync(join(fx.paths.root, "legacy", "store.json"), fx.paths.storeFile);
  const report = await status(fx.dataDir);
  assert.deepEqual(report.storage.accounts[0].legacy, { state: "in-place", entries: 1 });
  const check = report.checks.find((c) => c.name === "legacy files");
  assert.match(check.detail, /^1 earlier message files are at their old place, but the account was already imported/);
});
