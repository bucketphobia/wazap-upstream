import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { WazapError } from "./errors.js";
import { trustedProxies } from "./proxy-trust.js";

const require = createRequire(import.meta.url);
export const WAZAP_VERSION: string = (require("../package.json") as { version: string }).version;
export const BAILEYS_VERSION: string = (require("baileys/package.json") as { version: string }).version;

/** Where an effective setting came from, in precedence order. */
export type Source = "flag" | "env" | ".env" | "default";

export type Command =
  | "serve"
  | "login"
  | "setup"
  | "status"
  | "logout"
  | "connect"
  | "config"
  | "contacts"
  | "skills"
  | "service"
  | "expose"
  | "transcribe"
  | "embed"
  | "update"
  | "webhook"
  | "account"
  | "backup"
  | "migrate";

export interface Config {
  dataDir: string;
  readOnly: boolean;
  /** Always false outside tests since `WAZAP_SYNC_FULL_HISTORY` was retired. */
  syncFullHistory: boolean;
  /** Persist chats and messages under the data dir so they survive a restart. */
  persistHistory: boolean;
  /**
   * Strict retention: disappearing messages expire locally, and starting with
   * history off discards caches an earlier history-on run left. Off by default.
   */
  retention?: boolean;
  transport: "stdio" | "http";
  httpHost: string;
  httpPort: number;
  /** Proxy addresses allowed to supply X-Forwarded-For; default loopback only. */
  trustedProxies?: string[];
  readToken: string | null;
  writeToken: string | null;
  /** Where clients reach the HTTP endpoint from outside; with the password, turns OAuth on. */
  publicUrl: string | null;
  oauthPassword: string | null;
  /** Publish a loopback endpoint and a daemon.json sidecar so a bridge can reach this session. */
  share: boolean;
  /** Write-tool token bucket, per minute; an account's `rate_limit` overrides it. 0 disables the limit. */
  rateLimitPerMinute: number;
  /** Tool calls one MCP session may have running at once; 8 outside tests. */
  maxInFlight?: number;
  /** Tool calls the whole process may have running at once; 32 outside tests. */
  maxInFlightTotal?: number;
  /** HTTP POSTs to /mcp per credential per minute; 240 outside tests. */
  httpPostBudget?: number;
  sources: Record<"dataDir" | "readOnly" | "transport" | "transcribe" | "webhook" | "recall", Source>;
  command: Command;
  /** The command was named on the command line rather than defaulted to serve. */
  explicitCommand: boolean;
  /** Positionals after the command: the client for `connect`, the setting for `config`. */
  args: string[];
  dryRun: boolean;
  /** `backup` only: replace a file already at the destination. */
  force: boolean;
  /** `status` only: probe WhatsApp, and print the report as JSON. */
  live: boolean;
  json: boolean;
  loginPhone?: string;
  /** Pair with an 8-character code instead of the QR; implied by --phone. */
  loginCode: boolean;
  /** `login` asks about writes unless a flag already answered. */
  writesAnswer: boolean | null;
  /** `setup` only: print the agent procedure and exit. */
  agent: boolean;
  /** `setup` only, repeatable, overrides detection. */
  clients: string[];
  /** `setup` only: refuse the global install an npx run would otherwise offer. */
  noGlobal: boolean;
  /** Answer no to the `brew install` a missing dependency would otherwise offer. */
  noBrew: boolean;
  /** `setup` only: refuse the Claude Desktop restart it would otherwise offer. */
  relaunch: boolean;
  assumeYes: boolean;
  /** `transcribe download` only: the whisper model alias from --model. */
  modelName?: string;
  /** `setup` only: the answer to the transcription question, from --transcribe. */
  transcribeChoice?: string;
  /** `setup` only: the answer to the "keep running" question, from --service / --expose. */
  keepRunning: KeepRunning | null;
  /** `--account` on login, logout, status, config writes, webhook test, and short-lived services. */
  accountId?: string;
  /** `--name` on `account add`. */
  accountName?: string;
  /** `--event` on `webhook test`, as typed. `parseWebhookEvent` narrows it. */
  webhookEvent?: string;
}

export interface Paths {
  dataDir: string;
  lockFile: string;
  daemonFile: string;
  /** Where the running server tells the CLI how to reach its private control endpoint. */
  controlFile: string;
  serviceFile: string;
  oauthFile: string;
  envFile: string;
  accountsFile: string;
}

export interface AccountPaths {
  root: string;
  authDir: string;
  mediaDir: string;
  historyDir: string;
  previewsDir: string;
  notesFile: string;
  storeFile: string;
  qrFile: string;
  /** The account database; `wazap status` and doctor read its webhook outbox read-only. */
  databaseFile: string;
}

