/**
 * Live calls. Baileys reports a call as a stream of status events and never as
 * a message, so this folds that stream into one entry per call and hands back a
 * synthetic WAMessage the ordinary store path can carry. Pure: no timers, no
 * socket, no store, so a test can drive it by feeding events and a clock.
 */

import { proto, WAMessageStubType, type BinaryNode, type WACallEvent, type WAMessage } from "baileys";
import type { CallDirection, CallKind, CallOutcome } from "./wa-types.js";

/** A ringing call nobody answered and nobody hung up: the terminal event was lost. */
const RING_TIMEOUT_MS = 2 * 60_000;

/**
 * An answered call is not expired at the ring timeout, which would invent a
 * two-minute duration for a conversation still going on. It is only cut loose
 * once it has run longer than any real call does.
 */
const ANSWERED_CAP_MS = 6 * 3_600_000;

/**
 * How many settled call ids to remember. They are what makes a repeated
 * terminal event store nothing twice, and the process is long-lived, so the set
 * has to forget its oldest eventually rather than grow for the whole session.
 */
const SETTLED_MEMORY = 500;

/** Marks a stored message as one wazap tracked itself. See `isTrackedCall`. */
const TRACKED_ID_PREFIX = "call_";

export interface CallEntry {
  callId: string;
  /** The group jid for a group call, else the peer's, raw: whatsapp.ts canonicalises. */
  chatId: string;
  /** Offer time in ms. */
  at: number;
  kind: CallKind;
  direction: CallDirection;
  outcome: CallOutcome;
  durationSeconds?: number;
}

interface Pending {
  callId: string;
  chatId: string;
  at: number;
  kind: CallKind;
  direction: CallDirection;
  acceptedAt?: number;
  lastSeen: number;
}

const OUTCOME_CODES: Record<CallOutcome, proto.Message.CallLogMessage.CallOutcome> = {
  answered: proto.Message.CallLogMessage.CallOutcome.CONNECTED,
  rejected: proto.Message.CallLogMessage.CallOutcome.REJECTED,
  missed: proto.Message.CallLogMessage.CallOutcome.MISSED,
  unanswered: proto.Message.CallLogMessage.CallOutcome.MISSED,
};

function noAnswer(direction: CallDirection): CallOutcome {
  return direction === "outgoing" ? "unanswered" : "missed";
}

/**
 * `from` arrives as a LID as often as a phone jid, and either can carry a
 * device suffix, so only the user part of the two jids is comparable.
 */
function samePerson(one: string, other: string): boolean {
  const user = (jid: string): string => (jid.split("@")[0] ?? "").split(":")[0] ?? "";
  const left = user(one);
  return left.length > 0 && left === user(other);
}

export class CallTracker {
  private readonly calls = new Map<string, Pending>();
  private readonly settled = new Set<string>();

  get pending(): number {
    return this.calls.size;
  }

  /** The entry to store once the call reaches a terminal state, else null. */
  observe(event: WACallEvent, ownJid: string, now: number): CallEntry | null {
    if (!event.id || this.settled.has(event.id)) return null;
    const call = this.calls.get(event.id) ?? this.begin(event, ownJid, now);
    call.lastSeen = now;
    switch (event.status) {
      case "accept":
        call.acceptedAt = now;
        return null;
      case "reject":
        return this.finish(call, "rejected");
      case "timeout":
        return this.finish(call, noAnswer(call.direction));
      case "terminate":
        return call.acceptedAt === undefined
          ? this.finish(call, noAnswer(call.direction))
          : this.finish(call, "answered", Math.round((now - call.acceptedAt) / 1000));
      default:
        return null;
    }
  }

  /** Entries for calls whose terminal event never arrived. */
  expire(now: number): CallEntry[] {
    const done: CallEntry[] = [];
    for (const call of [...this.calls.values()]) {
      if (call.acceptedAt === undefined) {
        if (now - call.lastSeen >= RING_TIMEOUT_MS) done.push(this.finish(call, noAnswer(call.direction)));
      } else if (now - call.acceptedAt >= ANSWERED_CAP_MS) {
        done.push(this.finish(call, "answered", Math.round((now - call.acceptedAt) / 1000)));
      }
    }
    return done;
  }

