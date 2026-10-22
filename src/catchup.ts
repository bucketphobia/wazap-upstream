/**
 * catch_up (F2-2): what the user missed, in one call, within a token budget.
 *
 * Each account scans its own window (catchup-scan.ts); this merges the
 * accounts, lays the entries out in section order, spends the budget and
 * renders one line per entry, as text and as structured content built from
 * the same entries.
 *
 * The budget, in the order it is spent (tokens are rendered characters / 4):
 * 1. the skeleton — every entry's line without a quote, in section order —
 *    until the page is full; what does not fit goes to `more`, with a cursor;
 * 2. quotes, by priority: the ask of someone waiting (240 characters), a
 *    mention or reply (200), a person's newest message (160), a group's hot
 *    message (120); one per chat, at most 60 per page;
 * 3. when they do not all fit, the lowest-priority quotes shrink to 80
 *    characters, and then the lowest-priority ones go.
 *
 * Paging: the first page computes the whole digest, every account's entries,
 * and when they do not fit it is held in memory (a snapshot) under a random
 * cursor: later pages serve from it and never scan again, so what the phone
 * reads, a chat that folds or an account that fails meanwhile changes none of
 * them. A snapshot is bound to the client that made it, lives 15 minutes past
 * its last page, and at most MAX_SNAPSHOTS are held; a cursor it no longer
 * knows is CURSOR_EXPIRED, with no mark moved. A client's mark moves to an
 * account's window top only once every entry of the digest was given — a
 * digest with no `more`, or its last page — for an account whose scan
 * answered, and only by compare-and-set, so two catch-ups of one client racing
 * each other move it once.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AccountSource } from "./account-hub.js";
import {
  CATCHUP_SECTIONS,
  WINDOW_FLOOR_MS,
  type AddressedEntry,
  type CallsEntry,
  type CatchupQuote,
  type CatchupScan,
  type CatchupSection,
  type CatchupTagJids,
  type CatchupWindow,
  type CatchupWindowSpec,
  type DirectEntry,
  type GroupEntry,
  type WaitingEntry,
  type WindowBasis,
} from "./catchup-scan.js";
import { asWazapError, WazapError } from "./errors.js";
import { isoWithOffset } from "./messages.js";
import { signalsOf, type Signal } from "./signals.js";
import type { ToolResult } from "./tool-runtime.js";
import type { PrivateRule, WhatsAppApi } from "./wa-types.js";

export const DEFAULT_BUDGET_TOKENS = 2_500;
export const MIN_BUDGET_TOKENS = 500;
export const MAX_BUDGET_TOKENS = 8_000;
/** Quotes read back in full per page. */
const MAX_QUOTES = 60;
/** What a quote shrinks to before it is dropped. */
const SHORT_QUOTE = 80;
/** A quote's length by the section it belongs to; the order is the priority. */
const QUOTE_CAPS: Partial<Record<CatchupSection, number>> = { waiting: 240, addressed: 200, direct: 160, groups: 120 };
/** A poll's question or an event's line, in the skeleton. */
const TITLE_CHARS = 80;
/** How long a digest's later pages stay servable after the last page given. */
export const SNAPSHOT_TTL_MS = 15 * 60_000;
/** Digests held for their later pages at once, every client together; the least recently paged goes first. */
export const MAX_SNAPSHOTS = 16;

const HOUR = 3_600_000;

// ---------------------------------------------------------------- input and output

export const CATCHUP_INPUT = {
  since: z
    .string()
    .min(1)
    .optional()
    .describe('"last" (default); "previous" repeats that catch-up; or an ISO date or time from the last 14 days'),
  hours: z
    .number()
    .min(1)
    .max(336)
    .optional()
    .describe("The last N hours instead; never moves the mark"),
  budget_tokens: z
    .number()
    .int()
    .min(MIN_BUDGET_TOKENS)
    .max(MAX_BUDGET_TOKENS)
    .default(DEFAULT_BUDGET_TOKENS)
    .describe("Answer length in tokens"),
  include: z
    .array(z.enum(CATCHUP_SECTIONS))
    .min(1)
    .optional()
    .describe("Only these sections; the mark then stays"),
  cursor: z.string().min(1).optional().describe("more.cursor"),
};

const windowShape = z.object({
  since: z.string(),
  until: z.string(),
  hours: z.number(),
  basis: z.string(),
});

// Every key an entry may carry, and no other: a client validates the answer against this schema.
const acct = z.string().optional().describe("The account the entry is from, when the catch-up covers several");
const at = z.string().describe("When, as a clock time (with the day when not today)");
const q = z.string().optional().describe("Quote: the message's own words, cut to fit the budget");
const sig = z.string().optional().describe("Signals in the quote, comma-separated: amount, date, time, address, link, question");
const media = z.record(z.number()).optional().describe("Media by kind: image, video, voice, audio, document, sticker, location, contact");
const privateFlag = z.literal(true).optional().describe("Someone the user tagged #private: counted, never quoted");

const waitingEntry = z.object({
  acct,
  chat: z.string(),
  name: z.string(),
  note: z.string().optional(),
  tags: z.array(z.string()).optional(),
  group: z.literal(true).optional(),
  from: z.string().optional().describe("In a group: who asks"),
  business: z.literal(true).optional(),
  unknown: z.literal(true).optional().describe("A number the user never saved"),
  at,
  n: z.number().optional().describe("Their messages since the user's last one"),
  new: z.literal(true).optional().describe("Asked since this client's last catch-up"),
  before_window: z.literal(true).optional().describe("Asked before an explicit window: still open, not new"),
  private: privateFlag,
  type: z.string().optional(),
  voice: z.string().optional().describe("A voice note's length"),
  transcribed: z.boolean().optional(),
  sig,
  call_after: z
    .object({ at: z.string(), outgoing: z.literal(true).optional(), seconds: z.number().optional() })
    .optional()
    .describe("An answered call after the ask: it may have been dealt with by phone"),
  q,
  then: z.string().optional().describe("What they sent after the ask, quoted with it"),
});

const addressedEntry = z.object({
  acct,
  chat: z.string(),
  name: z.string(),
  kind: z.enum(["mention", "reply", "poll", "event"]),
  from: z.string(),
  at,
  more: z.number().optional().describe("Other mentions and replies in the chat"),
  title: z.string().optional().describe("A poll's question or an event's name"),
  private: privateFlag,
  q,
  sig,
});

const callsEntry = z.object({
  acct,
  chat: z.string(),
  name: z.string(),
  n: z.number().describe("Missed calls from them"),
  video: z.literal(true).optional(),
  last: z.string().describe("When the last one rang"),
  group: z.string().optional().describe("The group the call rang in"),
  called_back: z.literal(true).optional(),
  wrote_after: z.literal(true).optional(),
});

