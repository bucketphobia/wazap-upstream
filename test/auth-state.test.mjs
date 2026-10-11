/**
 * The stock Baileys useMultiFileAuthState truncates a file before rewriting it,
 * so a kill -9 in that window leaves unreadable creds and the account has to be
 * re-linked. These tests pin the properties that replace that behaviour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { useAtomicAuthState, readLinkedAccount, clearAuth, clearSession, withoutAppStateSync } from "../dist/auth-state.js";
import { AccountDb } from "../dist/db/index.js";

function authDir() {
  return join(mkdtempSync(join(tmpdir(), "wazap-auth-")), "auth");
}

test("creates the auth directory private to the user", async () => {
  const dir = authDir();
  await useAtomicAuthState(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("saveCreds writes creds.json with 0600 and leaves no temp file behind", async () => {
  const dir = authDir();
  const { saveCreds } = await useAtomicAuthState(dir);
  await saveCreds();
  assert.equal(statSync(join(dir, "creds.json")).mode & 0o777, 0o600);
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.endsWith(".tmp")),
    []
  );
});

test("a failed write leaves the previous file byte-for-byte intact", async () => {
  const dir = authDir();
  const { state } = await useAtomicAuthState(dir);
  await state.keys.set({ "pre-key": { 1: { public: Buffer.from("aa"), private: Buffer.from("bb") } } });
  const file = join(dir, "pre-key-1.json");
  const before = readFileSync(file);

  const circular = {};
  circular.self = circular;
  await assert.rejects(state.keys.set({ "pre-key": { 1: circular } }));

  assert.deepEqual(readFileSync(file), before, "the old key survived the failed write");
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.endsWith(".tmp")),
    [],
    "no partial file left behind"
  );
});

test("concurrent writes to one key never leave torn JSON", async () => {
  const dir = authDir();
  const { state } = await useAtomicAuthState(dir);
  await Promise.all(
    Array.from({ length: 200 }, (_, i) =>
      state.keys.set({ "pre-key": { 1: { public: Buffer.alloc(i + 1, i % 256), private: Buffer.alloc(64, 7) } } })
    )
  );
  const text = readFileSync(join(dir, "pre-key-1.json"), "utf8");
  assert.doesNotThrow(() => JSON.parse(text), "every observable state of the file is valid JSON");
  const read = await state.keys.get("pre-key", ["1"]);
  assert.ok(read["1"], "the key is still readable after the write storm");
});

test("a deleted key removes its file", async () => {
  const dir = authDir();
  const { state } = await useAtomicAuthState(dir);
  await state.keys.set({ "pre-key": { 1: { public: Buffer.from("aa"), private: Buffer.from("bb") } } });
  await state.keys.set({ "pre-key": { 1: null } });
  assert.equal(readdirSync(dir).includes("pre-key-1.json"), false);
});

test("a key id can never write outside the auth directory", async () => {
  const dir = authDir();
  const { state } = await useAtomicAuthState(dir);
  await state.keys.set({ session: { "..\\..\\outside": { ok: 1 }, "sub/dir": { ok: 2 }, "co:lon": { ok: 3 } } });
  const names = readdirSync(dir);
  assert.equal(names.length, 3, "every weird id still stores inside the directory");
  for (const name of names) {
    assert.match(name, /^[A-Za-z0-9._@+=-]+$/, `${name} carries no path separator`);
    assert.ok(!name.startsWith(".."), `${name} cannot climb out of the directory`);
  }
  assert.deepEqual((await state.keys.get("session", ["..\\..\\outside"]))["..\\..\\outside"], { ok: 1 });
  assert.equal(readdirSync(join(dir, "..")).filter((f) => f.includes("outside")).length, 0);
});

test("a base64 key id finds the file an earlier version wrote, + and = included", async () => {
  const dir = authDir();
  const { state } = await useAtomicAuthState(dir);
  // The name every earlier wazap (and stock Baileys) gave this id: only / and : were escaped.
  writeFileSync(join(dir, "session-AAAAAP+a/b=.json".replace("/", "__")), JSON.stringify({ ok: 1 }));
  assert.deepEqual((await state.keys.get("session", ["AAAAAP+a/b="]))["AAAAAP+a/b="], { ok: 1 });
});

test("readLinkedAccount reports nothing before a login", async () => {
  const dir = authDir();
  const { saveCreds } = await useAtomicAuthState(dir);
  assert.equal(readLinkedAccount(dir), null, "no creds file at all");
  await saveCreds();
  assert.equal(readLinkedAccount(dir), null, "fresh creds have no account yet");
});

test("unreadable creds surface as SESSION_CORRUPT with a fix", async () => {
  const dir = authDir();
  await useAtomicAuthState(dir);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "creds.json"), "{ not json");
  assert.throws(
    () => readLinkedAccount(dir),
    (err) => {
      assert.equal(err.code, "SESSION_CORRUPT");
      assert.match(err.fix, /wazap-mcp logout/);
      return true;
    }
  );
});

test("clearAuth removes the whole directory and is idempotent", async () => {
  const dir = authDir();
  const { saveCreds } = await useAtomicAuthState(dir);
  await saveCreds();
  clearAuth(dir);
  assert.throws(() => statSync(dir));
  clearAuth(dir);
});

test("clearSession ties the account database to the credentials' number before removing them, and touches nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "wazap-auth-session-"));
  const dir = join(root, "auth");
  mkdirSync(dir);
  writeFileSync(join(dir, "creds.json"), JSON.stringify({ me: { id: "40700000001:3@s.whatsapp.net" } }));
  writeFileSync(join(root, "store.json"), "{}");
  clearSession({ authDir: dir, root });
  assert.throws(() => statSync(dir));
  assert.equal(readFileSync(join(root, "store.json"), "utf8"), "{}");
  const db = AccountDb.open(join(root, "wazap.sqlite"), { readOnly: true });
  assert.equal(db.getMeta("owner"), "40700000001@s.whatsapp.net");
  db.close();

  // A database another number fills keeps its owner; unreadable credentials still go.
  mkdirSync(dir);
  writeFileSync(join(dir, "creds.json"), JSON.stringify({ me: { id: "40799999999:3@s.whatsapp.net" } }));
  clearSession({ authDir: dir, root });
  const kept = AccountDb.open(join(root, "wazap.sqlite"), { readOnly: true });
  assert.equal(kept.getMeta("owner"), "40700000001@s.whatsapp.net");
  kept.close();
  mkdirSync(dir);
  writeFileSync(join(dir, "creds.json"), "{ truncated");
  clearSession({ authDir: dir, root });
  assert.throws(() => statSync(dir));
});

/**
 * WhatsApp hands over the address book once per stored app state collection
 * version. A socket with no store that saves those versions eats that delivery
 * for every socket after it, so the login socket runs on a wrapped state.
 */
