/**
 * The link's own watch (src/service/link.ts) and what the service does with it: an outage the
 * owner hears of once, past a threshold and across the restart that hands it to the supervisor;
 * the return after it; a device WhatsApp unlinked; a sleep the clock gives away; a socket that
 * stops answering; and, through all of it, a session that is never thrown away.
 *
 * Run: npm test  (requires npm run build first — these drive dist/)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WhatsAppService } from "../dist/whatsapp.js";
import { CredentialsReadError, readLinkedAccount, useAtomicAuthState } from "../dist/auth-state.js";
import { classifyClose } from "../dist/service/health.js";
import {
  ALERT_AFTER_MS,
  CONNECT_STUCK_MS,
  RECORD_STALE_MS,
  LinkMonitor,
  PROBE_EVERY_MS,
  STALLED_DOWN_MS,
  WAKE_GAP_MS,
  WATCH_TICK_MS,
  alertReason,
} from "../dist/service/link.js";
import { WebhookSink, asAlertPayload, parseWebhookEvents } from "../dist/webhook.js";
import { connectedService, openService, offlineConfig, storageRows } from "./helpers.mjs";

/** A host the test drives: a status, a clock, and a record of what the watch asked for. */
function fakeHost(overrides = {}) {
  const host = {
    now: 1_000_000,
    statusValue: "connecting",
    since: 1_000_000,
    error: null,
    socketAt: null,
    pending: null,
    isStarting: false,
    startable: true,
    probeAnswer: "alive",
    queueable: true,
    alerts: [],
    forced: [],
    retried: [],
    probes: 0,
    status: () => host.statusValue,
    statusSince: () => host.since,
    lastError: () => host.error,
    socketSince: () => host.socketAt,
    reconnectPending: () => host.pending,
    starting: () => host.isStarting,
    canStart: () => host.startable,
    probe: async () => {
      host.probes += 1;
      return host.probeAnswer;
    },
    forceReconnect: (reason) => host.forced.push(reason),
    retryNow: (reason) => host.retried.push(reason),
    alert: (alert) => {
      if (!host.queueable) return false;
      host.alerts.push(alert);
      return true;
    },
    ...overrides,
  };
  return host;
}

function setStatus(watch, host, status) {
  host.statusValue = status;
  host.since = host.now;
  watch.noteStatus(status);
}

/** Advance the host's clock by ticks of the watchdog, as an awake machine would. */
function awake(watch, host, ms) {
  const end = host.now + ms;
  while (host.now < end) {
    host.now = Math.min(end, host.now + WATCH_TICK_MS);
    watch.tick();
  }
}

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), "wazap-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "link.json");
}

/** A watch armed as the server arms it, on a clock of the test's, its interval stopped at the end. */
function watching(t, host, file) {
  const watch = new LinkMonitor(host, file, () => host.now);
  t.after(() => watch.dispose(false));
  watch.arm();
  return watch;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a boot that connects in seconds is not an outage: no alert, no last outage, no record", (t) => {
  const file = tempFile(t);
  const host = fakeHost();
  const watch = watching(t, host, file);
  awake(watch, host, 10_000);
  setStatus(watch, host, "connected");
  assert.deepEqual(host.alerts, []);
  assert.equal(watch.info().last_outage, null);
  assert.equal(watch.info().down_since, null);
  assert.equal(existsSync(file), false, "nothing to keep once the link is up");
});

test("a short drop is not told; one past the threshold is told once, and its end once", (t) => {
  const file = tempFile(t);
  const host = fakeHost({ statusValue: "connected" });
  const watch = watching(t, host, file);

  setStatus(watch, host, "disconnected");
  awake(watch, host, 60_000);
  setStatus(watch, host, "connected");
  assert.deepEqual(host.alerts, [], "a minute's drop is not news");
  assert.equal(watch.info().last_outage.seconds, 60, "but it is on record");

  host.error = "WebSocket Error (connect ECONNREFUSED)";
  setStatus(watch, host, "disconnected");
  const downAt = host.now;
  awake(watch, host, ALERT_AFTER_MS - WATCH_TICK_MS);
  assert.deepEqual(host.alerts, []);
  awake(watch, host, 2 * WATCH_TICK_MS);
  assert.equal(host.alerts.length, 1);
  assert.equal(host.alerts[0].alert, "disconnected");
  assert.equal(host.alerts[0].downSince, downAt);
  assert.equal(host.alerts[0].reason, "WebSocket Error (connect ECONNREFUSED)");
  assert.equal(watch.info().alerted, "disconnected");
  assert.match(watch.hint(), /down for \d+ min .*do not link again/);

  awake(watch, host, 30 * 60_000);
  setStatus(watch, host, "connecting");
  setStatus(watch, host, "disconnected");
  assert.equal(host.alerts.length, 1, "flaps inside one outage tell nothing more");

  setStatus(watch, host, "connected");
  assert.deepEqual(
    host.alerts.map((alert) => alert.alert),
    ["disconnected", "recovered"]
  );
  assert.equal(host.alerts[1].downSince, downAt);
  assert.equal(host.alerts[1].downForMs, host.now - downAt);
  assert.equal(host.alerts[1].reason, null);
  assert.equal(watch.info().alerted, null);
  assert.equal(watch.hint(), null);
});

