/**
 * The shapes the account database takes and returns. Every time is epoch
 * milliseconds. A message's public identity is its sid,
 * `<fromMe>_<chatJid>_<keyId>`; the numeric id is chronological and internal.
 */

export type ChatKind = "direct" | "group" | "status" | "newsletter" | "broadcast";

export interface ContactRecord {
  id: number;
  phoneJid: string | null;
  lid: string | null;
  name: string | null;
  /** The name WhatsApp's contact sync gives. */
  notify: string | null;
  /** The name the person publishes on their own messages. */
  pushName: string | null;
  verifiedName: string | null;
  isBusiness: boolean | null;
  /** The address book's order: when a contact event first named them. Null for someone known only from messages. */
  listed: number | null;
  updatedAt: number;
}

export interface ContactInput {
  /** A phone jid or a lid; the contact is created when unknown. */
  jid: string;
  /** undefined keeps the stored value, null clears it. */
  name?: string | null;
  notify?: string | null;
  pushName?: string | null;
  verifiedName?: string | null;
  isBusiness?: boolean | null;
  /**
   * A contact event named this person: true puts them at the end of the
   * address book's order, once; a number is an explicit place (an import
   * keeping the order it read), and the earlier place wins.
   */
  listed?: true | number;
}

export interface ChatRecord {
  id: number;
  /** The canonical jid: the number once a pairing names it, for a direct chat. */
  jid: string;
  kind: ChatKind;
  contactId: number | null;
  name: string | null;
  archived: boolean;
  pinned: number | null;
  mutedUntil: number | null;
  unread: number;
  /** Messages at or before this instant are cleared and may not come back. */
  clearedThroughTs: number | null;
  lastMessageId: number | null;
  lastTs: number | null;
  lastFromMe: boolean | null;
  proto: Uint8Array | null;
  /** The newest message of the account's own a reader may see here (v5). */
  lastOwnId: number | null;
  /** The newest message the account's own devices reported read here; only moves forward (v5). */
  readThroughId: number | null;
}

export interface ChatInput {
  jid: string;
  kind?: ChatKind;
  name?: string | null;
  archived?: boolean;
  pinned?: number | null;
  mutedUntil?: number | null;
  unread?: number;
  proto?: Uint8Array | null;
}

/** A message is identified by its chat (any spelling), its direction and its WhatsApp key. */
export interface MessageInput {
  /** Archive imports may insert a new identity, never modify an existing row. */
  insertOnly?: boolean;
  chatJid: string;
  keyId: string;
  fromMe: boolean;
  /** Who wrote it. Omitted on an incoming direct message, the chat's contact is the sender. */
  senderJid?: string | null;
  /** The protocol timestamp; must be positive. */
  ts: number;
  type: string;
  /** The searchable rendering of the message. */
  text?: string | null;
  transcript?: string | null;
  /** Who made the transcript and when; kept with the transcript it describes. */
  transcriptInfo?: TranscriptInfo | null;
  /** The protobuf bytes. */
  raw?: Uint8Array | null;
  quotedSid?: string | null;
  status?: number | null;
  /** When this version was edited; a stored newer edit is never overwritten by an older version. */
  editedAt?: number | null;
  /** Absolute deadline; it can only ever move earlier. */
  expiresAt?: number | null;
  /**
   * MESSAGE_FLAGS bits the message carries (mentions_me, via_wazap). A stored
   * message only gains bits; via_wazap is also set by the database itself
   * when the key is a confirmed send's.
   */
  flags?: number;
}

/** The bits of messages.flags (v5). */
export const MESSAGE_FLAGS = Object.freeze({
  /** An incoming message whose mentions name the account, by number or lid. */
  mentionsMe: 1,
  /** The account's own message, sent through wazap. */
  viaWazap: 2,
});

export type UpsertOutcome =
  | "existing"
  /** A new row. */
  | "inserted"
  /** An existing row took the new version. */
  | "updated"
  /** An older version of a message whose newer edit is stored: content kept, bookkeeping merged. */
  | "stale"
  /** The message is a tombstone; nothing was written. */
  | "deleted"
  /** The chat was cleared through this message's time; nothing was written. */
  | "cleared"
  /**
   * Past its deadline. A message seen for the first time is stored as a
   * tombstone so a later replay cannot bring it back; a stored one is hidden
   * from reads and waits for the expiry sweep, which hands back its files.
   */
  | "expired";

export interface UpsertResult {
  outcome: UpsertOutcome;
  /** The row the message lives in; null when nothing was stored. */
  id: number | null;
  /** The public sid, over the chat's canonical jid. */
  sid: string | null;
}

