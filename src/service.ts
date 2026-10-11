import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { WAZAP_VERSION, paths, type Config } from "./config.js";
import { commandOnPath, isNpxPath, whereInstalled, type Install } from "./connect.js";
import { WazapError } from "./errors.js";
import { lockHolder } from "./lock.js";
import { say } from "./logger.js";
import { dim, fail, fix, info, ok, shortPath } from "./ui.js";

export type SupervisorName = "launchd" | "systemd";

/** `<data-dir>/service.json`: what was installed, and where the supervisor keeps it. */
export interface ServiceRecord {
  supervisor: SupervisorName;
  label: string;
  unitFile: string;
  port: number;
  logDir: string;
  installedVersion: string;
  tunnel?: { provider: string; url: string };
}

/** One thing a supervisor is asked to keep alive. The server and the tunnel are both this. */
export interface UnitSpec {
  label: string;
  describe: string;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  logDir: string;
}

/** Enough of a record to address an installed unit. */
export interface UnitRef {
  label: string;
  unitFile: string;
}

export interface Supervisor {
  name: SupervisorName;
  available(): boolean;
  logDir(): string;
  unitFile(label: string): string;
  render(unit: UnitSpec): string;
  start(ref: UnitRef): void;
  stop(ref: UnitRef): void;
  restart(ref: UnitRef): void;
  /** Stop it, forget it, and delete the unit file. */
  remove(ref: UnitRef): void;
  pid(ref: UnitRef): number | null;
  /** The command to follow the logs with, then the last 50 lines. */
  logs(ref: UnitRef): string[];
}

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

function run(argv: readonly string[]): Ran {
  const [command, ...args] = argv;
  const result = spawnSync(command!, args, { encoding: "utf8" });
  if (result.error) return { status: -1, stdout: "", stderr: result.error.message };
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runOrThrow(argv: readonly string[], repair: string): void {
  const result = run(argv);
  if (result.status === 0) return;
  const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`).split("\n")[0]!;
  throw new WazapError("SERVICE_ERROR", `\`${argv.join(" ")}\` failed: ${detail}`, repair);
}

function tailFile(file: string, lines: number): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

const TAIL_LINES = 50;

function escapeXml(text: string): string {
  return text.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!);
}

function plistStrings(values: readonly string[]): string {
  return values.map((value) => `\t\t<string>${escapeXml(value)}</string>`).join("\n");
}

function plistEnv(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([key, value]) => `\t\t<key>${escapeXml(key)}</key>\n\t\t<string>${escapeXml(value)}</string>`)
    .join("\n");
}

function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

/** `launchctl print` output for a bootstrapped label, or null when it is not loaded. */
function launchctlPrint(ref: UnitRef): string | null {
  const result = run(["launchctl", "print", `${guiDomain()}/${ref.label}`]);
  return result.status === 0 ? result.stdout : null;
}

const LAUNCHD_FIX = "check `launchctl print gui/$(id -u)` and the log in ~/Library/Logs/wazap";

