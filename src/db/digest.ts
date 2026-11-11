/**
 * The reads a catch-up digest is built from (catch_up, F2-2): aggregates over a
 * window of messages, never a protobuf. A window is a span: message ids (the
 * order messages were sent in) above a floor and up to the newest the account
 * held, and stored_seq (the order they reached the account) after a mark and
 * up to the newest handed out. Every read is bounded above by both tops, fixed
 * when the digest started, so nothing stored while it is built is half in it;
 * below by the window's start or a chat's own floor (the user's last word, the
 * phone's read mark). A window by time bounds only the ids below (afterSeq -1);
 * a window since a catch-up mark bounds stored_seq, so a message filed late
 * (a call when it ends, a retried decryption) is still in the next one.
 *
 *   const span = { afterId, untilId: db.digest.maxId(), afterSeq: mark, untilSeq: db.digest.storedTop() };
 *   for (const [chatId, low] of db.digest.chatsStoredIn(span)) {
 *     const family = families.get(chatId) ?? [chatId];
 *     db.digest.inbound(family, { ...span, afterId: Math.max(floor, low - 1) }, now);   // counts, senders, media, mentions, replies
 *   }
 *
 * A chat still folding into another reads as part of it: callers pass the
 * chat's family (itself and the chats folding into it), and window-wide reads
 * name the chat a message reads under. "Inbound" is someone else's message a
 * reader may see — not a tombstone, not expired, not under the clear barrier —
 * that is not one of WhatsApp's own notices.
 */
import { sqlLimit, type Connection } from "./connection.js";
import { STORED_SEQ_TOP } from "./messages.js";
import { chatFromRow, type ChatRow } from "./rows.js";
import type { ChatRecord } from "./types.js";

/** `m` a reader may see and someone else sent, not a notice; needs `m` and its chat `c`, binds now. */
const INBOUND = `m.from_me = 0 AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?)
  AND m.ts > coalesce(c.cleared_through_ts, 0) AND m.type <> 'system'`;

/**
 * Messages with an id in (afterId, untilId] that reached the account in
 * (afterSeq, untilSeq]; afterSeq -1 bounds nothing below. A message stored
 * before v5 has no stored_seq and reads as 0: before every mark. Nothing sent
 * by a contact in `excludeSenders` is read at all.
 */
export interface DigestSpan {
  afterId: number;
  untilId: number;
  afterSeq: number;
  untilSeq: number;
  excludeSenders?: ReadonlySet<number>;
}

/** A span over `m`, as SQL and its parameters. */
function spanOf(span: DigestSpan): { sql: string; params: Array<number | string> } {
  const bounds = "m.id > ? AND m.id <= ? AND coalesce(m.stored_seq, 0) > ? AND coalesce(m.stored_seq, 0) <= ?";
  const params: Array<number | string> = [span.afterId, span.untilId, span.afterSeq, span.untilSeq];
  if (span.excludeSenders === undefined || span.excludeSenders.size === 0) return { sql: bounds, params };
  return {
    sql: `${bounds} AND (m.sender_id IS NULL OR m.sender_id NOT IN (SELECT value FROM json_each(?)))`,
    params: [...params, JSON.stringify([...span.excludeSenders])],
  };
}

/** One chat of a batched read: the chat (a family of one) and the id its reads start after. */
export interface ChatFloor {
  chatId: number;
  afterId: number;
}

/**
 * A batched read's chats as `j` (json_each of [chatId, afterId] pairs) joined
 * to `m` over messages_chat, and the rest of the span as SQL: everything but
 * the floor is the same for every chat of the batch.
 */
function batchOf(chats: readonly ChatFloor[], span: Omit<DigestSpan, "afterId">): { from: string; sql: string; params: Array<number | string> } {
  const bounds = "m.id <= ? AND coalesce(m.stored_seq, 0) > ? AND coalesce(m.stored_seq, 0) <= ?";
  const params: Array<number | string> = [JSON.stringify(chats.map((chat) => [chat.chatId, chat.afterId])), span.untilId, span.afterSeq, span.untilSeq];
  const from = `json_each(?) j CROSS JOIN messages m ON m.chat_id = j.value ->> 0 AND m.id > j.value ->> 1 CROSS JOIN chats c ON c.id = m.chat_id`;
  if (span.excludeSenders === undefined || span.excludeSenders.size === 0) return { from, sql: bounds, params };
  return {
    from,
    sql: `${bounds} AND (m.sender_id IS NULL OR m.sender_id NOT IN (SELECT value FROM json_each(?)))`,
    params: [...params, JSON.stringify([...span.excludeSenders])],
  };
}

