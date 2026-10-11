/**
 * Scheduled messages and reminders as rows (v6 `scheduled`, `reminders`): the
 * storage half of src/schedule.ts, which decides when a row is due and what
 * becomes of it. Every move names the state it expects, so a stale writer
 * changes nothing and two passes over one row never both take it.
 *
 *   scheduled:  pending ──begin──▶ sending ──finish──▶ sent | unknown | failed
 *                  ▲                  │
 *                  └─────retry────────┘
 *               pending ──miss──▶ missed     pending ──cancel──▶ cancelled
 *
 *   reminders:  pending ──close──▶ fired | skipped     pending ──cancel──▶ cancelled
 *
 * begin makes the send row the scheduled message goes out under, in the same
 * transaction that marks it sending, so a crash leaves a row whose send record
 * says how far it got (settleInterrupted reads it). A scheduled row's words go
 * once it is sent; closed rows of either table are kept a week, then swept.
 */
import type { Connection } from "./connection.js";
import { StorageError } from "./errors.js";
import { STORED_SEQ_TOP } from "./messages.js";
import type { SQLInputValue } from "./sqlite.js";

export type ScheduledState = "pending" | "sending" | "sent" | "unknown" | "failed" | "missed" | "cancelled";
export type ReminderState = "pending" | "fired" | "skipped" | "cancelled";
export type ReminderCondition = "always" | "no_reply";

/**
 * How far before a reminder was set a message may have been sent and still
 * count as its reply when it reached the account after: a phone whose clock
 * runs behind, or a reply delivered late. Older ones a history sync files are not replies.
 */
export const REPLY_CLOCK_SKEW_MS = 10 * 60_000;

/** How long a closed scheduled message or reminder stays listed. */
export const SCHEDULE_KEEP_CLOSED_MS = 7 * 86_400_000;

