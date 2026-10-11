/**
 * AccountHub: one process, one service per enabled account. Status, give-up
 * and store lookup stay independent. /healthz lists every live account to a token holder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";

import { AccountHub } from "../dist/account-hub.js";
import { AccountRegistry } from "../dist/accounts.js";
import { healthBody, startHttpEndpoint } from "../dist/server.js";
import { fakeSocket, offlineConfig } from "./helpers.mjs";

const HOME = "40700000001@s.whatsapp.net";
const WORK = "40700000002@s.whatsapp.net";
const ANA = "40700000003@s.whatsapp.net";
const DAN = "40700000004@s.whatsapp.net";

function connect(svc, { id, name }) {
  const sock = fakeSocket();
  svc.sockClient = sock;
  svc.wireEvents(sock, ++svc.generation);
  svc.account = { id, name, number: id.split("@")[0] };
  svc.status = "connected";
  svc.initialSyncDone = true;
  return sock;
}

function twoAccountHub({ workWrites } = {}) {
  const config = offlineConfig("wazap-hub-", { readOnly: false, rateLimitPerMinute: 20 });
  const registry = AccountRegistry.load(config.dataDir);
  registry.add("work", "Work");
  if (workWrites === false) registry.setWrites("work", false);
  const hub = new AccountHub(config, registry);
  const home = hub.get("default");
  const work = hub.get("work");
  const homeSock = connect(home, { id: HOME, name: "Home" });
  const workSock = connect(work, { id: WORK, name: "Work" });
  return { hub, home, work, homeSock, workSock, config };
}

function message(chat, text, { id = "M1", fromMe = false } = {}) {
  return {
    key: { remoteJid: chat, fromMe, id },
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

async function closedPort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test("two services report independent status, enabled and write_tools", () => {
  const { home, work, hub } = twoAccountHub({ workWrites: false });
  assert.equal(hub.all().length, 2);
  assert.equal(hub.default(), home);
  assert.equal(home.getStatus().account_id, "default");
  assert.equal(home.getStatus().account_name, "default");
  assert.equal(home.getStatus().enabled, true);
  assert.equal(home.getStatus().write_tools, true);
  assert.equal(home.getStatus().status, "connected");
  assert.equal(work.getStatus().account_id, "work");
  assert.equal(work.getStatus().account_name, "Work");
  assert.equal(work.getStatus().write_tools, false);
  assert.equal(work.getStatus().read_only, true);

  work.status = "disconnected";
  assert.equal(home.getStatus().status, "connected");
  assert.equal(work.getStatus().status, "disconnected");
});

test("one account giving up does not exit; both giving up does", () => {
  const { hub, home, work } = twoAccountHub();
  let exited = 0;
  hub.onGiveUp = () => {
    exited += 1;
  };

  home.reconnectAttempts = 10;
  home.scheduleReconnect("Connection Terminated");
  assert.equal(exited, 0, "the other account is still up");
  assert.equal(home.getStatus().status, "disconnected");
  assert.equal(work.getStatus().status, "connected");

  work.reconnectAttempts = 10;
  work.scheduleReconnect("Connection Terminated");
  assert.equal(exited, 1);
  assert.equal(work.getStatus().status, "disconnected");
});

test("findByChat and findByMessage look across two stores", () => {
  const { hub, homeSock, workSock, home, work } = twoAccountHub();
  homeSock.ev.emit("chats.upsert", [{ id: ANA, conversationTimestamp: Math.floor(Date.now() / 1000) }]);
  workSock.ev.emit("chats.upsert", [{ id: DAN, conversationTimestamp: Math.floor(Date.now() / 1000) }]);
  homeSock.ev.emit("messages.upsert", { type: "notify", messages: [message(ANA, "from home", { id: "H1" })] });
  workSock.ev.emit("messages.upsert", { type: "notify", messages: [message(DAN, "from work", { id: "W1" })] });

  assert.deepEqual(
    hub.findByChat(ANA).map((row) => row.id),
    ["default"]
  );
  assert.deepEqual(
    hub.findByChat(DAN).map((row) => row.id),
    ["work"]
  );
  assert.deepEqual(hub.findByChat(HOME), []);

  const homeSid = `false_${ANA}_H1`;
  const workSid = `false_${DAN}_W1`;
  assert.deepEqual(
    hub.findByMessage(homeSid).map((row) => row.id),
    ["default"]
  );
  assert.deepEqual(
    hub.findByMessage(workSid).map((row) => row.id),
    ["work"]
  );
  assert.deepEqual(hub.findByMessage("false_nobody_X"), []);

  workSock.ev.emit("chats.upsert", [{ id: ANA, conversationTimestamp: Math.floor(Date.now() / 1000) }]);
  assert.deepEqual(
    hub
      .findByChat(ANA)
      .map((row) => row.id)
      .sort(),
    ["default", "work"]
  );
  assert.equal(home.hasChat(ANA), true);
  assert.equal(work.hasChat(DAN), true);

  workSock.ev.emit("contacts.upsert", [{ id: HOME, name: "Home on work" }]);
  assert.deepEqual(hub.findByChat(HOME), [], "a contact is not a chat");
  assert.equal(work.hasChat(HOME), false);
});

test("each service has its own write bucket", () => {
  const { home, work } = twoAccountHub();
  for (let i = 0; i < 20; i++) home.writes.take();
  assert.throws(
    () => home.writes.take(),
    (err) => err.code === "RATE_LIMITED"
  );
  assert.doesNotThrow(() => work.writes.take());
});

test("disabled accounts are not started; default() falls back to the first enabled", () => {
  const config = offlineConfig("wazap-hub-disabled-", { readOnly: false });
  const registry = AccountRegistry.load(config.dataDir);
  registry.add("work", "Work");
  registry.disable("default");
  const hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  assert.equal(hub.get("default"), undefined);
  assert.equal(hub.get("work").getStatus().account_id, "work");
  assert.equal(hub.default().getStatus().account_id, "work");
  assert.equal(hub.all().length, 1);
});

test("no enabled account refuses to construct", () => {
  const config = offlineConfig("wazap-hub-empty-", { readOnly: false });
  const registry = AccountRegistry.load(config.dataDir);
  registry.disable("default");
  assert.throws(
    () => new AccountHub(config, AccountRegistry.load(config.dataDir)),
    (err) => {
      assert.equal(err.code, "INVALID_ID");
      assert.match(err.message, /No enabled account/);
      return true;
    }
  );
});

test("/healthz tells a stranger only whether it is up, and a token holder every live account", async () => {
  const { hub, config } = twoAccountHub();
  const port = await closedPort();
  const stop = new AbortController();
  await startHttpEndpoint(hub, config, {
    host: "127.0.0.1",
    port,
    credentials: [{ token: "health-read", write: false }],
    openRead: false,
    signal: stop.signal,
  });
  const health = (token) =>
    fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
  try {
    for (const token of [undefined, "not-the-token"]) {
      const anonymous = await health(token);
      const bare = await anonymous.json();
      assert.equal(anonymous.status, 200);
      assert.deepEqual(Object.keys(bare).sort(), ["ok", "since", "status"], `token ${token}: ${JSON.stringify(bare)}`);
      assert.equal(bare.ok, true);
      assert.equal(bare.status, "connected");
    }

    const res = await health("health-read");
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status, "connected");
    assert.equal(body.default.account_id, "default");
    assert.equal(body.default.account_name, undefined);
    assert.deepEqual(
      body.accounts.map((row) => row.account_id),
      ["default", "work"]
    );
    assert.equal(body.accounts[1].status, "connected");
  } finally {
    stop.abort();
  }
});

test("one live account keeps /healthz up even if the default is stalled", () => {
  const { hub, home, work } = twoAccountHub();
  home.status = "disconnected";
  home.statusSince = Date.now() - 3 * 60_000;
  const body = healthBody(hub);
  assert.equal(body.ok, true);
  assert.equal(body.status, "disconnected");
  assert.equal(body.default.account_id, "default");
  assert.equal(work.getStatus().status, "connected");
  assert.equal(body.accounts[1].status, "connected");
});

test("stop stops every live service", async () => {
  const { hub, home, work } = twoAccountHub();
  await hub.stop();
  assert.equal(home.stopped, true);
  assert.equal(work.stopped, true);
});

test("a start that throws counts toward give-up", async () => {
  const { hub, home, work } = twoAccountHub();
  let exited = 0;
  hub.onGiveUp = () => {
    exited += 1;
  };
  home.start = async () => {
    throw new Error("boom");
  };
  await hub.start();
  assert.equal(exited, 0, "the other account is still up");
  work.reconnectAttempts = 10;
  work.scheduleReconnect("Connection Terminated");
  assert.equal(exited, 1);
});
