import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AccountRegistry, accountPolicy, draftContextEnabled, resolveAccount, type AccountRecord } from "./accounts.js";
import { ask, askSecret, warnIfServerRunning } from "./cli.js";
import { paths, writesHints, type Config } from "./config.js";
import { WazapError, asWazapError } from "./errors.js";
import { lockHolder } from "./lock.js";
import { say } from "./logger.js";
import { readRecallSettings } from "./recall/index.js";
import { normalizeSendRule } from "./send-guard.js";
import {
  maskKey,
  readTranscribeSettings,
  requireSafeUrl,
  stripPasted,
  transcribeReady,
  type Readiness,
  type TranscribeSettings,
} from "./transcribe/index.js";
import { brand, dim, fix, ok, shortPath, warn } from "./ui.js";
import {
  WEBHOOK_EVENTS_DEFAULT,
  WEBHOOK_EVENTS_FIX,
  WEBHOOK_ON_FIX,
  WEBHOOK_TEST_FIX,
  WebhookSink,
  describeWebhookEvents,
  parseWebhookEvent,
  parseWebhookEvents,
  readWebhookSettings,
  describeWebhookFilter,
  parseWebhookAuth,
  parseWebhookChats,
  requireCoalesceSeconds,
  requireWebhookTag,
  requireWebhookUrl,
  type WebhookEvent,
  type WebhookFilter,
  type WebhookOverride,
} from "./webhook.js";

/**
 * dotenv 16 treats an unquoted `#` as a comment, even with no space, and
 * trims unquoted padding. Quote so a secret like `p@ss#word` round-trips.
 * dotenv only expands `\n` / `\r` inside double quotes and does not unescape
 * `\"`, so the quote style is picked to avoid needing that.
 */
const SAFE_UNQUOTED = /^[A-Za-z0-9_./:@+-]*$/;

export function encodeEnvValue(value: string): string {
  if (SAFE_UNQUOTED.test(value)) return value;
  const hasSingle = value.includes("'");
  const hasDouble = value.includes('"');
  const hasTick = value.includes("`");
  const hasBreak = /[\n\r]/.test(value);
  if (!hasSingle && !hasBreak) return `'${value}'`;
  if (!hasDouble) return `"${value.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
  if (!hasTick && !hasBreak) return `\`${value}\``;
  return `"${value.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

/** Replace `KEY=` in place, keeping every other line, or append it. */
export function setEnvSetting(envFile: string, key: string, value: string): void {
  let text = "";
  try {
    text = readFileSync(envFile, "utf8");
  } catch {
    /* a data dir without an .env yet */
  }

  const line = `${key}=${encodeEnvValue(value)}`;
  const lines = text === "" ? [] : text.split("\n");
  // dotenv trims around `=` and applies last-wins, so every spelling of the key
  // has to go: leaving a later duplicate behind would silently outrank the edit.
  const assignment = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
  const hits = lines.flatMap((existing, index) => (assignment.test(existing) ? [index] : []));
  if (hits.length === 0) {
    const body = text.trimEnd();
    text = body === "" ? `${line}\n` : `${body}\n${line}\n`;
  } else {
    lines[hits[0]!] = line;
    text = lines.filter((_, index) => index === hits[0] || !hits.includes(index)).join("\n");
    if (!text.endsWith("\n")) text += "\n";
  }

  mkdirSync(dirname(envFile), { recursive: true, mode: 0o700 });
  // Replaced in one step: a write that fails halfway leaves the old .env whole,
  // never half of it. The mode argument only applies on creation; the chmod
  // covers a leftover temp file.
  const tmp = `${envFile}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, envFile);
}

/** Remove every assignment of `KEY` from the env file. A missing file is already clear. */
export function unsetEnvSetting(envFile: string, key: string): void {
  let text: string;
  try {
    text = readFileSync(envFile, "utf8");
  } catch {
    return;
  }
  const assignment = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
  const lines = text.split("\n").filter((line) => !assignment.test(line));
  let next = lines.join("\n");
  if (next !== "" && !next.endsWith("\n")) next += "\n";
  mkdirSync(dirname(envFile), { recursive: true, mode: 0o700 });
  const tmp = `${envFile}.${process.pid}.tmp`;
  writeFileSync(tmp, next, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, envFile);
}

interface SettingRow {
  label: string;
  value: (config: Config) => string;
  /** Where the value came from: a flag, the environment, `.env`, `accounts.json` or the default. */
  source: (config: Config) => string;
}

function writesSource(config: Config): string {
  const selected = resolveAccount(config.dataDir, config.accountId);
  return selected.account.writes === undefined ? config.sources.readOnly : "accounts.json";
}

/** The fixed default, unless the account sets its own `rate_limit`. */
function rateLimitSource(config: Config): string {
  return resolveAccount(config.dataDir, config.accountId).account.rate_limit === undefined ? "default" : "accounts.json";
}

