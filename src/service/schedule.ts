/**
 * Scheduled messages and reminders, for one account: what makes them, lists
 * and cancels them, and the timer that sends or fires each when its time
 * comes. Part of WhatsAppService (src/whatsapp.ts), which lends it the
 * database, the link, the webhook and the one confirm every send passes.
 *
 * A scheduled message is a draft the user said yes to for a later time. When
 * that time comes it goes out through the same confirm as any draft, under
 * the key it was drafted with, so every guard of a send runs at that moment:
 * the account's record on disk (enabled, writes on), the server's read-only
 * switch, the send rules, the link and WhatsApp's own restrictions, and the
 * account's write rate. A refusal that no retry fixes closes it as failed; a
 * passing one (the link is down, the rate limit) waits and tries again, until
 * SCHEDULE_GRACE_MS after its time. Past that it is missed: never sent late,
 * never in a burst after a restart, and told to the webhook (`scheduled`),
 * get_status's hint and the list.
 *
 * Only a service the hub runs has a scheduler (enable): a CLI command that
 * opens the account for a moment never sends anything on its own.
 */

import { randomUUID } from "node:crypto";
import type { AccountRecord } from "../accounts.js";
import {
  StorageError,
  type AccountDb,
  type ReminderRecord,
  type ScheduledRecord,
} from "../db/index.js";
import { DRAFT_TTL_MS, type FrozenDraft } from "../drafts.js";
import { asWazapError, WazapError } from "../errors.js";
import { log, logError } from "../logger.js";
import { isoWithOffset } from "../messages.js";
import { describeInstant, serverTimeZone } from "../schedule-time.js";
import { assertSendable, sendPolicyOf } from "../send-guard.js";
import type { WebhookReminderPayload, WebhookScheduledPayload, WebhookSink } from "../webhook.js";
import type { WebhookOutbox } from "../webhook-outbox.js";
import type {
  NewReminderInput,
  OutgoingTarget,
  ReminderView,
  ScheduledView,
  SentMessage,
} from "../wa-types.js";

/** How late a scheduled message may still go. After that it is missed, and told, never sent. */
export const SCHEDULE_GRACE_MS = 15 * 60_000;
/** The longest the timer sleeps, so a clock that jumps or a missed wake costs at most this. */
export const SCHEDULE_TICK_MAX_MS = 60_000;
/** A reminder that waits for no reply looks this long after the link is up, so what arrived while it was down is in. */
export const REMINDER_SETTLE_MS = 60_000;
/** Reminders one account may hold waiting. */
export const REMINDER_MAX_PENDING = 200;
/** Lanes of the webhook outbox these events wait in, apart from every chat's and the connection's. */
export const REMINDER_LANE = "reminders";
export const SCHEDULED_LANE = "scheduled";
/** Attempts a scheduled message gets before a passing failure closes it as failed; waits for the link or the rate limit do not count. */
const MAX_ATTEMPTS = 10;
/** Refusals that are a wait, not a failure of the message: only the grace window limits them. */
const WAITS: ReadonlySet<string> = new Set(["NOT_CONNECTED", "RATE_LIMITED"]);
const SWEEP_EVERY_MS = 3_600_000;
/** How soon the timer looks again at something overdue that a pass left waiting (a no-reply reminder while the link is down). */
const HELD_RETRY_MS = 15_000;
const BATCH = 20;

/** Refusals that may pass on their own: the message waits and tries again, within the grace window. */
const PASSING: ReadonlySet<string> = new Set([
  "NOT_CONNECTED",
  "RATE_LIMITED",
  "TIMEOUT",
  "SYNC_IN_PROGRESS",
  "ACCOUNT_RESTRICTED",
  "SERVICE_ERROR",
  "URL_FETCH_FAILED",
  "WHATSAPP_ERROR",
]);

/** What the service lends the scheduler, read at each call. */
export interface ScheduleHost {
  readyDb(): AccountDb | null;
  db(): AccountDb;
  stopped(): boolean;
  guarded<T>(work: () => Promise<T>): Promise<T>;
  /** Whether the link is up, and since when. */
  connectedSince(): number | null;
  /** The server-wide or account read-only switch as this run started with it. */
  readOnly(): boolean;
  /** The one confirm every send passes, for a draft made for later; nothing leaves after `notAfter` (epoch ms). */
  confirm(draftId: string, owner: string, notAfter: number): Promise<SentMessage>;
  /** The draft's yes: it becomes a scheduled message (AccountSends.scheduleDraft). */
  scheduleDraft(draftId: string, owner: string | undefined): Promise<{ record: ScheduledRecord; already: boolean }>;
  resolveId(chatId: string): string;
  displayName(jid: string): string;
  webhook(): WebhookSink;
  outbox(): WebhookOutbox;
}

