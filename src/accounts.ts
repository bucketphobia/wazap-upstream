import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readLinkedAccount } from "./auth-state.js";
import { accountPaths, paths, type AccountPaths, type Config } from "./config.js";
import { WazapError, asWazapError } from "./errors.js";
import { normalizeSendRule } from "./send-guard.js";
import { parseWebhookAuth, parseWebhookChats, parseWebhookEvents, requireCoalesceSeconds, requireWebhookTag } from "./webhook.js";

export const DEFAULT_ACCOUNT_ID = "default";
export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface AccountRecord {
  id: string;
  name: string;
  enabled: boolean;
  owner: string | null;
  writes?: boolean;
  rate_limit?: number;
  webhook_url?: string;
  webhook_secret?: string;
  webhook_events?: string;
  /** The header the receiver expects on top of the signature, as `WAZAP_WEBHOOK_AUTH` takes it. */
  webhook_auth?: string;
  /**
   * Present, even empty, this account's chat allowlist replaces the global one.
   * Together with `webhook_tag` it is the whole filter: neither half is inherited
   * once either is set.
   */
  webhook_chats?: string[];
  /** The contact tag whose direct chats are posted. Set with or without `webhook_chats`. */
  webhook_tag?: string;
  /** Seconds a chat's messages wait to share one POST. `0` turns that wait off for this account. */
  webhook_coalesce?: number;
  /** Retry a 401 instead of failing the event at once. */
  webhook_retry_401?: boolean;
  /** When present — even empty — only these recipients may be sent to. */
  send_allow?: string[];
  /** Refused no matter what send_allow says. Entries are chat ids or phone numbers. */
  send_deny?: string[];
  /**
   * `false` stops find_contact attaching the draft context (the recent
   * exchange and the user's style) for this account; absent means on.
   */
  draft_context?: boolean;
}

export interface AccountsFile {
  v: 2;
  default: string;
  accounts: AccountRecord[];
}

export interface ResolvedAccount {
  registry: AccountRegistry;
  account: AccountRecord;
  paths: AccountPaths;
}

const FIX_LIST = "Run `wazap account list`";
const FIX_ADD = "Run `wazap account add <id>` first, or `wazap account list`";
const FIX_POLICY = "Restore or repair accounts.json from a trusted backup; do not remove the policy file or its .required marker";
/** A lost policy has one knowing way out besides a backup, and it has to be spelled out. */
const FIX_MISSING_POLICY =
  "Restore accounts.json from a trusted backup. To start over on purpose with one default account and no send rules, delete accounts.json.required too, then run `wazap account list`";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/** Global flag/env is a hard off. A per-account `writes: false` turns that account off. */
export function accountPolicy(
  account: AccountRecord,
  config: Pick<Config, "readOnly" | "rateLimitPerMinute">
): { readOnly: boolean; rateLimit: number } {
  return {
    readOnly: config.readOnly || account.writes === false,
    rateLimit: account.rate_limit ?? config.rateLimitPerMinute,
  };
}

/** Whether find_contact may attach the draft context for this account: on unless the record says `draft_context: false`. */
export function draftContextEnabled(account: Pick<AccountRecord, "draft_context">): boolean {
  return account.draft_context !== false;
}

/** Atomic JSON write: tmp plus rename, mode 0600, the same contract as daemon.json. */
export function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

export function parseAccountId(id: string): string {
  if (!ACCOUNT_ID_RE.test(id)) {
    throw new WazapError(
      "INVALID_ID",
      `Invalid account id "${id}".`,
      "Use a slug like default or work: lowercase letters, digits, hyphen; 1–32 characters"
    );
  }
  return id;
}

function synthesizedDefault(): AccountsFile {
  return {
    v: 2,
    default: DEFAULT_ACCOUNT_ID,
    accounts: [{ id: DEFAULT_ACCOUNT_ID, name: DEFAULT_ACCOUNT_ID, enabled: true, owner: null }],
  };
}

