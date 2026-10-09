/**
 * The transcription queue of one account: incoming voice notes waiting for
 * the service to transcribe them, the run under way, and the notes it gave
 * up on. It lives in the database, so a restart resumes it instead of
 * forgetting it, and the schema's triggers take a note off it once it has a
 * transcript, a tombstone or no row.
 *
 * The queue holds no policy about which notes belong on it (the service
 * decides that) nor about how often to retry (the worker does): it keeps
 * attempts, times and a short reason, on the database's clock.
 */
import type { Connection } from "./connection.js";
import type { Messages } from "./messages.js";

/** Rows one look for the next note examines; a row whose note is gone leaves on the way. */
const NEXT_SCAN = 32;
/** A note given up on is remembered this long, so it is not queued again meanwhile. */
const FAILED_KEPT_MS = 30 * 24 * 60 * 60_000;
/** A reason is a few words; anything longer is cut. */
const REASON_MAX = 120;
/** A note still waiting this long after it was queued is given up on: its words are no longer news. */
export const TRANSCRIBE_QUEUE_MAX_AGE_MS = 24 * 60 * 60_000;

/** Runs a note gets before it is given up on; a run a crash interrupted counts. */
export const TRANSCRIBE_MAX_ATTEMPTS = 3;

/** Where the audio goes: stays on this machine, or is uploaded to an API. */
export type ProviderClass = "local" | "api";

export interface TranscribeItem {
  id: number;
  sid: string;
  /** Runs started before this one. */
  attempts: number;
  queuedAt: number;
}

export interface TranscribeQueueStats {
  /** Notes waiting or being transcribed. */
  queued: number;
  /** When the run under way started, or null. */
  startedAt: number | null;
  /** Notes given up on and remembered. */
  failed: number;
  /** The latest reason recorded on a note still queued or given up on. */
  lastError: { reason: string; at: number; final: boolean } | null;
}

/** Where one message stands: queued (waiting or running), given up on, or not on the queue at all. */
export type TranscribeState =
  | { state: "queued"; attempts: number; running: boolean; error: string | null }
  | { state: "failed"; attempts: number; error: string | null };

export class Transcripts {
  constructor(
    private readonly c: Connection,
    private readonly messages: Messages
  ) {}

  /**
   * Queues a message the reader can see and that has no transcript yet, for
   * the class of provider configured now. A message already on the queue, or
   * given up on, is left as it is. True when a row was added.
   */
  enqueue(sid: string, providerClass: ProviderClass): boolean {
    return this.c.write(() => {
      const key = this.messages.visibleKey(sid);
      if (key === null) return false;
      const now = this.c.now();
      return (
        this.c.run(
          `INSERT INTO transcribe_queue(message_id, provider_class, queued_at, next_at)
             SELECT m.id, ?, ?, ? FROM messages m
             WHERE m.id = ? AND m.transcript IS NULL
               AND NOT EXISTS (SELECT 1 FROM transcribe_queue q WHERE q.message_id = m.id)`,
          providerClass,
          now,
          now,
          key.id
        ) > 0
      );
    });
  }

  /**
   * The note to transcribe now with a provider of `providerClass`: queued, not
   * running, due. The newest message goes first, so a note that just arrived
   * is never held behind a history backlog or an older note's retry. A row
   * whose message a reader can no longer see, or that has a transcript, leaves
   * the queue on the way. Before that, what must never run is given up on: a
   * note queued more than a day ago (too_old), and a note queued for this
   * machine when the provider is now an API (provider_changed). A note queued
   * for an API may run locally.
   */
  next(providerClass: ProviderClass): TranscribeItem | null {
    return this.c.write(() => {
      this.expire();
      if (providerClass === "api") {
        const now = this.c.now();
        this.c.run(
          `UPDATE transcribe_queue SET failed_at = ?, error = 'provider_changed', error_at = ?
           WHERE failed_at IS NULL AND started_at IS NULL AND provider_class = 'local'`,
          now,
          now
        );
      }
      const rows = this.c.all<{ id: number; sid: string | null; attempts: number; queued_at: number; transcribed: number }>(
        `SELECT q.message_id AS id, q.attempts, q.queued_at,
           (CASE WHEN m.from_me = 1 THEN 'true' ELSE 'false' END) || '_' || coalesce(ck.jid, c.jid) || '_' || m.key_id AS sid,
           (m.transcript IS NOT NULL) AS transcribed
         FROM transcribe_queue q
           JOIN messages m ON m.id = q.message_id
           JOIN chats c ON c.id = m.chat_id LEFT JOIN chats ck ON ck.id = c.merged_into
         WHERE q.failed_at IS NULL AND q.started_at IS NULL AND q.next_at <= ?
         ORDER BY q.message_id DESC LIMIT ?`,
        this.c.now(),
        NEXT_SCAN
      );
      for (const row of rows) {
        if (row.sid !== null && row.transcribed === 0 && this.messages.visibleKey(row.sid)?.id === row.id) {
          return { id: row.id, sid: row.sid, attempts: row.attempts, queuedAt: row.queued_at };
        }
        this.c.run("DELETE FROM transcribe_queue WHERE message_id = ?", row.id);
      }
      // A full page of gone notes: the caller asks again, and the next page is due too.
      return rows.length === NEXT_SCAN ? this.next(providerClass) : null;
    });
  }

