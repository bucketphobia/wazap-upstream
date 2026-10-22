/**
 * One account's side of catch_up (F2-2): what the user missed, read off the
 * account database in a window of message ids, as unbudgeted entries per
 * section. src/catchup.ts merges accounts, spends the token budget, renders
 * and pages; the service supplies names and the network-free lookups
 * (`CatchupHost`), so this runs against a bare AccountDb as well (the bench).
 *
 * The window (see resolveWindow):
 * - "last" reads what reached the account after the client's mark — by
 *   stored_seq, the order messages were stored in, so a message filed late (a
 *   call when it ends, dated at its ring; a retried decryption; one dated
 *   ahead) is in the next catch-up, not under the mark — and moves the mark
 *   once the whole digest was given; a first run, or a mark more than 7 days
 *   old, reads the last 24 h;
 * - "previous" repeats the window the last complete digest covered;
 * - "hours" and an ISO "since" are explicit windows by time and never move the mark.
 * Nothing sent more than 14 days ago is in any window.
 *
 * Inside it, each chat starts later still: after the user's own last word
 * there and after the newest message the phone reported read (what "missed"
 * means). Nothing reads a message above the window's tops, the id and the
 * stored_seq fixed when the digest started, so the digest is what the account
 * held at that instant; its later pages are served from it (src/catchup.ts).
 *
 * `waiting` is not bound by the window: an ask stays until the user answers,
 * marks it handled, or it is 14 days old, as the service's getUnanswered has it.
 */
import { readsAsAsk } from "./asks.js";
import type { AccountDb, ChatRecord, DigestMedia, DigestSpan, InboundAggregate, TailMessage, WindowMessage } from "./db/index.js";
import { idLowerBound, secondOfId } from "./db/index.js";
import { PRIVATE_TAG, privatePeople } from "./private-contacts.js";
import { signalsOf, type Signal } from "./signals.js";

export const CATCHUP_SECTIONS = ["waiting", "addressed", "calls", "direct", "groups", "stories"] as const;
export type CatchupSection = (typeof CATCHUP_SECTIONS)[number];

/** Why the window starts where it does. */
export type WindowBasis = "last" | "first_run" | "mark_expired" | "previous" | "hours" | "since";

/** The tag that keeps a chat out of every catch-up (a bot, an agent). */
export const NO_CATCHUP_TAG = "no-catchup";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A first run, or a mark older than MARK_MAX_AGE_MS, reads this far back. */
export const FIRST_RUN_MS = DAY;
export const MARK_MAX_AGE_MS = 7 * DAY;
/** An ask older than this was abandoned, not left waiting (getUnanswered's default). */
export const WAITING_HORIZON_MS = 14 * DAY;
/** No window reaches further back than this: a message sent earlier and stored late is not missed, it is history. */
export const WINDOW_FLOOR_MS = WAITING_HORIZON_MS;
/** How many of their newest messages an ask is looked for among (getUnanswered's scan). */
const ASK_SCAN = 30;
/** Voice notes the footer names by id. */
const VOICE_IDS_MAX = 10;
/** Group metadata fetched to name senders: this many groups, within this long. */
export const GROUP_META_MAX = 12;
export const GROUP_META_MS = 1_000;

export interface CatchupWindow {
  /** Messages above this id (exclusive): sent after the window's start, or at most 14 days ago. */
  sinceId: number;
  /** Messages up to this id (inclusive): the newest the account held when the digest started. */
  untilId: number;
  /** Messages stored after this stored_seq (exclusive): the client's mark; -1 for a window by time. */
  afterSeq: number;
  /** Messages stored up to this stored_seq (inclusive): the newest the account held when the digest started. */
  untilSeq: number;
  /** When the window starts and ends, as the answer says it. */
  sinceAt: number;
  untilAt: number;
  basis: WindowBasis;
  /** Whether giving the whole digest moves the client's mark to untilSeq. */
  advance: boolean;
  /** The mark (a stored_seq) the window was built on, for the compare-and-set; null when the client had none. */
  expected: number | null;
  /** The instant the digest started; expiry, mutes and ages are judged against it. */
  at: number;
}

export type CatchupWindowSpec =
  | { kind: "last" }
  | { kind: "previous" }
  | { kind: "hours"; hours: number }
  | { kind: "since"; ms: number };

export interface CatchupScanRequest {
  client: string;
  window: CatchupWindowSpec;
  include: readonly CatchupSection[];
  /** The people another account of the same catch-up tagged, by jid: they hold here too. */
  tags?: CatchupTagJids;
  /** The instant the digest started, shared by every account it covers; the host's clock when omitted. */
  at?: number;
}

/** What the service knows that the database does not: names, the account itself, the network-bound lookups. */
export interface CatchupHost {
  now(): number;
  /** The account's own canonical jid; "" before the account is known. */
  ownJid(): string;
  nameOf(jid: string): string;
  noteOf(jid: string): string | undefined;
  /** The tags the user filed a person under; undefined when none. */
  tagsOf?(jid: string): string[] | undefined;
  /** A jid that addresses nobody (see ids.ts isNoiseJid). */
  isNoise(jid: string): boolean;
  /** A group the account left. */
  leftGroup(chat: ChatRecord): boolean;
  /** Learns what names these groups' senders and these people need; bounded by the host (GROUP_META_MS). */
  prepareNames(groups: readonly string[], people: readonly string[]): Promise<void>;
  connection(): CatchupConnection;
}