const directEntry = z.object({
  acct,
  chat: z.string(),
  name: z.string(),
  note: z.string().optional(),
  tags: z.array(z.string()).optional(),
  n: z.number().describe("New messages"),
  at,
  media,
  polls: z.number().optional(),
  business: z.literal(true).optional(),
  unknown: z.literal(true).optional().describe("A number the user never saved"),
  muted: z.literal(true).optional(),
  private: privateFlag,
  q,
  sig,
  more_in_chat: z.number().optional().describe("New messages besides the one quoted"),
});

const groupEntry = z.object({
  acct,
  chat: z.string(),
  name: z.string(),
  n: z.number().describe("New messages"),
  senders: z.number(),
  top: z.array(z.string()).describe("Who wrote most, at most three"),
  at,
  media,
  polls: z.number().optional(),
  addressed: z.literal(true).optional().describe("Someone mentioned, replied to or asked the user here"),
  hot: z.string().optional().describe("Quote: the most reacted message, or the newest worth quoting"),
  sig,
});

const mutedGroupsEntry = z.object({
  acct,
  muted_or_archived: z.literal(true),
  groups: z.number(),
  n: z.number().describe("New messages across them"),
  names: z.array(z.string()).describe("The busiest, at most three"),
});

const storiesEntry = z.object({
  acct,
  n: z.number().describe("Stories"),
  authors: z.array(z.string()).describe("The most recent authors, at most five"),
  more: z.number().optional().describe("Other authors"),
});

const skipCount = z.object({ chats: z.number(), messages: z.number() });
const footerShape = {
  voice_untranscribed: z.array(z.string()).optional().describe("Voice notes nobody transcribed, by message id, for get_media"),
  voice_untranscribed_more: z.number().optional().describe("Voice notes nobody transcribed that are not named"),
  skipped: z
    .object({ no_catchup: skipCount.optional(), left_groups: skipCount.optional(), newsletters: skipCount.optional(), broadcasts: skipCount.optional() })
    .optional()
    .describe("What was left out, counted"),
  history_sync: z.string().optional(),
  mentions_indexing: z.literal(true).optional(),
};

/** The structured content catch_up answers with; every entry keeps its own short keys. */
export const CATCHUP_OUTPUT = {
  window: windowShape,
  accounts: z.array(
    z.object({
      account_id: z.string(),
      name: z.string(),
      status: z.string(),
      status_since: z.string().optional(),
      sync: z.string().optional(),
      window: windowShape.optional(),
      mark: z.object({ moved: z.boolean(), why: z.string().optional(), next_since: z.string().optional() }).optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    })
  ),
  waiting: z.array(waitingEntry),
  addressed: z.array(addressedEntry),
  missed_calls: z.array(callsEntry),
  direct: z.array(directEntry),
  groups: z.array(z.union([groupEntry, mutedGroupsEntry])),
  stories: z.array(storiesEntry),
  footer: z
    .union([z.object(footerShape), z.object({ accounts: z.array(z.object({ acct: z.string(), ...footerShape })) })])
    .nullable()
    .describe("On the last page: what the entries leave out"),
  more: z
    .object({ cursor: z.string(), remaining: z.record(z.number()), approx_tokens: z.number() })
    .nullable()
    .describe("Set when entries are left: call catch_up again with more.cursor"),
  approx_tokens: z.number(),
  notes: z.array(z.string()).optional().describe("Caveats to act on or tell the user"),
  account_id: z.string().nullable(),
};

export interface CatchupArgs {
  since?: string;
  hours?: number;
  budget_tokens?: number;
  include?: CatchupSection[];
  cursor?: string;
  account_id?: string;
}

/** What catch_up needs from the tool runtime. */
export interface CatchupContext {
  hub: AccountSource;
  /** The account the call resolved to. */
  accountId: string;
  wa: WhatsAppApi;
  /** Who is catching up: an OAuth client id, a token's label, or `local`. */
  client: string;
  /** The clock a first page starts at and cursors expire by; Date.now when omitted (the bench fixes it). */
  now?: () => number;
}

// ---------------------------------------------------------------- formatting

function clock(ms: number, now: number): string {
  const at = new Date(ms);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  if (at.toDateString() === today.toDateString()) return time;
  const days = (now - ms) / 86_400_000;
  const weekday = at.toLocaleDateString("en-GB", { weekday: "short" });
  if (days < 6 && days > -1) return `${weekday} ${time}`;
  return `${at.getDate()} ${at.toLocaleDateString("en-GB", { month: "short" })} ${time}`;
}

/** "Wed 12:29 – Thu 12:29": an end on another day than the start says its day too, even today. */
function span(from: number, to: number, now: number): string {
  const start = clock(from, now);
  if (new Date(from).toDateString() === new Date(to).toDateString()) return `${start} – ${clock(to, now)}`;
  const end = new Date(to);
  const time = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
  const day = (now - to) / 86_400_000;
  const label = day < 6 && day > -1 ? end.toLocaleDateString("en-GB", { weekday: "short" }) : `${end.getDate()} ${end.toLocaleDateString("en-GB", { month: "short" })}`;
  return `${start} – ${label} ${time}`;
}

function age(ms: number, now: number): string {
  const elapsed = Math.max(0, now - ms);
  if (elapsed >= 86_400_000) return `${Math.floor(elapsed / 86_400_000)}d`;
  if (elapsed >= HOUR) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed >= 60_000) return `${Math.floor(elapsed / 60_000)}m`;
  return "now";
}

/** Whitespace, line breaks included, as single spaces: what someone else wrote stays on its line. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The tags the user filed someone under, after their name: " #client #autopeloc", or "". Stored tags hold no whitespace. */
function tagsLabel(tags: readonly string[] | undefined): string {
  return tags?.length ? ` ${tags.map((tag) => `#${tag}`).join(" ")}` : "";
}

function cut(text: string, max: number): string {
  const line = flat(text);
  const chars = [...line];
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join("")}…`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${Math.floor(minutes / 60)}h ${minutes % 60} min`;
}

const MEDIA_WORDS: Record<string, [string, string]> = {
  image: ["photo", "photos"],
  video: ["video", "videos"],
  voice: ["voice note", "voice notes"],
  audio: ["audio", "audios"],
  document: ["document", "documents"],
  sticker: ["sticker", "stickers"],
  location: ["location", "locations"],
  contact: ["contact card", "contact cards"],
};

function mediaLabel(media: Partial<Record<string, number>>, polls: number): string {
  const parts = Object.entries(media).flatMap(([type, n]) => {
    const words = MEDIA_WORDS[type];
    return n === undefined || n === 0 || words === undefined ? [] : [`${n} ${n === 1 ? words[0] : words[1]}`];
  });
  if (polls > 0) parts.push(plural(polls, "poll"));
  return parts.join(", ");
}

function windowOf(window: CatchupWindow): { since: string; until: string; hours: number; basis: WindowBasis } {
  const since = window.sinceAt;
  const until = window.untilAt;
  return {
    since: isoWithOffset(since),
    until: isoWithOffset(until),
    hours: Math.round(((until - since) / HOUR) * 10) / 10,
    basis: window.basis,
  };
}

