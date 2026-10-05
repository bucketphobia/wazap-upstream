/**
 * WAZAP_WEBHOOK_AUTH: a header the receiver expects beside wazap's signature
 * (Cursor Automations' bearer token, n8n's header auth). `Bearer <token>` goes
 * out as Authorization, `<Header-Name>: <value>` as that header; an account's
 * `webhook_auth` wins; the value is a credential, so no error, log line,
 * status or config line repeats it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { AccountRegistry } from "../dist/accounts.js";
import { WebhookSink, parseWebhookAuth, readWebhookSettings, webhookSignatureMatches } from "../dist/webhook.js";

const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const SECRET = "webhook-test-secret";
const TOKEN = "tok-4f9c2e7a1b";
const WEBHOOK_KEYS = [
  "WAZAP_WEBHOOK",
  "WAZAP_WEBHOOK_URL",
  "WAZAP_WEBHOOK_SECRET",
  "WAZAP_WEBHOOK_EVENTS",
  "WAZAP_WEBHOOK_AUTH",
  "WAZAP_WEBHOOK_CHATS",
  "WAZAP_WEBHOOK_TAG",
  "WAZAP_WEBHOOK_COALESCE",
  "WAZAP_WEBHOOK_RETRY_401",
];

function dataDir() {
  return mkdtempSync(join(tmpdir(), "wazap-webhook-auth-"), { mode: 0o700 });
}

function wazap(dir, args, { input = "", env = {} } = {}) {
  const base = { ...process.env, WAZAP_NO_UPDATE_CHECK: "1", WAZAP_TRANSCRIBE: "off" };
  for (const key of WEBHOOK_KEYS) delete base[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args, "--data-dir", dir], { env: { ...base, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** A receiver that records each request's headers and body, and answers `status`. */
async function receiver(status = 204) {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(status).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () => new Promise((done) => server.close(done)),
  };
}

function readyEnv(url, auth) {
  const env = { WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_URL: url, WAZAP_WEBHOOK_SECRET: SECRET };
  return auth === undefined ? env : { ...env, WAZAP_WEBHOOK_AUTH: auth };
}

const PAYLOAD = {
  event: "connection",
  status: "linked",
  timestamp: "2026-09-23T10:00:00.000Z",
  account_id: "default",
  account_name: "default",
};

test("a bare value goes out as Authorization; a Header-Name: value line as that header", () => {
  assert.equal(parseWebhookAuth(""), null);
  assert.equal(parseWebhookAuth("   "), null);
  assert.deepEqual(parseWebhookAuth(`Bearer ${TOKEN}`), { name: "Authorization", value: `Bearer ${TOKEN}` });
  assert.deepEqual(parseWebhookAuth(`  Bearer ${TOKEN}  `), { name: "Authorization", value: `Bearer ${TOKEN}` });
  assert.deepEqual(parseWebhookAuth(`X-Api-Key: ${TOKEN}`), { name: "X-Api-Key", value: TOKEN });
  assert.deepEqual(parseWebhookAuth(`Authorization: Basic dXNlcjpwYXNz`), { name: "Authorization", value: "Basic dXNlcjpwYXNz" });
  // A space before the colon means it is a value, not a header line.
  assert.deepEqual(parseWebhookAuth("Bearer a:b"), { name: "Authorization", value: "Bearer a:b" });
});

test("a header wazap sets itself, a bad name, an empty value or a line break is refused, without repeating the value", () => {
  const cases = [
    `X-Wazap-Signature: ${TOKEN}`,
    `content-type: ${TOKEN}`,
    `User-Agent: ${TOKEN}`,
    "X-Api-Key:",
    `Bearer ${TOKEN}\r\nX-Evil: 1`,
    `X-Api-Key: ${TOKEN}\nX-Evil: 1`,
    `Bad(Name): ${TOKEN}`,
  ];
  for (const raw of cases) {
    assert.throws(
      () => parseWebhookAuth(raw),
      (err) => {
        assert.equal(err.code, "INVALID_ID", raw);
        assert.ok(!err.message.includes(TOKEN) && !(err.fix ?? "").includes(TOKEN), `the refusal repeats the value: ${raw}`);
        return true;
      },
      raw
    );
  }
});

