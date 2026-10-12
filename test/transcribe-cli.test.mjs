/**
 * The transcription CLI, driven as a user drives it. Every assertion here exists
 * because the API key must reach `.env` and nothing else: not stdout, not stderr,
 * not `status`, not `status --json`, and never a command-line argument.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { downloadTranscribeModel } from "../dist/cli.js";

const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const KEY = "sk-live-ABCD1234EFGH5678";

function dataDir() {
  return mkdtempSync(join(tmpdir(), "wazap-transcribe-cli-"), { mode: 0o700 });
}

/** Nothing the machine running the suite has configured may reach the child. */
function childEnv(extra) {
  const env = { ...process.env, WAZAP_NO_UPDATE_CHECK: "1" };
  for (const name of Object.keys(env))
    if (name.startsWith("WAZAP_TRANSCRIBE") || name.startsWith("WAZAP_WHISPER")) delete env[name];
  delete env.OPENAI_API_KEY;
  return { ...env, ...extra };
}

function wazap(dir, args, { input = "", env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args, "--data-dir", dir], { env: childEnv(env) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function envFile(dir) {
  return readFileSync(join(dir, ".env"), "utf8");
}

/** Every file under the data dir, so a leak anywhere in it is visible. */
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

test("the API key is written to .env at 0600 and shows up nowhere else", async () => {
  const dir = dataDir();
  const { code, stdout, stderr } = await wazap(dir, ["config", "transcribe", "openai"], { input: `${KEY}\n` });

  assert.equal(code, 0);
  assert.match(envFile(dir), /^WAZAP_TRANSCRIBE_API_KEY=sk-live-ABCD1234EFGH5678$/m);
  assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);

  assert.ok(!stdout.includes(KEY) && !stderr.includes(KEY), "the key must not be printed");
  assert.ok(!stdout.includes("ABCD1234") && !stderr.includes("ABCD1234"), "not even most of it");
  assert.match(stderr, /✓ transcribe: openai/);

  const carrying = files(dir).filter((path) => readFileSync(path, "utf8").includes(KEY));
  assert.deepEqual(carrying, [join(dir, ".env")], "only .env may hold the key");
});

test("a key pasted with its quotes and spaces lands in .env as the key alone", async () => {
  const dir = dataDir();
  await wazap(dir, ["config", "transcribe", "openai"], { input: `  "sk-quoted-7777"  \n` });
  assert.match(envFile(dir), /^WAZAP_TRANSCRIBE_API_KEY=sk-quoted-7777$/m);
});

test("status and status --json mask the key", async () => {
  const dir = dataDir();
  await wazap(dir, ["config", "transcribe", "openai"], { input: `${KEY}\n` });

  const human = await wazap(dir, ["status"]);
  assert.match(human.stderr, /✓ transcribe: openai \(gpt-4o-mini-transcribe at api\.openai\.com\)/);
  assert.match(human.stderr, /✓ api key: set \(…5678\)/);
  assert.ok(!human.stderr.includes(KEY) && !human.stdout.includes(KEY));

  const json = await wazap(dir, ["status", "--json"]);
  const report = JSON.parse(json.stdout);
  const check = report.checks.find((entry) => entry.name === "api key");
  assert.equal(check.detail, "set (…5678)");
  assert.ok(!json.stdout.includes(KEY) && !json.stderr.includes(KEY));
});

test("config with no arguments reports the provider and the masked key", async () => {
  const dir = dataDir();
  await wazap(dir, ["config", "transcribe", "openai"], { input: `${KEY}\n` });

  const { stderr, stdout } = await wazap(dir, ["config"]);
  assert.match(stderr, /transcribe: openai \(\.env\)/);
  assert.match(stderr, /api key: set \(…5678\)/);
  assert.ok(!stderr.includes(KEY) && !stdout.includes(KEY));
});

test("config transcribe off persists, and config reads it back", async () => {
  const dir = dataDir();
  const off = await wazap(dir, ["config", "transcribe", "off"]);
  assert.equal(off.code, 0);
  assert.match(off.stderr, /✓ transcribe: off/);
  assert.match(envFile(dir), /^WAZAP_TRANSCRIBE=off$/m);
  assert.match((await wazap(dir, ["config"])).stderr, /transcribe: off \(\.env\)/);
});

test("the key is refused as a command-line argument, and nothing is written", async () => {
  const dir = dataDir();
  const { code, stderr } = await wazap(dir, ["config", "transcribe", "openai", "sk-whatever"]);
  assert.equal(code, 1);
  assert.match(stderr, /never a command-line argument/);
  assert.match(stderr, /shell history/);
  assert.match(stderr, /ps/);
  assert.deepEqual(files(dir), [], "a refused command must leave the data dir untouched");
});

test("transcribe test with no provider configured names the command that configures one", async () => {
  const dir = dataDir();
  const audio = join(dir, "note.ogg");
  writeFileSync(audio, "not really audio");
  const { code, stderr } = await wazap(dir, ["transcribe", "test", audio]);
  assert.equal(code, 1);
  assert.match(stderr, /✗ transcription is off/);
  assert.match(stderr, /wazap config transcribe local/);
});

test("transcribe download refuses an unknown model by naming the ones it knows", async () => {
  const { code, stderr } = await wazap(dataDir(), ["transcribe", "download", "--model", "nope"]);
  assert.equal(code, 1);
  assert.match(stderr, /Unknown whisper model "nope"/);
  assert.match(stderr, /turbo, large-v3, medium/);
});

test("a model already on disk is reported and refetched by nothing", async () => {
  const modelsDir = join(dataDir(), "models");
  mkdirSync(modelsDir);
  const payload = Buffer.alloc(2 * 1024 * 1024, 7);
  const spec = {
    alias: "turbo",
    file: "fake-model.bin",
    bytes: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"),
  };
  writeFileSync(join(modelsDir, spec.file), payload);

  // No stub server stands in for Hugging Face here: the download the file would
  // otherwise trigger is a 404 on a name that does not exist upstream, so a
  // passing assertion is also proof that nothing was fetched.
  const said = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => (said.push(String(chunk)), true);
  try {
    await downloadTranscribeModel({ modelsDir }, spec);
  } finally {
    process.stderr.write = real;
  }
  assert.match(said.join(""), /✓ fake-model\.bin \(2 MiB\) already present/);
});

/** An OpenAI-compatible endpoint on loopback, which requireSafeUrl allows over http. */
async function stubApi(onRequest) {
  const server = createServer((req, res) => {
    onRequest(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: "Bună ziua, sunt Ioana.", language: "ro", duration: 6 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() };
}

test("transcribe test prints the provider, the masked key and the text", async () => {
  const dir = dataDir();
  const seen = [];
  const api = await stubApi((req) => seen.push(req.headers.authorization));
  try {
    const pointed = { WAZAP_TRANSCRIBE_URL: api.url };
    await wazap(dir, ["config", "transcribe", "openai"], { input: `${KEY}\n`, env: pointed });
    const audio = join(dir, "note.ogg");
    writeFileSync(audio, "not really audio");
    const { code, stdout, stderr } = await wazap(dir, ["transcribe", "test", audio], { env: pointed });

    assert.equal(code, 0);
    assert.deepEqual(seen, [`Bearer ${KEY}`], "the key does travel to the endpoint");
    assert.match(stderr, /provider {2}openai \(127\.0\.0\.1:\d+\)/);
    assert.match(stderr, /model {5}gpt-4o-mini-transcribe/);
    assert.match(stderr, /key {7}set \(…5678\)/);
    assert.match(stderr, /language {2}auto/);
    assert.match(stderr, /✓ transcribed in \d+\.\ds · ro · 0:06/);
    assert.match(stderr, /"Bună ziua, sunt Ioana\."/);
    assert.ok(!stderr.includes(KEY) && !stdout.includes(KEY), "printing the run must not print the key");
  } finally {
    api.close();
  }
});

test("custom transcription auth needs no prompted key and reports only set", async () => {
  const dir = dataDir();
  const secret = "private-credential-5678";
  const env = { WAZAP_TRANSCRIBE_AUTH: `X-Api-Key: ${secret}` };
  const configured = await wazap(dir, ["config", "transcribe", "openai"], { env });
  assert.equal(configured.code, 0, configured.stderr);
  assert.equal(envFile(dir).includes("WAZAP_TRANSCRIBE_API_KEY"), false);
  for (const args of [["config"], ["status"], ["status", "--json"]]) {
    const result = await wazap(dir, args, { env });
    assert.equal(`${result.stdout} ${result.stderr}`.includes(secret), false);
    assert.equal(`${result.stdout} ${result.stderr}`.includes("5678"), false);
    if (args.includes("--json")) {
      const checks = JSON.parse(result.stdout).checks;
      assert.deepEqual(
        checks.find((check) => check.name === "auth"),
        { name: "auth", state: "ok", detail: "set" }
      );
      assert.equal(
        checks.some((check) => check.name === "api key"),
        false
      );
    } else assert.match(result.stderr, /auth: set/);
  }
});

test("transcribe test sends custom auth without printing any of it", async () => {
  const secret = "custom-private-5678";
  const seen = [];
  const api = await stubApi((req) => { seen.push(req.headers["x-api-key"]); req.resume(); });
  try {
    const dir = dataDir();
    const audio = join(dir, "note.ogg");
    writeFileSync(audio, "not really audio");
    const result = await wazap(dir, ["transcribe", "test", audio], { env: {
      WAZAP_TRANSCRIBE: "openai", WAZAP_TRANSCRIBE_AUTH: `X-Api-Key: ${secret}`, WAZAP_TRANSCRIBE_URL: api.url,
    } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(seen, [secret]);
    assert.match(result.stderr, /auth {6}set/);
    assert.equal(`${result.stdout} ${result.stderr}`.includes(secret), false);
    assert.equal(`${result.stdout} ${result.stderr}`.includes("5678"), false);
  } finally { api.close(); }
});

test("invalid custom auth is secret-safe and config writes nothing", async () => {
  const secret = "custom-private-5678";
  for (const args of [["config", "transcribe", "openai"], ["config"], ["status", "--json"]]) {
    const dir = dataDir();
    const result = await wazap(dir, args, { env: { WAZAP_TRANSCRIBE_AUTH: `Invalid@Header: ${secret}` } });
    assert.match(`${result.stdout} ${result.stderr}`, /WAZAP_TRANSCRIBE_AUTH/);
    assert.equal(`${result.stdout} ${result.stderr}`.includes(secret), false);
    assert.equal(files(dir).some((file) => file.endsWith(".env")), false);
  }
});