  /**
   * An event for an unknown call-id starts a pending call from whatever it
   * carries, so a restart in the middle of one still records something. Only
   * the offer names isVideo and the group, which is why baileys replays them
   * from its own cache onto the later events of the same call.
   */
  private begin(event: WACallEvent, ownJid: string, now: number): Pending {
    const offered = event.date instanceof Date ? event.date.getTime() : Number.NaN;
    const chat = (event.isGroup ? (event.groupJid ?? event.chatId) : event.chatId) || event.from;
    const call: Pending = {
      callId: event.id,
      chatId: chat,
      at: Number.isFinite(offered) ? offered : now,
      kind: event.isVideo ? "video" : "voice",
      direction: samePerson(event.from, ownJid) ? "outgoing" : "incoming",
      lastSeen: now,
    };
    this.calls.set(event.id, call);
    return call;
  }

  private finish(call: Pending, outcome: CallOutcome, durationSeconds?: number): CallEntry {
    this.calls.delete(call.callId);
    this.settled.add(call.callId);
    if (this.settled.size > SETTLED_MEMORY) {
      const oldest = this.settled.values().next().value;
      if (oldest !== undefined) this.settled.delete(oldest);
    }
    return {
      callId: call.callId,
      chatId: call.chatId,
      at: call.at,
      kind: call.kind,
      direction: call.direction,
      outcome,
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
    };
  }
}

/**
 * True for a message this tracker built. The tracker emits one entry per call
 * id, so two of these are always two different calls however close together
 * they fall, which is the one thing a dedupe by timestamp cannot know.
 */
export function isTrackedCall(raw: WAMessage): boolean {
  return (raw.key?.id ?? "").startsWith(TRACKED_ID_PREFIX);
}

/**
 * The entry as WhatsApp would have logged it, so snapshot, history JSONL, views
 * and list_chats all carry a live call with no machinery of their own. The
 * fields have to survive an encode/decode round trip, because that is what
 * persistence does to it.
 */
export function callMessage(entry: CallEntry): WAMessage {
  return {
    key: {
      remoteJid: entry.chatId,
      fromMe: entry.direction === "outgoing",
      id: `${TRACKED_ID_PREFIX}${entry.callId}`,
    },
    messageTimestamp: Math.floor(entry.at / 1000),
    message: {
      callLogMesssage: {
        isVideo: entry.kind === "video",
        callOutcome: OUTCOME_CODES[entry.outcome],
        ...(entry.durationSeconds === undefined ? {} : { durationSecs: entry.durationSeconds }),
      },
    },
  };
}

/**
 * One line for a raw call stanza, for the WAZAP_DEBUG_CALLS log: tags and
 * attributes all the way down, bytes as their length. It shows what a linked
 * device is actually sent, before Baileys keeps only part of it.
 */
export function callNodeLine(node: BinaryNode): string {
  const attrs = Object.entries(node.attrs ?? {}).map(([key, value]) => ` ${key}=${value}`).join("");
  const content = Array.isArray(node.content)
    ? node.content.map(callNodeLine).join("")
    : node.content instanceof Uint8Array
      ? `[${node.content.length} B]`
      : typeof node.content === "string"
        ? JSON.stringify(node.content)
        : "";
  return `<${node.tag}${attrs}>${content}</${node.tag}>`;
}

/** For the same log: a message that carries a call (a call log, a call stub), as one line; null for any other. */
export function callMessageLine(raw: WAMessage): string | null {
  const fields = Object.keys(raw.message ?? {}).filter((key) => /call/i.test(key));
  const stub = raw.messageStubType ? WAMessageStubType[raw.messageStubType] : undefined;
  if (fields.length === 0 && !stub?.includes("CALL")) return null;
  const content = fields.map((key) => `${key}=${JSON.stringify((raw.message as Record<string, unknown>)[key])}`).join(" ");
  return `call message: id=${raw.key.id} chat=${raw.key.remoteJid} fromMe=${raw.key.fromMe}${stub ? ` stub=${stub}` : ""} ${content}`.trim();
}