export function paths(dataDir: string): Paths {
  return {
    dataDir,
    lockFile: join(dataDir, "server.lock"),
    daemonFile: join(dataDir, "daemon.json"),
    controlFile: join(dataDir, "control.json"),
    serviceFile: join(dataDir, "service.json"),
    oauthFile: join(dataDir, "oauth.json"),
    envFile: join(dataDir, ".env"),
    accountsFile: join(dataDir, "accounts.json"),
  };
}

export function accountPaths(dataDir: string, accountId: string): AccountPaths {
  const root = join(dataDir, "accounts", accountId);
  return {
    root,
    authDir: join(root, "auth"),
    mediaDir: join(root, "media"),
    historyDir: join(root, "history"),
    previewsDir: join(root, "previews"),
    notesFile: join(root, "notes.json"),
    storeFile: join(root, "store.json"),
    qrFile: join(root, "qr.png"),
    databaseFile: join(root, "wazap.sqlite"),
  };
}

/** The answer to `setup`'s "keep running" question. */
export type KeepRunning = "client" | "service" | "expose";

export type CliInvocation = { kind: "help" } | { kind: "version"; json: boolean } | { kind: "run"; config: Config };

/** How many positionals each command takes after its own name. */
const COMMAND_ARGS: Record<Command, readonly number[]> = {
  serve: [0],
  login: [0],
  setup: [0],
  status: [0],
  logout: [0],
  connect: [1],
  // A third positional is either someone typing the API key after
  // `config transcribe openai` — accepted so runConfig can refuse it with the
  // reason — or the list after `config send allow|deny`. One positional is
  // `config send`, which prints the rules.
  config: [0, 1, 2, 3],
  contacts: [1],
  // One positional is `skills install`, which finds the harnesses itself.
  skills: [1, 2],
  service: [1],
  // No positional means the first available provider; `off` takes the tunnel down.
  expose: [0, 1],
  transcribe: [1, 2],
  embed: [1],
  update: [0],
  webhook: [1],
  account: [1, 2],
  backup: [1],
  migrate: [1],
};

const COMMANDS = Object.keys(COMMAND_ARGS) as readonly Command[];

export const ACCOUNT_USAGE =
  "Run `wazap account add <id> [--name <name>]`, `wazap account remove|enable|disable|default <id>`, or `wazap account list`";

export const MIGRATE_USAGE = "Run `wazap migrate rollback`";

export const BACKUP_USAGE = "Run `wazap backup <path> [--account <id>] [--force]`";

/**
 * What to type instead of `--help` when the arity is wrong. Literals, not
 * imports: this file cannot reach `connect` or `service` without a cycle.
 */
const COMMAND_USAGE: Partial<Record<Command, string>> = {
  connect: "Pick one of: claude-code, claude-desktop, cursor, codex, gemini",
  skills: "Run `wazap skills install [<harness>]`",
  service: "Run `wazap service install|status|start|stop|restart|logs|uninstall`",
  transcribe: "Run `wazap transcribe download` or `wazap transcribe test <audio file>`",
  embed: "Run `wazap embed download`",
  contacts: "Run `wazap contacts resync`",
  config:
    "Run `wazap config`, `wazap config writes on|off`, `wazap config transcribe local|openai|off`, `wazap config recall local|off`, `wazap config webhook on|off|auth|no-auth|chats|tag|coalesce|retry-401|filter off`, `wazap config draft-context on|off`, or `wazap config send allow|deny <list>|open`",
  webhook: "Run `wazap webhook test`",
  account: ACCOUNT_USAGE,
  backup: BACKUP_USAGE,
  migrate: MIGRATE_USAGE,
};

export function defaultDataDir(): string {
  return resolve(join(homedir(), ".wazap"));
}

function asBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Whether write tools stay unregistered.
 *
 * Unset means writes are on (`false`). That is what `wazap config` prints as
 * "writes: on (default)" and what `WAZAP_READ_ONLY=0` also means. Login still
 * asks and may persist `1`. Only an explicit on-value (`1` / `true` / `yes` /
 * `on`) or `--read-only` turns writes off.
 */
export function readOnlySetting(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["", "0", "false", "no", "off"].includes(normalized)) return false;
  throw new WazapError("INVALID_ID", "WAZAP_READ_ONLY must be a boolean value.",
    "Set WAZAP_READ_ONLY to 1 to disable writes or 0 to enable them deliberately");
}

