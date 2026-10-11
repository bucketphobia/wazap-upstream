/**
 * Sending, for one account: drafts and their one confirm, every kind of
 * message that leaves (text, media, poll, location, forward), edits and
 * reactions, and the checks every send passes first. A draft goes out at
 * most once: the claim, the key fixed at draft time and the receipt stored
 * under it are all here. Part of WhatsAppService (src/whatsapp.ts), which
 * keeps the draft store and the write guard, where tests replace them, and
 * lends them through SendsHost.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  generateMessageIDV2,
  generateWAMessage,
  type AnyMessageContent,
  type MiscMessageGenerationOptions,
  type WAMessage,
  type WASocket,
} from "baileys";
import { MESSAGE_FLAGS, StorageError, type AccountDb, type ScheduledRecord, type SendRecord, type UpsertResult } from "../db/index.js";
import {
  draftExpired,
  draftNotFound,
  frozenReceiptText,
  frozenSchedule,
  receiptText,
  sendOutcomeUnknown,
  withMentionTokens,
  type Draft,
  type DraftPayload,
  type DraftSchedule,
  type DraftStore,
  type DraftView,
} from "../drafts.js";
import { asWazapError, WazapError } from "../errors.js";
import { isGroupId } from "../ids.js";
import { logError } from "../logger.js";
import { isoWithOffset, messageIdFor, messageText, messageTimestampMs } from "../messages.js";
import { asGifMedia, assertMediaSource, describe, loadMedia, mediaContent } from "../outgoing-media.js";
import { videoFrame } from "../previews.js";
import { SCHEDULE_MIN_AHEAD_MS } from "../schedule-time.js";
import type { EmbedFeed } from "../recall/index.js";
import { SentIds } from "../sent-ids.js";
import type { MediaSource, MessageView, OutgoingTarget, SentMessage } from "../wa-types.js";
import { isAdmin, type AccountGroups } from "./groups.js";
import type { AccountIdentity } from "./identity.js";
import type { MessageViews } from "./views.js";

const MAX_TEXT_CHARS = 65_536;

/** Scheduled messages one account may hold waiting, so a looping agent cannot queue a flood. */
export const SCHEDULE_MAX_PENDING = 100;

const EDIT_WINDOW_MS = 15 * 60_000;

/** Unknown sends checked against the stored messages when the database opens. */
const SEND_RECOVERY_LIMIT = 500;

/**
 * One confirm of a draft: the key it goes out under, and whether the send got
 * as far as handing it to the socket. Before that a failure is definite; after
 * it, WhatsApp may have the message.
 */
export interface SendAttempt {
  readonly keyId: string;
  dispatched: boolean;
  /** A scheduled send: nothing is handed to WhatsApp after this (epoch ms), however long building it took. */
  readonly notAfter?: number;
}

/** A number whose WhatsApp lookup got no answer: not a verdict on the number, so NOT_CONNECTED, which a caller may retry. */
function lookupFailed(jid: string, reason: string): WazapError {
  return new WazapError(
    "NOT_CONNECTED",
    `Could not check whether ${jid} has WhatsApp: ${reason}`,
    "Call get_status, wait, retry"
  );
}

/** What the service lends the sends: its state, its guards, the draft store and where a sent message is filed, read at each call. */
export interface SendsHost {
  db(): AccountDb;
  readyDb(): AccountDb | null;
  stopped(): boolean;
  /** The draft store: the service's, so a test can give it its own clock. */
  drafts(): DraftStore;
  guarded<T>(work: () => Promise<T>): Promise<T>;
  ensureConnected(): WASocket;
  /** The socket for a write: connected, not read-only, within the rate limit. */
  beginWrite(): WASocket;
  getMessage(messageId: string): Promise<MessageView>;
  hasChat(jid: string): boolean;
  /** Runs work that must not take the caller down; a failure is logged, and answers fallback. */
  handling<T>(what: string, work: () => T, fallback: T): T;
  storeRaw(raw: WAMessage, chatJid: string, live?: boolean): UpsertResult | null;
  kept(result: UpsertResult): boolean;
  embedFeed(): EmbedFeed | null;
  /** Whether the account keeps its history between runs (WAZAP_PERSIST_HISTORY). */
  keepsHistory(): boolean;
  /** Throws ACCOUNT_RESTRICTED when WhatsApp forbids this account a first message to `jid` right now. */
  refuseNewChat(jid: string, sock: WASocket): Promise<void>;
}