test("the outage outlives the exit that hands it to the supervisor: told once, and its end told after", (t) => {
  const file = tempFile(t);
  const host = fakeHost({ statusValue: "connected" });
  const first = watching(t, host, file);
  setStatus(first, host, "disconnected");
  const downAt = host.now;
  awake(first, host, ALERT_AFTER_MS + WATCH_TICK_MS);
  assert.equal(host.alerts.length, 1);
  // The give-up exit: no stop runs, the record stays as it was written.
  const record = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(record.down_since, downAt);
  assert.equal(record.alerted, "disconnected");

  const again = fakeHost({ now: host.now + 10_000, statusValue: "connecting" });
  const second = watching(t, again, file);
  assert.equal(second.info().alerted, "disconnected");
  awake(second, again, ALERT_AFTER_MS * 2);
  assert.deepEqual(again.alerts, [], "the new process does not tell the same outage twice");
  setStatus(second, again, "connected");
  assert.deepEqual(
    again.alerts.map((alert) => alert.alert),
    ["recovered"]
  );
  assert.equal(again.alerts[0].downSince, downAt, "the outage is measured from when it began, not from the restart");
  assert.equal(second.info().last_outage.from.length > 0, true);
});

test("a down link at the give-up exit keeps its clock, so the next process alerts on time", (t) => {
  const file = tempFile(t);
  const host = fakeHost({ statusValue: "connected" });
  const first = watching(t, host, file);
  setStatus(first, host, "disconnected");
  const downAt = host.now;
  awake(first, host, ALERT_AFTER_MS - 60_000);
  assert.deepEqual(host.alerts, []);

  const again = fakeHost({ now: host.now + 10_000 });
  const second = watching(t, again, file);
  awake(second, again, 60_000);
  assert.equal(again.alerts.length, 1, "the minutes before the restart counted");
  assert.equal(again.alerts[0].downSince, downAt);
});

test("an untold outage in a record no process has touched for a while starts again with this process", (t) => {
  const file = tempFile(t);
  const host = fakeHost({ statusValue: "connected" });
  const first = watching(t, host, file);
  setStatus(first, host, "disconnected");
  awake(first, host, 4 * 60_000);
  // Stopped hard, and started again days later: the days are not an outage this process saw.
  const later = fakeHost({ now: host.now + 3 * 86_400_000 });
  const second = watching(t, later, file);
  assert.ok(Date.parse(second.info().down_since) >= later.now - 1000, "the clock starts at this boot");
  awake(second, later, 60_000);
  assert.deepEqual(later.alerts, [], "no alert for days nobody was watching");
  assert.ok(RECORD_STALE_MS < ALERT_AFTER_MS, "a give-up restart is well inside the window");
});

test("a clean stop forgets an outage nobody was told about, and keeps one they were", (t) => {
  const file = tempFile(t);
  const host = fakeHost({ statusValue: "connected" });
  const quiet = new LinkMonitor(host, file, () => host.now);
  quiet.arm();
  setStatus(quiet, host, "disconnected");
  assert.equal(existsSync(file), true, "written as it happens, for an exit that runs no stop");
  quiet.dispose(true);
  assert.equal(existsSync(file), false);

  const told = new LinkMonitor(host, file, () => host.now);
  told.arm();
  setStatus(told, host, "disconnected");
  awake(told, host, ALERT_AFTER_MS + WATCH_TICK_MS);
  told.dispose(true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).alerted, "disconnected");
});

test("an unlinked device is told at once, once, and never as an outage too", (t) => {
  const file = tempFile(t);
  const host = fakeHost({ statusValue: "connected" });
  const watch = watching(t, host, file);
  setStatus(watch, host, "logged_out");
  assert.deepEqual(
    host.alerts.map((alert) => alert.alert),
    ["relink_required"]
  );
  awake(watch, host, ALERT_AFTER_MS * 3);
  assert.equal(host.alerts.length, 1, "no disconnected alert on top of it");

  const again = fakeHost({ now: host.now, statusValue: "logged_out" });
  watching(t, again, file);
  assert.deepEqual(again.alerts, [], "a restart does not tell it again");
});

test("unreadable credentials need a new link too", (t) => {
  const host = fakeHost();
  const watch = watching(t, host, tempFile(t));
  setStatus(watch, host, "session_corrupt");
  assert.deepEqual(
    host.alerts.map((alert) => alert.alert),
    ["relink_required"]
  );
});

test("an account with no session, or one pairing, has nothing to be down", (t) => {
  const file = tempFile(t);
  const host = fakeHost({ statusValue: "not_linked" });
  const watch = watching(t, host, file);
  awake(watch, host, ALERT_AFTER_MS * 2);
  setStatus(watch, host, "linking");
  awake(watch, host, ALERT_AFTER_MS * 2);
  assert.deepEqual(host.alerts, []);
  assert.equal(watch.info().down_since, null);
});