export const WRITES_ENABLE_FIX = "run `wazap config writes on`, then restart the server";

export const WRITES_ENABLE_HINT =
  "Write tools are not registered. Run `wazap config writes on` and restart the server.";

/** Operator-facing lines for status, doctor, setup and HTTP connect. Only `readOnly` decides them. */
export function writesHints(config: Pick<Config, "readOnly"> & Partial<Config>): string[] {
  return config.readOnly ? [WRITES_ENABLE_HINT] : [];
}

function asInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Settings an earlier wazap read and this one ignores, each with what stands in
 * its place now. One set in the environment or `.env` costs a warning line at
 * startup and changes nothing.
 */
export const RETIRED_SETTINGS: Readonly<Record<string, string>> = {
  WAZAP_SYNC_FULL_HISTORY:
    "wazap takes WhatsApp's default history sync, and `read_messages` with `before` pulls older messages",
  WAZAP_RATE_LIMIT: "writes are limited to 20 a minute, unless an account sets `rate_limit` in accounts.json",
  WAZAP_MAX_INFLIGHT: "one MCP session runs at most 8 tool calls at once",
  WAZAP_MAX_INFLIGHT_TOTAL: "all sessions together run at most 32 tool calls at once",
  WAZAP_HTTP_BUDGET: "each HTTP credential gets 240 requests a minute",
  WAZAP_TRANSCRIBE_LANGUAGE: "the spoken language is detected, and `get_media` takes a `language`",
  WAZAP_EMBED_IDLE_MINUTES: "the embedding server stops after 30 idle minutes",
  WAZAP_RECALL_MAX: "it capped nothing, and every kept message is indexed",
  WAZAP_TYPEWRITER: "the setup screens always type out at a terminal",
};

/**
 * Settings still honoured through 1.x. One set in the environment or `.env`
 * works as before and costs a warning line at startup; the line depends on the
 * value, since only some values do anything.
 */
export const DEPRECATED_SETTINGS: Readonly<Record<string, (value: string) => string>> = {
  WAZAP_TRANSPORT: (value) =>
    value.trim().toLowerCase() === "http"
      ? "WAZAP_TRANSPORT=http still works but is deprecated and goes away in 2.0: pass `--http` instead, as in `wazap serve --http`."
      : "WAZAP_TRANSPORT is deprecated and goes away in 2.0: stdio is the default; remove WAZAP_TRANSPORT.",
};

/** One line per retired or deprecated setting that is still set, saying what to use instead. */
export function settingWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const lines: string[] = [];
  for (const [key, message] of Object.entries(DEPRECATED_SETTINGS)) {
    const value = env[key];
    if (value !== undefined) lines.push(message(value));
  }
  for (const [key, now] of Object.entries(RETIRED_SETTINGS)) {
    if (env[key] !== undefined) {
      lines.push(`${key} is no longer read and was ignored: ${now}. Remove it from your environment or .env.`);
    }
  }
  return lines;
}

/**
 * A user_config slot the person never filled in reaches us as the literal
 * `${user_config.data_dir}`: the Claude Desktop bundle substitutes what it has
 * and leaves the rest alone. An unanswered question is not a data directory.
 */
function dropUnfilledTemplates(): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("WAZAP_") && /^\$\{[^}]*\}$/.test(value ?? "")) delete process.env[key];
  }
}

export type DefaultAction = "serve" | "greet";

/**
 * A human at a terminal running bare `wazap` wants to see where they stand, not
 * a silent MCP server on stdin. Everything else serves, including `wazap serve`.
 */
export function pickDefaultAction(
  config: Pick<Config, "command" | "explicitCommand" | "transport">,
  stdinTTY: boolean,
  stderrTTY: boolean
): DefaultAction {
  const human =
    config.command === "serve" && !config.explicitCommand && config.transport === "stdio" && stdinTTY && stderrTTY;
  return human ? "greet" : "serve";
}