export class AccountSends {
  /** Confirms under way, by draft: a second confirm of the same draft by its owner waits for the first. */
  private readonly confirming = new Map<string, { owner: string | null; work: Promise<SentMessage> }>();
  /** Sends of our own, so their `fromMe` echo is never announced as `message_sent`. */
  readonly sentByWazap = new SentIds();

  constructor(
    private readonly host: SendsHost,
    private readonly identity: AccountIdentity,
    private readonly views: MessageViews,
    private readonly groups: AccountGroups
  ) {}

  draft(payload: DraftPayload, owner?: string, schedule?: DraftSchedule): Promise<DraftView> {
    return this.host.guarded(async () => {
      if (payload.kind === "media") await assertMediaSource(payload.source);
      if (schedule !== undefined) payload = await this.schedulable(payload);
      const sock = this.host.ensureConnected();
      const jid = await this.assertOutgoing(payload.chatId, sock);
      let stored: DraftPayload = { ...payload, chatId: jid };
      if (payload.kind === "forward") {
        this.views.contentOrThrow(payload.messageId);
        stored = { ...payload, chatId: jid, text: (await this.host.getMessage(payload.messageId)).text };
      } else if (payload.kind === "text" && payload.mentionIds?.length) {
        // Mentions resolve here, and the text gains each @<user> it lacks, so the
        // preview is the text that leaves and each token matches its mentionedJid.
        const mentionIds = payload.mentionIds.map((id) => this.identity.resolveId(id));
        stored = { ...payload, chatId: jid, mentionIds, text: withMentionTokens(payload.text, mentionIds) };
      }
      // The key is fixed now, so a confirm whose outcome is lost can still be recognised by it.
      const keyId = generateMessageIDV2(this.identity.ownJid());
      return this.host
        .drafts()
        .view(this.host.drafts().put(this.host.db().sends, this.outgoingOf(jid), stored, keyId, owner ?? null, schedule));
    });
  }

  /**
   * What a draft for later must hold so the message that leaves is the one the
   * user approved: a URL is refused (its bytes are whoever serves it then), a
   * file is pinned by its SHA-256, and a reply or a forward needs an account
   * that keeps the message it names until then.
   */
  private async schedulable(payload: DraftPayload): Promise<DraftPayload> {
    if ((payload.kind === "forward" || (payload.kind === "text" && payload.replyTo !== undefined)) && !this.host.keepsHistory()) {
      throw new WazapError(
        "INVALID_TIME",
        "This account keeps no history between runs, so the message a scheduled reply or forward names would be gone by then.",
        "Send it now without send_at, or schedule a plain message"
      );
    }
    if (payload.kind !== "media") return payload;
    if (payload.source.url !== undefined) {
      throw new WazapError(
        "INVALID_TIME",
        "A scheduled message cannot take media from a URL: what the URL serves when it goes may not be what was approved.",
        "Download it and pass file_path, or send it now without send_at"
      );
    }
    const digest = createHash("sha256").update(await readFile(payload.source.file_path!)).digest("hex");
    return { ...payload, sha256: digest };
  }

  /**
   * Sends a draft at most once. The claim is atomic, so a concurrent confirm by
   * the same owner waits for the first and answers the same; a later one gets
   * the stored receipt. A failure before the draft's key reached the socket
   * gives the draft back, with the code that failure had; one after it leaves
   * the send unknown (SEND_OUTCOME_UNKNOWN) until WhatsApp echoes the key.
   */
  confirm(draftId: string, owner?: string, { scheduled = false, notAfter }: { scheduled?: boolean; notAfter?: number } = {}): Promise<SentMessage> {
    return this.host.guarded(async () => {
      const who = owner ?? null;
      const running = this.confirming.get(draftId);
      if (running !== undefined && running.owner === who) return running.work;
      // A draft the user approved for later never goes now: only the scheduler's own confirm sends one.
      const row = scheduled ? null : this.host.db().sends.get(draftId);
      if (row !== null && row.state === "draft" && row.owner === who && frozenSchedule(row) !== undefined) {
        throw new WazapError(
          "INVALID_ID",
          `Draft ${draftId} is scheduled for later; nothing was sent.`,
          "confirm_send schedules it: call confirm_send with this draft_id through the tool, never a direct send"
        );
      }
      const claim = this.host.drafts().claim(this.host.db().sends, draftId, who);
      if (claim.state === "sent") return claim.receipt;
      const work = this.sendClaimed(claim.draft, notAfter);
      this.confirming.set(draftId, { owner: who, work });
      try {
        return await work;
      } finally {
        this.confirming.delete(draftId);
      }
    });
  }