function windowPhrase(window: CatchupWindow, now: number): string {
  const since = window.sinceAt;
  switch (window.basis) {
    case "last":
      return `since your last catch-up (${clock(since, now)})`;
    case "first_run":
      return "the last 24 h (first catch-up here)";
    case "mark_expired":
      return "the last 24 h (the last catch-up was over 7 days ago)";
    case "previous":
      return `the previous catch-up again (${span(since, window.untilAt, now)})`;
    case "hours":
      return `the last ${Math.round((now - since) / HOUR)} h`;
    case "since":
      return `since ${clock(since, now)}`;
  }
}

// ---------------------------------------------------------------- entries as items

/** A quote as placed: the message's words cut to their level, and for someone waiting, what they sent after the ask. */
type Quoted = { text: string; signals: Signal[]; then?: string } | null;

interface Item {
  section: CatchupSection;
  account: string;
  /** One quote per chat: the account and the chat. */
  chatKey: string;
  quoteId: number | null;
  /** Someone waiting: their newest message after the ask, sharing the ask's quote. */
  thenId: number | null;
  line(quote: Quoted): string;
  data(quote: Quoted): Record<string, unknown>;
  /** Someone waiting since before an explicit window (hours, or an ISO since): still open, not new. */
  beforeWindow?: true;
}

interface AccountView {
  id: string;
  name: string;
  source: WhatsAppApi;
  scan: CatchupScan | null;
  error: WazapError | null;
}

const SECTION_TITLES: Record<CatchupSection, string> = {
  waiting: "Waiting on you",
  addressed: "Mentions, replies and polls",
  calls: "Missed calls",
  direct: "People",
  groups: "Groups",
  stories: "Stories",
};

const STRUCTURED_KEYS: Record<CatchupSection, string> = {
  waiting: "waiting",
  addressed: "addressed",
  calls: "missed_calls",
  direct: "direct",
  groups: "groups",
  stories: "stories",
};

function sigOf(quote: NonNullable<Quoted>): { sig?: string } {
  return quote.signals.length === 0 ? {} : { sig: quote.signals.join(",") };
}

function quoteSuffix(quote: Quoted, withSignals: boolean): string {
  if (quote === null) return "";
  const markers = withSignals && quote.signals.length > 0 ? ` [${quote.signals.join(",")}]` : "";
  // Quoted as JSON strings: a quotation mark inside cannot end the quote and forge what follows.
  const then = quote.then === undefined ? "" : ` · then ${JSON.stringify(quote.then)}`;
  return `${quote.text === "" ? "" : ` — ${JSON.stringify(quote.text)}`}${markers}${then}`;
}

/** Shortest a "then" quote is worth showing. */
const THEN_MIN = 20;

/**
 * An ask and what followed it inside one quote of `level` characters: the
 * ask keeps at least two thirds when both are long, the rest goes to the
 * newer message, which is left out when too little room remains.
 */
function composeQuote(ask: string, then: string | null, level: number): { text: string; then?: string } {
  if (then === null) return { text: cut(ask, level) };
  if (ask === "") return { text: "", then: cut(then, level) };
  const thenChars = [...then].length;
  const askText = cut(ask, level - Math.min(thenChars, Math.floor(level / 3)));
  const room = level - [...askText].length;
  return room < THEN_MIN ? { text: askText } : { text: askText, then: cut(then, room) };
}

/**
 * The scan with every name, note and title others control — a group's
 * subject, a push name, a poll's question — on one line, so none of them can
 * start a line of the answer.
 */
function flatScan(scan: CatchupScan): CatchupScan {
  const note = <T extends { note?: string }>(entry: T): T => (entry.note === undefined ? entry : { ...entry, note: flat(entry.note) });
  return {
    ...scan,
    waiting: scan.waiting.map((entry) => note({ ...entry, name: flat(entry.name), ...(entry.from === undefined ? {} : { from: flat(entry.from) }) })),
    addressed: scan.addressed.map((entry) => ({
      ...entry,
      name: flat(entry.name),
      from: flat(entry.from),
      ...(entry.title === undefined ? {} : { title: flat(entry.title) }),
    })),
    calls: scan.calls.map((entry) => ({ ...entry, name: flat(entry.name), ...(entry.group === undefined ? {} : { group: flat(entry.group) }) })),
    direct: scan.direct.map((entry) => note({ ...entry, name: flat(entry.name) })),
    groups: scan.groups.map((entry) => ({ ...entry, name: flat(entry.name), top: entry.top.map(flat) })),
    mutedGroups: scan.mutedGroups === null ? null : { ...scan.mutedGroups, names: scan.mutedGroups.names.map(flat) },
    stories: scan.stories === null ? null : { ...scan.stories, authors: scan.stories.authors.map(flat) },
  };
}