function effectiveRateLimit(config: Config): string {
  const { rateLimit } = accountPolicy(resolveAccount(config.dataDir, config.accountId).account, config);
  return rateLimit === 0 ? "off" : `${rateLimit} writes/minute`;
}

const SETTINGS: readonly SettingRow[] = [
  { label: "data dir", value: (config) => config.dataDir, source: (config) => config.sources.dataDir },
  {
    label: "writes",
    value: (config) =>
      accountPolicy(resolveAccount(config.dataDir, config.accountId).account, config).readOnly ? "off" : "on",
    source: writesSource,
  },
  {
    label: "transport",
    value: (config) =>
      config.transport === "http"
        ? `http ${config.httpHost}:${config.httpPort}${config.publicUrl && config.oauthPassword ? ` · oauth at ${config.publicUrl}` : ""}`
        : "stdio",
    source: (config) => config.sources.transport,
  },
  { label: "rate limit", value: effectiveRateLimit, source: rateLimitSource },
  {
    label: "draft context",
    value: (config) => (draftContextEnabled(resolveAccount(config.dataDir, config.accountId).account) ? "on" : "off"),
    source: (config) => (resolveAccount(config.dataDir, config.accountId).account.draft_context === undefined ? "default" : "accounts.json"),
  },
];

/** Every setting `wazap config <name> <value>` can change, and what each accepts. */
const COMMANDS: Record<string, { values: readonly string[]; apply: (config: Config, value: string) => Promise<void> }> =
  {
    writes: {
      values: ["on", "off"],
      apply: async (config, value) => applyWrites(config, value === "on"),
    },
    transcribe: {
      values: ["local", "openai", "off"],
      apply: applyTranscribe,
    },
    recall: {
      values: ["local", "off"],
      apply: applyRecall,
    },
    webhook: {
      values: ["on", "off", "auth", "no-auth"],
      apply: applyWebhook,
    },
    "draft-context": {
      values: ["on", "off"],
      apply: async (config, value) => applyDraftContext(config, value === "on"),
    },
  };

const USAGE_FIX =
  "Run `wazap config writes on|off`, `wazap config transcribe local|openai|off`, `wazap config recall local|off`, `wazap config webhook on|off|auth|no-auth|chats|tag|coalesce|retry-401|filter off`, `wazap config draft-context on|off`, or `wazap config send allow|deny <list>|open`";

const WEBHOOK_OPTION_FIX =
  "Run `wazap config webhook chats <list>|none|off`, `wazap config webhook tag <name>|off`, `wazap config webhook coalesce <seconds>|off`, `wazap config webhook retry-401 on|off`, or `wazap config webhook filter off`";

const SEND_USAGE_FIX =
  'Run `wazap config send` to see the rules, `wazap config send allow <list>` or `wazap config send deny <list>` with numbers and chat ids comma-separated (`none` empties the list), or `wazap config send open` to lift every restriction';

export async function runConfig(config: Config): Promise<void> {
  if (config.args.length === 0) {
    for (const row of SETTINGS) {
      say(`${row.label}: ${row.value(config)} (${row.source(config)})`);
    }
    for (const line of transcribeRows(config)) say(line);
    for (const line of recallRows(config)) say(line);
    for (const line of webhookRows(config)) say(line);
    for (const line of sendRuleRows(config)) say(line);
    say("");
    say(
      dim(
        "Change writes with `wazap config writes on|off`, transcription with `wazap config transcribe`, recall with `wazap config recall`, webhook with `wazap config webhook on|off|auth|no-auth` (and `chats`, `tag`, `coalesce`, `retry-401`), the draft context with `wazap config draft-context on|off`, send rules with `wazap config send`. Probe it with `wazap webhook test`."
      )
    );
    const selected = resolveAccount(config.dataDir, config.accountId);
    for (const line of writesHints({ ...config, readOnly: accountPolicy(selected.account, config).readOnly })) {
      say(dim(line));
    }
    return;
  }

  const [setting, value, extra] = config.args;
  // chats, tag, coalesce and retry-401 take a value that is not a secret.
  // `on` with an extra argument is still the secret, and still refused.
  if (setting === "webhook" && value !== undefined && value !== "on" && value !== "off" && value !== "auth" && value !== "no-auth") {
    await applyWebhookOption(config, value, extra);
    return;
  }
  if (extra !== undefined && (setting === "transcribe" || setting === "webhook" || setting === "recall")) {
    throw new WazapError(
      "INVALID_ID",
      "The API key or webhook secret is never a command-line argument: it would be kept in your shell history and readable in `ps` by anyone on this machine.",
      setting === "webhook"
        ? "Run `wazap config webhook on` and paste the secret at the prompt, which does not echo it"
        : "Run `wazap config transcribe openai` and paste the key at the prompt, which does not echo it"
    );
  }

  if (setting === "send") {
    runSendRules(config, value, extra);
    return;
  }

  // `send` is the only one-positional form; every other is a missing value,
  // the arity complaint parseCli gave before `send` existed.
  if (value === undefined) {
    throw new WazapError("INVALID_ID", "Wrong arguments for `wazap config`.", USAGE_FIX);
  }
  const spec = setting === undefined ? undefined : COMMANDS[setting];
  if (spec === undefined || extra !== undefined || !spec.values.includes(value)) {
    throw new WazapError("INVALID_ID", `Cannot set "${config.args.join(" ")}".`, USAGE_FIX);
  }
  await spec.apply(config, value);
}