  /**
   * The owner's yes to a draft made with a schedule: the draft becomes a
   * scheduled message, at most once. A repeated yes answers the same one; a
   * draft that is missing, lapsed or another identity's answers as a confirm
   * would, and one whose time has come or passed meanwhile is refused, not
   * sent, since the yes was to that time.
   */
  scheduleDraft(draftId: string, owner: string | undefined, now: number = Date.now()): Promise<{ record: ScheduledRecord; already: boolean }> {
    return this.host.guarded(async () => {
      const who = owner ?? null;
      const db = this.host.db();
      const existing = db.schedule.scheduledByDraft(draftId);
      if (existing !== null) {
        if (existing.owner !== who) throw draftNotFound(draftId);
        return { record: existing, already: true };
      }
      const row = db.sends.get(draftId);
      if (row === null || row.owner !== who || row.state !== "draft") throw draftNotFound(draftId);
      const schedule = frozenSchedule(row);
      if (schedule === undefined) {
        throw new WazapError("INVALID_ID", `Draft ${draftId} carries no send_at; nothing was scheduled.`, "Confirm it with confirm_send to send it now");
      }
      if (row.expiresAt <= now) {
        db.sends.removeDraft(draftId);
        throw draftExpired(draftId);
      }
      if (schedule.at < now + SCHEDULE_MIN_AHEAD_MS) {
        throw new WazapError(
          "INVALID_TIME",
          `The time draft ${draftId} was scheduled for has come or passed while it waited for a yes; nothing was scheduled or sent.`,
          "Ask the user for a new time, draft again with that send_at, show the new preview and wait for a yes"
        );
      }
      let record: ScheduledRecord | null;
      try {
        record = db.schedule.adopt(
          { id: `s_${randomUUID().replaceAll("-", "").slice(0, 16)}`, draftId, owner: who, sendAt: schedule.at, timeZone: schedule.zone, now },
          SCHEDULE_MAX_PENDING
        );
      } catch (err) {
        if (err instanceof StorageError && err.code === "SCHEDULE_FULL") {
          throw new WazapError("SCHEDULE_FULL", err.message, "Tell the user; cancel scheduled messages they no longer want, or wait for some to go");
        }
        throw err;
      }
      if (record === null) throw draftNotFound(draftId);
      return { record, already: false };
    });
  }

  private async sendClaimed(draft: Draft, notAfter?: number): Promise<SentMessage> {
    const attempt: SendAttempt = { keyId: draft.keyId, dispatched: false, ...(notAfter === undefined ? {} : { notAfter }) };
    let sent: SentMessage;
    try {
      sent = await this.dispatchDraft(draft, attempt);
    } catch (err) {
      if (!attempt.dispatched) {
        this.recordSend(() => this.host.drafts().release(this.host.db().sends, draft.id));
        throw err;
      }
      // WhatsApp may have the message now: no error from here on, a stop
      // closing the database included, may answer as if nothing was sent.
      const echoed = this.echoedReceipt(draft);
      if (echoed !== null) {
        this.recordSend(() => this.host.drafts().settle(this.host.db().sends, draft.id, echoed));
        return echoed;
      }
      const cause = asWazapError(err);
      this.recordSend(() => this.host.drafts().unsettle(this.host.db().sends, draft.id, cause.code));
      throw sendOutcomeUnknown(draft.id, cause.message);
    }
    this.recordSend(() => this.host.drafts().settle(this.host.db().sends, draft.id, sent));
    return sent;
  }

  /**
   * A send's bookkeeping must not change what the caller is told: the send
   * happened or it did not. A database that refuses (stopping, disk full)
   * leaves the row as it was; a row left sending is unknown after a restart.
   */
  private recordSend(work: () => void): void {
    try {
      work();
    } catch (err) {
      if (!this.host.stopped()) logError("send record", err);
    }
  }

  /** storedReceipt of a draft that reached the socket, through a database that may be closing: null when it cannot tell. */
  private echoedReceipt(draft: Draft): SentMessage | null {
    const db = this.host.readyDb();
    if (db === null) return null;
    try {
      return this.storedReceipt(db, draft.to.chat_id, draft.keyId, receiptText(draft.payload));
    } catch {
      return null;
    }
  }

