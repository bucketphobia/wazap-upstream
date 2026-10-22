/**
 * find_contact (F2-3): who the user means by "mama", "Ana de la contabilitate"
 * or "fotbal", as an assistant should be told before it drafts anything.
 *
 * The scoring is db.contacts.find's (src/db/contacts.ts). This module is the
 * tool around it:
 * - one account, or every linked account when the call names none: each
 *   candidate is labelled with its account, and the answer is `resolved` only
 *   when exactly one account resolved and no other had a candidate at all;
 * - a qualifier that is only digits (4 or more) keeps the candidates whose
 *   number ends with them, so two people saved under one name can still be
 *   told apart once the user says which;
 * - `resolved` carries the full chat_id and, when the session can write, the
 *   draft context (src/draft-style.ts): the recent exchange and the user's
 *   style there. Not for a `#private` contact (style only), not when the
 *   account turned it off (`draft_context: false` in accounts.json, `wazap
 *   config draft-context off`), not when the caller passes include_context:
 *   false;
 * - `ambiguous` and `not_found` never carry a message's words, and a
 *   candidate's number only as its last four digits: the assistant has to ask
 *   the user and look the one they name up again, it cannot send to a guess.
 *   One name on several accounts, one candidate on each, is the exception the
 *   `fix` names: what the request is about usually says which account it
 *   means, so each candidate says since when it is `waiting` on an answer and
 *   the assistant is told to look before it asks. Nothing goes out on a guess
 *   either way: a draft's preview names the recipient, the number and the
 *   account, and the user says yes to that.
 */
import { z } from "zod";
import { contactLabel } from "./contact-display.js";
import type { AccountBinding } from "./account-hub.js";
import { draftContextEnabled } from "./accounts.js";
import { openAsk, ownThroughOf } from "./catchup-scan.js";
import { privateRule } from "./catchup.js";
import { FIND_SCORES, LOOKUP_MIN_DIGITS, RELATIONSHIPS, inflectionForms, nameWords, type AccountDb, type ContactCandidate, type FindKind, type FindResult, type FindVerdict } from "./db/index.js";
import { styleLine, type DraftContext } from "./draft-style.js";
import { WazapError, asWazapError } from "./errors.js";
import { resolveChatId } from "./ids.js";
import { formatAge, isoWithOffset } from "./messages.js";
import { hasPrivateTag } from "./private-contacts.js";
import { READ_ONLY_RULE, assertSendable, sendPolicyOf } from "./send-guard.js";
import type { ToolCtx, ToolResult } from "./tool-runtime.js";
import type { WhatsAppApi } from "./wa-types.js";

/** What one account is asked. */
export interface FindContactQuery {
  name: string;
  qualifier?: string;
  kind?: FindKind;
  limit?: number;
}

/** A candidate as one account found it, with the note and details the user filed on them. */
export interface FoundContact {
  accountId: string;
  candidate: ContactCandidate;
  note: string | null;
  fields: Record<string, string> | null;
  /** When an ask of theirs the user has not answered was sent; null when nothing of theirs is open. */
  waiting?: number | null;
}

/** One account's answer, before the tool merges accounts and decides on context. */
export interface AccountFind {
  accountId: string;
  verdict: FindVerdict;
  query: FindResult["query"];
  candidates: FoundContact[];
  closest: FoundContact[];
}

/** Digits a qualifier is made of, when it is a number's tail rather than words: "…2222", "2222", "+40 722 222 222". */
function numberTailOf(qualifier: string): string | null {
  const digits = qualifier.replace(/\D/g, "");
  return qualifier.trim() !== "" && !/\p{L}/u.test(qualifier) && digits.length >= 4 ? digits : null;
}

/** A name that is a phone number or a WhatsApp id, which find_contact looks up as such instead of matching names. */
export type Lookup = { source: "number"; digits: string } | { source: "id"; id: string };

/** "+40 722 001 111", "0722-001-111", "0040722001111": a number; "…@s.whatsapp.net", "…@lid", "…@g.us": an id. */
export function lookupOf(name: string): Lookup | null {
  const trimmed = name.trim();
  if (/^[^\s@]+@(s\.whatsapp\.net|c\.us|lid|g\.us)$/i.test(trimmed)) return { source: "id", id: trimmed };
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < LOOKUP_MIN_DIGITS) return null;
  return { source: "number", digits: trimmed.startsWith("00") ? digits.slice(2) : digits };
}

/**
 * When each of these candidates' still-open ask was sent, by the chat id they
 * were asked for under: catch_up's `waiting` judgment (openAsk), for the chats
 * these people and groups have. An ask stays open until the user answers it,
 * files it handled, or it is 14 days old.
 *
 * Only the instant, never the words: what tells two candidates of the same
 * name apart is that one of them is waiting on an answer, not what they wrote.
 * A name the user asked for by name is read whatever tags it carries, the way
 * a search is: #private and #no-catchup keep words and chats out of what was
 * not asked for, and no word is handed out here.
 */
