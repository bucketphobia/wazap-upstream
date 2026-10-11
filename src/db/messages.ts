/**
 * Messages and everything hanging off them: the upsert with its barriers,
 * tombstones, expiry, clearing and deleting chats, reactions, votes,
 * receipts, derived media files, and the reads the tools page through.
 *
 * The barriers, in the order a write meets them:
 * 1. a tombstone is final — no upsert touches a deleted row again;
 * 2. a chat cleared through T refuses every message at or before T;
 * 3. an expiry only ever moves earlier, and a message past it is stored as a
 *    tombstone so a replay without the ephemeral marker cannot revive it;
 * 4. an older version never overwrites a newer stored edit.
 */
import { performance } from "node:perf_hooks";
import type { Connection } from "./connection.js";
import { StorageError } from "./errors.js";
import { checkInstant, checkTimestamp, firstIdOfSecond, idLowerBound, idUpperBound, SEQ_SPAN } from "./ids.js";
import { parseSid, sidOf, type Identity, type MessageKey } from "./identity.js";
import {
  chatFromRow,
  MESSAGE_COLUMNS,
  MESSAGE_FROM,
  messageFromRow,
  RECOMPUTE_LAST,
  transcriptInfoJson,
  VISIBLE,
  type ChatRow,
  type MessageRow,
} from "./rows.js";
import { styleOf, type StyleStats } from "./style.js";
import { MESSAGE_FLAGS } from "./types.js";
import type {
  BulkDeleteResult,
  ChatCursor,
  ChatKind,
  ChatListItem,
  ChatRecord,
  Coverage,
  DeleteResult,
  MediaRecord,
  MessageInput,
  TranscriptInfo,
  Page,
  Reaction,
  Receipt,
  StoredMessage,
  UpsertResult,
  Vote,
  WaitingCandidate,
} from "./types.js";

/**
 * Removes the embedded copy of a quoted message from a quoting message's
 * protobuf. The storage layer does not parse protobuf; the service supplies
 * this, and a retraction then scrubs every quote of the retracted message.
 */
export type ScrubQuote = (raw: Uint8Array, quotedSid: string) => Uint8Array | null;

const MAX_PAGE = 1_000;
/** How far back styleFor reads the user's own messages, and how many it needs in a chat before it reads the account instead. */
const STYLE_DAYS = 90;
const STYLE_MIN_OWN = 5;
const STYLE_SAMPLE = 200;
const STYLE_ACCOUNT_SAMPLE = 500;

/** One message of recentExchange. */
export interface RecentExchangeItem {
  id: number;
  sid: string;
  fromMe: boolean;
  senderJid: string | null;
  ts: number;
  type: string;
  /** The words, the transcript of a voice note, or the stored placeholder; cut to maxChars with an ellipsis. */
  text: string;
  /** The text is a voice note's transcript. */
  transcribed: boolean;
  truncated: boolean;
}

/** The meta row saying before when via_wazap is incomplete: an epoch ms, or `migrated_v5` for the migration's time. */
const VIA_WAZAP_KNOWN_META = "via_wazap_known_after";
/**
 * The key shapes Baileys gives the messages it sends ("3EB0…", and "BAE5…"
 * in older releases). Before via_wazap is known, only an own message under
 * another shape — written on the phone — is surely the user's own words.
 */
const BAILEYS_KEY_SQL = "(m.key_id LIKE '3EB0%' OR m.key_id LIKE 'BAE5%')";

/** The meta row holding the descending id cursor of the flags backfill. */
export const FLAGS_BACKFILL_META = "flags_backfill_before";
/** How far back the flags backfill reaches: what catch_up and the draft context ever read. */
export const FLAGS_BACKFILL_WINDOW_MS = 14 * 86_400_000;

/**
 * The flags one stored message's protobuf carries, for backfillFlags: the
 * service decodes, the storage layer does not parse protobuf.
 */
export type FlagDetector = (message: { raw: Uint8Array; fromMe: boolean; type: string; chatJid: string }) => number;
/** A message's public sid in SQL, over the canonical jid of the chat it reads as part of; needs `m`, `c` and `ck`. */
const SID_EXPR = `(CASE WHEN m.from_me = 1 THEN 'true' ELSE 'false' END) || '_' || coalesce(ck.jid, c.jid) || '_' || m.key_id`;
const NO_UPPER_BOUND = Number.MAX_SAFE_INTEGER;

/**
 * The single upsert. On a key conflict the row keeps its id, and content only
 * moves when the incoming version is not older than the stored edit; status
 * only rises (in statusRank's order), expiry only falls, a transcript or
 * sender is never erased. A tombstone matches no update at all.
 */
const FRESH = "(messages.edited_at IS NULL OR (excluded.edited_at IS NOT NULL AND excluded.edited_at >= messages.edited_at))";

/**
 * A delivery status's place in the order it only climbs through: WhatsApp's
 * number, except ERROR (0), which can only follow a send still PENDING (1) and
 * so outranks that and nothing the server confirmed.
 */
export function statusRank(status: number): number {
  return status === 0 ? 1.5 : status;
}
const rank = (column: string): string => `(CASE WHEN ${column} = 0 THEN 1.5 ELSE ${column} END)`;
/**
 * The bits a write carries, and via_wazap whenever the account's own message
 * is filed under the key of a send wazap let go of in the last 90 days
 * (sent_keys), whoever stores it: the send itself, WhatsApp's echo, a history
 * sync, after a restart or not, after the send's own row is gone.
 */
const FLAGS_EXPR = `(:flags | CASE WHEN :from_me = 1 AND EXISTS (SELECT 1 FROM sent_keys WHERE key_id = :key_id)
  THEN ${MESSAGE_FLAGS.viaWazap} ELSE 0 END)`;
/**
 * The newest stored_seq handed out: the highest a row holds, or the one a
 * physical delete took with it (meta stored_seq_high), 0 before any. Off the
 * messages_stored index, a single descent.
 */
export const STORED_SEQ_TOP = `max(
  coalesce((SELECT stored_seq FROM messages INDEXED BY messages_stored WHERE stored_seq IS NOT NULL ORDER BY stored_seq DESC LIMIT 1), 0),
  coalesce((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'stored_seq_high'), 0))`;
/** The stored_seq a message stored now takes: one past every one handed out. */
const NEXT_STORED_SEQ = `(${STORED_SEQ_TOP} + 1)`;
const UPSERT_SQL = `
INSERT INTO messages(id, chat_id, key_id, from_me, sender_id, ts, type, quoted_sid, quoted_from_me, quoted_key_id, status,
  edited_at, expires_at, text, transcript, transcript_info, raw, flags, stored_seq)
VALUES (:id, :chat_id, :key_id, :from_me, :sender_id, :ts, :type, :quoted_sid, :quoted_from_me, :quoted_key_id, :status,
  :edited_at, :expires_at, :text, :transcript, :transcript_info, :raw, ${FLAGS_EXPR}, ${NEXT_STORED_SEQ})
ON CONFLICT(chat_id, from_me, key_id) DO UPDATE SET
  flags = messages.flags | excluded.flags,
  -- A stub standing in for a message (one that could not be decrypted) replaced by it: the message reaches the account now.
  stored_seq = CASE WHEN ${FRESH} AND messages.type = 'system' AND excluded.type <> 'system' THEN excluded.stored_seq
    ELSE messages.stored_seq END,
  type = CASE WHEN ${FRESH} THEN excluded.type ELSE messages.type END,
  text = CASE WHEN ${FRESH} THEN coalesce(excluded.text, messages.text) ELSE messages.text END,
  raw = CASE WHEN ${FRESH} THEN coalesce(excluded.raw, messages.raw) ELSE messages.raw END,
  quoted_sid = CASE WHEN ${FRESH} THEN coalesce(excluded.quoted_sid, messages.quoted_sid) ELSE messages.quoted_sid END,
  quoted_from_me = CASE WHEN ${FRESH} AND excluded.quoted_key_id IS NOT NULL THEN excluded.quoted_from_me
    ELSE messages.quoted_from_me END,
  quoted_key_id = CASE WHEN ${FRESH} THEN coalesce(excluded.quoted_key_id, messages.quoted_key_id) ELSE messages.quoted_key_id END,
  edited_at = CASE WHEN ${FRESH} THEN coalesce(excluded.edited_at, messages.edited_at) ELSE messages.edited_at END,
  transcript = coalesce(excluded.transcript, messages.transcript),
  transcript_info = CASE WHEN excluded.transcript IS NULL THEN messages.transcript_info
    WHEN excluded.transcript_info IS NOT NULL THEN excluded.transcript_info
    WHEN excluded.transcript IS messages.transcript THEN messages.transcript_info ELSE NULL END,
  sender_id = coalesce(messages.sender_id, excluded.sender_id),
  status = CASE WHEN excluded.status IS NULL THEN messages.status WHEN messages.status IS NULL THEN excluded.status
    WHEN ${rank("excluded.status")} > ${rank("messages.status")} THEN excluded.status ELSE messages.status END,
  expires_at = CASE WHEN excluded.expires_at IS NULL THEN messages.expires_at WHEN messages.expires_at IS NULL
    THEN excluded.expires_at ELSE min(messages.expires_at, excluded.expires_at) END
WHERE messages.deleted_at IS NULL`;