/** bootout can return before launchd lets go of the label, and a bootstrap then fails. */
function waitUntilUnloaded(ref: UnitRef, timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs;
  while (launchctlPrint(ref) !== null && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

/**
 * KeepAlive restarts the server whatever way it ended, a clean exit included: the exit wazap makes
 * when its reconnects run out is how it asks for a fresh process. ThrottleInterval spaces those
 * restarts. ProcessType Standard, not Background: launchd throttles a Background job's CPU and I/O
 * and coalesces its timers, and the server's keepalive, watchdog and HTTP answers run on those.
 */
const launchd: Supervisor = {
  name: "launchd",
  available: () => process.platform === "darwin" && commandOnPath("launchctl"),
  logDir: () => join(homedir(), "Library", "Logs", "wazap"),
  unitFile: (label) => join(homedir(), "Library", "LaunchAgents", `${label}.plist`),
  render: (unit) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${escapeXml(unit.label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${plistStrings(unit.argv)}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${plistEnv(unit.env)}
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
\t<string>${escapeXml(join(unit.logDir, `${unit.label}.out.log`))}</string>
\t<key>StandardErrorPath</key>
\t<string>${escapeXml(join(unit.logDir, `${unit.label}.err.log`))}</string>
</dict>
</plist>
`,
  start: (ref) => {
    if (launchctlPrint(ref) === null) runOrThrow(["launchctl", "bootstrap", guiDomain(), ref.unitFile], LAUNCHD_FIX);
    else runOrThrow(["launchctl", "kickstart", `${guiDomain()}/${ref.label}`], LAUNCHD_FIX);
  },
  stop: (ref) => {
    if (launchctlPrint(ref) !== null) runOrThrow(["launchctl", "bootout", `${guiDomain()}/${ref.label}`], LAUNCHD_FIX);
  },
  // kickstart -k reruns the job as launchd loaded it, and launchd keeps the plist
  // it read at bootstrap: a rewritten unit, pointing at another install or
  // another node, would never take effect. Booting the job out and back in
  // reads the file again.
  restart: (ref) => {
    launchd.stop(ref);
    waitUntilUnloaded(ref);
    runOrThrow(["launchctl", "bootstrap", guiDomain(), ref.unitFile], LAUNCHD_FIX);
  },
  remove: (ref) => {
    launchd.stop(ref);
    rmSync(ref.unitFile, { force: true });
  },
  pid: (ref) => {
    const printed = launchctlPrint(ref);
    const found = printed === null ? null : /^\s*pid = (\d+)$/m.exec(printed);
    return found === null ? null : Number.parseInt(found[1]!, 10);
  },
  logs: (ref) => {
    const file = join(launchd.logDir(), `${ref.label}.err.log`);
    return [`tail -f ${file}`, ...tailFile(file, TAIL_LINES)];
  },
};

function systemdUnitName(label: string): string {
  return label.replace(/\.service$/, "");
}

const SYSTEMD_FIX = "check `systemctl --user status wazap` and `journalctl --user -u wazap`";

/**
 * systemd splits unit values on whitespace; a path holding a space needs
 * double quotes, with `\` and `"` escaped inside. Values without them stay
 * bare, the form every existing unit already carries.
 */
function systemdQuote(value: string): string {
  return /[\s"\\]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

/**
 * Restart=always brings the server back after the exit wazap makes when its reconnects run out.
 * StartLimitIntervalSec=0 keeps systemd from ever giving up on it after a burst of restarts.
 */
const systemd: Supervisor = {
  name: "systemd",
  available: () => process.platform === "linux" && commandOnPath("systemctl"),
  logDir: () => "",
  unitFile: (label) => join(homedir(), ".config", "systemd", "user", label),
  render: (unit) =>
    `[Unit]
Description=${unit.describe}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
${Object.entries(unit.env)
  .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
  .join("\n")}
ExecStart=${unit.argv.map(systemdQuote).join(" ")}
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`,
  start: (ref) => {
    // Without lingering the user manager stops at logout, which is every reboot
    // on a headless box, and the service with it.
    run(["loginctl", "enable-linger", userInfo().username]);
    run(["systemctl", "--user", "daemon-reload"]);
    runOrThrow(["systemctl", "--user", "enable", "--now", ref.label], SYSTEMD_FIX);
  },
  stop: (ref) => runOrThrow(["systemctl", "--user", "stop", ref.label], SYSTEMD_FIX),
  restart: (ref) => {
    run(["systemctl", "--user", "daemon-reload"]);
    runOrThrow(["systemctl", "--user", "restart", ref.label], SYSTEMD_FIX);
  },
  remove: (ref) => {
    run(["systemctl", "--user", "disable", "--now", ref.label]);
    rmSync(ref.unitFile, { force: true });
    run(["systemctl", "--user", "daemon-reload"]);
  },
  pid: (ref) => {
    const result = run(["systemctl", "--user", "show", "-p", "MainPID", "--value", ref.label]);
    const pid = Number.parseInt(result.stdout.trim(), 10);
    return result.status === 0 && Number.isInteger(pid) && pid > 0 ? pid : null;
  },
  logs: (ref) => {
    const unit = systemdUnitName(ref.label);
    const result = run(["journalctl", "--user", "-u", unit, "-n", String(TAIL_LINES), "--no-pager"]);
    return [`journalctl --user -u ${unit} -f`, ...result.stdout.split("\n").filter(Boolean)];
  },
};

export const SUPERVISORS: readonly Supervisor[] = [launchd, systemd];

export const SERVER_LABELS: Record<SupervisorName, string> = {
  launchd: "com.wazap.server",
  systemd: "wazap.service",
};

export const TUNNEL_LABELS: Record<SupervisorName, string> = {
  launchd: "com.wazap.tunnel",
  systemd: "wazap-tunnel.service",
};

/** A unit on this machine that holds a tunnel open to the server's port. */
export interface TunnelUnit {
  label: string;
  unitFile: string;
  /** What stops it for good: the unit has to leave the supervisor's directory too. */
  stop: string;
}

/** `127.0.0.1:8766` or `localhost:8766`, never `:87660`. */
function reachesPort(command: string, port: number): boolean {
  return new RegExp(`(?:127\\.0\\.0\\.1|localhost):${port}(?!\\d)`).test(command);
}

/** The command a unit file runs: a plist's ProgramArguments, a unit's ExecStart lines. */
function unitCommand(supervisor: SupervisorName, text: string): string {
  if (supervisor === "launchd")
    return /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
  return text
    .split("\n")
    .filter((line) => /^\s*ExecStart\s*=/.test(line))
    .join("\n");
}

/**
 * Every unit in the supervisor's own directory whose command reaches `port` on
 * loopback: wazap's tunnel, or one set up by hand, which wazap did not write
 * and never stops. Loopback is only private while this finds nothing.
 */
export function tunnelsTo(supervisor: Supervisor, port: number): TunnelUnit[] {
  const dir = dirname(supervisor.unitFile(TUNNEL_LABELS[supervisor.name]));
  const extension = supervisor.name === "launchd" ? ".plist" : ".service";
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(extension))
      .sort();
  } catch {
    return [];
  }
  const found: TunnelUnit[] = [];
  for (const name of names) {
    const unitFile = join(dir, name);
    let text: string;
    try {
      text = readFileSync(unitFile, "utf8");
    } catch {
      continue;
    }
    if (!reachesPort(unitCommand(supervisor.name, text), port)) continue;
    if (supervisor.name === "launchd") {
      const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1] ?? basename(name, extension);
      found.push({ label, unitFile, stop: `launchctl bootout ${guiDomain()}/${label}; rm ${unitFile}` });
    } else {
      found.push({ label: name, unitFile, stop: `systemctl --user disable --now ${name}; rm ${unitFile}` });
    }
  }
  return found;
}

const UNSUPPORTED_FIX =
  "wazap needs launchd (macOS) or a systemd user session (Linux). On Windows, run `wazap serve --http` from a Task Scheduler task instead";

export function pickSupervisor(registry: readonly Supervisor[] = SUPERVISORS): Supervisor {
  const found = registry.find((supervisor) => supervisor.available());
  if (found === undefined) {
    throw new WazapError("SERVICE_ERROR", `No supported service supervisor on ${process.platform}.`, UNSUPPORTED_FIX);
  }
  return found;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function readTunnel(value: unknown): ServiceRecord["tunnel"] {
  if (typeof value !== "object" || value === null) return undefined;
  const { provider, url } = value as Record<string, unknown>;
  if (typeof provider !== "string" || typeof url !== "string" || provider === "" || url === "") return undefined;
  return { provider, url };
}

/** The installed service, or null when nothing was installed or the file is not one. */
export function readService(dataDir: string): ServiceRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths(dataDir).serviceFile, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { supervisor, label, unitFile, port, logDir, installedVersion, tunnel } = parsed as Record<string, unknown>;
  if (supervisor !== "launchd" && supervisor !== "systemd") return null;
  if (typeof label !== "string" || typeof unitFile !== "string" || typeof logDir !== "string") return null;
  if (typeof installedVersion !== "string" || !isPositiveInt(port)) return null;
  const record: ServiceRecord = { supervisor, label, unitFile, port, logDir, installedVersion };
  const parsedTunnel = readTunnel(tunnel);
  if (parsedTunnel) record.tunnel = parsedTunnel;
  return record;
}

export function writeService(dataDir: string, record: ServiceRecord): void {
  const file = paths(dataDir).serviceFile;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function removeService(dataDir: string): void {
  rmSync(paths(dataDir).serviceFile, { force: true });
}

export interface Installed {
  supervisor: Supervisor;
  record: ServiceRecord;
}

/** The installed service and the supervisor that owns it, or null. */
export function installedService(dataDir: string, registry: readonly Supervisor[] = SUPERVISORS): Installed | null {
  const record = readService(dataDir);
  if (record === null) return null;
  const supervisor = registry.find((entry) => entry.name === record.supervisor);
  return supervisor === undefined ? null : { supervisor, record };
}

/** The service, when it is the process holding `pid`. What tells a service apart from a client's own. */
export function serviceHolding(dataDir: string, pid: number): Installed | null {
  const found = installedService(dataDir);
  if (found === null) return null;
  return found.supervisor.pid(found.record) === pid ? found : null;
}

export interface Health {
  ok: boolean;
  status: string;
  since: string | null;
}

export async function fetchHealth(port: number, timeoutMs: number): Promise<Health | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.status !== "string") return null;
    return { ok: body.ok === true, status: body.status, since: typeof body.since === "string" ? body.since : null };
  } catch {
    return null;
  }
}

const HEALTH_TIMEOUT_MS = 2_000;
const HEALTH_POLL_MS = 250;
export const INSTALL_WAIT_MS = 10_000;

async function waitForHealth(port: number, waitMs: number): Promise<Health | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const health = await fetchHealth(port, HEALTH_TIMEOUT_MS);
    if (health !== null) return health;
    if (Date.now() >= deadline) return null;
    await sleep(HEALTH_POLL_MS);
  }
}