function waitingByChat(db: AccountDb, candidates: readonly ContactCandidate[]): Map<number, number> {
  const waiting = new Map<number, number>();
  const chatIds = [...new Set(candidates.map((candidate) => candidate.chatId).filter((id): id is number => id !== null))];
  if (chatIds.length === 0) return waiting;
  const now = Date.now();
  const untilId = db.digest.maxId();
  const untilSeq = db.digest.storedTop();
  const families = db.digest.families();
  const handled = db.digest.handled();
  for (const { chat, asked } of db.digest.chatsByIds(chatIds)) {
    const family = families.get(chat.id) ?? [chat.id];
    const open = openAsk(db, chat, {
      now,
      untilId,
      family,
      span: (afterId) => ({ afterId, untilId, afterSeq: -1, untilSeq }),
      ownThrough: ownThroughOf(db, chat, family, untilId),
      handled,
    });
    // A chat folding into another answers for both ids it was asked for under.
    if (open !== null) for (const id of asked) waiting.set(id, open.ask.ts);
  }
  return waiting;
}

/**
 * db.contacts.find on one account, with a digits-only qualifier read as the
 * end of a phone number (numberTail), each returned person's note, and
 * whether an ask of theirs is still open; a number or an id is looked up
 * instead (db.contacts.lookup), `resolveId` giving the number a lid is paired
 * with. The service calls it.
 */
export function findInAccount(db: AccountDb, accountId: string, query: FindContactQuery, resolveId?: (id: string) => string): AccountFind {
  const tail = numberTailOf(query.qualifier ?? "");
  const lookup = lookupOf(query.name);
  const kind = query.kind ?? "any";
  const { verdict, candidates, closest, ...found } =
    lookup === null
      ? db.contacts.find({
          name: query.name,
          qualifier: tail === null ? (query.qualifier ?? null) : null,
          numberTail: tail,
          kind,
          limit: query.limit,
        })
      : lookup.source === "number"
        ? db.contacts.lookup({ source: "number", digits: lookup.digits, kind, limit: query.limit })
        : db.contacts.lookup({ source: "id", jids: [...new Set([resolveChatId(lookup.id), resolveId?.(lookup.id) ?? lookup.id])], kind, limit: query.limit });
  const waiting = waitingByChat(db, [...candidates, ...closest]);
  const withNote = (candidate: ContactCandidate): FoundContact => {
    const filed = candidate.kind === "person" ? db.identity.notes(candidate.jid) : null;
    return {
      accountId,
      candidate,
      note: filed?.note ?? null,
      fields: filed === null || Object.keys(filed.fields).length === 0 ? null : filed.fields,
      waiting: candidate.chatId === null ? null : (waiting.get(candidate.chatId) ?? null),
    };
  };
  return { accountId, verdict, query: found.query, candidates: candidates.map(withNote), closest: closest.map(withNote) };
}

export interface FindOutcome {
  status: FindVerdict;
  contact: FoundContact | null;
  candidates: FoundContact[];
  closest: FoundContact[];
}

const byScore = (a: FoundContact, b: FoundContact): number =>
  b.candidate.score - a.candidate.score || (b.candidate.lastExchange?.at ?? -1) - (a.candidate.lastExchange?.at ?? -1);

/**
 * The answer over several accounts: resolved only when one account resolved
 * and no other found anyone; otherwise every account's candidates together,
 * best first; otherwise the closest of all.
 */
export function mergeAccounts(answers: readonly AccountFind[], limit: number): FindOutcome {
  const resolved = answers.filter((answer) => answer.verdict === "resolved");
  const ambiguous = answers.filter((answer) => answer.verdict === "ambiguous");
  if (resolved.length === 1 && ambiguous.length === 0) {
    return { status: "resolved", contact: resolved[0]!.candidates[0]!, candidates: [], closest: [] };
  }
  const candidates = answers.flatMap((answer) => answer.candidates).sort(byScore).slice(0, limit);
  if (candidates.length > 0) return { status: "ambiguous", contact: null, candidates, closest: [] };
  const closest = answers
    .flatMap((answer) => answer.closest)
    .sort(byScore)
    .slice(0, Math.min(limit, FIND_SCORES.closestMax));
  return { status: "not_found", contact: null, candidates: [], closest };
}

// ---------------------------------------------------------------- views

const NAME_SOURCES = ["contact", "nickname", "business", "pushname", "group", "none"] as const;
type NameSource = (typeof NAME_SOURCES)[number];

