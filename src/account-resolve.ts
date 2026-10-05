/**
 * Per-call account resolution and the status overlay that needs the hub.
 * Tool handlers stay in tools.ts.
 */

import type { AccountBinding, AccountSource } from "./account-hub.js";
import { ownerNumber, type AccountRecord } from "./accounts.js";
import { WazapError } from "./errors.js";
import { historyFreshness, historyLine } from "./freshness.js";
import { transcriptionStatusLine } from "./transcribe-status.js";
import { maskNumber } from "./ui.js";
import type { ListedAccount, StatusInfo } from "./wa-types.js";

export interface ToolPayload {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface ResolveTool {
  name: string;
  write: boolean;
}

const FIX_ADD_ACCOUNT = "Run `wazap account add`";
const FIX_PASS_ACCOUNT = "Pass account_id";

function ok(text: string, structured: Record<string, unknown>): ToolPayload {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

export function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function attachAccountId(result: ToolPayload, accountId: string): ToolPayload {
  // A text-only answer (learn's guide) stays text only.
  if (result.structuredContent === undefined && !result.isError) return result;
  const structured = result.structuredContent ?? {};
  // A read that had to walk the bindings stamps the account that answered, or
  // null when it answered for several (catch_up); anything else reports the one
  // the call resolved to.
  if (structured.account_id === null && !result.isError) return result;
  const answered = typeof structured.account_id === "string" && structured.account_id ? structured.account_id : accountId;
  return { ...result, structuredContent: { ...structured, account_id: answered } };
}

/** Write tools register when any live account allows writes. */
export function anyAccountAllowsWrites(hub: AccountSource): boolean {
  return hub.bindings().some((row) => row.wa.getStatus().read_only !== true);
}

function pickFromMatches(
  matches: AccountBinding[],
  write: boolean,
  hub: AccountSource,
  what: "chat" | "message" | "draft"
): AccountBinding {
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new WazapError(
      "AMBIGUOUS_ACCOUNT",
      `Several accounts have that ${what}: ${matches.map((row) => row.id).join(", ")}.`,
      FIX_PASS_ACCOUNT
    );
  }
  if (write) {
    throw new WazapError("AMBIGUOUS_ACCOUNT", `No account knows that ${what}.`, FIX_PASS_ACCOUNT);
  }
  return hub.defaultBinding();
}

function resolveGivenId(hub: AccountSource, requested: string, toolName: string): AccountBinding {
  let live = hub.binding(requested);
  if (live === undefined) {
    // The roster is a snapshot of accounts.json; an account added or enabled
    // since is picked up here, once, rather than called unknown. A missing or
    // malformed policy throws out of this, and the call fails closed.
    hub.reload();
    live = hub.binding(requested);
  }
  const record = hub.record(requested);
  if (record !== undefined && !record.enabled) {
    throw new WazapError(
      "ACCOUNT_DISABLED",
      `Account "${requested}" is disabled.`,
      `Run \`wazap account enable ${requested}\``
    );
  }
  if (live === undefined) {
    const fix = toolName === "link_account" ? FIX_ADD_ACCOUNT : `${FIX_ADD_ACCOUNT}, or call get_status without account_id to see the ids`;
    throw new WazapError("ACCOUNT_NOT_FOUND", `No account "${requested}".`, fix);
  }
  return live;
}

export function resolveToolAccount(
  hub: AccountSource,
  args: Record<string, unknown>,
  tool: ResolveTool
): AccountBinding {
  const requested = stringArg(args, "account_id");
  if (requested !== undefined) return resolveGivenId(hub, requested, tool.name);

  const live = hub.bindings();
  if (live.length === 1) return live[0]!;

  const chatId = stringArg(args, "chat_id") ?? stringArg(args, "group_id");
  const messageId = stringArg(args, "message_id");
  const draftId = stringArg(args, "draft_id");
  // A forward can only leave from the account that holds the message; the destination may be new to every account.
  const forwarded = stringArg(args, "forward");
  if (forwarded !== undefined) {
    const holders = hub.findByMessage(forwarded);
    if (holders.length === 1) return holders[0]!;
    if (holders.length > 1) {
      const knowChat = chatId === undefined ? [] : hub.findByChat(chatId).filter((row) => holders.some((holder) => holder.id === row.id));
      return pickFromMatches(knowChat.length === 1 ? knowChat : holders, tool.write, hub, "message");
    }
  }
  if (chatId !== undefined) return pickFromMatches(hub.findByChat(chatId), tool.write, hub, "chat");
  if (messageId !== undefined) return pickFromMatches(hub.findByMessage(messageId), tool.write, hub, "message");
  if (draftId !== undefined) return pickFromMatches(hub.findByDraft(draftId), false, hub, "draft");

  return hub.defaultBinding();
}

function listedFromStatus(s: StatusInfo, enabled: boolean, id = s.account_id): ListedAccount {
  return {
    id,
    name: s.account_name,
    status: s.status,
    phone_masked: s.account ? maskNumber(s.account.number) : null,
    owner_name: s.account?.name ?? null,
    write_tools: !s.read_only,
    enabled,
  };
}

function listedFromRecord(record: AccountRecord): ListedAccount {
  return {
    id: record.id,
    name: record.name,
    status: record.enabled ? "disconnected" : "disabled",
    phone_masked: record.owner === null ? null : maskNumber(ownerNumber(record.owner)),
    owner_name: null,
    write_tools: false,
    enabled: record.enabled,
  };
}

function renderAccountLines(rows: ListedAccount[]): string[] {
  return rows.map((row) => {
    const who = row.owner_name
      ? `${row.owner_name}${row.phone_masked ? ` (${row.phone_masked})` : ""}`
      : (row.phone_masked ?? "not linked");
    const writes = row.write_tools ? "writes on" : "writes off";
    const flag = row.enabled ? row.status : "disabled";
    return `- **${row.id}** (${row.name}) · ${flag} · ${who} · ${writes}`;
  });
}

/** Every configured account, disabled ones included, in registry order. */
function accountRows(hub: AccountSource): ListedAccount[] {
  return hub.records().map((record) => {
    const live = hub.binding(record.id);
    return live === undefined ? listedFromRecord(record) : listedFromStatus(live.wa.getStatus(), record.enabled, live.id);
  });
}

/**
 * A receiver that refuses every event clears nothing, so `last_error` alone went
 * unread for days. The counters and the failing run say it on the line itself.
 */
function webhookStatusLine(webhook: StatusInfo["webhook"]): string {
  if (!webhook.enabled) return "- **webhook**: off";
  if (!webhook.valid) return `- **webhook**: invalid${webhook.last_error ? ` · ${webhook.last_error}` : ""}`;
  const parts = ["on"];
  if (webhook.allowlist !== undefined) parts.push(`allowlist: ${webhook.allowlist}`);
  if (webhook.coalesce_seconds !== undefined) parts.push(`coalesce ${webhook.coalesce_seconds}s`);
  if (webhook.retry_unauthorized === true) parts.push("retry 401");
  const delivery = webhook.delivery;
  if (delivery !== undefined && delivery.delivered + delivery.failed + delivery.cancelled + delivery.pending + delivery.dropped > 0) {
    const counts = [`${delivery.delivered} delivered`, `${delivery.failed} failed`, `${delivery.cancelled} cancelled`, `${delivery.pending} pending`];
    if (delivery.dropped > 0) counts.push(`${delivery.dropped} dropped`);
    parts.push(counts.join(", "));
    if (delivery.consecutive_failures > 0) parts.push(`failing: ${delivery.consecutive_failures} in a row`);
    if (delivery.retrying > 0) {
      parts.push(`retrying: ${delivery.retrying} failed attempts, the oldest waiting since ${delivery.oldest_pending_at}`);
    }
    if (delivery.last_failure !== null) {
      parts.push(`last failure at ${delivery.last_failure_at}: ${delivery.last_failure}`);
    }
  }
  if (webhook.last_error && webhook.last_error !== delivery?.last_failure) {
    parts.push(`last error: ${webhook.last_error}`);
  }
  return `- **webhook**: ${parts.join(" · ")}`;
}

/** Only what is worth a line: a database not plainly ready, or legacy files still kept. */
function storageStatusLine(s: StatusInfo): string | null {
  const storage = s.storage;
  if (storage === undefined || (storage.state === "ready" && storage.legacy_files === undefined)) return null;
  const parts: string[] = [storage.progress === undefined ? storage.state : `${storage.state}, ${storage.progress}`];
  if (storage.legacy_files !== undefined) {
    parts.push("kept" in storage.legacy_files ? `earlier message files kept (${storage.legacy_files.kept})` : `earlier message files deleted after ${storage.legacy_files.deleted_after}`);
  }
  return `- **storage**: ${parts.join("; ")}`;
}

/**
 * The get_status body: `write_tools` is this session's, not the process default.
 * The `history` line is how an agent tells a stale store from a quiet one — the
 * same freshness block search and recall attach to their results.
 */
export function renderGetStatus(s: StatusInfo, writeTools: boolean, hub: AccountSource): ToolPayload {
  const account = s.account ? `${s.account.name || "(no name)"} (${s.account.number})` : "none";
  const writeLine = writeTools
    ? "registered"
    : s.read_only
      ? "not registered (server is read-only; run `wazap config writes on` and restart)"
      : "not registered (this session used a read token)";
  const accounts = accountRows(hub);
  const defaultId = hub.defaultBinding().id;
  const freshness = historyFreshness(s);
  const text = [
    `# WhatsApp: ${s.status} (sync: ${s.sync})`,
    `- **account**: ${account}`,
    `- **history**: ${historyLine(freshness)}`,
    `- **contacts named**: ${s.contacts_named}`,
    `- **data dir**: ${s.data_dir} · **read-only**: ${s.read_only} · **write tools**: ${writeLine} · **rate limit**: ${s.rate_limit}/min`,
    `- **versions**: wazap ${s.wazap_version}, baileys ${s.baileys_version}`,
    s.pairing
      ? `- **pairing code**: ${s.pairing.code} for ${s.pairing.phone_masked}, until ${s.pairing.expires_at}`
      : null,
    webhookStatusLine(s.webhook),
    storageStatusLine(s),
    s.transcription === undefined ? null : transcriptionStatusLine(s.transcription),
    s.last_error ? `- **last error**: ${s.last_error}` : null,
    s.hint ? `- **hint**: ${s.hint}` : null,
    ...(accounts.length > 1 ? [`- **accounts** (default: ${defaultId}):`, ...renderAccountLines(accounts).map((line) => `  ${line}`)] : []),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return ok(text, { ...s, write_tools: writeTools, default: defaultId, accounts, freshness } as unknown as Record<string, unknown>);
}
