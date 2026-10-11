import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { accountRows, describeAccount, describeStatusAccount, type StatusAccountRow } from "./account-cli.js";
import { AccountHub } from "./account-hub.js";
import { AccountRegistry, resolveAccount } from "./accounts.js";
import { readLinkedAccount, type LinkedAccount } from "./auth-state.js";
import { banner } from "./banner.js";
import { BAILEYS_VERSION, WAZAP_VERSION, paths, type AccountPaths, type Config, type Paths } from "./config.js";
import { connectNext, whereInstalled, type Install } from "./connect.js";
import { CONTROL_ROUTES, LOGOUT_WAIT_MS, askRunningServer, isLogoutOutcome, startControlEndpoint } from "./control.js";
import { decideRole, readDaemon, removeDaemon, writeDaemon } from "./daemon.js";
import { DEPS, ensureDeps } from "./deps.js";
import { checkLine, checkLines, recallEnabled, runChecks, type Check } from "./doctor.js";
import { withCode } from "./error-code.js";
import { WazapError, asWazapError } from "./errors.js";
import { normalizePhone } from "./ids.js";
import { lockHolder, releaseLock, writeLock } from "./lock.js";
import { log, logError, say } from "./logger.js";
import { logoutAccount, logoutLines, type LogoutOutcome } from "./logout.js";
import { clockLabel, formatAge } from "./messages.js";
import { oauthProblem } from "./oauth.js";
import {
  downloadEmbed,
  embedModelSpec,
  readRecallSettings,
  type RecallSettings,
} from "./recall/index.js";
import { PAIRING_TIMEOUT_MS, linkSession, prettyCode, settledAccount, startPairing } from "./pairing.js";
import { runHttp, runStdio, startLoopbackEndpoint } from "./server.js";
import { SUPERVISORS, fetchHealth, serviceHolding, tunnelsTo, type Supervisor } from "./service.js";
import { applyWrites } from "./settings.js";
import { storageReport, type StorageReport } from "./storage-status.js";
import {
  MODELS,
  downloadModel,
  maskKey,
  modelSpec,
  readTranscribeSettings,
  stripPasted,
  transcribeFile,
  transcribeReady,
  type ModelSpec,
  type ProviderName,
  type TranscribeSettings,
} from "./transcribe/index.js";
import {
  bold,
  box,
  brand,
  humanLayout,
  dim,
  fail,
  fix,
  info,
  maskNumber,
  next,
  ok,
  openScreen,
  qrFits,
  qrSavedLine,
  qrScreenRows,
  shortPath,
  spinner,
  terminalRows,
  tilde,
  warn,
  type Spinner,
} from "./ui.js";
import { loginWizardSteps, maybeWizard, qrScreenBody, wizFail, wizInfo, wizOk, wizWarn, type Wizard } from "./wizard.js";
import type { ConnectionStatus } from "./wa-types.js";
import { WhatsAppService } from "./whatsapp.js";

/** How long a probe waits for the socket to settle; tests shorten it through the environment. */
const LIVE_TIMEOUT_MS = Number.parseInt(process.env.WAZAP_LIVE_TIMEOUT_MS ?? "", 10) || 15_000;
/** Connection states the probe stops waiting on. */
const SETTLED_STATUSES: readonly ConnectionStatus[] = [
  "connected",
  "not_linked",
  "logged_out",
  "session_corrupt",
  "auth_failure",
];
/** What `serve` exits with when WhatsApp keeps refusing the socket. */
export const GAVE_UP_EXIT = 3;
const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"];
/** Bind addresses a loopback bridge can still reach; the wildcards include 127.0.0.1. */
const SHAREABLE_HOSTS = [...LOOPBACK_HOSTS, "0.0.0.0", "::"];

export interface LiveReport {
  reachable: boolean;
  chats: number | null;
  last_message_age: string | null;
  reason: string | null;
}

export { describeAccount, runAccount, runMigrate } from "./account-cli.js";
export { alreadyUnlinked } from "./logout.js";

interface StatusReport {
  data_dir: string;
  linked: boolean;
  credentials_readable: boolean;
  account: LinkedAccount | null;
  accounts: StatusAccountRow[];
  wazap_version: string;
  baileys_version: string;
  install: Install;
  server_pid: number | null;
  /** The lock holder is the background service, so it can be stopped with `wazap service stop`. */
  server_is_service?: boolean;
  daemon: { pid: number; port: number } | null;
  /** Each account's database, legacy files and set-aside databases, and the beta archive; read-only. */
  storage: StorageReport;
  checks: Check[];
  live?: LiveReport;
}

function openService(config: Config): WhatsAppService {
  const { account, paths: accountStorage } = resolveAccount(config.dataDir, config.accountId);
  return new WhatsAppService(config, account, accountStorage);
}

