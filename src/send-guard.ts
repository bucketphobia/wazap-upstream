/**
 * Per-account send rules: who this account may address. The rules live in
 * accounts.json (`send_allow`, `send_deny` on the account record) and the tools
 * re-read them at draft time and again at confirm_send, so a rule an operator
 * adds while a draft sits waiting still applies to it.
 *
 * Nothing here touches WhatsApp or the network: a refused send fails before
 * the socket ever sees it, with SEND_BLOCKED naming the rule that fired.
 */
import { DRAFT_TTL_MS, SEND_RECORD_TTL_MS, type DraftView } from "./drafts.js";
import { WazapError } from "./errors.js";
import type { AccountRecord } from "./accounts.js";
import type { OutgoingTarget } from "./wa-types.js";

/**
 * The rule a session that can send is given, in the server's instructions. The
 * yes is a yes to one draft: this text, this recipient. The request that
 * dictated the text can carry it ("change it and send"), and a yes that landed
 * on another subject does not, however enthusiastic it sounds.
 */
export const SEND_RULE =
  "Never send without the user's yes to this text and this recipient: draft with send_message (it sends nothing) and show the preview it returns. A send asked in the same request that gave the text is that yes: confirm_send it, do not ask again. A yes about something else, or one that comes after the talk moved on, is not: show the preview again and ask.";

/** What a session without the send tools is told instead, and a contact it resolves repeats. */
export const READ_ONLY_RULE =
  "This connection only reads: it cannot draft or send. Asked to send, say so, and offer the text for the user to send from their phone or a connection with write access.";

/** What a rule or a recipient can be matched on; `number` rides along when known. */
export interface SendTarget {
  chat_id: string;
  name?: string;
  number?: string;
}

/**
 * A record's rules as the account file wrote them: `allow` absent means open,
 * present — even empty — means only the listed recipients may be sent to.
 * `deny` blocks its entries no matter what `allow` says.
 */
export interface SendPolicy {
  allow: string[] | null;
  deny: string[];
}

export function sendPolicyOf(record: Pick<AccountRecord, "send_allow" | "send_deny"> | undefined): SendPolicy {
  return { allow: record?.send_allow ?? null, deny: record?.send_deny ?? [] };
}

export function hasSendRules(policy: SendPolicy): boolean {
  return policy.allow !== null || policy.deny.length > 0;
}

/** A rule typed by a person, reduced to the two forms a recipient resolves to. */
function matchForms(input: string): { jid?: string; digits?: string } {
  const trimmed = input.trim();
  const at = trimmed.lastIndexOf("@");
  if (at !== -1) {
    const user = trimmed.slice(0, at).split(":")[0] ?? "";
    const domain = trimmed.slice(at + 1).toLowerCase();
    if (user === "" || domain === "") return {};
    const jid = `${user}@${domain}`;
    return /^\d+$/.test(user) ? { jid, digits: user } : { jid };
  }
  const digits = trimmed.replace(/^\+/, "").replace(/[\s\-().]/g, "");
  return /^\d+$/.test(digits) ? { digits } : {};
}

/**
 * A rule entry as it lands in accounts.json, so matching never re-parses and a
 * bad entry fails the write instead of being stored. `120363@g.us` keeps its
 * domain; `+40 722 123 456` keeps only digits. Anything else is not an address.
 */
export function normalizeSendRule(entry: string): string {
  const trimmed = entry.trim();
  const at = trimmed.lastIndexOf("@");
  if (at !== -1) {
    const user = trimmed.slice(0, at).split(":")[0] ?? "";
    const domain = trimmed.slice(at + 1).toLowerCase();
    if (user !== "" && domain !== "") return `${user}@${domain}`;
  }
  const digits = trimmed.replace(/^\+/, "").replace(/[\s\-().]/g, "");
  if (/^\d{3,}$/.test(digits)) return digits;
  throw new WazapError(
    "INVALID_ID",
    `"${trimmed}" is not a chat id or a phone number.`,
    'Use a full chat id like "120363000000000001@g.us" or an international number like "+15550100"'
  );
}

/** Whether a stored chat id or phone number is the same address as `entry`. */
export function addressMatches(entry: string, target: SendTarget): boolean {
  return ruleMatches(entry, target);
}

function ruleMatches(entry: string, target: SendTarget): boolean {
  const rule = matchForms(entry);
  const candidates = target.number === undefined ? [target.chat_id] : [target.chat_id, target.number];
  return candidates.some((candidate) => {
    const form = matchForms(candidate);
    return (
      (rule.jid !== undefined && form.jid === rule.jid) || (rule.digits !== undefined && form.digits === rule.digits)
    );
  });
}