/** The quoted message's direction and key, parsed once; a quote is matched by these, never by spelling. */
function quoteColumns(quotedSid: string | null): { quoted_sid: string | null; quoted_from_me: number | null; quoted_key_id: string | null } {
  const parsed = quotedSid === null ? null : parseSid(quotedSid);
  return {
    quoted_sid: quotedSid,
    quoted_from_me: parsed === null || parsed.fromMe === null ? null : parsed.fromMe ? 1 : 0,
    quoted_key_id: parsed?.keyId ?? null,
  };
}

/** Flag bits as stored: a non-negative integer, anything else is none. */
function flagBits(flags: number | undefined): number {
  return typeof flags === "number" && Number.isSafeInteger(flags) && flags > 0 ? flags : 0;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return MAX_PAGE;
  return Math.min(MAX_PAGE, Math.max(1, Math.floor(limit)));
}

function earliest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function pageOf(items: StoredMessage[], limit: number): Page<StoredMessage> {
  const hasMore = items.length > limit;
  const kept = hasMore ? items.slice(0, limit) : items;
  return { items: kept, hasMore, nextBefore: hasMore ? kept[kept.length - 1]!.id : null };
}

function idsJson(ids: readonly number[]): string {
  return JSON.stringify(ids);
}

/** `m.chat_id` against one chat, or against a chat and the chats still folding into it. */
export function chatCondition(ids: readonly number[]): { sql: string; params: Array<number | string> } {
  return ids.length === 1
    ? { sql: "m.chat_id = ?", params: [ids[0]!] }
    : { sql: "m.chat_id IN (SELECT value FROM json_each(?))", params: [JSON.stringify(ids)] };
}

/**
 * While a chat folds into another, one message can sit under both spellings.
 * A page lists it once, from the chat it folds into, and not at all when
 * either copy is a tombstone — as get() answers for it. Empty for a chat
 * with nothing folding into it.
 */
function foldTwinCondition(family: readonly number[], canonicalId: number): { sql: string; params: Array<number | string> } {
  if (family.length <= 1) return { sql: "", params: [] };
  return {
    sql: `AND NOT EXISTS (SELECT 1 FROM messages t WHERE t.chat_id IN (SELECT value FROM json_each(?)) AND t.chat_id <> m.chat_id
            AND t.from_me = m.from_me AND t.key_id = m.key_id AND (t.deleted_at IS NOT NULL OR t.chat_id = ?))`,
    params: [JSON.stringify(family), canonicalId],
  };
}

export class Messages {
  constructor(
    private readonly c: Connection,
    private readonly identity: Identity,
    private readonly scrubQuote: ScrubQuote | null = null
  ) {}

  /**
   * The next id in the message's second: past the newest row and past every
   * id the second ever handed out, so an id freed by a purge is never reused.
   */
  allocateId(ts: number): number {
    const base = firstIdOfSecond(ts);
    const top = base + SEQ_SPAN;
    const newest =
      this.c.get<{ id: number }>("SELECT id FROM messages WHERE id >= ? AND id < ? ORDER BY id DESC LIMIT 1", base, top)?.id ?? -1;
    const high = this.c.get<{ top: number }>("SELECT top FROM id_high WHERE second = ?", Math.floor(ts / 1000))?.top ?? -1;
    const next = Math.max(newest, high) + 1;
    if (next < base) return base;
    if (next < top) return next;
    throw new StorageError("ID_SPACE_EXHAUSTED", `Second ${Math.floor(ts / 1000)} already handed out ${SEQ_SPAN} ids.`);
  }

  upsert(input: MessageInput): UpsertResult {
    return this.c.write(() => this.upsertOne(input));
  }

  /** Many messages in one transaction: the import and history-sync path. */
  upsertMany(inputs: readonly MessageInput[]): UpsertResult[] {
    return this.c.write(() => inputs.map((input) => this.upsertOne(input)));
  }

  private upsertOne(input: MessageInput): UpsertResult {
    const ts = checkTimestamp(input.ts, "ts");
    const expiresAt = checkInstant(input.expiresAt, "expiresAt");
    const editedAt = checkInstant(input.editedAt, "editedAt");
    if (!input.chatJid || !input.keyId || !input.type || typeof input.fromMe !== "boolean") {
      throw new StorageError("INVALID_INPUT", "A message needs a chat jid, a key id, a direction and a type.");
    }
    const now = this.c.now();
    let chat = this.identity.chat(input.chatJid);
    const existing = chat === null ? null : this.identity.findByKey(chat, input.fromMe, input.keyId);
    if (existing !== null) return this.mergeExisting(existing, input, expiresAt, editedAt, now);

    if (chat !== null && chat.clearedThroughTs !== null && ts <= chat.clearedThroughTs) {
      return { outcome: "cleared", id: null, sid: null };
    }
    chat ??= this.identity.ensureChat(input.chatJid);
    const sid = sidOf(input.fromMe, chat.jid, input.keyId);
    const id = this.allocateId(ts);
    const senderId = this.senderIdFor(input, chat);

    const gone = this.wasRetracted(chat, input.fromMe, input.keyId);
    // The status feed keeps no tombstones: its retraction record is the barrier, and a story's day is a hard end.
    if (gone !== null && chat.kind === "status") return { outcome: "deleted", id: null, sid };
    if (gone !== null) {
      // Its tombstone was purged with a clear, but the message stays gone.
      this.c.run(
        `INSERT INTO messages(id, chat_id, key_id, from_me, sender_id, ts, type, deleted_at, stored_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NEXT_STORED_SEQ})`,
        id,
        chat.id,
        input.keyId,
        input.fromMe ? 1 : 0,
        senderId,
        ts,
        input.type,
        gone
      );
      return { outcome: "deleted", id, sid };
    }

    if (expiresAt !== null && expiresAt <= now && chat.kind === "status") {
      this.recordRetracted(chat.id, input.fromMe, input.keyId, now);
      return { outcome: "expired", id: null, sid };
    }
    if (expiresAt !== null && expiresAt <= now) {
      this.c.run(
        `INSERT INTO messages(id, chat_id, key_id, from_me, sender_id, ts, type, expires_at, deleted_at, stored_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${NEXT_STORED_SEQ})`,
        id,
        chat.id,
        input.keyId,
        input.fromMe ? 1 : 0,
        senderId,
        ts,
        input.type,
        expiresAt,
        now
      );
      this.recordRetracted(chat.id, input.fromMe, input.keyId, now);
      return { outcome: "expired", id, sid };
    }

    this.c.stmt(UPSERT_SQL).run({
      id,
      chat_id: chat.id,
      key_id: input.keyId,
      from_me: input.fromMe ? 1 : 0,
      sender_id: senderId,
      ts,
      type: input.type,
      ...quoteColumns(input.quotedSid ?? null),
      status: input.status ?? null,
      edited_at: editedAt,
      expires_at: expiresAt,
      text: input.text ?? null,
      transcript: input.transcript ?? null,
      transcript_info: input.transcript ? transcriptInfoJson(input.transcriptInfo) : null,
      raw: this.scrubbedRaw(input.raw ?? null, input.quotedSid ?? null),
      flags: flagBits(input.flags),
    });
    return { outcome: "inserted", id, sid };
  }

  private mergeExisting(
    existing: MessageKey,
    input: MessageInput,
    expiresAt: number | null,
    editedAt: number | null,
    now: number
  ): UpsertResult {
    if (existing.deleted_at !== null) return { outcome: "deleted", id: existing.id, sid: existing.sid };
    const chat = existing.chat;
    if (chat.clearedThroughTs !== null && existing.ts <= chat.clearedThroughTs) {
      return { outcome: "cleared", id: null, sid: null };
    }
    const deadline = earliest(existing.expires_at, expiresAt);
    if (deadline !== null && deadline <= now) {
      // Past its deadline: the expiry sweep tombstones it and hands back its files.
      if (deadline !== existing.expires_at) {
        this.c.run("UPDATE messages SET expires_at = ? WHERE id = ?", deadline, existing.id);
      }
      return { outcome: "expired", id: existing.id, sid: existing.sid };
    }
    const stale = existing.edited_at !== null && (editedAt === null || editedAt < existing.edited_at);
    this.c.stmt(UPSERT_SQL).run({
      id: existing.id,
      chat_id: existing.chat_id,
      key_id: existing.key_id,
      from_me: existing.from_me,
      sender_id: this.senderIdFor(input, chat),
      ts: existing.ts,
      type: input.type,
      ...quoteColumns(input.quotedSid ?? null),
      status: input.status ?? null,
      edited_at: editedAt,
      expires_at: expiresAt,
      text: input.text ?? null,
      transcript: input.transcript ?? null,
      transcript_info: input.transcript ? transcriptInfoJson(input.transcriptInfo) : null,
      raw: this.scrubbedRaw(input.raw ?? null, input.quotedSid ?? null),
      flags: flagBits(input.flags),
    });
    return { outcome: stale ? "stale" : "updated", id: existing.id, sid: existing.sid };
  }

  private senderIdFor(input: MessageInput, chat: ChatRecord): number | null {
    if (input.senderJid) return this.identity.ensureContact(input.senderJid);
    return !input.fromMe && chat.kind === "direct" ? chat.contactId : null;
  }