function itemsOf(view: AccountView, multi: boolean, now: number): Item[] {
  const scan = flatScan(view.scan!);
  const account = view.id;
  const tag = multi ? { acct: account } : {};
  const key = (chat: string): string => `${account}|${chat}`;
  const items: Item[] = [];
  // An explicit window still lists every open ask of the 14 days; the ones asked before it say so.
  const explicit = scan.window.basis === "hours" || scan.window.basis === "since";

  scan.waiting.forEach((entry: WaitingEntry) => {
    const before = explicit && !entry.newSinceLast;
    items.push({
      section: "waiting",
      account,
      ...(before ? { beforeWindow: true as const } : {}),
      chatKey: key(entry.chat),
      quoteId: entry.private || (entry.ask.type === "voice" && !entry.ask.transcribed) ? null : entry.ask.id,
      thenId: entry.thenId ?? null,
      line: (quote) => {
        const who = `${entry.name}${tagsLabel(entry.tags)}${entry.note ? ` (${entry.note})` : ""}${entry.group ? " [group]" : ""}${entry.business ? " [business]" : entry.unknown ? " [not saved]" : ""}`;
        const parts = [
          `- ${who}`,
          ...(entry.from ? [`${entry.from} asks`] : []),
          `since ${clock(entry.ask.ts, now)} (${age(entry.ask.ts, now)})`,
          ...(entry.sinceYou > 1 ? [`${entry.sinceYou} msgs since you`] : []),
          ...(entry.newSinceLast ? ["new"] : []),
          ...(before ? ["from before this window"] : []),
          ...(entry.private ? ["private"] : []),
          ...(entry.ask.type === "voice" || entry.ask.type === "audio"
            ? [`voice${entry.ask.voice ? ` ${entry.ask.voice}` : ""}${entry.ask.transcribed ? "" : ", not transcribed"}`]
            : []),
          ...(entry.signals.length > 0 ? [entry.signals.join(",")] : []),
          ...(entry.callAfter
            ? [
                `then ${entry.callAfter.outgoing ? "you called" : "they called"} ${clock(entry.callAfter.ts, now)}${entry.callAfter.seconds ? ` (${durationLabel(entry.callAfter.seconds)})` : ""}`,
              ]
            : []),
        ];
        return `${parts.join(" · ")}${quoteSuffix(quote, false)} · ${entry.chat}`;
      },
      data: (quote) => ({
        ...tag,
        chat: entry.chat,
        name: entry.name,
        ...(entry.note ? { note: entry.note } : {}),
        ...(entry.tags ? { tags: entry.tags } : {}),
        ...(entry.group ? { group: true, from: entry.from } : {}),
        ...(entry.business ? { business: true } : {}),
        ...(entry.unknown ? { unknown: true } : {}),
        at: clock(entry.ask.ts, now),
        ...(entry.sinceYou > 1 ? { n: entry.sinceYou } : {}),
        ...(entry.newSinceLast ? { new: true } : {}),
        ...(before ? { before_window: true } : {}),
        ...(entry.private ? { private: true } : {}),
        ...(entry.ask.type === "text" ? {} : { type: entry.ask.type }),
        ...(entry.ask.voice ? { voice: entry.ask.voice } : {}),
        ...(entry.ask.type === "voice" || entry.ask.type === "audio" ? { transcribed: entry.ask.transcribed } : {}),
        ...(entry.signals.length > 0 ? { sig: entry.signals.join(",") } : {}),
        ...(entry.callAfter
          ? {
              call_after: {
                at: clock(entry.callAfter.ts, now),
                ...(entry.callAfter.outgoing ? { outgoing: true } : {}),
                ...(entry.callAfter.seconds ? { seconds: entry.callAfter.seconds } : {}),
              },
            }
          : {}),
        ...(quote && quote.text !== "" ? { q: quote.text } : {}),
        ...(quote?.then === undefined ? {} : { then: quote.then }),
      }),
    });
  });

  scan.addressed.forEach((entry: AddressedEntry) => {
    const verb =
      entry.kind === "mention" ? "mentioned you" : entry.kind === "reply" ? "replied to you" : entry.kind === "poll" ? "asks for your vote" : "invites you";
    items.push({
      section: "addressed",
      account,
      chatKey: key(entry.chat),
      quoteId: !entry.private && (entry.kind === "mention" || entry.kind === "reply") ? entry.id : null,
      thenId: null,
      line: (quote) =>
        `- ${entry.name} · ${entry.from} ${verb} · ${clock(entry.ts, now)}${entry.more > 0 ? ` (+${entry.more} more)` : ""}${
          entry.title ? `: ${JSON.stringify(cut(entry.title, TITLE_CHARS))}` : ""
        }${entry.private ? " · private" : ""}${quoteSuffix(quote, true)} · ${entry.chat}`,
      data: (quote) => ({
        ...tag,
        chat: entry.chat,
        name: entry.name,
        kind: entry.kind,
        from: entry.from,
        at: clock(entry.ts, now),
        ...(entry.more > 0 ? { more: entry.more } : {}),
        ...(entry.title ? { title: cut(entry.title, TITLE_CHARS) } : {}),
        ...(entry.private ? { private: true } : {}),
        ...(quote ? { q: quote.text, ...sigOf(quote) } : {}),
      }),
    });
  });

  scan.calls.forEach((entry: CallsEntry) => {
    items.push({
      section: "calls",
      account,
      chatKey: key(entry.chat),
      quoteId: null,
      thenId: null,
      line: () =>
        `- ${entry.name}${entry.group ? ` (in ${entry.group})` : ""} · ${entry.count} missed ${entry.video ? "video" : "voice"} call${entry.count === 1 ? "" : "s"} · last ${clock(entry.lastTs, now)}${
          entry.calledBack ? " · you called back" : ""
        }${entry.wroteAfter ? " · you wrote after" : ""} · ${entry.chat}`,
      data: () => ({
        ...tag,
        chat: entry.chat,
        name: entry.name,
        n: entry.count,
        ...(entry.video ? { video: true } : {}),
        last: clock(entry.lastTs, now),
        ...(entry.group ? { group: entry.group } : {}),
        ...(entry.calledBack ? { called_back: true } : {}),
        ...(entry.wroteAfter ? { wrote_after: true } : {}),
      }),
    });
  });

  scan.direct.forEach((entry: DirectEntry) => {
    const media = mediaLabel(entry.media, entry.polls);
    items.push({
      section: "direct",
      account,
      chatKey: key(entry.chat),
      quoteId: entry.quoteId,
      thenId: null,
      line: (quote) => {
        const who = `${entry.name}${tagsLabel(entry.tags)}${entry.note ? ` (${entry.note})` : ""}${entry.business ? " [business]" : entry.unknown ? " [not saved]" : ""}${entry.muted ? " [muted]" : ""}`;
        const more = quote !== null && entry.count > 1 ? ` (+${entry.count - 1} more)` : "";
        return `- ${who} · ${entry.count} new · ${clock(entry.newestTs, now)}${media ? ` · ${media}` : ""}${entry.private ? " · private" : ""}${quoteSuffix(quote, true)}${more} · ${entry.chat}`;
      },
      data: (quote) => ({
        ...tag,
        chat: entry.chat,
        name: entry.name,
        ...(entry.note ? { note: entry.note } : {}),
        ...(entry.tags ? { tags: entry.tags } : {}),
        n: entry.count,
        at: clock(entry.newestTs, now),
        ...(Object.keys(entry.media).length > 0 ? { media: entry.media } : {}),
        ...(entry.polls > 0 ? { polls: entry.polls } : {}),
        ...(entry.business ? { business: true } : {}),
        ...(entry.unknown ? { unknown: true } : {}),
        ...(entry.muted ? { muted: true } : {}),
        ...(entry.private ? { private: true } : {}),
        ...(quote
          ? { q: quote.text, ...sigOf(quote), ...(entry.count > 1 ? { more_in_chat: entry.count - 1 } : {}) }
          : {}),
      }),
    });
  });

  scan.groups.forEach((entry: GroupEntry) => {
    const media = mediaLabel(entry.media, entry.polls);
    items.push({
      section: "groups",
      account,
      chatKey: key(entry.chat),
      quoteId: entry.hotId,
      thenId: null,
      line: (quote) =>
        `- ${entry.name} · ${entry.count} new from ${entry.senders}${entry.top.length > 0 ? ` (${entry.top.join(", ")})` : ""}${media ? ` · ${media}` : ""}${
          entry.addressed ? " · addresses you" : ""
        }${quoteSuffix(quote, true)} · ${entry.chat}`,
      data: (quote) => ({
        ...tag,
        chat: entry.chat,
        name: entry.name,
        n: entry.count,
        senders: entry.senders,
        top: entry.top,
        at: clock(entry.newestTs, now),
        ...(Object.keys(entry.media).length > 0 ? { media: entry.media } : {}),
        ...(entry.polls > 0 ? { polls: entry.polls } : {}),
        ...(entry.addressed ? { addressed: true } : {}),
        ...(quote ? { hot: quote.text, ...sigOf(quote) } : {}),
      }),
    });
  });

  const muted = scan.mutedGroups;
  if (muted !== null) {
    items.push({
      section: "groups",
      account,
      chatKey: key("#muted"),
      quoteId: null,
      thenId: null,
      line: () => `- Muted or archived: ${plural(muted.groups, "group")}, ${muted.count} new (${muted.names.join(", ")}${muted.groups > muted.names.length ? ", …" : ""})`,
      data: () => ({ ...tag, muted_or_archived: true, groups: muted.groups, n: muted.count, names: muted.names }),
    });
  }

  const stories = scan.stories;
  if (stories !== null) {
    items.push({
      section: "stories",
      account,
      chatKey: key("#stories"),
      quoteId: null,
      thenId: null,
      line: () => `- ${plural(stories.count, "story", "stories")} from ${stories.authors.join(", ")}${stories.more > 0 ? ` +${stories.more}` : ""}`,
      data: () => ({ ...tag, n: stories.count, authors: stories.authors, ...(stories.more > 0 ? { more: stories.more } : {}) }),
    });
  }
  return items;
}