export class AccountSchedule {
  /** accounts.json's record for the account, read when a message is due; null until the hub enables the scheduler. */
  private record: (() => AccountRecord | undefined) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private lastSweep = 0;

  constructor(
    private readonly host: ScheduleHost,
    private readonly account: Pick<AccountRecord, "id" | "name">,
    private readonly now: () => number = Date.now
  ) {}

  /** Runs the timer, with the record to check each send against. Only the hub's services call it. */
  enable(record: () => AccountRecord | undefined): void {
    this.record = record;
    this.kick();
  }

  get enabled(): boolean {
    return this.record !== null;
  }

  /** Look now: something was scheduled or cancelled, or the link came up. */
  kick(): void {
    if (this.record === null || this.host.stopped()) return;
    if (this.running !== null) {
      this.again = true;
      return;
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.running = this.pass()
      .catch((err: unknown) => logError("schedule", err))
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.kick();
        } else this.arm();
      });
  }

  /** Test barrier, not a tool: a pass now, and every pass it set off, finished. */
  async settle(): Promise<void> {
    this.kick();
    while (this.running !== null) await this.running;
  }

  /** The timer stops; a pass under way finishes first, so nothing is left half-written. */
  async stop(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.again = false;
    await this.running?.catch(() => {});
  }

  private arm(): void {
    if (this.record === null || this.host.stopped()) return;
    const now = this.now();
    let next = now + SCHEDULE_TICK_MAX_MS;
    try {
      const db = this.host.readyDb();
      if (db !== null) {
        for (const at of [db.schedule.nextScheduledAt(), db.schedule.nextReminderAt()]) {
          // Overdue and still there after a pass: it is held (a reminder waiting for the link), so no busy loop.
          if (at !== null) next = Math.min(next, at <= now ? now + HELD_RETRY_MS : at);
        }
      }
    } catch {
      /* the next look finds out */
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, Math.max(1_000, next - now));
    this.timer.unref?.();
  }

  // ---- one pass ---------------------------------------------------------------

  private async pass(): Promise<void> {
    const db = this.host.readyDb();
    if (db === null || this.host.stopped()) return;
    // Passes run one at a time, so a row sending as one starts is one a stop, a crash or a failed write left.
    this.recover(db);
    await this.fireReminders(db);
    const due = db.schedule.due(this.now(), BATCH);
    for (const row of due) {
      if (this.host.stopped() || !db.isOpen) return;
      try {
        await this.sendDue(db, row);
      } catch (err) {
        // One row the database refuses must not hold up the others, or the missed and reported ones behind them.
        logError(`schedule ${row.id}`, err);
        this.write(db, () => db.schedule.close(row.id, "failed", "SERVICE_ERROR", "wazap could not record or start this attempt: check the chat before scheduling it again.", this.now()));
      }
    }
    // A full batch may have left more behind: look again at once, but only if this one moved something,
    // or a write that keeps failing would spin.
    if (due.length === BATCH && db.isOpen) {
      const before = due.map((row) => `${row.id}:${row.updatedAt}`).join();
      const after = db.schedule.due(this.now(), BATCH).map((row) => `${row.id}:${row.updatedAt}`).join();
      if (after !== before) this.again = true;
    }
    if (!db.isOpen) return;
    // Each on its own: one failing must not keep the others from running.
    this.write(db, () => this.closeMissed(db));
    this.write(db, () => this.settleEchoed(db));
    this.write(db, () => this.report(db));
    if (this.now() - this.lastSweep >= SWEEP_EVERY_MS) {
      this.lastSweep = this.now();
      this.write(db, () => db.schedule.sweep(this.now(), 200));
    }
  }

  /**
   * What a stop or a crash left sending is settled from the send row it made:
   * sent or unknown when the key may have left, pending again when it never
   * did. Never sent again by this: a pending row goes through the grace rule.
   */
  private recover(db: AccountDb): void {
    let rows: ScheduledRecord[];
    try {
      rows = db.schedule.sending(500);
    } catch (err) {
      logError("schedule recovery", err);
      return;
    }
    for (const row of rows) {
      try {
        const now = this.now();
        const send = row.sendId === null ? null : db.sends.get(row.sendId);
        if (send === null) {
          // Within the window a send that left still has its row (kept a day once claimed): a missing one never left,
          // whatever sent_keys says of an earlier attempt that was claimed and given back. Later, sent_keys decides.
          if (now > row.sendAt + SCHEDULE_GRACE_MS && db.sends.wasSent(row.keyId)) db.schedule.finish(row.id, row.sendId, "unknown", { errorCode: "INTERRUPTED", error: "wazap stopped while it was sending" }, now);
          else db.schedule.retry(row.id, row.sendId, now, "INTERRUPTED", "wazap stopped before it was sent", now);
          continue;
        }
        switch (send.state) {
          case "draft":
            db.schedule.retry(row.id, row.sendId, now, "INTERRUPTED", "wazap stopped before it was sent", now);
            break;
          case "sent": {
            const receipt = JSON.parse(send.receipt ?? "{}") as Partial<SentMessage>;
            db.schedule.finish(row.id, row.sendId, "sent", { messageId: receipt.message_id ?? null }, now);
            break;
          }
          case "sending":
          case "unknown":
            db.schedule.finish(row.id, row.sendId, "unknown", { errorCode: "INTERRUPTED", error: "wazap stopped while it was sending" }, now);
            break;
        }
      } catch (err) {
        // One row's failure leaves the others to be settled; this one is looked at again next pass.
        logError(`schedule recovery ${row.id}`, err);
      }
    }
  }

  /** One due message: the guards, then the confirm, then what its outcome makes of the row. */
  private async sendDue(db: AccountDb, row: ScheduledRecord): Promise<void> {
    const now = this.now();
    if (now > row.sendAt + SCHEDULE_GRACE_MS) return; // closeMissed takes it
    let frozen: FrozenDraft;
    try {
      frozen = JSON.parse(row.payload) as FrozenDraft;
      if (frozen.to === undefined || frozen.payload === undefined) throw new Error("empty");
    } catch {
      db.schedule.close(row.id, "failed", "SERVICE_ERROR", "The scheduled message's stored draft is unreadable; nothing was sent.", now);
      return;
    }
    const refusal = this.refusal(frozen.to);
    if (refusal !== null) {
      db.schedule.close(row.id, "failed", refusal.code, refusal.message, now);
      log(`schedule ${this.account.id}: ${row.id} not sent: ${refusal.code}`);
      return;
    }
    if (this.host.connectedSince() === null) {
      db.schedule.postpone(row.id, now + 30_000, "NOT_CONNECTED", "The account was not connected when it was due.", now);
      return;
    }
    const sendId = `d_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const owner = `schedule:${row.id}`;
    if (!db.schedule.begin(row.id, { draftId: sendId, owner, expiresAt: now + DRAFT_TTL_MS }, now)) return;
    try {
      const sent = await this.host.confirm(sendId, owner, row.sendAt + SCHEDULE_GRACE_MS);
      this.write(db, () => db.schedule.finish(row.id, sendId, "sent", { messageId: sent.message_id }, this.now()));
      log(`schedule ${this.account.id}: ${row.id} sent`);
    } catch (err) {
      const failure = asWazapError(err);
      const at = this.now();
      if (failure.code === "SEND_OUTCOME_UNKNOWN") {
        this.write(db, () => db.schedule.finish(row.id, sendId, "unknown", { errorCode: failure.code, error: failure.message }, at));
        return;
      }
      const waiting = WAITS.has(failure.code);
      const retryAt = at + (waiting ? waitOf(failure) : Math.min(300_000, 30_000 * 2 ** row.attempts));
      const spent = !waiting && row.attempts + 1 >= MAX_ATTEMPTS;
      if (PASSING.has(failure.code) && !spent && retryAt <= row.sendAt + SCHEDULE_GRACE_MS) {
        this.write(db, () => db.schedule.retry(row.id, sendId, retryAt, failure.code, failure.message, at, !waiting));
        return;
      }
      if (PASSING.has(failure.code) && spent) {
        this.write(db, () =>
          db.schedule.finish(row.id, sendId, "failed", { errorCode: failure.code, error: `Gave up after ${MAX_ATTEMPTS} attempts: ${failure.message}` }, at)
        );
        return;
      }
      if (PASSING.has(failure.code)) {
        // The window ran out on a refusal that might have passed: missed, as a message the link never let go.
        this.write(db, () => {
          db.schedule.retry(row.id, sendId, at, failure.code, failure.message, at, !waiting);
          db.schedule.close(row.id, "missed", failure.code, `Not sent by ${SCHEDULE_GRACE_MS / 60_000} minutes after its time: ${failure.message}`, at);
        });
        return;
      }
      this.write(db, () => db.schedule.finish(row.id, sendId, "failed", { errorCode: failure.code, error: failure.message }, at));
      log(`schedule ${this.account.id}: ${row.id} failed: ${failure.code}`);
    }
  }

  /**
   * What refuses this send now, before it is attempted: the account's record
   * as accounts.json holds it at this moment (gone, disabled, writes off), the
   * read-only switch this run started with, and the send rules. Null: let the
   * confirm run its own guards.
   */
  private refusal(to: OutgoingTarget): WazapError | null {
    const record = this.record?.();
    if (record === undefined || !record.enabled) {
      return new WazapError("READ_ONLY", `Account "${this.account.id}" is missing or disabled, so its scheduled message was not sent.`);
    }
    if (record.writes === false || this.host.readOnly()) {
      return new WazapError("READ_ONLY", `Account "${this.account.id}" is read-only, so its scheduled message was not sent.`);
    }
    try {
      assertSendable(sendPolicyOf(record), to, this.account.id);
    } catch (err) {
      return asWazapError(err);
    }
    return null;
  }

  /** Pending rows past their grace window: missed, with the last reason they waited for. */
  private closeMissed(db: AccountDb): void {
    const now = this.now();
    for (const row of db.schedule.listScheduled(false, 500)) {
      if (row.state !== "pending" || now <= row.sendAt + SCHEDULE_GRACE_MS) continue;
      const why =
        row.error === null
          ? `wazap was not running when it was due, and ${SCHEDULE_GRACE_MS / 60_000} minutes later it was too late to send it`
          : `Not sent by ${SCHEDULE_GRACE_MS / 60_000} minutes after its time: ${row.error}`;
      if (db.schedule.close(row.id, "missed", row.errorCode ?? "NOT_RUNNING", why, now)) {
        log(`schedule ${this.account.id}: ${row.id} missed (${row.errorCode ?? "NOT_RUNNING"})`);
      }
    }
  }

  /** An unknown send WhatsApp has since echoed is sent. */
  private settleEchoed(db: AccountDb): void {
    for (const row of db.schedule.unknownScheduled(BATCH)) {
      const send = row.sendId === null ? null : db.sends.get(row.sendId);
      if (send?.state !== "sent") continue;
      const receipt = JSON.parse(send.receipt ?? "{}") as Partial<SentMessage>;
      if (typeof receipt.message_id === "string") db.schedule.settleUnknown(row.id, receipt.message_id, this.now());
    }
  }

  /**
   * Each closed outcome once: a `scheduled` event when the webhook posts it,
   * and only marked otherwise, so turning the event on later does not post a
   * backlog. A cancel is the user's own act and is not told.
   */
  private report(db: AccountDb): void {
    const settings = this.host.webhook().settings();
    const posting = settings.kind === "ready" && settings.events.includes("scheduled");
    let queued = false;
    for (const row of db.schedule.unreported(BATCH)) {
      const now = this.now();
      if (!posting) {
        db.schedule.markReported(row.id, now);
        continue;
      }
      const payload: WebhookScheduledPayload = {
        event: "scheduled",
        schedule_id: row.id,
        state: row.state as WebhookScheduledPayload["state"],
        chat_id: row.chatJid,
        chat_name: this.host.displayName(row.chatJid),
        send_at: new Date(row.sendAt).toISOString(),
        message_id: row.messageId,
        error_code: row.errorCode,
        error: row.error,
        timestamp: new Date(now).toISOString(),
        account_id: this.account.id,
        account_name: this.account.name,
      };
      try {
        db.transaction(() => {
          db.events.enqueue({ kind: "scheduled", lane: SCHEDULED_LANE, messageId: null, payload: JSON.stringify(payload), createdAt: now });
          db.schedule.markReported(row.id, now);
        });
        queued = true;
      } catch (err) {
        this.host.outbox().dropped(`scheduled ${row.id}`, err);
        break;
      }
    }
    if (queued) this.host.outbox().nudge();
  }

  /**
   * Due reminders: one waiting for no reply is skipped when someone wrote in
   * the chat since it was set, and holds while the link is down (or just came
   * up) so it does not fire on a reply still on its way. A due one is posted
   * as a `reminder` event when the webhook posts it, in the same transaction
   * that closes it; with the webhook off or the event not enabled it closes
   * as fired, saying so, and the list shows it.
   */
  private async fireReminders(db: AccountDb): Promise<void> {
    const now = this.now();
    const since = this.host.connectedSince();
    const settled = since !== null && now - since >= REMINDER_SETTLE_MS;
    const settings = this.host.webhook().settings();
    const posting = settings.kind === "ready" && settings.events.includes("reminder");
    let queued = false;
    // All of them: held no-reply ones must not keep the rest from firing.
    let due: ReminderRecord[];
    try {
      due = db.schedule.dueReminders(now, REMINDER_MAX_PENDING);
    } catch (err) {
      logError("reminders", err);
      return;
    }
    for (const reminder of due) {
      try {
        if (this.fireReminder(db, reminder, now, settled, posting, settings.kind === "ready")) queued = true;
      } catch (err) {
        // One reminder's failure must not hold up the others, or the scheduled messages after them.
        this.host.outbox().dropped(`reminder ${reminder.id}`, err);
      }
    }
    if (queued) this.host.outbox().nudge();
  }

  /** One due reminder: skipped, closed with no webhook, or posted. True when an event was queued. */
  private fireReminder(db: AccountDb, reminder: ReminderRecord, now: number, settled: boolean, posting: boolean, ready: boolean): boolean {
    if (reminder.condition === "no_reply") {
      if (!settled) return false;
      if (db.schedule.repliedSince(reminder)) {
        db.schedule.closeReminder(reminder.id, "skipped", "replied", now);
        return false;
      }
    }
    if (!posting) {
      db.schedule.closeReminder(reminder.id, "fired", ready ? "event_off" : "webhook_off", now);
      return false;
    }
    const payload: WebhookReminderPayload = {
      event: "reminder",
      reminder_id: reminder.id,
      chat_id: reminder.chatJid,
      chat_name: this.host.displayName(reminder.chatJid),
      note: reminder.note,
      condition: reminder.condition,
      due_at: new Date(reminder.dueAt).toISOString(),
      created_at: new Date(reminder.createdAt).toISOString(),
      timestamp: new Date(now).toISOString(),
      account_id: this.account.id,
      account_name: this.account.name,
    };
    return db.transaction(() => {
      if (!db.schedule.closeReminder(reminder.id, "fired", "posted", now)) return false;
      db.events.enqueue({ kind: "reminder", lane: REMINDER_LANE, messageId: null, payload: JSON.stringify(payload), createdAt: now });
      return true;
    });
  }

  /** A write after an await: the database may be closing under a stop; the row then settles at the next start. */
  private write(db: AccountDb, work: () => unknown): void {
    try {
      if (db.isOpen) work();
    } catch (err) {
      if (!this.host.stopped()) logError("schedule", err);
    }
  }

  // ---- what the tools call ----------------------------------------------------

  confirmSchedule(draftId: string, owner?: string): Promise<ScheduledView> {
    return this.host.guarded(async () => {
      const { record, already } = await this.host.scheduleDraft(draftId, owner);
      if (!already) this.kick();
      const view = this.scheduledView(record);
      if (already) view.already_scheduled = true;
      return view;
    });
  }

  listScheduled(includeClosed: boolean, limit: number): Promise<ScheduledView[]> {
    return this.host.guarded(async () => this.host.db().schedule.listScheduled(includeClosed, limit).map((row) => this.scheduledView(row)));
  }

  cancelScheduled(scheduleId: string): Promise<{ cancelled: boolean; scheduled: ScheduledView }> {
    return this.host.guarded(async () => {
      const db = this.host.db();
      const cancelled = db.schedule.cancelScheduled(scheduleId, this.now());
      const row = db.schedule.scheduled(scheduleId);
      if (row === null) throw notFound("scheduled message", scheduleId);
      if (cancelled) this.kick();
      return { cancelled, scheduled: this.scheduledView(row) };
    });
  }

  addReminder(input: NewReminderInput, owner?: string): Promise<ReminderView> {
    return this.host.guarded(async () => {
      const jid = this.host.resolveId(input.chatId);
      let record: ReminderRecord;
      try {
        record = this.host.db().schedule.addReminder(
          {
            id: `r_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
            owner: owner ?? null,
            chatJid: jid,
            note: input.note,
            condition: input.condition,
            dueAt: input.dueAt,
            timeZone: input.timeZone,
            now: this.now(),
          },
          REMINDER_MAX_PENDING
        );
      } catch (err) {
        if (err instanceof StorageError && err.code === "SCHEDULE_FULL") {
          throw new WazapError("SCHEDULE_FULL", err.message, "Tell the user; cancel reminders they no longer need");
        }
        throw err;
      }
      this.kick();
      return this.reminderView(record);
    });
  }

  listReminders(includeClosed: boolean, limit: number): Promise<ReminderView[]> {
    return this.host.guarded(async () => this.host.db().schedule.listReminders(includeClosed, limit).map((row) => this.reminderView(row)));
  }

  cancelReminder(reminderId: string): Promise<{ cancelled: boolean; reminder: ReminderView }> {
    return this.host.guarded(async () => {
      const db = this.host.db();
      const cancelled = db.schedule.cancelReminder(reminderId, this.now());
      const row = db.schedule.reminder(reminderId);
      if (row === null) throw notFound("reminder", reminderId);
      return { cancelled, reminder: this.reminderView(row) };
    });
  }

  /** get_status's line about outcomes the user should hear of: messages missed or failed this week. */
  statusHint(): string | null {
    try {
      const db = this.host.readyDb();
      if (db === null) return null;
      const closed = db.schedule.listScheduled(true, 200).filter((row) => row.state === "missed" || row.state === "failed" || row.state === "unknown");
      if (closed.length === 0) return null;
      const where = this.host.readOnly()
        ? "the account is read-only now, so scheduled_messages can list them once writes are on again and the server restarted"
        : "scheduled_messages lists them in a session that can write";
      return `${closed.length} scheduled message${closed.length === 1 ? " was" : "s were"} not sent as planned this week (missed, failed or unknown): ${where}; tell the user.`;
    } catch {
      return null;
    }
  }

  private scheduledView(row: ScheduledRecord): ScheduledView {
    let frozen: Partial<FrozenDraft> = {};
    try {
      frozen = JSON.parse(row.payload) as Partial<FrozenDraft>;
    } catch {
      /* shown without its words */
    }
    const zone = row.timeZone ?? serverTimeZone();
    const view: ScheduledView = {
      schedule_id: row.id,
      state: row.state,
      to: frozen.to ?? { chat_id: row.chatJid, name: this.host.displayName(row.chatJid) },
      kind: row.kind,
      preview: frozen.preview ?? "",
      send_at: describeInstant(row.sendAt, zone).iso,
      time_zone: zone,
      created_at: isoWithOffset(row.createdAt),
      attempts: row.attempts,
    };
    if (row.messageId !== null) view.message_id = row.messageId;
    if (row.errorCode !== null) view.error_code = row.errorCode;
    if (row.error !== null) view.error = row.error;
    return view;
  }

  private reminderView(row: ReminderRecord): ReminderView {
    const zone = row.timeZone ?? serverTimeZone();
    const view: ReminderView = {
      reminder_id: row.id,
      state: row.state,
      chat_id: row.chatJid,
      chat_name: this.host.displayName(row.chatJid),
      note: row.note,
      condition: row.condition,
      due_at: describeInstant(row.dueAt, zone).iso,
      time_zone: zone,
      created_at: isoWithOffset(row.createdAt),
    };
    if (row.outcome !== null) view.outcome = row.outcome;
    return view;
  }
}

/** How long a wait refusal asks for: the rate limiter's "Wait N seconds", or half a minute for the link. */
function waitOf(failure: WazapError): number {
  const seconds = Number(/Wait (\d+) seconds?/.exec(failure.fix ?? "")?.[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 30_000;
}

function notFound(what: string, id: string): WazapError {
  return new WazapError("SCHEDULE_NOT_FOUND", `No ${what} ${id} on this account.`, "List them again and use an id from the list");
}
