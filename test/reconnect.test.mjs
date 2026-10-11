/**
 * Regression guard for the login storm that got the account throttled.
 *
 * A dropped socket used to be retried instantly and without tearing the old one
 * down, so a persistent rejection turned into several logins per second and
 * WhatsApp stopped letting *any* new device be linked to the number. These
 * tests pin the properties that prevent that: retries are spaced, they are
 * capped, a burst of closes cannot fan out, and a superseded socket is muted.
 *
 * Run: npm test  (requires npm run build first — these drive dist/)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WhatsAppService } from "../dist/whatsapp.js";
import { openService } from "./helpers.mjs";

const RECONNECT_MAX_ATTEMPTS = 10;
/** Baileys reports a server-side termination as connectionClosed, not loggedOut. */
const CONNECTION_CLOSED = 428;
const LOGGED_OUT = 401;

function config() {
  return {
    dataDir: mkdtempSync(join(tmpdir(), "wazap-reconnect-")),
    readOnly: false,
    syncFullHistory: false,
    persistHistory: false,
    transport: "stdio",
    httpHost: "127.0.0.1",
    httpPort: 8766,
    readToken: null,
    writeToken: null,
    rateLimitPerMinute: 20,
    command: "serve",
    loginCode: false,
  };
}

/** A service whose start() never touches the network, so we observe only pacing. */
function makeService() {
  const svc = openService(WhatsAppService, config());
  const starts = [];
  svc.start = async () => {
    starts.push(true);
  };
  return { svc, starts };
}

/** Minimal stand-in for a Baileys socket: just the event surface wireEvents uses. */
function makeFakeSocket() {
  const listeners = new Map();
  let ended = false;
  return {
    ended: () => ended,
    ev: {
      on(event, fn) {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      },
      removeAllListeners(event) {
        listeners.delete(event);
      },
      emit(event, arg) {
        for (const fn of listeners.get(event) ?? []) fn(arg);
      },
    },
    end() {
      ended = true;
    },
  };
}

/** Wire a fake socket into the service exactly as start() would. */
function attach(svc, sock) {
  svc.sockClient = sock;
  const generation = ++svc.generation;
  svc.wireEvents(sock, generation);
  return generation;
}

/** How Baileys words each close: a 401 comes from WhatsApp's failure node, the rest from the socket. */
const close = (statusCode) => ({
  connection: "close",
  lastDisconnect: {
    error: { message: statusCode === LOGGED_OUT ? "Connection Failure" : "Connection Terminated", output: { statusCode } },
  },
});

test("retries follow the exponential schedule instead of firing instantly", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5); // jitter factor lands on exactly 1.0

  const { svc, starts } = makeService();
  const expected = [2_000, 4_000, 8_000, 16_000, 32_000];

  for (let i = 0; i < expected.length; i++) {
    svc.scheduleReconnect("Connection Terminated");
    t.mock.timers.tick(expected[i] - 1);
    assert.equal(starts.length, i, `retry ${i + 1} fired before ${expected[i]}ms`);
    t.mock.timers.tick(1);
    assert.equal(starts.length, i + 1, `retry ${i + 1} should have fired at ${expected[i]}ms`);
  }
});

test("past the cap it slows to one try every 30 min instead of hammering, and keeps the session", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5);

  const { svc, starts } = makeService();

  for (let i = 0; i < RECONNECT_MAX_ATTEMPTS + 5; i++) {
    svc.scheduleReconnect("Connection Terminated");
    t.mock.timers.tick(10 * 60_000); // longer than any backoff
  }

  // Ten paced retries, then the 30-minute cadence: the five ten-minute ticks after the cap reach one more.
  assert.equal(starts.length, RECONNECT_MAX_ATTEMPTS + 1, "past the cap, tries are 30 min apart");
  const status = svc.getStatus();
  assert.equal(status.status, "disconnected", "a link that cannot be reached is not an expired session");
  assert.doesNotMatch(status.last_error ?? "", /re-link|login/i, "nothing tells the operator to throw the session away");
  assert.match(status.last_error ?? "", /session is kept/i);
});