// ---------------------------------------------------------------- snapshots

type Mark = { moved: boolean; why?: string; next_since?: string };

/**
 * A digest being given page by page: every account's entries as its first
 * page computed them, and the cursors handed out so far. Pages served from it
 * read no window again; only their quotes are read back by id.
 */
interface Snapshot {
  client: string;
  include: CatchupSection[];
  now: number;
  multi: boolean;
  views: AccountView[];
  answered: AccountView[];
  /** Every entry, in section order; within a section, account by account. */
  items: Item[];
  cursors: Set<string>;
  /** Set by the last page: asked for again, it answers the same marks. */
  marks: Map<string, Mark> | null;
  usedAt: number;
}

/** Held snapshots, the least recently paged first. */
const held: Snapshot[] = [];
const byCursor = new Map<string, { snapshot: Snapshot; start: number }>();

function release(snapshot: Snapshot): void {
  const at = held.indexOf(snapshot);
  if (at !== -1) held.splice(at, 1);
  for (const cursor of snapshot.cursors) byCursor.delete(cursor);
}

function hold(snapshot: Snapshot, asked: number): void {
  const at = held.indexOf(snapshot);
  if (at !== -1) held.splice(at, 1);
  held.push(snapshot);
  snapshot.usedAt = asked;
  while (held.length > MAX_SNAPSHOTS) release(held[0]!);
}

/** Random bytes in a cursor; base64url spells them in CURSOR_CHARS characters. */
const CURSOR_BYTES = 18;
const CURSOR_CHARS = Math.ceil((CURSOR_BYTES * 4) / 3);

function cursorFor(snapshot: Snapshot, start: number): string {
  const cursor = randomBytes(CURSOR_BYTES).toString("base64url");
  snapshot.cursors.add(cursor);
  byCursor.set(cursor, { snapshot, start });
  return cursor;
}

function cursorExpired(): WazapError {
  return new WazapError(
    "CURSOR_EXPIRED",
    "That catch_up cursor is unknown or expired: its digest is no longer held (15 minutes after its last page, or a restart).",
    "Call catch_up again without cursor; the mark has not moved"
  );
}

/** The page a cursor names, for the client that made it; anything else is CURSOR_EXPIRED. */
function pageAt(cursor: string, client: string, asked: number): { snapshot: Snapshot; start: number } {
  for (const snapshot of [...held]) if (asked - snapshot.usedAt > SNAPSHOT_TTL_MS) release(snapshot);
  const found = byCursor.get(cursor);
  if (found === undefined || found.snapshot.client !== client) throw cursorExpired();
  hold(found.snapshot, asked);
  return found;
}

// ---------------------------------------------------------------- the run

/** YYYY-MM-DD, or with THH:MM[:SS[.sss]] and an optional Z or ±HH:MM. */
const ISO_SINCE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * An ISO `since`, strictly: a real calendar date or time (none of the
 * formats Date.parse guesses at, "Sep 16" read as 2001), no later than now
 * and no earlier than the 14 days any window reaches. A date alone is local
 * midnight, and so is a time without an offset local.
 */
function sinceOf(since: string, now: number): number {
  const refuse = (why: string): WazapError =>
    new WazapError("INVALID_ID", `since ${why}: "${since}".`, 'Pass "last", "previous", or an ISO date or time from the last 14 days, like "2026-09-16" or "2026-09-16T18:00:00+03:00"');
  const match = ISO_SINCE.exec(since);
  if (match === null) throw refuse('is not "last", "previous" or an ISO date or time');
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  const fields = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  const real =
    fields.getUTCFullYear() === Number(year) &&
    fields.getUTCMonth() === Number(month) - 1 &&
    fields.getUTCDate() === Number(day) &&
    fields.getUTCHours() === Number(hour) &&
    fields.getUTCMinutes() === Number(minute) &&
    fields.getUTCSeconds() === Number(second);
  const ms = Date.parse(match[4] === undefined ? `${since}T00:00:00` : since);
  if (!real || Number.isNaN(ms)) throw refuse("is not a real date or time");
  if (ms > now) throw refuse("is in the future");
  if (ms < now - WINDOW_FLOOR_MS) throw refuse("is more than 14 days ago, further than a catch-up reads");
  return ms;
}

function specOf(args: CatchupArgs, now: number): CatchupWindowSpec {
  if (args.hours !== undefined) {
    if (args.since !== undefined && args.since.trim() !== "last") {
      throw new WazapError("INVALID_ID", "Pass either hours or since, not both.", 'Use hours: 24 for the last day, or since: "2026-09-16T18:00"');
    }
    return { kind: "hours", hours: args.hours };
  }
  const since = args.since?.trim() ?? "last";
  if (since === "last") return { kind: "last" };
  if (since === "previous") return { kind: "previous" };
  return { kind: "since", ms: sinceOf(since, now) };
}

/** Everyone tagged #private or #no-catchup on any of the live accounts, by jid; an account that cannot say adds nobody. The broad reads take its #private half. */
export async function taggedAcross(targets: ReadonlyArray<{ wa: WhatsAppApi }>): Promise<CatchupTagJids> {
  const privateJids = new Set<string>();
  const noCatchup = new Set<string>();
  for (const target of targets) {
    try {
      const tagged = await target.wa.catchUpTags?.();
      for (const jid of tagged?.private ?? []) privateJids.add(jid);
      for (const jid of tagged?.noCatchup ?? []) noCatchup.add(jid);
    } catch {
      // Its scan reports what is wrong with it.
    }
  }
  return { private: [...privateJids], noCatchup: [...noCatchup] };
}