export async function runStatus(config: Config): Promise<StatusReport> {
  const p = paths(config.dataDir);
  const selected = resolveAccount(config.dataDir, config.accountId);

  let account: LinkedAccount | null = null;
  let unreadable = false;
  try {
    account = readLinkedAccount(selected.paths.authDir);
  } catch {
    unreadable = true;
  }

  // A sidecar outliving the process that wrote it is stale, so only the lock
  // holder's own record counts as a session being shared.
  const serverPid = lockHolder(p.lockFile);
  const daemon = readDaemon(p.daemonFile);
  const sharing = daemon !== null && daemon.pid === serverPid ? { pid: daemon.pid, port: daemon.port } : null;

  const rows = accountRows(config);
  const storage = storageReport(config.dataDir, recallEnabled(config));
  const report: StatusReport = {
    data_dir: config.dataDir,
    // The dir is linked when any account is; `account` still describes the
    // selected one, and `accounts` carries each row's own credentials.
    linked: account !== null || rows.some((row) => row.account !== null),
    credentials_readable: !unreadable,
    account,
    accounts: rows,
    wazap_version: WAZAP_VERSION,
    baileys_version: BAILEYS_VERSION,
    install: whereInstalled(),
    server_pid: serverPid,
    server_is_service: serverPid !== null && serviceHolding(config.dataDir, serverPid) !== null,
    daemon: sharing,
    storage,
    checks: await runChecks(config, { storage }),
  };
  if (config.live) report.live = await runLiveProbe(config);

  if (config.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (config.live) process.exit(0);
    return report;
  }

  for (const line of humanLayout() ? richStatus(report) : plainStatus(report)) say(line);

  if (report.live) {
    say("");
    for (const line of liveLines(report.live)) say(line);
    process.exit(0);
  }
  return report;
}

/** Today's phrasing, kept verbatim so pipes and log captures keep parsing. */
function plainStatus(report: StatusReport): string[] {
  const lines = [`data dir: ${report.data_dir}`];
  const credsNote = report.credentials_readable
    ? ""
    : " (credentials unreadable — run `wazap logout` then `wazap login`)";
  lines.push(`linked: ${report.linked ? "yes" : "no"}${credsNote}`);
  if (report.account) lines.push(`account: ${describeAccount(report.account)}`);
  if (report.accounts.length > 1) {
    lines.push("accounts:");
    for (const row of report.accounts) {
      lines.push(`  ${describeStatusAccount(row)}${row.default ? "  (default)" : ""}`);
    }
  }
  lines.push(
    `wazap: ${report.wazap_version}`,
    `baileys: ${report.baileys_version}`,
    `install: ${describeInstall(report.install)}`,
    `server: ${serverState(report)}`,
    "",
    "checks:",
    ...report.checks.map(checkLine)
  );
  return lines;
}

/** The one place the sidecar becomes words, so the two renderers cannot drift. */
function serverState(report: StatusReport): string {
  if (report.server_pid === null) return "not running";
  const shared = report.daemon === null ? "" : `, sharing on 127.0.0.1:${report.daemon.port}`;
  return `running (pid ${report.server_pid}${shared})`;
}

const LABEL_WIDTH = 8;

function row(label: string, value: string): string {
  return `${dim(label.padEnd(LABEL_WIDTH))}  ${value}`;
}

/** `global (/usr/local/bin/wazap)`: the kind is what decides an upgrade, the path is the proof. */
function describeInstall(install: Install): string {
  return install.script === "" ? install.kind : `${install.kind} (${shortPath(install.script)})`;
}

function richStatus(report: StatusReport): string[] {
  const account = !report.credentials_readable
    ? "credentials unreadable"
    : report.account
      ? describeAccount(report.account)
      : "not linked";
  return [
    `${bold(`wazap ${report.wazap_version}`)}${dim(` · baileys ${report.baileys_version}`)}`,
    row("data dir", tilde(report.data_dir)),
    row("install", describeInstall(report.install)),
    row("account", account),
    ...(report.accounts.length > 1
      ? report.accounts.map((entry) =>
          entry.default
            ? row("accounts", `${describeStatusAccount(entry)}  (default)`)
            : row("", describeStatusAccount(entry))
        )
      : []),
    row("server", serverState(report)),
    "",
    ...report.checks.flatMap(checkLines),
  ];
}

function liveLines(live: LiveReport): string[] {
  if (!live.reachable) return [`live: no connection (${live.reason ?? "unknown"})`];
  return [
    "live: phone reachable",
    `live: ${live.chats === null ? "chats not synced in time" : `${live.chats} chats synced`}`,
    `live: last message ${live.last_message_age ?? "unknown"}`,
  ];
}

/**
 * Hold the session for a one-shot command: null once the lock is ours, otherwise
 * the pid that owns it. The claim only fails while the file exists, so a lost
 * race is looked up again rather than reported as a missing pid.
 */
function takeSessionLock(lockFile: string): number | null {
  for (let attempt = 0; attempt < 5; attempt++) {
    const running = lockHolder(lockFile);
    if (running !== null) return running;
    if (writeLock(lockFile)) return null;
  }
  throw new WazapError("WHATSAPP_ERROR", `Could not take the session lock in ${lockFile}.`, "Run the command again");
}

const SERVICE_HEALTH_TIMEOUT_MS = 5_000;

/**
 * What the installed service says about itself, for the callers that would
 * otherwise have to refuse: it holds the session, so nobody else may open it.
 */
export async function serviceLive(config: Config, pid: number): Promise<LiveReport | null> {
  const held = serviceHolding(config.dataDir, pid);
  if (held === null) return null;
  const health = await fetchHealth(held.record.port, SERVICE_HEALTH_TIMEOUT_MS);
  if (health === null) {
    return { reachable: false, chats: null, last_message_age: null, reason: "the service is not answering /healthz" };
  }
  return {
    reachable: health.status === "connected",
    chats: null,
    last_message_age: null,
    reason: health.status === "connected" ? null : health.status,
  };
}