/**
 * `wazap config draft-context on|off`: whether find_contact hands an assistant
 * the recent exchange and the user's style with a contact it resolved, for the
 * selected account. Kept in accounts.json and read on every call, so it applies
 * to the next find_contact without a restart. A contact tagged `#private`
 * gets style only either way.
 */
function applyDraftContext(config: Config, on: boolean): void {
  const selected = resolveAccount(config.dataDir, config.accountId);
  const id = selected.account.id;
  selected.registry.setDraftContext(id, on);
  say(
    ok(
      on
        ? `draft context (${id}): on — find_contact attaches the recent exchange and the user's style to a contact it resolves.`
        : `draft context (${id}): off — find_contact attaches no messages and no style.`
    )
  );
  say(dim(`Stored in ${shortPath(paths(config.dataDir).accountsFile)} — applies to the next find_contact.`));
}

/**
 * `wazap config send …` edits the account's send rules in accounts.json.
 * `allow <list>` makes the list exhaustive — `allow none` allows nobody —
 * `deny <list>` refuses its entries no matter what the allowlist says, and
 * `open` clears both. The tools re-read the file on every send, so the rules
 * apply to the next call, drafts already waiting included; no restart needed.
 */
function runSendRules(config: Config, verb: string | undefined, list: string | undefined): void {
  const selected = resolveAccount(config.dataDir, config.accountId);
  const id = selected.account.id;

  const parse = (raw: string | undefined): string[] => {
    if (raw === undefined) {
      throw new WazapError("INVALID_ID", `Cannot set \`wazap config send ${verb}\` without a list.`, SEND_USAGE_FIX);
    }
    return raw === "none" ? [] : raw.split(",").map((entry) => normalizeSendRule(entry));
  };

  switch (verb) {
    case undefined:
      say(`send rules (${id}): ${describeSendRules(selected.account)} (accounts.json)`);
      return;
    case "open":
      if (list !== undefined) {
        throw new WazapError("INVALID_ID", `Cannot set "${config.args.join(" ")}".`, SEND_USAGE_FIX);
      }
      selected.registry.setSendRules(id, { allow: null, deny: null });
      break;
    case "allow":
      selected.registry.setSendRules(id, { allow: parse(list) });
      break;
    case "deny":
      selected.registry.setSendRules(id, { deny: parse(list) });
      break;
    default:
      throw new WazapError("INVALID_ID", `Cannot set "${config.args.join(" ")}".`, SEND_USAGE_FIX);
  }
  say(ok(`send rules (${id}): ${describeSendRules(selected.registry.get(id)!)}.`));
  say(dim(`Stored in ${shortPath(paths(config.dataDir).accountsFile)} — applies to the next send call.`));
}

/** What `wazap config` prints: who the selected account may still message. */
function sendRuleRows(config: Config): string[] {
  const selected = resolveAccount(config.dataDir, config.accountId);
  return [`send rules (${selected.account.id}): ${describeSendRules(selected.account)} (accounts.json)`];
}

function describeSendRules(account: AccountRecord): string {
  const allow = account.send_allow;
  const deny = account.send_deny ?? [];
  const parts: string[] = [];
  if (allow === undefined) parts.push("open — anyone may be messaged");
  else if (allow.length === 0) parts.push("allowlist empty — nobody may be messaged");
  else parts.push(`allowlist: ${allow.join(", ")}`);
  if (deny.length > 0) parts.push(`denylist: ${deny.join(", ")}`);
  return parts.join(" · ");
}

/**
 * A stale `.env` is refused by readTranscribeSettings, and neither `config` nor
 * `status` may go down with it: the complaint is a line, not a crash.
 */
function transcribeSettings(env: NodeJS.ProcessEnv, dataDir: string): TranscribeSettings | WazapError {
  try {
    return readTranscribeSettings(env, dataDir);
  } catch (err) {
    return asWazapError(err);
  }
}

function transcribeRows(config: Config): string[] {
  const settings = transcribeSettings(process.env, config.dataDir);
  if (settings instanceof WazapError) {
    return [`transcribe: ${settings.message}${settings.fix === undefined ? "" : ` — ${settings.fix}`}`];
  }
  const rows = [`transcribe: ${settings.provider ?? "off"} (${config.sources.transcribe})`];
  if (settings.provider === "openai") rows.push(`api key: ${maskKey(settings.apiKey)}`);
  return rows;
}