  /** When the message with this key in this chat was deleted, retracted or expired; null when it never was. */
  private wasRetracted(chat: ChatRecord, fromMe: boolean, keyId: string): number | null {
    const inChat = chatCondition(this.identity.chatIdsOf(chat));
    const row = this.c.get<{ at: number }>(
      `SELECT at FROM retracted m WHERE key_id = ? AND from_me = ? AND ${inChat.sql} LIMIT 1`,
      keyId,
      fromMe ? 1 : 0,
      ...inChat.params
    );
    return row?.at ?? null;
  }

  /** The content-free record of a message gone for good. Call inside write(). */
  private recordRetracted(chatId: number, fromMe: boolean | number, keyId: string, at: number): void {
    this.c.run(
      "INSERT OR IGNORE INTO retracted(key_id, from_me, chat_id, at) VALUES (?, ?, ?, ?)",
      keyId,
      fromMe === true || fromMe === 1 ? 1 : 0,
      chatId,
      at
    );
  }

  /**
   * A quote of a deleted message arrives without its embedded copy. The quote
   * is matched by the quoted message's direction and WhatsApp key, whichever
   * address spelled it; stanza ids are random enough that the chat is not
   * needed, and a false match only ever removes a copy.
   */
  private scrubbedRaw(raw: Uint8Array | null, quotedSid: string | null): Uint8Array | null {
    if (raw === null || quotedSid === null || this.scrubQuote === null) return raw;
    const { quoted_from_me: fromMe, quoted_key_id: keyId } = quoteColumns(quotedSid);
    if (keyId === null) return raw;
    const gone =
      fromMe === null
        ? this.c.get("SELECT 1 FROM retracted WHERE key_id = ? LIMIT 1", keyId)
        : this.c.get("SELECT 1 FROM retracted WHERE key_id = ? AND from_me = ? LIMIT 1", keyId, fromMe);
    return gone === undefined ? raw : this.scrubQuote(raw, quotedSid);
  }

  /** Every live quote of `messageId`, however its address was spelled, loses its embedded copy of it. */
  private scrubQuotesOf(messageId: number): void {
    if (this.scrubQuote === null) return;
    const target = this.c.get<{ from_me: number; key_id: string }>("SELECT from_me, key_id FROM messages WHERE id = ?", messageId);
    if (target === undefined) return;
    const quoting = this.c.all<{ id: number; raw: Uint8Array; quoted_sid: string }>(
      `SELECT id, raw, quoted_sid FROM messages
       WHERE quoted_key_id = ? AND (quoted_from_me IS NULL OR quoted_from_me = ?) AND raw IS NOT NULL AND deleted_at IS NULL`,
      target.key_id,
      target.from_me
    );
    for (const row of quoting) {
      this.c.run("UPDATE messages SET raw = ? WHERE id = ?", this.scrubQuote(row.raw, row.quoted_sid), row.id);
    }
  }

  /** The row becomes a tombstone; returns the derived files to unlink after commit. Call inside write(). */
  tombstone(messageId: number, at: number): string[] {
    const paths = this.c.all<{ path: string }>("SELECT path FROM media WHERE message_id = ?", messageId).map((r) => r.path);
    this.c.run("DELETE FROM media WHERE message_id = ?", messageId);
    this.c.run(
      "UPDATE messages SET deleted_at = ?, text = NULL, transcript = NULL, transcript_info = NULL, raw = NULL WHERE id = ? AND deleted_at IS NULL",
      at,
      messageId
    );
    this.c.run(
      "INSERT OR IGNORE INTO retracted(key_id, from_me, chat_id, at) SELECT key_id, from_me, chat_id, ? FROM messages WHERE id = ?",
      at,
      messageId
    );
    this.scrubQuotesOf(messageId);
    return this.released(paths);
  }

  /** The paths no media row references any more: the ones the delete queued for unlinking. */
  private released(paths: readonly string[]): string[] {
    return [...new Set(paths)].filter((path) => this.c.get("SELECT 1 FROM media WHERE path = ?", path) === undefined);
  }

  /**
   * Delete for me, or a retraction for everyone: the message becomes a
   * tombstone. A retraction for a message not seen yet stores the tombstone
   * ahead of it, at the protocol timestamp (`ts`), never at 0.
   */
  delete(
    sid: string,
    options: { at?: number; ts?: number; chatJid?: string; keyId?: string; fromMe?: boolean } = {}
  ): DeleteResult {
    const result = this.c.write((): DeleteResult => {
      const at = checkInstant(options.at, "at") ?? this.c.now();
      const parsed = parseSid(sid);
      const chatJid = options.chatJid ?? parsed?.chatJid;
      const keyId = options.keyId ?? parsed?.keyId;
      const fromMe = options.fromMe ?? parsed?.fromMe ?? undefined;
      const existing =
        chatJid !== undefined && keyId !== undefined && fromMe !== undefined
          ? this.findKey(chatJid, fromMe, keyId)
          : this.identity.findMessage(sid);
      if (existing !== null) {
        if (existing.deleted_at !== null) return { outcome: "already", id: existing.id, mediaPaths: [] };
        const mediaPaths = this.tombstone(existing.id, at);
        // The status feed keeps no tombstones: the retraction record is its barrier.
        if (existing.chat.kind === "status") this.c.run("DELETE FROM messages WHERE id = ?", existing.id);
        return { outcome: "deleted", id: existing.id, mediaPaths };
      }
      if (chatJid === undefined || keyId === undefined || fromMe === undefined) {
        throw new StorageError("INVALID_INPUT", `A tombstone for the unseen ${sid} needs its chat, key and direction.`);
      }
      const ts = checkTimestamp(options.ts, "ts");
      let chat = this.identity.chat(chatJid);
      if (chat !== null && chat.clearedThroughTs !== null && ts <= chat.clearedThroughTs) {
        return { outcome: "cleared", id: null, mediaPaths: [] };
      }
      chat ??= this.identity.ensureChat(chatJid);
      if (chat.kind === "status") {
        this.recordRetracted(chat.id, fromMe, keyId, at);
        return { outcome: "placeholder", id: null, mediaPaths: [] };
      }
      const id = this.allocateId(ts);
      this.c.run(
        `INSERT INTO messages(id, chat_id, key_id, from_me, ts, type, deleted_at, stored_seq) VALUES (?, ?, ?, ?, ?, 'deleted', ?, ${NEXT_STORED_SEQ})`,
        id,
        chat.id,
        keyId,
        fromMe ? 1 : 0,
        ts,
        at
      );
      this.recordRetracted(chat.id, fromMe, keyId, at);
      this.scrubQuotesOf(id);
      return { outcome: "placeholder", id, mediaPaths: [] };
    });
    if (result.outcome === "deleted") this.c.scheduleCheckpoint();
    return result;
  }

  private findKey(chatJid: string, fromMe: boolean, keyId: string): MessageKey | null {
    const chat = this.identity.chat(chatJid);
    return chat === null ? null : this.identity.findByKey(chat, fromMe, keyId);
  }

  /** A transcript arrived for a live message, with who made it; it joins the search index and drops a stale embedding. */
  setTranscript(sid: string, transcript: string, info: TranscriptInfo | null = null): boolean {
    return this.c.write(() => {
      const key = this.visibleKey(sid);
      if (key === null) return false;
      return (
        this.c.run(
          "UPDATE messages SET transcript = ?, transcript_info = ? WHERE id = ? AND deleted_at IS NULL",
          transcript,
          transcriptInfoJson(info),
          key.id
        ) > 0
      );
    });
  }

  /** Delivery status only rises, in statusRank's order. */
  setStatus(sid: string, status: number): boolean {
    return this.c.write(() => {
      const key = this.visibleKey(sid);
      if (key === null) return false;
      return (
        this.c.run(
          `UPDATE messages SET status = ? WHERE id = ? AND deleted_at IS NULL AND (status IS NULL OR ${rank("status")} < ?)`,
          status,
          key.id,
          statusRank(status)
        ) > 0
      );
    });
  }

  /** Adds MESSAGE_FLAGS bits to a stored message that is not a tombstone; bits are never taken away. */
  addFlags(sid: string, bits: number): boolean {
    const add = flagBits(bits);
    if (add === 0) return false;
    return this.c.write(() => {
      const key = this.identity.findMessage(sid);
      if (key === null || key.deleted_at !== null) return false;
      return this.c.run("UPDATE messages SET flags = flags | ? WHERE id = ? AND deleted_at IS NULL AND flags & ? <> ?", add, key.id, add, add) > 0;
    });
  }

  /**
   * Asks for the protobuf-derived flags of every stored message to be worked
   * out again, newest first, by the next backfillFlags(): what an import that
   * stored messages without them calls. Rows already flagged only gain bits.
   * It also marks which of the account's own messages wazap sent as unknown
   * up to now (see viaWazapKnownAfter).
   */
  requestFlagsBackfill(): void {
    this.c.write(() => {
      const top = this.c.get<{ id: number | null }>("SELECT max(id) AS id FROM messages")?.id ?? null;
      if (top === null) return;
      // An import brings the account's own messages with no record of which wazap sent.
      const known = this.viaWazapKnownAfter();
      this.c.run("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", VIA_WAZAP_KNOWN_META, String(Math.max(known, this.c.now())));
      const current = this.c.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", FLAGS_BACKFILL_META)?.value;
      const before = Math.max(top + 1, current === undefined ? 0 : Number(current) || 0);
      this.c.run("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", FLAGS_BACKFILL_META, String(before));
    });
  }

