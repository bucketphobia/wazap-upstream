/**
 * The durable webhook outbox: one dispatcher per account, posting the events
 * the account database holds (db.events), oldest first and one at a time.
 *
 * - An event is written in the transaction that stores its message, so a
 *   message is never stored without its event, nor an event without its
 *   message. Only the server process posts; status and doctor read the same
 *   rows read-only (readWebhookDelivery).
 * - The body of a message event is built when it is posted, from the message
 *   as it is then: an edit or a transcript that landed meanwhile goes out with
 *   it, and a message deleted, expired or cleared first is not posted at all.
 * - Order is per chat: an event is posted only once every older event of its
 *   chat is delivered, failed or cancelled, and connection events keep their
 *   own order. An event waiting for its transcript or its next retry holds
 *   back its own chat, never another. Still one POST at a time per account.
 * - A connection event with a newer one behind it is cancelled unposted: after
 *   an outage the receiver hears the current status, not every flap.
 * - Retries: a timeout, an unreachable host, 408, 425, 429 or 5xx is tried
 *   again after 1 s, 5 s, 30 s and 2 min, then every 5 min, and one last time
 *   24 h after the event was created; then it has failed. Any other 4xx fails
 *   at once, except a 401 when the account asked for those to be retried. New
 *   traffic brings a waiting retry forward: an event queued, or a POST that
 *   succeeded, retries at once every event whose last attempt is at least
 *   30 s old, so a receiver that came back hears everything within a POST or
 *   two instead of at its next slot.
 * - Before a message event is posted, `allows` on the host may cancel it. The
 *   service refuses a chat the allowlist does not name, and any message from a
 *   contact tagged `#private`, including when no allowlist is set. A removal
 *   that lands before the claim cancels the event. One already claimed still
 *   goes out.
 * - Coalescing, when configured, holds a chat's not-yet-attempted events until
 *   the chat has been quiet for the window, or the cap since the first of them,
 *   and posts them as one body. A batch that has already been attempted retries
 *   as that same batch; messages that arrive after it wait their own window.
 * - At least once: a POST is marked as started before it is sent, and a crash
 *   during it leaves the event to be sent again, once the claim is older than
 *   a POST can run. Receivers dedupe by message_id.
 * - Delivered events are kept 7 days, failed and cancelled ones 30.
 */
import { setImmediate as turn, setTimeout as sleep } from "node:timers/promises";
import { AccountDb, type EventRecord, type EventStats, type StoredMessage } from "./db/index.js";
import { withCode } from "./error-code.js";
import { openForReading } from "./legacy-files.js";
import { log, logError } from "./logger.js";
import type { WebhookDelivery } from "./wa-types.js";
import {
  WEBHOOK_EVENTS,
  WEBHOOK_TIMEOUT_MS,
  coalescePayloads,
  type WebhookCoalesce,
  type WebhookPayload,
  type WebhookReady,
  type WebhookSink,
} from "./webhook.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** After the first failed POST of an event, the next waits this long; after the fourth, OUTBOX_RETRY_EVERY_MS. */
export const OUTBOX_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000, 2 * MINUTE];
export const OUTBOX_RETRY_EVERY_MS = 5 * MINUTE;
/** An event not delivered this long after it was created has failed, after one last attempt at that moment. */
export const OUTBOX_GIVE_UP_MS = DAY;
/** A waiting retry whose last attempt is at least this old is brought forward by new traffic. */
export const OUTBOX_NUDGE_AFTER_MS = 30_000;
/**
 * A `sending` event claimed this long ago is no POST still running: its
 * dispatcher crashed or was abandoned, and another may take it over. Until
 * then another dispatcher over the same file leaves it, and its chat, alone.
 */