const NPX_FIX = "run `npm i -g wazap-mcp`, then `wazap service install` again";

/** The absolute script a supervisor can launch for years. The npx cache is not one. */
export function serviceScript(install: Install = whereInstalled()): string {
  if (install.kind === "npx") {
    throw new WazapError(
      "SERVICE_ERROR",
      "wazap is running out of the npx cache, which npm clears; a service cannot point at it.",
      NPX_FIX
    );
  }
  const self = realpathSync(fileURLToPath(new URL("../dist/index.js", import.meta.url)));
  if (install.script === "") return self;
  let real: string;
  try {
    real = realpathSync(install.script);
  } catch {
    return self;
  }
  if (isNpxPath(real)) return self;
  const name = basename(real);
  if (name !== "index.js" && name !== "wazap") return self;
  return real;
}

/** whisper and ffmpeg live in these, and a launchd job inherits none of your shell PATH. */
const SERVICE_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

export function servicePath(node: string): string {
  return [dirname(node), ...SERVICE_PATH].join(":");
}

export function serverUnit(args: {
  label: string;
  node: string;
  script: string;
  dataDir: string;
  port: number;
  logDir: string;
}): UnitSpec {
  return {
    label: args.label,
    describe: "wazap MCP server (WhatsApp for your AI agent)",
    argv: [args.node, args.script, "serve", "--http", "--host", "127.0.0.1", "--port", String(args.port)],
    env: { HOME: homedir(), PATH: servicePath(args.node), WAZAP_DATA_DIR: args.dataDir },
    logDir: args.logDir,
  };
}