test("a new link forgets the old session's outage", (t) => {
  const file = tempFile(t);
  const host = fakeHost({ statusValue: "connected" });
  const watch = watching(t, host, file);
  setStatus(watch, host, "logged_out");
  watch.forgetSession();
  setStatus(watch, host, "linking");
  setStatus(watch, host, "connected");
  assert.deepEqual(
    host.alerts.map((alert) => alert.alert),
    ["relink_required"],
    "the owner linked it themselves; nothing more to tell"
  );
});

test("an alert the database cannot take yet is held and queued at a later tick", (t) => {
  const host = fakeHost({ statusValue: "connected", queueable: false });
  const watch = watching(t, host, tempFile(t));
  setStatus(watch, host, "logged_out");
  assert.deepEqual(host.alerts, []);
  host.queueable = true;
  awake(watch, host, WATCH_TICK_MS);
  assert.deepEqual(
    host.alerts.map((alert) => alert.alert),
    ["relink_required"]
  );
});

test("a short-lived command's watch alerts nothing and writes nothing", () => {
  const host = fakeHost({ statusValue: "connected" });
  const watch = new LinkMonitor(host, null, () => host.now);
  watch.arm();
  setStatus(watch, host, "logged_out");
  watch.tick();
  assert.deepEqual(host.alerts, []);
  assert.equal(watch.info().down_since, null);
});

test("a clock jump is a wake: a connected socket is pinged, and one that does not answer is replaced", async (t) => {
  const host = fakeHost({ statusValue: "connected", probeAnswer: "dead" });
  const watch = watching(t, host, tempFile(t));
  host.now += 8 * 3_600_000;
  watch.tick();
  await flush();
  assert.equal(host.probes, 1);
  assert.deepEqual(host.forced, ["the socket stopped answering pings"], "one unanswered ping is enough after a wake");
  assert.equal(watch.info().wakes, 1);
  assert.equal(watch.info().forced_reconnects, 1);
  assert.notEqual(watch.info().last_wake_at, null);
});

test("after a wake, a socket that answers is kept", async (t) => {
  const host = fakeHost({ statusValue: "connected", probeAnswer: "alive" });
  const watch = watching(t, host, tempFile(t));
  host.now += WATCH_TICK_MS + WAKE_GAP_MS + 1;
  watch.tick();
  await flush();
  assert.equal(host.probes, 1);
  assert.deepEqual(host.forced, []);
});

test("a late tick inside the slack is not a wake", (t) => {
  const host = fakeHost({ statusValue: "connected" });
  const watch = watching(t, host, tempFile(t));
  host.now += WATCH_TICK_MS + WAKE_GAP_MS;
  watch.tick();
  assert.equal(watch.info().wakes, 0);
});

test("a wake cuts a backoff wait short, and never a temporary ban's", (t) => {
  const host = fakeHost({ statusValue: "disconnected", pending: "backoff" });
  const watch = watching(t, host, tempFile(t));
  host.now += 3_600_000;
  watch.tick();
  assert.deepEqual(host.retried, ["woke from sleep"]);

  const banned = fakeHost({ statusValue: "auth_failure", pending: "ban" });
  const other = watching(t, banned, tempFile(t));
  banned.now += 3_600_000;
  other.tick();
  assert.deepEqual(banned.retried, []);
  assert.deepEqual(banned.forced, []);
});

test("a socket that was opening when the machine slept is replaced at the wake", (t) => {
  const host = fakeHost({ statusValue: "connecting" });
  host.socketAt = host.now;
  const watch = watching(t, host, tempFile(t));
  host.now += 3_600_000;
  watch.tick();
  assert.equal(host.forced.length, 1);
});

test("a socket a reconnect opened after the wake is left to finish", (t) => {
  const host = fakeHost({ statusValue: "connecting" });
  const watch = watching(t, host, tempFile(t));
  host.now += 3_600_000;
  host.socketAt = host.now - 2_000; // the backoff timer fired as the machine woke
  watch.tick();
  assert.deepEqual(host.forced, []);
});

test("time asleep does not count toward the alert; awake time does", (t) => {
  const host = fakeHost({ statusValue: "connected" });
  const watch = watching(t, host, tempFile(t));
  setStatus(watch, host, "disconnected");
  host.pending = "backoff";
  host.now += 8 * 3_600_000;
  watch.tick();
  assert.deepEqual(host.alerts, [], "eight hours asleep is not an eight-hour outage");
  awake(watch, host, ALERT_AFTER_MS + WATCH_TICK_MS);
  assert.equal(host.alerts.length, 1);
});

test("between wakes, a connected socket is pinged every few minutes and replaced after two silences", async (t) => {
  const host = fakeHost({ statusValue: "connected", probeAnswer: "dead" });
  const watch = watching(t, host, tempFile(t));
  setStatus(watch, host, "connected");
  awake(watch, host, PROBE_EVERY_MS);
  await flush();
  assert.equal(host.probes, 1);
  assert.deepEqual(host.forced, [], "one silence may be a busy socket");
  awake(watch, host, PROBE_EVERY_MS);
  await flush();
  assert.equal(host.probes, 2);
  assert.deepEqual(host.forced, ["the socket stopped answering pings"]);
});

