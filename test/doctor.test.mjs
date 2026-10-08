import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { WAZAP_VERSION } from "../dist/config.js";
import { isNewer, nodeVersionCheck } from "../dist/doctor.js";
import { childEnv } from "./helpers.mjs";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

/**
 * No test may reach the npm registry, so the update check is off by default, and
 * the transcription checks are pinned off so a configured machine cannot change
 * how many checks these tests see.
 */
function status(dataDir, args = [], env = {}) {
  return run(process.execPath, [binary, "status", "--data-dir", dataDir, ...args], {
    env: childEnv({ WAZAP_TRANSCRIBE: "off", WAZAP_WEBHOOK: "off", ...env }),
  });
}

function dataDir() {
  return mkdtempSync(join(tmpdir(), "wazap-doctor-"), { mode: 0o700 });
}

const VERSIONS = [
  ["0.9.1", "0.9.0", true],
  ["0.10.0", "0.9.9", true],
  ["1.0.0", "0.99.99", true],
  ["0.9.0", "0.9.0", false],
  ["0.8.9", "0.9.0", false],
  ["0.9.0", "0.9.0-rc1", false],
];

for (const [candidate, current, expected] of VERSIONS) {
  test(`isNewer ${candidate} over ${current} is ${expected}`, () => {
    assert.equal(isNewer(candidate, current), expected);
  });
}

test("the Node floor is 22.16 on the 22 line and 24 after it; 23 lacks node:sqlite features", () => {
  for (const version of ["22.16.0", "22.22.3", "24.0.0", "24.21.0", "26.1.0"]) {
    assert.deepEqual(nodeVersionCheck(version), { name: "node", state: "ok", detail: version });
  }
  const fix = "install Node 24 LTS, or Node 22.16 or newer";
  assert.deepEqual(nodeVersionCheck("22.15.1"), { name: "node", state: "fail", detail: "22.15.1 is too old", fix });
  assert.deepEqual(nodeVersionCheck("20.19.0"), { name: "node", state: "fail", detail: "20.19.0 is too old", fix });
  assert.deepEqual(nodeVersionCheck("23.11.0"), {
    name: "node",
    state: "fail",
    detail: "23.11.0 lacks node:sqlite features wazap needs",
    fix,
  });
});

test("a healthy data dir passes every check it can", async () => {
  const dir = dataDir();
  chmodSync(dir, 0o700);
  const { stderr } = await status(dir);
  assert.match(stderr, /checks:/);
  assert.match(stderr, new RegExp(`✓ node: ${process.versions.node.replace(/\\./g, "\\.")}`));
  assert.match(stderr, /✓ data dir: .* \(0700, writable\)/);
  assert.match(stderr, /– lock: none/);
  assert.match(stderr, /– service: not installed$/m);
  assert.ok(!stderr.includes("wazap service install"), "unlinked status must not send the user past setup");
  assert.match(stderr, /– credentials: no account linked yet/);
  assert.match(stderr, /✓ writes: on \(default\)/);
});

test("API recall diagnostics need no local binaries and never expose API credentials", async () => {
  const { stderr } = await status(dataDir(), [], {
    WAZAP_RECALL: "openai", WAZAP_EMBED_API_URL: "https://example.invalid/openai",
    WAZAP_EMBED_API_KEY: "synthetic-diagnostic-secret", WAZAP_EMBED_API_MODEL: "provider/exact-model",
    WAZAP_EMBED_API_DIMS: "3", WAZAP_EMBED_API_MIN_SIMILARITY: "0.6",
  });
  assert.match(stderr, /recall:.*openai/);
  assert.doesNotMatch(stderr, /llama-server|synthetic-diagnostic-secret|embed model:/);
});