/** Where the name shown comes from: the saved contact, a nickname the user filed, a business, what the person calls themselves, a group. */
function nameSourceOf(candidate: ContactCandidate): NameSource {
  if (candidate.kind === "group") return "group";
  const { names, displayName } = candidate;
  if (displayName === names.saved) return "contact";
  if (displayName === names.nickname) return "nickname";
  if (displayName === names.business) return "business";
  if (displayName === names.notify || displayName === names.pushName) return "pushname";
  return "none";
}

function matchedOf(candidate: ContactCandidate): { source: string; value: string; class: string } {
  return { source: candidate.match.source, value: candidate.match.value, class: candidate.match.class };
}

/**
 * A candidate to choose from: what tells them apart, the number cut to its
 * last four digits, no message text. `waiting` says one of them is owed an
 * answer — the same open ask catch_up lists — since that is often what the
 * request itself is about.
 */
function candidateView(found: FoundContact, labelAccount: boolean): Record<string, unknown> {
  const c = found.candidate;
  const view: Record<string, unknown> = {};
  if (labelAccount) view.account_id = found.accountId;
  view.kind = c.kind;
  view.name = c.displayName;
  view.name_source = nameSourceOf(c);
  if (c.phoneLast4 !== null) view.number_tail = c.phoneLast4;
  if (c.lastExchange !== null) {
    view.last_exchanged = {
      at: isoWithOffset(c.lastExchange.at),
      ago: formatAge(c.lastExchange.at),
      direction: c.lastExchange.fromMe ? "sent" : "received",
    };
  }
  if (found.waiting !== undefined && found.waiting !== null) {
    view.waiting = { since: isoWithOffset(found.waiting), ago: formatAge(found.waiting) };
  }
  view.messages_90d = c.ownMessages90d;
  if (c.groupsInCommon !== null && c.groupsInCommon.count > 0) {
    view.groups_in_common = { count: c.groupsInCommon.count, names: c.groupsInCommon.names.slice(0, 3) };
  }
  if (found.note !== null) view.note = found.note;
  if (c.tags.length > 0) view.tags = c.tags;
  if (c.business) view.business = true;
  view.matched = matchedOf(c);
  view.score = c.score;
  return view;
}

/** The one the user meant, in full: what the user filed on them, and their number. */
function contactView(found: FoundContact): Record<string, unknown> {
  const c = found.candidate;
  const view: Record<string, unknown> = {
    chat_id: c.jid,
    name: c.displayName,
    name_source: nameSourceOf(c),
    kind: c.kind,
    account_id: found.accountId,
    matched: matchedOf(c),
  };
  if (c.kind === "person") {
    view.number = c.jid.endsWith("@s.whatsapp.net") ? c.jid.split("@")[0]! : null;
    view.saved = c.saved;
  }
  if (c.business) view.business = true;
  if (found.note !== null) view.note = found.note;
  if (c.tags.length > 0) view.tags = c.tags;
  if (found.fields !== null) view.fields = found.fields;
  return view;
}

/** The word the user used for a relationship, in its base form: "mamei" is filed as "mama". */
function relationWordOf(query: FindResult["query"]): string {
  const word = query.words[0] ?? "";
  const spellings = query.relationship === null ? [] : (RELATIONSHIPS[query.relationship] ?? []);
  return inflectionForms(word).find((form) => spellings.includes(form)) ?? word;
}

/** An account in scope whose database could not answer, and the error it gave. */
export interface UnavailableAccount {
  account_id: string;
  error: string;
}

function unsearchedLine(unavailable: readonly UnavailableAccount[]): string | null {
  if (unavailable.length === 0) return null;
  const which = unavailable.map((entry) => entry.account_id).join(", ");
  return `Account ${which} could not be searched, so someone there may be meant too: confirm with the user before using any candidate, then call find_contact again with its account_id.`;
}

/**
 * Candidates that are one name on several accounts, one candidate per account:
 * the same person, or two people the user keeps apart by account. What the
 * request is about then says which account it means, so the assistant is told
 * to look before it asks (SAME_NAME_ON_ACCOUNTS). People with different names
 * are a question for the user, whatever account they are on.
 */
function sameNameOnAccounts(candidates: readonly FoundContact[]): boolean {
  if (candidates.length < 2) return false;
  const accounts = new Set(candidates.map((found) => found.accountId));
  if (accounts.size !== candidates.length) return false;
  return new Set(candidates.map((found) => nameWords(found.candidate.displayName).join(" "))).size === 1;
}

/**
 * One name on several accounts: the request itself usually says which one it
 * is about, so looking comes before asking — and the two things that decide it
 * are named, since an assistant told only to look looked at both accounts and
 * then asked anyway. Nothing is sent on a guess either way: a draft's preview
 * names the recipient, the number and the account, and the user says yes to it
 * — and that preview comes from send_message, never from a message written out
 * in the answer, which is what an assistant that had picked the right account
 * did instead in the gate's third run.
 */
