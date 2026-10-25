import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEPRECATED_SETTINGS, RETIRED_SETTINGS, parseCli, readOnlySetting, settingWarnings, writesHints } from "../dist/config.js";

const CASES = [
  [undefined, false, "unset registers write tools; config prints writes: on (default)"],
  ["", false, "empty is not an explicit on-value"],
  ["0", false, "0 is the stored yes from login / config writes on"],
  ["false", false, "a boolean false from a bundle checkbox"],
  ["1", true],
  ["true", true],
  ["yes", true],
  ["on", true],
  ["TRUE", true],
];

for (const [value, expected, note] of CASES) {
  test(`readOnlySetting(${JSON.stringify(value)}) is ${expected}${note ? ` (${note})` : ""}`, () => {
    assert.equal(readOnlySetting(value), expected);
  });
}

test("malformed read-only settings cannot silently enable writes or echo their contents", () => {
  for (const value of ["tru", "2", "SYNTHETIC-SECRET"]) {
    assert.throws(() => readOnlySetting(value), err => {
      assert.equal(err.code, "INVALID_ID");
      assert.ok(!err.message.includes(value));
      return true;
    });
  }
});

test("writesHints stay quiet when writes are on", () => {
  assert.deepEqual(writesHints({ readOnly: false, transport: "stdio", publicUrl: null }), []);
});

test("writesHints name the enable command when writes are off", () => {
  const hints = writesHints({ readOnly: true, transport: "stdio", publicUrl: null });
  assert.equal(hints.length, 1);
  assert.match(hints[0], /Write tools are not registered/);
  assert.match(hints[0], /wazap config writes on/);
});

test("writesHints carry no bearer-token note, whatever the transport", () => {
  assert.deepEqual(writesHints({ readOnly: false, transport: "http", publicUrl: "https://wazap.example" }), []);
  const hints = writesHints({ readOnly: true, transport: "http", publicUrl: "https://wazap.example" });
  assert.equal(hints.length, 1);
  assert.doesNotMatch(hints[0], /token/i);
});

const RETIRED_VALUES = {
  WAZAP_SYNC_FULL_HISTORY: "1",
  WAZAP_RATE_LIMIT: "0",
  WAZAP_MAX_INFLIGHT: "12",
  WAZAP_MAX_INFLIGHT_TOTAL: "64",
  WAZAP_HTTP_BUDGET: "1000",
};