/** Same failure-is-a-line rule as transcribeRows: a stale .env must not take config down. */
function recallRows(config: Config): string[] {
  try {
    const settings = readRecallSettings(process.env, config.dataDir);
    return [`recall: ${settings.enabled ? `local (${settings.model})` : "off"} (${config.sources.recall})`];
  } catch (err) {
    const failure = asWazapError(err);
    return [`recall: ${failure.message}${failure.fix === undefined ? "" : ` — ${failure.fix}`}`];
  }
}

const RECALL_SAID: Record<string, string> = {
  local: "recall: local — messages are embedded by llama.cpp on this machine; nothing leaves it.",
  off: "recall: off — `search` matches words only and says how to turn it on.",
};

async function applyRecall(config: Config, value: string): Promise<void> {
  const p = paths(config.dataDir);
  setEnvSetting(p.envFile, "WAZAP_RECALL", value);
  say(ok(RECALL_SAID[value]!));
  say(dim(`Stored in ${shortPath(p.envFile)}.`));
  const running = lockHolder(p.lockFile);
  if (running !== null) say(warn(`A server is running (pid ${running}); restart it for this to apply.`));
}

function accountWebhook(config: Config): { override: WebhookOverride; source: string } {
  const selected = resolveAccount(config.dataDir, config.accountId);
  const account = selected.account;
  const override: WebhookOverride = {
    url: account.webhook_url,
    secret: account.webhook_secret,
    events: account.webhook_events,
    auth: account.webhook_auth,
  };
  if (account.webhook_chats !== undefined || account.webhook_tag !== undefined) {
    override.filter = { chats: account.webhook_chats ?? [], tag: account.webhook_tag ?? null };
  }
  if (account.webhook_coalesce !== undefined) override.coalesce = account.webhook_coalesce;
  if (account.webhook_retry_401 !== undefined) override.retryUnauthorized = account.webhook_retry_401;
  const fromAccount =
    override.url !== undefined ||
    override.secret !== undefined ||
    override.events !== undefined ||
    override.auth !== undefined ||
    override.filter !== undefined ||
    override.coalesce !== undefined ||
    override.retryUnauthorized !== undefined;
  const source = fromAccount ? "accounts.json" : config.sources.webhook;
  return { override, source };
}

function webhookRows(config: Config): string[] {
  const { override, source } = accountWebhook(config);
  const settings = readWebhookSettings(process.env, override);
  switch (settings.kind) {
    case "off":
      return [`webhook: off (${source})`];
    case "ready":
      return [
        `webhook: on (${new URL(settings.url).host}) (${source})`,
        `secret: ${maskKey(settings.secret)}`,
        `events: ${settings.events.join(", ")}`,
        ...(settings.auth === undefined ? [] : [`auth: ${settings.auth.name} ${maskKey(settings.auth.value)}`]),
        filterLine(settings.filter),
        ...(settings.coalesce !== null
          ? [`coalesce: ${settings.coalesce.windowMs / 1000}s quiet, by ${settings.coalesce.capMs / 1000}s`]
          : override.coalesce === 0
            ? ["coalesce: off"]
            : []),
        ...(settings.retryUnauthorized ? ["retry 401: on"] : override.retryUnauthorized === false ? ["retry 401: off"] : []),
      ];
    case "invalid":
      return [`webhook: ${settings.detail}${settings.fix === "" ? "" : ` — ${settings.fix}`}`];
    default: {
      const _exhaustive: never = settings;
      return _exhaustive;
    }
  }
}

async function applyWebhook(config: Config, value: string): Promise<void> {
  if (value === "on") {
    await enableWebhook(config);
    return;
  }
  if (value === "auth") {
    await setWebhookAuth(config);
    return;
  }
  if (value === "no-auth") {
    clearWebhookAuth(config);
    return;
  }
  if (value === "off") {
    if (config.accountId !== undefined) {
      // The on/off switch is global; only the endpoint is per-account. `off`
      // scoped to an account drops its override so it follows the global again.
      AccountRegistry.load(config.dataDir).clearWebhook(config.accountId);
      const global = readWebhookSettings(process.env);
      say(
        ok(
          `webhook override removed for ${config.accountId} — the global webhook applies${global.kind === "off" ? " (off)" : ""}.`
        )
      );
      say(dim(`Stored in ${shortPath(paths(config.dataDir).accountsFile)}.`));
      warnIfServerRunning(config);
      return;
    }
    setWebhookFlag(config, "off");
    say(ok("webhook: off — nothing is posted anywhere. Turn it on with `wazap config webhook on`."));
    say(dim(`Stored in ${shortPath(paths(config.dataDir).envFile)}.`));
    warnIfServerRunning(config);
    return;
  }
  throw new WazapError("INVALID_ID", `Cannot set webhook "${value}".`, USAGE_FIX);
}