/** One process owns the session, so a probe only runs when no server holds the lock. */
export async function runLiveProbe(config: Config): Promise<LiveReport> {
  const p = paths(config.dataDir);
  // The probe owns the session for as long as it runs, exactly like the server.
  const running = takeSessionLock(p.lockFile);
  if (running !== null) {
    const live = await serviceLive(config, running);
    if (live !== null) return live;
    throw new WazapError(
      "WHATSAPP_ERROR",
      `A server (pid ${running}) already owns this session.`,
      "use get_status through your client, or wazap status"
    );
  }

  const wa = openService(config);
  const deadline = Date.now() + LIVE_TIMEOUT_MS;
  try {
    await wa.start();
    let probe = wa.getStatus();
    while (!SETTLED_STATUSES.includes(probe.status) && Date.now() < deadline) {
      await sleep(250);
      probe = wa.getStatus();
    }
    if (probe.status !== "connected") {
      return { reachable: false, chats: null, last_message_age: null, reason: probe.last_error ?? probe.status };
    }

    // listChats waits on its own sync gate, which would outlast the deadline.
    const chats = await Promise.race([
      wa.listChats("all", 100_000).then((synced) => synced.data),
      sleep(Math.max(0, deadline - Date.now()), null, { ref: false }),
    ]).catch(() => null);
    const newest = (chats ?? [])
      .map((chat) => (chat.last_message === null ? 0 : Date.parse(chat.last_message.timestamp)))
      .reduce((a, b) => Math.max(a, b), 0);
    return {
      reachable: true,
      chats: chats === null ? null : chats.length,
      last_message_age: newest === 0 ? null : formatAge(newest),
      reason: null,
    };
  } finally {
    await wa.stop();
    releaseLock(p.lockFile);
  }
}

/**
 * `wazap contacts resync`. One process owns the session, so this refuses while a
 * server holds it rather than fighting for the socket: that server asks
 * WhatsApp for an address book that looks empty on its own, when find_contact
 * needs names.
 */
export async function runContacts(config: Config): Promise<void> {
  if (config.args[0] !== "resync") {
    say(fail(`Unknown contacts command "${config.args[0]}".`));
    say(fix("Run `wazap contacts resync`"));
    process.exit(2);
  }

  const p = paths(config.dataDir);
  const running = takeSessionLock(p.lockFile);
  if (running !== null) {
    say(fail(`wazap is running (pid ${running}).`));
    say(fix("stop the server and run this again; a running server asks for an empty address book itself when find_contact needs it"));
    process.exit(1);
  }

  const wa = openService(config);
  const spin = spinner("Asking WhatsApp for your address book…");
  try {
    await wa.start();
    const deadline = Date.now() + LIVE_TIMEOUT_MS;
    let probe = wa.getStatus();
    while (!SETTLED_STATUSES.includes(probe.status) && Date.now() < deadline) {
      await sleep(250);
      probe = wa.getStatus();
    }
    const result = await wa.syncContacts();
    spin.stop(
      result.named_after > result.named_before
        ? ok(`${result.named_after} contacts have a name (was ${result.named_before})`)
        : result.named_after > 0
          ? ok(`Already up to date: ${result.named_after} contacts have a name`)
          : warn("WhatsApp sent no names at all. The phone has no saved contacts for these people.")
    );
  } catch (err) {
    const failure = asWazapError(err);
    spin.stop(fail(failure.message));
    if (failure.fix) say(fix(failure.fix));
    process.exitCode = 1;
  } finally {
    await wa.stop();
    releaseLock(p.lockFile);
  }
}

const MIB = 1024 * 1024;

function mib(bytes: number): number {
  return Math.round(bytes / MIB);
}

/** `wazap transcribe download` and `wazap transcribe test <audio file>`. */
export async function runTranscribe(config: Config): Promise<void> {
  const [verb, file] = config.args;
  const settings = readTranscribeSettings(process.env, config.dataDir);
  if (verb === "download" && file === undefined) {
    await ensureDeps([DEPS.whisper, DEPS.ffmpeg], config);
    await downloadTranscribeModel(settings, modelSpec(config.modelName ?? settings.model));
    return;
  }
  if (verb === "test" && file !== undefined) {
    await testTranscribe(settings, file);
    return;
  }
  throw new WazapError(
    "INVALID_ID",
    `Cannot run \`wazap transcribe ${config.args.join(" ")}\`.`,
    "Run `wazap transcribe download` or `wazap transcribe test <audio file>`"
  );
}

/**
 * Also `setup`'s download step. A model already on disk is re-hashed rather than
 * trusted, which is why the line starts as a check and only then becomes a fetch.
 */
export async function downloadTranscribeModel(settings: TranscribeSettings, spec: ModelSpec): Promise<void> {
  const spin = spinner(`Checking ${spec.file}…`);
  try {
    const result = await downloadModel(settings.modelsDir, spec, (progress) => {
      const percent = Math.floor((progress.received / progress.total) * 100);
      spin.update(`Downloading ${spec.file} — ${mib(progress.received)} / ${mib(progress.total)} MiB (${percent}%)`);
    });
    spin.stop(ok(`${spec.file} (${mib(spec.bytes)} MiB) ${result.alreadyPresent ? "already present" : "verified"}`));
  } catch (err) {
    spin.stop();
    throw err;
  }
}

/** `wazap embed download`. */
export async function runEmbed(config: Config): Promise<void> {
  const [verb] = config.args;
  if (verb !== "download") {
    throw new WazapError(
      "INVALID_ID",
      `Cannot run \`wazap embed ${config.args.join(" ")}\`.`,
      "Run `wazap embed download`"
    );
  }
  await ensureDeps([DEPS.llama], config);
  const settings = readRecallSettings(process.env, config.dataDir);
  await downloadEmbedModel(settings, config.modelName);
}