export interface CatchupConnection {
  status: string;
  /** When the connection entered that status, ISO; null when unknown. */
  since: string | null;
  sync: "done" | "in_progress";
  /** Mentions of messages stored before this build are still being worked out. */
  mentionsIndexing: boolean;
}

export interface WaitingEntry {
  chat: string;
  name: string;
  note?: string;
  tags?: string[];
  group: boolean;
  business: boolean;
  /** A person not in the address book, never named by the user. */
  unknown: boolean;
  /** In a group: who asked. */
  from?: string;
  ask: { id: number; sid: string; ts: number; type: string; voice?: string; transcribed: boolean };
  /** Their newest message after the ask inside the window, worth quoting with it. */
  thenId?: number;
  /** Tagged #private (the person, the group, or in a group the one asking): nothing they wrote is quoted. */
  private: boolean;
  /** Their messages since the user's last one (inside the 14 days). */
  sinceYou: number;
  newSinceLast: boolean;
  signals: Signal[];
  /** An answered call in the chat after the ask: it may have been dealt with by phone. */
  callAfter?: { ts: number; seconds?: number; outgoing: boolean };
}

export interface AddressedEntry {
  chat: string;
  name: string;
  kind: "mention" | "reply" | "poll" | "event";
  from: string;
  id: number;
  sid: string;
  ts: number;
  /** Other mentions and replies in the chat in the window. */
  more: number;
  /** A poll's question, an event's line. */
  title?: string;
  /** From someone tagged #private, or in a group tagged so: not quoted, no title. */
  private: boolean;
}

export interface CallsEntry {
  /** The person's own chat. */
  chat: string;
  name: string;
  count: number;
  video: boolean;
  lastTs: number;
  calledBack: boolean;
  wroteAfter: boolean;
  /** The group the call rang in, when it was a group call. */
  group?: string;
}

export interface DirectEntry {
  chat: string;
  name: string;
  note?: string;
  tags?: string[];
  count: number;
  media: Partial<Record<DigestMedia, number>>;
  polls: number;
  newestTs: number;
  saved: boolean;
  business: boolean;
  unknown: boolean;
  muted: boolean;
  /** Tagged #private: counted, never quoted. */
  private: boolean;
  quoteId: number | null;
}

export interface GroupEntry {
  chat: string;
  name: string;
  count: number;
  senders: number;
  top: string[];
  media: Partial<Record<DigestMedia, number>>;
  polls: number;
  newestTs: number;
  addressed: boolean;
  hotId: number | null;
}

export interface MutedGroups {
  groups: number;
  count: number;
  names: string[];
}

export interface StoriesEntry {
  count: number;
  authors: string[];
  more: number;
}

export interface SkipCount {
  chats: number;
  messages: number;
}

export interface CatchupScan {
  accountId: string;
  accountName: string;
  connection: CatchupConnection;
  window: CatchupWindow;
  waiting: WaitingEntry[];
  addressed: AddressedEntry[];
  calls: CallsEntry[];
  direct: DirectEntry[];
  groups: GroupEntry[];
  mutedGroups: MutedGroups | null;
  stories: StoriesEntry | null;
  /** Unheard voice notes by id, at most VOICE_IDS_MAX, never a #private person's: those are only counted. */
  voiceUntranscribed: string[];
  voiceUntranscribedCount: number;
  skipped: { noCatchup: SkipCount; leftGroups: SkipCount; newsletters: SkipCount; broadcasts: SkipCount };
}

/** A message a digest quotes, as the budget pass reads it back (≤60 per page). */
export interface CatchupQuote {
  id: number;
  sid: string;
  type: string;
  /** What it says: a voice note's transcript, otherwise its stored words ("[image] caption"). */
  text: string;
  transcribed: boolean;
}

// ---------------------------------------------------------------- window

/** The largest id below every message at or after `ms`: a window's exclusive start. */
function idBefore(ms: number): number {
  return Math.max(0, idLowerBound(Math.max(0, ms)) - 1);
}

/** The instant an id's second began. */
export function tsOfId(id: number): number {
  return secondOfId(id) * 1000;
}

// ---------------------------------------------------------------- an open ask

/** The ask still open in a chat, and the messages of theirs it was read among; see openAsk. */
export interface OpenAsk {
  ask: TailMessage;
  /** Their messages since the user's last word there, newest first, at most ASK_SCAN. */
  tail: TailMessage[];
  /** The id their messages were read from: the user's last word there, or the 14-day floor. */
  after: number;
}

/** What reading one chat's open ask takes: when it is judged, the newest id it may see, the chat's family and span, the user's last word there, and the handled marks. */
export interface AskReads {
  /** The instant ages, expiry and the 14-day horizon are judged against. */
  now: number;
  /** The newest id the read may see: the top the digest fixed when it started. */
  untilId: number;
  family: readonly number[];
  /** The span an ask reads back over, from `afterId` up: the window's tops, whatever the client's mark. */
  span: (afterId: number) => DigestSpan;
  /** The newest message of the user's own at or below `untilId`; see ownThroughOf. */
  ownThrough: number | null;
  /** Every handled mark, by the chat it was filed under (Digest.handled). */
  handled: ReadonlyMap<number, { askId: number | null; at: number }>;
}

/** The user's own last word in the chat at or below `untilId`: off the chat's row when that is low enough, walked back otherwise. */
export function ownThroughOf(db: AccountDb, chat: ChatRecord, family: readonly number[], untilId: number): number | null {
  if (chat.lastOwnId === null) return null;
  return chat.lastOwnId <= untilId ? chat.lastOwnId : db.digest.ownThrough(family, untilId);
}