function describeTarget(target: SendTarget): string {
  const name = target.name?.trim();
  if (name) return `"${name}" <${target.chat_id}>`;
  return target.number !== undefined ? `${target.number} <${target.chat_id}>` : `<${target.chat_id}>`;
}

const SEND_RULES_FIX =
  "Tell the user the send rules refuse it; they can change them with `wazap config send` — do not retry or route around them.";

/**
 * Fail closed, naming the rule that fired: a deny hit is refused, and a present
 * allowlist refuses anything it does not list. An absent allowlist lets through
 * whatever deny did not catch.
 */
export function assertSendable(policy: SendPolicy, target: SendTarget, accountId: string): void {
  const denied = policy.deny.find((entry) => ruleMatches(entry, target));
  if (denied !== undefined) {
    throw new WazapError(
      "SEND_BLOCKED",
      `Blocked by the send rules of account "${accountId}": ${describeTarget(target)} is denied by "${denied}".`,
      SEND_RULES_FIX
    );
  }
  if (policy.allow !== null && !policy.allow.some((entry) => ruleMatches(entry, target))) {
    throw new WazapError(
      "SEND_BLOCKED",
      `Blocked by the send rules of account "${accountId}": ${describeTarget(target)} is not on the send allowlist.`,
      SEND_RULES_FIX
    );
  }
}

/**
 * draft_id → the resolved recipient and the account it was drafted under. Every
 * draft is born in a send tool, so this is what confirm_send re-checks the live
 * rules against — a draft taken through any other path would have no entry.
 * Entries age out with the drafts themselves. A draft a confirm reached keeps
 * its entry as long as its send record, so confirming it again reaches the
 * service and answers its receipt or SEND_OUTCOME_UNKNOWN, never "draft
 * again". A restart forgets them all, as it forgets every session that drafted.
 */
interface DraftRef {
  accountId: string;
  target: OutgoingTarget;
  at: number;
  /** The identity that created this draft (a credential's on HTTP, an opaque session id otherwise); never supplied by a caller. */
  owner?: string;
}

/** Drafts no confirm has reached yet, oldest first. */
const draftTargets = new Map<string, DraftRef>();
const DRAFT_TARGETS_CAP = 500;
/** Drafts a confirm reached, oldest confirm first: new drafts never push these out. */
const confirmedTargets = new Map<string, DraftRef>();
const CONFIRMED_TARGETS_CAP = 10_000;

/** Drops the entries past `ttlMs`, and the oldest until one more fits under `cap`. A map iterates in insertion order, which is `at` order. */
function trim(map: Map<string, DraftRef>, ttlMs: number, cap: number, now: number): void {
  for (const [id, ref] of map) {
    if (ref.at + ttlMs > now && map.size < cap) break;
    map.delete(id);
  }
}

export function noteDraftTarget(view: DraftView, accountId: string, owner?: string): void {
  const now = Date.now();
  trim(draftTargets, DRAFT_TTL_MS, DRAFT_TARGETS_CAP, now);
  draftTargets.set(view.draft_id, { accountId, target: view.to, at: now, owner });
}

/** A confirm reached this draft: its route lasts as long as its send record. */
export function noteConfirming(draftId: string): void {
  const ref = draftTargets.get(draftId);
  if (ref === undefined) return;
  const now = Date.now();
  trim(confirmedTargets, SEND_RECORD_TTL_MS, CONFIRMED_TARGETS_CAP, now);
  draftTargets.delete(draftId);
  confirmedTargets.set(draftId, { ...ref, at: now });
}

export function draftTargetOf(draftId: string): DraftRef | undefined {
  return draftTargets.get(draftId) ?? confirmedTargets.get(draftId);
}

/** Unknown and foreign-identity drafts are indistinguishable, before account lookup or policy checks. */
export function requireDraftOwner(draftId: string, owner: string, accountId?: string): DraftRef {
  const ref = draftTargetOf(draftId);
  if (ref === undefined || ref.owner !== owner || (accountId !== undefined && ref.accountId !== accountId)) {
    throw new WazapError(
      "DRAFT_NOT_FOUND",
      "No draft available in this MCP session.",
      "Call send_message again in this session, show the new preview and ask the user to confirm before calling confirm_send"
    );
  }
  return ref;
}

export function forgetDraftTarget(draftId: string): void {
  draftTargets.delete(draftId);
  confirmedTargets.delete(draftId);
}