/** Media kinds a digest counts by type. */
export const DIGEST_MEDIA = ["image", "video", "voice", "audio", "document", "sticker", "location", "contact"] as const;
export type DigestMedia = (typeof DIGEST_MEDIA)[number];
/** The kinds catch_up names by id for get_media: what it opens as a view or as text. */
export const OPENED_MEDIA: readonly DigestMedia[] = ["image", "video", "document", "sticker", "audio"];

/** The columns of an InboundAggregate over `m`, as inbound() and inboundMany() select them. */
const INBOUND_AGGREGATE = `sum(m.type <> 'call') AS count, count(DISTINCT CASE WHEN m.type <> 'call' THEN m.sender_id END) AS senders,
  max(CASE WHEN m.type <> 'call' THEN m.id END) AS newest_id, max(CASE WHEN m.type <> 'call' THEN m.ts END) AS newest_ts,
  ${DIGEST_MEDIA.map((type) => `sum(m.type = '${type}') AS media_${type}`).join(", ")},
  sum(m.type IN ('poll', 'event')) AS polls,
  sum((m.flags & 1) <> 0) AS mentions, max(CASE WHEN (m.flags & 1) <> 0 THEN m.id END) AS last_mention,
  sum(m.quoted_from_me = 1) AS replies, max(CASE WHEN m.quoted_from_me = 1 THEN m.id END) AS last_reply,
  sum(m.type = 'voice' AND m.transcript IS NULL) AS voice_untranscribed`;

function aggregateOf(row: Record<string, number | null>): InboundAggregate {
  const media: Partial<Record<DigestMedia, number>> = {};
  for (const type of DIGEST_MEDIA) {
    const n = row[`media_${type}`] ?? 0;
    if (n > 0) media[type] = n;
  }
  return {
    count: row.count ?? 0,
    senders: row.senders ?? 0,
    newestId: row.newest_id ?? null,
    newestTs: row.newest_ts ?? null,
    media,
    polls: row.polls ?? 0,
    mentions: row.mentions ?? 0,
    lastMentionId: row.last_mention ?? null,
    replies: row.replies ?? 0,
    lastReplyId: row.last_reply ?? null,
    voiceUntranscribed: row.voice_untranscribed ?? 0,
  };
}

export interface InboundAggregate {
  /** Inbound messages, calls left out (a call is its own section). */
  count: number;
  senders: number;
  newestId: number | null;
  newestTs: number | null;
  media: Partial<Record<DigestMedia, number>>;
  /** Polls and events. */
  polls: number;
  mentions: number;
  lastMentionId: number | null;
  replies: number;
  lastReplyId: number | null;
  /** Voice notes without a transcript. */
  voiceUntranscribed: number;
}

export interface TailMessage {
  id: number;
  /** When it reached the account (stored_seq, 0 before v5). */
  storedSeq: number;
  keyId: string;
  ts: number;
  type: string;
  flags: number;
  quotedFromMe: boolean;
  senderId: number | null;
  text: string;
  transcript: string | null;
}

export interface WindowMessage {
  id: number;
  /** When it reached the account (stored_seq, 0 before v5). */
  storedSeq: number;
  keyId: string;
  /** The chat it reads under: the one its chat folds into, while that fold runs. */
  chatId: number;
  chatJid: string;
  fromMe: boolean;
  senderId: number | null;
  ts: number;
  type: string;
  text: string;
}

export interface DigestContact {
  id: number;
  jid: string | null;
  name: string | null;
  verifiedName: string | null;
  listed: number | null;
}

function familyCondition(family: readonly number[]): { sql: string; params: Array<number | string> } {
  return family.length === 1
    ? { sql: "m.chat_id = ?", params: [family[0]!] }
    : { sql: "m.chat_id IN (SELECT value FROM json_each(?))", params: [JSON.stringify(family)] };
}

export class Digest {
  constructor(private readonly c: Connection) {}