/**
 * A read on one account under the #private rule (src/private-contacts.ts): the
 * account reads its own tags, and every other live account names the people it
 * tagged, by number and lid. With one account nobody else is asked.
 */
export async function privateRule(hub: AccountSource, accountId: string): Promise<PrivateRule> {
  const others = hub.bindings().filter((binding) => binding.id !== accountId);
  return { others: others.length === 0 ? [] : (await taggedAcross(others)).private };
}

function missingSupport(id: string): WazapError {
  return new WazapError("SERVICE_ERROR", `Account "${id}" cannot give a catch-up.`, "Restart the wazap server so every account runs this version");
}

/** Which accounts a call covers: the one it names, or every live account when it names none and there are several. */
function targetsOf(args: CatchupArgs, ctx: CatchupContext): Array<{ id: string; wa: WhatsAppApi }> {
  const live = ctx.hub.bindings();
  if (args.account_id !== undefined || live.length <= 1) return [{ id: ctx.accountId, wa: ctx.wa }];
  return live;
}

/** Moves the mark once the whole digest was given, and says why not otherwise. */
async function settleMark(view: AccountView, client: string, complete: boolean): Promise<Mark> {
  const scan = view.scan!;
  const window = scan.window;
  if (!window.advance) return { moved: false, why: window.basis === "hours" || window.basis === "since" ? "explicit_window" : "previous" };
  if (!complete) return { moved: false, why: "partial_include" };
  if (scan.connection.status !== "connected") return { moved: false, why: "not_connected" };
  if (scan.connection.sync !== "done") return { moved: false, why: "sync_in_progress" };
  if (window.expected !== null && window.untilSeq <= window.expected) return { moved: false, why: "nothing_new" };
  if (typeof view.source.catchUpAdvance !== "function") return { moved: false, why: "unsupported" };
  try {
    const result = await view.source.catchUpAdvance(client, window);
    return result.advanced ? { moved: true, next_since: isoWithOffset(window.at) } : { moved: false, why: "moved_by_another_call" };
  } catch (err) {
    return { moved: false, why: `failed: ${asWazapError(err).code}` };
  }
}

export async function runCatchUp(args: CatchupArgs, ctx: CatchupContext): Promise<ToolResult> {
  const budget = Math.min(MAX_BUDGET_TOKENS, Math.max(MIN_BUDGET_TOKENS, Math.floor(args.budget_tokens ?? DEFAULT_BUDGET_TOKENS)));
  const asked = (ctx.now ?? Date.now)();
  if (args.cursor !== undefined) {
    const { snapshot, start } = pageAt(args.cursor, ctx.client, asked);
    if (args.account_id !== undefined && (snapshot.views.length !== 1 || snapshot.views[0]!.id !== args.account_id)) {
      throw new WazapError(
        "INVALID_ID",
        `That cursor continues a catch-up of ${snapshot.views.map((view) => view.id).join(", ")}.`,
        "Pass more.cursor without account_id"
      );
    }
    return givePage(snapshot, start, budget * 4, ctx, asked);
  }
  const include: CatchupSection[] =
    args.include === undefined ? [...CATCHUP_SECTIONS] : CATCHUP_SECTIONS.filter((section) => args.include!.includes(section));
  const spec = specOf(args, asked);
  const targets = targetsOf(args, ctx);
  const multi = targets.length > 1;
  const now = asked;

  // A person tagged on any live account is tagged on every one read, with account_id or without.
  const everyone = ctx.hub.bindings();
  const tags = everyone.length > 1 ? await taggedAcross(everyone) : undefined;
  // Each account's scan; one that fails is reported, the others still answer.
  const views: AccountView[] = await Promise.all(
    targets.map(async (target): Promise<AccountView> => {
      const name = flat(ctx.hub.record(target.id)?.name ?? target.id);
      const view: AccountView = { id: target.id, name, source: target.wa, scan: null, error: null };
      try {
        if (typeof target.wa.catchUpScan !== "function") throw missingSupport(target.id);
        view.scan = await target.wa.catchUpScan({ client: ctx.client, include, at: now, window: spec, ...(tags === undefined ? {} : { tags }) });
      } catch (err) {
        view.error = asWazapError(err);
      }
      return view;
    })
  );
  const answered = views.filter((view) => view.scan !== null);
  if (answered.length === 0) throw views[0]!.error ?? missingSupport(targets[0]!.id);

  // Every entry in section order; within a section, account by account.
  const byAccount = answered.map((view) => itemsOf(view, multi, now));
  const items: Item[] = CATCHUP_SECTIONS.flatMap((section) => byAccount.flatMap((each) => each.filter((item) => item.section === section)));
  const snapshot: Snapshot = { client: ctx.client, include, now, multi, views, answered, items, cursors: new Set(), marks: null, usedAt: asked };
  return givePage(snapshot, 0, budget * 4, ctx, asked);
}