export const OUTBOX_SENDING_STALE_MS = WEBHOOK_TIMEOUT_MS + 5_000;
/** How long an incoming voice note's event waits for the transcript wazap is making of it. */
export const WEBHOOK_TRANSCRIPT_WAIT_MS = MINUTE;
/** While an event waits for a transcript, the database is looked at again this often. */
export const OUTBOX_TRANSCRIPT_POLL_MS = 1_000;
export const OUTBOX_KEEP_DELIVERED_MS = 7 * DAY;
export const OUTBOX_KEEP_CLOSED_MS = 30 * DAY;
export const OUTBOX_PRUNE_EVERY_MS = DAY;
/** Inside a run of identical failures, one log line per this many. */
const LOG_EVERY = 100;
/** A pass the database refused tries again this much later. */
const FAULT_RETRY_MS = 5_000;
/** Events a pass closes without posting (cancelled, given up) before it lets the event loop run. */
const STEPS_PER_TURN = 64;

const MESSAGE_EVENTS: ReadonlySet<string> = new Set(["message_received", "message_sent"]);

/** The lane connection events are posted in, in order, apart from every chat. */
export const CONNECTION_LANE = "connection";

/** The lane of a message event: its chat, whose events are posted in the order they were queued. */
export function chatLane(chatId: number): string {
  return `chat:${chatId}`;
}

/** The wait before the next POST of an event that has failed `failedAttempts` POSTs. */
export function retryDelay(
  failedAttempts: number,
  schedule: readonly number[] = OUTBOX_RETRY_DELAYS_MS,
  every: number = OUTBOX_RETRY_EVERY_MS
): number {
  return schedule[Math.max(0, failedAttempts - 1)] ?? every;
}

/** What the dispatcher needs from the service that owns the account. */
export interface OutboxHost {
  /** The account database while it takes writes; null while it is preparing, failed or closed. */
  db(): AccountDb | null;
  sink(): WebhookSink;
  /** The body to post, built now: from the stored message for a message event, from the stored payload otherwise. */
  payload(event: EventRecord, message: StoredMessage | null): WebhookPayload;
  /** Whether a transcript of this message is still being made, which is what makes waiting for it worthwhile. */
  awaitingTranscript(message: StoredMessage): boolean;
  /**
   * False cancels a pending message event instead of posting it. Absent allows
   * every event. The service passes the allowlist check, read at post time so
   * a tag removed since the event was queued still keeps it back.
   */
  allows?(event: EventRecord, message: StoredMessage): boolean;
}

export interface OutboxOptions {
  /** Epoch ms; tests move it. */
  now?: () => number;
  retryDelays?: readonly number[];
  retryEveryMs?: number;
  giveUpMs?: number;
  transcriptPollMs?: number;
  keepDeliveredMs?: number;
  keepClosedMs?: number;
  pruneEveryMs?: number;
}

type Step =
  | { kind: "idle" }
  | { kind: "wait"; until: number }
  | { kind: "next" }
  | { kind: "post"; events: EventRecord[]; payload: WebhookPayload; settings: WebhookReady };

const IDLE: Step = { kind: "idle" };
const NEXT: Step = { kind: "next" };

export class WebhookOutbox {
  /** Mutable so a test can shorten the schedule of a service it did not construct. */
  retryDelays: readonly number[];
  retryEveryMs: number;
  giveUpMs: number;
  transcriptPollMs: number;
  private readonly now: () => number;
  private readonly keepDeliveredMs: number;
  private readonly keepClosedMs: number;
  private readonly pruneEveryMs: number;
  private started = false;
  private stopped = false;
  private pass: Promise<void> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private pruning: Promise<void> = Promise.resolve();
  /** Failed POSTs since the last delivery, and the error last logged, so a run of failures logs a few lines. */
  private failures = 0;
  private loggedFailure: string | null = null;
  private drops = 0;
  private droppedAt: number | null = null;
  /** New traffic since the last pass: bring stale retries forward before choosing. */
  private nudged = false;

