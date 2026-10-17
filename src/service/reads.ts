/**
 * What the account's tools read: the chat list, a chat's messages and the
 * pages behind them, the recent conversations, search by words, a message,
 * the stories, the chats waiting on a reply and marking one handled, the
 * catch-up scan, and the context a draft is written against. Part of
 * WhatsAppService (src/whatsapp.ts), which lends its guards and connection
 * state through ReadsHost.
 */

import { WazapError } from "../errors.js";
import type { WAMessage, WASocket } from "baileys";
import { wordsAsk } from "../asks.js";
import {
  GROUP_META_MAX,
  GROUP_META_MS,
  quotesOf,
  scanCatchup,
  taggedJids,
  type CatchupHost,
  type CatchupQuote,
  type CatchupScan,
  type CatchupScanRequest,
  type CatchupTagJids,
  type CatchupWindow,
} from "../catchup-scan.js";
import { secondOfId, type ChatKind, type StoredMessage } from "../db/index.js";
import { draftContextFor, styleCheckFor, type DraftContext, type StyleCheck } from "../draft-style.js";
import { isGroupId, isNoiseJid, STATUS_JID } from "../ids.js";
import { decodeChat } from "../store.js";
import { formatAge, isoWithOffset, mentionedJids, protoNumber, quotedSenderJid, viewText } from "../messages.js";
import { withoutPrivateQuote, withoutWords } from "../private-contacts.js";
import { frozenReceiptText } from "../drafts.js";
import { STORY_TTL_MS } from "./ingest.js";
import { leftGroup, pageLimit } from "./util.js";
import type { SearchCoverage } from "../coverage.js";
import type {
  ChatFilter,
  ChatRead,
  ChatSummary,
  ConnectionStatus,
  MessageType,
  MessageView,
  PrivateRule,
  RecentConversation,
  Synced,
  HandledResult,
  SearchAnswer,
  SearchOptions,
  SyncState,
  UnansweredChat,
  UnconfirmedSend,
} from "../wa-types.js";
import type { AccountRecord } from "../accounts.js";
import type { AccountGroups } from "./groups.js";
import type { AccountIdentity } from "./identity.js";
import type { AccountStorage } from "./storage.js";
import type { MessageViews } from "./views.js";
import type { AccountVoice } from "./voice.js";

/** Unknown sends a read of one chat lists at most. */
const UNCONFIRMED_SENDS_SHOWN = 20;

/** How many active groups one catch-up fetches metadata for, to name their senders. */
const RECENT_GROUP_META_MAX = 12;

/** Messages getRecentMessages returns per chat: the newest of its window, as many as main's per-chat ring held. */
const RECENT_PER_CHAT_MAX = 2_000;

/** How far back into a chat an open ask is looked for. */
const UNANSWERED_SCAN = 30;

/** Messages read_messages walks past a type filter before it answers with what it found. */
const TYPE_FILTER_SCAN = 10_000;

/** Chat kinds a person can be waiting in: every one but the status feed. */
const WAITING_KINDS: readonly ChatKind[] = ["direct", "group", "newsletter", "broadcast"];

/** What the service lends the reads: its guards and connection state, read at each call. */
export interface ReadsHost {
  status(): ConnectionStatus;
  statusSince(): number;
  syncState(): SyncState;
  guarded<T>(work: () => Promise<T>): Promise<T>;
  ensureConnected(): WASocket;
  waitForSync(): Promise<void>;
  synced<T>(data: T): Synced<T>;
  /** The folds a pairing started, let land within a bound. */
  foldsSettled(): Promise<void>;
  /** Asks the phone for messages older than `anchor`, and waits a while for them. */
  fetchOlder(sock: WASocket, anchor: StoredMessage, limit: number): Promise<void>;
}

export class AccountReads {
  constructor(
    private readonly host: ReadsHost,
    private readonly identity: AccountIdentity,
    private readonly views: MessageViews,
    private readonly storage: AccountStorage,
    private readonly groups: AccountGroups,
    private readonly voice: AccountVoice,
    private readonly accountRecord: AccountRecord
  ) {}