export function parseCli(argv: string[] = process.argv.slice(2)): CliInvocation {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "data-dir": { type: "string" },
        "read-only": { type: "boolean" },
        http: { type: "boolean" },
        host: { type: "string" },
        port: { type: "string" },
        phone: { type: "string" },
        qr: { type: "boolean" },
        code: { type: "boolean" },
        "dry-run": { type: "boolean" },
        force: { type: "boolean" },
        live: { type: "boolean" },
        json: { type: "boolean" },
        writes: { type: "boolean" },
        "no-writes": { type: "boolean" },
        agent: { type: "boolean" },
        client: { type: "string", multiple: true },
        "no-global": { type: "boolean" },
        "no-brew": { type: "boolean" },
        relaunch: { type: "boolean" },
        model: { type: "string" },
        transcribe: { type: "string" },
        service: { type: "boolean" },
        expose: { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        event: { type: "string" },
        account: { type: "string" },
        name: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    throw new WazapError("INVALID_ID", err instanceof Error ? err.message : String(err), "Run `wazap --help`");
  }

  const { values, positionals } = parsed;
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version", json: values.json === true };

  dropUnfilledTemplates();

  const [first, ...args] = positionals;
  if (first !== undefined && !COMMANDS.includes(first as Command)) {
    throw new WazapError("INVALID_ID", `Unknown command "${first}".`, "Run `wazap --help`");
  }
  const command = (first as Command | undefined) ?? "serve";
  if (!COMMAND_ARGS[command].includes(args.length)) {
    throw new WazapError(
      "INVALID_ID",
      `Wrong arguments for \`wazap ${command}\`.`,
      COMMAND_USAGE[command] ?? "Run `wazap --help`"
    );
  }

  const dataDir = resolve(values["data-dir"] ?? process.env.WAZAP_DATA_DIR ?? defaultDataDir());

  // Snapshot before dotenv, which fills process.env from the data dir's .env
  // without overriding what the real environment already set.
  const shell = new Set(Object.keys(process.env).filter((key) => key.startsWith("WAZAP_")));
  dotenv.config({ path: paths(dataDir).envFile, quiet: true });
  const sourceOf = (key: string, flagged: boolean): Source => {
    if (flagged) return "flag";
    if (shell.has(key)) return "env";
    return process.env[key] === undefined ? "default" : ".env";
  };

  const httpFromEnv = process.env.WAZAP_TRANSPORT?.trim().toLowerCase() === "http";

  return {
    kind: "run",
    config: {
      dataDir,
      readOnly: values["read-only"] === true || readOnlySetting(process.env.WAZAP_READ_ONLY),
      syncFullHistory: false,
      persistHistory: asBool(process.env.WAZAP_PERSIST_HISTORY, true),
      retention: asBool(process.env.WAZAP_RETENTION, false),
      transport: values.http === true || httpFromEnv ? "http" : "stdio",
      httpHost: values.host ?? (process.env.WAZAP_HOST?.trim() || "127.0.0.1"),
      httpPort: values.port ? asInt(values.port, 8766) : asInt(process.env.WAZAP_PORT, 8766),
      trustedProxies: trustedProxies(process.env.WAZAP_TRUST_PROXY),
      readToken: (process.env.WAZAP_READ_TOKEN ?? "").trim() || null,
      writeToken: (process.env.WAZAP_WRITE_TOKEN ?? "").trim() || null,
      publicUrl: (process.env.WAZAP_PUBLIC_URL ?? "").trim().replace(/\/+$/, "") || null,
      oauthPassword: process.env.WAZAP_OAUTH_PASSWORD || null,
      share: !asBool(process.env.WAZAP_NO_SHARE, false),
      rateLimitPerMinute: 20,
      maxInFlight: 8,
      maxInFlightTotal: 32,
      httpPostBudget: 240,
      sources: {
        // Resolved before dotenv runs, so the data dir's own .env cannot name it.
        dataDir: values["data-dir"] !== undefined ? "flag" : shell.has("WAZAP_DATA_DIR") ? "env" : "default",
        readOnly: sourceOf("WAZAP_READ_ONLY", values["read-only"] === true),
        transport: sourceOf("WAZAP_TRANSPORT", values.http === true),
        transcribe: sourceOf("WAZAP_TRANSCRIBE", false),
        webhook: sourceOf("WAZAP_WEBHOOK", false),
        recall: sourceOf("WAZAP_RECALL", false),
      },
      command,
      explicitCommand: first !== undefined,
      args,
      dryRun: values["dry-run"] === true,
      force: values.force === true,
      live: values.live === true,
      json: values.json === true,
      loginPhone: values.phone,
      loginCode: values.code === true || values.phone !== undefined,
      writesAnswer: values.writes === true ? true : values["no-writes"] === true ? false : null,
      agent: values.agent === true,
      clients: values.client ?? [],
      noGlobal: values["no-global"] === true,
      noBrew: values["no-brew"] === true,
      relaunch: values.relaunch === true,
      assumeYes: values.yes === true,
      modelName: values.model,
      transcribeChoice: values.transcribe,
      keepRunning: values.expose === true ? "expose" : values.service === true ? "service" : null,
      accountId: values.account,
      accountName: values.name,
      webhookEvent: values.event,
    },
  };
}