  /**
   * Voice notes with no transcript that were never queued (nor given up on),
   * newest first, at most `limit`: what a backfill may queue. Stories are left
   * out; whether each one belongs on the queue is the service's to decide.
   */
  untranscribedVoice(limit: number): string[] {
    return this.c
      .all<{ sid: string }>(
        `SELECT (CASE WHEN m.from_me = 1 THEN 'true' ELSE 'false' END) || '_' || coalesce(ck.jid, c.jid) || '_' || m.key_id AS sid
         FROM messages m
           JOIN chats c ON c.id = m.chat_id LEFT JOIN chats ck ON ck.id = c.merged_into
         WHERE m.type = 'voice' AND m.transcript IS NULL AND m.deleted_at IS NULL
           AND coalesce(ck.jid, c.jid) <> 'status@broadcast'
           AND NOT EXISTS (SELECT 1 FROM transcribe_queue q WHERE q.message_id = m.id)
         ORDER BY m.id DESC LIMIT ?`,
        Math.max(0, Math.floor(limit))
      )
      .map((row) => row.sid);
  }

  /**
   * Marks a run as started and counts it. The count this run makes, or null
   * when the row is gone, given up on, or already running.
   */
  claim(id: number): number | null {
    return this.c.write(() => {
      const changed = this.c.run(
        "UPDATE transcribe_queue SET attempts = attempts + 1, started_at = ? WHERE message_id = ? AND failed_at IS NULL AND started_at IS NULL",
        this.c.now(),
        id
      );
      if (changed === 0) return null;
      return this.c.get<{ attempts: number }>("SELECT attempts FROM transcribe_queue WHERE message_id = ?", id)!.attempts;
    });
  }

  /** A run failed and may be tried again in `delayMs`; the attempt stays counted. */
  retry(id: number, reason: string, delayMs: number): void {
    this.c.write(() => {
      const now = this.c.now();
      this.c.run(
        "UPDATE transcribe_queue SET started_at = NULL, next_at = ?, error = ?, error_at = ? WHERE message_id = ? AND failed_at IS NULL",
        now + Math.max(0, delayMs),
        shortReason(reason),
        now,
        id
      );
    });
  }

  /**
   * A run that could not start through no fault of the note — no connection,
   * a provider that is not ready, a stop: the attempt is given back, and the
   * note waits `delayMs`. A reason, when given, is recorded.
   */
  release(id: number, reason: string | null, delayMs: number): void {
    this.c.write(() => {
      const now = this.c.now();
      this.c.run(
        `UPDATE transcribe_queue SET started_at = NULL, attempts = max(0, attempts - 1), next_at = ?,
           error = coalesce(?, error), error_at = CASE WHEN ? IS NULL THEN error_at ELSE ? END
         WHERE message_id = ? AND failed_at IS NULL AND started_at IS NOT NULL`,
        now + Math.max(0, delayMs),
        reason === null ? null : shortReason(reason),
        reason,
        now,
        id
      );
    });
  }

  /** Gives up on a note: it leaves the queue, and the reason stays so it is not queued again. */
  fail(id: number, reason: string): void {
    this.c.write(() => {
      const now = this.c.now();
      this.c.run(
        "UPDATE transcribe_queue SET started_at = NULL, failed_at = ?, error = ?, error_at = ? WHERE message_id = ? AND failed_at IS NULL",
        now,
        shortReason(reason),
        now,
        id
      );
    });
  }

