import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse } from "dotenv";

import { offerWrites } from "../dist/cli.js";
import { encodeEnvValue, setEnvSetting } from "../dist/settings.js";
import { childEnv } from "./helpers.mjs";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function wazap(dataDir, args, env = {}) {
  return run(process.execPath, [binary, ...args, "--data-dir", dataDir], {
    env: childEnv(env),
  });
}

function dataDir() {
  return mkdtempSync(join(tmpdir(), "wazap-settings-"));
}

test("config labels API recall and its processing scope without printing credentials", async () => {
  const { stderr } = await wazap(dataDir(), ["config"], {
    WAZAP_RECALL: "openai", WAZAP_EMBED_API_URL: "https://example.invalid/openai",
    WAZAP_EMBED_API_KEY: "synthetic-config-secret", WAZAP_EMBED_API_MODEL: "provider/exact-model",
    WAZAP_EMBED_API_DIMS: "3", WAZAP_EMBED_API_MIN_SIMILARITY: "0.6",
  });
  assert.match(stderr, /recall: openai/);
  assert.match(stderr, /uploads retained message text and queries/);
  assert.doesNotMatch(stderr, /synthetic-config-secret|recall: local/);
});

test("setEnvSetting replaces its own line and keeps every other one", () => {
  const dir = dataDir();
  const envFile = join(dir, ".env");
  writeFileSync(envFile, "# notes\nWAZAP_READ_TOKEN=abc\nWAZAP_READ_ONLY=1\nWAZAP_RETENTION=1\n");

  setEnvSetting(envFile, "WAZAP_READ_ONLY", "0");
  assert.equal(readFileSync(envFile, "utf8"), "# notes\nWAZAP_READ_TOKEN=abc\nWAZAP_READ_ONLY=0\nWAZAP_RETENTION=1\n");

  setEnvSetting(envFile, "WAZAP_HOST", "0.0.0.0");
  assert.equal(
    readFileSync(envFile, "utf8"),
    "# notes\nWAZAP_READ_TOKEN=abc\nWAZAP_READ_ONLY=0\nWAZAP_RETENTION=1\nWAZAP_HOST=0.0.0.0\n"
  );
});

test("setEnvSetting replaces .env in one step, so a write that fails halfway leaves the old file whole", () => {
  const dir = dataDir();
  const envFile = join(dir, ".env");
  const before = "WAZAP_READ_TOKEN=abc\nWAZAP_READ_ONLY=1\n";
  writeFileSync(envFile, before, { mode: 0o644 });

  const write = fs.writeFileSync;
  // A few bytes land, then the disk is full.
  fs.writeFileSync = (file, data, options) => {
    write(file, String(data).slice(0, 10), options);
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => setEnvSetting(envFile, "WAZAP_READ_ONLY", "0"), /ENOSPC/);
  } finally {
    fs.writeFileSync = write;
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(envFile, "utf8"), before, "a failed write must not truncate the settings");

  setEnvSetting(envFile, "WAZAP_READ_ONLY", "0");
  assert.equal(readFileSync(envFile, "utf8"), "WAZAP_READ_TOKEN=abc\nWAZAP_READ_ONLY=0\n");
  assert.equal(statSync(envFile).mode & 0o777, 0o600, "the replaced .env is the owner's alone");
  assert.deepEqual(readdirSync(dir), [".env"], "no temp file is left next to it");
});

test("setEnvSetting matches a line however it was spaced, instead of adding a second one", () => {
  const envFile = join(dataDir(), ".env");
  writeFileSync(envFile, "A=1\nWAZAP_READ_ONLY = 1\nB=2\n");
  setEnvSetting(envFile, "WAZAP_READ_ONLY", "0");
  assert.equal(readFileSync(envFile, "utf8"), "A=1\nWAZAP_READ_ONLY=0\nB=2\n");
});

test("setEnvSetting removes every duplicate, because dotenv lets the last one win", () => {
  const envFile = join(dataDir(), ".env");
  writeFileSync(envFile, "WAZAP_READ_ONLY=0\nWAZAP_HOST=1.2.3.4\nexport WAZAP_READ_ONLY=0\n");
  setEnvSetting(envFile, "WAZAP_READ_ONLY", "1");
  assert.equal(readFileSync(envFile, "utf8"), "WAZAP_READ_ONLY=1\nWAZAP_HOST=1.2.3.4\n");
});

test("setEnvSetting creates the file when the data dir has no .env yet", () => {
  const envFile = join(dataDir(), ".env");
  setEnvSetting(envFile, "WAZAP_READ_ONLY", "1");
  assert.equal(readFileSync(envFile, "utf8"), "WAZAP_READ_ONLY=1\n");
});

test("encodeEnvValue quotes what dotenv 16 would otherwise cut or trim", () => {
  assert.equal(encodeEnvValue("on"), "on");
  assert.equal(encodeEnvValue("0.0.0.0"), "0.0.0.0");
  assert.equal(encodeEnvValue("http://127.0.0.1:9/hook"), "http://127.0.0.1:9/hook");
  assert.equal(encodeEnvValue("p@ss#word"), "'p@ss#word'");
  assert.equal(encodeEnvValue("a b"), "'a b'");
  assert.equal(encodeEnvValue('say "hi"'), `'say "hi"'`);
  assert.equal(encodeEnvValue("it's"), `"it's"`);
  assert.equal(encodeEnvValue("  pad  "), "'  pad  '");
});