export interface ScheduledRecord {
  id: string;
  /** The draft confirm_send scheduled. */
  draftId: string;
  /** The identity that confirmed it; kept for the record, never a key to it. */
  owner: string | null;
  chatJid: string;
  kind: string;
  /** The frozen draft, JSON; '{}' once sent, or once an account that keeps no history forgot it. */
  payload: string;
  keyId: string;
  sendAt: number;
  timeZone: string | null;
  state: ScheduledState;
  /** The send row it went out under, from its first attempt on. */
  sendId: string | null;
  messageId: string | null;
  errorCode: string | null;
  error: string | null;
  attempts: number;
  nextAttemptAt: number | null;
  reportedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReminderRecord {
  id: string;
  owner: string | null;
  chatJid: string;
  note: string;
  condition: ReminderCondition;
  dueAt: number;
  timeZone: string | null;
  sinceSeq: number;
  sinceTs: number;
  state: ReminderState;
  outcome: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewScheduled {
  id: string;
  draftId: string;
  owner: string | null;
  sendAt: number;
  timeZone: string | null;
  now: number;
}

export interface NewReminder {
  id: string;
  owner: string | null;
  chatJid: string;
  note: string;
  condition: ReminderCondition;
  dueAt: number;
  timeZone: string | null;
  now: number;
}

/** What begin writes beside the scheduled row: the draft its send confirms. */
export interface ScheduledSendRow {
  draftId: string;
  owner: string;
  expiresAt: number;
}

interface ScheduledRow {
  id: string;
  draft_id: string;
  owner: string | null;
  chat_jid: string;
  kind: string;
  payload: string;
  key_id: string;
  send_at: number;
  time_zone: string | null;
  state: ScheduledState;
  send_id: string | null;
  message_id: string | null;
  error_code: string | null;
  error: string | null;
  attempts: number;
  next_attempt_at: number | null;
  reported_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ReminderRow {
  id: string;
  owner: string | null;
  chat_jid: string;
  note: string;
  condition: ReminderCondition;
  due_at: number;
  time_zone: string | null;
  since_seq: number;
  since_ts: number;
  state: ReminderState;
  outcome: string | null;
  created_at: number;
  updated_at: number;
}

const SCHEDULED_COLUMNS =
  "id, draft_id, owner, chat_jid, kind, payload, key_id, send_at, time_zone, state, send_id, message_id, error_code, error, attempts, next_attempt_at, reported_at, created_at, updated_at";
const REMINDER_COLUMNS =
  "id, owner, chat_jid, note, condition, due_at, time_zone, since_seq, since_ts, state, outcome, created_at, updated_at";

/** Terminal states: nothing moves a row out of them. */
const SCHEDULED_CLOSED = "state IN ('sent', 'unknown', 'failed', 'missed', 'cancelled')";

function scheduledOf(row: ScheduledRow): ScheduledRecord {
  return {
    id: row.id,
    draftId: row.draft_id,
    owner: row.owner,
    chatJid: row.chat_jid,
    kind: row.kind,
    payload: row.payload,
    keyId: row.key_id,
    sendAt: row.send_at,
    timeZone: row.time_zone,
    state: row.state,
    sendId: row.send_id,
    messageId: row.message_id,
    errorCode: row.error_code,
    error: row.error,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    reportedAt: row.reported_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function reminderOf(row: ReminderRow): ReminderRecord {
  return {
    id: row.id,
    owner: row.owner,
    chatJid: row.chat_jid,
    note: row.note,
    condition: row.condition,
    dueAt: row.due_at,
    timeZone: row.time_zone,
    sinceSeq: row.since_seq,
    sinceTs: row.since_ts,
    state: row.state,
    outcome: row.outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cap(limit: number): number {
  return Math.max(1, Math.floor(limit));
}

export class Schedule {
  constructor(private readonly c: Connection) {}

  // ---- scheduled messages ------------------------------------------------

  /**
   * Turns the owner's live draft into a pending scheduled message, in one
   * transaction: the draft row goes, the scheduled row takes its frozen payload
   * and key. Null when the draft is not the owner's, not a draft any more, or
   * has lapsed: nothing changed, and the caller answers as a confirm would.
   * Refuses (SCHEDULE_FULL) when the account already holds `max` pending ones.
   */
  adopt(input: NewScheduled, max: number): ScheduledRecord | null {
    return this.c.write(() => {
      const draft = this.c.get<{ chat_jid: string; kind: string; payload: string; key_id: string }>(
        "SELECT chat_jid, kind, payload, key_id FROM sends WHERE draft_id = ? AND owner IS ? AND state = 'draft' AND expires_at > ?",
        input.draftId,
        input.owner,
        input.now
      );
      if (draft === undefined) return null;
      if (this.pendingCount() >= max) {
        throw new StorageError("SCHEDULE_FULL", `The account already holds ${max} scheduled messages waiting to be sent.`);
      }
      this.c.run("DELETE FROM sends WHERE draft_id = ? AND state = 'draft'", input.draftId);
      this.c.run(
        `INSERT INTO scheduled(${SCHEDULED_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, 0, NULL, NULL, ?, ?)`,
        input.id,
        input.draftId,
        input.owner,
        draft.chat_jid,
        draft.kind,
        draft.payload,
        draft.key_id,
        input.sendAt,
        input.timeZone,
        input.now,
        input.now
      );
      return this.scheduled(input.id);
    });
  }

  scheduled(id: string): ScheduledRecord | null {
    const row = this.c.get<ScheduledRow>(`SELECT ${SCHEDULED_COLUMNS} FROM scheduled WHERE id = ?`, id);
    return row === undefined ? null : scheduledOf(row);
  }

  /** The scheduled message a draft became, if it became one. */
  scheduledByDraft(draftId: string): ScheduledRecord | null {
    const row = this.c.get<ScheduledRow>(`SELECT ${SCHEDULED_COLUMNS} FROM scheduled WHERE draft_id = ?`, draftId);
    return row === undefined ? null : scheduledOf(row);
  }

  pendingCount(): number {
    return this.c.get<{ n: number }>("SELECT count(*) AS n FROM scheduled WHERE state IN ('pending', 'sending')")!.n;
  }

  /** Pending rows whose time has come and whose retry, if any, is due; the earliest first. */
  due(now: number, limit: number): ScheduledRecord[] {
    return this.c
      .all<ScheduledRow>(
        `SELECT ${SCHEDULED_COLUMNS} FROM scheduled INDEXED BY scheduled_due
         WHERE state = 'pending' AND send_at <= ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY send_at, id LIMIT ?`,
        now,
        now,
        cap(limit)
      )
      .map(scheduledOf);
  }

  /** Rows a stop or a crash left sending. */
  sending(limit: number): ScheduledRecord[] {
    return this.c
      .all<ScheduledRow>(`SELECT ${SCHEDULED_COLUMNS} FROM scheduled WHERE state = 'sending' ORDER BY send_at, id LIMIT ?`, cap(limit))
      .map(scheduledOf);
  }

  /** When the next pending row may go, or null when none waits. */
  nextScheduledAt(): number | null {
    return (
      this.c.get<{ at: number | null }>(
        "SELECT min(max(send_at, coalesce(next_attempt_at, 0))) AS at FROM scheduled INDEXED BY scheduled_due WHERE state = 'pending'"
      )?.at ?? null
    );
  }

  /**
   * pending → sending, with the draft its send confirms written beside it in
   * the same transaction. False when the row is no longer pending (cancelled
   * meanwhile): nothing was written.
   */
  begin(id: string, send: ScheduledSendRow, now: number): boolean {
    return this.c.write(() => {
      const changed = this.c.run(
        "UPDATE scheduled SET state = 'sending', send_id = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
        send.draftId,
        now,
        id
      );
      if (changed !== 1) return false;
      this.c.run(
        `INSERT INTO sends(draft_id, owner, chat_jid, kind, payload, key_id, state, receipt, error_code, created_at, expires_at, updated_at)
         SELECT ?, ?, chat_jid, kind, payload, key_id, 'draft', NULL, NULL, ?, ?, ? FROM scheduled WHERE id = ?`,
        send.draftId,
        send.owner,
        now,
        send.expiresAt,
        now,
        id
      );
      return true;
    });
  }

  /**
   * sending → pending again, due no sooner than `nextAt`: the attempt failed
   * before its key reached WhatsApp. The draft it made goes with it, so the
   * key is free for the next attempt. `counts` adds it to attempts; a wait
   * for the link or the rate limit does not.
   */
  retry(id: string, sendId: string | null, nextAt: number, errorCode: string, error: string, now: number, counts = true): boolean {
    return this.c.write(() => {
      const row = this.scheduled(id);
      // The attempt named, still sending: a late answer from an attempt another one took over changes nothing.
      if (row === null || row.state !== "sending" || row.sendId !== sendId) return false;
      if (row.sendId !== null) this.c.run("DELETE FROM sends WHERE draft_id = ? AND state = 'draft'", row.sendId);
      return (
        this.c.run(
          `UPDATE scheduled SET state = 'pending', next_attempt_at = ?, error_code = ?, error = ?, updated_at = ?, attempts = attempts + ?
           WHERE id = ? AND state = 'sending' AND send_id IS ?`,
          nextAt,
          errorCode,
          error,
          now,
          counts ? 1 : 0,
          id,
          sendId
        ) === 1
      );
    });
  }

  /**
   * sending → sent, unknown or failed, for good. A sent row's words go: the
   * message itself is in the chat. A failed attempt's draft goes too: it never
   * left, and nothing confirms it again.
   */
  finish(
    id: string,
    sendId: string | null,
    state: "sent" | "unknown" | "failed",
    fields: { messageId?: string | null; errorCode?: string | null; error?: string | null },
    now: number
  ): boolean {
    return this.c.write(() => {
      const row = this.scheduled(id);
      if (row === null || row.state !== "sending" || row.sendId !== sendId) return false;
      if (state === "failed" && row.sendId !== null) this.c.run("DELETE FROM sends WHERE draft_id = ? AND state = 'draft'", row.sendId);
      return (
        this.c.run(
          `UPDATE scheduled SET state = ?, message_id = ?, error_code = ?, error = ?, next_attempt_at = NULL, attempts = attempts + 1,
             payload = CASE WHEN ? = 'sent' THEN '{}' ELSE payload END, updated_at = ?
           WHERE id = ? AND state = 'sending' AND send_id IS ?`,
          state,
          fields.messageId ?? null,
          fields.errorCode ?? null,
          fields.error ?? null,
          state,
          now,
          id,
          sendId
        ) === 1
      );
    });
  }

  /** A pending row waits until `nextAt` without an attempt (the link is down): why, for the list. */
  postpone(id: string, nextAt: number, errorCode: string, error: string, now: number): boolean {
    return (
      this.change(
        "UPDATE scheduled SET next_attempt_at = ?, error_code = ?, error = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
        nextAt,
        errorCode,
        error,
        now,
        id
      ) === 1
    );
  }

  /** Rows whose send's outcome is unknown and whose send record WhatsApp's echo has since settled as sent, oldest first. */
  unknownScheduled(limit: number): ScheduledRecord[] {
    return this.c
      .all<ScheduledRow>(
        `SELECT ${SCHEDULED_COLUMNS.split(", ").map((column) => `s.${column}`).join(", ")}
         FROM scheduled s INDEXED BY scheduled_state JOIN sends d ON d.draft_id = s.send_id
         WHERE s.state = 'unknown' AND d.state = 'sent' ORDER BY s.updated_at, s.id LIMIT ?`,
        cap(limit)
      )
      .map(scheduledOf);
  }

  /** unknown → sent: WhatsApp echoed its key. Its outcome is told again. */
  settleUnknown(id: string, messageId: string, now: number): boolean {
    return (
      this.change(
        `UPDATE scheduled SET state = 'sent', message_id = ?, error_code = NULL, error = NULL, payload = '{}', reported_at = NULL, updated_at = ?
         WHERE id = ? AND state = 'unknown'`,
        messageId,
        now,
        id
      ) === 1
    );
  }

  /** pending → missed or failed: it will not be sent, and why. */
  close(id: string, state: "missed" | "failed", errorCode: string, error: string, now: number): boolean {
    return (
      this.change(
        `UPDATE scheduled SET state = ?, error_code = ?, error = ?, next_attempt_at = NULL, updated_at = ?
         WHERE id = ? AND state = 'pending'`,
        state,
        errorCode,
        error,
        now,
        id
      ) === 1
    );
  }

  /** pending → cancelled. False when it is already under way or closed. */
  cancelScheduled(id: string, now: number): boolean {
    return this.change("UPDATE scheduled SET state = 'cancelled', next_attempt_at = NULL, updated_at = ? WHERE id = ? AND state = 'pending'", now, id) === 1;
  }

  /** Closed rows whose outcome no webhook event has told yet, oldest first. */
  unreported(limit: number): ScheduledRecord[] {
    return this.c
      .all<ScheduledRow>(
        `SELECT ${SCHEDULED_COLUMNS} FROM scheduled WHERE reported_at IS NULL AND state IN ('sent', 'unknown', 'failed', 'missed')
         ORDER BY updated_at, id LIMIT ?`,
        cap(limit)
      )
      .map(scheduledOf);
  }

  markReported(id: string, now: number): void {
    this.change("UPDATE scheduled SET reported_at = ? WHERE id = ? AND reported_at IS NULL", now, id);
  }

  /** Pending and sending rows, the soonest first, then closed ones, the latest change first. */
  listScheduled(includeClosed: boolean, limit: number): ScheduledRecord[] {
    const open = this.c
      .all<ScheduledRow>(
        `SELECT ${SCHEDULED_COLUMNS} FROM scheduled WHERE state IN ('pending', 'sending') ORDER BY send_at, id LIMIT ?`,
        cap(limit)
      )
      .map(scheduledOf);
    if (!includeClosed || open.length >= limit) return open;
    const closed = this.c
      .all<ScheduledRow>(
        `SELECT ${SCHEDULED_COLUMNS} FROM scheduled WHERE ${SCHEDULED_CLOSED} ORDER BY updated_at DESC, id LIMIT ?`,
        cap(limit - open.length)
      )
      .map(scheduledOf);
    return [...open, ...closed];
  }

  // ---- reminders -----------------------------------------------------------

  /** Stores a reminder, its no-reply mark taken now: the newest stored message and the time. */
  addReminder(input: NewReminder, max: number): ReminderRecord {
    return this.c.write(() => {
      const held = this.c.get<{ n: number }>("SELECT count(*) AS n FROM reminders WHERE state = 'pending'")!.n;
      if (held >= max) throw new StorageError("SCHEDULE_FULL", `The account already holds ${max} pending reminders.`);
      const seq = this.c.get<{ seq: number }>(`SELECT ${STORED_SEQ_TOP} AS seq`)!.seq;
      this.c.run(
        `INSERT INTO reminders(${REMINDER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
        input.id,
        input.owner,
        input.chatJid,
        input.note,
        input.condition,
        input.dueAt,
        input.timeZone,
        seq,
        input.now,
        input.now,
        input.now
      );
      return this.reminder(input.id)!;
    });
  }

  reminder(id: string): ReminderRecord | null {
    const row = this.c.get<ReminderRow>(`SELECT ${REMINDER_COLUMNS} FROM reminders WHERE id = ?`, id);
    return row === undefined ? null : reminderOf(row);
  }

  dueReminders(now: number, limit: number): ReminderRecord[] {
    return this.c
      .all<ReminderRow>(
        `SELECT ${REMINDER_COLUMNS} FROM reminders INDEXED BY reminders_due WHERE state = 'pending' AND due_at <= ?
         ORDER BY due_at, id LIMIT ?`,
        now,
        cap(limit)
      )
      .map(reminderOf);
  }

  nextReminderAt(): number | null {
    return this.c.get<{ at: number | null }>("SELECT min(due_at) AS at FROM reminders INDEXED BY reminders_due WHERE state = 'pending'")?.at ?? null;
  }

  /**
   * Whether someone other than the account wrote in the reminder's chat after
   * it was made: a message stored since its mark, sent no earlier than
   * REPLY_CLOCK_SKEW_MS before it was made, not a system notice. The chat is its jid's row, and every row folding into it or
   * that it folds into, so a lid chat merging with its number still counts.
   */
  repliedSince(reminder: Pick<ReminderRecord, "chatJid" | "sinceSeq" | "sinceTs">): boolean {
    return (
      this.c.get(
        `WITH target(id) AS (SELECT id FROM chats WHERE jid = ?),
         family(id) AS (
           SELECT id FROM target
           UNION SELECT merged_into FROM chats WHERE id IN (SELECT id FROM target) AND merged_into IS NOT NULL
           UNION SELECT id FROM chats WHERE merged_into IN (SELECT id FROM target)
         )
         SELECT 1 FROM messages INDEXED BY messages_stored
         WHERE stored_seq > ? AND chat_id IN (SELECT id FROM family) AND from_me = 0 AND type <> 'system' AND ts >= ?
         LIMIT 1`,
        reminder.chatJid,
        reminder.sinceSeq,
        reminder.sinceTs - REPLY_CLOCK_SKEW_MS
      ) !== undefined
    );
  }

  /**
   * Pending no-reply reminders whose chat already holds a reply are skipped
   * now: what an account that keeps no history does before it purges the
   * messages that reply lives in. How many were.
   */
  settleReplied(now: number): number {
    let skipped = 0;
    for (const reminder of this.c
      .all<ReminderRow>(`SELECT ${REMINDER_COLUMNS} FROM reminders WHERE state = 'pending' AND condition = 'no_reply'`)
      .map(reminderOf)) {
      if (this.repliedSince(reminder) && this.closeReminder(reminder.id, "skipped", "replied", now)) skipped++;
    }
    return skipped;
  }

  /** pending → fired or skipped, with what became of it. */
  closeReminder(id: string, state: "fired" | "skipped", outcome: string, now: number): boolean {
    return (
      this.change("UPDATE reminders SET state = ?, outcome = ?, updated_at = ? WHERE id = ? AND state = 'pending'", state, outcome, now, id) === 1
    );
  }

  cancelReminder(id: string, now: number): boolean {
    return this.change("UPDATE reminders SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'pending'", now, id) === 1;
  }

  /** Pending reminders, the soonest first, then closed ones, the latest change first. */
  listReminders(includeClosed: boolean, limit: number): ReminderRecord[] {
    const open = this.c
      .all<ReminderRow>(`SELECT ${REMINDER_COLUMNS} FROM reminders WHERE state = 'pending' ORDER BY due_at, id LIMIT ?`, cap(limit))
      .map(reminderOf);
    if (!includeClosed || open.length >= limit) return open;
    const closed = this.c
      .all<ReminderRow>(
        `SELECT ${REMINDER_COLUMNS} FROM reminders WHERE state <> 'pending' ORDER BY updated_at DESC, id LIMIT ?`,
        cap(limit - open.length)
      )
      .map(reminderOf);
    return [...open, ...closed];
  }

  // ---- both ----------------------------------------------------------------

  /** Closed rows of both tables older than SCHEDULE_KEEP_CLOSED_MS, up to `limit` each. */
  sweep(now: number, limit: number): number {
    const before = now - SCHEDULE_KEEP_CLOSED_MS;
    return this.c.write(
      () =>
        this.c.run(
          `DELETE FROM scheduled WHERE id IN (SELECT id FROM scheduled WHERE ${SCHEDULED_CLOSED} AND updated_at <= ? ORDER BY updated_at LIMIT ?)`,
          before,
          cap(limit)
        ) +
        this.c.run(
          `DELETE FROM reminders WHERE id IN (SELECT id FROM reminders WHERE state <> 'pending' AND updated_at <= ? ORDER BY updated_at LIMIT ?)`,
          before,
          cap(limit)
        )
    );
  }

  /**
   * What an account that keeps no history forgets between runs: the words of
   * every closed scheduled message. A pending one keeps its own, or it could
   * not be sent; reminders are the user's notes, which such an account keeps.
   */
  forgetWords(): void {
    this.change(`UPDATE scheduled SET payload = '{}' WHERE ${SCHEDULED_CLOSED} AND payload <> '{}'`);
  }

  private change(sql: string, ...params: SQLInputValue[]): number {
    return this.c.write(() => this.c.run(sql, ...params));
  }
}