test("a burst of closes cannot fan out into parallel reconnects", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5);

  const { svc, starts } = makeService();
  const sock = makeFakeSocket();
  attach(svc, sock);

  // The old code called start() straight from this handler, and orphaned sockets
  // kept emitting closes of their own. Ten closes in one tick must cost one retry.
  for (let i = 0; i < 10; i++) sock.ev.emit("connection.update", close(CONNECTION_CLOSED));
  t.mock.timers.tick(10 * 60_000);

  assert.equal(starts.length, 1, "ten simultaneous closes produce exactly one reconnect");
  assert.equal(sock.ended(), true, "the dead socket is closed, not left dangling");
});

test("a superseded socket can no longer trigger reconnects", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5);

  const { svc, starts } = makeService();
  const old = makeFakeSocket();
  attach(svc, old);
  const fresh = makeFakeSocket();
  attach(svc, fresh); // bumps the generation, so `old` is stale

  old.ev.emit("connection.update", close(CONNECTION_CLOSED));
  t.mock.timers.tick(10 * 60_000);

  assert.equal(starts.length, 0, "the stale socket's close is ignored");
});

test("a healthy connection resets the retry budget", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5);

  const { svc, starts } = makeService();

  // Burn three retries.
  for (let i = 0; i < 3; i++) {
    svc.scheduleReconnect("Connection Terminated");
    t.mock.timers.tick(10 * 60_000);
  }
  assert.equal(starts.length, 3);

  // A real reconnect wires a fresh socket; the previous one is muted by teardown.
  const sock = makeFakeSocket();
  attach(svc, sock);
  // The `open` handler is what clears the counter.
  sock.ev.emit("connection.update", { connection: "open" });
  assert.equal(svc.getStatus().status, "connected");

  // Back to the start of the schedule, not to a 5-minute wait.
  svc.scheduleReconnect("Connection Terminated");
  t.mock.timers.tick(1_999);
  assert.equal(starts.length, 3, "still waiting");
  t.mock.timers.tick(1);
  assert.equal(starts.length, 4, "next retry is a fresh 2s, not the old backoff");
});

test("giving up asks the caller to exit, so a supervisor gets its turn", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5);

  const { svc } = makeService();
  let gaveUp = 0;
  svc.onGiveUp = () => gaveUp++;

  for (let i = 0; i < RECONNECT_MAX_ATTEMPTS; i++) {
    svc.scheduleReconnect("Connection Terminated");
    t.mock.timers.tick(10 * 60_000);
  }
  assert.equal(gaveUp, 0, "the signal must not fire while retries are left");

  svc.scheduleReconnect("Connection Terminated");
  assert.equal(gaveUp, 1, "the give-up signal fires once the budget is spent");
});

test("a 401 never asks the caller to exit: a restart cannot undo an unlink", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const { svc } = makeService();
  let gaveUp = 0;
  svc.onGiveUp = () => gaveUp++;
  const sock = makeFakeSocket();
  attach(svc, sock);

  for (let i = 0; i < RECONNECT_MAX_ATTEMPTS + 5; i++) {
    sock.ev.emit("connection.update", close(LOGGED_OUT));
    t.mock.timers.tick(10 * 60_000);
  }

  assert.equal(gaveUp, 0, "a logged-out session must keep answering SESSION_EXPIRED, not exit");
  assert.equal(svc.getStatus().status, "logged_out");
});

test("an explicit logout stops instead of retrying", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const { svc, starts } = makeService();
  const sock = makeFakeSocket();
  attach(svc, sock);

  sock.ev.emit("connection.update", close(LOGGED_OUT));
  t.mock.timers.tick(10 * 60_000);

  assert.equal(starts.length, 0, "a logged-out session must never be retried");
  assert.equal(svc.getStatus().status, "logged_out");
});