export async function runWebhook(config: Config): Promise<void> {
  const [verb] = config.args;
  if (verb !== "test") {
    throw new WazapError("INVALID_ID", `Cannot run \`wazap webhook ${config.args.join(" ")}\`.`, WEBHOOK_TEST_FIX);
  }
  await testWebhook(config);
}

async function enableWebhook(config: Config): Promise<void> {
  // An unknown --account fails before any prompt asks for a URL or a secret.
  const selected = config.accountId === undefined ? null : resolveAccount(config.dataDir, config.accountId);
  // A pipe is consumed whole by the first readline, so a script sets the URL
  // in the environment and only types the secret, the way transcribe does.
  let url: string;
  if (process.stdin.isTTY === true) {
    const typedUrl = stripPasted(await ask(`${brand("?")} Webhook URL: `));
    if (typedUrl === "") {
      throw new WazapError("INVALID_ID", "No webhook URL was typed.", "Run `wazap config webhook on` again");
    }
    url = requireWebhookUrl(typedUrl.replace(/\/+$/, ""));
  } else {
    const fromEnv = stripPasted(process.env.WAZAP_WEBHOOK_URL ?? "").replace(/\/+$/, "");
    if (fromEnv === "") {
      throw new WazapError(
        "INVALID_ID",
        "No webhook URL was typed.",
        "Set WAZAP_WEBHOOK_URL or run `wazap config webhook on` at a terminal"
      );
    }
    url = requireWebhookUrl(fromEnv);
  }
  const secret = await askSecret(`${brand("?")} Shared secret (it is not echoed): `);
  if (secret === "") {
    throw new WazapError("INVALID_ID", "No webhook secret was typed.", "Run `wazap config webhook on` again");
  }

  const p = paths(config.dataDir);
  if (config.accountId !== undefined) {
    // The switch stays global; the URL and secret are this account's override.
    AccountRegistry.load(config.dataDir).setWebhook(config.accountId, { url, secret });
    setEnvSetting(p.envFile, "WAZAP_WEBHOOK", "on");
    say(ok(`webhook: on for ${config.accountId} — ${postedLine(selected?.account.webhook_events, url)}`));
    hintMoreEvents(selected?.account.webhook_events);
    say(dim(`URL and secret stored in ${shortPath(p.accountsFile)}; WAZAP_WEBHOOK=on in ${shortPath(p.envFile)}.`));
    warnIfServerRunning(config);
    return;
  }
  setEnvSetting(p.envFile, "WAZAP_WEBHOOK", "on");
  setEnvSetting(p.envFile, "WAZAP_WEBHOOK_URL", url);
  setEnvSetting(p.envFile, "WAZAP_WEBHOOK_SECRET", secret);
  say(ok(`webhook: on — ${postedLine(undefined, url)}`));
  hintMoreEvents(undefined);
  say(dim(`Stored in ${shortPath(p.envFile)}.`));
  warnIfServerRunning(config);
}

/**
 * The header a receiver wants on top of wazap's signature — Cursor
 * Automations' bearer token, n8n's header auth — typed at a prompt that does
 * not echo it, never as an argument. With --account it is that account's.
 */
async function setWebhookAuth(config: Config): Promise<void> {
  // An unknown --account fails before the prompt asks for a credential.
  if (config.accountId !== undefined) resolveAccount(config.dataDir, config.accountId);
  const typed = (
    await askSecret(`${brand("?")} What the receiver expects — Bearer <token>, or <Header-Name>: <value> (it is not echoed): `)
  ).trim();
  if (typed === "") {
    throw new WazapError("INVALID_ID", "Nothing was typed.", "Run `wazap config webhook auth` again");
  }
  const auth = parseWebhookAuth(typed)!;
  const p = paths(config.dataDir);
  if (config.accountId !== undefined) {
    AccountRegistry.load(config.dataDir).setWebhook(config.accountId, { auth: typed });
    say(ok(`webhook auth: ${auth.name} goes with every POST for ${config.accountId}, beside the signature.`));
    say(dim(`Stored in ${shortPath(p.accountsFile)}.`));
  } else {
    setEnvSetting(p.envFile, "WAZAP_WEBHOOK_AUTH", typed);
    say(ok(`webhook auth: ${auth.name} goes with every POST, beside the signature.`));
    say(dim(`Stored in ${shortPath(p.envFile)}.`));
  }
  warnIfServerRunning(config);
}

function filterLine(filter: WebhookFilter | null): string {
  const described = describeWebhookFilter(filter);
  if (described === null) return "filter: off, #private excluded";
  if (described === "empty") return "filter: empty (nothing is posted)";
  return `filter: ${described}`;
}

/**
 * The allowlist, the burst window and the 401 retry. None of these is a
 * secret, so they are arguments; the URL's secret and the auth header stay
 * prompts. With --account the value is that account's and replaces the global
 * filter as a whole once either chats or the tag is set.
 */
