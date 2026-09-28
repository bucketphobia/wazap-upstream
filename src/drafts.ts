import { randomUUID } from "node:crypto";
import type { SendRecord, Sends } from "./db/index.js";
import { styleCheckLines, type StyleCheck } from "./draft-style.js";
import { WazapError } from "./errors.js";
import { isoWithOffset } from "./messages.js";
import { captionTravels, mimeOfSource } from "./outgoing-media.js";
import type { MediaSource, OutgoingTarget, SentMessage } from "./wa-types.js";

export const DRAFT_TTL_MS = 15 * 60_000;
/** Drafts one identity keeps — a session, or a credential's stable identity on HTTP; its oldest go first. */
export const DRAFT_CAP = 20;
/** Drafts one account keeps across every identity; the oldest go first. */
export const DRAFT_ACCOUNT_CAP = 200;
/** How long a confirmed send is remembered: its receipt, and its key for echoes and reconciliation. */
export const SEND_RECORD_TTL_MS = 24 * 60 * 60_000;
/** Rows one sweep deletes at most. */
const SWEEP_CHUNK = 200;

export type DraftKind = "text" | "media" | "poll" | "location" | "forward";

export type { OutgoingTarget };

export type DraftPayload =
  | { kind: "text"; chatId: string; text: string; replyTo?: string; mentionIds?: string[] }
  | {
      kind: "media";
      chatId: string;
      source: MediaSource;
      caption?: string;
      asDocument: boolean;
      asVoice: boolean;
      asGif: boolean;
    }
  | { kind: "poll"; chatId: string; question: string; options: string[]; multiSelect: boolean }
  | {
      kind: "location";
      chatId: string;
      latitude: number;
      longitude: number;
      name?: string;
      address?: string;
    }
  | { kind: "forward"; chatId: string; messageId: string; text?: string };

export interface Draft {
  id: string;
  to: OutgoingTarget;
  preview: string;
  expiresAt: number;
  payload: DraftPayload;
  /** The WhatsApp key the draft goes out under, fixed when it is made. */
  keyId: string;
}

export interface DraftView {
  status: "draft";
  draft_id: string;
  to: OutgoingTarget;
  preview: string;
  /**
   * The recipient is not in the phone's address book: the name shown is a
   * public profile name or just the number, not a saved contact. Set when the
   * name is already visibly not a name; the send tools also set it after the
   * address-book check.
   */
  unnamed_recipient?: boolean;
  expires_at: string;
  kind: DraftKind;
  /**
   * A text draft to a direct chat, against how the user writes there: the
   * mismatches found (none is fine) and what they were measured on. Absent
   * when the user wrote too little in that chat to judge. Never blocks.
   */
  style_check?: StyleCheck;
}

/** What confirm_send may do with a draft: send it, or answer the receipt of the send it already made. */
export type Claim = { state: "claimed"; draft: Draft } | { state: "sent"; receipt: SentMessage };

/** What a draft row keeps besides its columns. */
interface FrozenDraft {
  to: OutgoingTarget;
  preview: string;
  payload: DraftPayload;
}

export function draftNotFound(id: string): WazapError {
  return new WazapError(
    "DRAFT_NOT_FOUND",
    `No draft ${id}.`,
    "Call send_message again, show the new preview and wait for a new yes, then confirm_send"
  );
}

export function draftExpired(id: string): WazapError {
  return new WazapError(
    "DRAFT_EXPIRED",
    `Draft ${id} expired.`,
    "Call send_message again, show the new preview and wait for a new yes: the yes given to the expired draft does not carry over. Then confirm_send"
  );
}

/**
 * A draft the session made before it did something else: whatever the user has
 * just said, it was not said to this preview. Refused before anything is sent.
 */
export function draftStale(id: string): WazapError {
  return new WazapError(
    "DRAFT_STALE",
    `Draft ${id} was made earlier in this conversation and other calls followed it; nothing was sent.`,
    "The talk moved on since this draft: call send_message again, show the new preview and ask for a yes to it"
  );
}

