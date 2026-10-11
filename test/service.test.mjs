/**
 * `wazap service`, against a fake supervisor and a fake `launchctl`/`systemctl`
 * on PATH. Nothing here may reach the real launchd, the real systemd, or the
 * user's own ~/.wazap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AccountRegistry } from "../dist/accounts.js";
import { paths, WAZAP_VERSION } from "../dist/config.js";
import { yieldSession } from "../dist/cli.js";
import {
  SUPERVISORS,
  installService,
  readService,
  runService,
  serverUnit,
  servicePath,
  serviceScript,
} from "../dist/service.js";

function dataDir() {
  return mkdtempSync(join(tmpdir(), "wazap-service-"), { mode: 0o700 });
}

/** A high port nothing is listening on, so the port check cannot find a holder. */
let nextPort = 41_000;

function config(dir, overrides = {}) {
  return { dataDir: dir, httpPort: nextPort++, dryRun: false, args: [], ...overrides };
}

function fakeSupervisor(dir, pid = 4242) {
  const calls = [];
  const supervisor = {
    calls,
    name: "launchd",
    available: () => true,
    logDir: () => join(dir, "logs"),
    unitFile: (label) => join(dir, `${label}.unit`),
    render: (unit) => `label ${unit.label}\nargv ${unit.argv.join(" ")}\nHOME ${unit.env.HOME}\n`,
    start: (ref) => calls.push(`start ${ref.label}`),
    stop: (ref) => calls.push(`stop ${ref.label}`),
    restart: (ref) => calls.push(`restart ${ref.label}`),
    remove: (ref) => {
      calls.push(`remove ${ref.label}`);
      rmSync(ref.unitFile, { force: true });
    },
    pid: () => pid,
    logs: (ref) => [`tail ${ref.label}`],
  };
  return supervisor;
}

/** Everything `say` wrote while `work` ran. */
async function captured(work) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    await work();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

test("install writes an absolute unit and a 0600 service.json", async () => {
  const dir = dataDir();
  const supervisor = fakeSupervisor(dir);
  await captured(() => installService(config(dir), supervisor, 0));

  const record = readService(dir);
  assert.equal(record.supervisor, "launchd");
  assert.equal(record.label, "com.wazap.server");
  assert.equal(record.installedVersion, WAZAP_VERSION);
  assert.equal(statSync(paths(dir).serviceFile).mode & 0o777, 0o600, "service.json must not be world-readable");

  const unit = readFileSync(record.unitFile, "utf8");
  assert.ok(unit.includes(`argv ${process.execPath} /`), `the unit must launch this node: ${unit}`);
  assert.match(unit, /dist\/index\.js serve --http --host 127\.0\.0\.1 --port \d+/);
  assert.deepEqual(supervisor.calls, ["start com.wazap.server"]);
});

test("the service logs are the owner's alone, including the ones launchd already created", async () => {
  const dir = dataDir();
  const supervisor = fakeSupervisor(dir);
  const logs = supervisor.logDir();
  const out = join(logs, "com.wazap.server.out.log");
  const err = join(logs, "com.wazap.server.err.log");
  const mode = (file) => statSync(file).mode & 0o777;
  mkdirSync(logs);
  chmodSync(logs, 0o755);
  writeFileSync(out, "an old line\n");
  chmodSync(out, 0o644);

  await captured(() => installService(config(dir), supervisor, 0));
  assert.equal(mode(logs), 0o700, "the log dir must not be listable by others");
  assert.equal(mode(out), 0o600, "an existing log is tightened");
  assert.equal(mode(err), 0o600, "a log launchd has not made yet is created private");
  assert.equal(readFileSync(out, "utf8"), "an old line\n", "tightening a log must not truncate it");

  chmodSync(out, 0o644);
  chmodSync(err, 0o644);
  await captured(() => runService(config(dir, { args: ["restart"] }), [supervisor]));
  assert.equal(mode(out), 0o600, "restart tightens the log again");
  assert.equal(mode(err), 0o600);
});