/** The same check-then-fetch dance downloadTranscribeModel does, for the embed table. */
export async function downloadEmbedModel(settings: RecallSettings, modelName?: string): Promise<void> {
  const spec = embedModelSpec(modelName ?? settings.model);
  const spin = spinner(`Checking ${spec.file}…`);
  try {
    const result = await downloadEmbed(settings.modelsDir, spec, (progress) => {
      const percent = Math.floor((progress.received / progress.total) * 100);
      spin.update(`Downloading ${spec.file} — ${mib(progress.received)} / ${mib(progress.total)} MiB (${percent}%)`);
    });
    spin.stop(ok(`${spec.file} (${mib(spec.bytes)} MiB) ${result.alreadyPresent ? "already present" : "verified"}`));
  } catch (err) {
    spin.stop();
    throw err;
  }
}

/** What identifies each provider on screen. Keyed like PROVIDERS, never branched on. */
const PROVIDER_ROWS: Record<ProviderName, (settings: TranscribeSettings) => [string, string][]> = {
  local: (settings) => [
    ["provider", "local (whisper.cpp)"],
    ["model", MODELS[settings.model].file],
  ],
  openai: (settings) => [
    ["provider", `openai (${new URL(settings.baseUrl).host})`],
    ["model", settings.apiModel],
    ["key", maskKey(settings.apiKey)],
  ],
};

async function testTranscribe(settings: TranscribeSettings, file: string): Promise<void> {
  const readiness = await transcribeReady(settings);
  const provider = settings.provider;
  if (provider === null || !readiness.ok) {
    throw new WazapError("TRANSCRIBE_UNAVAILABLE", readiness.detail, readiness.fix);
  }

  for (const [label, value] of PROVIDER_ROWS[provider](settings)) say(row(label, value));
  say(row("language", settings.language));
  say("");

  const started = Date.now();
  const spin = spinner(`Transcribing ${shortPath(file)}…`);
  const transcript = await transcribeFile(settings, file).finally(() => spin.stop());

  const facts = [
    `transcribed in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    transcript.language,
    transcript.duration_seconds === undefined ? undefined : clockLabel(transcript.duration_seconds),
  ];
  say(ok(facts.filter((fact) => fact !== undefined).join(" · ")));
  say(`"${transcript.text}"`);
}

/**
 * The one line that names the leftover pid, so greet, login and logout cannot
 * drift. `kill` on a service-held pid just gets it restarted by the supervisor,
 * so that case names the service verb instead.
 */
export function leftoverFix(pid: number, heldByService = false): string {
  return heldByService ? "stop it first: `wazap service stop`" : `stop it first: kill ${pid}`;
}

/** A setting the running server reads only at start asks for a restart, on the spot. */
export function warnIfServerRunning(config: Config): void {
  const running = lockHolder(paths(config.dataDir).lockFile);
  if (running !== null) say(warn(`A server is running (pid ${running}); restart it for this to apply.`));
}

/**
 * A client-launched wazap holding the session, or null if the lock is free or
 * the background service owns it (that one we can stop ourselves).
 */
export function leftoverRefusal(config: Config): WazapError | null {
  const running = lockHolder(paths(config.dataDir).lockFile);
  if (running === null) return null;
  if (serviceHolding(config.dataDir, running) !== null) return null;
  return new WazapError("WHATSAPP_ERROR", `wazap is running (pid ${running}).`, leftoverFix(running));
}

export type GreetState = Pick<StatusReport, "linked" | "credentials_readable" | "server_pid" | "server_is_service">;

/** After status, the lines that say what to type next. A leftover does not hide them. */
export function greetNext(report: GreetState): string[] {
  const lines: string[] = [];
  if (report.server_pid !== null) {
    lines.push(info(`A server is already running (pid ${report.server_pid}).`));
    if (!report.linked || !report.credentials_readable) {
      lines.push(fix(leftoverFix(report.server_pid, report.server_is_service === true)));
    }
  }
  if (!report.credentials_readable) {
    lines.push(next("wazap logout", "(then wazap login)"));
    return lines;
  }
  if (!report.linked) {
    lines.push(next("wazap setup"));
    return lines;
  }
  if (report.server_pid !== null) return lines;
  lines.push(next("wazap connect claude-code", '(then ask your agent: "what did I miss on WhatsApp today?")'));
  return lines;
}

/** Bare `wazap` at a terminal: where you stand, and the one command to run next. */
export async function runGreet(config: Config): Promise<void> {
  say(banner());
  say("");
  const report = await runStatus(config);
  say("");
  for (const line of greetNext(report)) say(line);
}

/**
 * Loopback is only private while nothing tunnels to it. With no read token and
 * no sign-in, a tunnel on this machine hands the read tools to whoever finds
 * its URL, so that is refused the way an open non-loopback bind is.
 */
export function tunnelRefusal(
  config: Pick<Config, "httpHost" | "httpPort" | "readToken" | "publicUrl" | "oauthPassword">,
  registry: readonly Supervisor[] = SUPERVISORS
): { message: string; fix: string } | null {
  if (config.readToken || (config.publicUrl && config.oauthPassword) || config.httpPort === 0) return null;
  const supervisor = registry.find((entry) => entry.available());
  if (supervisor === undefined) return null;
  const tunnels = tunnelsTo(supervisor, config.httpPort);
  if (tunnels.length === 0) return null;
  return {
    message: `Refusing to serve ${config.httpHost}:${config.httpPort} without a token: ${tunnels.map((unit) => unit.label).join(", ")} ${tunnels.length === 1 ? "tunnels" : "tunnel"} to it.`,
    fix: `Set WAZAP_READ_TOKEN, or WAZAP_PUBLIC_URL and WAZAP_OAUTH_PASSWORD for sign-in, or stop the tunnel with \`${tunnels.map((unit) => unit.stop).join("; ")}\``,
  };
}

