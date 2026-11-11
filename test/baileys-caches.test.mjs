/**
 * What the service's socket is opened with so a send costs less: Signal keys
 * served from a bounded cache in front of the credential files (every write
 * still lands in a file), and group metadata from the service's own group
 * cache instead of a WhatsApp query per group send.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addTransactionCapability } from "baileys";

import { BoundedKeyCache, CACHED_KEY_TYPES, cachedAuthState, useAtomicAuthState } from "../dist/auth-state.js";
import { socketFactory } from "../dist/pairing.js";
import { AccountGroups, SEND_METADATA_MS } from "../dist/service/groups.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { fakeSocket, offlineConfig, openService, waitFor } from "./helpers.mjs";

const GROUP = "120363000000000077@g.us";
const ME = "40700000001@s.whatsapp.net";

test("the key cache keeps the newest-used keys up to its bound and forgets them after their time", () => {
  let now = 0;
  const cache = new BoundedKeyCache(3, 1000, () => now);
  for (const key of ["a", "b", "c"]) cache.set(key, key.toUpperCase());
  assert.equal(cache.get("a"), "A", "reading a key makes it the newest");
  cache.set("d", "D");
  assert.equal(cache.size, 3);
  assert.equal(cache.get("b"), undefined, "the least recently used went first");
  assert.deepEqual(["a", "c", "d"].map((key) => cache.get(key)), ["A", "C", "D"]);
  now = 1000;
  assert.equal(cache.get("a"), undefined, "a key is served for its time and no longer");
  cache.set("e", null);
  assert.equal(cache.get("e"), null, "a deleted key is remembered as deleted");
  cache.del("e");
  assert.equal(cache.get("e"), undefined);
  cache.flushAll();
  assert.equal(cache.size, 0);
});

async function authDir() {
  const dir = mkdtempSync(join(tmpdir(), "wazap-keys-"));
  const { state } = await useAtomicAuthState(dir);
  return { dir, state };
}

test("cached keys are written through to their files, and read from memory afterwards", async () => {
  const { dir, state } = await authDir();
  const cached = cachedAuthState(state);
  assert.equal(cached.creds, state.creds, "the credentials Baileys updates in place are the same object saveCreds writes");
  await cached.keys.set({ session: { "40700000002.0": { record: "one" } } });
  const file = join(dir, "session-40700000002.0.json");
  assert.ok(existsSync(file), "the write reached its file");
  assert.deepEqual((await state.keys.get("session", ["40700000002.0"]))["40700000002.0"], { record: "one" });
  rmSync(file);
  assert.deepEqual(
    (await cached.keys.get("session", ["40700000002.0"]))["40700000002.0"],
    { record: "one" },
    "the second read came from memory, not the file"
  );
  await cached.keys.set({ session: { "40700000002.0": null } });
  assert.equal((await cached.keys.get("session", ["40700000002.0"]))["40700000002.0"], null, "a deleted key reads as deleted");
});

test("a write that fails leaves nothing in the cache the files do not hold", async () => {
  const { dir, state } = await authDir();
  const cached = cachedAuthState(state);
  await cached.keys.set({ "pre-key": { 1: { public: Buffer.from("aa"), private: Buffer.from("bb") } } });
  const circular = {};
  circular.self = circular;
  await assert.rejects(cached.keys.set({ "pre-key": { 1: circular } }));
  const read = (await cached.keys.get("pre-key", ["1"]))["1"];
  assert.deepEqual(Buffer.from(read.public), Buffer.from("aa"), "after the failure the key is read from its file again");
  assert.ok(existsSync(join(dir, "pre-key-1.json")));
});

const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };

/**
 * relayMessage's sender-key-memory steps (Baileys rc14, messages-send.js), through
 * Baileys' own transaction layer: send 1 marks a device that joined as given the
 * sender key in the map it read, then fails before its transaction commits.
 * Returns who send 2 gives the sender key to.
 */
