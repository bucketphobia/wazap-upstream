/**
 * The in-memory store fed from Baileys events, and its shape on disk. Baileys
 * emits raw events rather than exposing a queryable store, so wazap keeps
 * chats, contacts and messages itself, keyed by canonical jid, and writes a
 * snapshot under the data dir so a restart does not start blind.
 */
import { proto, type Chat as BaileysChat, type Contact as BaileysContact, type WAMessage } from "baileys";
import { LidRegistry } from "./identity.js";
import { isNoiseJid } from "./ids.js";
import { isControlMessage, messageTimestampMs, protoNumber, viewText } from "./messages.js";
import type { TranscriptRecord } from "./transcribe/index.js";

// One window for memory and disk: this must stay equal to
// HISTORY_STORE_CAP_PER_CHAT in whatsapp.ts, so keyword search covers
// everything the history files keep.
export const MAX_MESSAGES_PER_CHAT = 2_000;
const PERSIST_MESSAGES_PER_CHAT = 120;

export interface HistoryRecord {
  sid: string;
  ts: number;
  raw: string;
  /** Added in 0.9.8. The transcript held for this message when the line was written. */
  tr?: TranscriptRecord;
  /** Absolute deadline survives edits that strip the original contextInfo. */
  expiresAt?: number;
  /**
   * Added in 0.20.0. A tombstone, not a message: `sid` was deleted for the
   * linked account alone, so the replay leaves it out the way it leaves out a
   * revoke's target. Its `raw` is empty.
   */
  deleted?: true;
}

export interface StoreSnapshot {
  v: 1;
  chats: Record<string, string>;
  contacts: Record<string, BaileysContact>;
  messages: Record<string, string>;
  byChat: Record<string, string[]>;
  /** Added in 0.9.4; absent in snapshots older wazap versions wrote. */
  pushNames?: Record<string, string>;
  /** Added in 0.9.5. When wazap last asked WhatsApp for the whole address book. */
  contactsResyncedAt?: number;
  /** Added in 0.9.8. Transcripts of the messages this snapshot keeps, by message id. */
  transcripts?: Record<string, TranscriptRecord>;
  /** Message deadlines independent of the latest protobuf's shape. */
  expires?: Record<string, number>;
  /** Added in 0.13.0. Reactions on the messages this snapshot keeps: message id → author jid → emoji. */
  reactions?: Record<string, Record<string, string>>;
  /** Added in 0.13.0. Stories seen in the last day, newest last, by message id; their messages are in `messages`. */
  stories?: string[];
  /** Added in 0.13.0. Pairings learned from WhatsApp's lid table: lid → phone jid. Contacts carry their own; these are the ones only the table knew. */
  lids?: Record<string, string>;
  /** Added in 0.20.0. Poll votes and event responses on the messages this snapshot keeps: message id → voter jid → vote. */
  votes?: Record<string, Record<string, Vote>>;
  /** Added in 0.20.0. How far the account's own messages this snapshot keeps got: message id → receipt. */
  receipts?: Record<string, Receipt>;
}

/** How far one of the account's own messages got, as WhatsApp confirmed it. */
export interface Receipt {
  /** proto.WebMessageInfo.Status: 0 error, 1 pending, 2 sent, 3 delivered, 4 read, 5 played. */
  status?: number;
  /** In a group, per participant jid: when it reached them. */
  users?: Record<string, UserMoments>;
}

/** When a message was delivered to, read and played by one person, epoch ms. */
export interface UserMoments {
  delivered?: number;
  read?: number;
  played?: number;
}

const STATUS = proto.WebMessageInfo.Status;

/**
 * A status only climbs. ERROR is the one out of order: it can only follow a
 * send still pending, so it outranks that and nothing WhatsApp confirmed.
 */
function statusRank(status: number): number {
  return status === STATUS.ERROR ? STATUS.PENDING + 0.5 : status;
}

export function raiseStatus(receipt: Receipt, status: number): void {
  if (receipt.status === undefined || statusRank(status) > statusRank(receipt.status)) receipt.status = status;
}

/** Each moment keeps its latest; the message's status climbs to the furthest any one person got. */
export function raiseUser(receipt: Receipt, user: string, moments: UserMoments): void {
  const users = (receipt.users ??= {});
  const standing = (users[user] ??= {});
  for (const field of ["delivered", "read", "played"] as const) {
    const at = moments[field];
    if (at !== undefined && at > (standing[field] ?? 0)) standing[field] = at;
  }
  if (standing.read !== undefined || standing.played !== undefined) raiseStatus(receipt, STATUS.READ);
  else if (standing.delivered !== undefined) raiseStatus(receipt, STATUS.DELIVERY_ACK);
}