test("a data dir with the wrong mode fails with the chmod that fixes it", async () => {
  const dir = dataDir();
  chmodSync(dir, 0o755);
  const { stderr } = await status(dir);
  assert.match(stderr, /✗ data dir: .* is mode 0755, not 0700 — run `chmod 700 /);
});

test("a lock left by a dead process reads as stale, not as a running server", async () => {
  const dir = dataDir();
  writeFileSync(join(dir, "server.lock"), "999999\n");
  const { stderr } = await status(dir);
  assert.match(stderr, /– lock: stale \(pid 999999 is gone\); the next start reclaims it/);
  assert.match(stderr, /server: not running/);
});

/**
 * A stub supervisor binary that reports a live pid, so the service check sees
 * the service as running and compares versions. Nothing reaches the real
 * launchd or systemd.
 */
const SUPERVISOR_STUB =
  {
    darwin: {
      name: "launchd",
      label: "com.wazap.server",
      binaries: {
        launchctl: (pid) => `#!/bin/sh\n[ "$1" = "print" ] && printf '\\tpid = ${pid}\\n' && exit 0\nexit 113\n`,
      },
    },
    linux: {
      name: "systemd",
      label: "wazap.service",
      binaries: { systemctl: (pid) => `#!/bin/sh\necho ${pid}\n` },
    },
  }[process.platform] ?? null;

test(
  "the service check tells a newer install, an older service and a newer service apart",
  { skip: SUPERVISOR_STUB === null ? `no launchd or systemd on ${process.platform}` : false },
  async () => {
    const dir = dataDir();
    const bin = mkdtempSync(join(tmpdir(), "wazap-doctor-bin-"));
    for (const [name, script] of Object.entries(SUPERVISOR_STUB.binaries)) {
      writeFileSync(join(bin, name), script(4242), { mode: 0o755 });
    }
    const record = {
      supervisor: SUPERVISOR_STUB.name,
      label: SUPERVISOR_STUB.label,
      unitFile: join(dir, "unit"),
      port: 41_999,
      logDir: join(dir, "logs"),
      installedVersion: "0.0.1",
    };
    writeFileSync(join(dir, "service.json"), `${JSON.stringify(record)}\n`);
    // Unlinked dirs have the service fix muted (it would fight `Next wazap
    // setup`), so this check needs a linked account to reach the wording.
    mkdirSync(join(dir, "auth"), { recursive: true });
    writeFileSync(
      join(dir, "auth", "creds.json"),
      JSON.stringify({ registered: true, me: { id: "15550100:1@s.whatsapp.net", name: "Test" } })
    );
    const env = { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };

    const older = await status(dir, [], env);
    assert.match(older.stderr, /– service: runs 0\.0\.1, .* is installed/);
    assert.match(older.stderr, /wazap service restart/);

    writeFileSync(join(dir, "service.json"), `${JSON.stringify({ ...record, installedVersion: "999.0.0" })}\n`);
    const newer = await status(dir, [], env);
    assert.match(newer.stderr, /– service: runs 999\.0\.0, but only .* is installed/);
    assert.match(newer.stderr, /wazap update/);
    assert.doesNotMatch(newer.stderr, /service restart/);

    writeFileSync(join(dir, "service.json"), `${JSON.stringify({ ...record, installedVersion: WAZAP_VERSION })}\n`);
    const same = await status(dir, [], env);
    assert.match(same.stderr, /✓ service: running \(pid 4242/);
  }
);

test("unreadable credentials fail the check and carry the repair", async () => {
  const dir = dataDir();
  mkdirSync(join(dir, "auth"), { recursive: true });
  writeFileSync(join(dir, "auth", "creds.json"), "{ truncated");
  const { stderr } = await status(dir);
  assert.match(stderr, /✗ credentials: default: Stored credentials in .* are unreadable/);
  assert.match(stderr, /wazap logout/);
});

test("WAZAP_NO_UPDATE_CHECK=1 skips the registry call and says so", async () => {
  const { stderr } = await status(dataDir());
  assert.match(stderr, /– update: update check skipped \(WAZAP_NO_UPDATE_CHECK=1\)/);
});

test("writes off is an info check that says how to turn them on", async () => {
  const dir = dataDir();
  writeFileSync(join(dir, ".env"), "WAZAP_READ_ONLY=1\n");
  const { stderr } = await status(dir);
  assert.match(stderr, /– writes: off \(\.env\); write tools are not registered/);
  assert.match(stderr, /wazap config writes on/);
});

test("status --json prints one parseable object carrying the same checks", async () => {
  const dir = dataDir();
  const { stdout } = await status(dir, ["--json"]);
  const report = JSON.parse(stdout);
  assert.equal(report.data_dir, dir);
  assert.equal(report.linked, false);
  assert.equal(report.server_pid, null);
  assert.deepEqual(
    report.checks.map((check) => check.name),
    ["node", "data dir", "lock", "service", "credentials", "writes", "skills", "transcribe", "recall", "webhook", "update"]
  );
  assert.equal(report.checks.find((check) => check.name === "writes").detail, "on (default)");
  assert.ok(["global", "checkout", "npx"].includes(report.install.kind), `install: ${JSON.stringify(report.install)}`);
  assert.match(report.install.script, /index\.js$/);
});

test("status --live on an unlinked data dir reports that, without waiting out the deadline", async () => {
  const started = Date.now();
  const { stderr } = await status(dataDir(), ["--live"]);
  assert.match(stderr, /live: no connection \(not_linked\)/);
  assert.ok(Date.now() - started < 12_000, "it must not sit through the 15s live deadline");
});

test("status --live refuses to touch the session a running server owns", async () => {
  const dir = dataDir();
  writeFileSync(join(dir, "server.lock"), `${process.pid}\n`);
  await assert.rejects(status(dir, ["--live"]), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, new RegExp(`A server \\(pid ${process.pid}\\) already owns this session`));
    assert.match(err.stderr, /get_status/);
    return true;
  });
});

