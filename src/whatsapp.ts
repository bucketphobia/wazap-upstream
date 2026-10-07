/**
 * WhatsApp service over Baileys. Baileys emits raw events rather than exposing
 * a queryable store, so this files what they carry in the account database
 * (`accounts/<id>/wazap.sqlite`, see src/db) and answers the tools from it.
 * What stays in memory is bounded by people and chats, never by messages: the
 * lid pairings, group metadata, the last arrivals a wait can replay, drafts.
 *
 * This class owns the socket and the connection's state (status, account,
 * generation, sync), the lifecycle (start, pairing, reconnect, stop) and the
 * event wiring, and is the WhatsAppApi every caller uses. What it does lives
 * in parts under src/service/, one per concern, each reaching the service
 * through a small host it is lent. The state and the seams tests replace
 * (sockClient, status, account, mediaBuffer, transcriber, drafts, writes, readMarks,
 * webhook, healContacts, saveCreds) stay here.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { downloadMediaMessage, type WAMessage, type WASocket } from "baileys";
import type { ILogger } from "baileys/lib/Utils/logger.js";
import { accountPolicy, type AccountRecord } from "./accounts.js";
import { clearAuth, readLinkedAccount, useAtomicAuthState, type LinkedAccount } from "./auth-state.js";
import {
  type CatchupQuote,
  type CatchupScan,
  type CatchupScanRequest,
  type CatchupTagJids,
  type CatchupWindow,
} from "./catchup-scan.js";
import { BAILEYS_VERSION, WAZAP_VERSION, writesHints, type AccountPaths, type Config } from "./config.js";
import { AccountDb, chatKindOf, StorageError, type StoredMessage } from "./db/index.js";
import { type DraftContext, type StyleCheck } from "./draft-style.js";
import { asWazapError, RELINK_FIX, RESET_FIX, WazapError } from "./errors.js";
import { type AccountFind, type FindContactQuery } from "./find-contact.js";
import { isNoiseJid, normalizePhone } from "./ids.js";
import { log, logError } from "./logger.js";
import { describe } from "./outgoing-media.js";
import { momentsOf } from "./store.js";
import { isoWithOffset, mediaInfo, messageIdFor, protoNumber } from "./messages.js";
import { PAIRING_TIMEOUT_MS, WA_BROWSER, prettyCode, socketFactory, startPairing } from "./pairing.js";
import { transcribeFile, transcribeReady } from "./transcribe/index.js";
import { DraftStore, type DraftPayload, type DraftView } from "./drafts.js";
import { READ_MARK_MULTIPLIER, RateLimiter } from "./ratelimit.js";
import { maskNumber } from "./ui.js";
import { AccountChats } from "./service/chats.js";
import { AccountContacts, CONTACT_SETTLE_MS, needsContactResync } from "./service/contacts.js";
import { AccountGroups } from "./service/groups.js";
import { AccountHealth, classifyClose, TEMP_BAN_RETRY_MAX_MS, type NewChatCapReport, type ReachoutLock } from "./service/health.js";
import { AccountIdentity } from "./service/identity.js";
import { AccountIngest, type MessageRef } from "./service/ingest.js";
import { AccountMedia } from "./service/media.js";
import { AccountRecall } from "./service/recall.js";
import { AccountReads } from "./service/reads.js";
import { AccountSends, type SendAttempt } from "./service/send.js";
import { AccountStorage } from "./service/storage.js";
import { MessageViews } from "./service/views.js";
import { AccountVoice } from "./service/voice.js";
import { MessageWaits } from "./service/waits.js";
import { AccountWebhooks } from "./service/webhooks.js";
import { WebhookSink } from "./webhook.js";
import { WebhookOutbox } from "./webhook-outbox.js";
import type { SearchCoverage } from "./coverage.js";
import type {
  ChatAction,
  ChatActionOptions,
  ChatActionResult,
  ChatFilter,
  ChatRead,
  ChatSummary,
  ConnectionStatus,
  ContactDetails,
  ContactDetailsEdit,
  ContactList,
  ContactSyncResult,
  ContactSummary,
  GroupAction,
  GroupActionResult,
  GroupInfo,
  JoinGroupResult,
  ListContactsQuery,
  MediaResult,
  MediaSource,
  MessageType,
  MessageView,
  PairingInfo,
  PrivateRule,
  ParticipantResult,
  RecallAnswer,
  RecentConversation,
  SentMessage,
  StatusInfo,
  SyncState,
  Synced,
  TranscribeOptions,
  TranscribeResult,
  WhatsAppApi,
  HandledResult,
  Preview,
  SearchAnswer,
  SearchOptions,
  UnansweredChat,
  WaitOptions,
  WaitResult,
} from "./wa-types.js";

/** Reconnect pacing. A closed socket used to be retried instantly, which turns
 * any persistent rejection into a login storm — WhatsApp answers that by
 * throttling the account and refusing to link *any* new device to it, phone
 * included. Retries are spaced, jittered and capped; past the cap we stop and
 * wait for a human instead of hammering. */
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 5 * 60_000;
const RECONNECT_MAX_ATTEMPTS = 10;

const SYNC_WAIT_MS = 10_000;
const HISTORY_FETCH_WAIT_MS = 5_000;
const STALE_INBOUND_MS = 24 * 3_600_000;
/** A download is buffered in memory, so the biggest file it may pull is bounded. */
const MEDIA_DOWNLOAD_MAX_BYTES = 100_000_000;
/** How long a stop waits for a transcription under way to store what it got. */
const STOP_TRANSCRIBE_WAIT_MS = 30_000;
/** How long list_chats waits for a lid chat still folding into its number before it lists what it has. */
const FOLD_SETTLE_MS = 2_000;
/** Baileys logs at info level to stdout by default, which corrupts the MCP
 * JSON-RPC stream on stdio. */