  /** The newest message id the account holds, whatever it is: the top a digest fixes when it starts. */
  maxId(): number {
    return this.c.get<{ id: number | null }>("SELECT max(id) AS id FROM messages")?.id ?? 0;
  }

  /** The newest stored_seq handed out: the top a digest fixes when it starts, with maxId. */
  storedTop(): number {
    return this.c.get<{ top: number }>(`SELECT ${STORED_SEQ_TOP} AS top`)?.top ?? 0;
  }

  /**
   * The chats something reached in the span, stored_seq bounded (afterSeq ≥ 0),
   * each with the lowest id that did: where the chat's reads start, however
   * late a message was filed. Keyed by the chat the row sits under; the caller
   * folds a chat into the one it merges into. Off the messages_stored index alone.
   */
  chatsStoredIn(span: DigestSpan): Map<number, number> {
    return new Map(
      this.c
        .all<{ chat_id: number; low: number }>(
          `SELECT m.chat_id, min(m.id) AS low FROM messages m INDEXED BY messages_stored
           WHERE m.stored_seq > ? AND m.stored_seq <= ? AND m.id > ? AND m.id <= ? GROUP BY m.chat_id`,
          Math.max(0, span.afterSeq),
          span.untilSeq,
          span.afterId,
          span.untilId
        )
        .map((row) => [row.chat_id, row.low])
    );
  }

  /**
   * Chats by id, each read as the chat it folds into while a fold runs, with
   * the ids asked for under it: newest first, as chatsActiveSince lists them.
   */
  chatsByIds(ids: Iterable<number>): Array<{ chat: ChatRecord; asked: number[] }> {
    const out = new Map<number, { chat: ChatRecord; asked: number[] }>();
    for (const row of this.c.all<ChatRow & { asked: number }>(
      `SELECT j.value AS asked, h.* FROM json_each(?) j CROSS JOIN chats c ON c.id = j.value
         CROSS JOIN chats h ON h.id = coalesce(c.merged_into, c.id)
       WHERE h.merged_into IS NULL ORDER BY h.last_ts DESC, h.id DESC`,
      JSON.stringify([...new Set(ids)])
    )) {
      const entry = out.get(row.id) ?? { chat: chatFromRow(row), asked: [] };
      entry.asked.push(row.asked);
      out.set(row.id, entry);
    }
    return [...out.values()];
  }

  /** Chats (not folding into another) whose newest visible message is at or after `ts`, newest first. */
  chatsActiveSince(ts: number): ChatRecord[] {
    return this.c
      .all<ChatRow>(
        `SELECT * FROM chats INDEXED BY chats_recent WHERE last_ts >= ? AND merged_into IS NULL ORDER BY last_ts DESC, id DESC`,
        ts
      )
      .map(chatFromRow);
  }

  /** Each chat with others still folding into it, and those others: whose messages read as its own. */
  families(): Map<number, number[]> {
    const families = new Map<number, number[]>();
    for (const row of this.c.all<{ id: number; merged_into: number }>(
      "SELECT id, merged_into FROM chats INDEXED BY chats_merging WHERE merged_into IS NOT NULL ORDER BY id"
    )) {
      const family = families.get(row.merged_into) ?? [row.merged_into];
      family.push(row.id);
      families.set(row.merged_into, family);
    }
    return families;
  }

  /** The newest message of the user's own in the chat at or before `untilId`, walked back off messages_own. */
  ownThrough(family: readonly number[], untilId: number): number | null {
    const inChat = familyCondition(family);
    return (
      this.c.get<{ id: number | null }>(
        `SELECT max(m.id) AS id FROM messages m INDEXED BY messages_own
         WHERE ${inChat.sql} AND m.from_me = 1 AND m.deleted_at IS NULL AND m.id <= ?`,
        ...inChat.params,
        untilId
      )?.id ?? null
    );
  }

  /** Whether the user wrote in the chat in (afterId, untilId] — a message, not a call — off messages_own. */
  ownWroteIn(family: readonly number[], afterId: number, untilId: number): boolean {
    const inChat = familyCondition(family);
    return (
      this.c.get(
        `SELECT 1 FROM messages m INDEXED BY messages_own
         WHERE ${inChat.sql} AND m.from_me = 1 AND m.deleted_at IS NULL AND m.id > ? AND m.id <= ? AND m.type NOT IN ('call', 'system')
         LIMIT 1`,
        ...inChat.params,
        afterId,
        untilId
      ) !== undefined
    );
  }