  listChats(filter: ChatFilter, limit: number, opts: { private?: PrivateRule; cursor?: string } = {}): Promise<Synced<ChatSummary[]> & { nextCursor?: string | null }> {
    return this.host.guarded(async () => {
      this.host.ensureConnected();
      await this.host.waitForSync();
      // The lookup can teach a pairing, and a pairing folds a lid chat into its
      // number's: it comes first, and the fold is let land before the list is read.
      const lidChats = this.storage.db.identity.listChats().filter((chat) => chat.jid.endsWith("@lid") && this.views.listed(chat));
      await this.identity.learnLidPhones(lidChats.map((chat) => chat.jid));
      await this.host.foldsSettled();
      const db = this.storage.db;
      const entries = db.identity
        .listChats()
        .filter((chat) => this.views.listed(chat) && this.views.matchesChatFilter(chat, filter))
        .map((chat) => ({ chat, proto: chat.proto === null ? null : decodeChat(Buffer.from(chat.proto).toString("base64")) }));
      const activity = (entry: (typeof entries)[number]): number => {
        const described = protoNumber(entry.proto?.conversationTimestamp);
        if (described !== undefined && described !== null) return described;
        return entry.chat.lastTs === null ? 0 : Math.floor(entry.chat.lastTs / 1000);
      };
      const key = (entry: (typeof entries)[number]): number[] => [activity(entry), entry.chat.lastMessageId ?? 0, entry.chat.id];
      const compare = (a: number[], b: number[]): number => b[0]! - a[0]! || b[1]! - a[1]! || b[2]! - a[2]!;
      let after: number[] | null = null;
      if (opts.cursor !== undefined) {
        try {
          if (!/^[A-Za-z0-9_-]{1,512}$/.test(opts.cursor)) throw new Error();
          const parsed: unknown = JSON.parse(Buffer.from(opts.cursor, "base64url").toString("utf8"));
          if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== filter || !parsed.slice(1).every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) throw new Error();
          after = parsed.slice(1) as number[];
        } catch {
          throw new WazapError("INVALID_ID", "Invalid list_chats cursor, or its filter changed.", "Start listing again without a cursor");
        }
      }
      const ordered = entries.sort((a, b) => compare(key(a), key(b))).filter(entry => after === null || compare(key(entry), after) > 0);
      const selected = ordered.slice(0, limit);
      const people = this.identity.privateScope(opts.private);
      const chats = selected.map(entry => this.views.chatSummary(entry.chat, entry.proto, people));
      const nextCursor = ordered.length > limit && selected.length > 0
        ? Buffer.from(JSON.stringify([filter, ...key(selected.at(-1)!)])).toString("base64url") : null;
      return { ...this.host.synced(chats), nextCursor };
    });
  }

  readMessages(chatId: string, limit: number, before?: string, types?: MessageType[]): Promise<ChatRead> {
    return this.host.guarded(async () => {
      const sock = this.host.ensureConnected();
      const jid = this.identity.resolveId(chatId);
      await this.host.waitForSync();
      await this.groups.learnParticipants(jid);
      await this.identity.learnLidPhones([jid]);

      if (before === undefined) {
        const read: ChatRead = this.host.synced(this.views.viewsOfStored(this.pageOf(jid, limit, undefined, types)));
        // The newest page is where a send handed to WhatsApp would show: until its echo comes, say it may be on its way.
        const unconfirmed = types === undefined ? this.unconfirmedSends(jid) : [];
        return unconfirmed.length === 0 ? read : { ...read, unconfirmedSends: unconfirmed };
      }

      const anchor = this.views.storedOrThrow(before);
      const inChat = this.storage.db.identity.chat(jid)?.jid === anchor.chatJid;
      let older = inChat ? this.pageOf(jid, limit, anchor.id, types) : [];
      if (older.length > 0) return this.host.synced(this.views.viewsOfStored(older));
      await this.host.fetchOlder(sock, anchor, limit);
      older = inChat ? this.pageOf(jid, limit, anchor.id, types) : [];
      // The phone may hold more than it sent in time: an empty answer says it was asked, never that the chat starts here.
      return { ...this.host.synced(this.views.viewsOfStored(older)), older: { askedPhone: true, received: older.length } };
    });
  }

  /**
   * confirm_send's sends to this chat that went unknown and have not echoed:
   * a read that does not show them yet has not shown they failed.
   */
  unconfirmedSends(jid: string): UnconfirmedSend[] {
    const db = this.storage.readyDb();
    if (db === null) return [];
    const chats = [...new Set([jid, db.identity.chat(jid)?.jid].filter((id): id is string => typeof id === "string"))];
    return db.sends.unknownIn(chats, UNCONFIRMED_SENDS_SHOWN).map((row) => ({
      draft_id: row.draftId,
      text: frozenReceiptText(row),
      handed_at: isoWithOffset(row.updatedAt),
      state: "unknown" as const,
    }));
  }

  /**
   * The newest `limit` messages of a chat older than `before`, oldest first.
   * A type filter pages on past what it leaves out, so `limit` counts
   * messages the caller asked for, up to a bounded walk.
   */
  private pageOf(jid: string, limit: number, before: number | undefined, types?: MessageType[]): StoredMessage[] {
    const db = this.storage.db;
    const wanted = types === undefined || types.length === 0 ? null : new Set<string>(types);
    const out: StoredMessage[] = [];
    let cursor = before;
    let walked = 0;
    for (;;) {
      const page = db.messages.chatPage(jid, { limit: wanted === null ? limit : Math.max(limit, 200), ...(cursor === undefined ? {} : { before: cursor }) });
      for (const message of page.items) {
        walked++;
        if (wanted !== null && !wanted.has(message.type)) continue;
        out.push(message);
        if (out.length >= limit) break;
      }
      if (out.length >= limit || page.nextBefore === null || walked >= TYPE_FILTER_SCAN) break;
      cursor = page.nextBefore;
    }
    return out.reverse();
  }

  getRecentMessages(
    hours: number,
    filter: Exclude<ChatFilter, "archived">,
    includeSystem = false,
    types?: MessageType[]
  ): Promise<Synced<RecentConversation[]>> {
    return this.host.guarded(async () => {
      this.host.ensureConnected();
      await this.host.waitForSync();
      const cutoff = Date.now() - hours * 3_600_000;
      const active = this.storage.db.identity.listChats().filter((chat) => chat.lastTs !== null && chat.lastTs >= cutoff);
      await this.identity.learnLidPhones(active.map((chat) => chat.jid));
      // A group's metadata is what names a sender the address book does not
      // know; fetch it for the groups that spoke in the window, once each.
      const activeGroups = active
        .map((chat) => chat.jid)
        .filter((jid) => isGroupId(jid) && !this.groups.groupCache.has(jid) && !this.groups.unreadableGroups.has(jid));
      await Promise.all(activeGroups.slice(0, RECENT_GROUP_META_MAX).map((jid) => this.groups.learnParticipants(jid)));

      const db = this.storage.db;
      const wanted = types === undefined || types.length === 0 ? null : new Set<string>(types);
      const chosen: Array<{ jid: string; stored: StoredMessage[] }> = [];
      for (const chat of active) {
        if (chat.kind === "status" || isNoiseJid(chat.jid) || !this.views.matchesChatFilter(chat, filter)) continue;
        // Each chat's newest messages in the window, at most as many as main's per-chat ring held.
        const newestFirst: StoredMessage[] = [];
        for (let before: number | undefined; newestFirst.length < RECENT_PER_CHAT_MAX; ) {
          const limit = Math.min(500, RECENT_PER_CHAT_MAX - newestFirst.length);
          const page = db.messages.chatPage(chat.jid, { limit, since: cutoff, ...(before === undefined ? {} : { before }) });
          newestFirst.push(...page.items);
          if (page.nextBefore === null) break;
          before = page.nextBefore;
        }
        const stored = newestFirst.reverse().filter((message) => wanted === null || wanted.has(message.type));
        if (stored.length > 0) chosen.push({ jid: chat.jid, stored });
      }
      // One read of every chosen message's reactions, votes and receipts, and each name once.
      const lookups = this.views.viewLookups(chosen.flatMap((entry) => entry.stored));
      const conversations: RecentConversation[] = [];
      for (const { jid, stored } of chosen) {
        const messages = stored
          .map((message) => this.views.viewOfStored(message, lookups))
          .filter((view) => includeSystem || view.type !== "system");
        if (messages.length === 0) continue;
        const note = this.identity.noteFor(jid);
        conversations.push({
          chat_id: jid,
          chat_name: this.identity.displayName(jid),
          ...(note ? { note } : {}),
          type: isGroupId(jid) ? "group" : "individual",
          last_activity: messages[messages.length - 1]!.timestamp,
          messages,
        });
      }

      conversations.sort((a, b) => b.last_activity.localeCompare(a.last_activity));
      return this.host.synced(conversations);
    });
  }

  searchMessages(
    query: string,
    chatId: string | undefined,
    limit: number,
    opts: SearchOptions = {}
  ): Promise<SearchAnswer> {
    return this.host.guarded(async () => {
      this.host.ensureConnected();
      await this.host.waitForSync();
      limit = pageLimit(limit);
      const db = this.storage.db;
      const scope = chatId === undefined ? undefined : this.identity.resolveId(chatId);
      const from = this.identity.senderFilter(opts.from);
      const filter = {
        ...(scope === undefined ? {} : { chat: scope }),
        ...(from === undefined ? {} : { from }),
        ...(opts.sinceMs === undefined ? {} : { since: opts.sinceMs }),
        ...(opts.untilMs === undefined ? {} : { until: opts.untilMs }),
      };
      const people = scope === undefined ? this.identity.privateScope(opts.private) : null;
      // from naming one of them asks for what they wrote; a quote of anyone else kept #private still loses its words.
      const author = people !== null && from !== undefined && people.names(from) ? from : undefined;
      const found: StoredMessage[] = [];
      let privateOmitted = 0;
      let capped: number | null = null;
      for (let before: number | undefined; found.length < limit; ) {
        const page = db.search.text({ query, limit, ...filter, ...(before === undefined ? {} : { before }) });
        for (const message of page.items) {
          // The status feed is not a chat: a story never answers a search.
          if (message.chatJid === STATUS_JID) continue;
          // Nor does someone kept #private, unless the call names them: counted, never an entry without its words.
          if (author === undefined && people?.message(message)) {
            privateOmitted++;
            continue;
          }
          found.push(message);
          if (found.length >= limit) break;
        }
        // A page the scan limit stopped is the last one: another would scan as much again, and the answer says where it stopped.
        if (page.scanCapped) {
          if (found.length < limit) capped = page.nextBefore;
          break;
        }
        if (page.nextBefore === null) break;
        before = page.nextBefore;
      }
      const views = this.views.viewsOfStored(found);
      const answer: SearchAnswer = this.host.synced(people === null ? views : views.map((view) => withoutPrivateQuote(view, people, author)));
      if (capped !== null) answer.scanCapped = { searchedBackTo: isoWithOffset(secondOfId(capped) * 1000) };
      if (privateOmitted > 0) answer.privateOmitted = privateOmitted;
      return answer;
    });
  }

  /**
   * What a search by words ran across: every visible message of the account (or
   * of the chat) inside the time filters, the status feed left out. Null when
   * the database cannot say; a coverage miss never takes a search down.
   */
  searchCoverage(chatId: string | undefined, opts: { sinceMs?: number; untilMs?: number } = {}): SearchCoverage | null {
    try {
      const db = this.storage.readyDb();
      if (db === null) return null;
      const scope = chatId === undefined ? undefined : this.identity.resolveId(chatId);
      const cov = db.search.coverage({
        excludeKinds: ["status"],
        ...(scope === undefined ? {} : { chat: scope }),
        ...(opts.sinceMs === undefined ? {} : { since: opts.sinceMs }),
        ...(opts.untilMs === undefined ? {} : { until: opts.untilMs }),
      });
      return {
        searched: cov.messages,
        chats: cov.chats,
        oldest_at: cov.oldestTs === null ? null : isoWithOffset(cov.oldestTs),
        newest_at: cov.newestTs === null ? null : isoWithOffset(cov.newestTs),
        per_chat_cap: null,
      };
    } catch {
      return null;
    }
  }

  getMessage(messageId: string): Promise<MessageView> {
    return this.host.guarded(async () => {
      this.host.ensureConnected();
      return this.views.viewOfStored(this.views.storedOrThrow(messageId));
    });
  }

  draftContext(chatJid: string, options: { recent: boolean; private?: PrivateRule }): DraftContext | null {
    return draftContextFor(this.storage.db, chatJid, { recent: options.recent, others: options.private?.others, senderName: (jid) => this.identity.displayName(jid) });
  }

  /** send_message's style check on a text draft; null when the chat gives too little to judge or the database is not ready. */
  styleCheck(chatJid: string, text: string, options: { private?: PrivateRule } = {}): StyleCheck | null {
    const db = this.storage.readyDb();
    return db === null ? null : styleCheckFor(db, chatJid, text, { others: options.private?.others });
  }

  /** The stories of the last `hours`, newest first, each with its author as the sender. */
  getStories(hours: number, opts: { private?: PrivateRule } = {}): Promise<Synced<MessageView[]>> {
    return this.host.guarded(async () => {
      this.host.ensureConnected();
      await this.host.waitForSync();
      const cutoff = Math.max(Date.now() - hours * 3_600_000, Date.now() - STORY_TTL_MS);
      const stories: StoredMessage[] = [];
      for (let before: number | undefined; ; ) {
        const page = this.storage.db.messages.chatPage(STATUS_JID, { limit: 200, ...(before === undefined ? {} : { before }) });
        const fresh = page.items.filter((message) => message.ts >= cutoff);
        stories.push(...fresh);
        if (fresh.length < page.items.length || page.nextBefore === null) break;
        before = page.nextBefore;
      }
      await this.identity.learnLidPhones(stories.flatMap((story) => (story.senderJid === null ? [] : [story.senderJid])));
      const views = this.views.viewsOfStored(stories);
      const people = this.identity.privateScope(opts.private);
      // Stories are never asked for by name: a #private person's keep who, when and what kind.
      return this.host.synced(people === null ? views : views.map((view, i) => (people.message(stories[i]!) ? withoutWords(view) : view)));
    });
  }

  /**
   * Chats where the last word is theirs and it asks for something: a question
   * mark, a request word, or a voice note nobody has heard yet. A closing
   * "ok, mersi" is not an ask, so the chat is left out. Groups count only when
   * the account was @-mentioned or replied to after its own last message.
   * People first, then the oldest wait first.
   */
  getUnanswered(minAgeHours: number, maxAgeHours: number, limit: number): Promise<Synced<UnansweredChat[]>> {
    return this.host.guarded(async () => {
      this.host.ensureConnected();
      await this.host.waitForSync();
      const now = Date.now();
      const cutoff = now - minAgeHours * 3_600_000;
      const horizon = now - maxAgeHours * 3_600_000;
      const db = this.storage.db;
      const found: UnansweredChat[] = [];
      // The database narrows to chats whose newest word is theirs inside the
      // horizon and that no handled mark still covers; the ask is judged here.
      for (let after: { lastTs: number; id: number } | undefined; ; ) {
        const page = db.messages.waiting({ since: horizon, until: now, limit: 200, kinds: WAITING_KINDS, ...(after === undefined ? {} : { after }) });
        for (const { chat, handled } of page.items) {
          const jid = chat.jid;
          if (isNoiseJid(jid)) continue;
          const open = this.openAsk(jid);
          if (!open) continue;
          const { ask, theirs } = open;
          if (handled?.askSid === ask.sid) continue;
          if (ask.ts > cutoff || ask.ts < horizon) continue;
          const group = isGroupId(jid);
          const note = this.identity.noteFor(jid);
          found.push({
            chat_id: jid,
            name: this.identity.displayName(jid),
            type: group ? "group" : "individual",
            ask: this.views.viewOfStored(ask),
            messages_since_you: theirs.length,
            business: !group && Boolean(db.identity.contact(jid)?.verifiedName),
            ...(note ? { note } : {}),
            waiting_since: isoWithOffset(ask.ts),
            age: formatAge(ask.ts),
          });
        }
        if (page.next === null) break;
        after = page.next;
      }
      found.sort((a, b) => {
        if (a.type !== b.type) return a.type === "individual" ? -1 : 1;
        return a.waiting_since.localeCompare(b.waiting_since);
      });
      return this.host.synced(found.slice(0, limit));
    });
  }

  /**
   * The ask still open in a chat: their messages after the user's last one,
   * and among them the newest that asks for something. In a group only a
   * message addressed to the user counts.
   */
  private openAsk(jid: string): { ask: StoredMessage; theirs: StoredMessage[] } | null {
    const tail = this.storage.db.messages.chatPage(jid, { limit: UNANSWERED_SCAN }).items;
    const theirs: StoredMessage[] = [];
    for (const message of tail) {
      if (message.fromMe) break;
      if (message.type === "system") continue;
      theirs.unshift(message);
    }
    if (theirs.length === 0) return null;
    const group = isGroupId(jid);
    const ask = [...theirs].reverse().find((message) => {
      const raw = this.views.rawOf(message);
      if (group && (raw === null || !this.addressesMe(raw))) return false;
      return this.readsAsAsk(message, raw);
    });
    return ask ? { ask, theirs } : null;
  }

  // ---- catch_up (F2-2): this account's side; the digest is src/catchup.ts ----

  /**
   * The account's catch-up entries over a window. It reads what the database
   * holds whether or not the socket is up, and says which: a digest of a
   * disconnected account is reported as such, not as "nothing new". An account
   * never linked has nothing to read.
   */
  catchUpScan(request: CatchupScanRequest): Promise<CatchupScan> {
    return this.host.guarded(async () => {
      if (this.host.status() === "not_linked" || this.host.status() === "linking") this.host.ensureConnected();
      return scanCatchup(this.storage.db, this.catchupHost(), request, { id: this.accountRecord.id, name: this.accountRecord.name });
    });
  }

  catchUpTags(): Promise<CatchupTagJids> {
    return this.host.guarded(async () => taggedJids(this.storage.db));
  }

  catchUpQuotes(ids: number[]): Promise<CatchupQuote[]> {
    return this.host.guarded(async () => quotesOf(this.storage.db, ids));
  }

  catchUpAdvance(client: string, window: CatchupWindow): Promise<{ advanced: boolean }> {
    return this.host.guarded(async () => ({
      advanced: this.storage.db.catchup.advance(client, window.untilSeq, {
        at: window.at,
        expectedThroughSeq: window.expected,
        // What the window read from: the mark, or a time when it read by time (a first run, a mark too old).
        from: { seq: window.afterSeq < 0 ? null : window.afterSeq, at: window.sinceAt },
      }).advanced,
    }));
  }

  private catchupHost(): CatchupHost {
    return {
      now: () => Date.now(),
      ownJid: () => this.identity.ownJid(),
      nameOf: (jid) => this.identity.displayName(jid),
      noteOf: (jid) => this.identity.noteFor(jid),
      isNoise: (jid) => isNoiseJid(jid),
      leftGroup: (chat) => {
        try {
          return chat.proto !== null && leftGroup(chat.proto);
        } catch {
          return false;
        }
      },
      // Names only: the lid table is a lookup, and group metadata is fetched for
      // at most a dozen groups, within a second, and only while connected — a
      // fetch that cannot run would mark the group unreadable for good.
      prepareNames: async (groups, people) => {
        await this.identity.learnLidPhones(people);
        if (this.host.status() !== "connected") return;
        const unknown = groups.filter((jid) => !this.groups.groupCache.has(jid) && !this.groups.unreadableGroups.has(jid)).slice(0, GROUP_META_MAX);
        if (unknown.length === 0) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.all(unknown.map((jid) => this.groups.learnParticipants(jid))),
          new Promise<void>((done) => {
            timer = setTimeout(done, GROUP_META_MS);
          }),
        ]);
        clearTimeout(timer);
      },
      connection: () => ({
        status: this.host.status(),
        since: isoWithOffset(this.host.statusSince()),
        sync: this.host.syncState(),
        mentionsIndexing: this.storage.readyDb()?.messages.flagsBackfillPending() ?? false,
      }),
    };
  }

  // ---- end catch_up -------------------------------------------------------------

  /**
   * "I dealt with that outside WhatsApp." The open ask is remembered as
   * handled, so it leaves the waiting list; the next message from them
   * makes a new ask and the chat comes back.
   */
  markHandled(chatId: string): Promise<HandledResult> {
    return this.host.guarded(async () => {
      const jid = this.identity.resolveId(chatId);
      const db = this.storage.db;
      const open = db.identity.chat(jid) === null ? null : this.openAsk(jid);
      const last = db.messages.chatPage(jid, { limit: 1 }).items[0] ?? null;
      const ask = open?.ask ?? (last && !last.fromMe ? last : null);
      if (ask) db.identity.markHandled(jid, ask.sid);
      return {
        chat_id: jid,
        name: this.identity.displayName(jid),
        ask_id: ask?.sid ?? null,
        ask_text: ask ? this.views.viewTextOf(ask) : null,
      };
    });
  }

  private readsAsAsk(message: StoredMessage, raw: WAMessage | null): boolean {
    if (message.type === "call") return false;
    // A voice note nobody has heard is an ask until proven otherwise.
    if (message.type === "voice" && message.transcript === null) return true;
    return wordsAsk(raw === null ? this.views.viewTextOf(message) : viewText(raw, this.voice.transcriptOf(message)));
  }

  /** A group message that @-mentions the linked account or replies to one of its messages. */
  addressesMe(raw: WAMessage): boolean {
    if (mentionedJids(raw).some((jid) => this.identity.isMe(jid))) return true;
    const quoted = quotedSenderJid(raw);
    return quoted !== undefined && this.identity.isMe(quoted);
  }
}