test("setEnvSetting round-trips #, spaces and quotes through dotenv.parse", () => {
  const cases = [
    ["plain", "plain"],
    ["p@ss#word", "p@ss#word"],
    ["hash#and more", "hash#and more"],
    ['say "hi" #now', 'say "hi" #now'],
    ["it's a secret", "it's a secret"],
    ["  padded  ", "  padded  "],
    ["a\\b", "a\\b"],
    ["line1\nline2", "line1\nline2"],
  ];
  for (const [raw] of cases) {
    const envFile = join(dataDir(), ".env");
    setEnvSetting(envFile, "WAZAP_WEBHOOK_SECRET", raw);
    const parsed = parse(readFileSync(envFile, "utf8"));
    assert.equal(parsed.WAZAP_WEBHOOK_SECRET, raw, raw);
  }
});

const ANSWERS = [
  ["--writes", { writesAnswer: true, assumeYes: false }, "WAZAP_READ_ONLY=0\n"],
  ["--no-writes", { writesAnswer: false, assumeYes: false }, "WAZAP_READ_ONLY=1\n"],
  ["--yes", { writesAnswer: null, assumeYes: true }, null],
  ["no TTY and no flag", { writesAnswer: null, assumeYes: false }, null],
];

for (const [name, flags, expected] of ANSWERS) {
  test(`login with ${name} does not prompt, and ${expected === null ? "leaves .env alone" : "persists the answer"}`, async () => {
    const dir = dataDir();
    await offerWrites({ dataDir: dir, ...flags });
    assert.equal(existsSync(join(dir, ".env")) ? readFileSync(join(dir, ".env"), "utf8") : null, expected);
  });
}

test("config without a writes setting says on (default), matching readOnlySetting(undefined)", async () => {
  const { stderr } = await wazap(dataDir(), ["config"]);
  assert.match(stderr, /writes: on \(default\)/);
  assert.ok(!stderr.includes("Write tools are not registered"), "on must not be described as off");
});

test("config writes off persists the setting, and config reads it back from .env", async () => {
  const dir = dataDir();
  const off = await wazap(dir, ["config", "writes", "off"]);
  assert.match(off.stderr, /writes: off/);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "WAZAP_READ_ONLY=1\n");

  const shown = await wazap(dir, ["config"]);
  assert.match(shown.stderr, /writes: off \(\.env\)/);
  assert.match(shown.stderr, /Write tools are not registered/);
  assert.match(shown.stderr, /wazap config writes on/);
  assert.match(shown.stderr, new RegExp(`data dir: ${dir} \\(flag\\)`));
  assert.match(shown.stderr, /transport: stdio \(default\)/);
  assert.match(shown.stderr, /rate limit: 20 writes\/minute \(default\)/);

  const on = await wazap(dir, ["config", "writes", "on"]);
  assert.match(on.stderr, /writes: on/);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "WAZAP_READ_ONLY=0\n");
  assert.match((await wazap(dir, ["config"])).stderr, /writes: on \(\.env\)/);
});

test("config shows the rate limit the account actually gets, and says when accounts.json set it", async () => {
  const dir = dataDir();
  assert.match((await wazap(dir, ["config"])).stderr, /rate limit: 20 writes\/minute \(default\)/);

  const account = (rate_limit) =>
    writeFileSync(
      join(dir, "accounts.json"),
      JSON.stringify({ v: 2, default: "default", accounts: [{ id: "default", name: "default", enabled: true, owner: null, rate_limit }] })
    );
  account(5);
  const five = (await wazap(dir, ["config"])).stderr;
  assert.match(five, /rate limit: 5 writes\/minute \(accounts\.json\)/);
  assert.doesNotMatch(five, /20 writes\/minute/);

  account(0);
  assert.match((await wazap(dir, ["config"])).stderr, /rate limit: off \(accounts\.json\)/);
});

test("the flag beats the environment, which beats .env", async () => {
  const dir = dataDir();
  await wazap(dir, ["config", "writes", "on"]);

  assert.match((await wazap(dir, ["config", "--read-only"])).stderr, /writes: off \(flag\)/);
  assert.match((await wazap(dir, ["config"], { WAZAP_READ_ONLY: "1" })).stderr, /writes: off \(env\)/);
  assert.match((await wazap(dir, ["config"])).stderr, /writes: on \(\.env\)/);
});

test("status reflects the persisted writes setting", async () => {
  const dir = dataDir();
  await wazap(dir, ["config", "writes", "off"]);
  assert.match((await wazap(dir, ["status"])).stderr, /writes: off \(\.env\)/);
});

test("config rejects a setting it does not know", async () => {
  const dir = dataDir();
  await assert.rejects(wazap(dir, ["config", "writes", "maybe"]), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /wazap config writes on\|off/);
    return true;
  });
});
