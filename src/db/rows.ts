/** SQL rows to records: the only place that knows both spellings of a column. */
import type { ChatKind, ChatRecord, ContactRecord, StoredMessage, TranscriptInfo } from "./types.js";

export interface ContactRow {
  id: number;
  phone_jid: string | null;
  lid: string | null;
  name: string | null;
  notify: string | null;
  push_name: string | null;
  verified_name: string | null;
  is_business: number | null;
  listed: number | null;
  updated_at: number;
  merged_into: number | null;
}

export interface ChatRow {
  id: number;
  jid: string;
  kind: string;
  contact_id: number | null;
  name: string | null;
  archived: number;
  pinned: number | null;
  muted_until: number | null;
  unread: number;
  cleared_through_ts: number | null;
  last_message_id: number | null;
  last_ts: number | null;
  last_from_me: number | null;
  proto: Uint8Array | null;
  merged_into: number | null;
  last_own_id: number | null;
  read_through_id: number | null;
  /** (v7) The conversationTimestamp the proto states, in seconds. */
  described_ts: number | null;
  /** (v7) Generated: what list_chats orders by. */
  activity: number;
}

export interface MessageRow {
  id: number;
  sid: string;
  chat_id: number;
  chat_jid: string;
  key_id: string;
  from_me: number;
  sender_id: number | null;
  sender_jid: string | null;
  ts: number;
  type: string;
  text: string | null;
  transcript: string | null;
  transcript_info: string | null;
  raw: Uint8Array | null;
  quoted_sid: string | null;
  status: number | null;
  edited_at: number | null;
  expires_at: number | null;
  deleted_at: number | null;
  flags: number;
}

/**
 * Columns for a full message; pair with MESSAGE_FROM. A row still sitting in a
 * chat that is folding into another reads as part of that other chat, and a
 * sender whose contact row is merging reads as the contact it merges into, so
 * nothing a reader sees depends on how far a merge has got.
 */
export const MESSAGE_COLUMNS = `m.id, coalesce(ck.id, c.id) AS chat_id, coalesce(ck.jid, c.jid) AS chat_jid,
  (CASE WHEN m.from_me = 1 THEN 'true' ELSE 'false' END) || '_' || coalesce(ck.jid, c.jid) || '_' || m.key_id AS sid,
  m.key_id, m.from_me, coalesce(sk.id, s.id) AS sender_id,
  coalesce(s.phone_jid, s.lid, sk.phone_jid, sk.lid) AS sender_jid, m.ts, m.type, m.quoted_sid, m.status, m.edited_at,
  m.expires_at, m.deleted_at, m.text, m.transcript, m.transcript_info, m.raw, m.flags`;

/** Messages drive the join, so a range or index scan over them is never reordered behind chats. */
export const MESSAGE_FROM = `messages m CROSS JOIN chats c ON c.id = m.chat_id LEFT JOIN chats ck ON ck.id = c.merged_into
  LEFT JOIN contacts s ON s.id = m.sender_id LEFT JOIN contacts sk ON sk.id = s.merged_into`;

/**
 * A row a reader may see: not a tombstone, not past its deadline, and not at
 * or before its chat's clear barrier — hidden from the moment the barrier is
 * stored, however far the physical purge has got. Needs `m` and its chat `c`;
 * binds one parameter, now.
 */
export const VISIBLE = `m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?) AND m.ts > coalesce(c.cleared_through_ts, 0)`;

/**
 * Recomputes a chat's last_* from what a reader may see in the chat and in
 * every chat folding into it: the newest of each one's newest visible row,
 * each found by walking its own (chat_id, id) index back. Binds the chat id.
 */
export const RECOMPUTE_LAST = `UPDATE chats SET (last_message_id, last_ts, last_from_me) = (
    SELECT m.id, m.ts, m.from_me FROM messages m WHERE m.id = (
      SELECT max((
        SELECT x.id FROM messages x
        WHERE x.chat_id = k.id AND x.deleted_at IS NULL
          AND x.id >= (coalesce(k.cleared_through_ts, 0) / 1000) * 1048576
          AND x.ts > coalesce(k.cleared_through_ts, 0)
        ORDER BY x.id DESC LIMIT 1))
      FROM chats k WHERE k.id = chats.id OR k.merged_into = chats.id))
  WHERE id = ?`;

export function contactFromRow(row: ContactRow): ContactRecord {
  return {
    id: row.id,
    phoneJid: row.phone_jid,
    lid: row.lid,
    name: row.name,
    notify: row.notify,
    pushName: row.push_name,
    verifiedName: row.verified_name,
    isBusiness: row.is_business === null ? null : row.is_business === 1,
    listed: row.listed,
    updatedAt: row.updated_at,
  };
}

export function chatFromRow(row: ChatRow): ChatRecord {
  return {
    id: row.id,
    jid: row.jid,
    kind: row.kind as ChatKind,
    contactId: row.contact_id,
    name: row.name,
    archived: row.archived === 1,
    pinned: row.pinned,
    mutedUntil: row.muted_until,
    unread: row.unread,
    clearedThroughTs: row.cleared_through_ts,
    lastMessageId: row.last_message_id,
    lastTs: row.last_ts,
    lastFromMe: row.last_from_me === null ? null : row.last_from_me === 1,
    proto: row.proto,
    lastOwnId: row.last_own_id,
    readThroughId: row.read_through_id,
  };
}

/** A stored transcript's details; a value that does not parse reads as none. */
export function transcriptInfoOf(json: string | null): TranscriptInfo | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as Partial<TranscriptInfo> | null;
    if (value === null || typeof value.provider !== "string" || typeof value.at !== "number") return null;
    return {
      provider: value.provider,
      at: value.at,
      ...(typeof value.language === "string" ? { language: value.language } : {}),
      ...(typeof value.duration_seconds === "number" ? { duration_seconds: value.duration_seconds } : {}),
    };
  } catch {
    return null;
  }
}

/** The JSON a transcript's details are stored as; null for none. */
export function transcriptInfoJson(info: TranscriptInfo | null | undefined): string | null {
  if (info === null || info === undefined) return null;
  return JSON.stringify({
    provider: info.provider,
    at: info.at,
    ...(info.language === undefined ? {} : { language: info.language }),
    ...(info.duration_seconds === undefined ? {} : { duration_seconds: info.duration_seconds }),
  });
}

export function messageFromRow(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    sid: row.sid,
    chatId: row.chat_id,
    chatJid: row.chat_jid,
    keyId: row.key_id,
    fromMe: row.from_me === 1,
    senderId: row.sender_id,
    senderJid: row.sender_jid,
    ts: row.ts,
    type: row.type,
    text: row.text,
    transcript: row.transcript,
    transcriptInfo: transcriptInfoOf(row.transcript_info),
    raw: row.raw,
    quotedSid: row.quoted_sid,
    status: row.status,
    editedAt: row.edited_at,
    expiresAt: row.expires_at,
    deletedAt: row.deleted_at,
    flags: row.flags,
  };
}