/** One page of a digest from entry `start`: the whole rest when it fits, otherwise as much as fits and a cursor to the next. */
async function givePage(snapshot: Snapshot, start: number, budgetChars: number, ctx: CatchupContext, asked: number): Promise<ToolResult> {
  const { now, multi, views, answered, items: all } = snapshot;
  const complete = snapshot.include.length === CATCHUP_SECTIONS.length;
  const rest = all.slice(start);

  // Every section read, and all there is are asks from before the window: nothing arrived in it.
  const quiet = complete && all.length > 0 && all.every((item) => item.beforeWindow === true);
  const header = [...headerLines(views, multi, now, start > 0), ...(quiet ? ["Nothing arrived in this window; still waiting from before it:"] : [])];
  const footer = footerLines(answered, multi);
  const linesChars = (lines: readonly string[]): number => lines.reduce((n, line) => n + line.length + 1, 0);
  const headerChars = linesChars(header);
  const footerChars = footer.length === 0 ? 0 : linesChars(footer) + 1;
  const skeletonChars = new Map(all.map((item) => [item, item.line(null).length + 1]));
  const longestName = Math.max(...answered.map((view) => view.name.length));
  const headingChars = (item: Item): number => `## ${SECTION_TITLES[item.section]}${multi ? ` · ${"x".repeat(longestName)}` : ""} (99)`.length + 1;
  const headingKey = (item: Item): string => (multi ? `${item.section}|${item.account}` : item.section);
  const moreChars = 140 + CURSOR_CHARS;

  // 1. The skeleton: all of it with the footer, or as much as fits before a `more` line (at least one entry).
  const skeletonOf = (items: readonly Item[]): number => {
    let chars = items.length > 0 ? 1 : 0;
    let key = "";
    for (const item of items) {
      if (headingKey(item) !== key) {
        key = headingKey(item);
        chars += headingChars(item);
      }
      chars += skeletonChars.get(item)!;
    }
    return chars;
  };
  let page: Item[] = rest;
  let final = headerChars + skeletonOf(rest) + footerChars <= budgetChars;
  if (!final) {
    let chars = 1;
    let key = "";
    let taken = 0;
    for (const item of rest) {
      const heading = headingKey(item) === key ? 0 : headingChars(item);
      if (taken > 0 && headerChars + chars + heading + skeletonChars.get(item)! + moreChars > budgetChars) break;
      chars += heading + skeletonChars.get(item)!;
      key = headingKey(item);
      taken++;
    }
    page = rest.slice(0, taken);
    final = taken === rest.length;
  }
  const spare = budgetChars - headerChars - skeletonOf(page) - (final ? footerChars : moreChars);

  // 2. Quotes by priority, one per chat, read back in full for at most 60 messages.
  const quotedChats = new Set<string>();
  const candidates: Item[] = [];
  let reads = 0;
  for (const section of CATCHUP_SECTIONS) {
    if (QUOTE_CAPS[section] === undefined) continue;
    for (const item of page) {
      if (item.section !== section || (item.quoteId === null && item.thenId === null) || quotedChats.has(item.chatKey)) continue;
      if (reads + (item.quoteId === null ? 0 : 1) + (item.thenId === null ? 0 : 1) > MAX_QUOTES) break;
      reads += (item.quoteId === null ? 0 : 1) + (item.thenId === null ? 0 : 1);
      quotedChats.add(item.chatKey);
      candidates.push(item);
    }
  }
  const texts = await readQuotes(candidates, answered);
  type Placed = { item: Item; full: string; then: string | null; signals: Signal[]; level: number };
  const placed: Placed[] = [];
  for (const item of candidates) {
    const full = item.quoteId === null ? "" : (texts.get(`${item.account}|${item.quoteId}`)?.text ?? "");
    const then = item.thenId === null ? "" : (texts.get(`${item.account}|${item.thenId}`)?.text ?? "");
    if (full === "" && then === "") continue;
    placed.push({
      item,
      full,
      then: then === "" ? null : then,
      signals: item.section === "waiting" ? [] : [...signalsOf(full)],
      level: QUOTE_CAPS[item.section]!,
    });
  }
  const quoteAt = (entry: Placed, level: number): Quoted => (level === 0 ? null : { ...composeQuote(entry.full, entry.then, level), signals: entry.signals });
  const extra = (entry: Placed, level: number): number => entry.item.line(quoteAt(entry, level)).length - skeletonChars.get(entry.item)! + 1;
  let spent = placed.reduce((n, entry) => n + extra(entry, entry.level), 0);
  // 3. Too long: the lowest-priority quotes shrink to 80 characters, then go.
  for (let i = placed.length - 1; i >= 0 && spent > spare; i--) {
    const entry = placed[i]!;
    if (entry.level <= SHORT_QUOTE) continue;
    spent -= extra(entry, entry.level) - extra(entry, SHORT_QUOTE);
    entry.level = SHORT_QUOTE;
  }
  for (let i = placed.length - 1; i >= 0 && spent > spare; i--) {
    const entry = placed[i]!;
    spent -= extra(entry, entry.level);
    entry.level = 0;
  }
  const quotes = new Map(placed.filter((entry) => entry.level > 0).map((entry) => [entry.item, quoteAt(entry, entry.level)]));

  // The marks, once every entry was given: settled by the last page, and the same when it is asked for again.
  const marks = new Map<string, Mark>();
  if (!final) for (const view of answered) marks.set(view.id, { moved: false, why: "more_pages" });
  else if (snapshot.marks !== null) for (const [id, mark] of snapshot.marks) marks.set(id, mark);
  else {
    for (const view of answered) marks.set(view.id, await settleMark(view, ctx.client, complete));
    snapshot.marks = marks;
  }

  // Render.
  const lines = [...header];
  let key = "";
  for (const item of page) {
    if (headingKey(item) !== key) {
      key = headingKey(item);
      lines.push(headingOf(item, page, answered, multi));
    }
    lines.push(item.line(quotes.get(item) ?? null));
  }
  if (all.length === 0) lines.push(nothingLine(answered, now));
  let more: { cursor: string; remaining: Record<string, number>; approx_tokens: number } | null = null;
  const remainingItems = all.slice(start + page.length);
  if (!final) {
    hold(snapshot, asked);
    const remaining: Record<string, number> = {};
    for (const item of remainingItems) remaining[STRUCTURED_KEYS[item.section]] = (remaining[STRUCTURED_KEYS[item.section]] ?? 0) + 1;
    const quotesLeft = remainingItems.filter((item) => item.quoteId !== null || item.thenId !== null).length;
    const approx = Math.ceil((skeletonOf(remainingItems) + footerChars) / 4) + quotesLeft * 30;
    more = { cursor: cursorFor(snapshot, start + page.length), remaining, approx_tokens: approx };
    const counts = Object.entries(remaining)
      .map(([section, n]) => `${section} ${n}`)
      .join(", ");
    lines.push("", `More: ${plural(remainingItems.length, "entry", "entries")} left (${counts}; ~${approx} tokens). Call catch_up with cursor: "${more.cursor}"`);
  } else {
    if (footer.length > 0) lines.push("", ...footer);
    for (const view of answered) {
      const mark = marks.get(view.id)!;
      const label = multi ? `${view.name}: ` : "";
      if (mark.moved) lines.push(`${label}The next catch-up starts after ${clock(Date.parse(mark.next_since!), now)}; since: "previous" gives this one again.`);
      else if (mark.why === "moved_by_another_call") lines.push(`${label}Another catch-up of this client finished first; the next one starts where that one ended.`);
    }
  }
  const text = lines.join("\n");

  const structured: Record<string, unknown> = {
    window: unionWindow(answered),
    accounts: views.map((view) =>
      view.scan === null
        ? { account_id: view.id, name: view.name, status: "error", error: { code: view.error!.code, message: view.error!.message } }
        : {
            account_id: view.id,
            name: view.name,
            status: view.scan.connection.status,
            ...(view.scan.connection.status !== "connected" && view.scan.connection.since !== null ? { status_since: view.scan.connection.since } : {}),
            ...(view.scan.connection.sync === "done" ? {} : { sync: view.scan.connection.sync }),
            ...(multi ? { window: windowOf(view.scan.window) } : {}),
            mark: marks.get(view.id),
          }
    ),
    waiting: [],
    addressed: [],
    missed_calls: [],
    direct: [],
    groups: [],
    stories: [],
    footer: final ? footerData(answered, multi) : null,
    more,
    approx_tokens: Math.ceil(text.length / 4),
    account_id: multi ? null : answered[0]!.id,
  };
  for (const item of page) (structured[STRUCTURED_KEYS[item.section]] as unknown[]).push(item.data(quotes.get(item) ?? null));
  // What the text says the assistant must act on, for a client that hands the model only the structured content.
  const notes = [
    ...answered.flatMap((view) => {
      const connection = view.scan!.connection;
      return [
        connection.status === "connected"
          ? null
          : `${view.id} is ${connection.status}${connection.since === null ? "" : ` since ${clock(Date.parse(connection.since), now)}`}: what arrived after that is not here yet.`,
        connection.sync === "done" ? null : `${view.id}: history sync is still running; some messages may not be here yet.`,
      ];
    }),
    quiet ? "Nothing arrived in this window: every waiting entry was asked before it and is still open." : null,
    more === null ? null : "More entries are left: call catch_up with more.cursor for them.",
  ].filter((note): note is string => note !== null);
  if (notes.length > 0) structured.notes = notes;
  return { content: [{ type: "text", text }], structuredContent: structured };
}

