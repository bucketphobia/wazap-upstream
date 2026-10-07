/**
 * The webhook outbox as rows: what to post, in which order, and how each
 * attempt went. The dispatcher (src/webhook-outbox.ts) decides when to post
 * and what counts as fresh; this only moves an event between states, and every
 * move names the state it expects, so a stale writer changes nothing.
 *
 *   pending ──claim──▶ sending ──delivered──▶ delivered
 *      ▲                  │──fail──────────▶ failed
 *      └──────retry───────┘
 *   pending/sending ──cancel──▶ cancelled
 *
 * A `sending` row is a POST in flight, or one a crash interrupted. claim()
 * takes one over only once it is older than a POST can run, so two
 * dispatchers over one file (a service stopping while its successor starts)
 * never post one event at once; a receiver may still see an event twice after
 * a crash, but never loses one. The writes that record a POST's answer name
 * the attempt they answer, so a dispatcher that was overtaken changes nothing.
 *
 * Every event is in a lane — its chat, or the account's connection — and only
 * the oldest open event of each lane may be posted (laneHeads).
 */
import type { Connection } from "./connection.js";
import { StorageError } from "./errors.js";

/** Thrown inside a write so a partial batch claim rolls back and answers false. */
class ClaimMiss extends Error {}

export type EventState = "pending" | "sending" | "delivered" | "failed" | "cancelled";

export interface EventInput {
  kind: string;
  /** Events of one lane are posted in the order they were queued: `chat:<chat id>` or `connection`. */
  lane: string;
  /** The message a message event is about; null for an event about the account. */
  messageId: number | null;
  /** What the dispatcher cannot read back from the message row, as JSON. */
  payload: string;
  /** Epoch ms. */
  createdAt: number;
  /** Not posted before this, unless the dispatcher finds it ready sooner. Defaults to createdAt. */
  readyAt?: number;
}

export interface EventRecord {
  seq: number;
  kind: string;
  lane: string;
  messageId: number | null;
  payload: string;
  createdAt: number;
  readyAt: number;
  state: EventState;
  /** POSTs started, including the one in flight. */
  attempts: number;
  nextAttemptAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
  updatedAt: number;
}

/** What status and doctor report, read off the indexes. */
export interface EventStats {
  delivered: number;
  failed: number;
  cancelled: number;
  /** Waiting, retrying or in flight. */
  pending: number;
  /** Failed events since the last delivery. */
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  /** The most recent failed attempt, whether its event gave up or is still retrying. */
  lastFailureAt: number | null;
  lastFailure: string | null;
  lastFailureStatus: number | null;
  /** The oldest event not delivered, failed or cancelled yet: when it was created and how many POSTs it already failed. */
  oldestPendingAt: number | null;
  oldestPendingFailures: number;
}

interface EventRow {
  seq: number;
  kind: string;
  lane: string;
  message_id: number | null;
  payload: string;
  created_at: number;
  ready_at: number;
  state: EventState;
  attempts: number;
  next_attempt_at: number | null;
  last_status: number | null;
  last_error: string | null;
  updated_at: number;
}

const OPEN = "state IN ('pending', 'sending')";
/** The seq of the latest delivery, which pruning keeps. */
const LATEST_DELIVERY = "SELECT seq FROM events WHERE state = 'delivered' ORDER BY updated_at DESC, seq DESC LIMIT 1";