test("retired settings change nothing, and WAZAP_TRANSPORT=http still serves HTTP", () => {
  const keys = [...Object.keys(RETIRED_VALUES), "WAZAP_RETENTION", "WAZAP_TRANSPORT"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const dir = mkdtempSync(join(tmpdir(), "wazap-limits-config-"));
  const load = (...flags) => parseCli(["serve", ...flags, "--data-dir", dir]).config;
  const fixed = ({ transport, syncFullHistory, persistHistory, rateLimitPerMinute, maxInFlight, maxInFlightTotal, httpPostBudget }) => ({
    transport,
    syncFullHistory,
    persistHistory,
    rateLimitPerMinute,
    maxInFlight,
    maxInFlightTotal,
    httpPostBudget,
  });
  const DEFAULTS = {
    transport: "stdio",
    syncFullHistory: false,
    persistHistory: true,
    rateLimitPerMinute: 20,
    maxInFlight: 8,
    maxInFlightTotal: 32,
    httpPostBudget: 240,
  };
  try {
    for (const key of keys) delete process.env[key];
    assert.deepEqual(fixed(load()), DEFAULTS);
    assert.equal(load().retention, false);

    Object.assign(process.env, RETIRED_VALUES, { WAZAP_RETENTION: "1" });
    const configured = load();
    assert.deepEqual(fixed(configured), DEFAULTS);
    assert.equal(configured.sources.transport, "default");
    assert.equal(configured.retention, true, "WAZAP_RETENTION is still read");

    const http = load("--http");
    assert.equal(http.transport, "http");
    assert.equal(http.sources.transport, "flag");

    process.env.WAZAP_TRANSPORT = "http";
    const deprecated = load();
    assert.equal(deprecated.transport, "http", "a supervisor relying on the variable must not fall back to stdio");
    assert.equal(deprecated.sources.transport, "env");
    process.env.WAZAP_TRANSPORT = "stdio";
    assert.equal(load().transport, "stdio");
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WAZAP_PERSIST_HISTORY is still honoured: 0 keeps no messages, unset keeps them", () => {
  const previous = process.env.WAZAP_PERSIST_HISTORY;
  const dir = mkdtempSync(join(tmpdir(), "wazap-persist-config-"));
  const load = () => parseCli(["serve", "--data-dir", dir]).config;
  try {
    delete process.env.WAZAP_PERSIST_HISTORY;
    assert.equal(load().persistHistory, true);
    process.env.WAZAP_PERSIST_HISTORY = "0";
    assert.equal(load().persistHistory, false);
    assert.deepEqual(settingWarnings({ WAZAP_PERSIST_HISTORY: "0" }), [], "a privacy setting is not a retired one");
    process.env.WAZAP_PERSIST_HISTORY = "1";
    assert.equal(load().persistHistory, true);
  } finally {
    if (previous === undefined) delete process.env.WAZAP_PERSIST_HISTORY;
    else process.env.WAZAP_PERSIST_HISTORY = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each retired or deprecated setting that is set gets one warning saying what to use, and nothing else does", () => {
  assert.deepEqual(settingWarnings({}), []);
  assert.deepEqual(settingWarnings({ WAZAP_READ_ONLY: "1", WAZAP_RECALL: "local", WAZAP_NO_SHARE: "1", WAZAP_PERSIST_HISTORY: "0" }), []);
  for (const key of Object.keys(RETIRED_SETTINGS)) {
    const [line, ...rest] = settingWarnings({ [key]: "" });
    assert.deepEqual(rest, [], key);
    assert.ok(line.startsWith(`${key} is no longer read and was ignored: `), line);
  }
  for (const key of Object.keys(DEPRECATED_SETTINGS)) {
    assert.equal(RETIRED_SETTINGS[key], undefined, `${key} cannot be both deprecated and retired`);
    const [line, ...rest] = settingWarnings({ [key]: "" });
    assert.deepEqual(rest, [], key);
    assert.match(line, new RegExp(`^${key}\\b.* is deprecated and goes away in 2\\.0: `), line);
  }
  for (const http of ["http", " HTTP "]) {
    assert.deepEqual(settingWarnings({ WAZAP_TRANSPORT: http }), [
      "WAZAP_TRANSPORT=http still works but is deprecated and goes away in 2.0: pass `--http` instead, as in `wazap serve --http`.",
    ]);
  }
});

test("WAZAP_TRANSPORT set to anything but http is told stdio is the default, not to pass --http", () => {
  for (const value of ["stdio", "STDIO", "", "https"]) {
    const lines = settingWarnings({ WAZAP_TRANSPORT: value });
    assert.deepEqual(lines, ["WAZAP_TRANSPORT is deprecated and goes away in 2.0: stdio is the default; remove WAZAP_TRANSPORT."], value);
    assert.doesNotMatch(lines[0], /--http/);
  }
  assert.equal(settingWarnings(RETIRED_VALUES).length, Object.keys(RETIRED_VALUES).length);
});

test("the link-method flags land on the config: --qr picks QR, --code and --phone pick the code", () => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-login-config-"));
  try {
    const load = (...flags) => parseCli(["login", ...flags, "--data-dir", dir]).config;
    assert.deepEqual([load().loginCode, load().loginQr], [false, false]);
    assert.deepEqual([load("--qr").loginCode, load("--qr").loginQr], [false, true]);
    assert.deepEqual([load("--code").loginCode, load("--code").loginQr], [true, false]);
    assert.deepEqual([load("--phone", "+15550100").loginCode, load("--phone", "+15550100").loginQr], [true, false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("automatic iPhone import defaults off and requires an explicit true setting", () => {
  const previous = process.env.WAZAP_IMPORT_IOS;
  const dir = mkdtempSync(join(tmpdir(), "wazap-ios-optin-config-"));
  try {
    for (const value of [undefined, "", "0", "off", "false", "typo", "1", "on", "true", " YES "]) {
      if (value === undefined) delete process.env.WAZAP_IMPORT_IOS;
      else process.env.WAZAP_IMPORT_IOS = value;
      assert.equal(
        parseCli(["serve", "--data-dir", dir]).config.importIos,
        ["1", "on", "true", " YES "].includes(value),
        String(value)
      );
    }
  } finally {
    if (previous === undefined) delete process.env.WAZAP_IMPORT_IOS;
    else process.env.WAZAP_IMPORT_IOS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