/** A receipt's timestamps, which WhatsApp sends in seconds, as epoch ms. */
export function momentsOf(receipt: proto.IUserReceipt): UserMoments {
  const ms = (value: typeof receipt.readTimestamp): number | undefined => {
    const seconds = protoNumber(value);
    return seconds ? seconds * 1000 : undefined;
  };
  const moments: UserMoments = {};
  const delivered = ms(receipt.receiptTimestamp);
  const read = ms(receipt.readTimestamp);
  const played = ms(receipt.playedTimestamp);
  if (delivered !== undefined) moments.delivered = delivered;
  if (read !== undefined) moments.read = read;
  if (played !== undefined) moments.played = played;
  return moments;
}

/** One person's standing vote on a poll or answer to an event. An empty choice is a withdrawn vote. */
export interface Vote {
  choice: string[];
  /** When it was cast, epoch ms. */
  at: number;
}

/** History-sync chat rows can embed the latest full message. Keep one payload store, not a hidden second copy. */
export function chatMetadata(chat: BaileysChat): BaileysChat {
  const metadata = { ...chat };
  delete metadata.messages;
  return metadata;
}

/** In-memory state fed from Baileys events, keyed by canonical jid. */
export class Store {
  readonly chats = new Map<string, BaileysChat>();
  readonly contacts = new Map<string, BaileysContact>();
  readonly messages = new Map<string, WAMessage>();
  readonly chatOf = new Map<string, string>();
  readonly byChat = new Map<string, string[]>();
  readonly edited = new Set<string>();
  readonly reactions = new Map<string, Map<string, string>>();
  /**
   * Votes on a poll or answers to an event, per voter. A withdrawal stays as an
   * empty choice, so an older vote that arrives after it cannot bring it back.
   */
  readonly votes = new Map<string, Map<string, Vote>>();
  /**
   * What WhatsApp confirmed about the account's own messages since they were
   * stored. The status a synced message carried in its proto is the floor
   * `receiptFor` starts from; nothing here ever lowers it.
   */
  readonly receipts = new Map<string, Receipt>();
  /**
   * The name a sender publishes on their own profile, as WhatsApp attaches it
   * to their messages. It is the only name we get for someone the user has not
   * saved, and it never arrives through the contact list.
   */
  readonly pushNames = new Map<string, string>();
  /** What a voice note said, keyed by message id. Transcribing is slow and can cost money. */
  readonly transcripts = new Map<string, TranscriptRecord>();
  /**
   * The rendered, lowercased text searchMessages matches on, filled lazily.
   * A message's words change on edit and when its transcript lands, and its
   * entry dies with it in `forget`.
   */
  private readonly searchText = new Map<string, string>();
  /**
   * The base64 proto encoding serialize() writes per message, computed once.
   * Encoding every persisted message on every flush was the bulk of the
   * snapshot's cost; a message's bytes change only when the raw does.
   */
  private readonly encoded = new Map<string, string>();
  /** Stories (status updates), newest last. Not a chat: they never join a ring and expire after a day. */
  readonly stories: string[] = [];
  /** Every lid ↔ number pairing learned, so a restart still knows who a lid-filed message is from. */
  readonly lids = new LidRegistry();

  /** See `needsContactResync`: it keeps a full resync from repeating forever. */
  contactsResyncedAt: number | null = null;

  private seconds(sid: string): number {
    const raw = this.messages.get(sid);
    return raw ? messageTimestampMs(raw) / 1000 : 0;
  }