/** The details of a transcript beyond its words. */
export interface TranscriptInfo {
  provider: string;
  /** Epoch ms. */
  at: number;
  language?: string;
  duration_seconds?: number;
}

export interface StoredMessage {
  id: number;
  /** `<fromMe>_<chat's canonical jid>_<keyId>`; every other spelling of it resolves to the same row. */
  sid: string;
  chatId: number;
  chatJid: string;
  keyId: string;
  fromMe: boolean;
  senderId: number | null;
  /** The sender contact's phone jid, or its lid while the number is unknown. */
  senderJid: string | null;
  ts: number;
  type: string;
  text: string | null;
  transcript: string | null;
  transcriptInfo: TranscriptInfo | null;
  raw: Uint8Array | null;
  quotedSid: string | null;
  status: number | null;
  editedAt: number | null;
  expiresAt: number | null;
  deletedAt: number | null;
  /** MESSAGE_FLAGS bits. */
  flags: number;
}

export interface Page<T> {
  items: T[];
  hasMore: boolean;
  /** Pass as `before` for the next, older page; null when there is none. */
  nextBefore: number | null;
}

export interface DeleteResult {
  /** "deleted": a live row became a tombstone; "placeholder": an unseen message got a tombstone ahead of it. */
  outcome: "deleted" | "already" | "placeholder" | "cleared";
  id: number | null;
  /**
   * Derived files (previews, downloads) this delete released: no row references
   * them any more. They are also queued in pendingUnlinks() until acknowledged.
   */
  mediaPaths: string[];
}

export interface BulkDeleteResult {
  /** Rows removed or tombstoned. */
  count: number;
  sids: string[];
  /** Files released by the operation; queued in pendingUnlinks() as well. */
  mediaPaths: string[];
}

export interface ChatListItem {
  chat: ChatRecord;
  last: StoredMessage | null;
}

export interface ChatCursor {
  lastTs: number;
  id: number;
}

export interface WaitingCandidate {
  chat: ChatRecord;
  /** Their message that has the last word. */
  last: StoredMessage;
  handled: HandledRecord | null;
}

export interface HandledRecord {
  askMessageId: number | null;
  askSid: string | null;
  at: number;
}

export interface ContactNotes {
  note: string | null;
  tags: string[];
  fields: Record<string, string>;
  updatedAt: number;
}

export interface FieldEdit {
  addTags?: string[];
  removeTags?: string[];
  set?: Record<string, string>;
  removeFields?: string[];
}

export interface Reaction {
  contactId: number;
  jid: string | null;
  emoji: string;
  ts: number;
}

export interface Vote {
  contactId: number;
  jid: string | null;
  choice: string;
  ts: number;
}

export interface Receipt {
  contactId: number;
  jid: string | null;
  deliveredAt: number | null;
  readAt: number | null;
  playedAt: number | null;
}

export interface MediaRecord {
  kind: string;
  path: string;
  createdAt: number;
}

export interface Coverage {
  oldest: { id: number; sid: string; ts: number } | null;
  newest: { id: number; sid: string; ts: number } | null;
}

/** What a search ran across; see Search.coverage. */
export interface SearchCoverage {
  messages: number;
  chats: number;
  oldestTs: number | null;
  newestTs: number | null;
}

export interface Counts {
  messages: number;
  tombstones: number;
  chats: number;
  contacts: number;
  embeddings: number;
}

/** What narrows a search or a scan; every field is optional. */
export interface MessageFilter {
  /** A chat jid in any known spelling. */
  chat?: string;
  /** "me", or a sender jid in any known spelling. */
  from?: string;
  /** Inclusive, epoch ms. */
  since?: number;
  /** Inclusive, epoch ms. */
  until?: number;
  /** A stored (normalized) tag: only the direct chats of the people filed under it. */
  tag?: string;
}

export interface TextSearchInput extends MessageFilter {
  query: string;
  limit: number;
  before?: number;
  /**
   * Candidates examined before the search stops and says so: FTS rows on the
   * trigram path (default 50,000), messages on the short-query scan (20,000).
   */
  scanCap?: number;
}

export interface TextSearchResult extends Page<StoredMessage> {
  /** "trigram" for queries of 3+ characters, "scan" for shorter ones. */
  mode: "trigram" | "scan";
  /** The cap stopped the search before it ran out of candidates: absence of a hit proves nothing. */
  scanCapped: boolean;
}

export interface MergeReport {
  /** The person's contact row after the pairing; null for resumeMerges, which finishes whatever was pending. */
  contactId: number | null;
  chatId: number | null;
  movedMessages: number;
  mediaPaths: string[];
}