test("the setting is read from WAZAP_WEBHOOK_AUTH, an account's webhook_auth wins, and a bad one makes the webhook invalid", () => {
  const url = "https://example.com/hook";
  assert.equal(readWebhookSettings(readyEnv(url)).auth, undefined);
  assert.deepEqual(readWebhookSettings(readyEnv(url, `Bearer ${TOKEN}`)).auth, { name: "Authorization", value: `Bearer ${TOKEN}` });
  assert.deepEqual(readWebhookSettings(readyEnv(url, `Bearer ${TOKEN}`), { auth: "X-Api-Key: other" }).auth, {
    name: "X-Api-Key",
    value: "other",
  });
  const invalid = readWebhookSettings(readyEnv(url, `X-Wazap-Signature: ${TOKEN}`));
  assert.equal(invalid.kind, "invalid");
  assert.ok(!invalid.detail.includes(TOKEN));
});

test("a POST carries the auth header beside the signature, and without the setting carries none", async (t) => {
  const hook = await receiver();
  t.after(() => hook.close());

  const withAuth = new WebhookSink(readyEnv(hook.url, `Bearer ${TOKEN}`), { retryDelays: [] });
  assert.deepEqual(await withAuth.attempt(PAYLOAD, withAuth.settings()), { ok: true, status: 204 });
  const named = new WebhookSink(readyEnv(hook.url, `X-Api-Key: ${TOKEN}`), { retryDelays: [] });
  assert.deepEqual(await named.attempt(PAYLOAD, named.settings()), { ok: true, status: 204 });
  const without = new WebhookSink(readyEnv(hook.url), { retryDelays: [] });
  assert.deepEqual(await without.attempt(PAYLOAD, without.settings()), { ok: true, status: 204 });

  const [first, second, third] = hook.received;
  assert.equal(first.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(webhookSignatureMatches(first.body, SECRET, first.headers["x-wazap-signature"]), true);
  assert.equal(second.headers["x-api-key"], TOKEN);
  assert.equal(second.headers.authorization, undefined);
  assert.equal(third.headers.authorization, undefined);
  assert.equal(third.headers["x-api-key"], undefined);
});

test("an account's webhook_auth goes with that account's POSTs", async (t) => {
  const hook = await receiver();
  t.after(() => hook.close());
  const account = { id: "work", name: "Work", webhook_auth: `Bearer ${TOKEN}` };
  const sink = new WebhookSink(readyEnv(hook.url, "Bearer global"), { retryDelays: [], account });
  assert.deepEqual(await sink.sendTest(), { ok: true });
  assert.equal(hook.received[0].headers.authorization, `Bearer ${TOKEN}`);
});

test("a failure never carries the auth value, however the error around it was worded", async () => {
  // A failure line keeps an error's code, and a token written like one is a code.
  const CODE_LIKE = "SECRETTOKEN42";
  const sink = new WebhookSink(readyEnv("https://example.com/hook", `Bearer ${CODE_LIKE}`), {
    retryDelays: [],
    post: async () => {
      const err = new Error(`request with Authorization: Bearer ${CODE_LIKE} failed`);
      err.code = CODE_LIKE;
      throw err;
    },
  });
  const result = await sink.attempt(PAYLOAD, sink.settings());
  assert.equal(result.ok, false);
  assert.match(result.error, /^could not reach example\.com/);
  assert.ok(!result.error.includes(CODE_LIKE), result.error);

  const refusing = new WebhookSink(readyEnv("https://example.com/hook", `Bearer ${TOKEN}`), {
    retryDelays: [],
    post: async () => new Response(null, { status: 401 }),
  });
  const refused = await refusing.attempt(PAYLOAD, refusing.settings());
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 401);
  assert.equal(refused.retry, false);
  assert.ok(!refused.error.includes(TOKEN));
});

test("accounts.json keeps a valid webhook_auth, refuses a bad one without repeating it, and clears it", () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  const id = registry.all()[0].id;
  registry.setWebhook(id, { auth: `  Bearer ${TOKEN}  ` });
  assert.equal(AccountRegistry.load(dir).all()[0].webhook_auth, `Bearer ${TOKEN}`);

  assert.throws(
    () => AccountRegistry.load(dir).setWebhook(id, { auth: `X-Wazap-Event: ${TOKEN}` }),
    (err) => err.code === "INVALID_ID" && !err.message.includes(TOKEN)
  );

  const file = join(dir, "accounts.json");
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  onDisk.accounts[0].webhook_auth = `Host: ${TOKEN}`;
  writeFileSync(file, JSON.stringify(onDisk));
  assert.throws(
    () => AccountRegistry.load(dir),
    (err) => err.code === "INVALID_ID" && /webhook_auth/.test(err.message) && !err.message.includes(TOKEN)
  );
  onDisk.accounts[0].webhook_auth = `Bearer ${TOKEN}`;
  writeFileSync(file, JSON.stringify(onDisk));

  AccountRegistry.load(dir).clearWebhookAuth(id);
  assert.equal(AccountRegistry.load(dir).all()[0].webhook_auth, undefined);
  AccountRegistry.load(dir).setWebhook(id, { auth: `Bearer ${TOKEN}` });
  AccountRegistry.load(dir).clearWebhook(id);
  assert.equal(AccountRegistry.load(dir).all()[0].webhook_auth, undefined, "webhook off --account clears it with the rest");
});