  /** What someone else sent in the chat in the span, in one pass over its (chat_id, id) index. */
  inbound(family: readonly number[], span: DigestSpan, now: number): InboundAggregate {
    const inSpan = spanOf(span);
    const inChat = familyCondition(family);
    const row = this.c.get<Record<string, number | null>>(
      `SELECT ${INBOUND_AGGREGATE}
       FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
       WHERE ${inChat.sql} AND ${inSpan.sql} AND ${INBOUND}`,
      ...inChat.params,
      ...inSpan.params,
      now
    )!;
    return aggregateOf(row);
  }

  /**
   * inbound() for many chats in one statement: each a family of one with its
   * own floor, the rest of the span shared. In the order asked; a chat with
   * nothing in its span reads as inbound() reads it, all zeros.
   */
  inboundMany(chats: readonly ChatFloor[], span: Omit<DigestSpan, "afterId">, now: number): InboundAggregate[] {
    if (chats.length === 0) return [];
    const batch = batchOf(chats, span);
    const rows = new Map<number, Record<string, number | null>>();
    for (const row of this.c.all<Record<string, number | null> & { k: number }>(
      `SELECT j.key AS k, ${INBOUND_AGGREGATE} FROM ${batch.from} WHERE ${batch.sql} AND ${INBOUND} GROUP BY j.key`,
      ...batch.params,
      now
    )) {
      rows.set(row.k, row);
    }
    return chats.map((_chat, index) => aggregateOf(rows.get(index) ?? {}));
  }

  /** topSenders() for many chats in one statement, as inboundMany() takes them; in the order asked. */
  topSendersMany(chats: readonly ChatFloor[], span: Omit<DigestSpan, "afterId">, now: number, limit = 3): Array<Array<{ senderId: number; count: number }>> {
    const out = chats.map(() => [] as Array<{ senderId: number; count: number }>);
    if (chats.length === 0) return out;
    const batch = batchOf(chats, span);
    for (const row of this.c.all<{ k: number; sender_id: number; n: number }>(
      `SELECT k, sender_id, n FROM (
         SELECT j.key AS k, m.sender_id, count(*) AS n,
           row_number() OVER (PARTITION BY j.key ORDER BY count(*) DESC, max(m.id) DESC) AS place
         FROM ${batch.from}
         WHERE ${batch.sql} AND ${INBOUND} AND m.type <> 'call' AND m.sender_id IS NOT NULL
         GROUP BY j.key, m.sender_id)
       WHERE place <= ${sqlLimit(limit)} ORDER BY k, place`,
      ...batch.params,
      now
    )) {
      out[row.k]!.push({ senderId: row.sender_id, count: row.n });
    }
    return out;
  }

  /** mostReacted() for many chats in one statement, as inboundMany() takes them; in the order asked, null where none qualifies. */
  mostReactedMany(
    chats: readonly ChatFloor[],
    span: Omit<DigestSpan, "afterId">,
    now: number,
    options: { min?: number; excludeSenders?: ReadonlySet<number> } = {}
  ): Array<number | null> {
    const out: Array<number | null> = chats.map(() => null);
    if (chats.length === 0) return out;
    const batch = batchOf(chats, span);
    for (const row of this.c.all<{ k: number; id: number }>(
      `SELECT k, id FROM (
         SELECT j.key AS k, m.id, row_number() OVER (PARTITION BY j.key ORDER BY count(*) DESC, m.id DESC) AS place
         FROM ${batch.from} CROSS JOIN reactions r ON r.message_id = m.id
         WHERE ${batch.sql} AND ${INBOUND}
           AND (m.sender_id IS NULL OR m.sender_id NOT IN (SELECT value FROM json_each(?)))
         GROUP BY j.key, m.id HAVING count(*) >= ?)
       WHERE place = 1`,
      ...batch.params,
      now,
      JSON.stringify([...(options.excludeSenders ?? [])]),
      options.min ?? 2
    )) {
      out[row.k] = row.id;
    }
    return out;
  }