  /**
   * The receipt of a send whose message is stored under its key, which only
   * the send itself or WhatsApp's echo of it stores: the id and time WhatsApp gave it.
   */
  private storedReceipt(db: AccountDb, chatJid: string, keyId: string, text: string): SentMessage | null {
    const stored = db.messages.get(messageIdFor({ remoteJid: chatJid, fromMe: true, id: keyId }, chatJid));
    if (stored === null || !stored.fromMe || stored.keyId !== keyId) return null;
    return { message_id: stored.sid, chat_id: stored.chatJid, text, timestamp: isoWithOffset(stored.ts) };
  }

  /**
   * What a stop or a crash cut short: a send left under way is unknown, or
   * sent when its message is stored under its key. Runs when the database
   * opens, before any confirm can claim a row.
   */
  recoverSends(db: AccountDb): void {
    try {
      this.host.drafts().recover(db.sends);
      for (const row of db.sends.unknown(SEND_RECOVERY_LIMIT)) this.reconcileSend(db, row);
    } catch (err) {
      logError("send record", err);
    }
  }

  /** An unknown send whose message is stored is sent. */
  private reconcileSend(db: AccountDb, row: SendRecord): void {
    const receipt = this.storedReceipt(db, row.chatJid, row.keyId, frozenReceiptText(row));
    if (receipt === null) return;
    db.messages.addFlags(receipt.message_id, MESSAGE_FLAGS.viaWazap);
    this.host.drafts().settle(db.sends, row.draftId, receipt);
  }

  /** `attempt` is confirm_send's: the send goes out under the draft's key, and says when it left. */
  sendMessage(
    chatId: string,
    text: string,
    replyTo?: string,
    mentionIds?: string[],
    attempt?: SendAttempt
  ): Promise<SentMessage> {
    return this.host.guarded(async () => {
      if (text.length > MAX_TEXT_CHARS) {
        throw new WazapError(
          "TEXT_TOO_LONG",
          `The text is ${text.length} characters; WhatsApp allows ${MAX_TEXT_CHARS}.`
        );
      }
      const { sock, jid } = await this.prepareSend(chatId);
      const mentions = (mentionIds ?? []).map((id) => this.identity.resolveId(id));
      const quoted = replyTo === undefined ? undefined : this.views.contentOrThrow(replyTo);
      const sent = await this.dispatch(
        sock,
        jid,
        // No link previews: an explicit null keeps Baileys from fetching the page itself.
        { text, linkPreview: null, ...(mentions.length > 0 ? { mentions } : {}) },
        quoted ? { quoted } : {},
        attempt
      );
      return this.sentResult(sent, jid, text);
    });
  }

  sendMedia(
    chatId: string,
    source: MediaSource,
    opts: { caption?: string; asDocument: boolean; asVoice: boolean; asGif: boolean; sha256?: string },
    attempt?: SendAttempt
  ): Promise<SentMessage> {
    return this.host.guarded(async () => {
      const { sock, jid } = await this.prepareSend(chatId);
      const loaded = await loadMedia(source);
      if (opts.sha256 !== undefined && createHash("sha256").update(loaded.buffer).digest("hex") !== opts.sha256) {
        throw new WazapError(
          "FILE_NOT_FOUND",
          `The file at "${source.file_path ?? ""}" changed since the scheduled message was approved; nothing was sent.`,
          "Tell the user; schedule it again with the file as it is now if they want it"
        );
      }
      const media = await asGifMedia(loaded, opts.asGif);
      const content = mediaContent(media, opts);
      if ("video" in content) {
        // Do not fall back to Baileys's unrestricted, shell-spawned ffmpeg.
        // Even an empty thumbnail suppresses its implicit decoder invocation.
        content.jpegThumbnail = (await videoFrame(media.buffer, 32))?.toString("base64") ?? "";
      }
      const sent = await this.dispatch(sock, jid, content, {}, attempt);
      // The receipt names the caption only when it went: audio (a URL that named no type) carries none.
      const caption = (content as { caption?: string }).caption;
      return this.sentResult(sent, jid, caption ?? `[${media.mimetype}]`);
    });
  }

  sendPoll(
    chatId: string,
    question: string,
    options: string[],
    multiSelect: boolean,
    attempt?: SendAttempt
  ): Promise<SentMessage> {
    return this.host.guarded(async () => {
      const { sock, jid } = await this.prepareSend(chatId);
      const sent = await this.dispatch(
        sock,
        jid,
        { poll: { name: question, values: options, selectableCount: multiSelect ? options.length : 1 } },
        {},
        attempt
      );
      return this.sentResult(sent, jid, `[poll] ${question}`);
    });
  }