  /**
   * Before when (epoch ms) via_wazap cannot be trusted to be missing: sends
   * leave no key record older than v5 or than an import, so an own message
   * from before then may be wazap's without saying so. 0 when the record is
   * whole.
   */
  viaWazapKnownAfter(): number {
    const value = this.c.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", VIA_WAZAP_KNOWN_META)?.value;
    if (value === undefined) return 0;
    const at = value === "migrated_v5" ? Number(this.c.get<{ value: string }>("SELECT value FROM meta WHERE key = 'migrated_v5'")?.value) : Number(value);
    return Number.isSafeInteger(at) && at > 0 ? at : 0;
  }

  /** Whether flags are still owed to stored messages: the cursor a migration or an import left. */
  flagsBackfillPending(): boolean {
    return this.c.get("SELECT 1 FROM meta WHERE key = ?", FLAGS_BACKFILL_META) !== undefined;
  }

  /**
   * Works out the flags the protobuf carries (mentions_me) for messages stored
   * before this build set them: from the cursor in meta flags_backfill_before
   * down, newest first, as far as `windowMs` back (14 days), in chunks that
   * commit and yield like every large operation. The cursor moves with each
   * chunk, so a stop or a crash resumes where it was; it is gone once the
   * window is walked. `detect` returns the bits for one message (0 for none)
   * and must not write; a detector that throws counts as none. The account's
   * own messages under a key in sent_keys gain via_wazap on the way.
   */
  backfillFlags(detect: FlagDetector, options: { windowMs?: number } = {}): Promise<{ scanned: number; flagged: number; done: boolean }> {
    this.c.assertWritable();
    return this.c.bulk(async () => {
      const result = { scanned: 0, flagged: 0, done: false };
      const floor = idLowerBound(Math.max(1, this.c.now() - Math.max(0, options.windowMs ?? FLAGS_BACKFILL_WINDOW_MS)));
      await this.c.chunked(() => {
        const cursor = this.c.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", FLAGS_BACKFILL_META)?.value;
        const before = cursor === undefined ? NaN : Number(cursor);
        if (!Number.isSafeInteger(before)) {
          if (cursor !== undefined) this.c.run("DELETE FROM meta WHERE key = ?", FLAGS_BACKFILL_META);
          result.done = true;
          return false;
        }
        const rows = this.c.all<{ id: number; from_me: number; type: string; raw: Uint8Array; chat_jid: string; sent: number }>(
          `SELECT m.id, m.from_me, m.type, m.raw, coalesce(ck.jid, c.jid) AS chat_jid,
             (m.from_me = 1 AND EXISTS (SELECT 1 FROM sent_keys k WHERE k.key_id = m.key_id)) AS sent
           FROM messages m CROSS JOIN chats c ON c.id = m.chat_id LEFT JOIN chats ck ON ck.id = c.merged_into
           WHERE m.id < ? AND m.id >= ? AND m.deleted_at IS NULL AND m.raw IS NOT NULL
           ORDER BY m.id DESC LIMIT ?`,
          before,
          floor,
          this.c.chunkSize
        );
        const started = performance.now();
        let last = before;
        let done = 0;
        for (const row of rows) {
          let bits: number;
          try {
            bits = flagBits(detect({ raw: row.raw, fromMe: row.from_me === 1, type: row.type, chatJid: row.chat_jid }));
          } catch {
            bits = 0;
          }
          if (row.sent === 1) bits |= MESSAGE_FLAGS.viaWazap;
          if (bits !== 0 && this.c.run("UPDATE messages SET flags = flags | ? WHERE id = ? AND flags & ? <> ?", bits, row.id, bits, bits) > 0) {
            result.flagged++;
          }
          result.scanned++;
          last = row.id;
          done++;
          if (performance.now() - started > this.c.chunkBudgetMs) break;
        }
        if (done === rows.length && rows.length < this.c.chunkSize) {
          this.c.run("DELETE FROM meta WHERE key = ?", FLAGS_BACKFILL_META);
          result.done = true;
          return false;
        }
        this.c.run("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", FLAGS_BACKFILL_META, String(last));
        return true;
      });
      return result;
    });
  }

  /**
   * The account's own devices (the phone) reported this message read: its
   * chat's read mark moves up to it, and never back. Any spelling of the sid
   * works, a bare `<chat>_<key>` too, since a receipt names a key and not
   * always its direction; a message not stored (yet), one of the account's
   * own, or a story, moves nothing (`chatJid` null only for the first). The mark lands on
   * the chat a reader sees, so a lid spelling marks the number's chat.
   */
  markReadSelf(sid: string): { moved: boolean; chatJid: string | null; readThroughId: number | null } {
    return this.c.write(() => {
      const parsed = parseSid(sid);
      const chat = parsed === null ? null : this.identity.chat(parsed.chatJid);
      if (parsed === null || chat === null) return { moved: false, chatJid: null, readThroughId: null };
      // A story viewed is not a chat read.
      if (chat.kind === "status") return { moved: false, chatJid: chat.jid, readThroughId: chat.readThroughId };
      // Only someone else's message is read; a receipt naming one of the account's own moves nothing.
      const key = parsed.fromMe === true ? null : this.identity.findByKey(chat, false, parsed.keyId);
      if (key === null) {
        const own = parsed.fromMe === false ? null : this.identity.findByKey(chat, true, parsed.keyId);
        return own === null
          ? { moved: false, chatJid: null, readThroughId: null }
          : { moved: false, chatJid: chat.jid, readThroughId: chat.readThroughId };
      }
      const moved =
        this.c.run(
          "UPDATE chats SET read_through_id = ? WHERE id = ? AND (read_through_id IS NULL OR read_through_id < ?)",
          key.id,
          key.chat.id,
          key.id
        ) > 0;
      const through = this.c.get<{ read_through_id: number | null }>("SELECT read_through_id FROM chats WHERE id = ?", key.chat.id);
      return { moved, chatJid: key.chat.jid, readThroughId: through?.read_through_id ?? null };
    });
  }

  /** A deadline only ever moves earlier; a later one is ignored. */
  setExpiry(sid: string, at: number): boolean {
    const deadline = checkInstant(at, "at")!;
    return this.c.write(() => {
      const key = this.visibleKey(sid);
      if (key === null) return false;
      return (
        this.c.run(
          "UPDATE messages SET expires_at = ? WHERE id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
          deadline,
          key.id,
          deadline
        ) > 0
      );
    });
  }

  /** The earliest pending deadline, for the expiry timer. */
  nextExpiry(): number | null {
    const row = this.c.get<{ expires_at: number }>(
      `SELECT expires_at FROM messages INDEXED BY messages_expiry
       WHERE expires_at IS NOT NULL AND deleted_at IS NULL ORDER BY expires_at LIMIT 1`
    );
    return row?.expires_at ?? null;
  }

  /**
   * Every message past its deadline becomes a tombstone, a chunk per
   * transaction. An expired story leaves no row at all: its retraction record
   * keeps a replay out, and the status feed is not walked past a day of them.
   */
  expireDue(): Promise<BulkDeleteResult> {
    return this.c.bulk(async () => {
      const result: BulkDeleteResult = { count: 0, sids: [], mediaPaths: [] };
      await this.c.chunked(() => {
        const now = this.c.now();
        const started = performance.now();
        const due = this.c.all<{ id: number; sid: string; kind: string }>(
          `SELECT m.id, ${SID_EXPR} AS sid, c.kind FROM messages m INDEXED BY messages_expiry
             JOIN chats c ON c.id = m.chat_id LEFT JOIN chats ck ON ck.id = c.merged_into
           WHERE m.expires_at IS NOT NULL AND m.deleted_at IS NULL AND m.expires_at <= ? ORDER BY m.expires_at LIMIT ?`,
          now,
          this.c.chunkSize
        );
        let done = 0;
        for (const row of due) {
          result.mediaPaths.push(...this.tombstone(row.id, now));
          if (row.kind === "status") this.c.run("DELETE FROM messages WHERE id = ?", row.id);
          result.sids.push(row.sid);
          done++;
          if (performance.now() - started > this.c.chunkBudgetMs) break;
        }
        result.count += done;
        return due.length === this.c.chunkSize || done < due.length;
      });
      if (result.count > 0) this.c.checkpoint();
      return result;
    });
  }

  /**
   * Clear a chat through `throughTs`, inclusive: the barrier is stored first,
   * so nothing at or before it can come back, then the rows go in chunks.
   */
  clearChat(chatJid: string, throughTs: number): Promise<BulkDeleteResult> {
    const through = checkTimestamp(throughTs, "throughTs");
    // Raised now, not when the queued purge starts: from this call on nothing at or before it is accepted.
    const chat = this.raiseBarrier(chatJid, through);
    return this.c.bulk(() => this.purgeCleared(chat.id));
  }