async function readQuotes(candidates: readonly Item[], views: readonly AccountView[]): Promise<Map<string, CatchupQuote>> {
  const out = new Map<string, CatchupQuote>();
  for (const view of views) {
    const ids = candidates
      .filter((item) => item.account === view.id)
      .flatMap((item) => [item.quoteId, item.thenId].filter((id): id is number => id !== null));
    if (ids.length === 0 || typeof view.source.catchUpQuotes !== "function") continue;
    for (const quote of await view.source.catchUpQuotes(ids)) out.set(`${view.id}|${quote.id}`, quote);
  }
  return out;
}

function headingOf(item: Item, page: readonly Item[], views: readonly AccountView[], multi: boolean): string {
  const same = page.filter((other) => other.section === item.section && (!multi || other.account === item.account));
  const count = item.section === "stories" ? "" : ` (${same.filter((other) => !other.chatKey.endsWith("|#muted")).length})`;
  const account = multi ? ` · ${views.find((view) => view.id === item.account)!.name}` : "";
  return `## ${SECTION_TITLES[item.section]}${account}${count}`;
}

function headerLines(views: readonly AccountView[], multi: boolean, now: number, continued: boolean): string[] {
  const title = continued ? "# WhatsApp catch-up, continued" : "# WhatsApp catch-up";
  const stale = (view: AccountView): string => {
    const connection = view.scan?.connection;
    if (connection === undefined || connection.status === "connected") return "";
    const since = connection.since === null ? "" : ` since ${clock(Date.parse(connection.since), now)}`;
    return ` · ${connection.status}${since}: what arrived after that is not here yet`;
  };
  if (!multi) {
    const view = views[0]!;
    return [`${title} · ${windowPhrase(view.scan!.window, now)}${stale(view)}`];
  }
  return [
    `${title} · ${views.length} accounts`,
    ...views.map((view) =>
      view.scan === null
        ? `- ${view.name} (${view.id}): unavailable — ${view.error!.code}: ${flat(view.error!.message)}`
        : `- ${view.name} (${view.id}): ${windowPhrase(view.scan.window, now)}${stale(view)}`
    ),
  ];
}

function nothingLine(views: readonly AccountView[], now: number): string {
  const disconnected = views.some((view) => view.scan!.connection.status !== "connected");
  return disconnected ? "Nothing new is stored for this window." : `Nothing new, checked up to ${clock(now, now)}.`;
}

function skippedParts(scan: CatchupScan): string[] {
  const { noCatchup, leftGroups, newsletters, broadcasts } = scan.skipped;
  const parts: string[] = [];
  if (noCatchup.chats > 0) parts.push(`${plural(noCatchup.chats, "chat")} tagged #no-catchup (${noCatchup.messages} msgs)`);
  if (leftGroups.chats > 0) parts.push(`${plural(leftGroups.chats, "group")} you left (${leftGroups.messages} msgs)`);
  if (newsletters.chats > 0) parts.push(`${plural(newsletters.chats, "channel")} (${newsletters.messages} msgs)`);
  if (broadcasts.chats > 0) parts.push(`${plural(broadcasts.chats, "broadcast list")} (${broadcasts.messages} msgs)`);
  return parts;
}

function footerLines(views: readonly AccountView[], multi: boolean): string[] {
  const lines: string[] = [];
  for (const view of views) {
    const scan = view.scan!;
    const label = multi ? `${view.name}: ` : "";
    if (scan.voiceUntranscribedCount > 0) {
      // Only the notes of people not kept #private are named; theirs are only counted.
      const more = scan.voiceUntranscribedCount - scan.voiceUntranscribed.length;
      lines.push(
        scan.voiceUntranscribed.length === 0
          ? `${label}Voice notes not transcribed (${scan.voiceUntranscribedCount}).`
          : `${label}Voice notes not transcribed (${scan.voiceUntranscribedCount}): ${scan.voiceUntranscribed.join(", ")}${more > 0 ? `, +${more}` : ""} — get_media reads one.`
      );
    }
    const skipped = skippedParts(scan);
    if (skipped.length > 0) lines.push(`${label}Left out: ${skipped.join(" · ")}.`);
    if (scan.connection.sync !== "done") lines.push(`${label}History sync is still running; some messages may not be here yet.`);
    if (scan.connection.mentionsIndexing) lines.push(`${label}Mentions in older messages are still being indexed.`);
  }
  return lines;
}

function footerData(views: readonly AccountView[], multi: boolean): Record<string, unknown> {
  const per = views.map((view) => {
    const scan = view.scan!;
    const { noCatchup, leftGroups, newsletters, broadcasts } = scan.skipped;
    const skipped: Record<string, { chats: number; messages: number }> = {};
    if (noCatchup.chats > 0) skipped.no_catchup = noCatchup;
    if (leftGroups.chats > 0) skipped.left_groups = leftGroups;
    if (newsletters.chats > 0) skipped.newsletters = newsletters;
    if (broadcasts.chats > 0) skipped.broadcasts = broadcasts;
    const more = scan.voiceUntranscribedCount - scan.voiceUntranscribed.length;
    return {
      ...(multi ? { acct: view.id } : {}),
      ...(scan.voiceUntranscribed.length > 0 ? { voice_untranscribed: scan.voiceUntranscribed } : {}),
      ...(more > 0 ? { voice_untranscribed_more: more } : {}),
      ...(Object.keys(skipped).length > 0 ? { skipped } : {}),
      ...(scan.connection.sync !== "done" ? { history_sync: scan.connection.sync } : {}),
      ...(scan.connection.mentionsIndexing ? { mentions_indexing: true } : {}),
    };
  });
  return multi ? { accounts: per } : per[0]!;
}

function unionWindow(views: readonly AccountView[]): { since: string; until: string; hours: number; basis: string } {
  const each = views.map((view) => windowOf(view.scan!.window));
  const since = Math.min(...each.map((window) => Date.parse(window.since)));
  const until = Math.max(...each.map((window) => Date.parse(window.until)));
  const bases = new Set(each.map((window) => window.basis));
  return {
    since: isoWithOffset(since),
    until: isoWithOffset(until),
    hours: Math.round(((until - since) / HOUR) * 10) / 10,
    basis: bases.size === 1 ? [...bases][0]! : "mixed",
  };
}