  sendLocation(
    chatId: string,
    latitude: number,
    longitude: number,
    name?: string,
    address?: string,
    attempt?: SendAttempt
  ): Promise<SentMessage> {
    return this.host.guarded(async () => {
      const { sock, jid } = await this.prepareSend(chatId);
      const sent = await this.dispatch(
        sock,
        jid,
        { location: { degreesLatitude: latitude, degreesLongitude: longitude, name, address } },
        {},
        attempt
      );
      return this.sentResult(sent, jid, `[location] ${name ?? `${latitude}, ${longitude}`}`);
    });
  }

  editMessage(messageId: string, text: string): Promise<SentMessage> {
    return this.host.guarded(async () => {
      if (text.length > MAX_TEXT_CHARS) {
        throw new WazapError(
          "TEXT_TOO_LONG",
          `The text is ${text.length} characters; WhatsApp allows ${MAX_TEXT_CHARS}.`
        );
      }
      const raw = this.views.messageOrThrow(messageId);
      if (!raw.key.fromMe) {
        throw new WazapError("NOT_OWN_MESSAGE", `Message ${messageId} was not sent by the linked account.`);
      }
      const age = Date.now() - messageTimestampMs(raw);
      if (age > EDIT_WINDOW_MS) {
        throw new WazapError("EDIT_WINDOW_EXPIRED", `Message ${messageId} is older than 15 minutes.`);
      }
      const { sock, jid } = await this.prepareSend(this.views.chatOfOrThrow(messageId));
      this.views.messageOrThrow(messageId);
      // No link previews: an explicit null keeps Baileys from fetching the page itself.
      await sock.sendMessage(jid, { text, edit: raw.key, linkPreview: null });
      return { message_id: messageId, chat_id: jid, text, timestamp: isoWithOffset(Date.now()) };
    });
  }

  reactToMessage(messageId: string, emoji: string): Promise<{ message_id: string; emoji: string }> {
    return this.host.guarded(async () => {
      const raw = this.views.messageOrThrow(messageId);
      const { sock, jid } = await this.prepareSend(this.views.chatOfOrThrow(messageId));
      this.views.messageOrThrow(messageId);
      await sock.sendMessage(jid, { react: { text: emoji, key: raw.key } });
      return { message_id: messageId, emoji };
    });
  }

  forwardMessage(messageId: string, toChatId: string, attempt?: SendAttempt): Promise<SentMessage> {
    return this.host.guarded(async () => {
      const raw = this.views.contentOrThrow(messageId);
      const { sock, jid } = await this.prepareSend(toChatId);
      this.views.contentOrThrow(messageId);
      const sent = await this.dispatch(sock, jid, { forward: raw }, {}, attempt);
      return this.sentResult(sent, jid, messageText(raw));
    });
  }

  private outgoingOf(jid: string): OutgoingTarget {
    const name = this.identity.displayName(jid);
    if (isGroupId(jid)) return { chat_id: jid, name };
    const number = this.views.contactSummary(jid).number;
    return number ? { chat_id: jid, name, number } : { chat_id: jid, name };
  }

  private dispatchDraft(draft: Draft, attempt: SendAttempt): Promise<SentMessage> {
    const chatId = draft.to.chat_id;
    const payload = draft.payload;
    switch (payload.kind) {
      case "text":
        return this.sendMessage(chatId, payload.text, payload.replyTo, payload.mentionIds, attempt);
      case "media":
        return this.sendMedia(
          chatId,
          payload.source,
          {
            caption: payload.caption,
            asDocument: payload.asDocument,
            asVoice: payload.asVoice,
            asGif: payload.asGif,
            ...(payload.sha256 === undefined ? {} : { sha256: payload.sha256 }),
          },
          attempt
        );
      case "poll":
        return this.sendPoll(chatId, payload.question, payload.options, payload.multiSelect, attempt);
      case "location":
        return this.sendLocation(chatId, payload.latitude, payload.longitude, payload.name, payload.address, attempt);
      case "forward":
        return this.forwardMessage(payload.messageId, chatId, attempt);
      default: {
        const _exhaustive: never = payload;
        return _exhaustive;
      }
    }
  }