export async function runServe(config: Config): Promise<void> {
  if (config.accountId !== undefined) {
    throw new WazapError(
      "INVALID_ID",
      "wazap serve starts every enabled account.",
      "Drop --account; pick an account on login, logout, or status"
    );
  }

  const p = paths(config.dataDir);

  // Losing the atomic claim means another `serve` won it, and the next pass finds
  // its sidecar and becomes a bridge onto it.
  let claimed = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const role = await decideRole(config, p);
    if (role.kind === "refuse") {
      say(fail(role.message));
      process.exit(2);
    }
    if (role.kind === "bridge") {
      // Bridging onto a running daemon is the rare role; the MCP client stack
      // it needs stays out of the common path until then.
      const { runBridge } = await import("./bridge.js");
      await runBridge(role.daemon, p.daemonFile);
      return;
    }

    // Loopback with no token only gets runHttp's warning; off-loopback is refused.
    if (config.transport === "http" && !config.readToken && !LOOPBACK_HOSTS.includes(config.httpHost)) {
      say(fail(`Refusing to serve ${config.httpHost} without a token. Set WAZAP_READ_TOKEN, or bind 127.0.0.1.`));
      process.exit(1);
    }
    if (config.transport === "http") {
      const problem = oauthProblem(config);
      if (problem) {
        say(fail(problem));
        process.exit(1);
      }
      const tunnel = tunnelRefusal(config);
      if (tunnel) {
        say(fail(tunnel.message));
        say(fix(tunnel.fix));
        process.exit(1);
      }
    }

    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    if (writeLock(p.lockFile)) {
      claimed = true;
      break;
    }
  }
  if (!claimed) {
    say(fail(`Another wazap keeps taking ${config.dataDir} as this one starts. Run it again.`));
    process.exit(2);
  }

  process.on("exit", () => {
    removeDaemon(p.daemonFile);
    removeDaemon(p.controlFile);
    releaseLock(p.lockFile);
  });

  let hub: AccountHub;
  try {
    hub = new AccountHub(config, AccountRegistry.load(config.dataDir));
  } catch (err) {
    if (err instanceof WazapError) {
      say(fail(`${err.message}${err.fix ? ` ${err.fix}` : ""}`));
      process.exit(1);
    }
    throw err;
  }
  let stopping = false;
  const shutdown = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    log(`received ${reason}, shutting down`);
    // A wedged socket must not cost the user a kill -9; the lock goes on "exit".
    setTimeout(() => process.exit(0), 3_000).unref();
    void hub
      .stop()
      .catch((err: unknown) => logError("shutdown", err))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // A socket WhatsApp keeps refusing is not something this process can fix, and
  // a live MCP server answering NOT_CONNECTED forever is worse than a dead one:
  // exiting hands the problem to whoever started us, which is a supervisor that
  // restarts it, or a client that shows the error. An unlinked device is the
  // exception and stays up in auth_failure, because no restart brings it back.
  // One dead account stays down; the process exits only when every enabled
  // account has given up.
  hub.onGiveUp = () => {
    logError("whatsapp", "reconnects exhausted on every enabled account; exiting so the supervisor can restart wazap");
    process.exit(GAVE_UP_EXIT);
  };

  // Connecting in the background: MCP startup never waits on WhatsApp, and the
  // tools answer NOT_LINKED until a session exists.
  hub.start().catch((err: unknown) => logError("whatsapp start", err));

  await publishControl(hub, p);

  const token = config.share ? randomBytes(32).toString("hex") : null;

  if (config.transport === "http") {
    const port = await runHttp(hub, config, token === null ? undefined : { token, write: true, localFiles: true, label: "local" });
    // Off-loopback binds get no sidecar: a bridge on this machine could not reach them.
    if (token !== null && SHAREABLE_HOSTS.includes(config.httpHost)) {
      writeDaemon(p.daemonFile, { pid: process.pid, port, token, version: WAZAP_VERSION });
    }
    return;
  }

  if (token !== null) {
    const port = await startLoopbackEndpoint(hub, config, token);
    writeDaemon(p.daemonFile, { pid: process.pid, port, token, version: WAZAP_VERSION });
  }
  await runStdio(hub, config);
  if (token === null) return;

  // The loopback endpoint keeps the event loop alive, so stdin EOF no longer ends
  // the process on its own. When the daemon's own client goes away the daemon goes
  // with it, rather than lingering for bridges. Registered after runStdio, so the
  // transport is already reading and "end" fires.
  process.stdin.on("end", () => shutdown("stdin end"));
  process.stdin.on("close", () => shutdown("stdin close"));
}

/**
 * The CLI's line to this process, whether or not the session is shared: `account`
 * changes and `logout` reach the running roster through it instead of asking
 * for a restart. A server that cannot open it still serves; those commands then
 * behave as they do against an older wazap.
 */
async function publishControl(hub: AccountHub, p: Paths): Promise<void> {
  const token = randomBytes(32).toString("hex");
  try {
    const port = await startControlEndpoint(hub, token);
    writeDaemon(p.controlFile, { pid: process.pid, port, token, version: WAZAP_VERSION });
  } catch (err) {
    log(`control endpoint unavailable${withCode(err)}; account changes will need a restart`);
  }
}