async function applyWebhookOption(config: Config, verb: string, extra: string | undefined): Promise<void> {
  if (config.accountId !== undefined) resolveAccount(config.dataDir, config.accountId);
  switch (verb) {
    case "chats":
      setWebhookChats(config, extra);
      return;
    case "tag":
      setWebhookTag(config, extra);
      return;
    case "coalesce":
      setWebhookCoalesce(config, extra);
      return;
    case "retry-401":
      setWebhookRetry401(config, extra);
      return;
    case "filter":
      if (extra !== "off") break;
      clearWebhookFilter(config);
      return;
    default:
      break;
  }
  throw new WazapError("INVALID_ID", `Cannot set webhook "${[verb, extra].filter((part) => part !== undefined).join(" ")}".`, WEBHOOK_OPTION_FIX);
}

function setWebhookChats(config: Config, raw: string | undefined): void {
  if (raw === undefined) throw new WazapError("INVALID_ID", "Name the chats, or `none` or `off`.", WEBHOOK_OPTION_FIX);
  const registry = config.accountId === undefined ? null : AccountRegistry.load(config.dataDir);
  if (raw === "off") {
    if (registry !== null) registry.setWebhookChats(config.accountId!, null);
    else unsetEnvSetting(paths(config.dataDir).envFile, "WAZAP_WEBHOOK_CHATS");
    say(
      ok(
        config.accountId === undefined
          ? "webhook chats removed. With no tag, every chat is posted again, except contacts tagged #private."
          : `webhook chats removed for ${config.accountId}.`
      )
    );
  } else if (raw === "none") {
    if (registry !== null) registry.setWebhookChats(config.accountId!, []);
    else setEnvSetting(paths(config.dataDir).envFile, "WAZAP_WEBHOOK_CHATS", "");
    say(ok("webhook chats: none."));
  } else {
    const chats = parseWebhookChats(raw);
    if (chats.length === 0) throw new WazapError("INVALID_ID", "Name the chats, or `none` or `off`.", WEBHOOK_OPTION_FIX);
    if (registry !== null) registry.setWebhookChats(config.accountId!, chats);
    else setEnvSetting(paths(config.dataDir).envFile, "WAZAP_WEBHOOK_CHATS", chats.join(","));
    say(ok(`webhook chats: ${chats.length} ${chats.length === 1 ? "chat" : "chats"}.`));
  }
  say(dim(`Stored in ${shortPath(registry === null ? paths(config.dataDir).envFile : paths(config.dataDir).accountsFile)}.`));
  say(dim("Groups are posted only when their chat id is listed. A contact tagged #private is never posted."));
  warnIfServerRunning(config);
}

function setWebhookTag(config: Config, raw: string | undefined): void {
  if (raw === undefined) throw new WazapError("INVALID_ID", "Name the tag, or `off`.", WEBHOOK_OPTION_FIX);
  const registry = config.accountId === undefined ? null : AccountRegistry.load(config.dataDir);
  if (raw === "off") {
    if (registry !== null) registry.setWebhookTag(config.accountId!, null);
    else unsetEnvSetting(paths(config.dataDir).envFile, "WAZAP_WEBHOOK_TAG");
    say(ok(config.accountId === undefined ? "webhook tag: off." : `webhook tag removed for ${config.accountId}.`));
  } else {
    const tag = requireWebhookTag(raw);
    if (registry !== null) registry.setWebhookTag(config.accountId!, tag);
    else setEnvSetting(paths(config.dataDir).envFile, "WAZAP_WEBHOOK_TAG", tag);
    say(ok(`webhook tag: ${tag}. Direct chats filed under it with remember are posted; groups are not.`));
  }
  say(dim(`Stored in ${shortPath(registry === null ? paths(config.dataDir).envFile : paths(config.dataDir).accountsFile)}.`));
  say(dim("Adding or removing the tag on a contact takes effect without a restart. A contact tagged #private is never posted."));
  warnIfServerRunning(config);
}

function setWebhookCoalesce(config: Config, raw: string | undefined): void {
  if (raw === undefined) throw new WazapError("INVALID_ID", "Give the seconds, or `off`.", WEBHOOK_OPTION_FIX);
  const accountId = config.accountId;
  const file = accountId === undefined ? paths(config.dataDir).envFile : paths(config.dataDir).accountsFile;
  if (raw === "off" || raw === "0") {
    if (accountId !== undefined) AccountRegistry.load(config.dataDir).setWebhookCoalesce(accountId, 0);
    else unsetEnvSetting(file, "WAZAP_WEBHOOK_COALESCE");
    say(ok(accountId === undefined ? "webhook coalesce: off — one POST per message." : `webhook coalesce off for ${accountId}.`));
  } else {
    const seconds = requireCoalesceSeconds(raw);
    const cap = Math.min(seconds * 2, 300);
    if (accountId !== undefined) AccountRegistry.load(config.dataDir).setWebhookCoalesce(accountId, seconds);
    else setEnvSetting(file, "WAZAP_WEBHOOK_COALESCE", String(seconds));
    say(ok(`webhook coalesce: ${seconds}s quiet, delivered by ${cap}s${accountId === undefined ? "" : ` for ${accountId}`}.`));
  }
  say(dim(`Stored in ${shortPath(file)}.`));
  warnIfServerRunning(config);
}