  putMessage(sid: string, chatJid: string, raw: WAMessage): void {
    const known = this.messages.has(sid);
    if (known) {
      this.searchText.delete(sid);
      this.encoded.delete(sid);
    }
    this.messages.set(sid, raw);
    this.chatOf.set(sid, chatJid);
    let ring = this.byChat.get(chatJid);
    if (!ring) {
      ring = [];
      this.byChat.set(chatJid, ring);
    }
    // A sid can sit in more than one ring (an old snapshot filed it under both
    // the lid and the phone chat), so membership is the ring's business —
    // chatOf only says where it landed last.
    if (known && ring.includes(sid)) return;
    // Live messages arrive newest-last, so appending is enough; a history sync
    // delivers older ones out of order, and the ring stays sorted either way.
    const ts = messageTimestampMs(raw) / 1000;
    const last = ring.length > 0 ? this.seconds(ring[ring.length - 1]!) : Number.NEGATIVE_INFINITY;
    if (ts >= last) {
      ring.push(sid);
    } else {
      let lo = 0;
      let hi = ring.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        // <= keeps the stable-sort semantics the old code had: a same-second
        // message lands after the ones already there.
        if (this.seconds(ring[mid]!) <= ts) lo = mid + 1;
        else hi = mid;
      }
      ring.splice(lo, 0, sid);
    }
    while (ring.length > MAX_MESSAGES_PER_CHAT) {
      const dropped = ring.shift();
      if (dropped) this.forget(dropped);
    }
  }

  putStory(sid: string, chatJid: string, raw: WAMessage): void {
    const known = this.messages.has(sid);
    if (known) {
      this.searchText.delete(sid);
      this.encoded.delete(sid);
    }
    this.messages.set(sid, raw);
    this.chatOf.set(sid, chatJid);
    if (!known || !this.stories.includes(sid)) this.stories.push(sid);
  }

  /** Stories older than `cutoffMs` go, message and all, the way WhatsApp lets them go after a day. Returns the dropped sids. */
  pruneStories(cutoffMs: number): string[] {
    const dropped: string[] = [];
    for (const sid of [...this.stories]) {
      const raw = this.messages.get(sid);
      if (raw && messageTimestampMs(raw) >= cutoffMs) continue;
      this.stories.splice(this.stories.indexOf(sid), 1);
      this.forget(sid);
      dropped.push(sid);
    }
    return dropped;
  }

  /** A chat WhatsApp listed, or one that only arrived as messages. Contacts are not chats. */
  hasChat(id: string): boolean {
    return this.chats.has(id) || this.byChat.has(id);
  }

  hasMessage(id: string): boolean {
    return this.messages.has(id);
  }

  /** The tail of a chat, newest first. */
  recent(chatJid: string, count: number): Array<{ sid: string; raw: WAMessage }> {
    const ring = this.byChat.get(chatJid) ?? [];
    const tail: Array<{ sid: string; raw: WAMessage }> = [];
    for (let i = ring.length - 1; i >= 0 && tail.length < count; i--) {
      const sid = ring[i];
      const raw = this.messages.get(sid);
      if (raw) tail.push({ sid, raw });
    }
    return tail;
  }

  /** Forget one message entirely, its place in the chat included. */
  dropMessage(sid: string): void {
    const ring = this.byChat.get(this.chatOf.get(sid) ?? "");
    const at = ring?.indexOf(sid) ?? -1;
    if (ring && at !== -1) ring.splice(at, 1);
    this.forget(sid);
  }

  private forget(sid: string): void {
    this.messages.delete(sid);
    this.chatOf.delete(sid);
    this.edited.delete(sid);
    this.reactions.delete(sid);
    this.votes.delete(sid);
    this.receipts.delete(sid);
    this.transcripts.delete(sid);
    this.searchText.delete(sid);
    this.encoded.delete(sid);
  }

  /** Set a message's transcript — the words it searches by change with it. */
  setTranscript(sid: string, record: TranscriptRecord): void {
    this.transcripts.set(sid, record);
    this.searchText.delete(sid);
  }

  /** Anything under an existing sid was swapped or touched (an edit, a new timestamp). */
  noteMessageChanged(sid: string): void {
    this.searchText.delete(sid);
    this.encoded.delete(sid);
  }

  /** The base64 the snapshot writes for a message, encoded once per version of it. */
  private encodeMessage(sid: string, raw: WAMessage): string | null {
    let b64 = this.encoded.get(sid);
    if (b64 === undefined) {
      const fresh = encode(() => proto.WebMessageInfo.encode(raw).finish());
      if (fresh === null) return null;
      b64 = fresh;
      this.encoded.set(sid, b64);
    }
    return b64;
  }

  /**
   * What searchMessages matches against: the rendered view text, lowercased
   * once and held until the message or its transcript changes. Undefined when
   * the sid names nothing the store holds.
   */
  searchLower(sid: string): string | undefined {
    const raw = this.messages.get(sid);
    if (!raw) return undefined;
    let text = this.searchText.get(sid);
    if (text === undefined) {
      text = viewText(raw, this.transcripts.get(sid)).toLowerCase();
      this.searchText.set(sid, text);
    }
    return text;
  }

  /** Set or withdraw one author's reaction on a message. */
  react(target: string, author: string, emoji: string): void {
    const map = this.reactions.get(target) ?? new Map<string, string>();
    if (emoji) map.set(author, emoji);
    else map.delete(author);
    if (map.size > 0) this.reactions.set(target, map);
    else this.reactions.delete(target);
  }

  reactionsFor(sid: string): Array<{ emoji: string; sender: string }> {
    const map = this.reactions.get(sid);
    if (!map) return [];
    return [...map].map(([sender, emoji]) => ({ emoji, sender }));
  }

  /** Set one voter's choice on a poll or event, unless what is there was cast later. */
  vote(target: string, voter: string, choice: string[], at: number): void {
    const map = this.votes.get(target) ?? new Map<string, Vote>();
    const standing = map.get(voter);
    if (standing && standing.at > at) return;
    map.set(voter, { choice, at });
    this.votes.set(target, map);
  }

  /** The votes that stand, withdrawals left out. */
  votesFor(sid: string): Array<{ voter: string; choice: string[] }> {
    const map = this.votes.get(sid);
    if (!map) return [];
    return [...map].flatMap(([voter, vote]) => (vote.choice.length > 0 ? [{ voter, choice: vote.choice }] : []));
  }

  /** A status WhatsApp reported for one of the account's own messages; a late, lower one changes nothing. */
  markStatus(sid: string, status: number): void {
    const receipt = this.receipts.get(sid) ?? {};
    raiseStatus(receipt, status);
    this.receipts.set(sid, receipt);
  }

  /** One participant's receipt on one of the account's own messages. */
  markReceipt(sid: string, user: string, moments: UserMoments): void {
    const receipt = this.receipts.get(sid) ?? {};
    raiseUser(receipt, user, moments);
    this.receipts.set(sid, receipt);
  }

  /**
   * How far one of the account's own messages got: what its proto carried when
   * it was synced, raised by whatever arrived since. The account itself is no
   * recipient — its other devices confirm the message too, and a synced proto
   * lists them. Undefined for someone else's message, and when WhatsApp has
   * said nothing.
   */
  receiptFor(sid: string, canonical: (jid: string) => string, isMe: (jid: string) => boolean): Receipt | undefined {
    const raw = this.messages.get(sid);
    if (!raw?.key.fromMe) return undefined;
    const merged: Receipt = {};
    if (typeof raw.status === "number") raiseStatus(merged, raw.status);
    for (const synced of raw.userReceipt ?? []) {
      if (synced.userJid && !isMe(synced.userJid)) raiseUser(merged, canonical(synced.userJid), momentsOf(synced));
    }
    const kept = this.receipts.get(sid);
    if (kept?.status !== undefined) raiseStatus(merged, kept.status);
    for (const [user, moments] of Object.entries(kept?.users ?? {})) {
      if (!isMe(user)) raiseUser(merged, canonical(user), moments);
    }
    return merged.status === undefined ? undefined : merged;
  }

  serialize(deadlineFor?: (raw: WAMessage, sid: string) => number | undefined): StoreSnapshot {
    const snapshot: StoreSnapshot = {
      v: 1,
      chats: {},
      contacts: {},
      messages: {},
      byChat: {},
      pushNames: Object.fromEntries(this.pushNames),
      lids: this.lids.toJSON(),
      ...(this.contactsResyncedAt === null ? {} : { contactsResyncedAt: this.contactsResyncedAt }),
    };
    for (const [jid, chat] of this.chats) {
      const encoded = encode(() => proto.Conversation.encode(chatMetadata(chat)).finish());
      if (encoded) snapshot.chats[jid] = encoded;
    }
    for (const [jid, contact] of this.contacts) snapshot.contacts[jid] = contact;
    const keep = new Set<string>(this.stories);
    snapshot.stories = [...this.stories];
    for (const [jid, ring] of this.byChat) {
      const capped = ring.slice(-PERSIST_MESSAGES_PER_CHAT);
      snapshot.byChat[jid] = capped;
      for (const sid of capped) keep.add(sid);
    }
    const transcripts: Record<string, TranscriptRecord> = {};
    const reactions: Record<string, Record<string, string>> = {};
    const votes: Record<string, Record<string, Vote>> = {};
    const receipts: Record<string, Receipt> = {};
    for (const sid of keep) {
      const raw = this.messages.get(sid);
      if (!raw) continue;
      const encoded = this.encodeMessage(sid, raw);
      if (encoded) snapshot.messages[sid] = encoded;
      const deadline = deadlineFor?.(raw, sid);
      if (deadline !== undefined) (snapshot.expires ??= {})[sid] = deadline;
      const transcript = this.transcripts.get(sid);
      if (transcript) transcripts[sid] = transcript;
      const reacted = this.reactions.get(sid);
      if (reacted && reacted.size > 0) reactions[sid] = Object.fromEntries(reacted);
      const voted = this.votes.get(sid);
      if (voted && voted.size > 0) votes[sid] = Object.fromEntries(voted);
      const receipt = this.receipts.get(sid);
      if (receipt) receipts[sid] = receipt;
    }
    snapshot.transcripts = transcripts;
    snapshot.reactions = reactions;
    snapshot.votes = votes;
    snapshot.receipts = receipts;
    return snapshot;
  }

  /** A snapshot an older wazap wrote can still hold noise it used to keep. */
  hydrate(snapshot: StoreSnapshot): void {
    if (snapshot?.v !== 1) return;
    for (const [jid, b64] of Object.entries(snapshot.chats ?? {})) {
      if (isNoiseJid(jid)) continue;
      const chat = decodeChat(b64);
      if (chat) this.chats.set(jid, chatMetadata(chat));
    }
    for (const [jid, contact] of Object.entries(snapshot.contacts ?? {})) this.contacts.set(jid, contact);
    for (const [jid, name] of Object.entries(snapshot.pushNames ?? {})) this.pushNames.set(jid, name);
    this.lids.hydrate(snapshot.lids ?? {});
    this.contactsResyncedAt = snapshot.contactsResyncedAt ?? null;
    for (const [sid, b64] of Object.entries(snapshot.messages ?? {})) {
      const raw = decodeMessage(b64);
      if (raw && !isControlMessage(raw)) {
        this.searchText.delete(sid);
        this.encoded.delete(sid);
        this.messages.set(sid, raw);
      }
    }
    // A transcript of a message the snapshot no longer carries is a leak, not a cache.
    for (const [sid, transcript] of Object.entries(snapshot.transcripts ?? {})) {
      if (this.messages.has(sid)) this.setTranscript(sid, transcript);
    }
    for (const [sid, byAuthor] of Object.entries(snapshot.reactions ?? {})) {
      if (this.messages.has(sid)) this.reactions.set(sid, new Map(Object.entries(byAuthor)));
    }
    for (const [sid, byVoter] of Object.entries(snapshot.votes ?? {})) {
      if (this.messages.has(sid)) this.votes.set(sid, new Map(Object.entries(byVoter)));
    }
    for (const [sid, receipt] of Object.entries(snapshot.receipts ?? {})) {
      if (this.messages.has(sid)) this.receipts.set(sid, receipt);
    }
    for (const sid of snapshot.stories ?? []) {
      if (!this.messages.has(sid) || this.stories.includes(sid)) continue;
      this.stories.push(sid);
      this.chatOf.set(sid, "status@broadcast");
    }
    for (const [jid, ring] of Object.entries(snapshot.byChat ?? {})) {
      if (isNoiseJid(jid)) continue;
      const present = ring.filter((sid) => this.messages.has(sid));
      this.byChat.set(jid, present);
      for (const sid of present) this.chatOf.set(sid, jid);
    }
  }
}

/** How long a contact lookup (getContact) waits for WhatsApp's about text or profile picture. */
export function encode(run: () => Uint8Array): string | null {
  try {
    return Buffer.from(run()).toString("base64");
  } catch {
    return null;
  }
}

export function decodeMessage(b64: string): WAMessage | null {
  try {
    return proto.WebMessageInfo.decode(Buffer.from(b64, "base64")) as unknown as WAMessage;
  } catch {
    return null;
  }
}

export function decodeChat(b64: string): BaileysChat | null {
  try {
    return proto.Conversation.decode(Buffer.from(b64, "base64")) as unknown as BaileysChat;
  } catch {
    return null;
  }
}

/** decodeChat over the stored bytes themselves, without the base64 round trip. */
export function decodeChatBytes(bytes: Uint8Array): BaileysChat | null {
  try {
    return proto.Conversation.decode(bytes) as unknown as BaileysChat;
  } catch {
    return null;
  }
}