function parseAccountRecord(value: unknown, file: string): AccountRecord {
  if (!isRecord(value) || typeof value.id !== "string" || !ACCOUNT_ID_RE.test(value.id)) {
    throw new WazapError("INVALID_ID", `Invalid account entry in ${file}.`, FIX_POLICY);
  }
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw new WazapError("INVALID_ID", `Account "${value.id}" in ${file} has no name.`, FIX_POLICY);
  }
  if (typeof value.enabled !== "boolean") {
    throw new WazapError(
      "INVALID_ID",
      `Account "${value.id}" in ${file} is missing enabled.`,
      FIX_POLICY
    );
  }
  if (value.owner !== null && typeof value.owner !== "string") {
    throw new WazapError(
      "INVALID_ID",
      `Account "${value.id}" in ${file} has a bad owner.`,
      FIX_POLICY
    );
  }
  const record: AccountRecord = {
    id: value.id,
    name: value.name,
    enabled: value.enabled,
    owner: value.owner,
  };
  if (value.writes !== undefined) {
    if (typeof value.writes !== "boolean") {
      throw new WazapError(
        "INVALID_ID",
        `Account "${value.id}" in ${file} has a bad writes flag.`,
        FIX_POLICY
      );
    }
    record.writes = value.writes;
  }
  if (value.rate_limit !== undefined) {
    if (typeof value.rate_limit !== "number" || !Number.isFinite(value.rate_limit) || value.rate_limit < 0) {
      throw new WazapError(
        "INVALID_ID",
        `Account "${value.id}" in ${file} has a bad rate_limit.`,
        FIX_POLICY
      );
    }
    record.rate_limit = value.rate_limit;
  }
  for (const field of ["send_allow", "send_deny"] as const) {
    if (value[field] !== undefined) record[field] = sendRuleList(value.id, field, value[field], ` in ${file}`);
  }
  if (value.draft_context !== undefined) {
    if (typeof value.draft_context !== "boolean") {
      throw new WazapError("INVALID_ID", `Account "${value.id}" in ${file} has a bad draft_context flag.`, FIX_POLICY);
    }
    record.draft_context = value.draft_context;
  }
  return {
    ...record,
    ...webhookFields(value.id, value.webhook_url, value.webhook_secret, value.webhook_events, ` in ${file}`, FIX_POLICY, value.webhook_auth),
    ...webhookPolicyFields(value.id, value, ` in ${file}`),
  };
}

/** Every entry must be a chat id or a phone number; what load refuses, a writer cannot persist either. */
function sendRuleList(id: string, field: "send_allow" | "send_deny", value: unknown, where = ""): string[] {
  const fix = FIX_POLICY;
  if (!Array.isArray(value) || value.length > 200) {
    throw new WazapError("INVALID_ID", `Account "${id}"${where} has a bad ${field}.`, fix);
  }
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new WazapError("INVALID_ID", `Account "${id}"${where} has a bad ${field} entry.`, fix);
    }
    try {
      return normalizeSendRule(entry);
    } catch {
      throw new WazapError("INVALID_ID", `Account "${id}"${where} has a bad ${field} entry.`, fix);
    }
  });
}

/** Shared by load and `setWebhook` so a writer cannot persist what load refuses. */
function webhookFields(
  id: string,
  url: unknown,
  secret: unknown,
  events: unknown,
  where = "",
  fix = FIX_POLICY,
  auth?: unknown
): Pick<AccountRecord, "webhook_url" | "webhook_secret" | "webhook_events" | "webhook_auth"> {
  const fields: Pick<AccountRecord, "webhook_url" | "webhook_secret" | "webhook_events" | "webhook_auth"> = {};
  if (url !== undefined) {
    if (typeof url !== "string" || url.trim() === "") {
      throw new WazapError("INVALID_ID", `Account "${id}"${where} has a bad webhook_url.`, fix);
    }
    fields.webhook_url = url.trim().replace(/\/+$/, "");
  }
  if (secret !== undefined) {
    if (typeof secret !== "string" || secret === "") {
      throw new WazapError("INVALID_ID", `Account "${id}"${where} has a bad webhook_secret.`, fix);
    }
    fields.webhook_secret = secret;
  }
  if (events !== undefined) {
    if (typeof events !== "string" || events.trim() === "") {
      throw new WazapError("INVALID_ID", `Account "${id}"${where} has a bad webhook_events.`, fix);
    }
    const trimmed = events.trim();
    try {
      parseWebhookEvents(trimmed);
    } catch (err) {
      throw new WazapError(
        "INVALID_ID",
        `Account "${id}"${where} has a bad webhook_events: ${asWazapError(err).message}`,
        fix
      );
    }
    fields.webhook_events = trimmed;
  }
  if (auth !== undefined) {
    // What is wrong with it is said without the value, which is a credential.
    if (typeof auth !== "string" || auth.trim() === "") {
      throw new WazapError("INVALID_ID", `Account "${id}"${where} has a bad webhook_auth.`, fix);
    }
    try {
      parseWebhookAuth(auth);
    } catch (err) {
      throw new WazapError("INVALID_ID", `Account "${id}"${where} has a bad webhook_auth: ${asWazapError(err).message}`, fix);
    }
    fields.webhook_auth = auth.trim();
  }
  return fields;
}

