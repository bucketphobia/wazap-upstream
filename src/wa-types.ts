/** Public shapes of the WhatsApp service: what the MCP tools and the CLI consume. */

import type { SearchCoverage } from "./coverage.js";
import type { DraftContext, StyleCheck } from "./draft-style.js";
import type { DraftPayload, DraftView } from "./drafts.js";
import type { CatchupQuote, CatchupScan, CatchupScanRequest, CatchupTagJids, CatchupWindow } from "./catchup-scan.js";
import type { AccountFind, FindContactQuery } from "./find-contact.js";
import type { RecallStatus } from "./recall/index.js";
import type { ProviderName } from "./transcribe/index.js";

export type ConnectionStatus =
  | "not_linked"
  /** A pairing code has been issued and WhatsApp is waiting for it on the phone. */
  | "linking"
  | "connecting"
  | "connected"
  | "disconnected"
  | "logged_out"
  | "session_corrupt"
  | "auth_failure";

export type SyncState = "in_progress" | "done";

export type ChatType = "individual" | "group";

export type ChatFilter = "all" | "unread" | "groups" | "individual" | "archived";

/** The zod enum the tools expose derives from this, so the two cannot drift. */
export const MESSAGE_TYPES = [
  "text",
  "image",
  "video",
  "audio",
  "voice",
  "document",
  "sticker",
  "location",
  "contact",
  "poll",
  "reaction",
  "deleted",
  "view_once",
  "call",
  "event",
  "invite",
  "system",
  "unknown",
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

export type CallKind = "voice" | "video";

export type CallDirection = "incoming" | "outgoing";

/** "unanswered" is the outgoing side of "missed": nobody picked up either way. */
export type CallOutcome = "answered" | "missed" | "rejected" | "unanswered";

export interface CallInfo {
  kind: CallKind;
  direction: CallDirection;
  outcome: CallOutcome;
  duration_seconds?: number;
  participants?: string[];
}

/** The code the user types into their phone, and how long it stays good for. */
export interface PairingInfo {
  code: string;
  phone_masked: string;
  expires_at: string;
}

export interface StatusInfo {
  status: ConnectionStatus;
  /** When the socket entered `status`. What /healthz calls a stall on. */
  status_since: string;
  sync: SyncState;
  account: { id: string; name: string; number: string } | null;
  /** Registry id (`default`, `work`, …), not the WhatsApp jid. */
  account_id: string;
  account_name: string;
  enabled: boolean;
  /**
   * Account writes policy (`!read_only`). `get_status` overwrites this key with
   * whether the current MCP session registered write tools.
   */
  write_tools: boolean;
  last_message_received_at: string | null;
  reconnect_attempts: number;
  /** Contacts carrying a name from the phone's address book. Zero means it never arrived. */
  contacts_named: number;
  wazap_version: string;
  baileys_version: string;
  data_dir: string;
  read_only: boolean;
  rate_limit: number;
  last_error: string | null;
  /** W1 outbound webhook: on/off, whether url+secret are present, delivery `last_error`. */
  webhook: WebhookInfo;
  /** Local semantic recall: off, or how far the index is from caught-up. */
  recall: RecallStatus;
  /** The account database: preparing, ready or failed, and the earlier message files it was imported from. */
  storage?: StorageInfo;
  /** Voice notes transcribed without being asked: the durable queue, without content. */
  transcription: TranscriptionStatus;
  /** What WhatsApp says about the account itself: a restriction, a ban, a session taken over. */
  health: HealthInfo;
  /** Counters for checking live what the account receives; no tool acts on them. */
  diagnostics?: StatusDiagnostics;
  /** Present only while `status` is "linking". */
  pairing?: PairingInfo;
  hint?: string;
}

/**
 * `reachout_restricted`: WhatsApp stops the account starting chats with people
 * it has not written to (existing chats still work); `temporarily_banned` and
 * `banned`: WhatsApp refuses the account; `session_replaced`: another client
 * took the session over; `client_outdated`: WhatsApp no longer takes this
 * client; `new_chats_capped`: WhatsApp's cap on first messages to new people
 * is used up for this cycle. Every state but `ok`, `new_chats_capped` and
 * `reachout_restricted` stops every write; those two stop first messages only.
 */
export type HealthState =
  | "ok"
  | "new_chats_capped"
  | "reachout_restricted"
  | "temporarily_banned"
  | "banned"
  | "session_replaced"
  | "client_outdated";

export interface HealthInfo {
  state: HealthState;
  /** When the account entered the state, as this process saw it. */
  since: string | null;
  /** When WhatsApp said it ends; null when it did not say or it does not end. */
  until: string | null;
  /** WhatsApp's own code for it: an enforcement type, or a ban reason. */
  reason: string | null;
  /** WhatsApp's own words, when it gave any. */
  detail: string | null;
  /** The latest send WhatsApp refused after it left, by WhatsApp's code (463: a new chat refused). */
  last_send_error: { code: string; at: string } | null;
  /**
   * WhatsApp's cap on first messages to people who have not written, when it
   * reported one: `status` none, first_warning, second_warning or capped, the
   * quota `used` and `total` of the cycle, and when the cycle ends.
   */
  new_chat_cap: { status: NewChatCapStatus; used: number | null; total: number | null; cycle_ends: string | null } | null;
}

export type NewChatCapStatus = "none" | "first_warning" | "second_warning" | "capped";

export interface StatusDiagnostics {
  /**
   * Read receipts from the account's own devices since the server started:
   * `seen` receipts, `synced` messages that arrived already read, `applied`
   * the ones that moved a chat's read mark, `unmatched` receipts for messages
   * not stored, `last_at` when the latest receipt arrived.
   */
  read_self: { seen: number; synced: number; applied: number; unmatched: number; last_at: string | null };
}

export interface StorageInfo {
  /**
   * `preparing`: importing the earlier message files, once after an upgrade;
   * tools answer NOT_CONNECTED meanwhile. `imported-unverified`: served from
   * the database, but the import found differences it could not explain.
   * `failed`: see `last_error`.
   */
  state: "preparing" | "ready" | "imported-unverified" | "failed";
  /** While preparing: the import phase reached, like "history (3 of 9)". */
  progress?: string;
  /**
   * The earlier message files in `legacy/`: when they are deleted, or why they
   * are kept — the import is unverified, or this database did not move them.
   */
  legacy_files?: { deleted_after: string } | { kept: "unverified" | "inherited" };
}

/**
 * The account's voice-note queue. `auto` is `off` when no provider is set,
 * `WAZAP_TRANSCRIBE_AUTO=0`, or read-only forbids the API provider; `degraded`
 * when the settings do not parse. A queue kept while auto is off stays, idle.
 */
export interface TranscriptionStatus {
  auto: "on" | "off" | "degraded";
  /** Notes waiting or being transcribed. */
  queued: number;
  /** How long the run under way has been going, or null. */
  running_for_seconds: number | null;
  /** Notes given up on (media gone, audio refused, attempts used up). */
  failed: number;
  /** The latest failure on a note still queued or given up on: a short reason, never content. */
  last_error: { reason: string; at: string; final: boolean } | null;
  /** The provider cannot take any note (not ready, key refused): no note runs until then. Process-wide. */
  paused: { reason: string; until: string } | null;
}

/** One row of `get_status.accounts`. Policy `write_tools`, not the session bit. */
export interface ListedAccount {
  id: string;
  name: string;
  status: ConnectionStatus | "disabled";
  phone_masked: string | null;
  owner_name: string | null;
  write_tools: boolean;
  enabled: boolean;
}

export interface WebhookInfo {
  enabled: boolean;
  valid: boolean;
  last_error: string | null;
  /** Only while the webhook is on and valid: the account's outbox, as its database records it. */
  delivery?: WebhookDelivery;
  /**
   * Set when a chat allowlist is configured. `empty` posts no message events.
   * Otherwise a short phrase: `tag autopeloc`, `2 chats`, or both.
   */
  allowlist?: string;
  /** The quiet window, in seconds, when bursts in one chat share a POST. */
  coalesce_seconds?: number;
  /** A 401 is retried instead of failing the event at once. */
  retry_unauthorized?: true;
}

/**
 * Events, not POSTs: a retried event that finally fails is one `failed`. The
 * outbox keeps delivered events 7 days and failed or cancelled ones 30, so the
 * counts cover those windows.
 */
export interface WebhookDelivery {
  delivered: number;
  /** Refused with a 4xx, or still failing 24 hours after it was created. */
  failed: number;
  /** Never posted because its message was deleted, expired or cleared first, or the webhook stopped wanting it. */
  cancelled: number;
  /** Waiting to be posted: behind another event, for a transcript, or for its next retry. */
  pending: number;
  /** Events this server could not store to post, because the account database refused the write. */
  dropped: number;
  /** Failed events since the last delivery; zero once one gets through. */
  consecutive_failures: number;
  /** POSTs the oldest waiting event already failed: above zero, the receiver is refusing or unreachable right now. */
  retrying: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure: string | null;
  /** The HTTP status of that failure, null for a timeout or an unreachable host. */
  last_status: number | null;
  last_dropped_at: string | null;
  /** When the oldest waiting event was created; null when nothing waits. */
  oldest_pending_at: string | null;
}

export interface ChatSummary {
  chat_id: string;
  /** A one-to-one chat: the other person's contact in this account's database, stable across the spellings of their id. */
  contact_id?: number;
  /** A one-to-one chat: the other person's number in E.164, once WhatsApp revealed it. */
  phone?: string;
  name: string;
  note?: string;
  type: ChatType;
  unread_count: number;
  /** `private`: written by someone tagged #private, or in their chat, in a list that did not ask for them; `text` holds no words. */
  last_message: { text: string; timestamp: string; from_me: boolean; private?: true } | null;
  archived: boolean;
  pinned: boolean;
  muted_until: string | null;
  /** Groups only: we are no longer a participant. */
  left?: boolean;
}

export interface MessageSender {
  id: string;
  /** The sender's contact in this account's database: stable when a lid's number becomes known. Absent while none is stored. */
  contact_id?: number;
  name: string;
  phone?: string;
  /** The user's own note on this person, when there is one. */
  note?: string;
}

export interface MessageView {
  message_id: string;
  chat_id: string;
  from_me: boolean;
  sender: MessageSender;
  type: MessageType;
  /** Never empty: media and system messages get a placeholder like "[sticker]". */
  text: string;
  timestamp: string;
  age: string;
  has_media: boolean;
  media?: { mime: string; size?: number; filename?: string };
  quoted?: { message_id: string; text: string; sender: string };
  call?: CallInfo;
  /** What a voice note or audio message says, once it has been transcribed. */
  transcript?: string;
  forwarded: boolean;
  /** One per person who reacted; `name` resolves `sender` the way a message's sender is. */
  reactions?: Array<{ emoji: string; sender: string; name: string }>;
  /** Who the message @-mentions, each once, resolved the way a reaction's sender is. */
  mentions?: Array<{ id: string; name: string }>;
  /** A group notice spelled out: who made which change, to whom. */
  system?: SystemEvent;
  /** On a poll: its options, each with who chose it. */
  poll?: PollResults;
  /** On an event: who answered going, maybe and not going. */
  event_responses?: EventResponses;
  edited: boolean;
  /** On the account's own messages: how far it got. Absent while WhatsApp has confirmed nothing. */
  delivery?: Delivery;
  /** In a broad read, from someone tagged #private: who, when and what kind, no words (src/private-contacts.ts). */
  private?: true;
}

export type DeliveryStatus = "error" | "pending" | "sent" | "delivered" | "read" | "played";

export interface Delivery {
  /** In a group, the furthest any one member got. */
  status: DeliveryStatus;
  /** Group members who read it, earliest first. */
  read_by?: Receiver[];
  /** Group members it reached who have not read it yet, earliest first. */
  delivered_to?: Receiver[];
}

/** A group member a message reached, resolved the way a reaction's sender is; `at` in timestamp's format. */
export interface Receiver {
  id: string;
  name: string;
  at: string;
}

/** Someone who voted or answered, resolved the way a reaction's sender is. */
export interface Voter {
  id: string;
  name: string;
}

export interface PollResults {
  question: string;
  options: Array<{ name: string; votes: number; voters: Voter[] }>;
  /** How many people voted; with multiple answers allowed, fewer than the votes. */
  voters: number;
}

export interface EventResponses {
  going: Voter[];
  maybe: Voter[];
  not_going: Voter[];
}

/** Someone a group notice names, resolved the way a sender is. */
export interface EventParty {
  id: string;
  name: string;
  phone?: string;
}

/** The change behind a group notice, in manage_group's words where it has one. */
export type SystemEventAction =
  | "create"
  | "add"
  | "remove"
  | "promote"
  | "demote"
  | "leave"
  | "join_via_link"
  | "change_number"
  | "set_subject"
  | "set_description"
  | "set_picture"
  | "reset_invite_link"
  | "set_announcement_only"
  | "set_info_locked"
  | "set_add_mode"
  | "set_join_approval"
  | "set_member_label"
  | "set_disappearing"
  | "join_request"
  | "pin_message"
  | "unpin_message"
  | "keep_message"
  | "unkeep_message"
  | "share_history";

export interface SystemEvent {
  action: SystemEventAction;
  /** Absent when WhatsApp did not say who made the change. */
  actor?: EventParty;
  /** Whom the change was made to; empty for a change to the group itself. */
  targets: EventParty[];
  /**
   * The new subject or description, the new state of a setting, the message_id
   * a pin or a keep points at, or how many messages a shared history holds.
   */
  value?: string;
}

export interface RecentConversation {
  chat_id: string;
  chat_name: string;
  note?: string;
  type: ChatType;
  last_activity: string;
  messages: MessageView[];
}

/** What wait_for_messages is asked to watch for. */
export interface WaitOptions {
  timeoutMs: number;
  chatId?: string;
  /** Only messages that address the linked account: any direct message, or a group message that @-mentions it or replies to one of its own. */
  addressedToMe: boolean;
  cursor?: string;
  /** Without a chat, a #private person's messages come without their words; a chat named reads whole. */
  private?: PrivateRule;
}

export interface WaitResult {
  messages: MessageView[];
  /** Pass back on the next call to continue from here without a gap. */
  cursor: string;
  timed_out: boolean;
  /** The cursor came from another run of wazap and could not be honoured; the wait started from now. */
  cursor_reset: boolean;
}

/** A small JPEG of a photo: the one WhatsApp shipped in the message, or one made here from the photo. */
export interface Preview {
  message_id: string;
  mime: string;
  base64: string;
}

/** A conversation whose last word is theirs and reads as something asked of the user. */
export interface UnansweredChat {
  chat_id: string;
  name: string;
  type: ChatType;
  /** The message that asks; a voice note counts as an ask until it has been heard. */
  ask: MessageView;
  /** How many of their messages arrived after the user's last one. */
  messages_since_you: number;
  /** A WhatsApp Business account, whose asks are often automatic replies. */
  business: boolean;
  note?: string;
  waiting_since: string;
  age: string;
}

export interface SearchOptions {
  /** Epoch ms; only messages at or after it. */
  sinceMs?: number;
  /** Epoch ms; only messages at or before it. */
  untilMs?: number;
  /** "me", or a contact / chat id: only messages that person sent. */
  from?: string;
  /** Without a chat, the #private rule (src/private-contacts.ts): their messages are left out and counted, unless `from` names them. */
  private?: PrivateRule;
}

/**
 * A broad read's #private rule (src/private-contacts.ts): the words of someone
 * tagged #private stay out of what the call did not ask of them by name.
 * `others` are the people another account of the call tagged, by number or lid.
 */
export interface PrivateRule {
  others: readonly string[];
}

/** One recall hit: the message plus the score it ranked by. */
export interface RecallHit {
  /** The fused rank score (reciprocal rank fusion of words and meaning); hits are sorted by it. */
  score: number;
  /** Raw cosine similarity to the query; null when only the words matched and the meaning did not rank it. */
  similarity: number | null;
  /** What found it: the query's words, its meaning, or both. */
  matched: "words" | "meaning" | "both";
  message: MessageView;
  /** The database holds the message only as text (from the earlier recall index): get_message and get_media cannot open it. */
  from_index: boolean;
}

export interface RecallAnswer {
  hits: RecallHit[];
  /** The index at query time; "indexing" means more matches may still land. */
  index: RecallStatus;
  /** More messages held the query's words than the word side examined: older word matches may be missing. */
  lexicalCapped: boolean;
  /** Matches from people kept #private that ranked among these, left out; absent when none were. */
  privateOmitted?: number;
}

export interface HandledResult {
  chat_id: string;
  name: string;
  /** The ask that was open; the chat is off the waiting list until a newer one arrives. */
  ask_id: string | null;
  ask_text: string | null;
}

export interface ContactSummary {
  contact_id: string;
  name: string;
  /** What the user told wazap about this person; kept locally, never sent. */
  note?: string;
  /** Local labels the agent filed this person under ("client", "echipa"); searchable. */
  tags?: string[];
  /** Local key-value details ("role": "contabil"); searchable. */
  fields?: Record<string, string>;
  number: string | null;
  is_my_contact: boolean;
  is_business: boolean;
}

/** What updateContactDetails applies; all four are optional but at least one must do something. */
export interface ContactDetailsEdit {
  addTags?: string[];
  removeTags?: string[];
  /** Keys set to the given value; an empty value deletes the key. */
  fields?: Record<string, string>;
  removeFields?: string[];
}

export interface ContactDetails extends ContactSummary {
  about: string | null;
  profile_pic_url: string | null;
  is_blocked: boolean;
}

export interface GroupParticipantInfo {
  contact_id: string;
  name: string;
  is_admin: boolean;
}

export interface GroupInfo {
  chat_id: string;
  name: string;
  description: string | null;
  owner: string | null;
  created_at: string | null;
  participant_count: number;
  participants: GroupParticipantInfo[];
  announcement_only: boolean;
  i_am_admin: boolean;
  /** Only admins may change the name, description and photo. */
  info_locked: boolean;
  /** Who may add members. */
  member_add_mode: "admins" | "all";
  /** New members wait for an admin to approve them. */
  join_approval: boolean;
  /** How long messages last before they disappear; 0 when disappearing messages are off. */
  disappearing_seconds: number;
  /** Present when the group is a community, or belongs to one. */
  community?: { is_community: boolean; parent_group_id: string | null };
  invite_link?: string;
}

/** Someone waiting for an admin to let them into a group. */
export interface JoinRequest {
  id: string;
  name: string;
  requested_at: string | null;
  /** How they asked, in WhatsApp's words ("invite_link", "linked_group_join", "non_admin_add"), when it says. */
  method: string | null;
}

export interface ParticipantResult {
  id: string;
  status: "ok" | "invite_needed" | "failed";
  reason?: string;
}

export interface SentMessage {
  message_id: string;
  chat_id: string;
  text: string;
  timestamp: string;
  /** confirm_send of a draft an earlier confirm sent: this is that send's receipt, and nothing went out again. */
  already_sent?: true;
}

/** Who a draft or send is aimed at, after jid resolution. Groups have no number. */
export interface OutgoingTarget {
  chat_id: string;
  name: string;
  number?: string;
}

export interface MediaResult {
  path: string;
  mime: string;
  size: number;
  filename: string;
  /** Base64 of images small enough to inline in the tool result. */
  inline_base64: string | null;
}

/** How a caller spends a transcription. */
export interface TranscribeOptions {
  /** Taken just before a provider runs: never for a transcript on hand, nor for one that cannot run. */
  limit?: { take(): void };
  /** Only a transcript on hand; none on hand is TRANSCRIBE_UNAVAILABLE, and no provider runs. */
  cachedOnly?: boolean;
}

export interface TranscribeResult {
  text: string;
  language?: string;
  duration_seconds?: number;
  provider: ProviderName;
  /** The transcript was already on hand, so no provider ran and nothing was billed. */
  cached: boolean;
}

export type ChatAction =
  | "archive"
  | "unarchive"
  | "pin"
  | "unpin"
  | "mute"
  | "unmute"
  | "mark_read"
  | "mark_unread"
  | "pin_message"
  | "unpin_message"
  | "star_message"
  | "unstar_message"
  | "clear"
  | "delete"
  | "block"
  | "unblock";

/** What some chat actions need beside the chat: the hours of a mute or a pin, the message a pin or a star is on. */
export interface ChatActionOptions {
  muteHours?: number;
  messageId?: string;
  /** How long a pinned message stays pinned: 24, 168 or 720 hours, the choices WhatsApp offers. */
  pinHours?: number;
}

export type GroupAction =
  | "add"
  | "remove"
  | "promote"
  | "demote"
  | "leave"
  | "set_subject"
  | "set_description"
  | "set_picture"
  | "remove_picture"
  | "get_invite_link"
  | "revoke_invite_link"
  | "list_join_requests"
  | "approve_join_requests"
  | "reject_join_requests"
  | "set_announcement_only"
  | "set_info_locked"
  | "set_add_mode"
  | "set_join_approval"
  | "set_disappearing";

export interface ChatActionResult {
  chat_id: string;
  action: ChatAction;
  applied: string;
  /** On the actions that take a message: the message acted on. */
  message_id?: string;
}

/** A group invite looked at, or acted on. The invite code itself is never part of it. */
export interface JoinGroupResult {
  /** "preview": nothing joined yet; "joined": the account is in; "pending_approval": an admin must let it in. */
  status: "preview" | "joined" | "pending_approval";
  group_id: string | null;
  name: string | null;
  description: string | null;
  participant_count: number | null;
  /** New members wait for an admin to approve them; null when WhatsApp did not say. */
  join_approval: boolean | null;
}

export interface GroupActionResult {
  group_id: string;
  action: GroupAction;
  applied: string;
  participants?: ParticipantResult[];
  invite_link?: string;
  /** After set_picture: the new photo's URL, or null while WhatsApp has not published one. */
  profile_pic_url?: string | null;
  /** After list_join_requests: who is waiting, as WhatsApp listed them. */
  join_requests?: JoinRequest[];
}

export interface MediaSource {
  file_path?: string;
  url?: string;
}

/** Read results carry the sync state, so an agent knows the data may be partial. */
export interface Synced<T> {
  data: T;
  sync: SyncState;
}

/** A send confirm_send handed to WhatsApp whose echo has not come back: it may or may not have arrived. */
export interface UnconfirmedSend {
  draft_id: string;
  /** The words it went out with; empty on an account that keeps no history. */
  text: string;
  /** When its outcome became unknown, ISO with the local offset. */
  handed_at: string;
  state: "unknown";
}

/** One page of a chat, and what the read cannot vouch for. */
export interface ChatRead extends Synced<MessageView[]> {
  /** On the newest page of the chat: sends whose outcome is unknown, oldest first. */
  unconfirmedSends?: UnconfirmedSend[];
  /**
   * Set when the page ran past what is held and the phone was asked for older
   * messages: how many came back for it. None is not the start of the chat.
   */
  older?: { askedPhone: true; received: number };
}

/** A keyword search's messages, and where the storage scan limit stopped it when it did. */
export interface SearchAnswer extends Synced<MessageView[]> {
  /** Set when the scan limit stopped the search before the history ran out: older messages were not searched. */
  scanCapped?: { searchedBackTo: string };
  /** Matches from people kept #private, left out before the limit; absent when none were. */
  privateOmitted?: number;
}

export interface ContactSyncResult {
  requested: boolean;
  named_before: number;
  named_after: number;
}

/**
 * The surface the MCP tools and the CLI use. Declared here so tools.ts compiles
 * against the contract rather than the implementation.
 */
export interface WhatsAppApi {
  getStatus(): StatusInfo;
  /** catch_up (F2-2): the account's entries over a window, unbudgeted; see catchup-scan.ts. */
  catchUpScan?(request: CatchupScanRequest): Promise<CatchupScan>;
  /** Who this account tagged #private or #no-catchup, by jid, for the other accounts of a catch-up. */
  catchUpTags?(): Promise<CatchupTagJids>;
  /** The messages a catch-up page quotes, read in full by id. */
  catchUpQuotes?(ids: number[]): Promise<CatchupQuote[]>;
  /** Moves `client`'s catch-up mark to the top of `window`, while it still is the window's `expected` (compare-and-set). */
  catchUpAdvance?(client: string, window: CatchupWindow): Promise<{ advanced: boolean }>;
  hasChat(jid: string): boolean;
  hasMessage(id: string): boolean;
  /** What search ran across by words; optional, so a stand-in need not count. */
  searchCoverage?(chatId: string | undefined, opts?: { sinceMs?: number; untilMs?: number }): SearchCoverage | null;
  hasDraft(id: string): boolean;
  link(phone: string): Promise<PairingInfo>;
  /** With `private`, a last message from someone tagged #private, or in their chat, comes without its words. */
  listChats(filter: ChatFilter, limit: number, opts?: { private?: PrivateRule }): Promise<Synced<ChatSummary[]>>;
  readMessages(chatId: string, limit: number, before?: string, types?: MessageType[]): Promise<ChatRead>;
  getRecentMessages(
    hours: number,
    filter: Exclude<ChatFilter, "archived">,
    includeSystem?: boolean,
    types?: MessageType[]
  ): Promise<Synced<RecentConversation[]>>;
  searchMessages(
    query: string,
    chatId: string | undefined,
    limit: number,
    opts?: SearchOptions
  ): Promise<SearchAnswer>;
  recall(
    query: string,
    chatId: string | undefined,
    limit: number,
    opts?: SearchOptions
  ): Promise<Synced<RecallAnswer>>;
  getMessage(messageId: string): Promise<MessageView>;
  searchContacts(query: string, limit: number, opts?: { tag?: string }): Promise<ContactSummary[]>;
  getContact(contactId: string): Promise<ContactDetails>;
  syncContacts(): Promise<ContactSyncResult>;
  // find_contact and the draft context (F2-3); optional, so a stand-in need not have them.
  /** Who a name, nickname or relationship means on this account; asks WhatsApp for an empty address book once per boot first. */
  findContact?(query: FindContactQuery): Promise<AccountFind>;
  /** The recent exchange (unless `recent: false`) and the user's style in a chat, or null when it has no history. */
  draftContext?(chatJid: string, options: { recent: boolean; private?: PrivateRule }): DraftContext | null;
  /**
   * How a text draft to a direct chat compares with the user's own messages
   * there; null without enough of them. With too few, the language is read off
   * the recipient's own messages instead, so `private` carries the same rule
   * every read does: nothing of a `#private` contact, on this account or on
   * another, is read for it.
   */
  styleCheck?(chatJid: string, text: string, options?: { private?: PrivateRule }): StyleCheck | null;
  updateContactDetails(contactId: string, edit: ContactDetailsEdit): Promise<ContactSummary>;
  getGroupInfo(groupId: string): Promise<GroupInfo>;
  downloadMedia(messageId: string, saveTo?: string): Promise<MediaResult>;
  transcribeAudio(messageId: string, language?: string, opts?: TranscribeOptions): Promise<TranscribeResult>;
  waitForMessages(opts: WaitOptions): Promise<WaitResult>;
  /** With `private`, a story of someone tagged #private comes without its words. */
  getStories(hours: number, opts?: { private?: PrivateRule }): Promise<Synced<MessageView[]>>;
  setContactNote(contactId: string, note: string): Promise<ContactSummary>;
  markHandled(chatId: string): Promise<HandledResult>;
  previews(messageIds: string[], max: number): Promise<Preview[]>;
  getUnanswered(minAgeHours: number, maxAgeHours: number, limit: number): Promise<Synced<UnansweredChat[]>>;
  /** `owner` is the MCP session drafting; only the same owner may confirm. */
  draft(payload: DraftPayload, owner?: string): Promise<DraftView>;
  /**
   * Sends a draft once. Confirming it again answers the same receipt; a send
   * that reached WhatsApp and then failed is SEND_OUTCOME_UNKNOWN, and stays so.
   */
  confirm(draftId: string, owner?: string): Promise<SentMessage>;
  sendMessage(chatId: string, text: string, replyTo?: string, mentionIds?: string[]): Promise<SentMessage>;
  sendMedia(
    chatId: string,
    source: MediaSource,
    opts: { caption?: string; asDocument: boolean; asVoice: boolean; asGif: boolean }
  ): Promise<SentMessage>;
  sendPoll(chatId: string, question: string, options: string[], multiSelect: boolean): Promise<SentMessage>;
  sendLocation(
    chatId: string,
    latitude: number,
    longitude: number,
    name?: string,
    address?: string
  ): Promise<SentMessage>;
  editMessage(messageId: string, text: string): Promise<SentMessage>;
  reactToMessage(messageId: string, emoji: string): Promise<{ message_id: string; emoji: string }>;
  forwardMessage(messageId: string, toChatId: string): Promise<SentMessage>;
  deleteMessage(messageId: string, forEveryone: boolean): Promise<{ message_id: string; for_everyone: boolean }>;
  manageChat(chatId: string, action: ChatAction, opts?: ChatActionOptions): Promise<ChatActionResult>;
  createGroup(name: string, participantIds: string[]): Promise<{ chat_id: string; participants: ParticipantResult[] }>;
  joinGroup(opts: { invite?: string; messageId?: string; confirm: boolean }): Promise<JoinGroupResult>;
  manageGroup(
    groupId: string,
    action: GroupAction,
    participantIds?: string[],
    value?: string,
    source?: MediaSource
  ): Promise<GroupActionResult>;
}