  /**
   * Hands a message to Baileys. A confirmed draft does in two steps what
   * sendMessage does in one, so the moment it may reach WhatsApp is known:
   * building the message (uploading its media on the way) writes nothing to
   * WhatsApp, and a failure there leaves the draft unsent. The relay is where
   * it goes out, under the key it was drafted with; it is marked as handed
   * over first, so whatever fails from there on leaves the outcome unknown.
   */
  private async dispatch(
    sock: WASocket,
    jid: string,
    content: AnyMessageContent,
    options: MiscMessageGenerationOptions,
    attempt: SendAttempt | undefined
  ): Promise<WAMessage | undefined> {
    if (attempt === undefined) return sock.sendMessage(jid, content, options);
    const built = await generateWAMessage(jid, content, {
      ...options,
      userJid: sock.user?.id ?? this.identity.ownJid(),
      upload: sock.waUploadToServer,
      messageId: attempt.keyId,
    });
    if (!built.message) throw new WazapError("WHATSAPP_ERROR", "Baileys built an empty message.");
    if (attempt.notAfter !== undefined && Date.now() > attempt.notAfter) {
      // A scheduled message whose window closed while it was being built (a slow upload): not sent late.
      throw new WazapError("TIMEOUT", "Its time window closed while the message was being prepared; nothing was sent.");
    }
    attempt.dispatched = true;
    await sock.relayMessage(jid, built.message, {
      messageId: attempt.keyId,
      // What sendMessage adds for a poll, so it arrives as one.
      ...("poll" in content ? { additionalNodes: [{ tag: "meta", attrs: { polltype: "creation" } }] } : {}),
    });
    return built;
  }

  /** The single gate every send path passes: writability, addressability, announce-only. */
  async prepareSend(chatId: string): Promise<{ sock: WASocket; jid: string }> {
    const sock = this.host.beginWrite();
    const jid = await this.assertOutgoing(chatId, sock);
    return { sock, jid };
  }

  /**
   * Same addressability checks as a send, without opening a write. A draft that
   * fails here would fail at confirm_send too.
   */
  private async assertOutgoing(chatId: string, sock: WASocket): Promise<string> {
    const jid = this.identity.resolveId(chatId);

    if (isGroupId(jid)) {
      const meta = await this.groups.groupMeta(jid);
      const mine = this.groups.myParticipation(meta);
      if (meta.announce && !(mine && isAdmin(mine))) {
        throw new WazapError("GROUP_ANNOUNCEMENT_ONLY", `Only admins may post in "${meta.subject}".`);
      }
      return jid;
    }

    // Before the lookup: under a reachout timelock even asking about a stranger is not worth it.
    await this.host.refuseNewChat(jid, sock);
    const db = this.host.db();
    if (!this.host.hasChat(jid) && db.identity.contact(jid) === null) {
      // Only an answer says a number has no WhatsApp; a lookup that got none
      // (a timeout, a dropped socket) is a link problem, and a consumer may retry it.
      let found: Awaited<ReturnType<WASocket["onWhatsApp"]>>;
      try {
        found = await sock.onWhatsApp(jid);
      } catch (err) {
        throw lookupFailed(jid, describe(err));
      }
      if (found === undefined) throw lookupFailed(jid, "WhatsApp gave no answer");
      if (!found.some((entry) => entry.exists)) {
        throw new WazapError("NOT_ON_WHATSAPP", `${jid} has no WhatsApp account.`);
      }
    }
    return jid;
  }

  /**
   * A key wazap sent under: noted by a send in this process, or recorded by a
   * confirmed draft, which a restart does not forget.
   */
  isOwnSend(keyId: string): boolean {
    if (this.sentByWazap.has(keyId)) return true;
    try {
      return this.host.readyDb()?.sends.hasKey(keyId) ?? false;
    } catch {
      return false;
    }
  }

  private sentResult(sent: WAMessage | undefined, jid: string, text: string): SentMessage {
    if (!sent) {
      return { message_id: `unknown_${jid}_${randomUUID()}`, chat_id: jid, text, timestamp: isoWithOffset(Date.now()) };
    }
    if (!sent.key.remoteJid) sent = { ...sent, key: { ...sent.key, remoteJid: jid } };
    const sid = messageIdFor(sent.key, jid);
    if (!this.host.stopped()) {
      if (sent.key.id) this.sentByWazap.note(sent.key.id);
      // Stored now, so the reply can be quoted at once; Baileys' echo lands on the same row.
      this.host.handling(
        "sent message",
        () => {
          const result = this.host.storeRaw(sent, jid);
          if (result !== null && this.host.kept(result)) this.host.embedFeed()?.kick();
        },
        undefined
      );
    }
    return { message_id: sid, chat_id: jid, text, timestamp: isoWithOffset(messageTimestampMs(sent)) };
  }
}