  /** How many inbound messages the chat holds in the span, counting at most `cap`. */
  inboundCount(family: readonly number[], span: DigestSpan, now: number, cap: number): number {
    const inSpan = spanOf(span);
    const inChat = familyCondition(family);
    return (
      this.c.get<{ n: number }>(
        `SELECT count(*) AS n FROM (SELECT 1 FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
           WHERE ${inChat.sql} AND ${inSpan.sql} AND ${INBOUND} AND m.type <> 'call' LIMIT ${sqlLimit(cap)})`,
        ...inChat.params,
        ...inSpan.params,
        now
      )?.n ?? 0
    );
  }

  /**
   * The newest inbound messages of the chat in the span, newest
   * first, with the words they read as: `text` is the stored rendering, cut to
   * `maxChars`, and a voice note's transcript rides along.
   */
  inboundTail(family: readonly number[], span: DigestSpan, now: number, limit: number, maxChars = 2000): TailMessage[] {
    const inSpan = spanOf(span);
    const inChat = familyCondition(family);
    return this.c
      .all<{
        id: number;
        stored_seq: number;
        key_id: string;
        ts: number;
        type: string;
        flags: number;
        quoted_from_me: number | null;
        sender_id: number | null;
        text: string | null;
        transcript: string | null;
      }>(
        `SELECT m.id, coalesce(m.stored_seq, 0) AS stored_seq, m.key_id, m.ts, m.type, m.flags, m.quoted_from_me, m.sender_id,
           substr(m.text, 1, ${sqlLimit(maxChars)}) AS text, substr(m.transcript, 1, ${sqlLimit(maxChars)}) AS transcript
         FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
         WHERE ${inChat.sql} AND ${inSpan.sql} AND ${INBOUND} AND m.type <> 'call'
         ORDER BY m.id DESC LIMIT ${sqlLimit(limit)}`,
        ...inChat.params,
        ...inSpan.params,
        now
      )
      .map((row) => ({
        id: row.id,
        storedSeq: row.stored_seq,
        keyId: row.key_id,
        ts: row.ts,
        type: row.type,
        flags: row.flags,
        quotedFromMe: row.quoted_from_me === 1,
        senderId: row.sender_id,
        text: row.text ?? "",
        transcript: row.transcript,
      }));
  }

  /** Who wrote most in the chat in the span, at most `limit`, the most recent first among equals. */
  topSenders(family: readonly number[], span: DigestSpan, now: number, limit = 3): Array<{ senderId: number; count: number }> {
    const inSpan = spanOf(span);
    const inChat = familyCondition(family);
    return this.c
      .all<{ sender_id: number; n: number }>(
        `SELECT m.sender_id, count(*) AS n FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
         WHERE ${inChat.sql} AND ${inSpan.sql} AND ${INBOUND} AND m.type <> 'call' AND m.sender_id IS NOT NULL
         GROUP BY m.sender_id ORDER BY n DESC, max(m.id) DESC LIMIT ${sqlLimit(limit)}`,
        ...inChat.params,
        ...inSpan.params,
        now
      )
      .map((row) => ({ senderId: row.sender_id, count: row.n }));
  }

  /** The inbound message in the span with the most reactions, when at least `min` people reacted, from nobody in `excludeSenders`. */
  mostReacted(
    family: readonly number[],
    span: DigestSpan,
    now: number,
    options: { min?: number; excludeSenders?: ReadonlySet<number> } = {}
  ): number | null {
    const inChat = familyCondition(family);
    const inSpan = spanOf(span);
    return (
      this.c.get<{ id: number }>(
        `SELECT m.id FROM messages m CROSS JOIN chats c ON c.id = m.chat_id CROSS JOIN reactions r ON r.message_id = m.id
         WHERE ${inChat.sql} AND ${inSpan.sql} AND ${INBOUND}
           AND (m.sender_id IS NULL OR m.sender_id NOT IN (SELECT value FROM json_each(?)))
         GROUP BY m.id HAVING count(*) >= ? ORDER BY count(*) DESC, m.id DESC LIMIT 1`,
        ...inChat.params,
        ...inSpan.params,
        now,
        JSON.stringify([...(options.excludeSenders ?? [])]),
        options.min ?? 2
      )?.id ?? null
    );
  }