/**
 * What one MCP session knows of the drafts it made: which of its own tool calls
 * answered each. An assistant that drafts, goes on to do something else and
 * then confirms is confirming words that were never about this draft, so that
 * confirm is refused (draftStale) and the draft is left untouched — a proper
 * retake goes through send_message, which makes a new one.
 *
 * In memory and per session — it tracks the conversation's own calls, nothing
 * the store keeps. A draft a confirm has reached is forgotten
 * here, so from then on the service's own answer stands — its receipt, or
 * SEND_OUTCOME_UNKNOWN — and the same message is never drafted twice.
 */
export class SessionDrafts {
  private calls = 0;
  /** draft_id → the session's call that answered it; capped like the session's drafts. */
  private readonly madeAt = new Map<string, number>();

  /** Counts a tool call of this session and gives its place, from 1. */
  startCall(): number {
    return ++this.calls;
  }

  /** The call `at` answered this draft. */
  note(draftId: string, at: number): void {
    if (this.madeAt.size >= DRAFT_CAP) {
      const oldest = this.madeAt.keys().next();
      if (oldest.done !== true) this.madeAt.delete(oldest.value);
    }
    this.madeAt.set(draftId, at);
  }

  /**
   * Whether any other tool call of this session came between the draft and the
   * call `at`. A draft this session never made, or one a confirm already
   * reached, is not stale: nothing here speaks for it.
   */
  movedOn(draftId: string, at: number): boolean {
    const made = this.madeAt.get(draftId);
    return made !== undefined && at - made > 1;
  }

  /**
   * A confirm of this draft was refused before the service saw it (an id this
   * session cannot confirm, a wrong account). Confirming the same draft is not
   * the talk moving on, so the retry that follows stands where this call does.
   */
  retried(draftId: string, at: number): void {
    if (this.madeAt.has(draftId)) this.madeAt.set(draftId, at);
  }

  /** A confirm reached this draft; what becomes of it is the service's answer. */
  forget(draftId: string): void {
    this.madeAt.delete(draftId);
  }
}

/** A draft handed to WhatsApp whose arrival nobody can vouch for. Never retried. */
export function sendOutcomeUnknown(id: string, cause?: string): WazapError {
  return new WazapError(
    "SEND_OUTCOME_UNKNOWN",
    `Draft ${id} was handed to WhatsApp, but whether it arrived is unknown${cause ? `: ${cause}` : "."}`,
    "Do not confirm or draft it again. Tell the user it may or may not have arrived. read_messages shows it once WhatsApp echoes it; not there yet does not mean it failed. Check again in a few seconds, and ask before any new send"
  );
}

/**
 * Drafts as confirm_send sees them, kept in the account database (`sends`)
 * so a confirm outlives a crash and never sends twice. Every call takes the
 * account's table, since the service may swap its database (a different
 * number linked). The owner is the identity that drafted — the credential's
 * stable identity on HTTP, an opaque id elsewhere (tool-runtime.ts): every
 * other identity is told there is no such draft.
 *
 * A draft lapses after 15 minutes; an owner keeps at most 20 and an account
 * 200. Confirming claims it atomically; a send that failed before its key
 * reached the socket gives it back (release), one that got further is settled
 * as sent or as unknown, and stays so. A sent draft answers its receipt again; an unknown
 * one answers SEND_OUTCOME_UNKNOWN until WhatsApp echoes its key.
 */