  /**
   * Clear, and drop what made the chat a list entry: it leaves the chat list
   * until a new message arrives. The entry is reset with the barrier, in the
   * same transaction, so what arrives while the purge runs — a new message, its
   * unread count, a handled mark — is not wiped when the purge ends.
   */
  deleteChat(chatJid: string, throughTs: number): Promise<BulkDeleteResult> {
    const through = checkTimestamp(throughTs, "throughTs");
    const chat = this.c.write(() => {
      const raised = this.raiseBarrier(chatJid, through);
      for (const chatId of this.identity.chatIdsOf(raised)) {
        this.c.run("UPDATE chats SET archived = 0, pinned = NULL, unread = 0, proto = NULL WHERE id = ?", chatId);
        this.c.run("DELETE FROM handled WHERE chat_id = ?", chatId);
      }
      return raised;
    });
    return this.c.bulk(() => this.purgeCleared(chat.id));
  }

  /**
   * Stores the barrier and hides everything under it in the same transaction:
   * the chat's last message is recomputed from what stays visible, and every
   * read filters on the barrier, so a purge that a crash interrupts leaves
   * nothing readable behind. `resumePurges()` finishes the physical delete.
   */
  private raiseBarrier(chatJid: string, through: number): ChatRecord {
    return this.c.write(() => {
      const chat = this.identity.ensureChat(chatJid);
      for (const chatId of this.identity.chatIdsOf(chat)) {
        this.c.run("UPDATE chats SET cleared_through_ts = max(coalesce(cleared_through_ts, 0), ?) WHERE id = ?", through, chatId);
        this.c.run(RECOMPUTE_LAST, chatId);
      }
      return chat;
    });
  }

  /** Whether any chat still has rows at or before its stored barrier: one index probe per chat with a barrier. */
  purgePending(): boolean {
    return (
      this.c.get(
        `SELECT 1 FROM chats c WHERE c.cleared_through_ts IS NOT NULL AND EXISTS (
           SELECT 1 FROM messages m WHERE m.chat_id = c.id
             AND m.id < ((c.cleared_through_ts / 1000) + 1) * 1048576 AND m.ts <= c.cleared_through_ts)
         LIMIT 1`
      ) !== undefined
    );
  }

  /**
   * Physically removes every live message, in chunks, and keeps every
   * tombstone and every retraction record: what an account that does not keep
   * its history forgets between runs. No barrier is raised, so WhatsApp may
   * sync the same messages again; nothing deleted can come back.
   */
  purgeLive(): Promise<BulkDeleteResult> {
    this.c.assertWritable();
    return this.c.bulk(async () => {
      const result: BulkDeleteResult = { count: 0, sids: [], mediaPaths: [] };
      await this.c.chunked(() => {
        const rows = this.c.all<{ id: number; sid: string }>(
          `SELECT m.id, ${SID_EXPR} AS sid FROM messages m JOIN chats c ON c.id = m.chat_id
             LEFT JOIN chats ck ON ck.id = c.merged_into
           WHERE m.deleted_at IS NULL ORDER BY m.id LIMIT ?`,
          this.c.chunkSize
        );
        const started = performance.now();
        let done = 0;
        while (done < rows.length) {
          this.deleteRows([rows[done]!], result);
          done++;
          if (performance.now() - started > this.c.chunkBudgetMs) break;
        }
        return rows.length === this.c.chunkSize || done < rows.length;
      });
      if (result.count > 0) this.c.checkpoint();
      return result;
    });
  }

  /** Physically removes rows a stored barrier already hides, for every chat a crash or a close left mid-purge. */
  resumePurges(): Promise<BulkDeleteResult> {
    this.c.assertWritable();
    return this.c.bulk(async () => {
      const result: BulkDeleteResult = { count: 0, sids: [], mediaPaths: [] };
      const pending = this.c.all<{ id: number }>(
        `SELECT c.id FROM chats c WHERE c.cleared_through_ts IS NOT NULL AND EXISTS (
           SELECT 1 FROM messages m WHERE m.chat_id = c.id
             AND m.id < ((c.cleared_through_ts / 1000) + 1) * 1048576 AND m.ts <= c.cleared_through_ts)`
      );
      for (const chat of pending) {
        const purged = await this.purgeCleared(chat.id);
        result.count += purged.count;
        result.sids.push(...purged.sids);
        result.mediaPaths.push(...purged.mediaPaths);
      }
      return result;
    });
  }

  /** Deletes every row of the chat at or before its barrier, tombstones included. Runs inside bulk(). */
  async purgeCleared(chatId: number): Promise<BulkDeleteResult> {
    const result: BulkDeleteResult = { count: 0, sids: [], mediaPaths: [] };
    await this.c.chunked(() => {
      const barrier = this.c.get<{ through: number | null }>(
        "SELECT cleared_through_ts AS through FROM chats WHERE id = ?",
        chatId
      )?.through;
      if (barrier === null || barrier === undefined) return false;
      const rows = this.c.all<{ id: number; sid: string }>(
        `SELECT m.id, ${SID_EXPR} AS sid FROM messages m JOIN chats c ON c.id = m.chat_id
           LEFT JOIN chats ck ON ck.id = c.merged_into
         WHERE m.chat_id = ? AND m.id < ? AND m.ts <= ? ORDER BY m.id LIMIT ?`,
        chatId,
        idUpperBound(barrier),
        barrier,
        this.c.chunkSize
      );
      const started = performance.now();
      let done = 0;
      // One row per statement: the budget is checked between rows, because
      // one indexed row can cost milliseconds on a large account.
      while (done < rows.length) {
        this.deleteRows([rows[done]!], result);
        done++;
        if (performance.now() - started > this.c.chunkBudgetMs) break;
      }
      return rows.length === this.c.chunkSize || done < rows.length;
    });
    if (result.count > 0) this.c.checkpoint();
    return result;
  }

  /** Physically removes rows; cascades take reactions, votes, receipts, media rows and embeddings. */
  deleteRows(rows: ReadonlyArray<{ id: number; sid: string }>, into: BulkDeleteResult): void {
    if (rows.length === 0) return;
    const ids = idsJson(rows.map((row) => row.id));
    const paths = this.c
      .all<{ path: string }>("SELECT path FROM media WHERE message_id IN (SELECT value FROM json_each(?))", ids)
      .map((row) => row.path);
    // A clear is not a retraction: quotes of cleared messages keep their copy, as they do on the phone.
    this.c.run("DELETE FROM messages WHERE id IN (SELECT value FROM json_each(?))", ids);
    into.mediaPaths.push(...this.released(paths));
    into.count += rows.length;
    for (const row of rows) into.sids.push(row.sid);
  }

  /**
   * The key of a message a reader may see, or null: unknown, a tombstone, past
   * its deadline, or at or before a stored clear barrier whose purge has not
   * reached it yet. Every accessor and write addressed by sid goes through this,
   * so a hidden row can neither be read nor gain reactions, files or words.
   */
  visibleKey(sid: string): MessageKey | null {
    const key = this.identity.findMessage(sid);
    if (key === null || key.deleted_at !== null) return null;
    if (key.ts <= Math.max(key.cleared_through_ts ?? 0, key.chat.clearedThroughTs ?? 0)) return null;
    if (key.expires_at !== null && key.expires_at <= this.c.now()) return null;
    return key;
  }

  /** A reaction, or its removal (empty emoji). An older event never overrides a newer one. */
  react(sid: string, reactorJid: string, emoji: string | null, ts: number): boolean {
    const at = checkTimestamp(ts, "ts");
    return this.c.write(() => {
      const key = this.visibleKey(sid);
      if (key === null) return false;
      const contactId = this.identity.ensureContact(reactorJid);
      if (!emoji) {
        this.c.run("DELETE FROM reactions WHERE message_id = ? AND contact_id = ? AND ts <= ?", key.id, contactId, at);
      } else {
        this.c.run(
          `INSERT INTO reactions(message_id, contact_id, emoji, ts) VALUES (?, ?, ?, ?)
           ON CONFLICT(message_id, contact_id) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts
           WHERE excluded.ts >= reactions.ts`,
          key.id,
          contactId,
          emoji,
          at
        );
      }
      return true;
    });
  }

  /** A poll vote: the voter's current choice (serialized by the caller), or its withdrawal (null). */
  vote(sid: string, voterJid: string, choice: string | null, ts: number): boolean {
    const at = checkTimestamp(ts, "ts");
    return this.c.write(() => {
      const key = this.visibleKey(sid);
      if (key === null) return false;
      const contactId = this.identity.ensureContact(voterJid);
      if (choice === null) {
        this.c.run("DELETE FROM votes WHERE message_id = ? AND contact_id = ? AND ts <= ?", key.id, contactId, at);
      } else {
        this.c.run(
          `INSERT INTO votes(message_id, contact_id, choice, ts) VALUES (?, ?, ?, ?)
           ON CONFLICT(message_id, contact_id) DO UPDATE SET choice = excluded.choice, ts = excluded.ts
           WHERE excluded.ts >= votes.ts`,
          key.id,
          contactId,
          choice,
          at
        );
      }
      return true;
    });
  }