/**
 * A HOME and a PATH of their own, so the skills check sees only the harnesses a
 * case sets up. `~/.cursor` is what makes Cursor detected; the skills land in
 * `~/.cursor/skills`.
 */
function skillsBox() {
  const home = mkdtempSync(join(tmpdir(), "wazap-doctor-home-"));
  return { home, env: { HOME: home, USERPROFILE: home, PATH: join(home, "bin") } };
}

function skillsLine(stderr) {
  return /^[^\n]*skills: .*$/m.exec(stderr)?.[0];
}

test("the skills check stays quiet when no skill-aware client is installed", async () => {
  const box = skillsBox();
  const { stderr } = await status(dataDir(), [], box.env);
  assert.match(skillsLine(stderr), /– skills: no skill-aware client detected/);
});

test("the skills check names the harness that never got them", async () => {
  const box = skillsBox();
  mkdirSync(join(box.home, ".cursor"), { recursive: true });
  const { stderr } = await status(dataDir(), [], box.env);
  assert.match(skillsLine(stderr), /– skills: missing for cursor$/);
  assert.ok(!stderr.includes("wazap skills install"), "unlinked status must not send the user past setup");
});

test("the skills check passes once they are installed, and calls an edited copy stale", async () => {
  const box = skillsBox();
  mkdirSync(join(box.home, ".cursor"), { recursive: true });
  await run(process.execPath, [binary, "skills", "install", "cursor"], {
    env: { ...process.env, ...box.env, PATH: `${box.env.PATH}${delimiter}${process.env.PATH ?? ""}` },
  });

  const installed = await status(dataDir(), [], box.env);
  assert.match(skillsLine(installed.stderr), /✓ skills: installed for cursor/);

  writeFileSync(join(box.home, ".cursor", "skills", "whatsapp-send", "SKILL.md"), "what an older wazap shipped\n");
  const stale = await status(dataDir(), [], box.env);
  assert.match(skillsLine(stale.stderr), /– skills: stale for cursor$/);
});

test("the skills check calls a partial copy stale, and an emptied one missing", async () => {
  const box = skillsBox();
  mkdirSync(join(box.home, ".cursor"), { recursive: true });
  await run(process.execPath, [binary, "skills", "install", "cursor"], {
    env: { ...process.env, ...box.env, PATH: `${box.env.PATH}${delimiter}${process.env.PATH ?? ""}` },
  });

  rmSync(join(box.home, ".cursor", "skills", "whatsapp-send"), { recursive: true });
  const partial = await status(dataDir(), [], box.env);
  assert.match(skillsLine(partial.stderr), /– skills: stale for cursor$/, "a release that adds a skill must still refresh");

  rmSync(join(box.home, ".cursor", "skills"), { recursive: true });
  const emptied = await status(dataDir(), [], box.env);
  assert.match(skillsLine(emptied.stderr), /– skills: missing for cursor$/);
});