  /**
   * Gives up on notes queued more than a day ago and still waiting (too_old),
   * and forgets notes given up on more than a month ago. Runs before every
   * look for the next note, and on the worker's hourly round.
   */
  expire(): void {
    this.c.write(() => {
      const now = this.c.now();
      this.c.run(
        `UPDATE transcribe_queue SET failed_at = ?, error = 'too_old', error_at = ?
         WHERE failed_at IS NULL AND started_at IS NULL AND queued_at <= ?`,
        now,
        now,
        now - TRANSCRIBE_QUEUE_MAX_AGE_MS
      );
      this.c.run("DELETE FROM transcribe_queue WHERE failed_at IS NOT NULL AND failed_at < ?", now - FAILED_KEPT_MS);
    });
  }

  /** Takes a note off the queue with nothing to remember: transcribed, gone, or no longer one to transcribe. */
  remove(id: number): void {
    this.c.write(() => {
      this.c.run("DELETE FROM transcribe_queue WHERE message_id = ?", id);
    });
  }

  /**
   * Right after a writable open, before anything runs: a run a stopped or crashed process left marked as started
   * is waiting again, its attempt still counted, and one that has used
   * `maxAttempts` is given up on. Failures older than a month are forgotten.
   * How many runs were recovered.
   */
  recover(maxAttempts = TRANSCRIBE_MAX_ATTEMPTS): number {
    return this.c.write(() => {
      const now = this.c.now();
      this.expire();
      this.c.run(
        `UPDATE transcribe_queue SET started_at = NULL, failed_at = ?, error = 'interrupted too often', error_at = ?
         WHERE failed_at IS NULL AND started_at IS NOT NULL AND attempts >= ?`,
        now,
        now,
        maxAttempts
      );
      return this.c.run("UPDATE transcribe_queue SET started_at = NULL, next_at = ? WHERE failed_at IS NULL AND started_at IS NOT NULL", now);
    });
  }

  /** Milliseconds until the next waiting note is due (0 when one is due now), or null when none waits. */
  dueIn(): number | null {
    const row = this.c.get<{ at: number | null }>(
      "SELECT min(next_at) AS at FROM transcribe_queue WHERE failed_at IS NULL AND started_at IS NULL"
    );
    return row?.at === null || row?.at === undefined ? null : Math.max(0, row.at - this.c.now());
  }

  /** Where a message stands on the queue, under any spelling of its id; null when it is not on it. */
  state(sid: string): TranscribeState | null {
    const key = this.messages.visibleKey(sid);
    if (key === null) return null;
    const row = this.c.get<{ attempts: number; started_at: number | null; error: string | null; failed_at: number | null }>(
      "SELECT attempts, started_at, error, failed_at FROM transcribe_queue WHERE message_id = ?",
      key.id
    );
    if (row === undefined) return null;
    if (row.failed_at !== null) return { state: "failed", attempts: row.attempts, error: row.error };
    return { state: "queued", attempts: row.attempts, running: row.started_at !== null, error: row.error };
  }

  /** The whole queue for status, without a word of any note. */
  stats(): TranscribeQueueStats {
    const counts = this.c.get<{ queued: number; started: number | null; failed: number }>(
      `SELECT (SELECT count(*) FROM transcribe_queue WHERE failed_at IS NULL) AS queued,
              (SELECT min(started_at) FROM transcribe_queue WHERE failed_at IS NULL) AS started,
              (SELECT count(*) FROM transcribe_queue WHERE failed_at IS NOT NULL) AS failed`
    )!;
    const last = this.c.get<{ error: string; error_at: number; final: number }>(
      `SELECT error, error_at, (failed_at IS NOT NULL) AS final FROM transcribe_queue
       WHERE error IS NOT NULL AND error_at IS NOT NULL ORDER BY error_at DESC LIMIT 1`
    );
    return {
      queued: counts.queued,
      startedAt: counts.started,
      failed: counts.failed,
      lastError: last === undefined ? null : { reason: last.error, at: last.error_at, final: last.final === 1 },
    };
  }
}

function shortReason(reason: string): string {
  const flat = reason.replace(/\s+/g, " ").trim();
  return flat.length <= REASON_MAX ? flat : `${flat.slice(0, REASON_MAX - 1)}…`;
}