test("a second install rewrites the same files and restarts instead of starting", async () => {
  const dir = dataDir();
  const first = fakeSupervisor(dir);
  await captured(() => installService(config(dir), first, 0));
  const record = readService(dir);
  const unit = readFileSync(record.unitFile, "utf8");

  const second = fakeSupervisor(dir);
  await captured(() => installService(config(dir, { httpPort: record.port }), second, 0));

  assert.deepEqual(readService(dir), record, "the record must not drift on a re-run");
  assert.equal(readFileSync(record.unitFile, "utf8"), unit);
  assert.deepEqual(second.calls, ["restart com.wazap.server"]);
});

test("serviceScript of a global install is the real file behind that bin, not this process", () => {
  const root = mkdtempSync(join(tmpdir(), "wazap-global-script-"));
  const dist = join(root, "dist");
  mkdirSync(dist);
  const file = join(dist, "index.js");
  writeFileSync(file, "#!/usr/bin/env node\n");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const wazap = join(bin, "wazap");
  symlinkSync(file, wazap);
  assert.equal(serviceScript({ kind: "global", script: wazap }), realpathSync(file));
});

test("a wazap launched through npx refuses to install, and says how to fix it", async () => {
  const dir = dataDir();
  const original = process.argv[1];
  process.argv[1] = join(tmpdir(), "_npx", "abcdef", "node_modules", ".bin", "wazap");
  try {
    await assert.rejects(installService(config(dir), fakeSupervisor(dir), 0), (err) => {
      assert.match(err.message, /npx cache/);
      assert.equal(err.fix, "run `npm i -g wazap-mcp`, then `wazap service install` again");
      return true;
    });
  } finally {
    process.argv[1] = original;
  }
  assert.equal(readService(dir), null, "a refused install must leave no record behind");
});

test("--dry-run prints the unit it would write and writes nothing", async () => {
  const dir = dataDir();
  const supervisor = fakeSupervisor(dir);
  const output = await captured(() => installService(config(dir, { dryRun: true }), supervisor, 0));

  assert.match(output, /would write .*com\.wazap\.server\.unit/);
  assert.match(output, /would write .*service\.json/);
  assert.equal(existsSync(paths(dir).serviceFile), false);
  assert.deepEqual(supervisor.calls, [], "a dry run must not touch the supervisor");
});

test("install refuses while a client's own server holds the session", async () => {
  const dir = dataDir();
  writeFileSync(paths(dir).lockFile, `${process.pid}\n`, { mode: 0o600 });
  await assert.rejects(installService(config(dir), fakeSupervisor(dir), 0), (err) => {
    assert.match(err.message, new RegExp(`already running \\(pid ${process.pid}\\)`));
    assert.match(err.fix, /quit the client that launched it/);
    return true;
  });
});

test("status reports the drift between the running build and the installed one", async () => {
  const dir = dataDir();
  const supervisor = fakeSupervisor(dir);
  await captured(() => installService(config(dir), supervisor, 0));
  const record = readService(dir);
  writeFileSync(paths(dir).serviceFile, JSON.stringify({ ...record, installedVersion: "0.0.1" }));

  const output = await captured(() => runService(config(dir, { args: ["status"] }), [supervisor]));
  assert.match(output, new RegExp(`runs 0\\.0\\.1, ${WAZAP_VERSION.replace(/\./g, "\\.")} is installed`));
  assert.match(output, /wazap service restart/);

  await captured(() => runService(config(dir, { args: ["restart"] }), [supervisor]));
  assert.equal(readService(dir).installedVersion, WAZAP_VERSION, "a restart runs the installed build, and says so");
});