function setWebhookRetry401(config: Config, raw: string | undefined): void {
  if (raw !== "on" && raw !== "off") throw new WazapError("INVALID_ID", "Say on or off.", WEBHOOK_OPTION_FIX);
  const on = raw === "on";
  if (config.accountId !== undefined) {
    AccountRegistry.load(config.dataDir).setWebhookRetry401(config.accountId, on);
    say(ok(on ? `webhook retry 401: on for ${config.accountId}.` : `webhook retry 401: off for ${config.accountId}.`));
    say(dim(`Stored in ${shortPath(paths(config.dataDir).accountsFile)}.`));
  } else if (on) {
    setEnvSetting(paths(config.dataDir).envFile, "WAZAP_WEBHOOK_RETRY_401", "on");
    say(ok("webhook retry 401: on — a 401 is retried like a 5xx, for up to a day."));
    say(dim(`Stored in ${shortPath(paths(config.dataDir).envFile)}.`));
  } else {
    unsetEnvSetting(paths(config.dataDir).envFile, "WAZAP_WEBHOOK_RETRY_401");
    say(ok("webhook retry 401: off — a 401 fails the event at once."));
    say(dim(`Stored in ${shortPath(paths(config.dataDir).envFile)}.`));
  }
  warnIfServerRunning(config);
}

function clearWebhookFilter(config: Config): void {
  if (config.accountId !== undefined) {
    const registry = AccountRegistry.load(config.dataDir);
    registry.setWebhookChats(config.accountId, null);
    registry.setWebhookTag(config.accountId, null);
    say(
      ok(
        `webhook filter removed for ${config.accountId}. The global filter applies, if one is set. Contacts tagged #private are still left out.`
      )
    );
    say(dim(`Stored in ${shortPath(paths(config.dataDir).accountsFile)}.`));
  } else {
    const file = paths(config.dataDir).envFile;
    unsetEnvSetting(file, "WAZAP_WEBHOOK_CHATS");
    unsetEnvSetting(file, "WAZAP_WEBHOOK_TAG");
    say(ok("webhook filter: off. Every chat is posted, except contacts tagged #private."));
    say(dim(`Stored in ${shortPath(file)}.`));
  }
  warnIfServerRunning(config);
}

function clearWebhookAuth(config: Config): void {
  const p = paths(config.dataDir);
  if (config.accountId !== undefined) {
    AccountRegistry.load(config.dataDir).clearWebhookAuth(config.accountId);
    say(ok(`webhook auth removed for ${config.accountId} — WAZAP_WEBHOOK_AUTH applies, if set.`));
    say(dim(`Stored in ${shortPath(p.accountsFile)}.`));
  } else {
    setEnvSetting(p.envFile, "WAZAP_WEBHOOK_AUTH", "");
    say(ok("webhook auth: off — only the signature goes with each POST."));
    say(dim(`Stored in ${shortPath(p.envFile)}.`));
  }
  warnIfServerRunning(config);
}

/** The events the webhook will post: the account's own list, else the global one, else the default. */
function eventsPosted(accountList: string | undefined): readonly WebhookEvent[] | null {
  try {
    return parseWebhookEvents(accountList ?? process.env.WAZAP_WEBHOOK_EVENTS ?? "");
  } catch {
    return null; // a bad list is reported where it is read; do not guess what it means
  }
}

/** What goes to the receiver, said as it is: the default is the messages you receive, not both ways. */
function postedLine(accountList: string | undefined, url: string): string {
  const events = eventsPosted(accountList);
  const what = events === null ? "the events WAZAP_WEBHOOK_EVENTS lists" : describeWebhookEvents(events);
  return `${what} are posted to ${new URL(url).host}.`;
}

/** Only the default list leaves out what someone would expect: say how to ask for the rest. */
function hintMoreEvents(accountList: string | undefined): void {
  const events = eventsPosted(accountList);
  const isDefault = events !== null && events.length === WEBHOOK_EVENTS_DEFAULT.length && events.every((event, i) => event === WEBHOOK_EVENTS_DEFAULT[i]);
  if (!isDefault) return;
  say(dim(`Nothing else is posted by default: ${WEBHOOK_EVENTS_FIX}.`));
}

function setWebhookFlag(config: Config, value: "on" | "off"): void {
  setEnvSetting(paths(config.dataDir).envFile, "WAZAP_WEBHOOK", value);
}