  /**
   * Delivery, read and played times; each keeps the latest one seen, as the
   * service always has: a person who reads a message again is shown at the
   * newer time.
   */
  receipt(
    sid: string,
    contactJid: string,
    times: { deliveredAt?: number | null; readAt?: number | null; playedAt?: number | null }
  ): boolean {
    const delivered = checkInstant(times.deliveredAt, "deliveredAt");
    const read = checkInstant(times.readAt, "readAt");
    const played = checkInstant(times.playedAt, "playedAt");
    return this.c.write(() => {
      const key = this.visibleKey(sid);
      if (key === null) return false;
      const contactId = this.identity.ensureContact(contactJid);
      this.c.run(
        `INSERT INTO receipts(message_id, contact_id, delivered_at, read_at, played_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(message_id, contact_id) DO UPDATE SET
           delivered_at = coalesce(max(receipts.delivered_at, excluded.delivered_at), receipts.delivered_at, excluded.delivered_at),
           read_at = coalesce(max(receipts.read_at, excluded.read_at), receipts.read_at, excluded.read_at),
           played_at = coalesce(max(receipts.played_at, excluded.played_at), receipts.played_at, excluded.played_at)`,
        key.id,
        contactId,
        delivered,
        read,
        played
      );
      return true;
    });
  }

  reactions(sid: string): Reaction[] {
    const key = this.visibleKey(sid);
    if (key === null) return [];
    return this.c
      .all<{ contact_id: number; jid: string | null; emoji: string; ts: number }>(
        `SELECT r.contact_id, coalesce(k.phone_jid, k.lid) AS jid, r.emoji, r.ts
         FROM reactions r JOIN contacts k ON k.id = r.contact_id WHERE r.message_id = ? ORDER BY r.ts, r.rowid`,
        key.id
      )
      .map((row) => ({ contactId: row.contact_id, jid: row.jid, emoji: row.emoji, ts: row.ts }));
  }

  votes(sid: string): Vote[] {
    const key = this.visibleKey(sid);
    if (key === null) return [];
    return this.c
      .all<{ contact_id: number; jid: string | null; choice: string; ts: number }>(
        `SELECT v.contact_id, coalesce(k.phone_jid, k.lid) AS jid, v.choice, v.ts
         FROM votes v JOIN contacts k ON k.id = v.contact_id WHERE v.message_id = ? ORDER BY v.ts, v.rowid`,
        key.id
      )
      .map((row) => ({ contactId: row.contact_id, jid: row.jid, choice: row.choice, ts: row.ts }));
  }

  receipts(sid: string): Receipt[] {
    const key = this.visibleKey(sid);
    if (key === null) return [];
    return this.c
      .all<{
        contact_id: number;
        jid: string | null;
        delivered_at: number | null;
        read_at: number | null;
        played_at: number | null;
      }>(
        `SELECT r.contact_id, coalesce(k.phone_jid, k.lid) AS jid, r.delivered_at, r.read_at, r.played_at
         FROM receipts r JOIN contacts k ON k.id = r.contact_id WHERE r.message_id = ? ORDER BY r.contact_id`,
        key.id
      )
      .map((row) => ({
        contactId: row.contact_id,
        jid: row.jid,
        deliveredAt: row.delivered_at,
        readAt: row.read_at,
        playedAt: row.played_at,
      }));
  }

  /**
   * The reactions, votes and receipts of many messages at once, keyed by
   * message id, in three queries: what a reader listing a page or a window of
   * messages uses instead of three lookups per message. The ids come from a
   * read that already checked they are visible.
   */
  marksOf(ids: readonly number[]): { reactions: Map<number, Reaction[]>; votes: Map<number, Vote[]>; receipts: Map<number, Receipt[]> } {
    const reactions = new Map<number, Reaction[]>();
    const votes = new Map<number, Vote[]>();
    const receipts = new Map<number, Receipt[]>();
    if (ids.length === 0) return { reactions, votes, receipts };
    const list = JSON.stringify(ids);
    const push = <T>(map: Map<number, T[]>, id: number, item: T): void => {
      const items = map.get(id);
      if (items === undefined) map.set(id, [item]);
      else items.push(item);
    };
    for (const row of this.c.all<{ message_id: number; contact_id: number; jid: string | null; emoji: string; ts: number }>(
      `SELECT r.message_id, r.contact_id, coalesce(k.phone_jid, k.lid) AS jid, r.emoji, r.ts
       FROM reactions r JOIN contacts k ON k.id = r.contact_id
       WHERE r.message_id IN (SELECT value FROM json_each(?)) ORDER BY r.message_id, r.ts, r.rowid`,
      list
    )) {
      push(reactions, row.message_id, { contactId: row.contact_id, jid: row.jid, emoji: row.emoji, ts: row.ts });
    }
    for (const row of this.c.all<{ message_id: number; contact_id: number; jid: string | null; choice: string; ts: number }>(
      `SELECT v.message_id, v.contact_id, coalesce(k.phone_jid, k.lid) AS jid, v.choice, v.ts
       FROM votes v JOIN contacts k ON k.id = v.contact_id
       WHERE v.message_id IN (SELECT value FROM json_each(?)) ORDER BY v.message_id, v.ts, v.rowid`,
      list
    )) {
      push(votes, row.message_id, { contactId: row.contact_id, jid: row.jid, choice: row.choice, ts: row.ts });
    }
    for (const row of this.c.all<{
      message_id: number;
      contact_id: number;
      jid: string | null;
      delivered_at: number | null;
      read_at: number | null;
      played_at: number | null;
    }>(
      `SELECT r.message_id, r.contact_id, coalesce(k.phone_jid, k.lid) AS jid, r.delivered_at, r.read_at, r.played_at
       FROM receipts r JOIN contacts k ON k.id = r.contact_id
       WHERE r.message_id IN (SELECT value FROM json_each(?)) ORDER BY r.message_id, r.contact_id`,
      list
    )) {
      push(receipts, row.message_id, {
        contactId: row.contact_id,
        jid: row.jid,
        deliveredAt: row.delivered_at,
        readAt: row.read_at,
        playedAt: row.played_at,
      });
    }
    return { reactions, votes, receipts };
  }

  /** Records a derived file; returns the path it replaced, which the caller unlinks. */
  setMedia(sid: string, kind: string, path: string): { stored: boolean; replaced: string | null } {
    return this.c.write(() => {
      const key = this.visibleKey(sid);
      if (key === null) return { stored: false, replaced: null };
      const previous = this.c.get<{ path: string }>(
        "SELECT path FROM media WHERE message_id = ? AND kind = ?",
        key.id,
        kind
      )?.path;
      this.c.run(
        `INSERT INTO media(message_id, kind, path, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id, kind) DO UPDATE SET path = excluded.path, created_at = excluded.created_at`,
        key.id,
        kind,
        path,
        this.c.now()
      );
      const replaced = previous !== undefined && previous !== path ? this.released([previous]) : [];
      return { stored: true, replaced: replaced[0] ?? null };
    });
  }

  media(sid: string): MediaRecord[] {
    const key = this.visibleKey(sid);
    if (key === null) return [];
    return this.c
      .all<{ kind: string; path: string; created_at: number }>(
        "SELECT kind, path, created_at FROM media WHERE message_id = ? ORDER BY kind",
        key.id
      )
      .map((row) => ({ kind: row.kind, path: row.path, createdAt: row.created_at }));
  }

  /** Every file recorded under `kind`, oldest first: what a quota or an age limit walks. */
  mediaOfKind(kind: string): Array<{ path: string; createdAt: number }> {
    return this.c
      .all<{ path: string; created_at: number }>("SELECT path, created_at FROM media WHERE kind = ? ORDER BY created_at, path", kind)
      .map((row) => ({ path: row.path, createdAt: row.created_at }));
  }

  /**
   * Forgets these files' `kind` rows; a path no row references any more is
   * queued for unlinking in the same transaction (pending_unlinks). Returns
   * how many rows went.
   */
  dropMedia(kind: string, paths: readonly string[]): number {
    if (paths.length === 0) return 0;
    return this.c.write(() => {
      let dropped = 0;
      for (const path of new Set(paths)) {
        dropped += this.c.run("DELETE FROM media WHERE kind = ? AND path = ?", kind, path);
      }
      return dropped;
    });
  }

  /**
   * Points `kind` rows at `from` to `to` instead: the same file, reached by a
   * new path (the data dir moved). `from` is queued for unlinking by the
   * trigger, and the service unlinks only paths inside its own folders.
   */
  rehomeMedia(kind: string, from: string, to: string): number {
    return this.c.write(() => this.c.run("UPDATE media SET path = ? WHERE kind = ? AND path = ?", to, kind, from));
  }