/** Write a unit, keeping one backup of whatever was there, the way `connect` does. */
export function writeUnit(unitFile: string, text: string): void {
  mkdirSync(dirname(unitFile), { recursive: true });
  if (existsSync(unitFile) && !existsSync(`${unitFile}.bak`)) copyFileSync(unitFile, `${unitFile}.bak`);
  writeFileSync(unitFile, text);
}

/**
 * launchd creates a job's log files world-readable, and a log holds whatever
 * the process printed. The directory and both files are the owner's alone:
 * created here before the job starts, and tightened when they already exist.
 * systemd has no log dir; the journal is already per user.
 */
export function secureLogs(logDir: string, label: string): void {
  if (logDir === "") return;
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  chmodSync(logDir, 0o700);
  for (const stream of ["out", "err"]) {
    const file = join(logDir, `${label}.${stream}.log`);
    // The mode argument only applies on creation; the chmod covers a log launchd made.
    closeSync(openSync(file, "a", 0o600));
    chmodSync(file, 0o600);
  }
}

/** The pid listening on `port`, or null when nothing is or lsof cannot say. */
function portHolder(port: number): number | null {
  const result = run(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (result.status !== 0) return null;
  const pid = Number.parseInt(result.stdout.trim().split("\n")[0] ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

const SLEEP_NOTE =
  "A Mac that sleeps is a wazap that is offline until it wakes (it reconnects on its own then). To keep it up: System Settings → Energy (or Battery → Options), prevent automatic sleeping on power, and turn on wake for network access.";

export async function installService(
  config: Config,
  supervisor: Supervisor = pickSupervisor(),
  waitMs: number = INSTALL_WAIT_MS,
  install: Install = whereInstalled()
): Promise<void> {
  const script = serviceScript(install);
  const p = paths(config.dataDir);
  const existing = readService(config.dataDir);
  const label = SERVER_LABELS[supervisor.name];
  const record: ServiceRecord = {
    supervisor: supervisor.name,
    label,
    unitFile: supervisor.unitFile(label),
    port: config.httpPort,
    logDir: supervisor.logDir(),
    installedVersion: WAZAP_VERSION,
  };
  if (existing?.tunnel) record.tunnel = existing.tunnel;

  const ours = existing === null ? null : supervisor.pid(record);
  const holder = portHolder(record.port);
  if (holder !== null && holder !== ours) {
    throw new WazapError(
      "SERVICE_ERROR",
      `Port ${record.port} is already held by pid ${holder}.`,
      `stop that process, or set WAZAP_PORT in ${shortPath(p.envFile)} to a free port and run this again`
    );
  }
  const locked = lockHolder(p.lockFile);
  if (locked !== null && locked !== ours) {
    throw new WazapError(
      "SERVICE_ERROR",
      `wazap is already running (pid ${locked}) on this data dir.`,
      "quit the client that launched it, then run `wazap service install` again"
    );
  }

  const text = supervisor.render(serverUnit({ ...record, node: process.execPath, script, dataDir: config.dataDir }));
  if (config.dryRun) {
    say(info(`would write ${shortPath(record.unitFile)}`));
    for (const line of text.split("\n")) say(`  ${dim(line)}`);
    say(info(`would write ${shortPath(p.serviceFile)}`));
    return;
  }

  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  secureLogs(record.logDir, record.label);
  writeUnit(record.unitFile, text);
  writeService(config.dataDir, record);
  if (existing === null) supervisor.start(record);
  else supervisor.restart(record);

  say(ok(`${supervisor.name} · ${shortPath(record.unitFile)}`));
  await report(supervisor, record, waitMs);
  say(dim(supervisor.logs(record)[0]!));
  if (process.platform === "darwin") say(info(SLEEP_NOTE));
}

async function report(supervisor: Supervisor, record: ServiceRecord, waitMs: number): Promise<void> {
  const health = await waitForHealth(record.port, waitMs);
  const pid = supervisor.pid(record);
  if (health === null) {
    say(fail(`No answer on http://127.0.0.1:${record.port}/healthz${pid === null ? "" : ` (pid ${pid})`}.`));
    say(fix("run `wazap service logs`"));
    return;
  }
  say(ok(`Running · pid ${pid ?? "unknown"} · http://127.0.0.1:${record.port}/mcp`));
  if (!health.ok) say(info(`WhatsApp is ${health.status}.`));
}

function requireService(config: Config, registry: readonly Supervisor[]): Installed {
  const found = installedService(config.dataDir, registry);
  if (found === null) {
    throw new WazapError("SERVICE_ERROR", "No wazap service is installed.", "run `wazap service install`");
  }
  return found;
}

async function serviceStatus(config: Config, registry: readonly Supervisor[]): Promise<void> {
  const { supervisor, record } = requireService(config, registry);
  say(`${supervisor.name} · ${record.label} · ${shortPath(record.unitFile)}`);
  const pid = supervisor.pid(record);
  say(pid === null ? fail("not running") : ok(`running (pid ${pid})`));
  const health = await fetchHealth(record.port, HEALTH_TIMEOUT_MS);
  say(
    health === null
      ? fail(`no answer on http://127.0.0.1:${record.port}/healthz`)
      : health.ok
        ? ok(`healthy · ${health.status} · http://127.0.0.1:${record.port}/mcp`)
        : info(`unhealthy · ${health.status} since ${health.since ?? "unknown"}`)
  );
  if (record.tunnel) say(info(`${record.tunnel.provider} · ${record.tunnel.url}/mcp`));
  if (record.installedVersion !== WAZAP_VERSION) {
    say(info(`runs ${record.installedVersion}, ${WAZAP_VERSION} is installed`));
    say(fix("run `wazap service restart`, or `wazap service install` when the script path changed"));
  }
  say(dim(supervisor.logs(record)[0]!));
}

function uninstallService(config: Config, registry: readonly Supervisor[]): void {
  const { supervisor, record } = requireService(config, registry);
  supervisor.remove(record);
  const tunnelLabel = TUNNEL_LABELS[supervisor.name];
  supervisor.remove({ label: tunnelLabel, unitFile: supervisor.unitFile(tunnelLabel) });
  removeService(config.dataDir);
  say(ok("Service removed. Your session and credentials are untouched."));
}

type Verb = (config: Config, registry: readonly Supervisor[]) => void | Promise<void>;

const VERBS: Record<string, Verb> = {
  install: (config, registry) => installService(config, pickSupervisor(registry)),
  status: serviceStatus,
  start: (config, registry) => {
    const { supervisor, record } = requireService(config, registry);
    secureLogs(record.logDir, record.label);
    supervisor.start(record);
    say(ok(`Started ${record.label}`));
  },
  stop: (config, registry) => {
    const { supervisor, record } = requireService(config, registry);
    supervisor.stop(record);
    say(ok(`Stopped ${record.label}`));
  },
  restart: (config, registry) => {
    const { supervisor, record } = requireService(config, registry);
    secureLogs(record.logDir, record.label);
    supervisor.restart(record);
    // The unit runs whatever dist/ holds now, so the record says so too.
    if (record.installedVersion !== WAZAP_VERSION)
      writeService(config.dataDir, { ...record, installedVersion: WAZAP_VERSION });
    say(ok(`Restarted ${record.label}`));
  },
  logs: (config, registry) => {
    const { supervisor, record } = requireService(config, registry);
    for (const line of supervisor.logs(record)) say(line);
  },
  uninstall: uninstallService,
};

export const SERVICE_VERBS: string = Object.keys(VERBS).join("|");

export async function runService(config: Config, registry: readonly Supervisor[] = SUPERVISORS): Promise<void> {
  const verb = VERBS[config.args[0] ?? ""];
  if (verb === undefined) {
    throw new WazapError(
      "INVALID_ID",
      `Cannot run \`wazap service ${config.args.join(" ")}\`.`,
      `Run \`wazap service ${SERVICE_VERBS}\``
    );
  }
  await verb(config, registry);
}
