/**
 * The voice-note transcription queue in words, for `get_status` and for
 * `wazap status`. Counts, an age and a short reason: never a word of a note.
 * `wazap status` reads each account's database read-only, so it answers the
 * same whether or not a server is running.
 */
import { join } from "node:path";
import { AccountRegistry, accountPolicy } from "./accounts.js";
import { accountPaths, type Config } from "./config.js";
import type { AccountDb, TranscribeQueueStats } from "./db/index.js";
import type { Check } from "./doctor.js";
import { openForReading } from "./legacy-files.js";
import { readTranscribeSettings } from "./transcribe/index.js";
import type { TranscriptionStatus } from "./wa-types.js";

const DB_FILE = "wazap.sqlite";

/** `2 waiting, one running for 12 s, 1 given up; last error 3 min ago: media no longer on WhatsApp (HTTP 404)`. */
export function describeTranscribeQueue(
  queue: { queued: number; runningForSeconds: number | null; failed: number; lastError: { reason: string; agoSeconds: number; final: boolean } | null }
): string {
  const running = queue.runningForSeconds !== null;
  const waiting = queue.queued - (running ? 1 : 0);
  const parts = [waiting === 0 && !running ? "empty" : `${waiting} waiting`];
  if (running) parts.push(`one running for ${ago(queue.runningForSeconds!)}`);
  if (queue.failed > 0) parts.push(`${queue.failed} given up`);
  let text = parts.join(", ");
  if (queue.lastError !== null) {
    const outcome = queue.lastError.final ? "gave up" : "will retry";
    text += `; last error ${ago(queue.lastError.agoSeconds)} ago (${outcome}): ${queue.lastError.reason}`;
  }
  return text;
}

/** The get_status line, only when there is something to say. */
export function transcriptionStatusLine(status: TranscriptionStatus, now = Date.now()): string | null {
  if (status.queued === 0 && status.failed === 0 && status.last_error === null) return null;
  const lastError =
    status.last_error === null
      ? null
      : {
          reason: status.last_error.reason,
          agoSeconds: Math.max(0, Math.round((now - Date.parse(status.last_error.at)) / 1000)),
          final: status.last_error.final,
        };
  const detail = describeTranscribeQueue({
    queued: status.queued,
    runningForSeconds: status.running_for_seconds,
    failed: status.failed,
    lastError,
  });
  const idle = status.auto === "on" ? "" : " (automatic transcription is off, so the queue waits)";
  const paused = status.paused === null ? "" : `; paused until ${status.paused.until}: ${status.paused.reason}`;
  return `- **voice transcription queue**: ${detail}${idle}${paused}`;
}

/**
 * One `voice queue` line per account whose database holds a queue or a
 * failure, and one saying it is empty when transcription is on and nothing
 * waits. An account without a database yet, or one a newer wazap wrote, is
 * left out.
 */
export function checkTranscribeQueue(config: Pick<Config, "dataDir" | "readOnly" | "rateLimitPerMinute">): Check[] {
  let transcribing = false;
  let uploads = false;
  let allowApi = false;
  try {
    const settings = readTranscribeSettings(process.env, config.dataDir);
    transcribing = settings.provider !== null && settings.auto;
    uploads = settings.provider === "openai";
    allowApi = settings.allowApi;
  } catch {
    // The transcribe check already reports settings that do not parse.
  }
  let registry: AccountRegistry;
  try {
    registry = AccountRegistry.load(config.dataDir);
  } catch {
    return [];
  }
  const accounts = registry.all();
  const checks: Check[] = [];
  for (const account of accounts) {
    const stats = readStats(join(accountPaths(config.dataDir, account.id).root, DB_FILE));
    if (stats === null) continue;
    const refused = transcribing && uploads && accountPolicy(account, config).readOnly && !allowApi;
    const runs = transcribing && !refused;
    const quiet = stats.queued === 0 && stats.failed === 0;
    if (quiet && !runs) continue;
    const now = Date.now();
    const detail = describeTranscribeQueue({
      queued: stats.queued,
      runningForSeconds: stats.startedAt === null ? null : Math.max(0, Math.round((now - stats.startedAt) / 1000)),
      failed: stats.failed,
      lastError:
        stats.lastError === null
          ? null
          : { reason: stats.lastError.reason, agoSeconds: Math.max(0, Math.round((now - stats.lastError.at) / 1000)), final: stats.lastError.final },
    });
    const name = accounts.length > 1 ? `voice queue (${account.id})` : "voice queue";
    const stalled = stats.queued > 0 && !runs;
    const why = refused ? "the account is read-only, so audio is not uploaded and it waits" : "automatic transcription is off, so it waits";
    const fix = refused
      ? "approve audio uploads, set WAZAP_TRANSCRIBE_ALLOW_API=1 and restart, or `wazap config transcribe local`"
      : "keep manual transcription, or review the upload scope, set WAZAP_TRANSCRIBE_AUTO=1 with a configured provider and restart";
    checks.push({
      name,
      state: stalled ? "warn" : "info",
      detail: stalled ? `${detail}; ${why}` : detail,
      ...(stalled ? { fix } : {}),
    });
  }
  return checks;
}

function readStats(path: string): TranscribeQueueStats | null {
  let db: AccountDb;
  try {
    // Read-only while a server holds it, immutable otherwise: status leaves nothing beside a closed file.
    db = openForReading(path);
  } catch {
    return null;
  }
  try {
    return db.transcripts.stats();
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function ago(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}
