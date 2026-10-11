/**
 * What WhatsApp hands the account, filed in its database: history batches in
 * bounded transactions, live messages, and the marks on stored ones (edits,
 * receipts, reactions, votes, revokes), each behind a batch still being
 * stored; stories, calls, the names senders publish, and what the account's
 * own devices read. Part of WhatsAppService (src/whatsapp.ts), whose event
 * wiring calls in here and which lends its state through IngestHost.
 */

import {
  type BaileysEventMap,
  proto,
  type Chat as BaileysChat,
  type Contact as BaileysContact,
  type GroupMetadata,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from "baileys";
import { CallTracker, callMessage, isTrackedCall, type CallEntry } from "../calls.js";
import {
  chatKindOf,
  type AccountDb,
  MESSAGE_FLAGS,
  type FlagDetector,
  type MessageInput,
  type StoredMessage,
  type UpsertResult,
} from "../db/index.js";
import { isGroupId, isNoiseJid, isStatusJid, STATUS_JID } from "../ids.js";
import { FUTURE_SLACK_MS } from "../legacy-import/index.js";
import { logError } from "../logger.js";
import { messageExpiry } from "../message-expiry.js";
import { chatMetadata, decodeChat, encode, momentsOf } from "../store.js";
import {
  callInfo,
  isCallPlaceholder,
  isControlMessage,
  isEvent,
  isStubEvent,
  isoWithOffset,
  mentionedJids,
  messageIdFor,
  messageText,
  messageTimestampMs,
  messageType,
  pollOf,
  protoNumber,
  quotedMessageId,
  reactionOf,
  revokedTargetKey,
  voteOf,
  type EncryptedVote,
} from "../messages.js";
import { readVote } from "../polls.js";
import type { EmbedFeed } from "../recall/index.js";
import { frozenReceiptText, type DraftStore } from "../drafts.js";
import type { Config } from "../config.js";
import type { CallInfo } from "../wa-types.js";
import type { AccountIdentity } from "./identity.js";
import type { AccountSends } from "./send.js";
import type { AccountStorage } from "./storage.js";
import type { MessageViews } from "./views.js";
import type { AccountVoice } from "./voice.js";
import type { MessageWaits } from "./waits.js";

/** WhatsApp shows a story for a day; so does wazap. */
export const STORY_TTL_MS = 24 * 3_600_000;

const CALL_SWEEP_MS = 30_000;

/** The same call reaches the store up to three ways; only nearness in time tells them apart. */
const CALL_DEDUPE_WINDOW_MS = 60_000;

/** How far back into a chat a poll that just arrived looks for the votes that came before it. */
const EARLY_VOTE_SCAN = 2_000;

/** How long one transaction of a history batch may hold the event loop. */
const HISTORY_CHUNK_MS = 20;

/** A message a reply, a vote or a delete names by its chat, direction and key. */
export interface MessageRef {
  chatJid: string;
  fromMe: boolean;
  keyId: string;
}

type HistorySetEvent = BaileysEventMap["messaging-history.set"];

/** How much a call message says. A duration is the most it can carry. */
function callDetail(raw: WAMessage, info: CallInfo): number {
  if (info.duration_seconds !== undefined) return 2;
  return isCallPlaceholder(raw) ? 0 : 1;
}

/** The own enumerable fields whose value is not undefined, so a spread cannot erase with "unknown". */
function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** WhatsApp's description of a chat, as the database keeps it. */
function chatOf(bytes: Uint8Array): BaileysChat | null {
  return decodeChat(Buffer.from(bytes).toString("base64"));
}

function encodeChat(chat: BaileysChat): Uint8Array | null {
  const b64 = encode(() => proto.Conversation.encode(chat as proto.IConversation).finish());
  return b64 === null ? null : new Uint8Array(Buffer.from(b64, "base64"));
}

/** What the service lends ingest: its state and what an arrival touches beyond the database, read at each call. */
export interface IngestHost {
  stopped(): boolean;
  sock(): WASocket | null;
  /** The draft store: an echoed send settles its draft. */
  drafts(): DraftStore;
  /** Runs work that must not take the caller down; a failure is logged, and answers fallback. */
  handling<T>(what: string, work: () => T, fallback: T): T;
  /** A contact's name changed: the named-contacts count is stale. */
  namesChanged(): void;
  /** A stored message that is evidence the phone link is alive. */
  noteInbound(fromMe: boolean, ts: number): void;
  /** A history batch is stored: history counts as received, and a read waiting on it goes on. */
  noteHistoryReceived(): void;
  markSyncDone(): void;
  /** Stored live messages, queued for the webhook in the same transaction; returns them. */
  announced(stored: WAMessage[], type: string): WAMessage[];
  nudgeOutbox(): void;
  embedFeed(): EmbedFeed | null;
  /** Stored live messages whose media the kept-media settings may want (src/service/keep.ts). */
  keepMedia(stored: readonly WAMessage[]): void;
}

export class AccountIngest {
  /**
   * History batches stored one after another, and the live marks (edits,
   * reactions, receipts, deletes) that arrived while one was being stored,
   * each after the work before it; storageIdle waits on the chain.
   */
  private historyWork: Promise<void> = Promise.resolve();
  /** Batches and marks on the chain that have not run yet. */
  historyPending = 0;
  private callSweepTimer: ReturnType<typeof setInterval> | null = null;
  readonly calls = new CallTracker();
  /**
   * Read receipts from the account's own devices (the phone), since the
   * process started: what get_status shows so it can be checked live that they
   * arrive. `seen` counts receipts, `synced` incoming messages that arrived
   * already marked read, `applied` the ones that moved a chat's read mark,
   * `unmatched` receipts for a message not stored.
   */
  readonly readSelf = { seen: 0, synced: 0, applied: 0, unmatched: 0, lastAt: null as number | null };

  constructor(
    private readonly host: IngestHost,
    private readonly identity: AccountIdentity,
    private readonly views: MessageViews,
    private readonly storage: AccountStorage,
    private readonly sends: AccountSends,
    private readonly voice: AccountVoice,
    private readonly waits: MessageWaits,
    private readonly config: Config
  ) {}

  /**
   * What a revoke takes back, by chat, direction and key. Protocol keys are
   * sender-relative, unlike reactions', and an embedded key cannot revoke a
   * message in a different chat. Baileys' group REVOKE stub retains the
   * actor's fromMe, not necessarily the original author's (an admin may
   * revoke somebody else's message), so it takes back both directions.
   */
  private revokeTargets(raw: WAMessage): MessageRef[] {
    const target = revokedTargetKey(raw);
    if (!target?.id || !raw.key?.remoteJid) return [];
    const chatJid = this.identity.canonical(raw.key.remoteJid);
    if (raw.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
      if (isGroupId(chatJid)) {
        return [
          { chatJid, fromMe: false, keyId: target.id },
          { chatJid, fromMe: true, keyId: target.id },
        ];
      }
      return [{ chatJid, fromMe: Boolean(target.fromMe), keyId: target.id }];
    }
    const author = target.participant || target.remoteJid;
    const fromMe = raw.key.fromMe ? Boolean(target.fromMe) : !target.fromMe && Boolean(author) && this.identity.isMe(author!);
    return [{ chatJid, fromMe, keyId: target.id }];
  }

  /**
   * Messages gone for this account — revoked, deleted for everyone or for the
   * account alone — the way the phone lets them go: each becomes a tombstone,
   * ahead of the message when it has not arrived yet, so no replay brings it
   * back; its quotes lose their copy of it, its vector and its files go.
   */
  retract(targets: readonly MessageRef[], ts: number): void {
    const db = this.storage.readyDb();
    if (db === null || targets.length === 0) return;
    const at = this.plausibleTs(ts);
    db.transaction(() => {
      for (const target of targets) {
        if (!target.keyId || (isNoiseJid(target.chatJid) && !isStatusJid(target.chatJid))) continue;
        db.messages.delete(messageIdFor({ fromMe: target.fromMe, id: target.keyId }, target.chatJid), {
          chatJid: target.chatJid,
          keyId: target.keyId,
          fromMe: target.fromMe,
          ts: at,
        });
      }
    });
    void this.storage.scheduleFileCleanup().catch(() => {});
  }

  /**
   * One messages.update entry: a revoke takes its target back; otherwise an
   * edit replaces the words, a receipt raises the status of the account's own
   * message, a disappearing timer can only bring the deadline closer, and a
   * new timestamp that is not a receipt's re-dates what the message shows.
   */
  applyUpdate(key: WAMessageKey, update: Partial<WAMessage>): void {
    const jid = key.remoteJid ? this.identity.canonical(key.remoteJid) : undefined;
    if (!jid) return;
    const revoked = this.revokeTargets({ ...update, key } as WAMessage);
    if (revoked.length) {
      const at = protoNumber(update.messageTimestamp);
      this.retract(revoked, at === undefined ? Date.now() : at * 1000);
      return;
    }
    const db = this.storage.db;
    const sid = messageIdFor(key, jid);
    const stored = db.messages.get(sid);
    if (stored === null) return;
    const raw = this.views.rawOf(stored);
    if (raw === null) return;
    const merged = { ...raw, ...update, key: raw.key } as WAMessage;
    if (this.config.retention === true) {
      const deadline = messageExpiry(merged);
      if (deadline !== undefined && db.messages.setExpiry(stored.sid, deadline)) this.storage.armExpiry();
      if (db.messages.get(stored.sid) === null) {
        this.storage.armExpiry();
        return;
      }
    }
    const edited = update.message?.editedMessage?.message;
    const redated = update.messageTimestamp && typeof update.status !== "number" ? update.messageTimestamp : undefined;
    if (edited || redated !== undefined) {
      // A receipt's messageTimestamp is when it was delivered or read, not when
      // the message was sent; any other update's is the message's own. The
      // row keeps its place in time; what the message shows follows the update.
      const next: WAMessage = { ...raw, ...(edited ? { message: edited } : {}), ...(redated === undefined ? {} : { messageTimestamp: redated }) };
      const editedAt = edited ? (protoNumber(update.messageTimestamp) ?? 0) * 1000 || Date.now() : stored.editedAt;
      this.writeVersion(next, stored, editedAt);
      if (edited) this.host.embedFeed()?.kick();
    }
    // A receipt on a one-to-one message: sent, delivered, read, played.
    if (typeof update.status === "number" && stored.fromMe) db.messages.setStatus(stored.sid, update.status);
  }

  /**
   * A one-to-one receipt from the account's own devices: Baileys reports one
   * as an update to someone else's message (the key is not the account's own)
   * that raises it to read or played. The other side's receipts are always on
   * the account's own messages.
   */
  isReadSelfUpdate(key: WAMessageKey, update: Partial<WAMessage>): boolean {
    if (key.fromMe !== false || !key.remoteJid || !key.id) return false;
    if (update.status !== proto.WebMessageInfo.Status.READ && update.status !== proto.WebMessageInfo.Status.PLAYED) return false;
    const jid = this.identity.canonical(key.remoteJid);
    return chatKindOf(jid) === "direct" && !isNoiseJid(jid);
  }

  noteReadSelf(count: number): void {
    if (count === 0) return;
    this.readSelf.seen += count;
    this.readSelf.lastAt = Date.now();
  }

  /**
   * Moves each chat's read mark up to the messages the account's own devices
   * read. The key names someone else's message; its direction is not trusted,
   * so the message is looked up under either, and one of the account's own
   * never moves a mark.
   */
  applyReadSelf(keys: readonly WAMessageKey[]): void {
    const db = this.storage.db;
    db.transaction(() => {
      for (const key of keys) {
        if (!key.remoteJid || !key.id) continue;
        const outcome = db.messages.markReadSelf(`${this.identity.canonical(key.remoteJid)}_${key.id}`);
        if (outcome.chatJid === null) this.readSelf.unmatched++;
        else if (outcome.moved) this.readSelf.applied++;
      }
    });
  }

  ingestChat(chat: BaileysChat): void {
    if (!chat.id) return;
    if (chat.lidJid && chat.pnJid) this.identity.learnLid(chat.lidJid, chat.pnJid);
    const jid = this.identity.canonical(chat.id);
    if (isNoiseJid(jid)) return;
    this.writeChat(jid, { ...definedOnly(chat), id: jid });
  }

  /**
   * A chat's fields merged over what is stored, the way the snapshot used to
   * merge them: the list columns (name, archive, pin, mute, unread) and the
   * rest of WhatsApp's description, which never carries an embedded message.
   */
  writeChat(jid: string, fields: Partial<BaileysChat>): void {
    const db = this.storage.db;
    const current = db.identity.chat(jid);
    const previous = current?.proto ? chatOf(current.proto) : null;
    const merged = chatMetadata({ ...(previous ?? {}), ...fields, id: jid } as BaileysChat);
    const bytes = encodeChat(merged);
    db.identity.upsertChat({
      jid,
      ...("name" in fields ? { name: fields.name ?? null } : {}),
      ...("archived" in fields ? { archived: Boolean(fields.archived) } : {}),
      ...("pinned" in fields ? { pinned: protoNumber(fields.pinned) ?? null } : {}),
      ...("muteEndTime" in fields ? { mutedUntil: protoNumber(fields.muteEndTime) ?? null } : {}),
      ...("unreadCount" in fields ? { unread: Math.max(0, fields.unreadCount ?? 0) } : {}),
      ...(bytes === null ? {} : { proto: bytes }),
    });
  }

  ingestContact(contact: BaileysContact): void {
    if (!contact.id) return;
    this.identity.relearnLid(contact);
    const jid = this.identity.canonical(contact.id);
    if (isNoiseJid(jid) || chatKindOf(jid) !== "direct") return;
    // Baileys sends a contact with the fields it does not know set to
    // undefined; only what it states is written, or a name learned earlier
    // would be erased with "unknown".
    const fields = definedOnly(contact);
    const input = {
      ...(fields.name === undefined ? {} : { name: fields.name ?? null }),
      ...(fields.notify === undefined ? {} : { notify: fields.notify ?? null }),
      ...(fields.verifiedName === undefined ? {} : { verifiedName: fields.verifiedName ?? null }),
    };
    // A contact event puts the person in the address book, even one that names nothing.
    this.storage.db.identity.upsertContact({ jid, ...input, listed: true });
    if ("name" in input) this.host.namesChanged();
  }

  /**
   * A history batch — thousands of messages — in transactions of a bounded
   * duration, the event loop running between them, so live messages, timers
   * and tool calls are not held for the whole batch. Contacts, chats and the
   * batch's revokes go first; a revoke or a clear that lands between two
   * transactions is a barrier the later ones honour. Batches are stored one
   * after another, in the order they came, and history counts as received
   * once a batch is stored.
   */
  /**
   * A messages.upsert as the service takes it: stored, then announced when it
   * is new. `deferred` marks waited for a history batch, and are stored even
   * while a stop waits for that batch; a stopping service announces nothing.
   */
  receiveMessages(messages: WAMessage[], type: string, deferred = false): void {
    if (messages.length === 0) return;
    let stored: WAMessage[] = [];
    if (!deferred) {
      stored = this.host.handling("messages", () => this.storage.db.transaction(() => this.host.announced(this.ingestMessages(messages, type === "notify"), type)), []);
    } else if (this.storage.readyDb() !== null) {
      try {
        stored = this.storage.db.transaction(() => this.host.announced(this.fileMessages(messages, type === "notify"), type));
      } catch (err) {
        logError("messages", err);
      }
    }
    if (type === "notify" && !this.host.stopped()) {
      for (const raw of messages) {
        if (raw.key.fromMe) continue;
        this.host.noteInbound(false, messageTimestampMs(raw));
      }
      // What announced() queued goes out now, and retries a receiver back up may take.
      this.host.nudgeOutbox();
      this.waits.noteArrivals(stored);
      this.host.keepMedia(stored);
    }
  }

  ingestHistory(batch: HistorySetEvent): void {
    // A batch received before the stop is stored; one arriving after it began is not.
    if (this.host.stopped()) return;
    this.afterHistory(() => this.storeHistory(batch).catch((err: unknown) => logError("history sync", err)));
  }

  /**
   * Runs `work` now when no history batch is being stored, or right after the
   * one under way — and after anything already waiting on it. A mark aimed at
   * a message of that batch lands once the message is stored, instead of
   * finding nothing and being lost. With nothing pending the work starts at
   * once, so a small batch or a mark is stored before emit returns.
   */
  afterHistory(work: () => unknown): void {
    const run = async (): Promise<void> => {
      await work();
    };
    const guarded = (): Promise<void> => run().catch((err: unknown) => logError("history sync", err));
    this.historyPending++;
    const done = (): void => {
      this.historyPending--;
    };
    this.historyWork = this.historyPending === 1 ? guarded().finally(done) : this.historyWork.then(guarded).finally(done);
  }

  /**
   * A mark on a stored message — an edit, a status, a receipt, a reaction, a
   * delete — as the service applies it, behind a history batch still being
   * stored when there is one.
   */
  markLater(what: string, work: () => void): void {
    if (this.host.stopped()) return;
    if (this.historyPending === 0) {
      this.host.handling(what, work, undefined);
      return;
    }
    // A stop waits for the history it received, and for the marks that arrived with it.
    this.afterHistory(() => {
      if (this.storage.readyDb() === null) return;
      try {
        work();
      } catch (err) {
        logError(what, err);
      }
    });
  }

  /** A message whose whole meaning is a mark on another one: a reaction, a vote, a revoke. */
  isMark(raw: WAMessage): boolean {
    return reactionOf(raw) !== undefined || voteOf(raw) !== undefined || this.revokeTargets(raw).length > 0;
  }

  private async storeHistory({ chats, contacts, messages, lidPnMappings, isLatest, progress }: HistorySetEvent): Promise<void> {
    const all = messages ?? [];
    // WhatsApp sends the history once: a stop waits for a batch it already
    // received to be stored, so nothing here gives up on `stopped`.
    const db = this.storage.readyDb();
    if (db === null) return;
    try {
      for (const mapping of lidPnMappings ?? []) this.identity.learnLid(mapping.lid, mapping.pn);
      db.transaction(() => {
        for (const contact of contacts) this.ingestContact(contact);
        for (const chat of chats) this.ingestChat(chat);
        this.retractRevokes(all);
      });
    } catch (err) {
      logError("history sync", err);
    }
    for (let next = 0; next < all.length; ) {
      if (!db.isOpen) return;
      const from = next;
      try {
        next = db.transaction(() => this.storeMessages(all, from, HISTORY_CHUNK_MS));
      } catch (err) {
        logError("history sync", err);
        return;
      }
      if (next < all.length) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.host.noteHistoryReceived();
    if (isLatest === true || progress === 100) this.host.markSyncDone();
  }

  /** Every history batch received so far is stored. */
  async historyIdle(): Promise<void> {
    for (;;) {
      const pending = this.historyWork;
      await pending;
      if (pending === this.historyWork) return;
    }
  }

  /**
   * Files what a batch carries: revokes first, wherever their target landed or
   * lands later in the batch; reactions and votes onto their message; a story
   * apart; every other message through the database's barriers. Returns the
   * messages that were stored, which is what a webhook, a wait and the
   * transcription queue may act on.
   */
  private ingestMessages(messages: WAMessage[], live = false): WAMessage[] {
    if (this.host.stopped()) return [];
    return this.fileMessages(messages, live);
  }

  /** `live`: the messages genuinely arrived now (a notify), which is what the transcription queue asks. */
  private fileMessages(messages: WAMessage[], live = false): WAMessage[] {
    this.retractRevokes(messages);
    const stored: WAMessage[] = [];
    this.storeMessages(messages, 0, Infinity, stored, live);
    return stored;
  }

  /** The revokes a batch carries, before any of its messages: a revoked message must not be stored for a moment. */
  private retractRevokes(messages: readonly WAMessage[]): void {
    for (const raw of messages) {
      const targets = this.revokeTargets(raw);
      if (targets.length > 0 && !isStatusJid(raw.key.remoteJid ?? "")) this.retract(targets, messageTimestampMs(raw));
    }
  }

  /**
   * Stores `messages` from `from` on, until `budgetMs` have passed; returns
   * the index to continue from. The revokes among them are already applied.
   */
  private storeMessages(messages: readonly WAMessage[], from: number, budgetMs: number, stored: WAMessage[] = [], live = false): number {
    const started = performance.now();
    let index = from;
    for (; index < messages.length; index++) {
      if (index > from && index % 32 === 0 && performance.now() - started > budgetMs) break;
      const raw = messages[index]!;
      try {
        if (!raw.key?.remoteJid || (!raw.message && !isStubEvent(raw))) continue;
        if (isStatusJid(raw.key.remoteJid)) {
          this.ingestStory(raw);
          continue;
        }
        const jid = this.identity.canonical(raw.key.remoteJid);
        if (isNoiseJid(jid) || isControlMessage(raw)) continue;
        this.learnPushName(raw, jid);
        if (this.applyReaction(raw, jid)) continue;
        if (this.applyVote(raw, jid)) continue;
        if (!this.keepOverEarlierCall(raw, jid)) continue;
        const result = this.storeRaw(raw, jid, live);
        if (result === null || !this.kept(result)) continue;
        this.host.noteInbound(Boolean(raw.key.fromMe), messageTimestampMs(raw));
        this.foldVotesOnto(raw, jid);
        this.voice.queueTranscript(raw, result, live);
        stored.push(raw);
      } catch (err) {
        // One message the database refuses must not cost the rest of its batch.
        logError("message store", err);
      }
    }
    if (stored.length > 0) this.host.embedFeed()?.kick();
    return index;
  }

  kept(result: UpsertResult): boolean {
    return result.outcome === "inserted" || result.outcome === "updated" || result.outcome === "stale";
  }

  /** A timestamp the database files as given: a clock days ahead is today, as the import leaves it out. */
  private plausibleTs(ts: number): number {
    const now = Date.now();
    return !Number.isSafeInteger(ts) || ts <= 0 || ts > now + FUTURE_SLACK_MS ? now : ts;
  }

  /**
   * One message as the database stores it: the rendering the tools show, the
   * quote it answers, who wrote it, its delivery status and, under
   * WAZAP_RETENTION, its disappearing deadline. A time days in the future is
   * a device's clock gone wrong: the message is filed, and dated, as now.
   */
  private messageInput(raw: WAMessage, chatJid: string): { input: MessageInput; raw: WAMessage } | null {
    const keyId = raw.key.id;
    if (!keyId) return null;
    const seconds = protoNumber(raw.messageTimestamp);
    const ts = this.plausibleTs(seconds === undefined ? Date.now() : seconds * 1000);
    if (seconds === undefined || ts !== seconds * 1000) raw = { ...raw, messageTimestamp: Math.floor(ts / 1000) };
    const fromMe = Boolean(raw.key.fromMe);
    let expiresAt: number | null = null;
    if (this.config.retention === true) expiresAt = messageExpiry(raw) ?? null;
    if (chatJid === STATUS_JID) expiresAt = Math.min(expiresAt ?? Infinity, ts + STORY_TTL_MS);
    const sender = this.senderOf(raw, chatJid);
    let bytes: Uint8Array | null;
    try {
      bytes = proto.WebMessageInfo.encode(raw).finish();
    } catch {
      bytes = null;
    }
    const input: MessageInput = {
      chatJid,
      keyId,
      fromMe,
      ...(sender === undefined ? {} : { senderJid: sender }),
      ts,
      type: messageType(raw),
      text: messageText(raw),
      raw: bytes,
      quotedSid: quotedMessageId(raw, { canonical: (jid) => this.identity.canonical(jid), ownId: this.identity.ownJid(), chatId: chatJid }) ?? null,
      status: fromMe && typeof raw.status === "number" ? raw.status : null,
      expiresAt,
      flags: this.flagsOf(raw, fromMe, keyId, chatJid),
    };
    return { input, raw };
  }

  /**
   * The flags a message is stored with: someone else's that mentions the
   * account (by number or lid), not in a story; the account's own that this
   * process sent. The database adds via_wazap for a confirmed send's key by itself.
   */
  private flagsOf(raw: WAMessage, fromMe: boolean, keyId: string, chatJid: string): number {
    if (fromMe) return this.sends.sentByWazap.has(keyId) ? MESSAGE_FLAGS.viaWazap : 0;
    if (chatJid === STATUS_JID) return 0;
    return mentionedJids(raw).some((jid) => this.identity.isMe(jid)) ? MESSAGE_FLAGS.mentionsMe : 0;
  }

  /** The flags backfill's detector: the mentions a stored message's protobuf carries. */
  private readonly storedFlags: FlagDetector = ({ raw, fromMe, chatJid }) => {
    if (fromMe || chatJid === STATUS_JID) return 0;
    let decoded: WAMessage;
    try {
      decoded = proto.WebMessageInfo.decode(raw) as WAMessage;
    } catch {
      return 0;
    }
    return mentionedJids(decoded).some((jid) => this.identity.isMe(jid)) ? MESSAGE_FLAGS.mentionsMe : 0;
  };

  /**
   * Flags for what was stored before this build set them, the last 14 days,
   * in the background once the account serves. Without the account's own
   * number no mention can be told apart, so it waits for a start that has it.
   */
  scheduleFlagsBackfill(db: AccountDb): void {
    if (this.host.stopped() || db.readOnly || this.identity.ownJid() === "") return;
    try {
      if (!db.messages.flagsBackfillPending()) return;
    } catch {
      return;
    }
    void db.messages.backfillFlags(this.storedFlags).catch((err: unknown) => {
      if (!this.host.stopped() && db.isOpen) logError("flags backfill", err);
    });
  }

  /** The sender the database files a message under; undefined for the other side of a direct chat. */
  private senderOf(raw: WAMessage, chatJid: string): string | null | undefined {
    if (raw.key.fromMe) return null;
    if (chatJid.endsWith("@s.whatsapp.net")) return undefined;
    const from = raw.key.participant || raw.participant || raw.key.remoteJid || "";
    if (!from) return null;
    const jid = this.identity.canonical(from);
    return chatKindOf(jid) === "direct" && !isNoiseJid(jid) ? jid : null;
  }

  /** Stores a message and what its protobuf already carries: the receipts of a synced message of the account's own. */
  storeRaw(raw: WAMessage, chatJid: string, live = false): UpsertResult | null {
    const prepared = this.messageInput(raw, chatJid);
    if (prepared === null) return null;
    const db = this.storage.db;
    const result = db.messages.upsert(prepared.input);
    if (result.sid !== null && (result.outcome === "inserted" || result.outcome === "updated")) {
      for (const receipt of raw.key.fromMe ? (raw.userReceipt ?? []) : []) {
        if (!receipt.userJid || this.identity.isMe(receipt.userJid)) continue;
        const moments = momentsOf(receipt);
        db.messages.receipt(result.sid, this.identity.canonical(receipt.userJid), {
          deliveredAt: moments.delivered ?? null,
          readAt: moments.read ?? null,
          playedAt: moments.played ?? null,
        });
      }
    }
    if (result.outcome === "inserted") {
      // A chat that only ever arrived as messages still lists after a clear, as it always did.
      const chat = db.identity.chat(chatJid);
      if (chat !== null && chat.proto === null && chat.kind !== "status") {
        const bytes = encodeChat({ id: chat.jid } as BaileysChat);
        if (bytes !== null) db.identity.upsertChat({ jid: chat.jid, proto: bytes });
      }
    }
    if (prepared.input.expiresAt !== null && prepared.input.expiresAt !== undefined) this.storage.armExpiry();
    if (result.outcome === "expired") void this.storage.sweepExpired();
    if (prepared.input.fromMe && result.sid !== null && this.kept(result)) {
      this.settleEcho(db, prepared.input.keyId, result.sid, chatJid, prepared.input.ts);
    }
    if (!prepared.input.fromMe && result.sid !== null && this.kept(result)) this.noteReadOnArrival(db, raw, result.sid, chatJid, live);
    return result;
  }

  /**
   * Someone else's message that arrives already read by the account's own
   * devices. Live (a notify), that is a receipt Baileys folded into the message
   * it was holding back: a one-to-one message's read status, or the account's
   * own member receipt on a group message. It moves the chat's read mark like
   * the receipt itself would. Anything else — a history sync, an append — is
   * only counted as `synced`: that the phone marks read in a sync only what was
   * read is not verified yet. Stories read nothing.
   */
  private noteReadOnArrival(db: AccountDb, raw: WAMessage, sid: string, chatJid: string, live: boolean): void {
    const kind = chatKindOf(chatJid);
    const readStatus = kind === "direct" && (raw.status === proto.WebMessageInfo.Status.READ || raw.status === proto.WebMessageInfo.Status.PLAYED);
    const readReceipt =
      kind === "group" &&
      (raw.userReceipt ?? []).some((receipt) => Boolean(receipt.userJid) && this.identity.isMe(receipt.userJid!) && Boolean(receipt.readTimestamp || receipt.playedTimestamp));
    if (!readStatus && !readReceipt) return;
    if (!live) {
      this.readSelf.synced++;
      return;
    }
    this.noteReadSelf(1);
    if (db.messages.markReadSelf(sid).moved) this.readSelf.applied++;
  }

  /** WhatsApp echoed the key of a send a confirm could not vouch for: that send arrived, as this message. */
  private settleEcho(db: AccountDb, keyId: string, sid: string, chatJid: string, ts: number): void {
    try {
      const row = db.sends.unknownByKey(keyId);
      if (row === null) return;
      db.messages.addFlags(sid, MESSAGE_FLAGS.viaWazap);
      this.host.drafts().settle(db.sends, row.draftId, {
        message_id: sid,
        chat_id: chatJid,
        text: frozenReceiptText(row),
        timestamp: isoWithOffset(ts),
      });
    } catch (err) {
      if (!this.host.stopped()) logError("send record", err);
    }
  }

  /** A new version of a stored message: an edit, or a new date; the row keeps its id and its place in time. */
  private writeVersion(next: WAMessage, stored: StoredMessage, editedAt: number | null): void {
    const prepared = this.messageInput(next, stored.chatJid);
    if (prepared === null) return;
    const { input } = prepared;
    this.storage.db.messages.upsert({ ...input, ts: stored.ts, editedAt, expiresAt: input.expiresAt ?? null });
  }

  /**
   * A story is a message on the status feed with its author as the sender. It
   * lists nowhere but read_messages on "status", wakes no wait, and goes after a day, as on
   * the phone; a revoked one leaves nothing behind.
   */
  private ingestStory(raw: WAMessage): void {
    if (raw.key.fromMe || isControlMessage(raw) || messageType(raw) === "system") return;
    const revoked = this.revokeTargets(raw);
    if (revoked.length) {
      this.retract(
        revoked.map((target) => ({ ...target, chatJid: STATUS_JID })),
        messageTimestampMs(raw)
      );
      return;
    }
    if (messageTimestampMs(raw) + STORY_TTL_MS <= Date.now()) return;
    this.learnPushName(raw, STATUS_JID);
    const result = this.storeRaw(raw, STATUS_JID);
    if (result !== null && this.kept(result)) this.host.noteInbound(false, messageTimestampMs(raw));
  }

  /**
   * A reaction is not a message in the chat, it is a mark on one: it goes onto
   * the target and is never filed on its own, whether it arrives live or in a
   * history sync. True when `raw` was a reaction.
   */
  applyReaction(raw: WAMessage, chatJid: string): boolean {
    const reaction = reactionOf(raw);
    if (!reaction) return false;
    const author = raw.key.fromMe ? this.identity.ownJid() : this.identity.canonical(raw.key.participant || raw.key.remoteJid || chatJid);
    const target = messageIdFor(reaction.targetKey, chatJid);
    if (author) this.react(target, author, reaction.text, messageTimestampMs(raw));
    return true;
  }

  /** One author's reaction, or its withdrawal (empty); the newer of two never loses to the older. */
  react(target: string, author: string, emoji: string, at: number): void {
    const db = this.storage.db;
    db.messages.react(target, author, emoji || null, this.plausibleTs(at));
  }

  /**
   * A vote on a poll, or a response to an event, is a mark on that message the
   * way a reaction is: once it can be read it goes onto the poll and is never
   * filed on its own. One that cannot be read yet — its poll is not stored, or
   * no spelling of the two jids opens it — stays a line of its own, and is
   * tried again when the poll arrives. True when `raw` was folded.
   */
  applyVote(raw: WAMessage, chatJid: string): boolean {
    const vote = voteOf(raw);
    if (!vote) return false;
    const target = this.voteTarget(vote, chatJid);
    if (!target) return false;
    const reading = readVote(vote, target.raw, this.voteSpellings(target.raw), this.voteSpellings(raw));
    if (!reading) return false;
    const voter = raw.key.fromMe
      ? this.identity.ownJid()
      : this.identity.canonical(raw.key.participant || raw.participant || raw.key.remoteJid || chatJid);
    // A withdrawal is kept as an empty choice, so an older vote arriving after it cannot bring it back.
    if (voter) this.storage.db.messages.vote(target.sid, voter, JSON.stringify(reading.choice), this.plausibleTs(vote.at));
    return true;
  }

  /**
   * The poll or event a vote points at, by its id, in the vote's chat under
   * every name that chat goes by: the voter's device may key the poll under a
   * lid where this account filed it under the number, or the other way round.
   */
  voteTarget(vote: EncryptedVote, chatJid: string): { sid: string; raw: WAMessage } | undefined {
    const remote = vote.targetKey.remoteJid;
    const chats = [chatJid, remote ? this.identity.canonical(remote) : "", this.identity.lids.phoneOf(chatJid), this.identity.lids.lidOf(chatJid)];
    const mine = Boolean(vote.targetKey.fromMe);
    const db = this.storage.db;
    for (const chat of new Set(chats)) {
      if (!chat) continue;
      for (const fromMe of [mine, !mine]) {
        const stored = db.messages.get(messageIdFor({ ...vote.targetKey, fromMe }, chat));
        const raw = stored === null ? null : this.views.rawOf(stored);
        if (raw && (vote.kind === "poll" ? pollOf(raw) !== undefined : isEvent(raw))) return { sid: stored!.sid, raw };
      }
    }
    return undefined;
  }

  /**
   * Every jid WhatsApp may have bound a vote to for the author of `raw`: the
   * ones its key carries, device dropped, each with the number or lid it pairs
   * with — ours in both forms when the message is our own. The order is fixed,
   * so every retry tries the same spellings the same way.
   */
  voteSpellings(raw: WAMessage): string[] {
    const key = raw.key;
    return this.identity.lids.spellings(
      key.fromMe
        ? [this.identity.ownJid(), this.host.sock()?.user?.id, this.host.sock()?.user?.lid]
        : [key.participant, key.participantAlt, raw.participant, key.remoteJid, key.remoteJidAlt]
    );
  }

  /** Votes and responses that arrived before their poll or event fold onto it the moment it lands. */
  private foldVotesOnto(raw: WAMessage, chatJid: string): void {
    if (pollOf(raw) === undefined && !isEvent(raw)) return;
    const db = this.storage.db;
    let walked = 0;
    for (let before: number | undefined; walked < EARLY_VOTE_SCAN; ) {
      const page = db.messages.chatPage(chatJid, { limit: 200, ...(before === undefined ? {} : { before }) });
      for (const waiting of page.items) {
        walked++;
        // A vote no poll could open is stored as the system line it reads as.
        if (waiting.type !== "system" || waiting.raw === null) continue;
        const vote = this.views.rawOf(waiting);
        if (vote === null || voteOf(vote)?.targetKey.id !== raw.key.id) continue;
        if (this.applyVote(vote, chatJid)) db.messages.delete(waiting.sid);
      }
      if (page.nextBefore === null) break;
      before = page.nextBefore;
    }
  }

  /**
   * One call can reach the account three ways: wazap's own tracker, the stub
   * baileys synthesises on a timeout, and WhatsApp's later call-log message.
   * Each carries a different id, so only nearness in time pairs them up, and
   * whichever says more about the call is the one kept; the other is deleted
   * for good, so a replay cannot bring the pair back.
   */
  keepOverEarlierCall(raw: WAMessage, chatJid: string): boolean {
    const info = callInfo(raw);
    if (!info) return true;
    const db = this.storage.db;
    const chat = db.identity.chat(chatJid);
    if (chat === null) return true;
    const at = this.plausibleTs(messageTimestampMs(raw));
    const sid = messageIdFor(raw.key, chat.jid);
    const nearby = db.messages.recent({ since: Math.max(1, at - CALL_DEDUPE_WINDOW_MS), until: at + CALL_DEDUPE_WINDOW_MS, limit: 200 });
    for (const known of nearby.items) {
      if (known.type !== "call" || known.chatJid !== chat.jid || known.sid === sid) continue;
      const other = this.views.rawOf(known);
      const otherInfo = other === null ? undefined : callInfo(other);
      if (other === null || !otherInfo) continue;
      // A redial inside the window is two calls, and wazap knows it built both.
      if (isTrackedCall(raw) && isTrackedCall(other)) continue;
      if (callDetail(raw, info) <= callDetail(other, otherInfo)) return false;
      db.messages.delete(known.sid);
      return true;
    }
    return true;
  }

  /** A live call goes in the way any message does, so everything downstream carries it. */
  storeCall(entry: CallEntry): void {
    this.host.handling("call", () => this.storage.db.transaction(() => this.ingestMessages([callMessage(entry)])), []);
  }

  /**
   * Only while a call is in flight: a call whose terminal event never arrives
   * would otherwise sit pending forever, and a timer with nothing to do would
   * otherwise keep ticking for the life of the process.
   */
  armCallSweep(): void {
    if (this.callSweepTimer || this.calls.pending === 0) return;
    this.callSweepTimer = setInterval(() => {
      for (const entry of this.calls.expire(Date.now())) this.storeCall(entry);
      if (this.calls.pending === 0) this.stopCallSweep();
    }, CALL_SWEEP_MS);
    this.callSweepTimer.unref();
  }

  stopCallSweep(): void {
    if (this.callSweepTimer) clearInterval(this.callSweepTimer);
    this.callSweepTimer = null;
  }

  /** The name a sender publishes, as WhatsApp attaches it to their messages; written only when it changed. */
  private learnPushName(raw: WAMessage, chatJid: string): void {
    const name = raw.pushName?.trim();
    if (!name || raw.key.fromMe) return;
    const sender = this.identity.canonical(raw.key.participant || raw.participant || chatJid);
    if (!sender || this.identity.isMe(sender) || isNoiseJid(sender) || chatKindOf(sender) !== "direct") return;
    const db = this.storage.db;
    if (db.identity.contact(sender)?.pushName === name) return;
    db.identity.upsertContact({ jid: sender, pushName: name });
  }

  /**
   * One fetch teaches every later message in that group who its participants
   * are, which matters most for a group whose members are strangers to the
   * address book.
   */
  learnGroup(meta: GroupMetadata): void {
    for (const p of meta.participants) {
      const lid = p.lid ?? (p.id.endsWith("@lid") ? p.id : undefined);
      const phone = p.phoneNumber ?? (p.id.endsWith("@s.whatsapp.net") ? p.id : undefined);
      if (lid && phone) this.identity.learnLid(lid, phone);
      const name = p.name ?? p.notify ?? p.username;
      if (name) this.ingestContact({ id: phone ?? p.id, ...(lid ? { lid } : {}), notify: name });
    }
  }
}