  /**
   * Visible messages of these types from `since` on (and below the id
   * `before`, for the next page), newest first, that carry
   * no file of `kind` yet: what arrived while nothing was there to keep it.
   */
  withoutMedia(kind: string, types: readonly string[], since: number, limit: number, before = NO_UPPER_BOUND): StoredMessage[] {
    if (types.length === 0) return [];
    const floor = Math.max(1, since);
    return this.c
      .all<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM}
         WHERE m.id >= ? AND m.id < ? AND m.ts >= ? AND m.type IN (SELECT value FROM json_each(?)) AND ${VISIBLE}
           AND NOT EXISTS (SELECT 1 FROM media k WHERE k.message_id = m.id AND k.kind = ?)
         ORDER BY m.id DESC LIMIT ?`,
        idLowerBound(floor),
        before,
        floor,
        JSON.stringify(types),
        this.c.now(),
        kind,
        Math.max(1, Math.floor(limit))
      )
      .map(messageFromRow);
  }

  /** A message by any sid spelling; tombstones and expired rows only when asked for. */
  get(sid: string, options: { includeHidden?: boolean } = {}): StoredMessage | null {
    const key = this.identity.findMessage(sid);
    if (key === null) return null;
    const row =
      options.includeHidden === true
        ? this.c.get<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.id = ?`, key.id)
        : this.c.get<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.id = ? AND ${VISIBLE}`, key.id, this.c.now());
    return row === undefined ? null : messageFromRow(row);
  }

  /** Visible messages by id, newest first. */
  byIds(ids: readonly number[]): StoredMessage[] {
    if (ids.length === 0) return [];
    return this.c
      .all<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM}
         WHERE m.id IN (SELECT value FROM json_each(?)) AND ${VISIBLE} ORDER BY m.id DESC`,
        idsJson(ids),
        this.c.now()
      )
      .map(messageFromRow);
  }

  /** One page of a chat, newest first; `before` is the previous page's nextBefore. */
  chatPage(chatJid: string, options: { before?: number; limit: number; since?: number }): Page<StoredMessage> {
    const limit = clampLimit(options.limit);
    const chat = this.identity.chat(chatJid);
    if (chat === null) return { items: [], hasMore: false, nextBefore: null };
    const family = this.identity.chatIdsOf(chat);
    const inChat = chatCondition(family);
    const once = foldTwinCondition(family, chat.id);
    const since = options.since === undefined ? null : checkTimestamp(options.since, "since");
    const rows = this.c.all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM}
       WHERE ${inChat.sql} AND m.id < ? AND m.id >= ? AND m.ts >= ? AND ${VISIBLE} ${once.sql} ORDER BY m.id DESC LIMIT ?`,
      ...inChat.params,
      options.before ?? NO_UPPER_BOUND,
      since === null ? 0 : idLowerBound(since),
      since ?? 0,
      this.c.now(),
      ...once.params,
      limit + 1
    );
    return pageOf(rows.map(messageFromRow), limit);
  }

  /** Messages across every chat since a time, newest first, walked straight off the primary key. */
  recent(options: {
    since: number;
    until?: number;
    before?: number;
    limit: number;
    excludeKinds?: readonly ChatKind[];
  }): Page<StoredMessage> {
    const limit = clampLimit(options.limit);
    const upper = Math.min(options.before ?? NO_UPPER_BOUND, options.until === undefined ? NO_UPPER_BOUND : idUpperBound(options.until));
    const excluded = options.excludeKinds ?? [];
    const kindFilter = excluded.length === 0 ? "" : "AND c.kind NOT IN (SELECT value FROM json_each(?))";
    const params = [idLowerBound(options.since), upper, options.since, options.until ?? NO_UPPER_BOUND, this.c.now()];
    const rows = this.c.all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM}
       WHERE m.id >= ? AND m.id < ? AND m.ts >= ? AND m.ts <= ? AND ${VISIBLE} ${kindFilter}
       ORDER BY m.id DESC LIMIT ?`,
      ...params,
      ...(excluded.length === 0 ? [] : [JSON.stringify(excluded)]),
      limit + 1
    );
    return pageOf(rows.map(messageFromRow), limit);
  }

  /** The newest visible message of a chat, walked back from the end of its index range. */
  lastVisible(chatId: number): StoredMessage | null {
    const inChat = chatCondition(this.c.all<{ id: number }>("SELECT id FROM chats WHERE id = ? OR merged_into = ?", chatId, chatId).map((r) => r.id));
    const row = this.c.get<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE ${inChat.sql} AND ${VISIBLE} ORDER BY m.id DESC LIMIT 1`,
      ...inChat.params,
      this.c.now()
    );
    return row === undefined ? null : messageFromRow(row);
  }

  /**
   * The denormalized last message, unless its deadline passed before the
   * sweep ran — then the chat's newest visible message instead.
   */
  private lastOf(chat: ChatRecord, row: MessageRow | undefined): StoredMessage | null {
    if (chat.lastMessageId === null) return null;
    if (row !== undefined && row.deleted_at === null && (row.expires_at === null || row.expires_at > this.c.now())) {
      return messageFromRow(row);
    }
    return this.lastVisible(chat.id);
  }

  /** Chats that have a message, most recent first. */
  listChats(options: { limit: number; before?: ChatCursor; includeArchived?: boolean }): {
    items: ChatListItem[];
    next: ChatCursor | null;
  } {
    const limit = clampLimit(options.limit);
    const cursor = options.before;
    const archived = options.includeArchived === false ? "AND ch.archived = 0" : "";
    const rows = this.c.all<ChatRow & { m_id: number | null }>(
      `SELECT ch.*, ch.last_message_id AS m_id FROM chats ch INDEXED BY chats_recent
       WHERE ch.last_ts IS NOT NULL AND ch.merged_into IS NULL AND (ch.last_ts < ? OR (ch.last_ts = ? AND ch.id < ?)) ${archived}
       ORDER BY ch.last_ts DESC, ch.id DESC LIMIT ?`,
      cursor?.lastTs ?? NO_UPPER_BOUND,
      cursor?.lastTs ?? NO_UPPER_BOUND,
      cursor?.id ?? NO_UPPER_BOUND,
      limit + 1
    );
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const lasts = new Map(
      this.c
        .all<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.id IN (SELECT value FROM json_each(?))`,
          idsJson(kept.flatMap((row) => (row.m_id === null ? [] : [row.m_id])))
        )
        .map((row) => [row.id, row])
    );
    const items = kept.map((row) => {
      const chat = chatFromRow(row);
      return { chat, last: this.lastOf(chat, row.m_id === null ? undefined : lasts.get(row.m_id)) };
    });
    const tail = kept[kept.length - 1];
    return { items, next: hasMore && tail !== undefined ? { lastTs: tail.last_ts!, id: tail.id } : null };
  }

  /**
   * Chats whose last word is theirs, with that word between `since` and
   * `until`, oldest wait first, read off the denormalized columns and paged
   * with `after`. Everything that narrows the list happens in SQL before the
   * limit: the kinds of chat a person waits in (direct and group unless told
   * otherwise), archived chats (left out unless asked), and chats a handled
   * mark still covers — nothing from the other side has arrived after the
   * ask the mark names (or, naming none, after the mark itself). The user's
   * own messages and system notices do not reopen a chat. Whether a word asks
   * for something stays the caller's judgment, and so does a finer rule.
   *
   * The cursor is a chat's last_ts, which moves when a message arrives: a chat
   * that changes between two pages can appear twice or not at all. Paging is
   * best-effort, not a snapshot.
   */
  waiting(options: {
    since: number;
    until: number;
    limit: number;
    kinds?: readonly ChatKind[];
    includeArchived?: boolean;
    includeHandled?: boolean;
    after?: ChatCursor;
  }): { items: WaitingCandidate[]; next: ChatCursor | null } {
    const limit = clampLimit(options.limit);
    const kinds = options.kinds ?? ["direct", "group"];
    const archived = options.includeArchived === true ? "" : "AND ch.archived = 0";
    // A mark covers the chat until the other side writes again after its ask:
    // walked up each chat's (chat_id, id) index from the ask, or from the
    // mark's own second when it names no message.
    const handled =
      options.includeHandled === true
        ? ""
        : `AND (h.chat_id IS NULL OR EXISTS (
             SELECT 1 FROM chats k CROSS JOIN messages m ON m.chat_id = k.id
             WHERE (k.id = ch.id OR k.merged_into = ch.id)
               AND m.id > coalesce(h.ask_message_id, (h.at / 1000) * 1048576 - 1)
               AND (h.ask_message_id IS NOT NULL OR m.ts > h.at)
               AND m.from_me = 0 AND m.type <> 'system' AND m.deleted_at IS NULL
               AND (m.expires_at IS NULL OR m.expires_at > ?) AND m.ts > coalesce(k.cleared_through_ts, 0)))`;
    const rows = this.c.all<ChatRow>(
      `SELECT ch.* FROM chats ch INDEXED BY chats_waiting LEFT JOIN handled h ON h.chat_id = ch.id
       WHERE ch.last_from_me = 0 AND ch.last_ts >= ? AND ch.last_ts <= ? AND ch.merged_into IS NULL
         AND ch.kind IN (SELECT value FROM json_each(?)) ${archived} ${handled}
         AND (ch.last_ts > ? OR (ch.last_ts = ? AND ch.id > ?))
       ORDER BY ch.last_ts ASC, ch.id ASC LIMIT ?`,
      options.since,
      options.until,
      JSON.stringify(kinds),
      ...(options.includeHandled === true ? [] : [this.c.now()]),
      options.after?.lastTs ?? -1,
      options.after?.lastTs ?? -1,
      options.after?.id ?? -1,
      limit + 1
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lasts = new Map(
      this.c
        .all<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.id IN (SELECT value FROM json_each(?))`,
          idsJson(page.map((row) => row.last_message_id!))
        )
        .map((row) => [row.id, row])
    );
    const items: WaitingCandidate[] = [];
    for (const row of page) {
      const chat = chatFromRow(row);
      const last = this.lastOf(chat, lasts.get(row.last_message_id!));
      if (last === null || last.fromMe || last.ts < options.since || last.ts > options.until) continue;
      items.push({ chat, last, handled: this.identity.handledByChatId(chat.id) });
    }
    const tail = page[page.length - 1];
    return { items, next: hasMore && tail !== undefined ? { lastTs: tail.last_ts!, id: tail.id } : null };
  }

  /**
   * When the newest visible message someone else sent arrived, stories
   * included: what status reports as the last sign of a live phone. Walks
   * the primary key back from the newest message to the first one that is not
   * the user's own.
   */
  lastInboundTs(): number | null {
    const row = this.c.get<{ ts: number }>(
      `SELECT m.ts FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
       WHERE m.from_me = 0 AND ${VISIBLE} ORDER BY m.id DESC LIMIT 1`,
      this.c.now()
    );
    return row?.ts ?? null;
  }

  /** The oldest and newest visible message, of one chat or of the account, read off an index. */
  coverage(chatJid?: string): Coverage {
    const now = this.c.now();
    type Edge = { id: number; sid: string; ts: number };
    let inChat = { sql: "1", params: [] as Array<number | string> };
    if (chatJid !== undefined) {
      const chat = this.identity.chat(chatJid);
      if (chat === null) return { oldest: null, newest: null };
      inChat = chatCondition(this.identity.chatIdsOf(chat));
    }
    const edge = (order: "ASC" | "DESC"): Edge | null =>
      this.c.get<Edge>(
        `SELECT m.id, ${SID_EXPR} AS sid, m.ts FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
           LEFT JOIN chats ck ON ck.id = c.merged_into
         WHERE ${inChat.sql} AND ${VISIBLE} ORDER BY m.id ${order} LIMIT 1`,
        ...inChat.params,
        now
      ) ?? null;
    return { oldest: edge("ASC"), newest: edge("DESC") };
  }

  /**
   * How the user writes in a chat: their own text messages there in the last
   * `days` (90), newest first, at most STYLE_SAMPLE of them; with fewer than
   * STYLE_MIN_OWN, their own messages across the account instead (`scope`
   * says which). `excludeViaWazap` (the default) leaves out what wazap sent,
   * so an assistant does not learn its own style back — and, from before
   * via_wazap was recorded (viaWazapKnownAfter: an upgrade to v5, an import),
   * every own message under a key shaped like Baileys' (WhatsApp Web's too),
   * keeping what was written on the phone. Null for a chat the account does
   * not know.
   */
  styleFor(chatJid: string, options: { days?: number; excludeViaWazap?: boolean } = {}): StyleStats | null {
    const chat = this.identity.chat(chatJid);
    if (chat === null) return null;
    const days = Math.max(1, Math.floor(options.days ?? STYLE_DAYS));
    const lower = idLowerBound(Math.max(1, this.c.now() - days * 86_400_000));
    const knownAfter = this.viaWazapKnownAfter();
    const unknownBefore = knownAfter === 0 ? "" : `AND (m.ts >= ${knownAfter} OR NOT ${BAILEYS_KEY_SQL})`;
    const skipOwnSends = options.excludeViaWazap === false ? "" : `AND (m.flags & ${MESSAGE_FLAGS.viaWazap}) = 0 ${unknownBefore}`;
    const inChat = chatCondition(this.identity.chatIdsOf(chat));
    const own = (where: string, params: Array<number | string>, limit: number): string[] =>
      this.c
        .all<{ text: string }>(
          `SELECT m.text FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
           WHERE ${where} AND m.from_me = 1 AND m.deleted_at IS NULL AND m.id >= ? AND m.type = 'text' AND m.text IS NOT NULL
             AND (m.expires_at IS NULL OR m.expires_at > ?) AND m.ts > coalesce(c.cleared_through_ts, 0) ${skipOwnSends}
           ORDER BY m.id DESC LIMIT ?`,
          ...params,
          lower,
          this.c.now(),
          limit
        )
        .map((row) => row.text);
    const inThisChat = own(inChat.sql, inChat.params, STYLE_SAMPLE);
    if (inThisChat.length >= STYLE_MIN_OWN) {
      return styleOf(inThisChat, { own_messages: inThisChat.length, days, scope: "chat" }, { oneToOne: chat.kind === "direct" });
    }
    const account = own("c.kind IN ('direct', 'group')", [], STYLE_ACCOUNT_SAMPLE);
    return styleOf(account, { own_messages: account.length, days, scope: "account" });
  }

  /**
   * The other side's last `limit` text messages in this chat, newest first,
   * within `days`: what says which language they write in. styleFor answers
   * about the user, and falls back to the whole account when they have written
   * too little here — which says nothing about this one chat. What the other
   * side writes is the evidence left, and it is read only for its language.
   */
  theirTexts(chatJid: string, options: { days?: number; limit?: number } = {}): string[] {
    const chat = this.identity.chat(chatJid);
    if (chat === null) return [];
    const days = Math.max(1, Math.floor(options.days ?? STYLE_DAYS));
    const lower = idLowerBound(Math.max(1, this.c.now() - days * 86_400_000));
    const inChat = chatCondition(this.identity.chatIdsOf(chat));
    return this.c
      .all<{ text: string }>(
        `SELECT m.text FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
         WHERE ${inChat.sql} AND m.from_me = 0 AND m.deleted_at IS NULL AND m.id >= ? AND m.type = 'text' AND m.text IS NOT NULL
           AND (m.expires_at IS NULL OR m.expires_at > ?) AND m.ts > coalesce(c.cleared_through_ts, 0)
         ORDER BY m.id DESC LIMIT ?`,
        ...inChat.params,
        lower,
        this.c.now(),
        Math.max(1, Math.floor(options.limit ?? STYLE_SAMPLE))
      )
      .map((row) => row.text);
  }

  /**
   * The last `limit` (8) messages a reader sees in a chat, both ways, oldest
   * first, each cut to `maxChars` (200): what a draft is written after. A
   * voice note or audio with a transcript reads as its transcript; any other
   * media as the placeholder it is stored with ("[image] caption"); system
   * notices are left out.
   *
   * It returns what the messages say, whatever the user filed about the chat:
   * the caller gates it — a contact tagged `#private` gets style statistics
   * only, and the account setting that turns the draft context off gets
   * nothing (design D4). The storage layer does not read tags for this.
   */
  recentExchange(chatJid: string, options: { limit?: number; maxChars?: number } = {}): RecentExchangeItem[] {
    const chat = this.identity.chat(chatJid);
    if (chat === null) return [];
    const limit = Math.max(1, Math.min(MAX_PAGE, Math.floor(options.limit ?? 8)));
    const maxChars = Math.max(2, Math.floor(options.maxChars ?? 200));
    const family = this.identity.chatIdsOf(chat);
    const inChat = chatCondition(family);
    const once = foldTwinCondition(family, chat.id);
    const rows = this.c.all<{
      id: number;
      sid: string;
      from_me: number;
      sender_jid: string | null;
      ts: number;
      type: string;
      text: string | null;
      transcript: string | null;
    }>(
      `SELECT m.id, ${SID_EXPR} AS sid, m.from_me, coalesce(s.phone_jid, s.lid, sk.phone_jid, sk.lid) AS sender_jid, m.ts, m.type, m.text, m.transcript
       FROM messages m CROSS JOIN chats c ON c.id = m.chat_id LEFT JOIN chats ck ON ck.id = c.merged_into
         LEFT JOIN contacts s ON s.id = m.sender_id LEFT JOIN contacts sk ON sk.id = s.merged_into
       WHERE ${inChat.sql} AND ${VISIBLE} AND m.type <> 'system' ${once.sql}
       ORDER BY m.id DESC LIMIT ?`,
      ...inChat.params,
      this.c.now(),
      ...once.params,
      limit
    );
    return rows.reverse().map((row) => {
      const spoken = (row.type === "voice" || row.type === "audio") && row.transcript !== null && row.transcript.trim() !== "";
      const full = spoken ? row.transcript!.trim() : (row.text ?? `[${row.type}]`);
      const chars = [...full];
      const truncated = chars.length > maxChars;
      return {
        id: row.id,
        sid: row.sid,
        fromMe: row.from_me === 1,
        senderJid: row.sender_jid,
        ts: row.ts,
        type: row.type,
        text: truncated ? `${chars.slice(0, maxChars - 1).join("")}…` : full,
        transcribed: spoken,
        truncated,
      };
    });
  }

  /** Rows and tombstones of one chat above its clear barrier; what an import compares against its source. */
  countInChat(chatJid: string): { messages: number; tombstones: number } {
    const chat = this.identity.chat(chatJid);
    if (chat === null) return { messages: 0, tombstones: 0 };
    const inChat = chatCondition(this.identity.chatIdsOf(chat));
    const row = this.c.get<{ total: number; tombstones: number }>(
      `SELECT count(*) AS total, count(m.deleted_at) AS tombstones FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
       WHERE ${inChat.sql} AND m.ts > coalesce(c.cleared_through_ts, 0)`,
      ...inChat.params
    )!;
    return { messages: row.total - row.tombstones, tombstones: row.tombstones };
  }
}