test("a ping that finds the socket already replaced does nothing", async (t) => {
  const host = fakeHost({ statusValue: "connected", probeAnswer: "gone" });
  const watch = watching(t, host, tempFile(t));
  for (let i = 0; i < 3; i++) {
    awake(watch, host, PROBE_EVERY_MS);
    await flush();
  }
  assert.equal(host.probes, 3);
  assert.deepEqual(host.forced, []);
});

test("a socket stuck opening is replaced; a link down with nothing on its way gets a reconnect", (t) => {
  const host = fakeHost({ statusValue: "connecting" });
  host.socketAt = host.now;
  const watch = watching(t, host, tempFile(t));
  awake(watch, host, CONNECT_STUCK_MS - WATCH_TICK_MS);
  assert.deepEqual(host.forced, []);
  awake(watch, host, WATCH_TICK_MS);
  assert.equal(host.forced.length, 1);
  assert.match(host.forced[0], /still connecting/);

  const stalled = fakeHost({ statusValue: "disconnected" });
  const other = watching(t, stalled, tempFile(t));
  awake(other, stalled, STALLED_DOWN_MS);
  assert.deepEqual(stalled.forced, ["down with no reconnect scheduled"]);

  const waiting = fakeHost({ statusValue: "disconnected", pending: "backoff" });
  const third = watching(t, waiting, tempFile(t));
  awake(third, waiting, STALLED_DOWN_MS * 3);
  assert.deepEqual(waiting.forced, [], "a reconnect already scheduled is left to run");
});

test("a damaged record is ignored, not trusted", (t) => {
  const file = tempFile(t);
  writeFileSync(file, '{"down_since":"yesterday","alerted":"nonsense"');
  const host = fakeHost();
  const watch = watching(t, host, file);
  assert.equal(watch.info().alerted, null);
  writeFileSync(file, JSON.stringify({ down_since: -5, alerted: "disconnected", last_outage: { from: 9, to: 1 } }));
  const again = watching(t, fakeHost(), file);
  assert.equal(again.info().alerted, null, "an alert with no outage under way is no alert");
  assert.equal(again.info().last_outage, null);
});

test("the reason an alert carries has no credentials and a bounded length", () => {
  assert.equal(alertReason("WebSocket Error (connect to http://user:hunter2@proxy.lan:3128 failed)"), "WebSocket Error (connect to http://proxy.lan:3128 failed)");
  assert.equal(alertReason("   "), null);
  assert.equal(alertReason(null), null);
  assert.equal(alertReason("x".repeat(1000)).length, 300);
});

test("a 401 means unlinked only when WhatsApp, or wazap's own logout, says it", () => {
  const failure = { message: "Connection Failure", output: { statusCode: 401 } };
  const stream = { message: "Stream Errored (conflict)", output: { statusCode: 401 } };
  const ours = { message: "Intentional Logout", output: { statusCode: 401 } };
  const proxy = { message: "WebSocket Error (Unexpected server response: 401)", output: { statusCode: 401 } };
  assert.equal(classifyClose(failure).kind, "logged_out");
  assert.equal(classifyClose(stream).kind, "logged_out");
  assert.equal(classifyClose(ours).kind, "logged_out");
  assert.equal(classifyClose(proxy).kind, "transient", "a proxy or captive portal's 401 is a dropped link, retried");
});

test("the alert payload names the outage in UTC and says what to do", () => {
  const payload = asAlertPayload({
    alert: "disconnected",
    status: "disconnected",
    account: { id: "default", name: "Home" },
    at: Date.UTC(2026, 9, 11, 10, 5),
    downSince: Date.UTC(2026, 9, 11, 10, 0),
    downForMs: 300_000,
    reason: "Connection was lost",
  });
  assert.deepEqual(payload, {
    event: "alert",
    alert: "disconnected",
    status: "disconnected",
    timestamp: "2026-10-11T10:05:00.000Z",
    down_since: "2026-10-11T10:00:00.000Z",
    down_for_seconds: 300,
    reason: "Connection was lost",
    fix: payload.fix,
    account_id: "default",
    account_name: "Home",
  });
  assert.match(payload.fix, /Nothing to re-link/);
  const relink = asAlertPayload({ alert: "relink_required", status: "logged_out", account: { id: "a", name: "a" }, at: 1, downSince: 1, downForMs: 0, reason: null });
  assert.equal(relink.status, "expired");
  assert.match(relink.fix, /wazap login/);
});

test("an outage WhatsApp holds closed says so, not to check the network", () => {
  const payload = asAlertPayload({ alert: "disconnected", status: "auth_failure", account: { id: "a", name: "a" }, at: 1, downSince: 1, downForMs: 0, reason: "WhatsApp has banned or locked this account." });
  assert.equal(payload.status, "expired");
  assert.match(payload.fix, /refuses this account/);
  assert.doesNotMatch(payload.fix, /network/);
});

