/**
 * One legacy message, as the service's boot replay would read it, turned into
 * what the account database stores. Nothing is rendered here: the type, the
 * text and the quoted id come from messages.ts, the same functions the tools
 * show a message through, so a stored row says exactly what a view said.
 */
import { proto, type WAMessage } from "baileys";
import { isTrackedCall } from "../calls.js";
import { chatKindOf, parseSid, type MessageInput, type TranscriptInfo } from "../db/index.js";
import type { LidRegistry } from "../identity.js";
import { isNoiseJid, STATUS_JID } from "../ids.js";
import { messageExpiry } from "../message-expiry.js";
import {
  buildMessageView,
  callInfo,
  isCallPlaceholder,
  isControlMessage,
  isStubEvent,
  messageIdFor,
  messageText,
  messageType,
  protoNumber,
  reactionOf,
  revokedTargetKey,
  voteOf,
} from "../messages.js";
import type { TranscriptRecord } from "../transcribe/index.js";
import type { SkipReason } from "./report.js";

/** A timestamp further ahead than this is a clock gone wrong, not a message: it would sit on top of its chat for good. */
export const FUTURE_SLACK_MS = 24 * 3_600_000;
/** How long a story lives, as the service prunes it. */
export const STORY_TTL_MS = 24 * 3_600_000;
/** Two call records of one chat this close together are one call, as keepOverEarlierCall pairs them. */
export const CALL_DEDUPE_WINDOW_MS = 60_000;

/** What the service knows about identity and the clock while it replays: the pieces a decision needs. */
export interface LegacyIdentity {
  lids: LidRegistry;
  /** The linked account's phone jid, "" when unlinked. */
  ownJid: string;
  now: number;
  /** WAZAP_RETENTION: disappearing-message deadlines are recorded and enforced. */
  enforceExpiry: boolean;
  /** Deadlines recorded for a message, by view sid; only filled when enforceExpiry. */
  deadlines: Map<string, number>;
}

export function canonical(id: LegacyIdentity, jid: string): string {
  return id.lids.canonical(jid);
}

export function isMe(id: LegacyIdentity, jid: string): boolean {
  return id.lids.isSelf(jid, id.ownJid);
}

/** The id a view reports for a sid in any spelling: direction, canonical chat, key. Null for a sid that names no chat. */
export function viewSidOf(id: LegacyIdentity, sid: string): string | null {
  const parsed = parseSid(sid);
  if (parsed === null || parsed.fromMe === null) return null;
  return `${parsed.fromMe}_${canonical(id, parsed.chatJid)}_${parsed.keyId}`;
}

/** Deadlines only ever move earlier; the earliest recorded one wins. */
export function noteDeadline(id: LegacyIdentity, viewSid: string, at: number): void {
  if (!id.enforceExpiry) return;
  const deadline = Number.isSafeInteger(at) && at >= 0 ? at : 0;
  const current = id.deadlines.get(viewSid);
  if (current === undefined || deadline < current) id.deadlines.set(viewSid, deadline);
}

/** The deadline the service would enforce for this message: its own marker and every recorded one, earliest first. */
export function deadlineFor(id: LegacyIdentity, raw: WAMessage | null, viewSid: string): number | null {
  if (!id.enforceExpiry) return null;
  let deadline = Infinity;
  if (raw !== null) deadline = Math.min(deadline, messageExpiry(raw) ?? Infinity);
  deadline = Math.min(deadline, id.deadlines.get(viewSid) ?? Infinity);
  return deadline === Infinity ? null : deadline;
}

export function decodeRaw(bytes: Uint8Array): WAMessage | null {
  try {
    return proto.WebMessageInfo.decode(bytes) as unknown as WAMessage;
  } catch {
    return null;
  }
}