function eventFromRow(row: EventRow): EventRecord {
  return {
    seq: row.seq,
    kind: row.kind,
    lane: row.lane,
    messageId: row.message_id,
    payload: row.payload,
    createdAt: row.created_at,
    readyAt: row.ready_at,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

function instant(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new StorageError("INVALID_INPUT", `${name} must be an epoch-ms integer.`);
  return value;
}

export class Events {
  constructor(private readonly c: Connection) {}

  /** Adds an event behind every other; joins the caller's transaction, so it commits with the message it is about. */
  enqueue(input: EventInput): number {
    if (!input.kind || !input.lane) throw new StorageError("INVALID_INPUT", "An event needs a kind and a lane.");
    const created = instant(input.createdAt, "createdAt");
    const ready = instant(input.readyAt ?? created, "readyAt");
    return this.c.write(
      () =>
        this.c.get<{ seq: number }>(
          `INSERT INTO events(kind, lane, message_id, payload, created_at, ready_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
          input.kind,
          input.lane,
          input.messageId,
          input.payload,
          created,
          ready,
          created
        )!.seq
    );
  }

  /** Whether an event of this kind was ever recorded for the message, so a repeated delivery of it is not announced twice. */
  hasMessageEvent(messageId: number, kind: string): boolean {
    return this.c.get("SELECT 1 FROM events WHERE message_id = ? AND kind = ? LIMIT 1", messageId, kind) !== undefined;
  }

  get(seq: number): EventRecord | null {
    const row = this.c.get<EventRow>("SELECT * FROM events WHERE seq = ?", seq);
    return row === undefined ? null : eventFromRow(row);
  }

  /** The oldest event still to post, in any lane. */
  head(): EventRecord | null {
    const row = this.c.get<EventRow>(`SELECT * FROM events INDEXED BY events_open WHERE ${OPEN} ORDER BY seq LIMIT 1`);
    return row === undefined ? null : eventFromRow(row);
  }

  /** Every open event of one lane, oldest first. The dispatcher reads a chat's burst from here. */
  openInLane(lane: string): EventRecord[] {
    return this.c
      .all<EventRow>(`SELECT * FROM events INDEXED BY events_lane WHERE lane = ? AND ${OPEN} ORDER BY seq`, lane)
      .map(eventFromRow);
  }

  /** The oldest open event of every lane, oldest first: the only events that may be posted next. */
  laneHeads(): EventRecord[] {
    return this.c
      .all<EventRow>(
        `SELECT * FROM events WHERE seq IN (
           SELECT min(seq) FROM events INDEXED BY events_lane WHERE ${OPEN} GROUP BY lane)
         ORDER BY seq`
      )
      .map(eventFromRow);
  }

  /** Whether an event queued after `seq` in the same lane is still open. */
  hasNewerOpen(lane: string, seq: number): boolean {
    return this.c.get(`SELECT 1 FROM events INDEXED BY events_lane WHERE lane = ? AND seq > ? AND ${OPEN} LIMIT 1`, lane, seq) !== undefined;
  }

  /**
   * Marks the POST as started before it is sent, so a crash during it leaves a
   * row that is sent again. A `sending` row is taken over only when it was
   * claimed at or before `takeOverBefore`; null takes pending rows only.
   */
  claim(seq: number, at: number, takeOverBefore: number | null = null): boolean {
    return this.claimMany([seq], at, takeOverBefore);
  }

  /**
   * Claims every seq or none of them. A coalesced POST is one body for several
   * rows; claiming some and not the rest would split that body on the retry.
   * A `sending` row is taken over only when it was claimed at or before
   * `takeOverBefore`; null takes pending rows only.
   */
  claimMany(seqs: number[], at: number, takeOverBefore: number | null = null): boolean {
    if (seqs.length === 0) return false;
    const claimedAt = instant(at, "at");
    try {
      return this.c.write(() => {
        const changed = this.c.run(
          `UPDATE events SET state = 'sending', attempts = attempts + 1, next_attempt_at = NULL, updated_at = ?
           WHERE seq IN (SELECT value FROM json_each(?))
             AND (state = 'pending' OR (state = 'sending' AND updated_at <= ?))`,
          claimedAt,
          JSON.stringify(seqs),
          takeOverBefore ?? -1
        );
        if (changed !== seqs.length) throw new ClaimMiss();
        return true;
      });
    } catch (err) {
      if (err instanceof ClaimMiss) return false;
      throw err;
    }
  }

  /** `attempt`: the attempts count the POST's claim left, when this records its answer; otherwise any open event. */
  delivered(seq: number, status: number | null, at: number, attempt?: number): boolean {
    return this.close(seq, "delivered", status, null, at, attempt);
  }

  fail(seq: number, status: number | null, error: string, at: number, attempt?: number): boolean {
    return this.close(seq, "failed", status, error, at, attempt);
  }

  /** Why it will never be posted: the message is gone, or the webhook no longer wants it. */
  cancel(seq: number, reason: string, at: number): boolean {
    return this.c.write(
      () =>
        this.c.run(
          `UPDATE events SET state = 'cancelled', next_attempt_at = NULL, last_error = ?, updated_at = ? WHERE seq = ? AND ${OPEN}`,
          reason,
          at,
          seq
        ) > 0
    );
  }

  /** Back to waiting after a POST that may succeed later; `attempt` as for delivered(). */
  retry(seq: number, nextAttemptAt: number, status: number | null, error: string, at: number, attempt?: number): boolean {
    return this.c.write(
      () =>
        this.c.run(
          `UPDATE events SET state = 'pending', next_attempt_at = ?, last_status = ?, last_error = ?, updated_at = ?
           WHERE seq = ? AND state = 'sending' AND attempts = coalesce(?, attempts)`,
          instant(nextAttemptAt, "nextAttemptAt"),
          status,
          error,
          at,
          seq,
          attempt ?? null
        ) > 0
    );
  }

  /**
   * Makes every retry that waits and was last attempted at or before
   * `lastAttemptBefore` due at `at`; returns how many. The last change of a
   * waiting retry is when its attempt failed.
   */
  nudge(at: number, lastAttemptBefore: number): number {
    return this.c.write(() =>
      this.c.run(
        `UPDATE events SET next_attempt_at = ?
         WHERE seq IN (SELECT seq FROM events INDEXED BY events_open WHERE ${OPEN})
           AND state = 'pending' AND next_attempt_at > ? AND updated_at <= ?`,
        at,
        at,
        lastAttemptBefore
      )
    );
  }

  /** Cancels up to `limit` open events, oldest first; returns how many. For a webhook turned off. */
  cancelOpen(reason: string, at: number, limit = 500): number {
    return this.c.write(() =>
      this.c.run(
        `UPDATE events SET state = 'cancelled', next_attempt_at = NULL, last_error = ?, updated_at = ?
         WHERE seq IN (SELECT seq FROM events INDEXED BY events_open WHERE ${OPEN} ORDER BY seq LIMIT ?)`,
        reason,
        at,
        Math.max(1, Math.floor(limit))
      )
    );
  }

  /**
   * Removes closed events: delivered ones updated before `deliveredBefore`,
   * failed and cancelled ones before `closedBefore`. The latest delivery is
   * always kept, since it is what says the failures before it are over.
   * Chunked, the event loop turning between chunks; resolves to how many rows
   * went.
   */
  async prune(deliveredBefore: number, closedBefore: number, chunk = 500): Promise<number> {
    this.c.assertWritable();
    let removed = 0;
    const size = Math.max(1, Math.floor(chunk));
    for (const [states, before] of [
      ["'delivered'", deliveredBefore],
      ["'failed', 'cancelled'", closedBefore],
    ] as const) {
      await this.c.chunked(() => {
        const n = this.c.run(
          `DELETE FROM events WHERE seq IN (
             SELECT seq FROM events WHERE state IN (${states}) AND updated_at < ?
               AND seq <> coalesce((${LATEST_DELIVERY}), -1) LIMIT ?)`,
          before,
          size
        );
        removed += n;
        return n === size;
      });
    }
    return removed;
  }

  /** Read in one transaction, so a server writing meanwhile cannot make the counts disagree with each other. */
  stats(): EventStats {
    return this.snapshot(() => this.readStats());
  }

  private readStats(): EventStats {
    const counts = this.c.get<{
      delivered: number;
      failed: number;
      cancelled: number;
      pending: number;
      last_success_at: number | null;
    }>(
      `SELECT (SELECT count(*) FROM events WHERE state = 'delivered') AS delivered,
              (SELECT count(*) FROM events WHERE state = 'failed') AS failed,
              (SELECT count(*) FROM events WHERE state = 'cancelled') AS cancelled,
              (SELECT count(*) FROM events INDEXED BY events_open WHERE ${OPEN}) AS pending,
              (SELECT max(updated_at) FROM events WHERE state = 'delivered') AS last_success_at`
    )!;
    // Chats post independently, so "since the last delivery" is a matter of time, not of seq.
    const consecutive = this.c.get<{ n: number }>(
      "SELECT count(*) AS n FROM events WHERE state = 'failed' AND updated_at > ?",
      counts.last_success_at ?? -1
    )!.n;
    const failures = this.c.all<{ seq: number; updated_at: number; last_error: string; last_status: number | null }>(
      `SELECT * FROM (SELECT seq, updated_at, last_error, last_status FROM events
                      WHERE state = 'failed' ORDER BY updated_at DESC, seq DESC LIMIT 1)
       UNION ALL
       SELECT * FROM (SELECT seq, updated_at, last_error, last_status FROM events INDEXED BY events_open
                      WHERE ${OPEN} AND last_error IS NOT NULL ORDER BY updated_at DESC, seq DESC LIMIT 1)`
    );
    const last = failures.sort((a, b) => b.updated_at - a.updated_at || b.seq - a.seq)[0];
    const head = this.head();
    return {
      delivered: counts.delivered,
      failed: counts.failed,
      cancelled: counts.cancelled,
      pending: counts.pending,
      consecutiveFailures: consecutive,
      lastSuccessAt: counts.last_success_at,
      lastFailureAt: last?.updated_at ?? null,
      lastFailure: last?.last_error ?? null,
      lastFailureStatus: last?.last_status ?? null,
      oldestPendingAt: head?.createdAt ?? null,
      // The in-flight attempt has not failed yet.
      oldestPendingFailures: head === null ? 0 : head.state === "sending" ? head.attempts - 1 : head.attempts,
    };
  }

  /** `read` inside one read transaction, or inside the caller's transaction when there is one. */
  private snapshot<T>(read: () => T): T {
    const db = this.c.db;
    if (db.isTransaction) return read();
    db.exec("BEGIN");
    try {
      return read();
    } finally {
      if (db.isTransaction) db.exec("COMMIT");
    }
  }

  private close(
    seq: number,
    state: "delivered" | "failed",
    status: number | null,
    error: string | null,
    at: number,
    attempt: number | undefined
  ): boolean {
    const guard = attempt === undefined ? OPEN : "state = 'sending' AND attempts = ?";
    return this.c.write(
      () =>
        this.c.run(
          `UPDATE events SET state = ?, next_attempt_at = NULL, last_status = ?, last_error = ?, updated_at = ?
           WHERE seq = ? AND ${guard}`,
          state,
          status,
          error,
          at,
          seq,
          ...(attempt === undefined ? [] : [attempt])
        ) > 0
    );
  }
}