test("alert is a webhook event of its own: asked for by name, not by default and not by all", () => {
  assert.deepEqual(parseWebhookEvents(""), ["message_received"]);
  assert.deepEqual(parseWebhookEvents("alert"), ["alert"]);
  assert.deepEqual(parseWebhookEvents("all"), ["message_received", "message_sent", "connection"], "an integration that wrote all gets what it always got");
  assert.deepEqual(parseWebhookEvents("all,alert"), ["message_received", "message_sent", "connection", "alert"]);
});

// The service ------------------------------------------------------------------

function serviceWatch(t, overrides = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-link-svc-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const connected = connectedService(WhatsAppService, {
    prefix: "wazap-link-svc-",
    id: "40700000001@s.whatsapp.net",
    name: "Ana",
    config: { dataDir, ...overrides },
  });
  t.after(() => connected.svc.stop());
  return { ...connected, dataDir };
}

const close = (sock, message, statusCode) =>
  sock.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { message, output: { statusCode } } } });

test("the service pings with Baileys' keepalive and reads its answer", async (t) => {
  const { svc, sock } = serviceWatch(t);
  const sent = [];
  sock.query = async (node, timeoutMs) => {
    sent.push({ node, timeoutMs });
    return { tag: "iq", attrs: { type: "result" } };
  };
  assert.equal(await svc.probeSocket(5_000), "alive");
  assert.deepEqual(sent[0].node, { tag: "iq", attrs: { to: "@s.whatsapp.net", type: "get", xmlns: "w:p" }, content: [{ tag: "ping", attrs: {} }] });
  assert.equal(sent[0].timeoutMs, 5_000);

  sock.query = async () => {
    throw Object.assign(new Error("Timed Out"), { output: { statusCode: 408 } });
  };
  assert.equal(await svc.probeSocket(5_000), "dead");
  sock.query = async () => {
    throw Object.assign(new Error("Connection Closed"), { output: { statusCode: 428 } });
  };
  assert.equal(await svc.probeSocket(5_000), "dead");
  sock.query = async () => {
    throw Object.assign(new Error("bad-request"), { output: { statusCode: 400 } });
  };
  assert.equal(await svc.probeSocket(5_000), "alive", "an error answer is still an answer");

  svc.status = "disconnected";
  assert.equal(await svc.probeSocket(5_000), "gone");
});

test("a forced reconnect tears the socket down and paces the retry, credentials untouched", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5);
  const { svc, sock, dataDir } = serviceWatch(t);
  const auth = join(dataDir, "accounts", "default", "auth");
  mkdirSync(auth, { recursive: true });
  writeFileSync(join(auth, "creds.json"), '{"me":{"id":"40700000001@s.whatsapp.net"}}');
  const starts = [];
  svc.start = async () => starts.push(true);
  svc.forceReconnect("the socket stopped answering pings");
  assert.equal(sock.ended, true);
  assert.equal(svc.getStatus().status, "disconnected");
  assert.equal(svc.getStatus().last_error, "the socket stopped answering pings");
  t.mock.timers.tick(1_999);
  assert.equal(starts.length, 0);
  t.mock.timers.tick(1);
  assert.equal(starts.length, 1);
  assert.equal(readFileSync(join(auth, "creds.json"), "utf8"), '{"me":{"id":"40700000001@s.whatsapp.net"}}', "the credentials are untouched");
});

test("a forced reconnect leaves a temporary ban's one try alone, and a wake does not cut it short", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { svc, sock } = serviceWatch(t);
  const starts = [];
  svc.start = async () => starts.push(true);
  sock.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { message: "Connection Failure", output: { statusCode: 402 }, data: { expire: 3600, code: "x" } } },
  });
  assert.equal(svc.getStatus().status, "auth_failure");
  assert.notEqual(svc.reconnectTimer, null);
  svc.forceReconnect("whatever");
  svc.retryNow("woke from sleep");
  assert.equal(svc.getStatus().status, "auth_failure");
  t.mock.timers.tick(60 * 60_000);
  assert.equal(starts.length, 0, "the ban's try waits for the ban to end");
  t.mock.timers.tick(61_000);
  assert.equal(starts.length, 1, "and is still there, a minute after the ban ends");
});

test("a wake retries a backoff at once with a fresh budget", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5);
  const { svc } = serviceWatch(t);
  const starts = [];
  svc.start = async () => starts.push(true);
  svc.reconnectAttempts = 8; // the next wait would be minutes
  svc.scheduleReconnect("Connection Terminated");
  svc.retryNow("woke from sleep");
  assert.equal(svc.getStatus().reconnect_attempts, 1);
  t.mock.timers.tick(2_000);
  assert.equal(starts.length, 1);
});

test("a proxy's 401 is retried like any dropped link, and nothing invites a new link", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { svc, sock } = serviceWatch(t);
  svc.start = async () => {};
  close(sock, "WebSocket Error (Unexpected server response: 401)", 401);
  assert.equal(svc.getStatus().status, "disconnected");
  assert.notEqual(svc.reconnectTimer, null);
});