test("withoutAppStateSync drops app-state-sync-version writes and reads", async () => {
  const dir = authDir();
  const { state } = await useAtomicAuthState(dir);
  const version = { version: 21, hash: Buffer.alloc(128), indexValueMap: {} };
  await state.keys.set({ "app-state-sync-version": { critical_unblock_low: version } });

  const guarded = withoutAppStateSync(state);
  await guarded.keys.set({ "app-state-sync-version": { regular: version } });
  assert.equal(readdirSync(dir).includes("app-state-sync-version-regular.json"), false);
  assert.deepEqual(await guarded.keys.get("app-state-sync-version", ["critical_unblock_low"]), {});
  assert.ok(
    readdirSync(dir).includes("app-state-sync-version-critical_unblock_low.json"),
    "a version the real service saved is left alone"
  );
});

test("withoutAppStateSync passes every other key type straight through", async () => {
  const dir = authDir();
  const { state } = await useAtomicAuthState(dir);
  const guarded = withoutAppStateSync(state);
  const key = { public: Buffer.from("aa"), private: Buffer.from("bb") };

  await guarded.keys.set({ "pre-key": { 7: key }, "app-state-sync-version": { regular: { version: 1 } } });
  assert.deepEqual((await guarded.keys.get("pre-key", ["7"]))["7"], key);
  assert.deepEqual((await state.keys.get("pre-key", ["7"]))["7"], key, "and it reached the real store");
  assert.equal(readdirSync(dir).includes("app-state-sync-version-regular.json"), false);
});

test("withoutAppStateSync shares the creds object, so saveCreds still writes them", async () => {
  const dir = authDir();
  const { state, saveCreds } = await useAtomicAuthState(dir);
  const guarded = withoutAppStateSync(state);
  guarded.creds.accountSyncCounter = 3;
  await saveCreds();
  assert.equal(JSON.parse(readFileSync(join(dir, "creds.json"), "utf8")).accountSyncCounter, 3);
});