export class DraftStore {
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = DRAFT_TTL_MS,
    private readonly cap: number = DRAFT_CAP,
    private readonly accountCap: number = DRAFT_ACCOUNT_CAP
  ) {}

  put(sends: Sends, to: OutgoingTarget, payload: DraftPayload, keyId: string, owner: string | null = null): Draft {
    const now = this.now();
    this.sweep(sends);
    const draft: Draft = {
      id: `d_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      to,
      preview: formatDraftPreview(to, payload),
      expiresAt: now + this.ttlMs,
      payload,
      keyId,
    };
    const frozen: FrozenDraft = { to, preview: draft.preview, payload };
    sends.insertDraft(
      {
        draftId: draft.id,
        owner,
        chatJid: to.chat_id,
        kind: payload.kind,
        payload: JSON.stringify(frozen),
        keyId,
        createdAt: now,
        expiresAt: draft.expiresAt,
      },
      this.cap,
      this.accountCap
    );
    return draft;
  }

  /** Whether the database holds this draft in any state, so a repeated confirm finds its account. */
  has(sends: Sends, id: string): boolean {
    return sends.get(id) !== null;
  }

  /**
   * Takes a draft for sending, or answers what an earlier confirm made of it.
   * Missing, and another session's, are the same DRAFT_NOT_FOUND; the owner's
   * lapsed draft is DRAFT_EXPIRED once, then gone.
   */
  claim(sends: Sends, id: string, owner: string | null = null): Claim {
    const now = this.now();
    if (sends.claim(id, owner, now)) return { state: "claimed", draft: draftOf(sends.get(id)!) };
    const row = sends.get(id);
    if (row === null || row.owner !== owner) throw draftNotFound(id);
    switch (row.state) {
      case "draft":
        sends.removeDraft(id);
        throw draftExpired(id);
      case "sent":
        return { state: "sent", receipt: { ...(JSON.parse(row.receipt ?? "{}") as SentMessage), already_sent: true } };
      case "sending":
      case "unknown":
        throw sendOutcomeUnknown(id);
    }
  }

  /** The claimed draft failed before its key reached the socket: it may be confirmed again. */
  release(sends: Sends, id: string): void {
    sends.release(id, this.now());
  }

  /** The claimed (or unknown) draft is known to be sent. */
  settle(sends: Sends, id: string, receipt: SentMessage): void {
    const now = this.now();
    sends.settle(id, JSON.stringify(receipt), now, now + SEND_RECORD_TTL_MS);
  }

  /** The claimed draft reached the socket and then failed: it may or may not have arrived. */
  unsettle(sends: Sends, id: string, errorCode: string): void {
    const now = this.now();
    sends.unsettle(id, errorCode, now, now + SEND_RECORD_TTL_MS);
  }

  /** Sends a crash or a stop left under way are unknown now; lapsed rows go. Before any confirm runs. */
  recover(sends: Sends): void {
    const now = this.now();
    sends.interrupt(now, now + SEND_RECORD_TTL_MS);
    this.sweep(sends);
  }

  view(draft: Draft): DraftView {
    const view: DraftView = {
      status: "draft",
      draft_id: draft.id,
      to: draft.to,
      preview: draft.preview,
      expires_at: isoWithOffset(draft.expiresAt),
      kind: draft.payload.kind,
    };
    if (looksUnnamed(draft.to)) view.unnamed_recipient = true;
    return view;
  }

  /** Lapsed drafts and forgotten sends, a bounded chunk at a time. */
  private sweep(sends: Sends): void {
    sends.sweep(this.now(), SWEEP_CHUNK);
  }
}

/** The text a receipt shows for a stored send; empty once the message it sent was deleted. */
export function frozenReceiptText(row: SendRecord): string {
  const frozen = JSON.parse(row.payload) as Partial<FrozenDraft>;
  return frozen.payload === undefined ? "" : receiptText(frozen.payload);
}

/** The draft a row froze. */
function draftOf(row: SendRecord): Draft {
  const frozen = JSON.parse(row.payload) as FrozenDraft;
  return {
    id: row.draftId,
    to: frozen.to,
    preview: frozen.preview,
    expiresAt: row.expiresAt,
    payload: frozen.payload,
    keyId: row.keyId,
  };
}

/**
 * The text a receipt shows for a draft, as the send would have answered it;
 * a media file's type is only known once loaded, so a captionless one is
 * `[media]`.
 */
export function receiptText(payload: DraftPayload): string {
  switch (payload.kind) {
    case "text":
      return payload.text;
    case "media":
      return payload.caption ?? "[media]";
    case "poll":
      return `[poll] ${payload.question}`;
    case "location":
      return `[location] ${payload.name ?? `${payload.latitude}, ${payload.longitude}`}`;
    case "forward":
      return payload.text ?? "";
    default: {
      const _exhaustive: never = payload;
      return _exhaustive;
    }
  }
}

/** The resolved recipient the way the preview and the sent line show it. */
export function describeTarget(to: OutgoingTarget): string {
  if (to.number) return `${to.name} (${formatNumber(to.number)})`;
  if (to.chat_id.endsWith("@g.us")) return `${to.name} (group)`;
  return to.name;
}

export function formatToLine(to: OutgoingTarget): string {
  return `To: ${describeTarget(to)}`;
}

/**
 * True when the name shown is not a name at all: the bare digits displayName
 * falls back to, or the "unknown (lid …)" an unmapped LID gets. A public
 * profile name does not trip it — that check needs the address book, which the
 * send tools run.
 */
export function looksUnnamed(to: OutgoingTarget): boolean {
  const name = to.name.trim();
  if (name === "" || name === "unknown" || name.startsWith("unknown (")) return true;
  return /^[\d\s+().-]+$/.test(name);
}

/**
 * The text with an `@<user>` token for every mentioned jid it does not already
 * name. WhatsApp highlights a mention only where the text carries the user part
 * of the jid in mentionedJid, and sends the text as written, so a missing token
 * goes at the end — before the draft, so the preview is the text that leaves.
 */
export function withMentionTokens(text: string, jids: readonly string[]): string {
  let result = text;
  for (const jid of jids) {
    const user = jid.split("@")[0] ?? "";
    const escaped = user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A longer number that starts with these digits is someone else.
    if (user === "" || new RegExp(`@${escaped}(?!\\d)`).test(result)) continue;
    result = `${result}${/\s$/.test(result) ? "" : " "}@${user}`;
  }
  return result;
}

export function formatDraftPreview(to: OutgoingTarget, payload: DraftPayload): string {
  return `${formatToLine(to)}\n${formatBody(payload)}`;
}

export function renderDraft(view: DraftView): string {
  const lines = [`Draft ${view.draft_id}. Not sent.`, "", view.preview];
  if (view.unnamed_recipient === true) {
    lines.push(
      "",
      "Note: the recipient is not a saved contact — the name shown is their public WhatsApp name, or only their number."
    );
  }
  const style = styleCheckLines(view.style_check);
  if (style.length > 0) lines.push("", ...style);
  lines.push("", "Show this to the user. After they say yes, call confirm_send with this draft_id.");
  return lines.join("\n");
}

function formatBody(payload: DraftPayload): string {
  switch (payload.kind) {
    case "text":
      return payload.replyTo ? `[reply] "${payload.text}"` : `"${payload.text}"`;
    case "media":
      return mediaBody(payload);
    case "poll":
      return `[poll] ${payload.question}${payload.multiSelect ? " (multiple answers)" : ""}\n${payload.options.join(" / ")}`;
    case "location": {
      const label = payload.name ?? `${payload.latitude}, ${payload.longitude}`;
      const extra = payload.address ? `\n${payload.address}` : "";
      return `[location] ${label}${extra}`;
    }
    case "forward":
      return `Forward: "${payload.text ?? ""}"`;
    default: {
      const _exhaustive: never = payload;
      return _exhaustive;
    }
  }
}

function mediaBody(payload: Extract<DraftPayload, { kind: "media" }>): string {
  const name = mediaLabel(payload);
  const tag = payload.asVoice ? "voice" : payload.asDocument ? "document" : payload.asGif ? "gif" : "media";
  const line = `[${tag}] ${name}`;
  // Only a caption that will travel: a voice note or an audio file goes without one.
  const shown = payload.caption && captionTravels(mimeOfSource(payload.source), payload);
  return shown ? `${line}\n"${payload.caption}"` : line;
}

function mediaLabel(payload: Extract<DraftPayload, { kind: "media" }>): string {
  const path = payload.source.file_path;
  if (path) return path.split(/[/\\]/).pop() || path;
  const url = payload.source.url;
  if (url) {
    try {
      const last = new URL(url).pathname.split("/").filter(Boolean).pop();
      if (last) return decodeURIComponent(last);
    } catch {
      return url;
    }
    return url;
  }
  return "file";
}

/** +40 722 123 456 from stored digits, so the preview matches the send skill. */
function formatNumber(digits: string): string {
  const raw = digits.startsWith("+") ? digits.slice(1) : digits;
  if (!/^\d+$/.test(raw) || raw.length < 4) return digits.startsWith("+") ? digits : `+${digits}`;
  const rest =
    raw
      .slice(2)
      .match(/.{1,3}/g)
      ?.join(" ") ?? raw.slice(2);
  return `+${raw.slice(0, 2)} ${rest}`;
}