/**
 * The ask still open in one chat: the newest message of theirs since the
 * user's last word there that reads as an ask (in a group, only one that
 * mentions the user or answers them). Null when the user had the last word,
 * when nothing of theirs asks anything, when `remember handled` covered the
 * ask, or when the ask is more than WAITING_HORIZON_MS old.
 *
 * catch_up's `waiting` and each find_contact candidate's `waiting` are both
 * this, so the two never disagree about who is waiting on the user.
 */
export function openAsk(db: AccountDb, chat: ChatRecord, reads: AskReads): OpenAsk | null {
  if (chat.kind !== "direct" && chat.kind !== "group") return null;
  if (chat.archived) return null;
  // The user had the last word, and nothing came after it before the read started.
  if (chat.lastFromMe === true && chat.lastMessageId !== null && chat.lastMessageId <= reads.untilId) return null;
  const after = Math.max(idBefore(reads.now - WAITING_HORIZON_MS), reads.ownThrough ?? 0);
  const tail = db.digest.inboundTail(reads.family, reads.span(after), reads.now, ASK_SCAN);
  if (tail.length === 0) return null;
  const group = chat.kind === "group";
  const ask = tail.find((message) => (!group || (message.flags & 1) !== 0 || message.quotedFromMe) && readsAsAsk(message));
  if (ask === undefined) return null;
  const mark = reads.handled.get(chat.id);
  if (mark !== undefined && (mark.askId !== null ? ask.id <= mark.askId : ask.ts <= mark.at)) return null;
  return { ask, tail, after };
}

/**
 * Where a digest for `client` starts and ends, and whether it may move the
 * mark. Reads the mark and the two tops in one synchronous pass, writes nothing.
 */
export function resolveWindow(db: AccountDb, client: string, spec: CatchupWindowSpec, now: number): CatchupWindow {
  const untilId = db.digest.maxId();
  const untilSeq = db.digest.storedTop();
  const byTime = (basis: WindowBasis, sinceAt: number, advance: boolean, expected: number | null): CatchupWindow => ({
    sinceId: idBefore(sinceAt),
    untilId,
    afterSeq: -1,
    untilSeq,
    sinceAt,
    untilAt: now,
    basis,
    advance,
    expected,
    at: now,
  });
  switch (spec.kind) {
    case "hours":
      return byTime("hours", now - spec.hours * HOUR, false, null);
    case "since":
      return byTime("since", spec.ms, false, null);
    case "previous": {
      const repeat = db.catchup.repeat(client);
      if (repeat === null) return byTime("first_run", now - FIRST_RUN_MS, false, null);
      // A repeat reads two weeks back at most, like every window, however old the catch-up it repeats.
      const floorAt = now - WINDOW_FLOOR_MS;
      const sinceAt = Math.max(floorAt, repeat.afterAt ?? repeat.throughAt - FIRST_RUN_MS);
      return {
        sinceId: idBefore(repeat.afterSeq === null ? sinceAt : Math.max(floorAt, repeat.throughAt - WINDOW_FLOOR_MS)),
        untilId,
        afterSeq: repeat.afterSeq ?? -1,
        untilSeq: repeat.throughSeq,
        sinceAt,
        untilAt: Math.max(sinceAt, repeat.throughAt),
        basis: "previous",
        advance: false,
        expected: null,
        at: now,
      };
    }
    case "last": {
      const mark = db.catchup.get(client);
      if (mark === null) return byTime("first_run", now - FIRST_RUN_MS, true, null);
      if (now - mark.throughAt > MARK_MAX_AGE_MS) return byTime("mark_expired", now - FIRST_RUN_MS, true, mark.throughSeq);
      return {
        sinceId: idBefore(now - WINDOW_FLOOR_MS),
        untilId,
        afterSeq: mark.throughSeq,
        untilSeq,
        sinceAt: mark.throughAt,
        untilAt: now,
        basis: "last",
        advance: true,
        expected: mark.throughSeq,
        at: now,
      };
    }
  }
}

// ---------------------------------------------------------------- calls

export interface CallReading {
  outcome: "answered" | "missed" | "rejected" | "unanswered" | "offered";
  outgoing: boolean;
  video: boolean;
  seconds?: number;
}

const CALL_TEXT = /^\[(outgoing )?(?:(missed|rejected|unanswered) )?(voice|video) call(?: · ([^\]]+))?\]$/;

function durationSeconds(label: string): number | undefined {
  let match = /^(\d+)s$/.exec(label);
  if (match) return Number(match[1]);
  match = /^(\d+) min$/.exec(label);
  if (match) return Number(match[1]) * 60;
  match = /^(\d+)h(?: (\d+) min)?$/.exec(label);
  if (match) return Number(match[1]) * 3600 + Number(match[2] ?? 0) * 60;
  return undefined;
}

/**
 * A call as its stored words say it (messages.ts callText): who called, how
 * it ended, how long it ran. Read off the text so a window of calls needs no
 * protobuf; test/catchup.test.mjs holds it to callText.
 */