const silentLogger: ILogger = {
  level: "silent",
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** How long stop waits for a cancelled pairing socket to close. */
const PAIRING_STOP_MS = 5_000;

/** Baileys' privacy-token window: tokens in the last four 7-day buckets are live (tc-token-utils). */
const TC_TOKEN_BUCKET_S = 604_800;
const TC_TOKEN_BUCKETS = 4;

/**
 * Whether the account holds a live privacy token (tctoken) for `jid`: what WhatsApp checks on a
 * 1:1 send, and what a reachout timelock refuses a first message without. Baileys keeps it in the
 * auth state under the contact's lid. A socket without the store answers false.
 */
async function hasPrivacyToken(sock: WASocket, jid: string): Promise<boolean> {
  try {
    const lid = jid.endsWith("@lid") ? jid : ((await sock.signalRepository?.lidMapping?.getLIDForPN?.(jid)) ?? jid);
    const keys = [...new Set([lid, jid])];
    const stored = (await sock.authState?.keys?.get("tctoken" as never, keys)) as Record<string, { token?: Uint8Array; timestamp?: number | string } | undefined> | undefined;
    const cutoff = (Math.floor(Date.now() / 1000 / TC_TOKEN_BUCKET_S) - (TC_TOKEN_BUCKETS - 1)) * TC_TOKEN_BUCKET_S;
    return keys.some((key) => {
      const entry = stored?.[key];
      const at = Number(entry?.timestamp);
      return (entry?.token?.length ?? 0) > 0 && Number.isFinite(at) && at >= cutoff;
    });
  } catch {
    return false;
  }
}

export class WhatsAppService implements WhatsAppApi {
  private sockClient: WASocket | null = null;
  private saveCreds: (() => Promise<void>) | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private starting = false;
  private stopped = false;
  /** Bumped per socket, so events from a superseded socket are ignored. */
  private generation = 0;
  private status: ConnectionStatus = "connecting";
  private statusSince = Date.now();
  private lastError: string | null = null;
  /**
   * Called once when the reconnect budget runs out on something a restart could
   * fix. The CLI turns it into an exit code, so a supervisor gets its turn.
   */
  onGiveUp: (() => void) | null = null;
  /** Fires when a `link` lands, so the hub can persist the owner on the record. */
  onLinked: ((account: LinkedAccount) => void) | null = null;
  private account: StatusInfo["account"] = null;
  /** The pairing in flight, from the first `link` call until it settles either way. */
  private linking: Promise<PairingInfo> | null = null;
  private pairing: PairingInfo | null = null;
  /**
   * The pairing socket behind a code already handed out. Stopping cancels it and
   * waits for it to close, so no link lands credentials behind a logout or a removal.
   */
  private pairingRun: { cancel: () => void; settled: Promise<void> } | null = null;
  private lastInboundAt: number | null = null;
  private initialSyncDone = false;
  private historyReceived = false;
  private syncDeadline: ReturnType<typeof setTimeout> | null = null;
  private syncWaiters: Array<() => void> = [];
  private historyWaiters: Array<() => void> = [];
  private contactResyncTried = false;
  /** Who a jid is: the lid pairings, the account's own ids, the names (src/service/identity.ts). */
  private readonly identity: AccountIdentity;
  /** The account database: open, boot, legacy files, expiry and file cleanup (src/service/storage.ts). */
  private readonly storage: AccountStorage;
  /** What a reader sees of the database (src/service/views.ts). */
  private readonly views: MessageViews;
  /** The account's groups and their metadata cache (src/service/groups.ts). */
  private readonly groups: AccountGroups;
  /** Voice notes as text: get_media's transcription and the queue (src/service/voice.ts). */
  private readonly voice: AccountVoice;
  /** Search by words and meaning, and the index behind it (src/service/recall.ts). */
  private readonly recallIndex: AccountRecall;
  /** wait_for_messages: the last arrivals and the waits parked on them (src/service/waits.ts). */
  private readonly waits: MessageWaits;
  /** Drafts, their one confirm, and every send (src/service/send.ts). */
  private readonly sends: AccountSends;
  /** What WhatsApp hands the account, filed in its database (src/service/ingest.ts). */
  private readonly ingest: AccountIngest;
  /** The address book, search, notes and details, the full resync (src/service/contacts.ts). */
  private readonly contacts: AccountContacts;
  /** The chat list, messages, search, stories, the waiting list, catch-up (src/service/reads.ts). */
  private readonly reads: AccountReads;
  /** get_media's download and the previews reads show (src/service/media.ts). */
  private readonly media: AccountMedia;
  /** manage_chat and delete_message, and the forgetting each asks for (src/service/chats.ts). */
  private readonly chats: AccountChats;
  /** What the account posts to the webhook, and its status (src/service/webhooks.ts). */
  private readonly webhooks: AccountWebhooks;
  /** Lid chats still folding into their number's chat; list_chats lets them land. */
  private readonly folds = new Set<Promise<unknown>>();
  private stopPromise: Promise<void> | null = null;
  private readonly paths: AccountPaths;
  /** The seams the tests replace; production always runs the real providers. */
  private transcriber = transcribeFile;
  private transcribeReadiness = transcribeReady;
  private readonly drafts = new DraftStore();
  private readonly writes: RateLimiter;
  /** `mark_read`'s own bucket, READ_MARK_MULTIPLIER times the writes', off when the writes' is. */
  private readonly readMarks: RateLimiter;
  /** What WhatsApp says about the account itself: restrictions, bans, a session taken over (src/service/health.ts). */
  // A restriction that comes or goes while the link stays up is told to the webhook as a connection event.
  // Only while linked: a change seen while the link is down is carried by the status change that brings it back.
  private readonly health = new AccountHealth(Date.now, () => {
    if (this.status === "connected") this.webhooks.queueConnectionWebhook(this.status);
  });
  /** The reachout timelock question in flight, so a burst of refused sends asks once. */
  private reachoutCheck: Promise<void> | null = null;
  private readonly webhook: WebhookSink;
  /** Posts the events the account database holds; see src/webhook-outbox.ts. */
  private readonly outbox: WebhookOutbox;
  private readonly accountRecord: AccountRecord;
  private readonly effectiveReadOnly: boolean;
  private readonly effectiveRateLimit: number;

  constructor(
    private readonly config: Config,
    account: AccountRecord,
    paths: AccountPaths
  ) {
    this.identity = new AccountIdentity({
      db: () => this.storage.db,
      readyDb: () => this.storage.readyDb(),
      sock: () => this.sockClient,
      account: () => this.account,
      stopped: () => this.stopped,
      cachedGroup: (jid) => this.groups.groupCache.get(jid),
      folds: this.folds,
      scheduleFileCleanup: () => this.storage.scheduleFileCleanup(),
      namesChanged: () => {
        this.contacts.namedContactsCache = null;
      },
    });
    this.storage = new AccountStorage(
      {
        stopped: () => this.stopped,
        adoptDatabase: (db) => this.adoptDatabase(db),
        recoverSends: (db) => this.sends.recoverSends(db),
        recoverTranscriptions: (db) => this.voice.recoverTranscriptions(db),
        startOutbox: () => this.outbox.start(),
        scheduleFlagsBackfill: (db) => this.ingest.scheduleFlagsBackfill(db),
        embedFeed: () => this.recallIndex.embedFeed,
      },
      this.identity,
      config,
      account,
      paths
    );
    this.views = new MessageViews(
      {
        db: () => this.storage.db,
        readyDb: () => this.storage.readyDb(),
        settleExpired: (db, id) => this.storage.settleExpired(db, id),
        transcriptOf: (message) => this.voice.transcriptOf(message),
      },
      this.identity
    );
    this.groups = new AccountGroups(
      {
        guarded: (work) => this.guarded(work),
        ensureConnected: () => this.ensureConnected(),
        beginWrite: () => this.beginWrite(),
        learnGroup: (meta) => this.ingest.learnGroup(meta),
      },
      this.identity,
      this.views
    );
    this.accountRecord = account;
    this.webhook = new WebhookSink(process.env, { account });
    this.outbox = new WebhookOutbox({
      db: () => this.storage.readyDb(),
      sink: () => this.webhook,
      payload: (event, message) => this.webhooks.webhookPayload(event, message),
      awaitingTranscript: (message) => this.voice.webhookAwaitsTranscript(message),
      allows: (_event, message) => this.webhooks.allowsMessage(message),
    });
    const policy = accountPolicy(account, config);
    this.effectiveReadOnly = policy.readOnly;
    this.effectiveRateLimit = policy.rateLimit;
    this.writes = new RateLimiter(this.effectiveRateLimit);
    this.readMarks = new RateLimiter(this.effectiveRateLimit * READ_MARK_MULTIPLIER, Date.now, "Read mark");
    this.paths = paths;
    this.sends = new AccountSends(
      {
        db: () => this.storage.db,
        readyDb: () => this.storage.readyDb(),
        stopped: () => this.stopped,
        drafts: () => this.drafts,
        guarded: (work) => this.guarded(work),
        ensureConnected: () => this.ensureConnected(),
        beginWrite: () => this.beginWrite(),
        getMessage: (messageId) => this.getMessage(messageId),
        hasChat: (jid) => this.hasChat(jid),
        handling: (what, work, fallback) => this.handling(what, work, fallback),
        storeRaw: (raw, chatJid, live) => this.ingest.storeRaw(raw, chatJid, live),
        kept: (result) => this.ingest.kept(result),
        embedFeed: () => this.recallIndex.embedFeed,
        refuseNewChat: async (jid, sock) => {
          if (!this.health.blocksNewChats()) return;
          if (this.heardFrom(jid) || (await hasPrivacyToken(sock, jid))) return;
          throw this.health.refusal("new_chat");
        },
      },
      this.identity,
      this.views,
      this.groups
    );
    this.voice = new AccountVoice(
      {
        db: () => this.storage.db,
        readyDb: () => this.storage.readyDb(),
        stopped: () => this.stopped,
        status: () => this.status,
        guarded: (work) => this.guarded(work),
        ensureConnected: () => this.ensureConnected(),
        mediaBuffer: (sock, messageId, raw) => this.mediaBuffer(sock, messageId, raw),
        transcriber: (...args) => this.transcriber(...args),
        transcribeReadiness: (...args) => this.transcribeReadiness(...args),
        transcribeAudio: (messageId) => this.transcribeAudio(messageId),
        embedFeed: () => this.recallIndex.embedFeed,
        webhookTranscriptSettled: (sid) => this.webhooks.webhookTranscriptSettled(sid),
      },
      this.views,
      config,
      account,
      this.effectiveReadOnly
    );
    this.recallIndex = new AccountRecall(
      {
        db: () => this.storage.db,
        readyDb: () => this.storage.readyDb(),
        stopped: () => this.stopped,
        storageState: () => this.storage.storageState,
        guarded: (work) => this.guarded(work),
        ensureConnected: () => {
          this.ensureConnected();
        },
        waitForSync: () => this.waitForSync(),
        synced: (data) => this.synced(data),
        transcriptRecordOf: (message) => this.voice.transcriptRecordOf(message),
      },
      this.identity,
      this.views,
      config
    );
    this.waits = new MessageWaits(
      {
        readyDb: () => this.storage.readyDb(),
        stopped: () => this.stopped,
        guarded: (work) => this.guarded(work),
        ensureConnected: () => {
          this.ensureConnected();
        },
        addressesMe: (raw) => this.reads.addressesMe(raw),
      },
      this.identity,
      this.views
    );
    this.ingest = new AccountIngest(
      {
        stopped: () => this.stopped,
        sock: () => this.sockClient,
        drafts: () => this.drafts,
        handling: (what, work, fallback) => this.handling(what, work, fallback),
        namesChanged: () => {
          this.contacts.namedContactsCache = null;
        },
        noteInbound: (fromMe, ts) => this.noteInbound(fromMe, ts),
        noteHistoryReceived: () => {
          this.historyReceived = true;
          this.releaseHistoryWaiters();
        },
        markSyncDone: () => this.markSyncDone(),
        announced: (stored, type) => this.webhooks.announced(stored, type),
        nudgeOutbox: () => this.outbox.nudge(),
        embedFeed: () => this.recallIndex.embedFeed,
      },
      this.identity,
      this.views,
      this.storage,
      this.sends,
      this.voice,
      this.waits,
      config
    );
    this.contacts = new AccountContacts(
      {
        stopped: () => this.stopped,
        status: () => this.status,
        guarded: (work) => this.guarded(work),
        ensureConnected: () => this.ensureConnected(),
        waitForSync: () => this.waitForSync(),
        notesChanged: () => this.outbox.kick(),
        synced: (data) => this.synced(data),
      },
      this.identity,
      this.views,
      this.storage,
      account
    );
    this.reads = new AccountReads(
      {
        status: () => this.status,
        statusSince: () => this.statusSince,
        syncState: () => this.syncState(),
        guarded: (work) => this.guarded(work),
        ensureConnected: () => this.ensureConnected(),
        waitForSync: () => this.waitForSync(),
        synced: (data) => this.synced(data),
        foldsSettled: () => this.foldsSettled(),
        fetchOlder: (sock, anchor, limit) => this.fetchOlder(sock, anchor, limit),
      },
      this.identity,
      this.views,
      this.storage,
      this.groups,
      this.voice,
      account
    );
    this.media = new AccountMedia(
      {
        status: () => this.status,
        sock: () => this.sockClient,
        guarded: (work) => this.guarded(work),
        ensureConnected: () => this.ensureConnected(),
        hasMessage: (id) => this.hasMessage(id),
        mediaBuffer: (sock, messageId, raw) => this.mediaBuffer(sock, messageId, raw),
      },
      this.views,
      this.storage,
      paths
    );
    this.chats = new AccountChats(
      {
        guarded: (work) => this.guarded(work),
        beginWrite: () => this.beginWrite(),
        beginReadMark: () => this.beginWrite(this.readMarks),
        storageIdle: () => this.storageIdle(),
      },
      this.identity,
      this.views,
      this.storage,
      this.groups,
      this.sends,
      this.ingest,
      this.contacts
    );
    this.webhooks = new AccountWebhooks(
      {
        stopped: () => this.stopped,
        statusSince: () => this.statusSince,
        webhook: () => this.webhook,
        outbox: () => this.outbox,
        health: () => this.health.summary(),
      },
      this.identity,
      this.views,
      this.storage,
      this.sends,
      this.voice,
      account
    );
    this.storage.openDatabase();
    // Only the server transcribes: a short-lived command (status --live, contacts resync, the sync after a
    // link) queues what arrives and leaves the backlog to it.
    if (this.voice.autoTranscribe && config.command === "serve") this.voice.transcribeWorker.register(this.voice.transcribeSource);
  }

  async start(): Promise<void> {
    if (this.stopped || this.starting) return;
    this.starting = true;
    try {
      let linked = this.readAccount();
      if (linked !== "corrupt" && linked !== null) {
        this.account = linked;
        this.storage.claimDatabase(linked.id);
      }
      await this.storage.bootStorage();
      // A stop during the boot (a logout, a removal) must not be followed by a socket.
      if (this.stopped) return;
      if (linked === "corrupt" || linked === null) {
        // A link that finished while the database was being prepared found this
        // start() still running, so its own start() returned at once: pick it up.
        const since = this.linkedSinceBoot();
        if (since === null) return;
        linked = since;
        this.account = linked;
        this.storage.claimDatabase(linked.id);
        // A claim that swapped the database prepares the one it put in place.
        await this.storage.bootStorage();
        if (this.stopped) return;
      }

      let state;
      try {
        ({ state, saveCreds: this.saveCreds } = await useAtomicAuthState(this.paths.authDir));
      } catch (err) {
        this.markCorrupt(err);
        return;
      }
      if (this.stopped) return;

      this.teardownSocket();
      this.initialSyncDone = false;
      this.setStatus("connecting");
      const generation = ++this.generation;
      const sock = socketFactory.open({
        auth: state,
        logger: silentLogger,
        browser: WA_BROWSER,
        syncFullHistory: this.config.syncFullHistory,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        // Retries and poll decryption ask for a message the account already has.
        getMessage: async (key) => this.views.storedProto(key),
      });
      this.sockClient = sock;
      this.wireEvents(sock, generation);
    } finally {
      this.starting = false;
    }
  }

  stop(): Promise<void> {
    return this.stopPromise ??= this.stopOnce();
  }

  private async stopOnce(): Promise<void> {
    this.stopped = true;
    this.health.dispose();
    if (this.storage.expiryTimer) clearTimeout(this.storage.expiryTimer);
    if (this.storage.legacyTimer) clearInterval(this.storage.legacyTimer);
    this.storage.legacyTimer = null;
    this.storage.expiryTimer = null;
    this.storage.expiryAt = undefined;
    for (const timer of [this.reconnectTimer, this.syncDeadline]) {
      if (timer) clearTimeout(timer);
    }
    this.reconnectTimer = null;
    this.syncDeadline = null;
    this.ingest.stopCallSweep();
    this.releaseWaiters();
    this.waits.wakeArrivalWaiters();
    this.teardownSocket();
    await this.outbox.stop();
    await this.stopPairing();
    await this.ingest.historyIdle();
    // Before the database closes: a run under way gets a while to store the transcript it is paying for,
    // then gives its claim back, so the note waits for the next start rather than being uploaded twice.
    await this.voice.transcribeWorker.finish(this.voice.transcribeSource, STOP_TRANSCRIBE_WAIT_MS);
    this.voice.transcribeWorker.unregister(this.voice.transcribeSource);
    await this.recallIndex.stopRecall();
    const db = this.storage.accountDb;
    if (db !== null && db.isOpen) {
      await Promise.allSettled([this.storage.expirySweep, ...this.folds]);
      await db.idle().catch(() => {});
      await this.storage.fileWork.catch(() => {});
      // An account that keeps no history forgets it when it stops, as it did when nothing reached the disk.
      if (!this.config.persistHistory && this.storage.storageState === "ready") {
        await db.messages.purgeLive().catch((err: unknown) => logError("history purge", err));
        try {
          db.sends.forgetWords();
        } catch (err) {
          logError("send record", err);
        }
        await this.storage.unlinkReleased().catch(() => {});
      }
      db.close();
    }
  }

  // Storage ------------------------------------------------------------------

  /** The account database's path. */
  get databasePath(): string {
    return this.storage.databasePath;
  }

  /**
   * The account database for tests and for the doctor: every read and seed
   * goes through the same API the tools use. Refuses while the account is
   * still importing its earlier files, and when the database failed.
   */
  get db(): AccountDb {
    return this.storage.db;
  }

  /**
   * What start() runs before the socket, once per service. Tests call it to
   * boot a service without a socket.
   */
  bootStorage(): Promise<void> {
    return this.storage.bootStorage();
  }

  /** What the service mirrors from a database it starts reading: the pairings and the last sign of life. */
  private adoptDatabase(db: AccountDb): void {
    for (const [lid, phone] of db.identity.lidPairs()) this.identity.lids.learn(lid, phone);
    this.lastInboundAt = db.messages.lastInboundTs();
    this.contacts.namedContactsCache = null;
    this.recallIndex.vectorCount = null;
  }

  private async stopPairing(): Promise<void> {
    const run = this.pairingRun;
    if (run === null) return;
    run.cancel();
    let timer: NodeJS.Timeout | undefined;
    const bounded = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, PAIRING_STOP_MS);
    });
    await Promise.race([run.settled, bounded]).finally(() => clearTimeout(timer));
  }

  /**
   * Pair this install from inside the agent, so linking needs no terminal. One
   * pairing runs at a time: a second call while one is in flight hands back the
   * same code rather than opening a second socket on the same session.
   */
  link(phone: string): Promise<PairingInfo> {
    return this.guarded(async () => {
      if (this.linking) return this.linking;
      const number = normalizePhone(phone);
      this.requireUnlinked();
      // Pairing clears the credentials: not while they would come back on their own.
      if (this.health.blocksLink()) throw this.health.refusal("link");
      this.health.forgetSession();
      // A new link supersedes a try the ban scheduled.
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      // The service claimed the database for these credentials at start; only they go.
      if (this.status !== "not_linked") clearAuth(this.paths.authDir);
      this.linking = this.pair(number);
      return this.linking;
    });
  }

  private requireUnlinked(): void {
    switch (this.status) {
      case "not_linked":
      case "logged_out":
      case "session_corrupt":
      case "auth_failure":
        return;
      default:
        throw new WazapError("ALREADY_LINKED", `The account is ${this.status}.`, "Call get_status");
    }
  }

  private async pair(phone: string): Promise<PairingInfo> {
    let pairing;
    try {
      pairing = await startPairing(this.paths.authDir, phone, PAIRING_TIMEOUT_MS);
    } catch (err) {
      this.abandonLink(err);
      throw err;
    }
    if (this.stopped) {
      pairing.cancel();
      throw new WazapError("NOT_CONNECTED", "The account is shutting down.", "Call get_status");
    }
    this.pairing = {
      code: prettyCode(pairing.code),
      phone_masked: maskNumber(phone),
      expires_at: isoWithOffset(pairing.expiresAt),
    };
    this.setStatus("linking");
    void pairing.done.then(
      (account) => this.adoptLink(account),
      (err: unknown) => this.abandonLink(err)
    );
    // Registered after the handlers above, so a stop waiting on it resumes only
    // once adoptLink or abandonLink has seen the outcome.
    this.pairingRun = { cancel: pairing.cancel, settled: pairing.done.then(() => {}, () => {}) };
    return this.pairing;
  }

  /**
   * The pairing socket is already ended by the time `done` resolves, so this one
   * is safe to open. It has to be this process's socket, because WhatsApp sends
   * the history once and only the store here can catch it.
   */
  private async adoptLink(account: LinkedAccount): Promise<void> {
    this.linking = null;
    this.pairing = null;
    this.pairingRun = null;
    // A stopped service is being logged out or removed: the credentials are the
    // caller's to clear, and the owner is not this service's to record.
    if (this.stopped) return;
    this.account = account;
    this.lastError = null;
    this.onLinked?.(account);
    await this.start();
  }

  private abandonLink(err: unknown): void {
    this.linking = null;
    this.pairing = null;
    this.pairingRun = null;
    // Cancelled by stop: nothing failed, so nothing to report.
    if (this.stopped) return;
    this.setStatus("not_linked");
    this.lastError = describe(err);
    logError("link", err);
  }

  /** True once WhatsApp has delivered at least one history-sync batch. */
  hasHistory(): boolean {
    return this.historyReceived;
  }

  storeCounts(): { chats: number; contacts: number; messages: number } {
    const db = this.storage.readyDb();
    if (db === null) return { chats: 0, contacts: 0, messages: 0 };
    const chats = db.identity.listChats().filter((chat) => this.views.listed(chat)).length;
    return { chats, contacts: this.namedContacts(), messages: db.counts().messages };
  }

  /** This account already has a chat, or messages, for this jid. Contacts do not count. */
  hasChat(jid: string): boolean {
    const id = this.identity.canonical(jid);
    if (!id || isNoiseJid(id)) return false;
    const chat = this.storage.readyDb()?.identity.chat(id) ?? null;
    return chat !== null && this.views.listed(chat);
  }

  hasMessage(id: string): boolean {
    if (this.stopped) return false;
    try {
      const db = this.storage.readyDb();
      if (db === null) return false;
      if (db.messages.get(id) !== null) return true;
      this.storage.settleExpired(db, id);
      return false;
    } catch {
      return false;
    }
  }

  hasDraft(id: string): boolean {
    const db = this.storage.readyDb();
    if (db === null) return false;
    try {
      return this.drafts.has(db.sends, id);
    } catch {
      return false;
    }
  }

  /** The one writer of `status`, so `status_since` can never drift from it. */
  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.statusSince = Date.now();
    this.webhooks.queueConnectionWebhook(next);
    // Notes that waited for the connection run now rather than at the worker's next look.
    if (next === "connected" && this.voice.autoTranscribe) this.voice.transcribeWorker.kick();
  }

  getStatus(): StatusInfo {
    const inboundAt = this.latestInboundAt();
    const info: StatusInfo = {
      status: this.status,
      status_since: isoWithOffset(this.statusSince),
      sync: this.syncState(),
      account: this.account,
      account_id: this.accountRecord.id,
      account_name: this.accountRecord.name,
      enabled: this.accountRecord.enabled,
      write_tools: !this.effectiveReadOnly,
      last_message_received_at: inboundAt === null ? null : isoWithOffset(inboundAt),
      reconnect_attempts: this.reconnectAttempts,
      wazap_version: WAZAP_VERSION,
      baileys_version: BAILEYS_VERSION,
      contacts_named: this.namedContacts(),
      data_dir: this.config.dataDir,
      read_only: this.effectiveReadOnly,
      rate_limit: this.effectiveRateLimit,
      last_error: this.lastError ?? this.storage.storageFault?.message ?? null,
      webhook: this.webhooks.webhookStatus(),
      recall: this.recallIndex.recallStatus(),
      storage: this.storage.storageInfo(),
      transcription: this.voice.transcriptionStatus(),
      health: this.health.info(),
      diagnostics: {
        read_self: {
          seen: this.ingest.readSelf.seen,
          synced: this.ingest.readSelf.synced,
          applied: this.ingest.readSelf.applied,
          unmatched: this.ingest.readSelf.unmatched,
          last_at: this.ingest.readSelf.lastAt === null ? null : isoWithOffset(this.ingest.readSelf.lastAt),
        },
      },
    };
    const hints: string[] = [];
    const restricted = this.health.hint();
    if (restricted !== null) hints.push(restricted);
    if (this.storage.storageState === "preparing") {
      hints.push("The account is preparing its database from its earlier message files (once, after an upgrade); tools answer NOT_CONNECTED until it is done.");
    }
    if (this.storage.storageState === "failed" && this.storage.storageFault?.fix) hints.push(this.storage.storageFault.fix);
    if (this.status === "linking" && this.pairing) {
      info.pairing = this.pairing;
      hints.push("Enter the code on the phone; call get_status again in 10 s");
    }
    hints.push(
      ...writesHints({
        readOnly: this.effectiveReadOnly,
        transport: this.config.transport,
        publicUrl: this.config.publicUrl,
      })
    );
    const stale = inboundAt !== null && Date.now() - inboundAt > STALE_INBOUND_MS;
    if (this.status === "connected" && stale) {
      hints.push("No messages received for 24h; the phone may be offline.");
    }
    if (hints.length > 0) info.hint = hints.join(" ");
    return info;
  }

  /**
   * `lastInboundAt` is read from the database when it opens and raised as
   * messages land, so status is a read, not a scan. A deleted newest message
   * can leave it a touch stale, which only ever delays the "phone may be
   * offline" hint.
   */
  private latestInboundAt(): number | null {
    return this.lastInboundAt;
  }

  /** Every stored inbound message is evidence the phone link is alive. */
  private noteInbound(fromMe: boolean, ts: number): void {
    if (fromMe) return;
    this.lastInboundAt = Math.max(this.lastInboundAt ?? 0, ts);
  }

  listChats(filter: ChatFilter, limit: number, opts: { private?: PrivateRule } = {}): Promise<Synced<ChatSummary[]>> {
    return this.reads.listChats(filter, limit, opts);
  }

  readMessages(chatId: string, limit: number, before?: string, types?: MessageType[]): Promise<ChatRead> {
    return this.reads.readMessages(chatId, limit, before, types);
  }

  getRecentMessages(
    hours: number,
    filter: Exclude<ChatFilter, "archived">,
    includeSystem = false,
    types?: MessageType[]
  ): Promise<Synced<RecentConversation[]>> {
    return this.reads.getRecentMessages(hours, filter, includeSystem, types);
  }

  searchMessages(
    query: string,
    chatId: string | undefined,
    limit: number,
    opts: SearchOptions = {}
  ): Promise<SearchAnswer> {
    return this.reads.searchMessages(query, chatId, limit, opts);
  }

  searchCoverage(chatId: string | undefined, opts: { sinceMs?: number; untilMs?: number } = {}): SearchCoverage | null {
    return this.reads.searchCoverage(chatId, opts);
  }

  getMessage(messageId: string): Promise<MessageView> {
    return this.reads.getMessage(messageId);
  }

  draftContext(chatJid: string, options: { recent: boolean; private?: PrivateRule }): DraftContext | null {
    return this.reads.draftContext(chatJid, options);
  }

  styleCheck(chatJid: string, text: string, options: { private?: PrivateRule } = {}): StyleCheck | null {
    return this.reads.styleCheck(chatJid, text, options);
  }

  getStories(hours: number, opts: { private?: PrivateRule } = {}): Promise<Synced<MessageView[]>> {
    return this.reads.getStories(hours, opts);
  }

  getUnanswered(minAgeHours: number, maxAgeHours: number, limit: number): Promise<Synced<UnansweredChat[]>> {
    return this.reads.getUnanswered(minAgeHours, maxAgeHours, limit);
  }

  catchUpScan(request: CatchupScanRequest): Promise<CatchupScan> {
    return this.reads.catchUpScan(request);
  }

  catchUpTags(): Promise<CatchupTagJids> {
    return this.reads.catchUpTags();
  }

  catchUpQuotes(ids: number[]): Promise<CatchupQuote[]> {
    return this.reads.catchUpQuotes(ids);
  }

  catchUpAdvance(client: string, window: CatchupWindow): Promise<{ advanced: boolean }> {
    return this.reads.catchUpAdvance(client, window);
  }

  markHandled(chatId: string): Promise<HandledResult> {
    return this.reads.markHandled(chatId);
  }

  recall(
    query: string,
    chatId: string | undefined,
    limit: number,
    opts: SearchOptions = {}
  ): Promise<Synced<RecallAnswer>> {
    return this.recallIndex.recall(query, chatId, limit, opts);
  }

  /** The recent exchange and the user's style in a chat, for a contact find_contact resolved. */
  syncContacts(): Promise<ContactSyncResult> {
    return this.contacts.syncContacts();
  }

  /** People from the phone's address book: the only contact count worth reporting. */
  namedContacts(): number {
    return this.contacts.namedContacts();
  }

  searchContacts(query: string, limit: number, opts: { tag?: string } = {}): Promise<ContactSummary[]> {
    return this.contacts.searchContacts(query, limit, opts);
  }

  getContact(contactId: string): Promise<ContactDetails> {
    return this.contacts.getContact(contactId);
  }

  findContact(query: FindContactQuery): Promise<AccountFind> {
    return this.contacts.findContact(query);
  }

  listContacts(query: ListContactsQuery): Promise<ContactList> {
    return this.contacts.listContacts(query);
  }

  setContactNote(contactId: string, note: string): Promise<ContactSummary> {
    return this.contacts.setContactNote(contactId, note);
  }

  updateContactDetails(contactId: string, edit: ContactDetailsEdit): Promise<ContactSummary> {
    return this.contacts.updateContactDetails(contactId, edit);
  }

  waitForMessages(opts: WaitOptions): Promise<WaitResult> {
    return this.waits.waitForMessages(opts);
  }

  previews(messageIds: string[], max: number): Promise<Preview[]> {
    return this.media.previews(messageIds, max);
  }

  downloadMedia(messageId: string, saveTo?: string): Promise<MediaResult> {
    return this.media.downloadMedia(messageId, saveTo);
  }

  transcribeAudio(messageId: string, language?: string, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
    return this.voice.transcribeAudio(messageId, language, opts);
  }

  /**
   * The account is being removed: its upload or whisper.cpp run under way ends
   * now instead of being waited for, and gives its attempt back.
   */
  abortTranscription(): void {
    this.voice.abortTranscription();
  }

  /**
   * Resolves when the background queue has nothing left to transcribe. Off the
   * WhatsAppApi on purpose: an agent has no business waiting on it, and a test
   * needs it so it can wait on the queue instead of sleeping.
   */
  transcribeIdle(): Promise<void> {
    return this.voice.transcribeIdle();
  }

  /**
   * Resolves when the embedding feed has nothing left to embed. Same rule as
   * transcribeIdle: off the public API, here so tests can wait on it.
   */
  recallIdle(): Promise<void> {
    return this.recallIndex.recallIdle();
  }

  /**
   * Test and lifecycle barrier, not an MCP tool: queued purges, folds, expiry
   * sweeps and file cleanup have finished. A cleanup failure since the last
   * call is reported here, once. Deleting tools wait on it too.
   */
  async storageIdle(): Promise<void> {
    await this.ingest.historyIdle();
    const db = this.storage.accountDb;
    if (db !== null && db.isOpen) {
      await Promise.allSettled([...this.folds]);
      await db.idle();
      // A deadline that passed before its timer fired is due now: the sweep runs here too.
      const next = this.storage.readyDb()?.messages.nextExpiry() ?? null;
      if (next !== null && next <= Date.now()) await this.storage.sweepExpired();
    }
    await this.storage.expirySweep;
    for (;;) {
      const pending = this.storage.fileWork;
      await pending;
      if (pending === this.storage.fileWork) break;
    }
    const fault = this.storage.fileFault;
    this.storage.fileFault = null;
    if (fault) throw fault;
  }

  /** The folds a pairing started, let land within a bound: list_chats reads the merged rows. */
  private async foldsSettled(): Promise<void> {
    if (this.folds.size === 0) return;
    await Promise.race([Promise.allSettled([...this.folds]), sleep(FOLD_SETTLE_MS, undefined, { ref: false })]);
  }

  draft(payload: DraftPayload, owner?: string): Promise<DraftView> {
    return this.sends.draft(payload, owner);
  }

  confirm(draftId: string, owner?: string): Promise<SentMessage> {
    return this.sends.confirm(draftId, owner);
  }

  sendMessage(
    chatId: string,
    text: string,
    replyTo?: string,
    mentionIds?: string[],
    attempt?: SendAttempt
  ): Promise<SentMessage> {
    return this.sends.sendMessage(chatId, text, replyTo, mentionIds, attempt);
  }

  sendMedia(
    chatId: string,
    source: MediaSource,
    opts: { caption?: string; asDocument: boolean; asVoice: boolean; asGif: boolean },
    attempt?: SendAttempt
  ): Promise<SentMessage> {
    return this.sends.sendMedia(chatId, source, opts, attempt);
  }

  sendPoll(
    chatId: string,
    question: string,
    options: string[],
    multiSelect: boolean,
    attempt?: SendAttempt
  ): Promise<SentMessage> {
    return this.sends.sendPoll(chatId, question, options, multiSelect, attempt);
  }

  sendLocation(
    chatId: string,
    latitude: number,
    longitude: number,
    name?: string,
    address?: string,
    attempt?: SendAttempt
  ): Promise<SentMessage> {
    return this.sends.sendLocation(chatId, latitude, longitude, name, address, attempt);
  }

  editMessage(messageId: string, text: string): Promise<SentMessage> {
    return this.sends.editMessage(messageId, text);
  }

  reactToMessage(messageId: string, emoji: string): Promise<{ message_id: string; emoji: string }> {
    return this.sends.reactToMessage(messageId, emoji);
  }

  forwardMessage(messageId: string, toChatId: string, attempt?: SendAttempt): Promise<SentMessage> {
    return this.sends.forwardMessage(messageId, toChatId, attempt);
  }

  deleteMessage(messageId: string, forEveryone: boolean): Promise<{ message_id: string; for_everyone: boolean }> {
    return this.chats.deleteMessage(messageId, forEveryone);
  }

  manageChat(chatId: string, action: ChatAction, opts: ChatActionOptions = {}): Promise<ChatActionResult> {
    return this.chats.manageChat(chatId, action, opts);
  }

  getGroupInfo(groupId: string): Promise<GroupInfo> {
    return this.groups.getGroupInfo(groupId);
  }

  createGroup(name: string, participantIds: string[]): Promise<{ chat_id: string; participants: ParticipantResult[] }> {
    return this.groups.createGroup(name, participantIds);
  }

  joinGroup(opts: { invite?: string; messageId?: string; confirm: boolean }): Promise<JoinGroupResult> {
    return this.groups.joinGroup(opts);
  }

  manageGroup(
    groupId: string,
    action: GroupAction,
    participantIds?: string[],
    value?: string,
    source?: MediaSource
  ): Promise<GroupActionResult> {
    return this.groups.manageGroup(groupId, action, participantIds, value, source);
  }

  /** Close the current socket and mute it, so a socket we are replacing can no
   * longer emit a close event and trigger a reconnect of its own. */
  private teardownSocket(): void {
    const sock = this.sockClient;
    if (!sock) return;
    this.sockClient = null;
    try {
      sock.ev.removeAllListeners("connection.update");
      void sock.end(undefined);
    } catch (err) {
      logError("teardown", err);
    }
  }

  /**
   * Asks WhatsApp whether the account is under a reachout timelock: at every open, and after a first
   * message was refused (463). Older Baileys has no such call; a failure costs only the answer.
   */
  private checkReachout(sock: WASocket, generation: number): Promise<void> {
    // One question at a time: a burst of refused sends asks once.
    this.reachoutCheck ??= (async () => {
      const asks = sock as {
        fetchAccountReachoutTimelock?: () => Promise<ReachoutLock>;
        fetchNewChatMessageCap?: () => Promise<NewChatCapReport>;
      };
      if (typeof asks.fetchAccountReachoutTimelock === "function") {
        try {
          const lock = await asks.fetchAccountReachoutTimelock.call(sock);
          if (generation !== this.generation || this.stopped) return;
          this.health.noteReachout(lock);
        } catch (err) {
          logError("reachout timelock", err);
        }
      }
      // WhatsApp's cap on first messages to new people; an account it does not apply to may answer nothing.
      if (typeof asks.fetchNewChatMessageCap === "function") {
        try {
          const cap = await asks.fetchNewChatMessageCap.call(sock);
          if (generation !== this.generation || this.stopped) return;
          this.health.noteNewChatCap(cap);
        } catch (err) {
          logError("new chat cap", err);
        }
      }
    })().finally(() => {
      this.reachoutCheck = null;
    });
    return this.reachoutCheck;
  }

  /**
   * Whether `jid` has written to the account, among the latest messages stored: a stranger's
   * reply opens a chat a reachout timelock leaves open. The account's own message does not
   * count — it is stored the moment it leaves, before WhatsApp may refuse it.
   */
  private heardFrom(jid: string): boolean {
    try {
      return this.storage.readyDb()?.messages.chatPage(jid, { limit: 200 }).items.some((message) => !message.fromMe) ?? false;
    } catch {
      return false;
    }
  }

  /** One try at the link when a temporary ban WhatsApp dated ends, a minute after; none for an undated or long one. */
  private retryAfterBan(): void {
    const until = this.health.banEndsAt();
    if (until === null || this.stopped || this.reconnectTimer) return;
    const wait = until - Date.now();
    if (wait > TEMP_BAN_RETRY_MAX_MS) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts = 0;
      this.start().catch((err) => {
        logError("reconnect", err);
        this.scheduleReconnect("reconnect after a temporary ban failed");
      });
    }, Math.max(0, wait) + 60_000);
    this.reconnectTimer.unref();
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return;
    this.teardownSocket();
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.setStatus("auth_failure");
      this.lastError =
        `${reason} — gave up after ${RECONNECT_MAX_ATTEMPTS} attempts. ` +
        "WhatsApp keeps rejecting this session: re-link the device with `npx wazap-mcp login`.";
      logError("reconnect", this.lastError);
      this.onGiveUp?.();
      return;
    }
    const attempt = this.reconnectAttempts++;
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    const delay = Math.round(backoff * (0.5 + Math.random()));
    log(`disconnected (${reason}); retry ${attempt + 1}/${RECONNECT_MAX_ATTEMPTS} in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((err) => {
        logError("reconnect", err);
        this.scheduleReconnect("reconnect failed");
      });
    }, delay);
  }

  /**
   * Runs one event's writes, and keeps a storage failure — a full disk, a
   * database closed by a stop — inside the handler: logged, never thrown into
   * Baileys' emitter.
   */
  private handling<T>(what: string, work: () => T, fallback: T): T {
    if (this.stopped) return fallback;
    try {
      return work();
    } catch (err) {
      if (!this.stopped) logError(what, err);
      return fallback;
    }
  }

  private wireEvents(sock: WASocket, generation: number): void {
    sock.ev.on("creds.update", () => {
      const save = this.saveCreds;
      if (save) void save().catch((err: unknown) => logError("creds save", err));
    });

    sock.ev.on("connection.update", (update) => {
      if (generation !== this.generation) return;
      const { connection, lastDisconnect } = update;
      // WhatsApp's own word on the reachout timelock, pushed or answering fetchAccountReachoutTimelock.
      const reachout = (update as { reachoutTimeLock?: ReachoutLock }).reachoutTimeLock;
      if (reachout !== undefined) this.health.noteReachout(reachout);
      if (connection === "open") {
        this.reconnectAttempts = 0;
        this.health.noteOpen();
        this.setStatus("connected");
        this.lastError = null;
        this.adoptSocketAccount();
        this.armSyncDeadline();
        log("connected to WhatsApp");
        void this.healContacts(sock, generation);
        void this.loadBlocklist(sock, generation);
        void this.checkReachout(sock, generation);
      } else if (connection === "close") {
        const verdict = classifyClose(lastDisconnect?.error);
        if (verdict.kind === "logged_out") {
          this.health.forgetSession();
          this.setStatus("logged_out");
          this.lastError = "The account was unlinked from the phone.";
          logError("auth", this.lastError);
          this.teardownSocket();
        } else if (verdict.kind !== "transient") {
          // About the account, not the link: reconnecting would only knock on a closed door, and a
          // restart cannot open it, so onGiveUp is not called. A temporary ban gets one try when it ends.
          this.health.noteClose(verdict);
          this.setStatus("auth_failure");
          this.lastError = this.health.refusal("write").message;
          logError("account", `${this.lastError} (WhatsApp close ${verdict.code})`);
          this.teardownSocket();
          this.retryAfterBan();
        } else if (!this.stopped) {
          this.setStatus("disconnected");
          this.lastError = lastDisconnect?.error?.message ?? "connection closed";
          this.scheduleReconnect(this.lastError);
        }
      }
    });

    sock.ev.on("messaging-history.set", (batch) => this.ingest.ingestHistory(batch));

    sock.ev.on("call", ([call]) => {
      if (generation !== this.generation || !call) return;
      // WhatsApp addresses a call node by LID as often as by number, and ownJid
      // is only ever the number, so an outgoing call reads as incoming unless
      // the two are brought into the same form first.
      const from = this.identity.canonical(call.from);
      const entry = this.ingest.calls.observe({ ...call, from }, this.identity.ownJid(), Date.now());
      if (entry) this.ingest.storeCall(entry);
      this.ingest.armCallSweep();
    });

    sock.ev.on("lid-mapping.update", (mapping) => this.identity.learnLid(mapping.lid, mapping.pn));

    sock.ev.on("chats.upsert", (chats) => {
      this.handling("chats", () => this.storage.db.transaction(() => chats.forEach((chat) => this.ingest.ingestChat(chat))), undefined);
    });

    sock.ev.on("chats.update", (updates) => {
      this.handling(
        "chats",
        () =>
          this.storage.db.transaction(() => {
            for (const update of updates) {
              if (!update.id) continue;
              const jid = this.identity.canonical(update.id);
              if (isNoiseJid(jid)) continue;
              this.ingest.writeChat(jid, { ...update, id: jid });
            }
          }),
        undefined
      );
    });

    sock.ev.on("chats.delete", (ids) => {
      for (const id of ids) {
        this.handling("chat delete", () => void this.chats.forgetChat(this.identity.canonical(id), true).catch((err: unknown) => logError("chat delete", err)), undefined);
      }
    });

    sock.ev.on("contacts.upsert", (contacts) => {
      this.handling("contacts", () => this.storage.db.transaction(() => contacts.forEach((contact) => this.ingest.ingestContact(contact))), undefined);
    });

    sock.ev.on("contacts.update", (updates) => {
      this.handling(
        "contacts",
        () =>
          this.storage.db.transaction(() => {
            for (const update of updates) if (update.id) this.ingest.ingestContact({ ...update, id: update.id });
          }),
        undefined
      );
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (this.ingest.historyPending === 0 || this.stopped) {
        this.ingest.receiveMessages(messages, type);
        return;
      }
      // While history is being stored, new messages land at once and marks on messages wait for it.
      const marks = messages.filter((raw) => this.ingest.isMark(raw));
      this.ingest.receiveMessages(messages.filter((raw) => !marks.includes(raw)), type);
      if (marks.length > 0) this.ingest.afterHistory(() => this.ingest.receiveMessages(marks, type, true));
    });

    sock.ev.on("messages.delete", (item) => {
      // The other side asked that these go; the database honours it the way the
      // phone does, vectors and files included.
      if ("all" in item) {
        this.handling("messages delete", () => void this.chats.forgetChat(this.identity.canonical(item.jid), false).catch((err: unknown) => logError("messages delete", err)), undefined);
        return;
      }
      const targets: MessageRef[] = [];
      for (const key of item.keys) {
        if (!key.remoteJid || !key.id) continue;
        targets.push({ chatJid: this.identity.canonical(key.remoteJid), fromMe: Boolean(key.fromMe), keyId: key.id });
      }
      const at = Date.now();
      this.ingest.markLater("messages delete", () => this.ingest.retract(targets, at));
    });

    sock.ev.on("message-capping.update", (report) => {
      if (generation !== this.generation) return;
      this.health.noteNewChatCap(report as NewChatCapReport);
    });

    sock.ev.on("messages.update", (updates) => {
      // A send WhatsApp refused after it left comes back as status ERROR with its code first; 463 is a
      // first message refused, which a reachout timelock explains, so the timelock is asked for.
      for (const { update } of updates) {
        const refused = update.status === 0 ? update.messageStubParameters?.[0] : undefined;
        if (refused === undefined || refused === null) continue;
        this.health.noteSendError(String(refused));
        if (String(refused) === "463") void this.checkReachout(sock, generation);
      }
      const readSelf = updates.flatMap(({ key, update }) => (this.ingest.isReadSelfUpdate(key, update) ? [key] : []));
      this.ingest.noteReadSelf(readSelf.length);
      this.ingest.markLater("messages update", () => {
        for (const { key, update } of updates) this.ingest.applyUpdate(key, update);
        if (readSelf.length > 0) this.ingest.applyReadSelf(readSelf);
      });
    });

    // In a group, each member's receipt arrives on its own; the status is theirs combined.
    sock.ev.on("message-receipt.update", (items) => {
      // A member's receipt that is the account's own: one of its devices read a group message (a story it viewed is not a chat read).
      const readSelf = items.flatMap(({ key, receipt }) =>
        key.remoteJid && chatKindOf(this.identity.canonical(key.remoteJid)) === "group" && receipt.userJid && this.identity.isMe(receipt.userJid) && (receipt.readTimestamp || receipt.playedTimestamp)
          ? [key]
          : []
      );
      this.ingest.noteReadSelf(readSelf.length);
      this.ingest.markLater(
        "receipts",
        () =>
          this.storage.db.transaction(() => {
            if (readSelf.length > 0) this.ingest.applyReadSelf(readSelf);
            for (const { key, receipt } of items) {
              const jid = key.remoteJid ? this.identity.canonical(key.remoteJid) : undefined;
              // The account's other devices confirm its messages too; they are not members.
              if (!jid || !key.fromMe || !receipt.userJid || this.identity.isMe(receipt.userJid)) continue;
              const moments = momentsOf(receipt);
              this.storage.db.messages.receipt(messageIdFor(key, jid), this.identity.canonical(receipt.userJid), {
                deliveredAt: moments.delivered ?? null,
                readAt: moments.read ?? null,
                playedAt: moments.played ?? null,
              });
            }
          })
      );
    });

    sock.ev.on("messages.reaction", (items) => {
      this.ingest.markLater(
        "reactions",
        () => {
          for (const { key, reaction } of items) {
            const jid = key.remoteJid ? this.identity.canonical(key.remoteJid) : undefined;
            if (!jid) continue;
            const author = reaction.key?.fromMe
              ? this.identity.ownJid()
              : this.identity.canonical(reaction.key?.participant || reaction.key?.remoteJid || "");
            if (!author) continue;
            const at = protoNumber(reaction.senderTimestampMs) || Date.now();
            this.ingest.react(messageIdFor(key, jid), author, reaction.text ?? "", at);
          }
        }
      );
    });

    sock.ev.on("groups.upsert", (groups) => {
      this.handling("groups", () => groups.forEach((meta) => this.groups.cacheGroup(this.identity.canonical(meta.id), meta)), undefined);
    });

    sock.ev.on("groups.update", (updates) => {
      for (const update of updates) {
        if (!update.id) continue;
        const jid = this.identity.canonical(update.id);
        const previous = this.groups.groupCache.get(jid);
        if (previous) this.groups.groupCache.set(jid, { ...previous, ...update });
      }
    });

    sock.ev.on("group-participants.update", ({ id }) => this.groups.groupCache.delete(this.identity.canonical(id)));

    sock.ev.on("blocklist.set", ({ blocklist }) => {
      this.contacts.blocked.clear();
      for (const jid of blocklist) this.contacts.blocked.add(this.identity.canonical(jid));
    });

    sock.ev.on("blocklist.update", ({ blocklist, type }) => {
      for (const jid of blocklist) {
        if (type === "add") this.contacts.blocked.add(this.identity.canonical(jid));
        else this.contacts.blocked.delete(this.identity.canonical(jid));
      }
    });
  }

  private readAccount(): StatusInfo["account"] | "corrupt" {
    let linked;
    try {
      linked = readLinkedAccount(this.paths.authDir);
    } catch (err) {
      this.markCorrupt(err);
      return "corrupt";
    }
    if (!linked) {
      this.setStatus("not_linked");
      this.account = null;
      this.lastError = null;
      log("no WhatsApp account is linked; run `npx wazap-mcp login`");
      return null;
    }
    return { id: linked.id, name: linked.name, number: linked.number };
  }

  /** The credentials a pairing saved while start() was busy, without touching the status when there are none. */
  private linkedSinceBoot(): StatusInfo["account"] | null {
    if (this.linking !== null) return null;
    try {
      const linked = readLinkedAccount(this.paths.authDir);
      return linked ? { id: linked.id, name: linked.name, number: linked.number } : null;
    } catch {
      return null;
    }
  }

  private markCorrupt(err: unknown): void {
    this.setStatus("session_corrupt");
    this.lastError = describe(err);
    logError("auth state", err);
  }

  private adoptSocketAccount(): void {
    const user = this.sockClient?.user;
    if (!user?.id) return;
    const id = this.identity.canonical(user.id);
    this.account = { id, name: user.name ?? this.account?.name ?? "", number: id.split("@")[0] ?? "" };
    if (user.lid) this.identity.learnLid(user.lid, id);
  }

  private armSyncDeadline(): void {
    if (this.syncDeadline) clearTimeout(this.syncDeadline);
    this.syncDeadline = setTimeout(() => this.markSyncDone(), SYNC_WAIT_MS);
  }

  private markSyncDone(): void {
    if (this.syncDeadline) {
      clearTimeout(this.syncDeadline);
      this.syncDeadline = null;
    }
    if (this.initialSyncDone) return;
    this.initialSyncDone = true;
    this.releaseWaiters();
  }

  private releaseWaiters(): void {
    const waiters = this.syncWaiters;
    this.syncWaiters = [];
    for (const waiter of waiters) waiter();
    this.releaseHistoryWaiters();
  }

  private releaseHistoryWaiters(): void {
    const waiters = this.historyWaiters;
    this.historyWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Resolves as soon as the initial sync lands, and in any case within 10s. */
  private waitForSync(): Promise<void> {
    if (this.initialSyncDone) return Promise.resolve();
    return new Promise<void>((done) => {
      const timer = setTimeout(() => {
        this.syncWaiters = this.syncWaiters.filter((entry) => entry !== waiter);
        done();
      }, SYNC_WAIT_MS);
      const waiter = (): void => {
        clearTimeout(timer);
        done();
      };
      this.syncWaiters.push(waiter);
    });
  }

  /**
   * The address book, once, for a session that connected without it.
   *
   * Names reach a companion through the app state sync, and WhatsApp sends each
   * collection's snapshot only to a connection asking from version zero. A
   * socket that saved those versions and dropped the contacts leaves every later
   * connection resyncing from a version with nothing left to send, so the only
   * way back is to forget the versions and ask again.
   */
  private async healContacts(sock: WASocket, generation: number): Promise<void> {
    if (this.contactResyncTried) return;
    this.contactResyncTried = true;
    try {
      await this.waitForSync();
      const named = await this.contacts.waitForNames(0, Date.now() + CONTACT_SETTLE_MS);
      if (generation !== this.generation || this.stopped) return;
      const decision = {
        named,
        storedVersions: await this.contacts.hasAppStateVersions(sock),
        resyncedAt: this.contacts.contactsResyncedAt(),
        now: Date.now(),
      };
      if (!needsContactResync(decision)) return;
      log("address book missing; requesting a full contact sync");
      await this.contacts.resyncContacts(sock);
    } catch (err) {
      logError("contact sync", err);
    }
  }

  /**
   * Who the account has blocked, asked once per connection: WhatsApp pushes the
   * list only when it changes, so getContact would otherwise say "not blocked"
   * for everyone until then. A failure costs only that answer, so it is logged.
   */
  private async loadBlocklist(sock: WASocket, generation: number): Promise<void> {
    // A stand-in socket without the call has no blocklist to give, and nothing worth logging.
    if (typeof sock.fetchBlocklist !== "function") return;
    try {
      const blocklist = await sock.fetchBlocklist();
      if (generation !== this.generation || this.stopped) return;
      this.contacts.blocked.clear();
      for (const jid of blocklist) if (jid) this.contacts.blocked.add(this.identity.canonical(jid));
    } catch (err) {
      logError("blocklist", err);
    }
  }

  private syncState(): SyncState {
    return this.initialSyncDone ? "done" : "in_progress";
  }

  private synced<T>(data: T): Synced<T> {
    return { data, sync: this.syncState() };
  }

  /** Every public method funnels through here, so no raw Baileys or storage error escapes. */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof StorageError && err.code === "CLOSED") {
        throw new WazapError("NOT_CONNECTED", "The account is stopping.", "Call get_status, wait, retry");
      }
      throw asWazapError(err);
    }
  }

  private ensureConnected(): WASocket {
    if (this.storage.storageState === "preparing") throw this.storage.preparingError();
    if (this.storage.storageState === "failed" && this.storage.storageFault !== null) throw this.storage.storageFault;
    switch (this.status) {
      case "not_linked":
        throw new WazapError("NOT_LINKED", "No WhatsApp account is linked.", RELINK_FIX);
      case "linking":
        throw new WazapError(
          "NOT_CONNECTED",
          "Pairing is in progress.",
          "Enter the code on the phone, then call get_status"
        );
      case "session_corrupt":
        throw new WazapError("SESSION_CORRUPT", this.lastError ?? "Stored credentials are unreadable.", RESET_FIX);
      case "logged_out":
        throw new WazapError("SESSION_EXPIRED", this.lastError ?? "The account was unlinked.", RELINK_FIX);
      case "auth_failure":
        if (this.health.blocksWrites()) throw this.health.refusal("read");
        throw new WazapError("NOT_CONNECTED", this.lastError ?? "WhatsApp refused this session.");
      case "connecting":
      case "disconnected":
        throw new WazapError("NOT_CONNECTED", `The WhatsApp socket is ${this.status}.`, "Call get_status, wait, retry");
      case "connected": {
        if (!this.sockClient) throw new WazapError("NOT_CONNECTED", "The WhatsApp socket is gone.");
        return this.sockClient;
      }
    }
  }

  /**
   * First statement of every write, so a broken link is reported before the bucket is spent. The bucket is
   * the writes' unless a write has one of its own; read at the call, so a test's stand-in is the one taken.
   */
  private beginWrite(bucket: RateLimiter = this.writes): WASocket {
    if (this.effectiveReadOnly) {
      const id = this.accountRecord.id;
      throw new WazapError(
        "READ_ONLY",
        `Account "${id}" is read-only, so this write is refused.`,
        this.accountRecord.writes === false
          ? `Run \`wazap config writes on --account ${id}\`, then restart the server`
          : "Run `wazap config writes on`, then restart the server"
      );
    }
    if (this.health.blocksWrites()) throw this.health.refusal("write");
    const sock = this.ensureConnected();
    bucket.take();
    return sock;
  }

  /**
   * The bytes behind a message's media — saving them and transcribing them
   * share this. Media arrives whole in memory, so the size is checked twice:
   * the declared length before the download starts, and the stream itself
   * while it lands — a sender can understate the first, not the second.
   */
  private async mediaBuffer(sock: WASocket, messageId: string, raw: WAMessage): Promise<Buffer> {
    const declared = mediaInfo(raw)?.size;
    if (declared !== undefined && declared > MEDIA_DOWNLOAD_MAX_BYTES) {
      throw new WazapError(
        "FILE_TOO_LARGE",
        `The media of ${messageId} is ${Math.ceil(declared / 1_000_000)} MB; downloads are capped at ${MEDIA_DOWNLOAD_MAX_BYTES / 1_000_000} MB.`
      );
    }
    try {
      const stream = await downloadMediaMessage(raw, "stream", {}, {
        logger: silentLogger,
        reuploadRequest: sock.updateMediaMessage,
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of stream) {
        this.views.messageOrThrow(messageId);
        bytes += (chunk as Buffer).length;
        if (bytes > MEDIA_DOWNLOAD_MAX_BYTES) {
          stream.destroy();
          throw new WazapError(
            "FILE_TOO_LARGE",
            `The media of ${messageId} exceeds the ${MEDIA_DOWNLOAD_MAX_BYTES / 1_000_000} MB download cap.`
          );
        }
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    } catch (err) {
      if (err instanceof WazapError) throw err;
      const failure = new WazapError(
        "MEDIA_UNAVAILABLE",
        `Could not download the media of ${messageId}: ${describe(err)}`,
        "Ask the sender to resend it"
      );
      // Not enumerable, so no answer serializes it: the transcription queue reads its status to tell expired media from a timeout.
      Object.defineProperty(failure, "cause", { value: err, configurable: true, writable: true });
      throw failure;
    }
  }

  private async fetchOlder(sock: WASocket, anchor: StoredMessage, limit: number): Promise<void> {
    const raw = this.views.rawOf(anchor) ?? this.views.keyOnly(anchor);
    const seconds = Math.floor(anchor.ts / 1000);
    await sock.fetchMessageHistory(limit, raw.key, seconds);
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        this.historyWaiters = this.historyWaiters.filter((entry) => entry !== waiter);
        done();
      }, HISTORY_FETCH_WAIT_MS);
      const waiter = (): void => {
        clearTimeout(timer);
        done();
      };
      this.historyWaiters.push(waiter);
    });
  }

}