  /** Voice notes someone sent in the span that have no transcript, newest first. */
  untranscribedVoice(family: readonly number[], span: DigestSpan, now: number, limit: number): Array<{ id: number; keyId: string }> {
    const inSpan = spanOf(span);
    const inChat = familyCondition(family);
    return this.c
      .all<{ id: number; key_id: string }>(
        `SELECT m.id, m.key_id FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
         WHERE ${inChat.sql} AND ${inSpan.sql} AND ${INBOUND} AND m.type = 'voice' AND m.transcript IS NULL
         ORDER BY m.id DESC LIMIT ${sqlLimit(limit)}`,
        ...inChat.params,
        ...inSpan.params,
        now
      )
      .map((row) => ({ id: row.id, keyId: row.key_id }));
  }

  /**
   * The newest media someone sent in the span that get_media opens as a view
   * or text (photos, videos, documents, stickers, audio files; a voice note
   * is a transcript, and the footer names those), newest first.
   */
  mediaTail(family: readonly number[], span: DigestSpan, now: number, limit: number): Array<{ id: number; keyId: string; type: string }> {
    const inSpan = spanOf(span);
    const inChat = familyCondition(family);
    return this.c
      .all<{ id: number; key_id: string; type: string }>(
        `SELECT m.id, m.key_id, m.type FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
         WHERE ${inChat.sql} AND ${inSpan.sql} AND ${INBOUND} AND m.type IN (${OPENED_MEDIA.map((type) => `'${type}'`).join(", ")})
         ORDER BY m.id DESC LIMIT ${sqlLimit(limit)}`,
        ...inChat.params,
        ...inSpan.params,
        now
      )
      .map((row) => ({ id: row.id, keyId: row.key_id, type: row.type }));
  }

  /** Every handled mark, by the chat it was filed under. */
  handled(): Map<number, { askId: number | null; at: number }> {
    return new Map(
      this.c
        .all<{ chat_id: number; ask_message_id: number | null; at: number }>("SELECT chat_id, ask_message_id, at FROM handled")
        .map((row) => [row.chat_id, { askId: row.ask_message_id, at: row.at }])
    );
  }

  /** The calls in the span, both ways, oldest first, off the messages_calls index. */
  calls(span: DigestSpan, now: number): WindowMessage[] {
    return this.windowRows("messages_calls", "m.type = 'call'", span, now);
  }

  /** Polls and events someone else posted in the span that `voterId` has not answered, oldest first. */
  openPolls(span: DigestSpan, now: number, voterId: number | null): WindowMessage[] {
    return this.windowRows(
      "messages_polls",
      "m.type IN ('poll', 'event') AND m.from_me = 0 AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.message_id = m.id AND v.contact_id = ?)",
      span,
      now,
      [voterId ?? -1]
    );
  }

  private windowRows(index: string, where: string, span: DigestSpan, now: number, params: number[] = []): WindowMessage[] {
    const inSpan = spanOf(span);
    return this.c
      .all<{
        id: number;
        stored_seq: number;
        key_id: string;
        chat_id: number;
        chat_jid: string;
        from_me: number;
        sender_id: number | null;
        ts: number;
        type: string;
        text: string | null;
      }>(
        `SELECT m.id, coalesce(m.stored_seq, 0) AS stored_seq, m.key_id, coalesce(ck.id, c.id) AS chat_id, coalesce(ck.jid, c.jid) AS chat_jid,
           m.from_me, m.sender_id, m.ts, m.type, substr(m.text, 1, 300) AS text
         FROM messages m INDEXED BY ${index} CROSS JOIN chats c ON c.id = m.chat_id LEFT JOIN chats ck ON ck.id = c.merged_into
         WHERE ${inSpan.sql} AND ${where} AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?)
           AND m.ts > coalesce(c.cleared_through_ts, 0)
         ORDER BY m.id`,
        ...inSpan.params,
        ...params,
        now
      )
      .map((row) => ({
        id: row.id,
        storedSeq: row.stored_seq,
        keyId: row.key_id,
        chatId: row.chat_id,
        chatJid: row.chat_jid,
        fromMe: row.from_me === 1,
        senderId: row.sender_id,
        ts: row.ts,
        type: row.type,
        text: row.text ?? "",
      }));
  }