test("uninstall removes the unit and the record, and leaves the data dir alone", async () => {
  const dir = dataDir();
  const supervisor = fakeSupervisor(dir);
  await captured(() => installService(config(dir), supervisor, 0));
  const record = readService(dir);
  writeFileSync(join(dir, "store.json"), "{}");

  await captured(() => runService(config(dir, { args: ["uninstall"] }), [supervisor]));

  assert.equal(existsSync(record.unitFile), false, "the unit file outlived the uninstall");
  assert.equal(existsSync(paths(dir).serviceFile), false, "service.json outlived the uninstall");
  assert.equal(existsSync(join(dir, "store.json")), true, "uninstall must never touch the session data");
  assert.deepEqual(supervisor.calls.slice(1), ["remove com.wazap.server", "remove com.wazap.tunnel"]);
});

test("an unknown verb names the ones that exist", async () => {
  const dir = dataDir();
  await assert.rejects(runService(config(dir, { args: ["frobnicate"] })), (err) => {
    assert.match(err.fix, /install\|status\|start\|stop\|restart\|logs\|uninstall/);
    return true;
  });
});

const NODE = "/opt/node/bin/node";
const SCRIPT = "/opt/wazap/dist/index.js";

const UNIT = {
  label: "com.wazap.server",
  describe: "wazap MCP server (WhatsApp for your AI agent)",
  argv: [NODE, SCRIPT, "serve", "--http", "--host", "127.0.0.1", "--port", "8766"],
  env: { HOME: "/home/u", PATH: "/opt/node/bin:/usr/bin", WAZAP_DATA_DIR: "/home/u/.wazap" },
  logDir: "/home/u/logs",
};

function supervisorNamed(name) {
  return SUPERVISORS.find((entry) => entry.name === name);
}

test("the launchd plist keeps the job alive, throttled, with its own PATH", () => {
  const plist = supervisorNamed("launchd").render(UNIT);
  assert.equal(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>com.wazap.server</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/opt/node/bin/node</string>
\t\t<string>/opt/wazap/dist/index.js</string>
\t\t<string>serve</string>
\t\t<string>--http</string>
\t\t<string>--host</string>
\t\t<string>127.0.0.1</string>
\t\t<string>--port</string>
\t\t<string>8766</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>HOME</key>
\t\t<string>/home/u</string>
\t\t<key>PATH</key>
\t\t<string>/opt/node/bin:/usr/bin</string>
\t\t<key>WAZAP_DATA_DIR</key>
\t\t<string>/home/u/.wazap</string>
\t</dict>
\t<key>KeepAlive</key>
\t<true/>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>ProcessType</key>
\t<string>Standard</string>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>StandardOutPath</key>
\t<string>/home/u/logs/com.wazap.server.out.log</string>
\t<key>StandardErrorPath</key>
\t<string>/home/u/logs/com.wazap.server.err.log</string>
</dict>
</plist>
`
  );
});

/**
 * ProtectHome is deliberately absent: deploy/wazap.service sets it because that
 * unit runs as a system user out of /var/lib/wazap, and here the data dir is
 * ~/.wazap, which ProtectHome would hide from the process.
 */
test("the systemd user unit restarts always and keeps the hardening that fits a home data dir", () => {
  const unit = supervisorNamed("systemd").render(UNIT);
  assert.equal(
    unit,
    `[Unit]
Description=wazap MCP server (WhatsApp for your AI agent)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Environment=HOME=/home/u
Environment=PATH=/opt/node/bin:/usr/bin
Environment=WAZAP_DATA_DIR=/home/u/.wazap
ExecStart=/opt/node/bin/node /opt/wazap/dist/index.js serve --http --host 127.0.0.1 --port 8766
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`
  );
  assert.ok(!unit.includes("ProtectHome"), "ProtectHome would hide ~/.wazap from the service");
});

test("the systemd user unit quotes env values and argv items that hold spaces", () => {
  const unit = supervisorNamed("systemd").render({
    ...UNIT,
    argv: ["/opt/my node/bin/node", "/opt/wazap/dist/index.js", "serve"],
    env: { WAZAP_DATA_DIR: "/home/u/My Files/wazap", QUOTED: 'say "hi"' },
  });
  assert.ok(unit.includes('Environment="WAZAP_DATA_DIR=/home/u/My Files/wazap"'), "a spaced data dir is one value");
  assert.ok(unit.includes('Environment="QUOTED=say \\"hi\\""'), "an embedded quote is escaped");
  assert.ok(unit.includes('ExecStart="/opt/my node/bin/node" /opt/wazap/dist/index.js serve'), "a spaced argv item stays one argument");
});

test("the unit runs the http server on loopback, with whisper and ffmpeg on its PATH", () => {
  const unit = serverUnit({ label: "x", node: NODE, script: SCRIPT, dataDir: "/d", port: 9000, logDir: "/l" });
  assert.deepEqual(unit.argv, [NODE, SCRIPT, "serve", "--http", "--host", "127.0.0.1", "--port", "9000"]);
  assert.equal(unit.env.WAZAP_DATA_DIR, "/d");
  assert.equal(servicePath(NODE), "/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
});

/**
 * A stub supervisor binary, so `login` exercises the real launchd or systemd
 * code path without the real one ever being called. `stop` frees the session
 * lock, which is what a stopped service does.
 */
const STUBS = {
  darwin: {
    name: "launchd",
    binaries: ["launchctl"],
    script: (state, lock, pid, record) => `#!/bin/sh
echo "$@" >> ${record}
case "$1" in
  print) [ -f ${state} ] && { printf '\\tpid = ${pid}\\n'; exit 0; } || exit 113 ;;
  bootout) rm -f ${state} ${lock}; exit 0 ;;
  *) touch ${state}; exit 0 ;;