async function testWebhook(config: Config): Promise<void> {
  const event = parseWebhookEvent(config.webhookEvent);
  const selected = resolveAccount(config.dataDir, config.accountId);
  const result = await new WebhookSink(process.env, { account: selected.account }).sendTest(event);
  if (result.ok) {
    say(ok("webhook: test delivered"));
    return;
  }
  throw new WazapError("INVALID_ID", result.error, result.fix === "" ? WEBHOOK_ON_FIX : result.fix);
}

const DEFAULT_URL = "https://api.openai.com/v1";

const TRANSCRIBE_SAID: Record<string, string> = {
  local: "transcribe: local — whisper.cpp runs here, and the audio never leaves this machine.",
  openai: "transcribe: openai — voice messages are uploaded to the API to be transcribed.",
  off: "transcribe: off — voice messages stay as `[voice message]`.",
};

/**
 * The openai path asks for everything before it writes anything, so a refused
 * URL leaves .env as it was rather than half configured. `report` is off for
 * `setup`, which fetches the model itself and would otherwise announce a gap it
 * is about to close.
 */
export async function applyTranscribe(config: Config, choice: string, report = true): Promise<void> {
  const p = paths(config.dataDir);
  const writes: Record<string, string> = { WAZAP_TRANSCRIBE: choice };

  if (choice === "openai") {
    const key = await askSecret(`${brand("?")} Paste the API key (it is not echoed): `);
    if (key === "") {
      throw new WazapError("INVALID_ID", "No API key was typed.", "Run `wazap config transcribe openai` again");
    }
    writes.WAZAP_TRANSCRIBE_API_KEY = key;
    // A piped stdin was consumed whole by the reader above, so the second question
    // is only put to a person; a script sets WAZAP_TRANSCRIBE_URL itself, and
    // whatever it set is left alone here.
    if (process.stdin.isTTY === true) {
      const typed = stripPasted(await ask(`${brand("?")} Base URL [${DEFAULT_URL}]: `));
      // Written even when the default is accepted: an earlier answer's URL must
      // not outlive the answer that replaced it.
      writes.WAZAP_TRANSCRIBE_URL = typed === "" ? DEFAULT_URL : requireSafeUrl(typed.replace(/\/+$/, ""));
    }
  }

  for (const [name, value] of Object.entries(writes)) setEnvSetting(p.envFile, name, value);
  say(ok(TRANSCRIBE_SAID[choice]!));
  say(dim(`Stored in ${shortPath(p.envFile)}.`));
  if (report && choice !== "off") await reportReadiness({ ...process.env, ...writes }, config.dataDir);

  const running = lockHolder(p.lockFile);
  if (running !== null) say(warn(`A server is running (pid ${running}); restart it for this to apply.`));
}

/** What is still missing prints as a repair line, so a fresh choice never crashes. */
async function reportReadiness(env: NodeJS.ProcessEnv, dataDir: string): Promise<void> {
  const settings = transcribeSettings(env, dataDir);
  const readiness: Readiness =
    settings instanceof WazapError
      ? { ok: false, detail: settings.message, fix: settings.fix }
      : await transcribeReady(settings);
  if (readiness.ok) {
    say(ok(readiness.detail));
    return;
  }
  say(warn(readiness.detail));
  if (readiness.fix !== undefined) say(fix(readiness.fix));
}

/** Persist the writes answer, then say what is now true and how to change it. */
export function applyWrites(config: Config, allowWrites: boolean): void {
  const p = paths(config.dataDir);
  if (config.accountId !== undefined) {
    AccountRegistry.load(config.dataDir).setWrites(config.accountId, allowWrites);
    say(
      ok(
        allowWrites
          ? `writes: on for ${config.accountId} — the agent can send from this account. Turn it off with \`wazap config writes off --account ${config.accountId}\`.`
          : `writes: off for ${config.accountId} — the agent can only read this account. Turn it on with \`wazap config writes on --account ${config.accountId}\`.`
      )
    );
    say(dim(`Stored in ${shortPath(p.accountsFile)}.`));
    // The account flag is set, but the global switch is a hard off either way.
    if (allowWrites && config.readOnly) {
      say(warn("Global read-only is still on, so writes stay off until `wazap config writes on` clears it."));
    }
  } else {
    setEnvSetting(p.envFile, "WAZAP_READ_ONLY", allowWrites ? "0" : "1");
    config.readOnly = !allowWrites;
    if (config.sources) config.sources.readOnly = ".env";
    say(
      ok(
        allowWrites
          ? "writes: on — the agent can send messages, react and manage chats. Turn it off with `wazap config writes off`."
          : "writes: off — the agent can only read. Turn it on with `wazap config writes on`."
      )
    );
    say(dim(`Stored in ${shortPath(p.envFile)}.`));
  }

  const running = lockHolder(p.lockFile);
  if (running !== null) say(warn(`A server is running (pid ${running}); restart it for this to apply.`));
}