/** The allowlist, the burst window and the 401 retry. A writer cannot persist what load refuses. */
function webhookPolicyFields(
  id: string,
  value: Record<string, unknown>,
  where = ""
): Pick<AccountRecord, "webhook_chats" | "webhook_tag" | "webhook_coalesce" | "webhook_retry_401"> {
  const fields: Pick<AccountRecord, "webhook_chats" | "webhook_tag" | "webhook_coalesce" | "webhook_retry_401"> = {};
  if (value.webhook_chats !== undefined) {
    if (!Array.isArray(value.webhook_chats) || value.webhook_chats.some((entry) => typeof entry !== "string")) {
      throw new WazapError("INVALID_ID", `Account "${id}"${where} has a bad webhook_chats.`, FIX_POLICY);
    }
    try {
      fields.webhook_chats = parseWebhookChats(value.webhook_chats.join(","));
    } catch (err) {
      throw new WazapError("INVALID_ID", `Account "${id}"${where} has a bad webhook_chats: ${asWazapError(err).message}`, FIX_POLICY);
    }
  }
  if (value.webhook_tag !== undefined) {
    if (typeof value.webhook_tag !== "string" || value.webhook_tag.trim() === "") {
      throw new WazapError("INVALID_ID", `Account "${id}"${where} has a bad webhook_tag.`, FIX_POLICY);
    }
    try {
      fields.webhook_tag = requireWebhookTag(value.webhook_tag);
    } catch (err) {
      throw new WazapError("INVALID_ID", `Account "${id}"${where} has a bad webhook_tag: ${asWazapError(err).message}`, FIX_POLICY);
    }
  }
  if (value.webhook_coalesce !== undefined) {
    if (typeof value.webhook_coalesce !== "number" || !Number.isInteger(value.webhook_coalesce)) {
      throw new WazapError("INVALID_ID", `Account "${id}"${where} has a bad webhook_coalesce.`, FIX_POLICY);
    }
    if (value.webhook_coalesce !== 0) {
      try {
        fields.webhook_coalesce = requireCoalesceSeconds(value.webhook_coalesce);
      } catch (err) {
        throw new WazapError(
          "INVALID_ID",
          `Account "${id}"${where} has a bad webhook_coalesce: ${asWazapError(err).message}`,
          FIX_POLICY
        );
      }
    } else {
      fields.webhook_coalesce = 0;
    }
  }
  if (value.webhook_retry_401 !== undefined) {
    if (typeof value.webhook_retry_401 !== "boolean") {
      throw new WazapError("INVALID_ID", `Account "${id}"${where} has a bad webhook_retry_401.`, FIX_POLICY);
    }
    fields.webhook_retry_401 = value.webhook_retry_401;
  }
  return fields;
}

function parseAccountsFile(value: unknown, file: string): AccountsFile {
  if (!isRecord(value) || value.v !== 2 || typeof value.default !== "string" || !Array.isArray(value.accounts)) {
    throw new WazapError("INVALID_ID", `Could not read ${file}.`, FIX_POLICY);
  }
  if (value.accounts.length === 0) {
    throw new WazapError("INVALID_ID", `${file} lists no accounts.`, FIX_ADD);
  }
  const accounts = value.accounts.map((entry) => parseAccountRecord(entry, file));
  const ids = new Set(accounts.map((account) => account.id));
  if (ids.size !== accounts.length) {
    throw new WazapError("INVALID_ID", `${file} lists the same account id twice.`, FIX_POLICY);
  }
  if (!ids.has(value.default)) {
    throw new WazapError(
      "INVALID_ID",
      `${file} default is not an account.`,
      FIX_POLICY
    );
  }
  return { v: 2, default: value.default, accounts };
}

export class AccountRegistry {
  private constructor(
    readonly dataDir: string,
    private file: AccountsFile
  ) {}