async function senderKeyRecipientsAfterFailedSend(wrap) {
  const OLD = "40700000002:0@s.whatsapp.net";
  const NEW = "40700000009:3@s.whatsapp.net";
  const { dir, state } = await authDir();
  const keys = addTransactionCapability(wrap(state).keys, quiet, { maxCommitRetries: 1, delayBetweenTriesMs: 1 });
  await keys.set({ "sender-key-memory": { [GROUP]: { [OLD]: true } } });
  await assert.rejects(
    keys.transaction(async () => {
      const map = (await keys.get("sender-key-memory", [GROUP]))[GROUP] ?? {};
      map[NEW] = true;
      throw new Error("prekey fetch timed out");
    }, "me"),
    /prekey fetch timed out/
  );
  let needs;
  await keys.transaction(async () => {
    const map = (await keys.get("sender-key-memory", [GROUP]))[GROUP] ?? {};
    needs = [OLD, NEW].filter((device) => !map[device]);
    for (const device of needs) map[device] = true;
    await keys.set({ "sender-key-memory": { [GROUP]: map } });
  }, "me");
  return { needs, dir, NEW };
}

test("a group send that failed leaves no device marked as given the sender key: the map is the file's, not the cache's", async () => {
  const files = await senderKeyRecipientsAfterFailedSend((state) => state);
  const cached = await senderKeyRecipientsAfterFailedSend((state) => cachedAuthState(state));
  assert.deepEqual(files.needs, [files.NEW], "the plain files: send 2 gives the new device the key");
  assert.deepEqual(cached.needs, files.needs, "the cached store answers the same");
  const stored = JSON.parse(readFileSync(join(cached.dir, `sender-key-memory-${GROUP}.json`), "utf8"));
  assert.equal(stored[cached.NEW], true, "and send 2's commit is on disk");
});

test("only the key types Baileys never edits in place are cached; the others are read from their files every time", async () => {
  assert.deepEqual([...CACHED_KEY_TYPES].sort(), ["identity-key", "lid-mapping", "pre-key", "sender-key", "session"]);
  const { dir, state } = await authDir();
  const cached = cachedAuthState(state);
  // One commit carrying both kinds, as a transaction's does.
  await cached.keys.set({
    session: { "40700000002.0": { record: "one" } },
    "device-list": { 40700000002: ["0", "3"] },
    "sender-key-memory": { [GROUP]: { "40700000002:0@s.whatsapp.net": true } },
  });
  for (const name of ["session-40700000002.0.json", "device-list-40700000002.json", `sender-key-memory-${GROUP}.json`]) {
    assert.ok(existsSync(join(dir, name)), `${name} was written`);
  }
  const devices = (await cached.keys.get("device-list", ["40700000002"]))["40700000002"];
  devices.push("7");
  assert.deepEqual((await cached.keys.get("device-list", ["40700000002"]))["40700000002"], ["0", "3"], "an edit to what was read stays with its reader");
  rmSync(join(dir, "session-40700000002.0.json"));
  rmSync(join(dir, `sender-key-memory-${GROUP}.json`));
  assert.deepEqual((await cached.keys.get("session", ["40700000002.0"]))["40700000002.0"], { record: "one" }, "a session is served from memory");
  assert.equal((await cached.keys.get("sender-key-memory", [GROUP]))[GROUP], null, "sender-key-memory is read from its file");
});

test("a commit with a part the files refuse is reported once every part has settled", async () => {
  const { dir, state } = await authDir();
  const cached = cachedAuthState(state);
  const circular = {};
  circular.self = circular;
  await assert.rejects(
    cached.keys.set({ session: { "40700000002.0": { record: "one" } }, "sender-key-memory": { [GROUP]: circular } }),
    TypeError
  );
  assert.ok(existsSync(join(dir, "session-40700000002.0.json")), "the other part was written before the error came back");
  await assert.rejects(cached.keys.set({ session: { "40700000002.0": circular }, "device-list": { 1: ["0"] } }), TypeError);
  assert.ok(existsSync(join(dir, "device-list-1.json")));
  rmSync(join(dir, "session-40700000002.0.json"));
  assert.equal(
    (await cached.keys.get("session", ["40700000002.0"]))["40700000002.0"],
    undefined,
    "the refused session left nothing in the cache"
  );
});