export interface Stepper {
  (title: string): void;
  /** Consume a step without painting it. TTY link screens replace "Link". */
  skip(): void;
}

export function stepper(total: number): Stepper {
  let n = 0;
  const announce = ((title: string) => openScreen(++n, total, title)) as Stepper;
  announce.skip = () => {
    n += 1;
  };
  return announce;
}

export async function runLogin(config: Config): Promise<void> {
  const selected = resolveAccount(config.dataDir, config.accountId);
  const linked = readLinkedAccount(selected.paths.authDir);
  if (!linked) {
    const refusal = leftoverRefusal(config);
    if (refusal !== null) throw refusal;
  }
  const loginCode = linked ? config.loginCode : await chooseLoginCode(config);
  const resolved = { ...config, loginCode };
  const askWrites = resolved.writesAnswer === null && !resolved.assumeYes && process.stdin.isTTY === true;
  const w = maybeWizard(linked ? 1 : loginWizardSteps(loginCode, askWrites));
  try {
    if (!w) say(banner());

    if (linked) {
      if (w) {
        await w.next("Already linked", [
          wizOk(`Already linked as ${describeAccount(linked)}`),
          wizInfo("Run `wazap logout` to relink."),
          "",
          connectNext(),
        ]);
      } else {
        say("");
        say(ok(`Already linked as ${describeAccount(linked)}`));
        say(info("Run `wazap logout` to relink."));
        say("");
        say(connectNext());
      }
      return;
    }

    await linkAndSync(resolved, w ? () => {} : stepper(loginCode ? 4 : 3), w);
    if (!w) {
      say("");
      say(connectNext());
    }
  } finally {
    w?.close();
  }
  process.exit(0);
}

/**
 * Pairing owns the session the way the server does, so the lock is held from
 * here until the history has landed. Writes are offered after it is released:
 * that question edits .env, not the session, and it waits on a human.
 */
export async function linkAndSync(
  config: Config,
  announce: (title: string) => void = () => {},
  w: Wizard | null = null
): Promise<void> {
  const p = paths(config.dataDir);
  const selected = resolveAccount(config.dataDir, config.accountId);

  const resumeService = await yieldSession(config, p.lockFile);
  // The lock goes the moment pairing is over; the service waits until the
  // writes answer is on disk, so it starts with the setting it should run under.
  const release = (): void => releaseLock(p.lockFile);
  const bail = (): void => {
    release();
    resumeService();
  };
  const onInterrupt = (): void => {
    bail();
    process.exit(130);
  };
  const onTerminate = (): void => {
    bail();
    process.exit(143);
  };
  process.on("exit", bail);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  try {
    let phone: string | null = null;
    if (config.loginCode) {
      if (w) await w.next("Your number");
      else announce("Your number");
      phone = config.loginPhone === undefined ? await askPhone(w) : normalizePhone(config.loginPhone);
      if (w) await w.paint([wizOk(maskNumber(phone))]);
      else say(ok(maskNumber(phone)));
    }

    const waiting = new Countdown(Date.now() + PAIRING_TIMEOUT_MS);
    if (!w) announce("Link your phone");

    let account: LinkedAccount;
    try {
      account =
        phone === null
          ? await linkByQr(selected.paths, waiting, w)
          : await linkByCode(selected.paths.authDir, phone, waiting, w);
    } catch (err) {
      waiting.stop();
      throw err;
    }
    selected.registry.setOwner(selected.account.id, account.id);
    if (w) waiting.stop();
    else waiting.stop(ok(`Linked as ${describeAccount(account)}`));

    if (w) await w.next("Syncing your chats", [wizOk(`Linked as ${describeAccount(account)}`)]);
    else announce("Sync your chats");
    await syncAfterLink(config, w);
  } catch (err) {
    resumeService();
    throw err;
  } finally {
    release();
    process.off("exit", bail);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }

  const askWrites = config.writesAnswer === null && !config.assumeYes && process.stdin.isTTY === true;
  if (w) {
    if (askWrites) {
      await w.next("Sending messages", [
        "Off unless you say yes. The agent can then send, reply, react and manage chats.",
      ]);
    }
  } else {
    announce("Permissions");
  }
  try {
    await offerWrites(config, w);
  } finally {
    resumeService();
  }
}

/** The same pairing the `link_account` tool runs, with the code shown in a box. */
async function linkByCode(
  authDir: string,
  phone: string,
  waiting: Countdown,
  w: Wizard | null
): Promise<LinkedAccount> {
  const pairing = await startPairing(authDir, phone, PAIRING_TIMEOUT_MS);
  const pretty = prettyCode(pairing.code);
  if (!humanLayout()) say(`pairing code: ${pretty}`);
  if (w) {
    await w.next("Type this in WhatsApp", [
      "WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead",
      "",
      ...box(pretty).split("\n"),
    ]);
  } else {
    say("  On your phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead");
    say("");
    say(box(pretty));
    say("");
  }
  waiting.start();
  return pairing.done;
}