export function readCallText(text: string): CallReading | null {
  if (text === "[group call]") return { outcome: "offered", outgoing: false, video: false };
  const match = CALL_TEXT.exec(text);
  if (match === null) return null;
  const outgoing = match[1] !== undefined;
  const video = match[3] === "video";
  const suffix = match[4];
  if (outgoing) {
    if (suffix === "unanswered" || suffix === "rejected" || suffix === "missed") {
      return { outcome: suffix === "rejected" ? "rejected" : "unanswered", outgoing, video };
    }
    const seconds = suffix === undefined ? undefined : durationSeconds(suffix);
    return { outcome: "answered", outgoing, video, ...(seconds === undefined ? {} : { seconds }) };
  }
  if (match[2] === "missed" || match[2] === "rejected" || match[2] === "unanswered") return { outcome: match[2], outgoing, video };
  const seconds = suffix === undefined ? undefined : durationSeconds(suffix);
  return { outcome: "answered", outgoing, video, ...(seconds === undefined ? {} : { seconds }) };
}

// ---------------------------------------------------------------- helpers

/** Written like a phone number rather than a name (service/identity.ts realName). */
const NOT_A_NAME = /^[+\d\s()\-.·•∙…*]+$/u;

function isRealName(value: string | null): boolean {
  const trimmed = value?.trim() ?? "";
  return trimmed !== "" && !NOT_A_NAME.test(trimmed);
}

/** "0:42" out of "[voice message · 0:42]". */
function voiceLength(text: string): string | undefined {
  return /· (\d+:\d{2}(?::\d{2})?)\]/.exec(text)?.[1];
}

function sidOf(chatJid: string, keyId: string, fromMe = false): string {
  return `${fromMe}_${chatJid}_${keyId}`;
}

/** A bare placeholder ("[image]", "[sticker]") says nothing worth quoting. */
function quotable(message: TailMessage): boolean {
  if (message.transcript !== null && message.transcript.trim() !== "") return true;
  const text = message.text.trim();
  return text !== "" && !/^\[[^\]]*\]$/.test(text);
}

/** Signals that move an ask up: a sum, or a day or an hour to keep. */
function urgent(signals: readonly Signal[]): boolean {
  return signals.includes("amount") || signals.includes("date") || signals.includes("time");
}

const byJid = (a: { chat: string }, b: { chat: string }): number => (a.chat < b.chat ? -1 : a.chat > b.chat ? 1 : 0);

function emptySkips(): CatchupScan["skipped"] {
  return {
    noCatchup: { chats: 0, messages: 0 },
    leftGroups: { chats: 0, messages: 0 },
    newsletters: { chats: 0, messages: 0 },
    broadcasts: { chats: 0, messages: 0 },
  };
}

// ---------------------------------------------------------------- tags

/**
 * #private and #no-catchup as a catch-up reads them, #private through the set
 * every broad read takes (privatePeople, src/private-contacts.ts):
 * - #no-catchup keeps a person out of every catch-up: their chat is left out
 *   and counted, and nothing they send anywhere else — an ask, a mention, a
 *   poll, a quote, a group call, a story — is read at all (`excludedSenders`
 *   goes into every span);
 * - #private keeps a person in, counted, but never quoted: their chat, and
 *   what they send in a group.
 * A tag is filed on a contact (a group keeps notes on its own row too). With
 * several live accounts, a person tagged on any of them is tagged on every one
 * a catch-up reads, account_id or not: the accounts pass each other the jids
 * (taggedJids, `extra`).
 */
export interface CatchupTagJids {
  private: readonly string[];
  noCatchup: readonly string[];
}

/** Everyone tagged on this account, by number and lid, for the other accounts of a catch-up. */
export function taggedJids(db: AccountDb): CatchupTagJids {
  return { private: [...db.digest.tagged(PRIVATE_TAG).jids], noCatchup: [...db.digest.tagged(NO_CATCHUP_TAG).jids] };
}

interface CatchupTags {
  privateChat(chat: ChatRecord): boolean;
  privateSender(senderId: number | null): boolean;
  privateSenders: ReadonlySet<number>;
  excludedChat(chat: ChatRecord): boolean;
  excludedSenders: ReadonlySet<number>;
}

function catchupTags(db: AccountDb, extra: CatchupTagJids | undefined): CatchupTags {
  const privacy = privatePeople(db, extra?.private);
  const excluded = db.digest.tagged(NO_CATCHUP_TAG, extra?.noCatchup);
  return {
    privateChat: privacy.chat,
    privateSender: privacy.sender,
    privateSenders: privacy.contactIds,
    excludedChat: (chat) => (chat.contactId !== null && excluded.contactIds.has(chat.contactId)) || excluded.jids.has(chat.jid),
    excludedSenders: excluded.contactIds,
  };
}

// ---------------------------------------------------------------- scan

/**
 * The account's entries for a digest over the window `request` names. The
 * database reads run in one synchronous pass; the only wait is the host's
 * name preparation, bounded to a second, and it changes no entry's order.
 */