  constructor(
    private readonly host: OutboxHost,
    options: OutboxOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.retryDelays = options.retryDelays ?? OUTBOX_RETRY_DELAYS_MS;
    this.retryEveryMs = options.retryEveryMs ?? OUTBOX_RETRY_EVERY_MS;
    this.giveUpMs = options.giveUpMs ?? OUTBOX_GIVE_UP_MS;
    this.transcriptPollMs = options.transcriptPollMs ?? OUTBOX_TRANSCRIPT_POLL_MS;
    this.keepDeliveredMs = options.keepDeliveredMs ?? OUTBOX_KEEP_DELIVERED_MS;
    this.keepClosedMs = options.keepClosedMs ?? OUTBOX_KEEP_CLOSED_MS;
    this.pruneEveryMs = options.pruneEveryMs ?? OUTBOX_PRUNE_EVERY_MS;
  }

  /**
   * Once the account database is ready: prunes what aged out, arms the daily
   * prune, and posts whatever an earlier run left, including a POST a crash
   * interrupted once its claim is older than a POST can run.
   */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.prune();
    this.pruneTimer = setInterval(() => this.prune(), this.pruneEveryMs);
    this.pruneTimer.unref();
    this.kick();
  }

  /**
   * An event was queued: the receiver may be back, so every retry whose last
   * attempt is OUTBOX_NUDGE_AFTER_MS old or more is due now.
   */
  nudge(): void {
    this.nudged = true;
    this.kick();
  }

  /** Something may be ready to post: a transcript, a changed setting, a timer. */
  kick(): void {
    if (this.stopped) return;
    if (this.pass !== null) {
      this.again = true;
      return;
    }
    this.disarm();
    this.pass = this.run().finally(() => {
      this.pass = null;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    });
  }

  /** Settles once no pass is running. A timer armed for a later attempt stays armed. */
  async idle(): Promise<void> {
    while (this.pass !== null) await this.pass;
  }

  /**
   * Posts nothing more, and waits for the POST in flight to be answered and
   * recorded, as long as its own timeout allows. One that outlives that stays
   * `sending`, and the next dispatcher posts it again once the claim is stale.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.disarm();
    if (this.pruneTimer !== null) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    const pass = this.pass;
    if (pass !== null) await Promise.race([pass, sleep(WEBHOOK_TIMEOUT_MS + 1_000, undefined, { ref: false })]);
    await this.pruning;
  }

  /** An event the database would not store: it can never be posted, so it is counted here instead. */
  dropped(what: string, err?: unknown): void {
    this.drops++;
    this.droppedAt = this.now();
    logError("webhook", `dropped ${what}: the account database could not store it${err === undefined ? "" : withCode(err)}`);
  }

  /** The counters status shows: the database's, and the drops only this process saw. */
  delivery(db: AccountDb | null): WebhookDelivery {
    let stats: EventStats | null = null;
    try {
      stats = db?.events.stats() ?? null;
    } catch (err) {
      logError("webhook", `could not read the outbox${withCode(err)}`);
    }
    return deliveryOf(stats, { count: this.drops, at: this.droppedAt });
  }

  private async run(): Promise<void> {
    let closed = 0;
    while (!this.stopped) {
      let step: Step;
      try {
        step = this.step();
      } catch (err) {
        if (this.stopped) return;
        logError("webhook", `the outbox could not be read or updated${withCode(err)}`);
        this.arm(this.now() + FAULT_RETRY_MS);
        return;
      }
      switch (step.kind) {
        case "idle":
          return;
        case "wait":
          this.arm(step.until);
          return;
        case "next":
          if (++closed % STEPS_PER_TURN === 0) await turn();
          continue;
        case "post":
          try {
            await this.post(step);
          } catch (err) {
            if (this.stopped) return;
            logError("webhook", `the outbox could not record a delivery${withCode(err)}`);
            this.arm(this.now() + FAULT_RETRY_MS);
            return;
          }
      }
    }
  }

  /**
   * The oldest event that may be posted now — the oldest open one of its lane,
   * due, and not waiting for a transcript — and every write it takes to find
   * it short of a POST. A write changes which events head their lanes, so the
   * pass looks again after each.
   */
  private step(): Step {
    const db = this.host.db();
    if (db === null || !db.isOpen) return IDLE;
    const now = this.now();
    if (this.nudged) {
      this.nudged = false;
      db.events.nudge(now, now - OUTBOX_NUDGE_AFTER_MS);
    }
    const heads = db.events.laneHeads();
    if (heads.length === 0) return IDLE;
    const settings = this.host.sink().settings();
    if (settings.kind !== "ready") {
      // Off means post nothing anywhere; an event must not go out once the webhook is fixed or back on.
      db.events.cancelOpen(settings.kind === "off" ? "the webhook is off" : "the webhook settings are invalid", now);
      return NEXT;
    }
    let wake = Infinity;
    for (const event of heads) {
      if (event.state === "sending" && event.updatedAt > now - OUTBOX_SENDING_STALE_MS) {
        // Another dispatcher's POST, still running: its chat waits for the answer.
        wake = Math.min(wake, event.updatedAt + OUTBOX_SENDING_STALE_MS);
        continue;
      }
      if (!WEBHOOK_EVENTS.some((name) => name === event.kind && settings.events.includes(name))) {
        db.events.cancel(event.seq, `${event.kind} is not an enabled event`, now);
        return NEXT;
      }
      if (event.lane === CONNECTION_LANE && db.events.hasNewerOpen(event.lane, event.seq)) {
        db.events.cancel(event.seq, "superseded by a newer connection event", now);
        return NEXT;
      }
      if (MESSAGE_EVENTS.has(event.kind)) {
        const decision = this.decideChat(db, event, settings.coalesce, now);
        switch (decision.kind) {
          case "cancel":
            db.events.cancel(decision.seq, decision.reason, now);
            return NEXT;
          case "fail":
            db.events.fail(decision.seq, decision.status, decision.error, now);
            this.noteFailure(decision.log);
            return NEXT;
          case "wait":
            wake = Math.min(wake, decision.until);
            continue;
          case "ready": {
            let payload: WebhookPayload;
            try {
              payload = this.payloadFor(decision.events, decision.messages);
            } catch (err) {
              // Whatever went wrong may have said what the message says; only its code is kept.
              const error = `Webhook delivery failed${withCode(err)}.`;
              db.events.fail(decision.events[0]!.seq, null, error, now);
              this.noteFailure(error);
              return NEXT;
            }
            const seqs = decision.events.map((row) => row.seq);
            if (!db.events.claimMany(seqs, now, now - OUTBOX_SENDING_STALE_MS)) return NEXT;
            return { kind: "post", events: decision.events, payload, settings };
          }
          default: {
            const _exhaustive: never = decision;
            return _exhaustive;
          }
        }
      }
      const deadline = event.createdAt + this.giveUpMs;
      // Past the day, only the last attempt scheduled for its very end is still made.
      if (now >= deadline && (event.nextAttemptAt === null || event.nextAttemptAt < deadline)) {
        const error = event.lastError ?? "not posted";
        db.events.fail(event.seq, event.lastStatus, `${error}; gave up 24 h after the event`, now);
        this.noteFailure(`gave up on ${event.kind} after ${event.attempts} attempts: ${error}`);
        return NEXT;
      }
      if (event.nextAttemptAt !== null && event.nextAttemptAt > now) {
        wake = Math.min(wake, event.nextAttemptAt);
        continue;
      }
      let payload: WebhookPayload;
      try {
        payload = this.host.payload(event, null);
      } catch (err) {
        const error = `Webhook delivery failed${withCode(err)}.`;
        db.events.fail(event.seq, null, error, now);
        this.noteFailure(error);
        return NEXT;
      }
      if (!db.events.claim(event.seq, now, now - OUTBOX_SENDING_STALE_MS)) return NEXT;
      return { kind: "post", events: [event], payload, settings };
    }
    return wake === Infinity ? IDLE : { kind: "wait", until: wake };
  }

  /**
   * What to do with the oldest open message event of a chat: cancel it, fail
   * it, wait, or post it together with the later events of the same burst.
   * One write at a time, so a cancel is visible to the next look.
   */
  private decideChat(
    db: AccountDb,
    head: EventRecord,
    coalesce: WebhookCoalesce | null,
    now: number
  ):
    | { kind: "cancel"; seq: number; reason: string }
    | { kind: "fail"; seq: number; status: number | null; error: string; log: string }
    | { kind: "wait"; until: number }
    | { kind: "ready"; events: EventRecord[]; messages: StoredMessage[] } {
    const closed = head.attempts > 0 || head.state === "sending";
    const lane = coalesce === null && !closed ? [head] : db.events.openInLane(head.lane);
    const batch = batchOf(lane, head, coalesce !== null || closed);
    const chosen: { event: EventRecord; message: StoredMessage }[] = [];
    for (const event of batch) {
      const message = event.messageId === null ? null : (db.messages.byIds([event.messageId])[0] ?? null);
      if (message === null) {
        return { kind: "cancel", seq: event.seq, reason: "the message was deleted, expired or cleared before it was posted" };
      }
      // A removal takes effect before the next POST, including one already waiting out a retry.
      if (this.host.allows?.(event, message) === false) {
        return { kind: "cancel", seq: event.seq, reason: "the webhook is not posting this message" };
      }
      if (event.readyAt > now && message.transcript === null && this.host.awaitingTranscript(message)) {
        if (chosen.length === 0) return { kind: "wait", until: Math.min(event.readyAt, now + this.transcriptPollMs) };
        break;
      }
      chosen.push({ event, message });
    }
    const first = chosen[0];
    if (first === undefined) return { kind: "wait", until: now + this.transcriptPollMs };
    const deadline = first.event.createdAt + this.giveUpMs;
    // Past the day, only the last attempt scheduled for its very end is still made.
    if (now >= deadline && (first.event.nextAttemptAt === null || first.event.nextAttemptAt < deadline)) {
      const error = first.event.lastError ?? "not posted";
      return {
        kind: "fail",
        seq: first.event.seq,
        status: first.event.lastStatus,
        error: `${error}; gave up 24 h after the event`,
        log: `gave up on ${first.event.kind} after ${first.event.attempts} attempts: ${error}`,
      };
    }
    if (first.event.nextAttemptAt !== null && first.event.nextAttemptAt > now) {
      return { kind: "wait", until: first.event.nextAttemptAt };
    }
    if (coalesce !== null && !closed) {
      const newest = batch[batch.length - 1]!.createdAt;
      const deliverAt = Math.min(batch[0]!.createdAt + coalesce.capMs, newest + coalesce.windowMs);
      if (now < deliverAt) return { kind: "wait", until: deliverAt };
    }
    return {
      kind: "ready",
      events: chosen.map((row) => row.event),
      messages: chosen.map((row) => row.message),
    };
  }

  private payloadFor(events: EventRecord[], messages: StoredMessage[]): WebhookPayload {
    if (events.length === 1) return this.host.payload(events[0]!, messages[0] ?? null);
    return coalescePayloads(events.map((event, index) => this.host.payload(event, messages[index] ?? null)));
  }

  private async post({ events, payload, settings }: Extract<Step, { kind: "post" }>): Promise<void> {
    const result = await this.host.sink().attempt(payload, settings);
    const db = this.host.db();
    // Stays `sending`: another dispatcher posts it again once the claim is stale.
    if (db === null || !db.isOpen) return;
    const now = this.now();
    const head = events[0]!;
    const deadline = head.createdAt + this.giveUpMs;
    if (result.ok) {
      db.transaction(() => {
        for (const event of events) db.events.delivered(event.seq, result.status, now, event.attempts + 1);
      });
      this.noteDelivery();
      // The receiver answers again: what waits for a retry need not wait for its slot.
      this.nudged = true;
      return;
    }
    // One next attempt for the whole body, so a retry cannot post half of it early.
    const next = Math.min(now + retryDelay(head.attempts + 1, this.retryDelays, this.retryEveryMs), deadline);
    const giveUp = !result.retry || now >= deadline;
    const failure = result.retry && giveUp ? `${result.error}; gave up 24 h after the event` : result.error;
    db.transaction(() => {
      for (const event of events) {
        const attempt = event.attempts + 1;
        if (giveUp) db.events.fail(event.seq, result.status, failure, now, attempt);
        else db.events.retry(event.seq, next, result.status, result.error, now, attempt);
      }
    });
    this.noteFailure(result.error);
  }

  /**
   * A receiver that refused every event once logged a line per event,
   * thousands of them. A run logs its first failure, any change of error and a
   * count every LOG_EVERY failures; noteDelivery says when it ends.
   */
  private noteFailure(error: string): void {
    const failures = ++this.failures;
    if (error !== this.loggedFailure) logError("webhook", error);
    else if (failures % LOG_EVERY === 0) logError("webhook", `${error} (${failures} failures in a row)`);
    this.loggedFailure = error;
  }

  private noteDelivery(): void {
    if (this.failures > 0) log(`webhook delivered again after ${this.failures} failures`);
    this.failures = 0;
    this.loggedFailure = null;
  }

  private arm(at: number): void {
    if (this.stopped) return;
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, Math.max(0, at - this.now()));
    this.timer.unref();
  }

  private disarm(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private prune(): void {
    this.pruning = this.pruning.then(async () => {
      // A prune stop() found under way finishes; stop waits for it.
      const db = this.host.db();
      if (db === null || !db.isOpen) return;
      const now = this.now();
      try {
        await db.events.prune(now - this.keepDeliveredMs, now - this.keepClosedMs);
      } catch (err) {
        if (!this.stopped) logError("webhook", `could not prune the outbox${withCode(err)}`);
      }
    });
  }
}