export function base64Bytes(b64: string): Uint8Array {
  const buffer = Buffer.from(b64, "base64");
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** A keyed reference to a message, over the canonical chat. */
export interface MessageRef {
  chatJid: string;
  fromMe: boolean;
  keyId: string;
}

export function refSid(ref: MessageRef): string {
  return `${ref.fromMe}_${ref.chatJid}_${ref.keyId}`;
}

/**
 * What a revoke takes back: the service's revokedTarget and revokedSids. A
 * protocol revoke names its target by key, sender-relative; a REVOKE stub is
 * its own target, and in a group either direction may be the one it removes.
 */
export function revokedRefs(id: LegacyIdentity, raw: WAMessage, chatJid: string): MessageRef[] {
  const target = revokedTargetKey(raw);
  if (!target?.id || !raw.key?.remoteJid) return [];
  let fromMe: boolean;
  const stub = raw.messageStubType === proto.WebMessageInfo.StubType.REVOKE;
  if (stub) fromMe = Boolean(target.fromMe);
  else {
    const author = target.participant || target.remoteJid;
    fromMe = raw.key.fromMe ? Boolean(target.fromMe) : !target.fromMe && Boolean(author) && isMe(id, author!);
  }
  if (stub && chatJid.endsWith("@g.us")) {
    return [
      { chatJid, fromMe: false, keyId: target.id },
      { chatJid, fromMe: true, keyId: target.id },
    ];
  }
  return [{ chatJid, fromMe, keyId: target.id }];
}

export type Classified =
  | { kind: "skip"; reason: SkipReason }
  | { kind: "reaction"; targetSid: string; author: string; emoji: string; ts: number }
  | { kind: "vote" }
  | { kind: "message"; input: MessageInput; viewSid: string; raw: WAMessage; revokes: MessageRef[] };

export interface ClassifyOptions {
  /** The protobuf bytes as stored; re-encoding could differ from what arrived. */
  bytes: Uint8Array | null;
  /** The chat the message is filed under; the canonical form of its remote jid unless a snapshot ring says otherwise. */
  chatJid: string;
  transcript?: TranscriptRecord | null;
  /** When the protobuf carries no timestamp, the one its record does (history lines keep seconds). */
  fallbackTs?: number;
  /** A story: filed under status@broadcast, which is otherwise a noise jid. */
  story?: boolean;
  /** Store a vote as the message the service shows while its poll cannot open it. */
  asMessage?: boolean;
}

/** The sender a view names, as a jid the database files a contact under; undefined for the other side of a direct chat. */
export function senderOf(id: LegacyIdentity, raw: WAMessage, chatJid: string): string | null | undefined {
  if (raw.key.fromMe) return null;
  if (chatJid.endsWith("@s.whatsapp.net")) return undefined;
  const from = raw.key.participant || raw.participant || raw.key.remoteJid || "";
  if (!from) return null;
  const jid = canonical(id, from);
  return chatKindOf(jid) === "direct" && !isNoiseJid(jid) ? jid : null;
}

/** The message a reply quotes, spelled as the view spells it. */
export function quotedSidOf(id: LegacyIdentity, raw: WAMessage, chatJid: string): string | null {
  const view = buildMessageView(raw, {
    canonical: (jid) => canonical(id, jid),
    nameFor: (jid) => jid,
    ownId: id.ownJid,
    chatId: chatJid,
    edited: false,
    reactions: [],
    now: id.now,
  });
  return view.quoted?.message_id ?? null;
}

/**
 * The boot replay's filters, in its order: no chat, no payload, a noise jid,
 * control machinery; then a reaction or vote is a mark, not a message; then a
 * message, with the rendering the tools show.
 */
export function classify(id: LegacyIdentity, raw: WAMessage, options: ClassifyOptions): Classified {
  if (!raw.key?.remoteJid) return { kind: "skip", reason: "malformed" };
  if (!raw.message && !isStubEvent(raw)) return { kind: "skip", reason: "control" };
  const chatJid = options.chatJid;
  if (!(options.story === true && chatJid === STATUS_JID) && isNoiseJid(chatJid)) return { kind: "skip", reason: "noise" };
  if (isControlMessage(raw)) return { kind: "skip", reason: "control" };
  const reaction = reactionOf(raw);
  if (reaction && options.asMessage !== true) {
    const author = raw.key.fromMe ? id.ownJid : canonical(id, raw.key.participant || raw.key.remoteJid || chatJid);
    if (!author) return { kind: "skip", reason: "missingTarget" };
    const seconds = protoNumber(raw.messageTimestamp);
    const ts = seconds === undefined ? (options.fallbackTs ?? id.now) : seconds * 1000;
    return { kind: "reaction", targetSid: messageIdFor(reaction.targetKey, chatJid), author, emoji: reaction.text, ts };
  }
  if (options.asMessage !== true && voteOf(raw)) return { kind: "vote" };
  const keyId = raw.key.id;
  if (!keyId) return { kind: "skip", reason: "malformed" };
  const seconds = protoNumber(raw.messageTimestamp);
  const ts = seconds === undefined || seconds <= 0 ? options.fallbackTs : seconds * 1000;
  if (ts === undefined || !Number.isSafeInteger(ts) || ts <= 0) return { kind: "skip", reason: "malformed" };
  if (ts > id.now + FUTURE_SLACK_MS) return { kind: "skip", reason: "futureTs" };

  const fromMe = Boolean(raw.key.fromMe);
  const viewSid = `${fromMe}_${chatJid}_${keyId}`;
  const type = messageType(raw);
  const spoken = options.transcript?.text && (type === "voice" || type === "audio") ? options.transcript.text : null;
  const sender = senderOf(id, raw, chatJid);
  const input: MessageInput = {
    chatJid,
    keyId,
    fromMe,
    ...(sender === undefined ? {} : { senderJid: sender }),
    ts,
    type,
    text: messageText(raw),
    transcript: spoken,
    ...(spoken === null ? {} : { transcriptInfo: transcriptInfoOfRecord(options.transcript!) }),
    raw: options.bytes,
    quotedSid: quotedSidOf(id, raw, chatJid),
    status: fromMe && typeof raw.status === "number" ? raw.status : null,
    expiresAt: deadlineFor(id, raw, viewSid),
    observedExpiresAt: messageExpiry(raw) ?? null,
  };
  return { kind: "message", input, viewSid, raw, revokes: revokedRefs(id, raw, chatJid) };
}

/** How much a call record says: a duration beats an outcome, an outcome beats Baileys' bare placeholder. */
export function callDetail(raw: WAMessage): number | null {
  const info = callInfo(raw);
  if (!info) return null;
  if (info.duration_seconds !== undefined) return 2;
  return isCallPlaceholder(raw) ? 0 : 1;
}

export { isTrackedCall };

/** A legacy transcript record's details, as the database keeps them next to its words. */
function transcriptInfoOfRecord(record: TranscriptRecord): TranscriptInfo {
  return {
    provider: typeof record.provider === "string" ? record.provider : "local",
    at: typeof record.at === "number" && Number.isFinite(record.at) ? record.at : 0,
    ...(typeof record.language === "string" ? { language: record.language } : {}),
    ...(typeof record.duration_seconds === "number" && Number.isFinite(record.duration_seconds) ? { duration_seconds: record.duration_seconds } : {}),
  };
}