test("WhatsApp's unlink reaches the webhook as relink_required, in a lane no connection event supersedes", async (t) => {
  const { svc, sock } = serviceWatch(t);
  await svc.bootStorage();
  const posted = [];
  svc.webhook = new WebhookSink(
    { WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_URL: "http://127.0.0.1:9/hook", WAZAP_WEBHOOK_SECRET: "synthetic-secret", WAZAP_WEBHOOK_EVENTS: "connection,alert" },
    {
      post: async (_url, init) => {
        posted.push(JSON.parse(init.body));
        return new Response(null, { status: 503 });
      },
    }
  );
  close(sock, "Connection Failure", 401);
  const status = svc.getStatus();
  assert.equal(status.status, "logged_out");
  assert.equal(status.link.alerted, "relink_required");
  assert.match(status.hint, /link it again with link_account/);
  const rows = storageRows(svc, "SELECT kind, lane, payload FROM events ORDER BY seq");
  const alert = rows.find((row) => row.kind === "alert");
  assert.ok(alert, "the alert is queued in the outbox");
  assert.equal(alert.lane, "alert");
  const body = JSON.parse(alert.payload);
  assert.equal(body.alert, "relink_required");
  assert.equal(body.status, "expired");
  assert.ok(rows.some((row) => row.kind === "connection"), "the connection event goes out as before");
  await svc.outbox.idle();
  assert.ok(posted.some((body) => body.event === "alert" && body.account_name === "default"));
});

test("an alert is not queued when the webhook does not ask for it", async (t) => {
  const { svc, sock } = serviceWatch(t);
  await svc.bootStorage();
  svc.webhook = new WebhookSink(
    { WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_URL: "http://127.0.0.1:9/hook", WAZAP_WEBHOOK_SECRET: "synthetic-secret", WAZAP_WEBHOOK_EVENTS: "connection" },
    { post: async () => new Response(null, { status: 204 }) }
  );
  close(sock, "Connection Failure", 401);
  const kinds = storageRows(svc, "SELECT kind FROM events").map((row) => row.kind);
  assert.equal(kinds.includes("alert"), false);
  assert.equal(svc.getStatus().link.alerted, "relink_required", "get_status still says so");
});

test("get_status carries the link block on every account", (t) => {
  const svc = openService(WhatsAppService, offlineConfig("wazap-link-status-"));
  t.after(() => svc.stop());
  const link = svc.getStatus().link;
  assert.deepEqual(Object.keys(link).sort(), [
    "alert_after_seconds",
    "alerted",
    "down_for_seconds",
    "down_since",
    "forced_reconnects",
    "last_forced_reconnect",
    "last_outage",
    "last_wake_at",
    "wakes",
  ]);
  assert.equal(link.alert_after_seconds, ALERT_AFTER_MS / 1000);
});

test("the service keeps link.json beside its database, and a short-lived command does not", async (t) => {
  const { svc, sock, dataDir } = serviceWatch(t);
  close(sock, "Connection Terminated", 428);
  assert.equal(existsSync(join(dataDir, "accounts", "default", "link.json")), true);
  await svc.stop();

  const other = serviceWatch(t, { command: "status" });
  close(other.sock, "Connection Terminated", 428);
  assert.equal(existsSync(join(other.dataDir, "accounts", "default", "link.json")), false);
});

// The fixes the review asked for --------------------------------------------------

test("credentials that cannot be read for a moment are not 'nothing linked', and never replaced by fresh ones", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-creds-io-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(readLinkedAccount(dir), null, "a missing file is nothing linked");
  mkdirSync(join(dir, "creds.json")); // reading it fails with EISDIR, as an EIO or EMFILE would fail
  assert.throws(() => readLinkedAccount(dir), CredentialsReadError);
  await assert.rejects(useAtomicAuthState(dir), CredentialsReadError, "no fresh session is started over it");
});

test("the service retries unreadable credentials as a dropped link, never not_linked", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { svc, dataDir } = serviceWatch(t);
  mkdirSync(join(dataDir, "accounts", "default", "auth", "creds.json"), { recursive: true });
  assert.equal(svc.readAccount(), "unreadable");
  const status = svc.getStatus();
  assert.equal(status.status, "disconnected");
  assert.match(status.last_error, /could not be read \(EISDIR\)\. Retrying; .*do not log out/);
  assert.doesNotMatch(status.last_error, /accounts/, "no local path");
  assert.notEqual(svc.reconnectTimer, null, "a reconnect is on its way");
});

test("the outage hint is for an outage wazap is fixing, and a logout ends the outage", (t) => {
  const file = tempFile(t);
  const host = fakeHost({ statusValue: "connected" });
  const watch = watching(t, host, file);
  setStatus(watch, host, "disconnected");
  awake(watch, host, ALERT_AFTER_MS + WATCH_TICK_MS);
  assert.notEqual(watch.hint(), null);
  host.statusValue = "auth_failure";
  assert.equal(watch.hint(), null, "a link WhatsApp holds closed is not being reconnected");
  setStatus(watch, host, "not_linked");
  assert.equal(watch.info().alerted, null);
  assert.equal(watch.info().down_since, null);
  assert.equal(existsSync(file), false);
});