  /**
   * Load accounts.json, or an in-memory default account when the file is
   * missing and no .required marker exists. Legacy unmarked layouts can still
   * bootstrap through the migrator. This load synthesizes so login and status
   * work on a fresh data dir without writing anything.
   */
  static load(dataDir: string): AccountRegistry {
    const file = paths(dataDir).accountsFile;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if (isEnoent(err) && !existsSync(`${file}.required`)) return new AccountRegistry(dataDir, synthesizedDefault());
      throw new WazapError("INVALID_ID", "Account policy is missing or unreadable; refusing unrestricted defaults.", FIX_MISSING_POLICY);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new WazapError("INVALID_ID", `Could not read ${file}.`, FIX_POLICY);
    }
    return new AccountRegistry(dataDir, parseAccountsFile(parsed, file));
  }

  save(): void {
    this.commit(this.file);
  }

  /** Remember existing policy without rewriting its bytes or permissions. */
  seal(): void {
    const file = paths(this.dataDir).accountsFile;
    if (existsSync(file)) this.markRequired(file);
    else if (existsSync(`${file}.required`)) throw new WazapError("INVALID_ID", "Account policy is missing.", FIX_MISSING_POLICY);
    else this.save();
  }

  defaultId(): string {
    return this.file.default;
  }

  all(): AccountRecord[] {
    return this.file.accounts.map((account) => ({ ...account }));
  }

  get(id: string): AccountRecord | undefined {
    const found = this.file.accounts.find((account) => account.id === id);
    return found === undefined ? undefined : { ...found };
  }

  add(id: string, name?: string): AccountRecord {
    const slug = parseAccountId(id);
    if (this.get(slug) !== undefined) {
      throw new WazapError("INVALID_ID", `Account "${slug}" already exists.`, "Pick another id");
    }
    const record: AccountRecord = {
      id: slug,
      name: name === undefined || name.trim() === "" ? slug : name.trim(),
      enabled: true,
      owner: null,
    };
    this.commit({ ...this.file, accounts: [...this.file.accounts, record] });
    mkdirSync(accountPaths(this.dataDir, slug).root, { recursive: true, mode: 0o700 });
    return { ...record };
  }

  remove(id: string): void {
    const slug = parseAccountId(id);
    if (this.file.accounts.length <= 1) {
      throw new WazapError("INVALID_ID", "Cannot remove the last account.", "Add another account first");
    }
    const accounts = this.file.accounts.filter((account) => account.id !== slug);
    if (accounts.length === this.file.accounts.length) {
      throw new WazapError("INVALID_ID", `No account "${slug}".`, FIX_LIST);
    }
    this.commit({
      ...this.file,
      default: this.file.default === slug ? accounts[0]!.id : this.file.default,
      accounts,
    });
    rmSync(accountPaths(this.dataDir, slug).root, { recursive: true, force: true });
  }

  enable(id: string): void {
    this.commit(this.withAccount(id, (account) => ({ ...account, enabled: true })));
  }

  disable(id: string): void {
    this.commit(this.withAccount(id, (account) => ({ ...account, enabled: false })));
  }

  setOwner(id: string, owner: string | null): void {
    this.commit(this.withAccount(id, (account) => ({ ...account, owner })));
  }

  setWrites(id: string, writes: boolean): void {
    this.commit(this.withAccount(id, (account) => ({ ...account, writes })));
  }

  /** On drops the key, so the file only ever records the exception. */
  setDraftContext(id: string, on: boolean): void {
    this.commit(
      this.withAccount(id, (account) => {
        const next = { ...account };
        if (on) delete next.draft_context;
        else next.draft_context = false;
        return next;
      })
    );
  }

  /**
   * Send rules gate who the account may address: `send_deny` refuses its
   * entries; a present `send_allow` — even empty — refuses everyone else. Pass
   * a list to replace it, null to drop it, undefined to leave it alone.
   */
  setSendRules(id: string, rules: { allow?: string[] | null; deny?: string[] | null }): void {
    this.commit(
      this.withAccount(id, (account) => {
        const next = { ...account };
        for (const [key, list] of [
          ["send_allow", rules.allow],
          ["send_deny", rules.deny],
        ] as const) {
          if (list === undefined) continue;
          if (list === null) delete next[key];
          else next[key] = sendRuleList(id, key, list);
        }
        return next;
      })
    );
  }

  setWebhook(id: string, webhook: { url?: string; secret?: string; auth?: string }): void {
    this.commit(
      this.withAccount(id, (account) => ({
        ...account,
        ...webhookFields(id, webhook.url, webhook.secret, undefined, "", "Set a non-empty webhook URL or secret", webhook.auth),
      }))
    );
  }

  /** Drop only the account's auth header, so it follows `WAZAP_WEBHOOK_AUTH` again. */
  clearWebhookAuth(id: string): void {
    this.commit(
      this.withAccount(id, (account) => {
        const next = { ...account };
        delete next.webhook_auth;
        return next;
      })
    );
  }

  /**
   * The account's chat allowlist. `null` drops it. An empty list is kept, and
   * with no tag it posts nothing. Setting chats or the tag replaces the global
   * filter as a whole.
   */
  setWebhookChats(id: string, chats: string[] | null): void {
    this.commit(
      this.withAccount(id, (account) => {
        const next = { ...account };
        if (chats === null) delete next.webhook_chats;
        else next.webhook_chats = parseWebhookChats(chats.join(","));
        return next;
      })
    );
  }

  /** `null` drops the account's tag so only its chat list, if it has one, remains. */
  setWebhookTag(id: string, tag: string | null): void {
    this.commit(
      this.withAccount(id, (account) => {
        const next = { ...account };
        if (tag === null) delete next.webhook_tag;
        else next.webhook_tag = requireWebhookTag(tag);
        return next;
      })
    );
  }

  /** `null` drops the override. `0` forces the window off even when the global one is on. */
  setWebhookCoalesce(id: string, seconds: number | null): void {
    this.commit(
      this.withAccount(id, (account) => {
        const next = { ...account };
        if (seconds === null) delete next.webhook_coalesce;
        else next.webhook_coalesce = seconds === 0 ? 0 : requireCoalesceSeconds(seconds);
        return next;
      })
    );
  }

  /** `null` drops the override so the global flag applies. */
  setWebhookRetry401(id: string, enabled: boolean | null): void {
    this.commit(
      this.withAccount(id, (account) => {
        const next = { ...account };
        if (enabled === null) delete next.webhook_retry_401;
        else next.webhook_retry_401 = enabled;
        return next;
      })
    );
  }

  /** Drop the per-account override so the account follows the global webhook again. */
  clearWebhook(id: string): void {
    this.commit(
      this.withAccount(id, (account) => {
        const next = { ...account };
        delete next.webhook_url;
        delete next.webhook_secret;
        delete next.webhook_events;
        delete next.webhook_auth;
        delete next.webhook_chats;
        delete next.webhook_tag;
        delete next.webhook_coalesce;
        delete next.webhook_retry_401;
        return next;
      })
    );
  }

  setDefault(id: string): void {
    const slug = parseAccountId(id);
    if (!this.file.accounts.some((account) => account.id === slug)) {
      throw new WazapError("INVALID_ID", `No account "${slug}".`, FIX_LIST);
    }
    this.commit({ ...this.file, default: slug });
  }

  private markRequired(file: string): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.required`, "", { mode: 0o600 });
    chmodSync(`${file}.required`, 0o600);
  }

  private commit(next: AccountsFile): void {
    const file = paths(this.dataDir).accountsFile;
    // Seal existence before publication; loss must not bootstrap open rules.
    this.markRequired(file);
    writeJsonFile(file, next);
    this.file = next;
  }

  private withAccount(id: string, update: (account: AccountRecord) => AccountRecord): AccountsFile {
    const slug = parseAccountId(id);
    let found = false;
    const accounts = this.file.accounts.map((account) => {
      if (account.id !== slug) return account;
      found = true;
      return update(account);
    });
    if (!found) {
      throw new WazapError("INVALID_ID", `No account "${slug}".`, FIX_LIST);
    }
    return { ...this.file, accounts };
  }
}

/** The account `--account` named, or the default. Unknown ids fail. */
export function resolveAccount(dataDir: string, accountId?: string): ResolvedAccount {
  const registry = AccountRegistry.load(dataDir);
  const id = accountId === undefined ? registry.defaultId() : parseAccountId(accountId);
  const account = registry.get(id);
  if (account === undefined) {
    throw new WazapError("INVALID_ID", `No account "${id}".`, FIX_ADD);
  }
  return { registry, account, paths: accountPaths(dataDir, account.id) };
}

/** Persist a synthesized default so a just-migrated dir always has accounts.json. */
export function ensureAccountsFile(dataDir: string): AccountRegistry {
  const registry = AccountRegistry.load(dataDir);
  if (!existsSync(paths(dataDir).accountsFile)) registry.save();
  return registry;
}

/** The digits of an owner jid like `40734…:75@s.whatsapp.net`, for display. */
export function ownerNumber(owner: string): string {
  return owner.split(/[:@]/)[0] ?? "";
}

/**
 * Whether any configured account has linked credentials on disk. `status` and
 * the doctor checks answer for the data dir, not only the selected account.
 */
export function anyAccountLinked(dataDir: string, registry: AccountRegistry = AccountRegistry.load(dataDir)): boolean {
  return registry.all().some((account) => {
    try {
      return readLinkedAccount(accountPaths(dataDir, account.id).authDir) !== null;
    } catch {
      return false;
    }
  });
}