async function linkByQr(p: AccountPaths, waiting: Countdown, w: Wizard | null): Promise<LinkedAccount> {
  // The QR drawers are only needed by this one login path, not by serve.
  const [{ default: qrcode }, { default: qrcodeTerminal }] = await Promise.all([
    import("qrcode"),
    import("qrcode-terminal"),
  ]);
  if (w) {
    await w.next("Scan this with WhatsApp");
    waiting.start("Waiting for a QR from WhatsApp…");
  }
  // The last QR, so a resized window can redraw it: WhatsApp sends a new one
  // every so often, and the window may change height between two of them.
  let latest: string[] | null = null;
  const onResize = (): void => {
    if (w === null || latest === null) return;
    void w.paint(qrScreenBody(latest, terminalRows(), qrSavedLine(p.qrFile)), { reveal: false }).catch(() => {});
  };
  const onQr = async (qr: string): Promise<void> => {
    const art = await new Promise<string>((resolve) => {
      qrcodeTerminal.generate(qr, { small: true }, (drawn: string) => resolve(drawn));
    });
    const lines = art.trimEnd().split("\n");
    latest = lines;
    const saved = qrSavedLine(p.qrFile);
    if (w) {
      await w.paint(qrScreenBody(lines, terminalRows(), saved));
    } else {
      say(art);
      say("  Scan it with WhatsApp → Settings → Linked devices → Link a device");
      if (saved !== null) say(dim(`  ${saved}`));
      say("");
    }
    await qrcode.toFile(p.qrFile, qr);
    waiting.start();
  };
  if (w) process.on("SIGWINCH", onResize);
  try {
    const sock = await linkSession(p.authDir, { deadline: Date.now() + PAIRING_TIMEOUT_MS, onQr });
    try {
      return await settledAccount(sock, p.authDir);
    } finally {
      await sock.end(undefined);
    }
  } finally {
    process.off("SIGWINCH", onResize);
  }
}

const SERVICE_STOP_MS = 10_000;

/**
 * The session lock, held for pairing. A client's own server is the user's to
 * quit; the background service is ours to stop, which is why the returned
 * function starts it again. What `~/.wazap/link.sh` did by hand.
 */
export async function yieldSession(config: Config, lockFile: string, why = "pairing"): Promise<() => void> {
  const running = takeSessionLock(lockFile);
  if (running === null) return () => {};

  const held = serviceHolding(config.dataDir, running);
  if (held === null) {
    throw (
      leftoverRefusal(config) ??
      new WazapError("WHATSAPP_ERROR", `wazap is running (pid ${running}).`, leftoverFix(running))
    );
  }

  say(info(`Stopping the wazap service for ${why}`));
  held.supervisor.stop(held.record);
  let resumed = false;
  const resume = (): void => {
    if (resumed) return;
    resumed = true;
    held.supervisor.start(held.record);
  };

  const deadline = Date.now() + SERVICE_STOP_MS;
  while (Date.now() < deadline) {
    if (takeSessionLock(lockFile) === null) return resume;
    await sleep(200);
  }
  resume();
  throw new WazapError(
    "SERVICE_ERROR",
    `The wazap service (pid ${running}) did not let go of the session.`,
    "run `wazap service logs`"
  );
}

const HISTORY_WAIT_MS = 90_000;
const HISTORY_QUIET_MS = 3_000;

/**
 * WhatsApp sends the chat history exactly once, right after pairing, to the
 * socket that paired. The link socket has no store, so the real service takes
 * over here and stays up until the history has landed and gone quiet.
 */
async function syncAfterLink(config: Config, w: Wizard | null = null): Promise<void> {
  const wa = openService(config);
  const spin = spinner("Syncing your chats…");
  try {
    await wa.start();
    const deadline = Date.now() + HISTORY_WAIT_MS;
    let seen = "";
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const counts = wa.storeCounts();
      const key = `${counts.chats}/${counts.contacts}/${counts.messages}`;
      spin.update(
        `Syncing your chats…  ${counts.chats} chats, ${counts.contacts} contacts, ${counts.messages} messages`
      );
      if (!wa.hasHistory()) continue;
      if (key !== seen) {
        seen = key;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= HISTORY_QUIET_MS) {
        break;
      }
    }
  } finally {
    const counts = wa.storeCounts();
    const got = wa.hasHistory();
    await wa.stop();
    spin.stop(
      got
        ? w
          ? wizOk(`Synced ${counts.chats} chats, ${counts.contacts} contacts, ${counts.messages} messages`)
          : ok(`Synced ${counts.chats} chats, ${counts.contacts} contacts, ${counts.messages} messages`)
        : w
          ? wizWarn(
              "No history arrived in 90s. The server keeps listening; if chats stay empty, run `wazap logout` then `wazap login`."
            )
          : warn(
              "No history arrived in 90s. The server keeps listening; if chats stay empty, run `wazap logout` then `wazap login`."
            )
    );
  }
}

/**
 * The spinner shown while WhatsApp is asked to accept the code, counting the
 * pairing code down to the deadline it expires on.
 */
class Countdown {
  #spinner: Spinner | null = null;
  #ticker: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(private readonly deadline: number) {}

  line(): string {
    const left = Math.max(0, Math.round((this.deadline - Date.now()) / 1_000));
    return `Waiting for your phone…  (expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")})`;
  }