test("the service socket gets the cached key store, and group sends address members from the group cache", async (t) => {
  const config = offlineConfig("wazap-caches-", { readOnly: false });
  const svc = openService(WhatsAppService, config);
  t.after(() => svc.stop());
  const authDirPath = join(config.dataDir, "accounts", "default", "auth");
  mkdirSync(authDirPath, { recursive: true });
  writeFileSync(join(authDirPath, "creds.json"), JSON.stringify({ me: { id: "40700000001:12@s.whatsapp.net", name: "Owner" } }));

  const meta = (subject) => ({ id: GROUP, subject, participants: [{ id: ME, admin: null }, { id: "40700000002@s.whatsapp.net", admin: null }] });
  const fetched = [];
  let opened = null;
  const sock = fakeSocket({ user: { id: "40700000001:12@s.whatsapp.net", name: "Owner" } });
  sock.groupMetadata = async (jid) => {
    fetched.push(jid);
    return meta("Fetched");
  };
  const original = socketFactory.open;
  socketFactory.open = (options) => {
    opened = options;
    return sock;
  };
  t.after(() => (socketFactory.open = original));

  await svc.start();
  await waitFor(() => opened !== null, 5000, "the service socket");
  assert.equal(typeof opened.auth.keys.get, "function");
  await opened.auth.keys.set({ "sender-key": { [`${GROUP}::40700000002::0`]: { k: 1 } } });
  assert.ok(existsSync(join(authDirPath, `sender-key-${GROUP}--40700000002--0.json`)), "a key the socket stores is written to its file");

  svc.status = "connected";
  sock.ev.emit("groups.upsert", [meta("Cached")]);
  assert.equal((await opened.cachedGroupMetadata(GROUP)).subject, "Cached", "a group the account has is served from the cache");
  assert.deepEqual(fetched, [], "no metadata query for it");

  sock.ev.emit("group-participants.update", { id: GROUP, participants: ["40700000003@s.whatsapp.net"], action: "add" });
  assert.equal((await opened.cachedGroupMetadata(GROUP)).subject, "Fetched", "membership changed: read again");
  assert.equal((await opened.cachedGroupMetadata(GROUP)).subject, "Fetched");
  assert.deepEqual(fetched, [GROUP], "once, then kept");

  // Another admin turns disappearing messages on: Baileys reports it as a chat update, and the next send must carry it.
  sock.ev.emit("chats.update", [{ id: GROUP, ephemeralExpiration: 86_400, ephemeralSettingTimestamp: 1 }]);
  sock.ev.emit("chats.update", [{ id: "40700000002@s.whatsapp.net", ephemeralExpiration: 86_400 }]);
  assert.equal((await opened.cachedGroupMetadata(GROUP)).subject, "Fetched");
  assert.deepEqual(fetched, [GROUP, GROUP], "the setting changed: read again before the send");
  await opened.cachedGroupMetadata(GROUP);
  assert.equal(fetched.length, 2, "then kept");

  // A new socket may have missed changes while none was connected: every group is read again once.
  const reopened = opened;
  await svc.start();
  await waitFor(() => opened !== reopened, 5000, "the second socket");
  svc.status = "connected";
  await opened.cachedGroupMetadata(GROUP);
  await opened.cachedGroupMetadata(GROUP);
  assert.deepEqual(fetched, [GROUP, GROUP, GROUP], "read again once after the reconnect");

  const forbidden = Object.assign(new Error("forbidden"), { output: { statusCode: 403 } });
  sock.groupMetadata = async () => {
    throw forbidden;
  };
  await assert.rejects(
    opened.cachedGroupMetadata("120363000000000078@g.us"),
    (err) => err === forbidden,
    "a group that cannot be read fails the send with WhatsApp's own answer, as Baileys' own query did"
  );
});

function groupsWith(fetch) {
  const clock = { now: 1_000_000 };
  const sock = { groupMetadata: fetch };
  const host = { guarded: (work) => work(), ensureConnected: () => sock, beginWrite: () => sock, learnGroup: () => {} };
  const identity = { canonical: (jid) => jid };
  return { groups: new AccountGroups(host, identity, {}, () => clock.now), clock };
}

test("a send trusts a group's members for five minutes after they were read, then reads them again", async () => {
  let members = ["40700000001@s.whatsapp.net", "40700000002@s.whatsapp.net"];
  let fetches = 0;
  const { groups, clock } = groupsWith(async (jid) => {
    fetches++;
    return { id: jid, subject: "Grup", participants: members.map((id) => ({ id, admin: null })) };
  });
  const ids = async () => (await groups.forSend(GROUP)).participants.map((p) => p.id);
  assert.equal((await ids()).length, 2);
  assert.equal(fetches, 1);
  // Someone joins and no event says so (the socket was down): the cache cannot know.
  members = [...members, "40700000005@s.whatsapp.net"];
  clock.now += SEND_METADATA_MS - 1;
  assert.equal((await ids()).length, 2, "within its time the entry is served as read");
  assert.equal(fetches, 1);
  clock.now += 1;
  assert.equal((await ids()).length, 3, "past it, the send reads the group again and addresses the newcomer");
  assert.equal(fetches, 2);
  assert.equal(groups.groupCache.get(GROUP).participants.length, 3, "the read refreshes the cache the reads use");

  groups.rereadBeforeSend(GROUP);
  await ids();
  assert.equal(fetches, 3, "a group marked for a re-read is read again");
  groups.rereadBeforeSend();
  await ids();
  assert.equal(fetches, 4, "and so is every group after a reconnect");
});