/**
 * The events posted as one body. A burst that has not been attempted yet is
 * every not-yet-attempted event from the head on. One that has is every
 * already-attempted event from the head on, and stops where a newer message
 * is still waiting for its own window.
 */
function batchOf(lane: readonly EventRecord[], head: EventRecord, group: boolean): EventRecord[] {
  if (!group) return [head];
  const closed = head.attempts > 0 || head.state === "sending";
  const out: EventRecord[] = [];
  for (const event of lane) {
    if (event.seq < head.seq) continue;
    const fresh = event.attempts === 0 && event.state !== "sending";
    if (closed ? fresh : !fresh) break;
    out.push(event);
  }
  return out.length > 0 ? out : [head];
}

function iso(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}

/** The status block's counters from the outbox's rows; `drops` are what only the posting process knows. */
export function deliveryOf(
  stats: EventStats | null,
  drops: { count: number; at: number | null } = { count: 0, at: null }
): WebhookDelivery {
  return {
    delivered: stats?.delivered ?? 0,
    failed: stats?.failed ?? 0,
    cancelled: stats?.cancelled ?? 0,
    pending: stats?.pending ?? 0,
    dropped: drops.count,
    consecutive_failures: stats?.consecutiveFailures ?? 0,
    retrying: stats?.oldestPendingFailures ?? 0,
    last_success_at: iso(stats?.lastSuccessAt ?? null),
    last_failure_at: iso(stats?.lastFailureAt ?? null),
    last_failure: stats?.lastFailure ?? null,
    last_status: stats?.lastFailureStatus ?? null,
    last_dropped_at: iso(drops.at),
    oldest_pending_at: iso(stats?.oldestPendingAt ?? null),
  };
}

/** The failure a delivery has not cleared since: what `webhook.last_error` says. */
export function undeliveredFailure(delivery: WebhookDelivery): string | null {
  const { last_failure: failure, last_failure_at: failedAt, last_success_at: deliveredAt } = delivery;
  if (failure === null || failedAt === null) return null;
  return deliveredAt === null || Date.parse(failedAt) > Date.parse(deliveredAt) ? failure : null;
}

/**
 * What an account's outbox says, read through a connection of its own:
 * read-only while a server holds the database, immutable otherwise, so a
 * status leaves nothing beside a closed file. Null when the database is not
 * there or not readable yet, or holds no event.
 */
export function readWebhookDelivery(databaseFile: string): WebhookDelivery | null {
  let db: AccountDb | null = null;
  try {
    db = openForReading(databaseFile);
    const stats = db.events.stats();
    if (stats.delivered + stats.failed + stats.cancelled + stats.pending === 0) return null;
    return deliveryOf(stats);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