  /**
   * Animate a status line. Pass a message for the wait-before-QR state; omit it
   * to count the pairing code down. Calling again just changes the copy, the
   * spinner keeps turning.
   */
  start(text?: string): void {
    if (this.#stopped) return;
    const line = text ?? this.line();
    if (this.#spinner !== null) this.#spinner.update(line);
    else this.#spinner = spinner(line);
    if (this.#ticker !== null) clearInterval(this.#ticker);
    this.#ticker = null;
    if (text !== undefined) return;
    this.#ticker = setInterval(() => this.#spinner?.update(this.line()), 1_000);
    this.#ticker.unref();
  }

  stop(final?: string): void {
    this.#stopped = true;
    if (this.#ticker !== null) clearInterval(this.#ticker);
    this.#ticker = null;
    if (this.#spinner === null) {
      if (final !== undefined) say(final);
      return;
    }
    this.#spinner.stop(final);
    this.#spinner = null;
  }
}

export async function runLogout(config: Config): Promise<void> {
  const p = paths(config.dataDir);
  const selected = resolveAccount(config.dataDir, config.accountId);

  // A server holding the data dir logs the account out itself: it closes the
  // account's socket, runs the same logout, and keeps serving the rest.
  const served = await askRunningServer<{ outcome?: unknown }>(
    p.controlFile,
    p.lockFile,
    CONTROL_ROUTES.logout,
    { account_id: selected.account.id },
    LOGOUT_WAIT_MS
  );
  if (served.kind === "answered") {
    const outcome = served.body.outcome;
    if (!isLogoutOutcome(outcome)) {
      throw new WazapError(
        "SERVICE_ERROR",
        `The running server (pid ${served.pid}) gave no logout result.`,
        "Run `wazap status`"
      );
    }
    printLogout(outcome);
    process.exit(0);
  }

  const resumeService = await yieldSession(config, p.lockFile, "logout");
  try {
    printLogout(await logoutAccount(config.dataDir, selected.account.id));
  } finally {
    releaseLock(p.lockFile);
    resumeService();
  }
  process.exit(0);
}

function printLogout(outcome: LogoutOutcome): void {
  for (const line of logoutLines(outcome)) say(line);
}

/**
 * Writes stay off unless the user says otherwise, so a fresh link cannot message
 * anyone. A non-interactive login leaves the setting alone rather than guessing.
 */
export async function offerWrites(config: Config, w: Wizard | null = null): Promise<void> {
  if (config.writesAnswer !== null) {
    applyWrites(config, config.writesAnswer);
    return;
  }
  if (config.assumeYes || !process.stdin.isTTY) return;
  const question = "Allow the agent to send messages, react and manage chats? [y/N] ";
  const answer = w ? await w.prompt(question) : await ask(`${brand("?")} ${question}`);
  applyWrites(config, /^y(es)?$/i.test(answer.trim()));
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * A secret typed at the prompt, echoed nowhere: not as characters, not as stars.
 * readline is given no output stream at all, which is the only mute that holds
 * on current Node — overriding `_writeToOutput` no longer reaches the interface's
 * own writer. `terminal` still follows the real stdin, so a TTY goes into raw
 * mode (the kernel stops echoing too) and a pipe reads one line for a script.
 */
export async function askSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: undefined, terminal: process.stdin.isTTY === true });
  process.stderr.write(question);
  try {
    // End of input answers nothing rather than hanging the command, and the
    // caller refuses an empty secret.
    const answered = rl.question("").catch(() => "");
    return stripPasted(await Promise.race([answered, once(rl, "close").then(() => "")]));
  } finally {
    rl.close();
    process.stderr.write("\n");
  }
}

const PHONE_ATTEMPTS = 3;
const LINK_CHOICE_ATTEMPTS = 3;

export type LinkChoice = "qr" | "code" | "retry";

/**
 * Empty takes the default: the QR, or the pairing code when the window is too
 * short to hold the QR whole. 1 is the QR, 2 a pairing code. Anything else is
 * another try.
 */
export function parseLinkChoice(answer: string, qrFits = true): LinkChoice {
  const trimmed = answer.trim();
  if (trimmed === "") return qrFits ? "qr" : "code";
  if (trimmed === "1") return "qr";
  if (trimmed === "2") return "code";
  return "retry";
}

/**
 * Whether login/setup should pair with a code. Asked before the wizard so its
 * step count is already right. `--phone` / `--code` answer code, `--qr`
 * answers QR; a pipe or `--yes` keeps the QR.
 */
export async function chooseLoginCode(config: Config): Promise<boolean> {
  if (config.loginCode) return true;
  if (config.loginQr || config.assumeYes || process.stdin.isTTY !== true) return false;

  // Asked before there is a QR to measure, so the height is the usual one.
  const rows = terminalRows();
  const fits = qrFits(rows);
  const menu = [
    "Link with a QR or a pairing code?",
    fits ? "  1. QR code" : `  1. QR code (needs a window ${qrScreenRows()} rows tall; this one is ${rows})`,
    fits ? "  2. Pairing code (type on your phone)" : "  2. Pairing code (type on your phone), which needs no room",
  ];
  for (const line of menu) say(line);
  for (let attempt = 1; ; attempt++) {
    const answer = await ask(`${brand("?")} Choose: [${fits ? 1 : 2}] (enter to accept) `);
    const picked = parseLinkChoice(answer, fits);
    switch (picked) {
      case "qr":
        return false;
      case "code":
        return true;
      case "retry":
        if (attempt === LINK_CHOICE_ATTEMPTS) return !fits;
        say(fail("Type 1 or 2."));
        continue;
      default: {
        const _never: never = picked;
        return _never;
      }
    }
  }
}

/** A typo costs another prompt, not the whole login. */
async function askPhone(w: Wizard | null = null): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const question = "WhatsApp number, international format (e.g. +15550100): ";
    const answer = w ? await w.prompt(question) : await ask(`${brand("?")} ${question}`);
    try {
      return normalizePhone(answer);
    } catch (err) {
      if (attempt === PHONE_ATTEMPTS) throw err;
      if (w) await w.paint([wizFail("Use international format, e.g. +15550100")], { reveal: false });
      else say(fail("Use international format, e.g. +15550100"));
    }
  }
}