/** relayMessage's group addressing (Baileys rc14, messages-send.js): the cache first, its own query when that has no members. */
async function relayGroupData(groups, sock, jid) {
  const cached = await groups.forSend(jid);
  return cached && Array.isArray(cached.participants) ? cached : sock.groupMetadata(jid);
}

test("sends waiting on the same group share one read; a read that fails fails them with WhatsApp's own error", async () => {
  let fetches = 0;
  let fail = false;
  const timedOut = Object.assign(new Error("Timed Out"), { output: { statusCode: 408 } });
  const { groups, clock } = groupsWith(async (jid) => {
    fetches++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (fail) throw timedOut;
    return { id: jid, subject: "Grup", participants: [{ id: ME, admin: null }] };
  });
  const [a, b, c] = await Promise.all([groups.forSend(GROUP), groups.forSend(GROUP), groups.forSend(GROUP)]);
  assert.equal(fetches, 1, "one query for three sends");
  assert.ok(a === b && b === c);
  clock.now += SEND_METADATA_MS;
  fail = true;
  const waiting = [groups.forSend(GROUP), groups.forSend(GROUP)];
  for (const send of waiting) {
    await assert.rejects(send, (err) => err === timedOut, "an entry past its time is not served when it cannot be read again");
  }
  assert.equal(fetches, 2, "the sends waiting on the failed read shared it");
  assert.equal(await groups.forSend("40700000002@s.whatsapp.net"), undefined, "not a group: nothing to address");
  assert.equal(fetches, 2);
});

test("a group send whose metadata read fails waits for one query, not two", async () => {
  let fetches = 0;
  const sock = {
    groupMetadata: async () => {
      fetches++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw Object.assign(new Error("Timed Out"), { output: { statusCode: 408 } });
    },
  };
  const host = { guarded: (work) => work(), ensureConnected: () => sock, beginWrite: () => sock, learnGroup: () => {} };
  const groups = new AccountGroups(host, { canonical: (jid) => jid }, {});
  await assert.rejects(relayGroupData(groups, sock, GROUP), /Timed Out/);
  assert.equal(fetches, 1, "Baileys does not ask again after the cache's read failed");

  // No socket to ask on: nothing was asked, so Baileys asks, once.
  host.ensureConnected = () => {
    throw new Error("not connected");
  };
  await assert.rejects(relayGroupData(groups, sock, GROUP), /Timed Out/);
  assert.equal(fetches, 2);
});

test("a group read whose names the store refuses still addresses the send", async () => {
  let fetches = 0;
  const sock = {
    groupMetadata: async (jid) => {
      fetches++;
      return { id: jid, subject: "Grup", participants: [{ id: ME, admin: null }] };
    },
  };
  const host = {
    guarded: (work) => work(),
    ensureConnected: () => sock,
    beginWrite: () => sock,
    learnGroup: () => {
      throw new Error("disk full");
    },
  };
  const groups = new AccountGroups(host, { canonical: (jid) => jid }, {});
  assert.equal((await relayGroupData(groups, sock, GROUP)).subject, "Grup");
  assert.equal((await relayGroupData(groups, sock, GROUP)).subject, "Grup");
  assert.equal(fetches, 1, "read once, then served from the cache");
});

test("a read already in flight when a group changes does not count for the sends after it", async () => {
  let fetches = 0;
  let release;
  const { groups, clock } = groupsWith(async (jid) => {
    const n = ++fetches;
    if (n === 1) await new Promise((resolve) => (release = resolve));
    return { id: jid, subject: `Read ${n}`, participants: [{ id: ME, admin: null }] };
  });
  const first = groups.forSend(GROUP);
  clock.now += 1;
  // The disappearing setting changes while the first read is on its way back.
  groups.rereadBeforeSend(GROUP);
  release();
  assert.equal((await first).subject, "Read 1", "the send that asked gets what it asked for");
  assert.equal((await groups.forSend(GROUP)).subject, "Read 2", "the next send reads the group again");
  assert.equal((await groups.forSend(GROUP)).subject, "Read 2");
  assert.equal(fetches, 2);
});