export async function scanCatchup(db: AccountDb, host: CatchupHost, request: CatchupScanRequest, account: { id: string; name: string }): Promise<CatchupScan> {
  const include = new Set(request.include);
  const window = resolveWindow(db, request.client, request.window, request.at ?? host.now());
  const now = window.at;
  const { sinceId, untilId, afterSeq, untilSeq } = window;
  const tags = catchupTags(db, request.tags);
  const { privateChat, privateSender } = tags;
  const excludeSenders = tags.excludedSenders;
  /** The window from `afterId` up, the client's mark included; nothing from anyone #no-catchup. */
  const windowSpan = (afterId: number): DigestSpan => ({ afterId, untilId, afterSeq, untilSeq, excludeSenders });
  /** From `afterId` up to the window's tops, whatever the mark: what an ask reads back over two weeks. */
  const openSpan = (afterId: number): DigestSpan => ({ afterId, untilId, afterSeq: -1, untilSeq, excludeSenders });
  /** A chat tagged #no-catchup is counted, so its own reads keep what its person sent. */
  const counting = (span: DigestSpan): DigestSpan => ({ ...span, excludeSenders: undefined });
  const inWindow = (message: { id: number; storedSeq: number }): boolean => message.id > sinceId && message.storedSeq > afterSeq;
  const digest = db.digest;
  const own = host.ownJid();
  const families = digest.families();
  const familyOf = (chat: ChatRecord): number[] => families.get(chat.id) ?? [chat.id];
  const isExcluded = tags.excludedChat;
  const muted = (chat: ChatRecord): boolean => chat.archived || (chat.mutedUntil !== null && chat.mutedUntil > now);
  const ownThroughs = new Map<number, number | null>();
  const ownThrough = (chat: ChatRecord): number | null => {
    if (!ownThroughs.has(chat.id)) ownThroughs.set(chat.id, ownThroughOf(db, chat, familyOf(chat), untilId));
    return ownThroughs.get(chat.id) ?? null;
  };
  /**
   * Where "missed" starts in a chat: the window, the lowest id stored in it
   * (`low`), the user's own last word, the phone's read mark.
   */
  const floorOf = (chat: ChatRecord, low: number): number =>
    Math.max(sinceId, low - 1, ownThrough(chat) ?? 0, chat.readThroughId === null ? 0 : Math.min(chat.readThroughId, untilId));
  const skipped = emptySkips();
  const excludedChats = new Set<number>();
  const noteExcluded = (chat: ChatRecord, messages: number): void => {
    if (!excludedChats.has(chat.id)) {
      excludedChats.add(chat.id);
      skipped.noCatchup.chats++;
    }
    skipped.noCatchup.messages += messages;
  };
  const voiceIds: string[] = [];
  const voiceSeen = new Set<string>();
  let voiceCount = 0;
  /** An unheard voice note, counted once; named for get_media unless its person is #private. */
  const noteVoice = (sid: string, hidden: boolean): void => {
    if (voiceSeen.has(sid)) return;
    voiceSeen.add(sid);
    voiceCount++;
    if (!hidden && voiceIds.length < VOICE_IDS_MAX) voiceIds.push(sid);
  };

  // Names are filled in once the host has prepared them; entries keep jids until then.
  const groupsToName = new Set<string>();
  const peopleToName = new Set<string>();
  const contactIds = new Set<number>();

  // -------------------------------------------------------------- calls, 14 days
  const horizonTs = now - WAITING_HORIZON_MS;
  const horizonId = idBefore(horizonTs);
  const needCalls = include.has("waiting") || include.has("calls");
  const calls = needCalls ? digest.calls(openSpan(Math.min(horizonId, sinceId)), now) : [];
  const callsByChat = new Map<number, Array<WindowMessage & { reading: CallReading }>>();
  for (const call of calls) {
    const reading = readCallText(call.text);
    if (reading === null) continue;
    const list = callsByChat.get(call.chatId) ?? [];
    list.push({ ...call, reading });
    callsByChat.set(call.chatId, list);
  }

  // -------------------------------------------------------------- waiting
  type RawWaiting = Omit<WaitingEntry, "name" | "note" | "business" | "unknown" | "from"> & { chatRecord: ChatRecord; senderId: number | null };
  const rawWaiting: RawWaiting[] = [];
  const waitingChats = new Set<number>();
  if (include.has("waiting")) {
    const handled = digest.handled();
    for (const chat of digest.chatsActiveSince(horizonTs)) {
      if (host.isNoise(chat.jid) || chat.jid === own) continue;
      const family = familyOf(chat);
      // A chat tagged #no-catchup is read counting its person, so its own reads keep what they sent.
      const open = openAsk(db, chat, {
        now,
        untilId,
        family,
        span: (afterId) => (isExcluded(chat) ? counting(openSpan(afterId)) : openSpan(afterId)),
        ownThrough: ownThrough(chat),
        handled,
      });
      if (open === null) continue;
      const { ask, tail, after } = open;
      const group = chat.kind === "group";
      if (group && host.leftGroup(chat)) continue;
      if (isExcluded(chat)) {
        noteExcluded(chat, 0);
        continue;
      }
      const sinceYou = tail.length < ASK_SCAN ? tail.length : digest.inboundCount(family, openSpan(after), now, 999);
      const hidden = privateChat(chat) || (group && privateSender(ask.senderId));
      const words = ask.transcript === null ? ask.text : ask.transcript;
      const transcribed = ask.transcript !== null;
      // In a person's chat, what they said after the ask rides with it; a group's chatter has its own row.
      const then = group || hidden ? undefined : tail.find((message) => message.id > ask.id && inWindow(message) && quotable(message));
      const answered = group
        ? undefined
        : (callsByChat.get(chat.id) ?? []).find((call) => call.id > ask.id && call.reading.outcome === "answered");
      rawWaiting.push({
        chat: chat.jid,
        chatRecord: chat,
        group,
        senderId: ask.senderId,
        ask: {
          id: ask.id,
          sid: sidOf(chat.jid, ask.keyId),
          ts: ask.ts,
          type: ask.type,
          ...(ask.type === "voice" || ask.type === "audio" ? { voice: voiceLength(ask.text) } : {}),
          transcribed,
        },
        ...(then === undefined ? {} : { thenId: then.id }),
        private: hidden,
        sinceYou,
        newSinceLast: inWindow(ask),
        // A private ask gives away nothing of its words, markers included.
        signals: hidden || (ask.type === "voice" && !transcribed) ? [] : [...signalsOf(words)],
        ...(answered === undefined
          ? {}
          : {
              callAfter: {
                ts: answered.ts,
                outgoing: answered.fromMe,
                ...(answered.reading.seconds === undefined ? {} : { seconds: answered.reading.seconds }),
              },
            }),
      });
      waitingChats.add(chat.id);
      if (ask.type === "voice" && !transcribed) noteVoice(sidOf(chat.jid, ask.keyId), hidden);
      if (group && ask.senderId !== null) contactIds.add(ask.senderId);
      if (!group && chat.contactId !== null) contactIds.add(chat.contactId);
      if (group) groupsToName.add(chat.jid);
      else peopleToName.add(chat.jid);
    }
  }

  // -------------------------------------------------------------- the window, chat by chat
  // Since a mark: the chats something was stored in after it, each from the lowest id stored.
  // By time: the chats active since the window's start, from there.
  const byStored = afterSeq >= 0;
  const hasWindow = byStored ? afterSeq < untilSeq : sinceId < untilId;
  const active: Array<{ chat: ChatRecord; low: number }> = !hasWindow
    ? []
    : byStored
      ? (() => {
          const lows = digest.chatsStoredIn(windowSpan(sinceId));
          return digest.chatsByIds(lows.keys()).map(({ chat, asked }) => ({ chat, low: Math.min(...asked.map((id) => lows.get(id)!)) }));
        })()
      : digest.chatsActiveSince(sinceId === 0 ? 0 : tsOfId(sinceId)).map((chat) => ({ chat, low: sinceId + 1 }));
  const chatsById = new Map(active.map(({ chat }) => [chat.id, chat]));
  type RawDirect = Omit<DirectEntry, "name" | "note" | "saved" | "business" | "unknown"> & { chatRecord: ChatRecord };
  type RawGroup = Omit<GroupEntry, "name" | "top"> & { chatRecord: ChatRecord; floor: number; topIds: number[] };
  const rawDirect: RawDirect[] = [];
  const rawGroups: RawGroup[] = [];
  type RawAddressed = Omit<AddressedEntry, "name" | "from"> & { senderId: number | null };
  const rawAddressed: RawAddressed[] = [];
  const mutedGroups = { groups: 0, count: 0, chats: [] as Array<{ jid: string; count: number }> };
  const wantsWindow = include.has("addressed") || include.has("direct") || include.has("groups");
  const leftGroups = new Set<number>();
  for (const { chat, low } of wantsWindow ? active : []) {
    if (chat.kind === "status" || host.isNoise(chat.jid) || chat.jid === own) continue;
    const family = familyOf(chat);
    const floor = floorOf(chat, low);
    if (floor >= untilId) continue;
    const aggregate: InboundAggregate = digest.inbound(family, isExcluded(chat) ? counting(windowSpan(floor)) : windowSpan(floor), now);
    if (aggregate.count === 0) continue;
    if (chat.kind === "newsletter" || chat.kind === "broadcast") {
      const bucket = chat.kind === "newsletter" ? skipped.newsletters : skipped.broadcasts;
      bucket.chats++;
      bucket.messages += aggregate.count;
      continue;
    }
    if (isExcluded(chat)) {
      noteExcluded(chat, aggregate.count);
      continue;
    }
    if (chat.kind === "group" && host.leftGroup(chat)) {
      leftGroups.add(chat.id);
      skipped.leftGroups.chats++;
      skipped.leftGroups.messages += aggregate.count;
      continue;
    }
    if (chat.kind === "group") {
      const addressedId = Math.max(aggregate.lastMentionId ?? 0, aggregate.lastReplyId ?? 0);
      const inWaiting = waitingChats.has(chat.id);
      if (include.has("addressed") && addressedId > 0 && !inWaiting) {
        const [message] = digest.inboundTail(family, { ...windowSpan(addressedId - 1), untilId: addressedId }, now, 1);
        if (message !== undefined) {
          rawAddressed.push({
            chat: chat.jid,
            kind: (message.flags & 1) !== 0 ? "mention" : "reply",
            id: message.id,
            sid: sidOf(chat.jid, message.keyId),
            ts: message.ts,
            more: Math.max(0, aggregate.mentions + aggregate.replies - 1),
            private: privateChat(chat) || privateSender(message.senderId),
            senderId: message.senderId,
          });
          if (message.senderId !== null) contactIds.add(message.senderId);
          groupsToName.add(chat.jid);
        }
      }
      if (!include.has("groups")) continue;
      if (muted(chat)) {
        mutedGroups.groups++;
        mutedGroups.count += aggregate.count;
        mutedGroups.chats.push({ jid: chat.jid, count: aggregate.count });
        continue;
      }
      const top = digest.topSenders(family, windowSpan(floor), now, 3);
      for (const sender of top) contactIds.add(sender.senderId);
      rawGroups.push({
        chat: chat.jid,
        chatRecord: chat,
        floor,
        count: aggregate.count,
        senders: aggregate.senders,
        topIds: top.map((sender) => sender.senderId),
        media: aggregate.media,
        polls: aggregate.polls,
        newestTs: aggregate.newestTs ?? 0,
        addressed: addressedId > 0 || inWaiting,
        hotId: null,
      });
      groupsToName.add(chat.jid);
      continue;
    }
    // A direct chat.
    if (aggregate.voiceUntranscribed > 0) {
      const voices = digest.untranscribedVoice(family, windowSpan(floor), now, VOICE_IDS_MAX);
      for (const voice of voices) noteVoice(sidOf(chat.jid, voice.keyId), privateChat(chat));
      voiceCount += Math.max(0, aggregate.voiceUntranscribed - voices.length);
    }
    if (!include.has("direct") || waitingChats.has(chat.id)) continue;
    const newest = digest.inboundTail(family, windowSpan(floor), now, 5, 400).find(quotable);
    rawDirect.push({
      chat: chat.jid,
      chatRecord: chat,
      count: aggregate.count,
      media: aggregate.media,
      polls: aggregate.polls,
      newestTs: aggregate.newestTs ?? 0,
      muted: muted(chat),
      private: privateChat(chat),
      quoteId: privateChat(chat) ? null : (newest?.id ?? null),
    });
    if (chat.contactId !== null) contactIds.add(chat.contactId);
    peopleToName.add(chat.jid);
  }

  // Polls and events nobody has answered for the user, even in a muted group.
  if (include.has("addressed") && hasWindow) {
    const me = own === "" ? null : db.identity.contactIdOf(own);
    for (const poll of digest.openPolls(windowSpan(sinceId), now, me)) {
      const chat = chatsById.get(poll.chatId) ?? db.identity.chatById(poll.chatId);
      if (chat === null || chat.kind !== "group" || leftGroups.has(chat.id) || host.leftGroup(chat)) continue;
      if (isExcluded(chat)) continue;
      const hidden = privateChat(chat) || privateSender(poll.senderId);
      rawAddressed.push({
        chat: chat.jid,
        kind: poll.type === "event" ? "event" : "poll",
        id: poll.id,
        sid: sidOf(poll.chatJid, poll.keyId),
        ts: poll.ts,
        more: 0,
        ...(hidden ? {} : { title: poll.text.replace(/^\[(?:poll|event|canceled event)\]\s*/, "") }),
        private: hidden,
        senderId: poll.senderId,
      });
      if (poll.senderId !== null) contactIds.add(poll.senderId);
      groupsToName.add(chat.jid);
    }
  }

  // Hot quotes: the most reacted message, or the newest one worth quoting — never from someone #private.
  for (const group of rawGroups) {
    if (privateChat(group.chatRecord)) continue;
    const family = familyOf(group.chatRecord);
    group.hotId =
      digest.mostReacted(family, windowSpan(group.floor), now, { excludeSenders: tags.privateSenders }) ??
      digest
        .inboundTail(family, windowSpan(group.floor), now, 10, 400)
        .find((message) => quotable(message) && message.text.length >= 20 && !privateSender(message.senderId))?.id ??
      null;
  }

  // -------------------------------------------------------------- missed calls
  type RawCall = { key: string; chatRecord: ChatRecord | null; personJid: string; count: number; video: boolean; lastId: number; lastTs: number; group?: string };
  const rawCalls = new Map<string, RawCall>();
  if (include.has("calls")) {
    for (const call of calls) {
      if (!inWindow(call) || call.fromMe) continue;
      const reading = readCallText(call.text);
      if (reading === null || reading.outcome !== "missed") continue;
      const chat = chatsById.get(call.chatId) ?? db.identity.chatById(call.chatId);
      if (chat === null || host.isNoise(chat.jid) || isExcluded(chat)) continue;
      let personJid = chat.jid;
      let group: string | undefined;
      if (chat.kind === "group") {
        const sender = call.senderId === null ? null : digest.contacts([call.senderId]).get(call.senderId);
        if (sender?.jid == null) continue;
        personJid = sender.jid;
        group = chat.jid;
      } else if (chat.kind !== "direct") {
        continue;
      }
      const entry = rawCalls.get(personJid) ?? {
        key: personJid,
        chatRecord: chat.kind === "direct" ? chat : db.identity.chat(personJid),
        personJid,
        count: 0,
        video: false,
        lastId: 0,
        lastTs: 0,
        ...(group === undefined ? {} : { group }),
      };
      entry.count++;
      entry.video ||= reading.video;
      if (call.id > entry.lastId) {
        entry.lastId = call.id;
        entry.lastTs = call.ts;
      }
      rawCalls.set(personJid, entry);
      peopleToName.add(personJid);
      if (group !== undefined) groupsToName.add(group);
    }
  }

  // -------------------------------------------------------------- stories
  let rawStories: { count: number; authors: number[] } | null = null;
  if (include.has("stories") && hasWindow) {
    const statusId = digest.statusChatId();
    if (statusId !== null) {
      const found = digest.stories(statusId, windowSpan(sinceId), now);
      if (found.count > 0) {
        rawStories = found;
        for (const author of found.authors.slice(0, 5)) contactIds.add(author);
      }
    }
  }

  // -------------------------------------------------------------- names
  const contacts = digest.contacts([...contactIds]);
  for (const contact of contacts.values()) if (contact.jid !== null) peopleToName.add(contact.jid);
  const namingGroups = [...rawGroups]
    .sort((a, b) => b.count - a.count || byJid(a, b))
    .map((group) => group.chat)
    .concat([...groupsToName])
    .filter((jid, index, all) => all.indexOf(jid) === index)
    .slice(0, GROUP_META_MAX);
  await host.prepareNames(namingGroups, [...peopleToName]);
  const personName = (contactId: number | null, fallback: string): string => {
    const jid = contactId === null ? null : (contacts.get(contactId)?.jid ?? null);
    return jid === null ? fallback : host.nameOf(jid);
  };
  const noteOf = (jid: string): { note?: string; tags?: string[] } => {
    const note = host.noteOf(jid);
    const tags = host.tagsOf?.(jid);
    return { ...(note === undefined || note === "" ? {} : { note }), ...(tags === undefined || tags.length === 0 ? {} : { tags }) };
  };
  const personFlags = (chat: ChatRecord): { saved: boolean; business: boolean; unknown: boolean } => {
    const contact = chat.contactId === null ? undefined : contacts.get(chat.contactId);
    const saved = isRealName(contact?.name ?? null);
    return { saved, business: contact?.verifiedName != null, unknown: !saved && (contact?.listed ?? null) === null };
  };

  const waiting: WaitingEntry[] = rawWaiting
    .map(({ chatRecord, senderId, ...entry }) => ({
      ...entry,
      name: host.nameOf(entry.chat),
      ...noteOf(entry.chat),
      business: entry.group ? false : personFlags(chatRecord).business,
      unknown: entry.group ? false : personFlags(chatRecord).unknown && !personFlags(chatRecord).business,
      ...(entry.group ? { from: personName(senderId, "someone") } : {}),
    }))
    .sort(
      (a, b) =>
        Number(a.group) - Number(b.group) ||
        Number(urgent(b.signals)) - Number(urgent(a.signals)) ||
        a.ask.ts - b.ask.ts ||
        byJid(a, b)
    );

  const addressed: AddressedEntry[] = rawAddressed
    .map(({ senderId, ...entry }) => ({ ...entry, name: host.nameOf(entry.chat), from: personName(senderId, "someone") }))
    .sort((a, b) => {
      const rank = (entry: AddressedEntry): number => (entry.kind === "mention" || entry.kind === "reply" ? 0 : 1);
      return rank(a) - rank(b) || b.ts - a.ts || a.id - b.id;
    });

  const direct: DirectEntry[] = rawDirect
    .map(({ chatRecord, ...entry }) => ({ ...entry, name: host.nameOf(entry.chat), ...noteOf(entry.chat), ...personFlags(chatRecord) }))
    .sort((a, b) => {
      const tier = (entry: DirectEntry): number =>
        entry.muted ? 3 : entry.business || entry.unknown ? 2 : entry.saved ? 0 : 1;
      return tier(a) - tier(b) || b.count - a.count || b.newestTs - a.newestTs || byJid(a, b);
    });

  const groups: GroupEntry[] = rawGroups
    .map(({ chatRecord: _chat, floor: _floor, topIds, ...entry }) => ({
      ...entry,
      name: host.nameOf(entry.chat),
      top: topIds.map((id) => personName(id, "someone")),
    }))
    .sort((a, b) => b.count - a.count || b.newestTs - a.newestTs || byJid(a, b));

  const callEntries: CallsEntry[] = [...rawCalls.values()]
    .map((entry) => {
      const chat = entry.chatRecord;
      const calledBack = (chat === null ? [] : (callsByChat.get(chat.id) ?? [])).some((call) => call.fromMe && call.id > entry.lastId);
      const wroteAfter = chat !== null && (ownThrough(chat) ?? 0) > entry.lastId && digest.ownWroteIn(familyOf(chat), entry.lastId, untilId);
      return {
        chat: entry.personJid,
        name: host.nameOf(entry.personJid),
        count: entry.count,
        video: entry.video,
        lastTs: entry.lastTs,
        calledBack,
        wroteAfter,
        ...(entry.group === undefined ? {} : { group: host.nameOf(entry.group) }),
      };
    })
    .sort(
      (a, b) =>
        Number(a.calledBack || a.wroteAfter) - Number(b.calledBack || b.wroteAfter) ||
        b.count - a.count ||
        b.lastTs - a.lastTs ||
        byJid(a, b)
    );

  const stories: StoriesEntry | null =
    rawStories === null
      ? null
      : {
          count: rawStories.count,
          authors: rawStories.authors.slice(0, 5).map((id) => personName(id, "someone")),
          more: Math.max(0, rawStories.authors.length - 5),
        };

  return {
    accountId: account.id,
    accountName: account.name,
    connection: host.connection(),
    window,
    waiting,
    addressed,
    calls: callEntries,
    direct,
    groups,
    mutedGroups:
      mutedGroups.groups === 0
        ? null
        : {
            groups: mutedGroups.groups,
            count: mutedGroups.count,
            names: mutedGroups.chats
              .sort((a, b) => b.count - a.count || (a.jid < b.jid ? -1 : 1))
              .slice(0, 3)
              .map((chat) => host.nameOf(chat.jid)),
          },
    stories,
    voiceUntranscribed: voiceIds,
    voiceUntranscribedCount: voiceCount,
    skipped,
  };
}

/** The messages a page quotes, read in full by id (≤60 per page). */
export function quotesOf(db: AccountDb, ids: readonly number[]): CatchupQuote[] {
  return db.messages.byIds([...new Set(ids)]).map((message) => {
    const spoken = message.transcript !== null && message.transcript.trim() !== "" && (message.type === "voice" || message.type === "audio");
    return {
      id: message.id,
      sid: message.sid,
      type: message.type,
      text: spoken ? message.transcript!.trim() : (message.text ?? "").trim(),
      transcribed: spoken,
    };
  });
}