const SAME_NAME_ON_ACCOUNTS =
  "The same name on several accounts, one on each: look before asking. Either of two things decides it. Exactly one candidate has waiting, an open ask of theirs, and the request answers it: that one. Or what the request is about (a file, a topic) is in one candidate's conversation: read it with search(query, from: the name), or with find_contact again with a candidate's number_tail as qualifier and its account_id, which brings their recent messages. Then go on with that account and say which one: call send_message there and show the preview it returns, never one you wrote yourself. Ask the user only when nothing tells them apart.";

function fixFor(outcome: FindOutcome, query: FindResult["query"], asked: string, multi: boolean, unavailable: readonly UnavailableAccount[]): string | undefined {
  if (outcome.status === "resolved") return undefined;
  const unsearched = unsearchedLine(unavailable);
  const lookup = lookupOf(asked);
  if (lookup !== null) {
    const accounts = new Set(outcome.candidates.map((found) => found.accountId));
    const line =
      outcome.status === "not_found"
        ? lookup.source === "number"
          ? `Nobody saved or filed has the number "${asked}": check the number with the user, in international format. A number nobody saved still takes a message as chat_id.`
          : `Nobody saved or filed, and no group, is "${asked}": check the id, passed exactly as a message or chat gave it.`
        : accounts.size > 1
          ? "They are on different accounts: ask the user which account, then call find_contact again with its account_id."
          : "Several numbers end with those digits: ask the user for the full number in international format.";
    return [line, unsearched].filter((part) => part !== null).join(" ");
  }
  if (outcome.status === "ambiguous") {
    const accounts = new Set(outcome.candidates.map((found) => found.accountId));
    if (multi && sameNameOnAccounts(outcome.candidates)) {
      return [SAME_NAME_ON_ACCOUNTS, unsearched].filter((line) => line !== null).join(" ");
    }
    return [
      outcome.candidates.length > 1
        ? `Ask the user which one they mean, naming each by what tells them apart (last exchange, groups, note, tags, number_tail); never pick one yourself.`
        : null,
      unsearched,
      `Then call find_contact again with the full name, a qualifier ("contabilitate", a group), or the last 4 digits as qualifier.`,
      multi && accounts.size > 1 ? "They are on different accounts: pass account_id for the one the user means." : null,
    ]
      .filter((line) => line !== null)
      .join(" ");
  }
  const lines: string[] = [];
  if (query.relationship !== null) {
    const word = relationWordOf(query);
    lines.push(
      `No saved name, tag, detail or note says who "${word}" is, and messages are never read for it. Ask the user who it is, find that person with find_contact, then file it with remember({chat_id, fields: {relatie: "${word}"}}) so "${word}" resolves next time.`
    );
  } else {
    lines.push(
      outcome.closest.length > 0
        ? `Nobody is called "${asked}". Ask the user whether they mean one of closest, or for the full name or the number in international format.`
        : `Nobody is called "${asked}". Ask the user for the full name, a detail about them, or the number in international format.`
    );
  }
  if (unsearched !== null) lines.push(unsearched);
  return lines.join(" ");
}

// ---------------------------------------------------------------- text