test("config webhook auth stores what was typed without printing it, config shows it masked, webhook test sends it, no-auth drops it", async (t) => {
  const hook = await receiver();
  t.after(() => hook.close());
  const dir = dataDir();
  const on = await wazap(dir, ["config", "webhook", "on"], { input: `${SECRET}\n`, env: { WAZAP_WEBHOOK_URL: hook.url } });
  assert.equal(on.code, 0, on.stderr);

  const set = await wazap(dir, ["config", "webhook", "auth"], { input: `Bearer ${TOKEN}\n` });
  assert.equal(set.code, 0, set.stderr);
  assert.ok(!set.stdout.includes(TOKEN) && !set.stderr.includes(TOKEN), "the value must not be printed");
  assert.match(set.stderr, /webhook auth: Authorization goes with every POST/);
  assert.equal(parse(readFileSync(join(dir, ".env"), "utf8")).WAZAP_WEBHOOK_AUTH, `Bearer ${TOKEN}`);

  const shown = await wazap(dir, ["config"]);
  assert.ok(!shown.stderr.includes(TOKEN) && !shown.stdout.includes(TOKEN));
  assert.match(shown.stderr, /^auth: Authorization /m);

  const probed = await wazap(dir, ["webhook", "test"]);
  assert.equal(probed.code, 0, probed.stderr);
  assert.equal(hook.received.at(-1).headers.authorization, `Bearer ${TOKEN}`);

  const status = await wazap(dir, ["status", "--json"]);
  assert.ok(!status.stdout.includes(TOKEN) && !status.stderr.includes(TOKEN), "status must not print the value");

  const dropped = await wazap(dir, ["config", "webhook", "no-auth"]);
  assert.equal(dropped.code, 0, dropped.stderr);
  assert.equal(parse(readFileSync(join(dir, ".env"), "utf8")).WAZAP_WEBHOOK_AUTH, "");
  const again = await wazap(dir, ["webhook", "test"]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(hook.received.at(-1).headers.authorization, undefined);
});

test("config webhook auth refuses the value as an argument, an empty answer, and a header wazap sets itself", async () => {
  const dir = dataDir();
  const asArgument = await wazap(dir, ["config", "webhook", "auth", `Bearer-${TOKEN}`]);
  assert.notEqual(asArgument.code, 0);
  assert.match(asArgument.stderr, /never a command-line argument/);

  const empty = await wazap(dir, ["config", "webhook", "auth"], { input: "\n" });
  assert.notEqual(empty.code, 0);
  assert.match(empty.stderr, /Nothing was typed/);

  const reserved = await wazap(dir, ["config", "webhook", "auth"], { input: `X-Wazap-Signature: ${TOKEN}\n` });
  assert.notEqual(reserved.code, 0);
  assert.ok(!reserved.stderr.includes(TOKEN) && !reserved.stdout.includes(TOKEN));
  assert.equal(parse(readFileSync(join(dir, ".env"), { encoding: "utf8", flag: "a+" })).WAZAP_WEBHOOK_AUTH, undefined);
});

test("config webhook auth --account stores it on that account, and no-auth --account drops only that", async () => {
  const dir = dataDir();
  const added = await wazap(dir, ["account", "add", "work"]);
  assert.equal(added.code, 0, added.stderr);
  const set = await wazap(dir, ["config", "webhook", "auth", "--account", "work"], { input: `X-Api-Key: ${TOKEN}\n` });
  assert.equal(set.code, 0, set.stderr);
  assert.ok(!set.stderr.includes(TOKEN));
  assert.match(set.stderr, /X-Api-Key goes with every POST for work/);
  const work = () => AccountRegistry.load(dir).all().find((account) => account.id === "work");
  assert.equal(work().webhook_auth, `X-Api-Key: ${TOKEN}`);

  const dropped = await wazap(dir, ["config", "webhook", "no-auth", "--account", "work"]);
  assert.equal(dropped.code, 0, dropped.stderr);
  assert.equal(work().webhook_auth, undefined);
});