test("a first boot still preparing its database is not an outage until a socket is tried", (t) => {
  const host = fakeHost({ statusValue: "connecting", isStarting: true });
  const watch = watching(t, host, tempFile(t));
  awake(watch, host, ALERT_AFTER_MS * 3);
  assert.deepEqual(host.alerts, [], "fifteen minutes of import alerts nobody");
  host.socketAt = host.now;
  host.isStarting = false;
  awake(watch, host, ALERT_AFTER_MS - 2 * WATCH_TICK_MS);
  assert.deepEqual(host.alerts, []);
  awake(watch, host, 3 * WATCH_TICK_MS);
  assert.equal(host.alerts.length, 1, "counted from the first socket");
});

test("a ping that was out when the machine slept decides with one silence", async (t) => {
  let answer;
  const host = fakeHost({ statusValue: "connected" });
  host.probe = () => {
    host.probes += 1;
    return new Promise((resolve) => (answer = resolve));
  };
  const watch = watching(t, host, tempFile(t));
  awake(watch, host, PROBE_EVERY_MS); // a periodic ping goes out
  assert.equal(host.probes, 1);
  host.now += 3_600_000; // and the machine sleeps before it is answered
  watch.tick();
  answer("dead");
  await flush();
  assert.deepEqual(host.forced, ["the socket stopped answering pings"]);
});

test("unreadable credentials reach the webhook without the path they live at", (t) => {
  const host = fakeHost({ statusValue: "connected" });
  host.error = "Stored credentials in /Users/someone/.wazap/accounts/default/auth are unreadable.";
  const watch = watching(t, host, tempFile(t));
  setStatus(watch, host, "session_corrupt");
  assert.equal(host.alerts[0].reason, "The stored credentials cannot be read.");
});

// The second review pass ----------------------------------------------------------

test("credentials unreadable at boot still arm the watch, so a read that keeps failing is told", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-link-boot-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, "accounts", "default", "auth", "creds.json"), { recursive: true });
  const svc = openService(WhatsAppService, offlineConfig("wazap-link-boot-", { dataDir }));
  t.after(() => svc.stop());
  await svc.start();
  assert.equal(svc.getStatus().status, "disconnected");
  assert.notEqual(svc.linkWatch.timer, null, "the watchdog runs");
  assert.notEqual(svc.getStatus().link.down_since, null, "the outage clock runs");
});

test("an alert still waiting for the outbox is not recorded as told, so a restart tells it", (t) => {
  const file = tempFile(t);
  const host = fakeHost({ statusValue: "connected", queueable: false });
  const watch = watching(t, host, file);
  setStatus(watch, host, "session_corrupt");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).alerted, null);
  host.queueable = true;
  awake(watch, host, WATCH_TICK_MS);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).alerted, "relink_required", "recorded once queued");
});

test("a sleep moves the outage forward by its length, keeping the awake minutes before it", (t) => {
  const host = fakeHost({ statusValue: "connected" });
  const watch = watching(t, host, tempFile(t));
  setStatus(watch, host, "disconnected");
  host.pending = "backoff";
  awake(watch, host, 3 * 60_000);
  host.now += 8 * 3_600_000;
  watch.tick();
  assert.deepEqual(host.alerts, [], "the sleep itself is not down time");
  awake(watch, host, 90_000);
  assert.deepEqual(host.alerts, [], "four and a half awake minutes are under the threshold");
  awake(watch, host, 30_000 + WATCH_TICK_MS);
  assert.equal(host.alerts.length, 1, "three minutes before the sleep and two after make five");
});

test("a boot whose socket failed to open is counted once start() is done", (t) => {
  const host = fakeHost({ statusValue: "connecting", isStarting: true });
  const watch = watching(t, host, tempFile(t));
  awake(watch, host, ALERT_AFTER_MS * 2);
  assert.deepEqual(host.alerts, [], "preparing");
  host.isStarting = false; // the open threw: connecting, no socket, not starting
  awake(watch, host, ALERT_AFTER_MS + WATCH_TICK_MS);
  assert.equal(host.alerts.length, 1);
});

// The third review pass ------------------------------------------------------------

test("credentials missing from under a running session are retried, never not_linked", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { svc } = serviceWatch(t);
  assert.equal(svc.readAccount(), "unreadable", "the session it had is not gone because a read missed it");
  assert.equal(svc.getStatus().status, "disconnected");
  assert.notEqual(svc.reconnectTimer, null);
});

test("a connect after relink_required is a new session, not the outage's end", (t) => {
  const file = tempFile(t);
  const host = fakeHost({ statusValue: "connected" });
  const first = watching(t, host, file);
  setStatus(first, host, "logged_out");
  // Linked again offline (`wazap logout` then `wazap login` with no server), then the server starts.
  const again = fakeHost({ now: host.now + 3_600_000 });
  const second = watching(t, again, file);
  setStatus(second, again, "connected");
  assert.deepEqual(again.alerts, []);
  assert.equal(second.info().alerted, null);
});