esac
`,
    stopped: /^bootout /m,
    started: /^bootstrap /m,
  },
  linux: {
    name: "systemd",
    binaries: ["systemctl", "loginctl", "journalctl"],
    script: (state, lock, pid, record) => `#!/bin/sh
echo "$@" >> ${record}
case "$*" in
  *"show -p MainPID"*) [ -f ${state} ] && echo ${pid} || echo 0; exit 0 ;;
  *"--user stop"*) rm -f ${state} ${lock}; exit 0 ;;
  *) touch ${state}; exit 0 ;;
esac
`,
    stopped: /--user stop/m,
    started: /--user enable --now/m,
  },
};

const STUB = STUBS[process.platform] ?? null;
const BINARY = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

/**
 * The pieces that make a pid read as the background service: service.json, a
 * stub supervisor on PATH that reports that pid, and the lock holding it.
 * `bin` gets the stub binaries; `record` collects what the supervisor ran.
 */
function serviceHeldDir() {
  const dir = dataDir();
  const bin = mkdtempSync(join(tmpdir(), "wazap-bin-"));
  const state = join(dir, "loaded");
  const record = join(dir, "calls");
  const p = paths(dir);
  writeFileSync(state, "");
  writeFileSync(record, "");
  writeFileSync(p.lockFile, `${process.pid}\n`, { mode: 0o600 });
  writeFileSync(
    p.serviceFile,
    JSON.stringify({
      supervisor: STUB.name,
      label: STUB.name === "launchd" ? "com.wazap.server" : "wazap.service",
      unitFile: join(dir, "unit"),
      port: 41_999,
      logDir: join(dir, "logs"),
      installedVersion: WAZAP_VERSION,
    })
  );
  for (const binary of STUB.binaries) {
    writeFileSync(join(bin, binary), STUB.script(state, p.lockFile, process.pid, record), { mode: 0o755 });
  }
  const env = { ...process.env, WAZAP_NO_UPDATE_CHECK: "1", PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
  return { dir, record, env };
}

function wazapIn(env, args) {
  return promisify(execFile)(process.execPath, [BINARY, ...args], { env });
}

test(
  "logout stops the wazap service, unlinks, and starts it again",
  { skip: STUB === null ? `no launchd or systemd on ${process.platform}` : false },
  async () => {
    const { dir, record, env } = serviceHeldDir();
    const { stderr } = await wazapIn(env, ["logout", "--data-dir", dir]);
    assert.match(stderr, /Stopping the wazap service for logout/);
    assert.match(stderr, /Not linked/);
    const calls = readFileSync(record, "utf8");
    assert.match(calls, STUB.stopped, "logout never stopped the service");
    assert.match(calls, STUB.started, "logout left the service down");
    assert.ok(
      calls.search(STUB.stopped) < calls.search(STUB.started),
      `the service must be stopped before it is started again: ${calls}`
    );
    assert.equal(existsSync(paths(dir).lockFile), false, "the command must not leave the session held");
  }
);

test(
  "account remove on a service-held lock points at wazap service stop",
  { skip: STUB === null ? `no launchd or systemd on ${process.platform}` : false },
  async () => {
    const { dir, env } = serviceHeldDir();
    AccountRegistry.load(dir).add("work");
    await assert.rejects(wazapIn(env, ["account", "remove", "work", "--yes", "--data-dir", dir]), (err) => {
      assert.match(err.stderr, new RegExp(`stop it first: \`wazap service stop\``));
      assert.doesNotMatch(err.stderr, new RegExp(`kill ${process.pid}`));
      return true;
    });
  }
);