  /** The stories someone posted in the span: how many, and their authors, the most recent first. */
  stories(statusChatId: number, span: DigestSpan, now: number): { count: number; authors: number[] } {
    const inSpan = spanOf(span);
    const rows = this.c.all<{ sender_id: number | null; n: number }>(
      `SELECT m.sender_id, count(*) AS n FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
       WHERE m.chat_id = ? AND ${inSpan.sql} AND ${INBOUND}
       GROUP BY m.sender_id ORDER BY max(m.id) DESC`,
      statusChatId,
      ...inSpan.params,
      now
    );
    return {
      count: rows.reduce((n, row) => n + row.n, 0),
      authors: rows.flatMap((row) => (row.sender_id === null ? [] : [row.sender_id])),
    };
  }

  /** People by contact id, the rows they merge into read in their place. */
  contacts(ids: readonly number[]): Map<number, DigestContact> {
    const out = new Map<number, DigestContact>();
    if (ids.length === 0) return out;
    for (const row of this.c.all<{
      asked: number;
      id: number;
      phone_jid: string | null;
      lid: string | null;
      name: string | null;
      verified_name: string | null;
      listed: number | null;
    }>(
      `SELECT j.value AS asked, k.id, k.phone_jid, k.lid, k.name, k.verified_name, k.listed
       FROM json_each(?) j CROSS JOIN contacts o ON o.id = j.value CROSS JOIN contacts k ON k.id = coalesce(o.merged_into, o.id)`,
      JSON.stringify([...new Set(ids)])
    )) {
      out.set(row.asked, { id: row.id, jid: row.phone_jid ?? row.lid, name: row.name, verifiedName: row.verified_name, listed: row.listed });
    }
    return out;
  }

  /**
   * The contacts (people, and the rows groups keep notes on) filed under `tag`,
   * and the people another account filed under it, named by `jids` (a number
   * or a lid, this account's lid pairings included): every row that is them —
   * the row a tagged one merges into, and the rows still merging into that
   * (digest.contacts reads them as it), so a message whose sender has not
   * moved over yet is theirs too — with their jids and `jids` themselves.
   */
  tagged(tag: string, jids: readonly string[] = []): { contactIds: Set<number>; jids: Set<string> } {
    const needle = JSON.stringify(tag);
    const survivors = new Set<number>();
    for (const row of this.c.all<{ survivor: number; tags: string }>(
      `SELECT coalesce(k.merged_into, k.id) AS survivor, n.tags FROM contact_notes n CROSS JOIN contacts k ON k.id = n.contact_id
       WHERE n.tags IS NOT NULL AND instr(n.tags, ?) > 0`,
      needle
    )) {
      let tags: unknown;
      try {
        tags = JSON.parse(row.tags);
      } catch {
        continue;
      }
      if (Array.isArray(tags) && tags.includes(tag)) survivors.add(row.survivor);
    }
    if (jids.length > 0) {
      for (const row of this.c.all<{ survivor: number }>(
        `SELECT coalesce(k.merged_into, k.id) AS survivor FROM json_each(?) j CROSS JOIN contacts k ON k.phone_jid = j.value
         UNION SELECT coalesce(k.merged_into, k.id) FROM json_each(?) j CROSS JOIN contacts k ON k.lid = j.value
         UNION SELECT coalesce(k.merged_into, k.id) FROM json_each(?) j CROSS JOIN lid_phones p ON p.lid = j.value
           CROSS JOIN contacts k ON k.phone_jid = p.phone_jid`,
        ...Array<string>(3).fill(JSON.stringify([...new Set(jids)]))
      )) {
        survivors.add(row.survivor);
      }
    }
    const contactIds = new Set<number>();
    const named = new Set<string>(jids);
    if (survivors.size === 0) return { contactIds, jids: named };
    for (const row of this.c.all<{ id: number; phone_jid: string | null; lid: string | null }>(
      `SELECT id, phone_jid, lid FROM contacts WHERE id IN (SELECT value FROM json_each(?))
       UNION SELECT id, phone_jid, lid FROM contacts INDEXED BY contacts_merging WHERE merged_into IN (SELECT value FROM json_each(?))`,
      ...Array<string>(2).fill(JSON.stringify([...survivors]))
    )) {
      contactIds.add(row.id);
      if (row.phone_jid !== null) named.add(row.phone_jid);
      if (row.lid !== null) named.add(row.lid);
    }
    return { contactIds, jids: named };
  }

  /** The status feed's chat row, if any story ever arrived. */
  statusChatId(): number | null {
    return this.c.get<{ id: number }>("SELECT id FROM chats WHERE jid = 'status@broadcast'")?.id ?? null;
  }
}