test("a start that threw before its socket opened is retried by the watchdog", (t) => {
  const host = fakeHost({ statusValue: "connecting" });
  const watch = watching(t, host, tempFile(t));
  awake(watch, host, STALLED_DOWN_MS - WATCH_TICK_MS);
  assert.deepEqual(host.forced, []);
  awake(watch, host, WATCH_TICK_MS);
  assert.deepEqual(host.forced, ["the socket never opened"]);
});

test("unreadable credentials are a WazapError with a fix that never says log out", () => {
  const err = new CredentialsReadError("EACCES");
  assert.equal(err.code, "SERVICE_ERROR");
  assert.equal(err.errno, "EACCES");
  assert.match(err.fix, /do not log out/);
});

// The fourth review pass -----------------------------------------------------------

test("a start that cannot succeed (the database failed) is not dressed up as a WhatsApp outage", (t) => {
  const host = fakeHost({ statusValue: "connecting", startable: false });
  const watch = watching(t, host, tempFile(t));
  awake(watch, host, ALERT_AFTER_MS * 3);
  assert.deepEqual(host.forced, []);
  assert.deepEqual(host.alerts, [], "nor told as one");
  assert.equal(watch.hint(), null);
});

test("a credentials file gone from under a session says so, and how out if it is gone for good", () => {
  const err = new CredentialsReadError("ENOENT");
  assert.equal(err.message, "The stored credentials file is missing.");
  assert.match(err.fix, /wazap logout`, then link again/);
});

// The fifth review pass ------------------------------------------------------------

test("missing credentials stay a dropped link across the give-up restart, and a logout ends it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { svc, dataDir } = serviceWatch(t);
  assert.equal(svc.readAccount(), "unreadable");
  const record = join(dataDir, "accounts", "default", "link.json");
  assert.equal(existsSync(record), true, "the open outage is on disk");
  // The process the supervisor starts after the give-up exit knows no account, only the record.
  const next = openService(WhatsAppService, offlineConfig("wazap-link-next-", { dataDir }));
  t.after(() => next.stop());
  assert.equal(next.readAccount(), "unreadable", "still retried, not not_linked");
  assert.equal(next.getStatus().status, "disconnected");

  const { logoutAccount } = await import("../dist/logout.js");
  t.mock.timers.reset();
  assert.equal(await logoutAccount(dataDir, "default"), "not_linked");
  assert.equal(existsSync(record), false, "the logout takes the record with the session");
  const fresh = openService(WhatsAppService, offlineConfig("wazap-link-fresh-", { dataDir }));
  t.after(() => fresh.stop());
  assert.equal(fresh.readAccount(), null);
  assert.equal(fresh.getStatus().status, "not_linked", "now a new link is what it needs");
});

// The sixth review pass ------------------------------------------------------------

test("a clean stop keeps a credentials-missing outage, and a stale record of one still counts", (t) => {
  const file = tempFile(t);
  const host = fakeHost({ statusValue: "connected" });
  const first = new LinkMonitor(host, file, () => host.now);
  first.arm();
  setStatus(first, host, "disconnected");
  first.noteCredentialsMissing();
  first.dispose(true); // `wazap service restart` within the first minutes
  assert.equal(JSON.parse(readFileSync(file, "utf8")).credentials_missing, true);

  const later = fakeHost({ now: host.now + 86_400_000 }); // a reboot that took a day
  const second = watching(t, later, file);
  assert.equal(second.outageOpen(), true, "the next process still knows the account had a session");
  assert.equal(Date.parse(second.info().down_since) >= later.now - 1000, true, "its clock starts with this process");

  setStatus(second, later, "connected");
  assert.equal(second.outageOpen(), false);
  assert.equal(existsSync(file), true, "only the last outage is left on record");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).credentials_missing, undefined);
});

test("a new link forgets a credentials-missing outage", (t) => {
  const file = tempFile(t);
  const host = fakeHost({ statusValue: "connected" });
  const watch = watching(t, host, file);
  setStatus(watch, host, "disconnected");
  watch.noteCredentialsMissing();
  watch.forgetSession();
  assert.equal(watch.outageOpen(), false);
  assert.equal(existsSync(file), false);
});

// The seventh review pass ----------------------------------------------------------

test("a credentials-missing outage leaves the way out to last_error, even past its alert and the give-up", (t) => {
  const host = fakeHost({ statusValue: "connected" });
  const watch = watching(t, host, tempFile(t));
  setStatus(watch, host, "disconnected");
  watch.noteCredentialsMissing();
  awake(watch, host, ALERT_AFTER_MS + WATCH_TICK_MS);
  assert.equal(watch.info().alerted, "disconnected");
  assert.equal(watch.hint(), null, "no 'do not link again' beside a fix that may need a new link");
});

test("the give-up line keeps the missing-credentials fix", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { svc } = serviceWatch(t);
  svc.reconnectAttempts = 10;
  svc.readAccount();
  assert.match(svc.getStatus().last_error, /could not be reached after 10 attempts/);
  assert.match(svc.getStatus().last_error, /run `wazap logout`, then link again/);
});