test(
  "a launchd restart reloads the plist, so a rewritten unit takes effect",
  { skip: STUB?.name === "launchd" ? false : `launchctl only runs on macOS, not ${process.platform}` },
  () => {
    const dir = dataDir();
    const bin = mkdtempSync(join(tmpdir(), "wazap-bin-"));
    const state = join(dir, "loaded");
    const record = join(dir, "calls");
    writeFileSync(state, "");
    writeFileSync(record, "");
    writeFileSync(join(bin, "launchctl"), STUB.script(state, join(dir, "lock"), process.pid, record), { mode: 0o755 });
    const launchd = SUPERVISORS.find((supervisor) => supervisor.name === "launchd");

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    try {
      launchd.restart({ label: "com.wazap.server", unitFile: join(dir, "com.wazap.server.plist") });
    } finally {
      process.env.PATH = originalPath;
    }

    const calls = readFileSync(record, "utf8");
    assert.doesNotMatch(calls, /kickstart/, `kickstart reruns the plist launchd already read: ${calls}`);
    assert.match(calls, /^bootout /m, "the loaded job was never booted out");
    assert.match(calls, /^bootstrap .*com\.wazap\.server\.plist$/m, "the unit file was never loaded again");
    assert.ok(calls.search(/^bootout /m) < calls.search(/^bootstrap /m), `booted out before loaded again: ${calls}`);
  }
);

test(
  "login stops the wazap service for pairing and starts it again",
  { skip: STUB === null ? `no launchd or systemd on ${process.platform}` : false },
  async () => {
    const dir = dataDir();
    const bin = mkdtempSync(join(tmpdir(), "wazap-bin-"));
    const state = join(dir, "loaded");
    const record = join(dir, "calls");
    const p = paths(dir);

    writeFileSync(state, "");
    writeFileSync(record, "");
    writeFileSync(p.lockFile, `${process.pid}\n`, { mode: 0o600 });
    writeFileSync(
      p.serviceFile,
      JSON.stringify({
        supervisor: STUB.name,
        label: STUB.name === "launchd" ? "com.wazap.server" : "wazap.service",
        unitFile: join(dir, "unit"),
        port: 41_999,
        logDir: join(dir, "logs"),
        installedVersion: WAZAP_VERSION,
      })
    );
    for (const binary of STUB.binaries) {
      writeFileSync(join(bin, binary), STUB.script(state, p.lockFile, process.pid, record), { mode: 0o755 });
    }

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    try {
      let resume;
      await captured(async () => {
        resume = await yieldSession({ dataDir: dir }, p.lockFile);
      });
      resume();
    } finally {
      process.env.PATH = originalPath;
    }

    const calls = readFileSync(record, "utf8");
    assert.match(calls, STUB.stopped, "pairing never stopped the service");
    assert.match(calls, STUB.started, "pairing left the service down");
    assert.ok(
      calls.search(STUB.stopped) < calls.search(STUB.started),
      `the service must be stopped before it is started again: ${calls}`
    );
  }
);