function when(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

function candidateLine(view: Record<string, unknown>, index: number): string {
  const parts = [`${index + 1}. ${view.name as string}${view.account_id ? ` (account ${view.account_id as string})` : ""}`];
  if (view.kind === "group") parts.push("group");
  if (view.number_tail) parts.push(`number …${view.number_tail as string}`);
  const last = view.last_exchanged as { ago: string; direction: string } | undefined;
  parts.push(last === undefined ? "no direct messages" : `last ${last.direction} ${last.ago}`);
  const waiting = view.waiting as { since: string; ago: string } | undefined;
  if (waiting !== undefined) parts.push(`waiting on an answer since ${when(waiting.since)} (${waiting.ago})`);
  parts.push(`${view.messages_90d as number} from the user in 90 days`);
  const groups = view.groups_in_common as { count: number; names: string[] } | undefined;
  if (groups !== undefined) parts.push(`groups: ${groups.names.join(", ")}${groups.count > groups.names.length ? ` +${groups.count - groups.names.length}` : ""}`);
  if (view.note) parts.push(`note: ${view.note as string}`);
  if (view.tags) parts.push((view.tags as string[]).map((tag) => `#${tag}`).join(" "));
  if (view.business) parts.push("business");
  return parts.join(" · ");
}

function renderContext(context: DraftContext, name: string): string[] {
  const lines: string[] = [];
  if (context.style !== undefined) {
    const { basis } = context.style;
    const where = basis.scope === "chat" ? "in this chat" : "across the account (too few here)";
    lines.push(`How the user writes ${where}, from ${basis.own_messages} of their messages: ${styleLine(context.style)}; emoji in ${Math.round(context.style.emoji_rate * 100)}%.`);
  }
  if (context.private === true) lines.push("Tagged #private: no recent messages are attached.");
  if (context.recent !== undefined) {
    lines.push("Recent, oldest first:");
    for (const line of context.recent) {
      const who = line.from_me ? "user" : (line.sender ?? name);
      lines.push(`- ${when(line.at)} ${who}: ${line.text}`);
    }
  }
  return lines;
}

/** What the user filed on someone, on one line: note, tags, details. */
function filedLine(view: Record<string, unknown>): string | null {
  const parts = [
    view.note ? `note: ${view.note as string}` : null,
    view.tags ? (view.tags as string[]).map((tag) => `#${tag}`).join(" ") : null,
    ...Object.entries((view.fields as Record<string, string> | undefined) ?? {}).map(([key, value]) => `${key}: ${value}`),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** What a tag list left out, and how to see it; null when it left out nobody. */
function cutNote(omitted: ReadonlyArray<{ account_id: string; count: number }>): string | null {
  const left = omitted.reduce((sum, entry) => sum + entry.count, 0);
  if (left === 0) return null;
  return `${left} more not shown (${omitted.map((entry) => `${entry.count} on ${entry.account_id}`).join(", ")}): raise limit, up to ${MAX_LISTED}, or narrow it with name or account_id.`;
}

export function renderFindContact(structured: Record<string, unknown>): string {
  const query = structured.query as { name: string };
  const fix = structured.fix as string | undefined;
  const unavailable = (structured.accounts_unavailable as UnavailableAccount[] | undefined) ?? [];
  const unsearched = unavailable.length === 0 ? null : `Not searched: ${unavailable.map((entry) => `${entry.account_id} (${entry.error})`).join(", ")}.`;
  switch (structured.status) {
    case "listed": {
      const contacts = structured.contacts as Array<Record<string, unknown>>;
      const tag = (structured.query as { tag: string }).tag;
      if (contacts.length === 0) return [`Nobody is filed under #${tag}.`, unsearched].filter(Boolean).join("\n");
      const cut = cutNote((structured.omitted as Array<{ account_id: string; count: number }> | undefined) ?? []);
      return [
        `# Filed under #${tag} (${contacts.length})`,
        cut,
        ...contacts.map(
          (c) =>
            `- ${contactLabel(c.name as string, c.chat_id as string, c.number as string | null)}${c.account_id ? ` (account ${c.account_id as string})` : ""}${c.saved ? " · saved" : ""}${filedLine(c) ? ` · ${filedLine(c)}` : ""}\n  chat_id: ${c.chat_id as string}`
        ),
        unsearched,
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "resolved": {
      const contact = structured.contact as { name: string; chat_id: string; number?: string | null; account_id: string; matched: { source: string; value: string; class: string } };
      const how = contact.matched.class === "exact" || contact.matched.class === "word" ? "" : `, ${contact.matched.class}`;
      const lines = [
        `"${query.name}" is ${contactLabel(contact.name, contact.chat_id, contact.number)} on account ${contact.account_id} (matched ${contact.matched.source}${how}: ${contact.matched.value}).`,
        `chat_id: ${contact.chat_id}`,
      ];
      const filed = filedLine(structured.contact as Record<string, unknown>);
      if (filed !== null) lines.push(filed);
      if (unsearched !== null) lines.push(unsearched);
      if (structured.context !== undefined) lines.push(...renderContext(structured.context as DraftContext, contact.name));
      return lines.join("\n");
    }
    case "ambiguous": {
      const candidates = structured.candidates as Array<Record<string, unknown>>;
      const head = candidates.length === 1 ? `"${query.name}" may be this one, to confirm:` : `"${query.name}" could be ${candidates.length} of these:`;
      return [head, ...candidates.map(candidateLine), unsearched, fix].filter(Boolean).join("\n");
    }
    default: {
      const closest = (structured.closest as Array<Record<string, unknown>> | undefined) ?? [];
      return [`Nobody found for "${query.name}".`, ...(closest.length > 0 ? ["Closest:", ...closest.map(candidateLine)] : []), unsearched, fix]
        .filter(Boolean)
        .join("\n");
    }
  }
}

// ---------------------------------------------------------------- schema

const matchedSchema = z.object({
  source: z.string().describe("What matched: name, nickname, relatie, tag, field, note, business_name, notify, push_name, group_name"),
  value: z.string(),
  class: z.string().describe("exact, word, diminutive, prefix, substring or fuzzy"),
});

const candidateSchema = z.object({
  account_id: z.string().optional().describe("Set when several accounts were searched"),
  kind: z.enum(["person", "group"]),
  name: z.string(),
  name_source: z.enum(NAME_SOURCES),
  number_tail: z.string().optional().describe("Last 4 digits of the number; the full number is never given for a candidate"),
  last_exchanged: z.object({ at: z.string(), ago: z.string(), direction: z.enum(["sent", "received"]) }).optional(),
  waiting: z
    .object({ since: z.string(), ago: z.string() })
    .optional()
    .describe("Set when an ask of theirs is still open, as catch_up reads it: when they asked, still unanswered"),
  messages_90d: z.number().int().describe("The user's own messages to them in the last 90 days"),
  groups_in_common: z.object({ count: z.number().int(), names: z.array(z.string()) }).optional(),
  note: z.string().optional().describe("What the user noted about them"),
  tags: z.array(z.string()).optional(),
  business: z.boolean().optional(),
  matched: matchedSchema,
  score: z.number(),
});

const styleSchema = z.object({
  basis: z.object({ own_messages: z.number().int(), days: z.number().int(), scope: z.enum(["chat", "account"]) }),
  language: z.enum(["ro", "en", "other"]),
  diacritics: z.enum(["none", "some", "most", "unknown"]),
  address: z.enum(["tu", "dumneavoastra", "unknown"]),
  length_chars: z.object({ p50: z.number(), p90: z.number() }),
  emoji_rate: z.number(),
  starts_capital: z.number(),
  ends_punct: z.number(),
  their_language: z.enum(["ro", "en"]).optional().describe("What language the recipient writes here; a draft goes in this one, whatever scope the style above has"),
});

const listedSchema = z.object({
  account_id: z.string().optional(),
  chat_id: z.string(),
  name: z.string(),
  number: z.string().nullable(),
  saved: z.boolean(),
  business: z.boolean().optional(),
  note: z.string().optional(),
  tags: z.array(z.string()).optional(),
  fields: z.record(z.string()).optional(),
});

export const FIND_CONTACT_OUTPUT = {
  status: z.enum(["resolved", "ambiguous", "not_found", "listed"]),
  query: z.object({
    name: z.string().optional(),
    tag: z.string().optional(),
    qualifier: z.string().optional(),
    kind: z.enum(["person", "group", "any"]),
    words: z.array(z.string()),
    relationship: z.string().nullable(),
  }),
  contact: z
    .object({
      chat_id: z.string().describe("Pass this to send_message and the other chat tools"),
      name: z.string(),
      name_source: z.enum(NAME_SOURCES),
      kind: z.enum(["person", "group"]),
      account_id: z.string(),
      matched: matchedSchema,
      number: z.string().nullable().optional(),
      saved: z.boolean().optional(),
      business: z.boolean().optional(),
      note: z.string().optional(),
      tags: z.array(z.string()).optional(),
      fields: z.record(z.string()).optional(),
    })
    .optional()
    .describe("Only when resolved"),
  context: z
    .object({
      style: styleSchema.optional(),
      recent: z
        .array(z.object({ at: z.string(), from_me: z.boolean(), sender: z.string().optional(), text: z.string(), transcribed: z.literal(true).optional() }))
        .optional(),
      private: z.literal(true).optional(),
    })
    .optional()
    .describe("Only when resolved, in a session that can write: what a draft to them is written after"),
  candidates: z.array(candidateSchema).optional().describe("Only when ambiguous; best first"),
  closest: z.array(candidateSchema).optional().describe("Only when not_found"),
  contacts: z.array(listedSchema).optional().describe("Only when listed: everyone filed under the tag"),
  omitted: z
    .array(z.object({ account_id: z.string(), count: z.number().int() }))
    .optional()
    .describe("Only when listed and cut by limit: how many more on each account"),
  fix: z.string().optional().describe("What to do next, when not resolved"),
  next: z.string().optional().describe("Resolved: how a message to them starts"),
  can_draft: z.literal(false).optional().describe("Resolved in a session that cannot send"),
  notes: z.array(z.string()).optional().describe("Caveats to act on or tell the user"),
  accounts_searched: z.array(z.string()).optional(),
  accounts_unavailable: z.array(z.object({ account_id: z.string(), error: z.string() })).optional(),
  account_id: z.string().nullable().optional().describe("The account that answered; null when several accounts were searched and none answered alone"),
};

// ---------------------------------------------------------------- the tool

export interface FindContactArgs {
  name?: string;
  tag?: string;
  qualifier?: string;
  kind?: FindKind;
  limit?: number;
  include_context?: boolean;
  account_id?: string;
}

/**
 * Whether a resolved contact gets the draft context: a write session, an
 * account that writes and has not turned it off, and a recipient its send
 * rules allow — no draft to them could go out.
 */
function contextAllowed(ctx: ToolCtx, binding: Pick<AccountBinding, "id" | "wa">, chatJid: string): boolean {
  if (!ctx.allowWrite) return false;
  try {
    // Read fresh, like the send rules: `wazap config draft-context off` applies to the next call.
    const record = ctx.hub.recordOnDisk(binding.id);
    if (record === undefined || !record.enabled || record.writes === false || !draftContextEnabled(record)) return false;
    assertSendable(sendPolicyOf(record), { chat_id: chatJid }, binding.id);
    return binding.wa.getStatus?.().read_only !== true;
  } catch {
    // Refused by the rules, or an unreadable policy: nothing handed out.
    return false;
  }
}

/**
 * The step a resolved contact points to in a session that can write: the draft
 * itself, since a draft sends nothing and its answer is the preview to show.
 * An assistant that asks first, with a preview of its own, never gets one —
 * which the gate's third run did once, after it had picked the right account.
 * So where the preview comes from, and that it is never written by hand, is
 * said here rather than left to be understood.
 */
const RESOLVED_NEXT =
  "To message them, call send_message(chat_id) now: it sends nothing, and the preview to show is the one it returns. Never write a preview of your own.";

/** A tag lists at most this many people. */
const MAX_LISTED = 50;
/** People one account is asked for under a tag: more than any list shows, so what the limit leaves out can be counted. */
const TAG_SCAN_MAX = 10_000;

/**
 * Everyone the user filed under a tag, on one account or every one: a list
 * the user asked for by filing it, so each person comes with their chat_id.
 * `name` narrows it the way the address book is searched.
 */
async function listTagged(args: FindContactArgs & { tag: string }, ctx: ToolCtx): Promise<ToolResult> {
  const limit = Math.max(1, Math.min(MAX_LISTED, Math.floor(args.limit ?? MAX_LISTED)));
  const everyone = args.account_id === undefined ? ctx.hub.bindings() : [];
  const multi = everyone.length > 1;
  const targets: Array<Pick<AccountBinding, "id" | "wa">> = multi ? everyone : [{ id: ctx.accountId, wa: ctx.wa }];
  const settled = await Promise.allSettled(targets.map((target) => target.wa.searchContacts(args.name ?? "", TAG_SCAN_MAX, { tag: args.tag })));
  const perAccount: Array<{ accountId: string; rows: Array<Record<string, unknown>> }> = [];
  const unavailable: UnavailableAccount[] = [];
  settled.forEach((result, index) => {
    const accountId = targets[index]!.id;
    if (result.status === "rejected") {
      unavailable.push({ account_id: accountId, error: asWazapError(result.reason).code });
      return;
    }
    const rows: Array<Record<string, unknown>> = [];
    perAccount.push({ accountId, rows });
    for (const c of result.value) {
      rows.push({
        ...(multi ? { account_id: accountId } : {}),
        chat_id: c.contact_id,
        name: c.name,
        number: c.number,
        saved: c.is_my_contact,
        ...(c.is_business ? { business: true } : {}),
        ...(c.note ? { note: c.note } : {}),
        ...(c.tags?.length ? { tags: c.tags } : {}),
        ...(c.fields && Object.keys(c.fields).length > 0 ? { fields: c.fields } : {}),
      });
    }
  });
  if (unavailable.length === targets.length) {
    throw asWazapError(settled.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason);
  }
  // The limit is shared out a person per account a round, so one account's long list never crowds out another's.
  const taken = perAccount.map(() => 0);
  for (let round = 0, left = limit; left > 0; round++) {
    let more = false;
    perAccount.forEach((account, index) => {
      if (left > 0 && round < account.rows.length) {
        taken[index]!++;
        left--;
        more = true;
      }
    });
    if (!more) break;
  }
  const omitted = perAccount
    .map((account, index) => ({ account_id: account.accountId, count: account.rows.length - taken[index]! }))
    .filter((entry) => entry.count > 0);
  const structured: Record<string, unknown> = {
    status: "listed",
    query: { tag: args.tag, ...(args.name === undefined ? {} : { name: args.name }), kind: "person", words: [], relationship: null },
    contacts: perAccount.flatMap((account, index) => account.rows.slice(0, taken[index])),
    ...(omitted.length > 0 ? { omitted } : {}),
  };
  if (multi) {
    structured.accounts_searched = targets.map((target) => target.id);
    structured.account_id = null;
  }
  if (unavailable.length > 0) structured.accounts_unavailable = unavailable;
  const cut = cutNote(omitted);
  if (cut !== null) structured.notes = [cut];
  return { content: [{ type: "text", text: renderFindContact(structured) }], structuredContent: structured };
}

/** The live account a name is, by its id or its name, folded: "business" is the account named Business. */
function accountNamed(ctx: ToolCtx, name: string): string | null {
  const asked = nameWords(name).join(" ");
  if (asked === "") return null;
  for (const binding of ctx.hub.bindings()) {
    if (nameWords(binding.id).join(" ") === asked || nameWords(ctx.hub.record(binding.id)?.name).join(" ") === asked) return binding.id;
  }
  return null;
}

export async function runFindContact(args: FindContactArgs, ctx: ToolCtx): Promise<ToolResult> {
  if (args.tag !== undefined) return listTagged({ ...args, tag: args.tag }, ctx);
  if (args.name === undefined) {
    throw new WazapError("INVALID_ID", "Pass who to find as name, or tag to list everyone filed under it.", 'find_contact({ name: "Ana" }) or find_contact({ tag: "client" })');
  }
  const name = args.name;
  if (nameWords(name).length === 0) {
    throw new WazapError(
      "INVALID_ID",
      `"${name}" has no letter or digit to look anyone up by.`,
      'Pass what the user calls them, as they said it: find_contact({ name: "Ana" }). A phone number goes straight to send_message as chat_id'
    );
  }
  const limit = Math.max(1, Math.min(10, Math.floor(args.limit ?? FIND_SCORES.ambiguousMax)));
  const query: FindContactQuery = { name, qualifier: args.qualifier, kind: args.kind ?? "any", limit };
  const everyone = args.account_id === undefined ? ctx.hub.bindings() : [];
  const multi = everyone.length > 1;
  const targets: Array<Pick<AccountBinding, "id" | "wa">> = multi ? everyone : [{ id: ctx.accountId, wa: ctx.wa }];

  const settled = await Promise.allSettled(
    targets.map(async (target) => {
      const wa: WhatsAppApi = target.wa;
      if (typeof wa.findContact !== "function") {
        throw new WazapError("SERVICE_ERROR", `Account "${target.id}" cannot look people up.`);
      }
      return wa.findContact(query);
    })
  );
  const answers: AccountFind[] = [];
  const unavailable: UnavailableAccount[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") answers.push(result.value);
    else unavailable.push({ account_id: targets[index]!.id, error: asWazapError(result.reason).code });
  });
  if (answers.length === 0) {
    const first = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    throw asWazapError(first?.reason);
  }

  let outcome = mergeAccounts(answers, limit);
  // One match where not every account could look is a candidate to confirm, not an answer.
  if (outcome.contact !== null && unavailable.length > 0) outcome = { status: "ambiguous", contact: null, candidates: [outcome.contact], closest: [] };
  const read = answers[0]!.query;
  const structured: Record<string, unknown> = {
    status: outcome.status,
    query: {
      name,
      ...(args.qualifier === undefined ? {} : { qualifier: args.qualifier }),
      kind: query.kind,
      words: read.words,
      relationship: read.relationship,
    },
  };
  if (outcome.contact !== null) {
    const found = outcome.contact;
    structured.contact = contactView(found);
    const binding = targets.find((target) => target.id === found.accountId)!;
    if (args.include_context !== false && contextAllowed(ctx, binding, found.candidate.jid) && typeof binding.wa.draftContext === "function") {
      try {
        // Tagged #private on this account or on any other live one: style only, and a group without their words.
        const rule = await privateRule(ctx.hub, binding.id);
        const context = binding.wa.draftContext(found.candidate.jid, { recent: !hasPrivateTag(found.candidate.tags), private: rule });
        if (context !== null) structured.context = context;
      } catch {
        /* the contact stands without its context */
      }
    }
    structured.account_id = found.accountId;
    if (ctx.allowWrite) structured.next = RESOLVED_NEXT;
    else Object.assign(structured, { can_draft: false, next: READ_ONLY_RULE });
  } else if (outcome.status === "ambiguous") {
    structured.candidates = outcome.candidates.map((found) => candidateView(found, multi));
  } else {
    structured.closest = outcome.closest.map((found) => candidateView(found, multi));
  }
  // Over several accounts, no one account answered: each candidate names its own.
  if (multi && outcome.contact === null) structured.account_id = null;
  // Asked for an account by its name ("Business") or id: the account to pass, not a person to ask about.
  const account = outcome.status === "not_found" ? accountNamed(ctx, name) : null;
  const fix = account === null ? fixFor(outcome, read, name, multi, unavailable) : `"${name}" is the account ${account}: pass account_id "${account}" to catch_up, read_messages or search.`;
  if (fix !== undefined) structured.fix = fix;
  if (multi) structured.accounts_searched = targets.map((target) => target.id);
  if (unavailable.length > 0) structured.accounts_unavailable = unavailable;
  return { content: [{ type: "text", text: renderFindContact(structured) }], structuredContent: structured };
}
