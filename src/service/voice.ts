/**
 * Voice notes as text, for one account: get_media's transcription, the
 * durable queue incoming notes join, and what get_status says about it. Part
 * of WhatsAppService (src/whatsapp.ts). The provider and the media download
 * stay on the service, where the tests replace them, and are reached through
 * VoiceHost like the socket and the database.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WAMessage, WASocket } from "baileys";
import type { AccountRecord } from "../accounts.js";
import type { Config } from "../config.js";
import type { AccountDb, StoredMessage, UpsertResult } from "../db/index.js";
import { asWazapError, WazapError } from "../errors.js";
import { isStatusJid } from "../ids.js";
import { logError } from "../logger.js";
import { isoWithOffset, mediaInfo, messageTimestampMs, messageType, protoNumber, voiceSeconds } from "../messages.js";
import { mediaFilename } from "../outgoing-media.js";
import type { EmbedFeed } from "../recall/index.js";
import {
  markFailure,
  PROVIDERS,
  readTranscribeSettings,
  transcribeWorker,
  type transcribeFile,
  type transcribeReady,
  type Transcript,
  type TranscribeSettings,
  type TranscribeSource,
  type TranscriptRecord,
} from "../transcribe/index.js";
import type { ConnectionStatus, TranscribeOptions, TranscribeResult, TranscriptionStatus } from "../wa-types.js";
import { FILE_MODE } from "./util.js";
import { missingMessage, type MessageViews } from "./views.js";

/** Ten minutes of speech. Past that, auto-transcribing is a bill nobody asked for. */
const AUTO_TRANSCRIBE_MAX_SECONDS = 600;

/**
 * A voice note a history sync delivers is queued for transcription only when
 * it is this recent: the notes of the last day, not the whole archive a first
 * link brings.
 */
const HISTORY_TRANSCRIBE_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Voice notes without a transcript that one connection queues when the
 * provider runs on this machine, newest first: free, one at a time, and a
 * history a few hundred notes deep is done within the hour.
 */
const BACKFILL_LIMIT = 500;

/**
 * A wrong WAZAP_TRANSCRIBE_* value must not take a running server down with it.
 * Everything else still works, so the complaint is logged once and kept, and the
 * tool that needs it reports it instead of transcribing.
 */
function readTranscribeConfig(dataDir: string): TranscribeSettings | WazapError {
  try {
    return readTranscribeSettings(process.env, dataDir);
  } catch (err) {
    const fault = asWazapError(err);
    logError("transcribe settings", fault);
    return fault;
  }
}

/**
 * A voice note the service transcribes without being asked: not a story,
 * recorded as a voice note rather than attached as an audio file, and of a
 * length WhatsApp stated and kept to ten minutes. The user's own notes too when
 * transcription is free (`own`) or the owner explicitly opts in to new outgoing API notes.
 */
function transcribable(raw: WAMessage, own: boolean): boolean {
  if ((raw.key.fromMe && !own) || isStatusJid(raw.key.remoteJid ?? "") || messageType(raw) !== "voice") return false;
  const seconds = voiceSeconds(raw);
  return seconds !== undefined && seconds <= AUTO_TRANSCRIBE_MAX_SECONDS;
}

/** Field by field, because `at` is the cache's bookkeeping and not the caller's business. */
function transcribeResult(record: TranscriptRecord, cached: boolean): TranscribeResult {
  return {
    text: record.text,
    ...(record.language === undefined ? {} : { language: record.language }),
    ...(record.duration_seconds === undefined ? {} : { duration_seconds: record.duration_seconds }),
    provider: record.provider,
    cached,
  };
}

/** What the service lends voice: its state, its guards, and the seams tests replace, read at each call. */
export interface VoiceHost {
  db(): AccountDb;
  readyDb(): AccountDb | null;
  stopped(): boolean;
  status(): ConnectionStatus;
  guarded<T>(work: () => Promise<T>): Promise<T>;
  ensureConnected(): WASocket;
  /** The bytes behind a message's media. */
  mediaBuffer(sock: WASocket, messageId: string, raw: WAMessage): Promise<Buffer>;
  /** The provider run, and its readiness check: the service's, so a test can stub them. */
  transcriber(...args: Parameters<typeof transcribeFile>): ReturnType<typeof transcribeFile>;
  transcribeReadiness(...args: Parameters<typeof transcribeReady>): ReturnType<typeof transcribeReady>;
  /** get_media's transcription as the service answers it, which a test may replace. */
  transcribeAudio(messageId: string): Promise<TranscribeResult>;
  /** The recall feed, to embed a note once it carries words. */
  embedFeed(): EmbedFeed | null;
  /** The worker is done with a note, or with every note: events held for them look again. */
  webhookTranscriptSettled(sid: string | null): void;
}

export class AccountVoice {
  /** The transcription environment, or the complaint about it. See `readTranscribeConfig`. */
  readonly transcribe: TranscribeSettings | WazapError;
  /**
   * Whether incoming voice notes are queued for transcription: a provider is
   * configured, auto mode is on, and the provider may run in this mode.
   */
  readonly autoTranscribe: boolean;
  /** Where the configured provider sends the audio, recorded with each note queued; null with no provider. */
  private readonly transcribeClass: "local" | "api" | null;
  /** Paid outgoing notes require both explicit API consent and their own opt-in. */
  private readonly autoOwn: boolean;
  /** Only notes created since this process enabled the opt-in can join the paid queue. */
  private readonly ownAutoSince = Math.floor(Date.now() / 1000) * 1000;
  /** This account as the process's transcription worker sees it. */
  readonly transcribeSource: TranscribeSource;
  /** The worker every account shares; a seam for tests. */
  readonly transcribeWorker = transcribeWorker;
  /** Cancels this account's uploads and whisper.cpp runs: it is being removed. */
  private readonly transcribeAbort = new AbortController();
  /** Transcriptions under way, so one recording is never uploaded twice at once. */
  private readonly transcribing = new Map<string, Promise<TranscribeResult>>();

  constructor(
    private readonly host: VoiceHost,
    private readonly views: MessageViews,
    private readonly config: Config,
    account: AccountRecord,
    private readonly effectiveReadOnly: boolean
  ) {
    this.transcribe = readTranscribeConfig(config.dataDir);
    const settings = this.transcribe;
    // Audio processing permission is independent from WhatsApp writes, and defaults off.
    this.autoTranscribe =
      !(settings instanceof WazapError) &&
      settings.provider !== null &&
      settings.auto &&
      !(this.effectiveReadOnly && settings.provider === "openai" && !settings.allowApi);
    this.autoOwn = !(settings instanceof WazapError) && settings.autoOwn && settings.allowApi;
    this.transcribeClass = settings instanceof WazapError || settings.provider === null ? null : PROVIDERS[settings.provider].kind;
    this.transcribeSource = {
      name: account.id,
      providerClass: () => this.transcribeClass ?? "local",
      db: () => (this.host.stopped() ? null : this.host.readyDb()),
      ready: () => !this.host.stopped() && this.host.status() === "connected",
      run: (sid) => this.transcribeQueued(sid),
      settled: (sid) => this.host.webhookTranscriptSettled(sid),
    };
  }

  /**
   * Speech into text, once per message: a transcript already on hand is returned
   * as it is, because the local provider is slow and the API one is billed.
   */
  transcribeAudio(messageId: string, language?: string, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
    return this.host.guarded(async () => {
      const message = this.views.storedOrThrow(messageId);
      if (message.transcript !== null) return transcribeResult(this.transcriptRecordOf(message), true);
      if (opts.cachedOnly === true) {
        throw new WazapError("TRANSCRIBE_UNAVAILABLE", `No transcript of ${messageId} is on hand.`, "Call get_media without save_to to transcribe it");
      }
      const raw = this.views.messageOrThrow(messageId);

      const type = messageType(raw);
      const info = mediaInfo(raw);
      if (info === undefined || (type !== "voice" && type !== "audio")) {
        throw new WazapError(
          "MEDIA_UNAVAILABLE",
          `Message ${messageId} is not a voice note or an audio message.`,
          "Pass a message whose type is voice or audio"
        );
      }

      const settings = this.transcribeSettings();
      // WhatsApp writes and paid audio processing are separate permissions.
      // Read-only still refuses API uploads unless the owner explicitly opts in.
      if (this.effectiveReadOnly && settings.provider === "openai" && !settings.allowApi) {
        throw new WazapError(
          "READ_ONLY",
          "wazap runs read-only, so it will not upload audio to the transcription API.",
          "Approve audio uploads and charges, set WAZAP_TRANSCRIBE_ALLOW_API=1 and restart, or run `wazap config transcribe local`"
        );
      }
      const readiness = await this.host.transcribeReadiness(settings);
      if (!readiness.ok) throw new WazapError("TRANSCRIBE_UNAVAILABLE", readiness.detail, readiness.fix);

      // The transcript is only written once a provider has run and been paid, so the
      // auto queue and a tool call asking for the same message at the same
      // moment would otherwise upload it twice. They share the first run.
      const running = this.transcribing.get(message.sid);
      if (running) return await running;
      // Only a run spends the caller's budget: what is on hand, or cannot run, cost nothing.
      opts.limit?.take();
      const work = this.runTranscribe(message.sid, raw, info, settings, language);
      this.transcribing.set(message.sid, work);
      try {
        return await work;
      } finally {
        this.transcribing.delete(message.sid);
      }
    });
  }

  private async runTranscribe(
    messageId: string,
    raw: WAMessage,
    info: { mime: string; size?: number; filename?: string },
    settings: TranscribeSettings,
    language?: string
  ): Promise<TranscribeResult> {
    // Readiness is never ok while no provider is configured.
    const provider = settings.provider!;
    this.views.messageOrThrow(messageId);
    const sock = this.host.ensureConnected();
    const buffer = await this.host.mediaBuffer(sock, messageId, raw);
    this.views.messageOrThrow(messageId);
    // Its own temp dir, deleted straight after: nobody asked to keep this file,
    // and the media dir is where the files the user did ask for live.
    const dir = await mkdtemp(join(tmpdir(), "wazap-audio-"));
    let transcript: Transcript;
    try {
      const file = join(dir, mediaFilename(info));
      await writeFile(file, buffer, { mode: FILE_MODE });
      this.views.messageOrThrow(messageId);
      transcript = await this.host.transcriber(settings, file, {
        ...(language === undefined ? {} : { language }),
        signal: this.transcribeAbort.signal,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // An API provider answers without a duration, and WhatsApp already said
    // how long the recording runs.
    const seconds = transcript.duration_seconds ?? voiceSeconds(raw);
    const record: TranscriptRecord = {
      ...transcript,
      ...(seconds === undefined ? {} : { duration_seconds: seconds }),
      provider,
      at: Date.now(),
    };
    // A message revoked or expired while the transcription ran keeps nothing behind.
    this.views.messageOrThrow(messageId);
    const sid = this.views.storedOrThrow(messageId).sid;
    const { text, ...details } = record;
    if (!this.host.db().messages.setTranscript(sid, text, details)) throw missingMessage(messageId);
    // With the transcript on it, the voice note finally carries searchable words.
    this.host.embedFeed()?.kick();
    this.views.messageOrThrow(messageId);
    return transcribeResult(record, false);
  }

  /**
   * A stored transcript as the views and get_media take it, with the
   * details stored beside it. One stored without them (set directly, or by
   * an import of a record that had none) names the configured provider.
   */
  transcriptRecordOf(message: StoredMessage): TranscriptRecord {
    const text = message.transcript ?? "";
    const info = message.transcriptInfo;
    if (info !== null) {
      return {
        text,
        provider: info.provider as TranscriptRecord["provider"],
        at: info.at,
        ...(info.language === undefined ? {} : { language: info.language }),
        ...(info.duration_seconds === undefined ? {} : { duration_seconds: info.duration_seconds }),
      };
    }
    const configured = this.transcribe instanceof WazapError ? null : this.transcribe.provider;
    return { text, provider: configured ?? "local", at: 0 };
  }

  transcriptOf(message: StoredMessage): TranscriptRecord | undefined {
    return message.transcript === null ? undefined : this.transcriptRecordOf(message);
  }

  /**
   * At open, whether or not this process transcribes: a run a stopped or
   * crashed process left marked as started waits again (its attempt counted),
   * so no status reports a run that is not happening.
   */
  recoverTranscriptions(db: AccountDb): void {
    try {
      db.transcripts.recover();
    } catch (err) {
      logError("transcribe", err);
    }
  }

  /**
   * The account is being removed: its upload or whisper.cpp run under way ends
   * now instead of being waited for, and gives its attempt back.
   */
  abortTranscription(): void {
    this.transcribeAbort.abort();
  }

  transcribeIdle(): Promise<void> {
    return this.transcribeWorker.idle();
  }

  /** The parsed environment, or the reason it could not be parsed, as a refusal. */
  private transcribeSettings(): TranscribeSettings {
    if (this.transcribe instanceof WazapError) {
      throw new WazapError("TRANSCRIBE_UNAVAILABLE", this.transcribe.message, this.transcribe.fix);
    }
    return this.transcribe;
  }

  // Webhook outbox --------------------------------------------------------------

  /**
   * Whether an event is worth holding for a transcript right now: the note is
   * on the durable queue, this process transcribes, the account can run it,
   * and the provider is not paused. After a restart the queue still says so,
   * and the worker takes the note up again.
   */
  webhookAwaitsTranscript(message: StoredMessage): boolean {
    if (!this.autoTranscribe || this.config.command !== "serve" || this.host.stopped()) return false;
    // A boot starts the outbox before the socket opens: an event a restart left
    // waiting keeps waiting while the account connects, and its ready_at still
    // caps the wait. Only a connection that dropped sends the placeholder now.
    if (this.host.status() !== "connected" && this.host.status() !== "connecting") return false;
    return this.transcribeWorker.paused() === null && this.transcriptQueued(message);
  }

  transcriptQueued(message: StoredMessage): boolean {
    try {
      return this.host.readyDb()?.transcripts.state(message.sid)?.state === "queued";
    } catch {
      return false;
    }
  }

  /**
   * With transcription on this machine, the voice notes already stored that
   * have no transcript join the queue too — the user's own, and those a
   * history sync brought — newest first, up to BACKFILL_LIMIT a connection.
   * The worker takes new arrivals ahead of them. A billed provider queues none.
   */
  backfillTranscripts(): void {
    if (!this.autoTranscribe || this.transcribeClass !== "local") return;
    try {
      const db = this.host.readyDb();
      if (db === null) return;
      let queued = 0;
      for (const sid of db.transcripts.untranscribedVoice(BACKFILL_LIMIT)) {
        const raw = this.views.rawOf(this.views.storedOrThrow(sid));
        if (raw !== null && transcribable(raw, true) && db.transcripts.enqueue(sid, "local")) queued++;
      }
      if (queued > 0) this.transcribeWorker.kick();
    } catch (err) {
      logError("transcribe", err);
    }
  }

  /**
   * In the transaction that stores it, an incoming voice note joins the
   * durable queue: every one that arrives live, however old its stamp (a note
   * WhatsApp delivers only now is still an arrival), and one a history sync
   * brings when it is less than a day old. A crash after the store cannot lose
   * it. Only incoming voice notes whose length WhatsApp stated and kept short,
   * since an audio file is something the sender chose to attach and a
   * recording of unknown length is unbounded; anything skipped is still one
   * get_media call away. The worker is woken at once; it reads the
   * queue a turn later, once the transaction has committed.
   */
  queueTranscript(raw: WAMessage, result: UpsertResult, live: boolean): void {
    if (!this.autoTranscribe || result.sid === null || !transcribable(raw, this.transcribeClass === "local" || this.autoOwn)) return;
    // Outgoing API opt-in applies only to new live notes, never history/import or a stored replay.
    if (this.transcribeClass === "api" && raw.key.fromMe) {
      const seconds = protoNumber(raw.messageTimestamp);
      if (!live || result.outcome !== "inserted" || seconds === undefined ||
        !Number.isFinite(seconds) || seconds * 1000 < this.ownAutoSince) return;
    }
    if (result.outcome !== "inserted" && !(live && result.outcome === "updated")) return;
    if (!live && messageTimestampMs(raw) <= Date.now() - HISTORY_TRANSCRIBE_WINDOW_MS) return;
    if (this.transcribeClass === null) return;
    try {
      if (this.host.db().transcripts.enqueue(result.sid, this.transcribeClass)) this.transcribeWorker.kick();
    } catch (err) {
      // The message is stored whatever the queue says: a webhook, a wait and a read still see it.
      logError("transcribe", err);
    }
  }

  /**
   * One note off the queue, as the worker runs it: a message deleted, expired
   * or transcribed meanwhile is done with, and so is one that is no longer a
   * short voice note this provider may take. The rest is get_media's own path, so a
   * tool call asking for the same note at the same moment shares the upload.
   */
  private async transcribeQueued(sid: string): Promise<void> {
    const message = this.views.storedOrThrow(sid);
    if (message.transcript !== null) return;
    if (!transcribable(this.views.messageOrThrow(sid), this.transcribeClass === "local" || this.autoOwn)) {
      throw markFailure(new WazapError("MEDIA_UNAVAILABLE", "Not a short voice note to transcribe."), "gone", "not a voice note to transcribe");
    }
    await this.host.transcribeAudio(sid);
  }

  /**
   * The account's transcription queue for get_status, without a word of any
   * note: how many wait, how long the run under way has been going, how many
   * were given up on, and the latest reason.
   */
  transcriptionStatus(): TranscriptionStatus {
    const settings = this.transcribe;
    const auto: TranscriptionStatus["auto"] =
      settings instanceof WazapError ? "degraded" : this.autoTranscribe ? "on" : "off";
    const pause = this.transcribeWorker.paused();
    const status: TranscriptionStatus = {
      auto,
      queued: 0,
      running_for_seconds: null,
      failed: 0,
      last_error: null,
      paused: pause === null ? null : { reason: pause.reason, until: isoWithOffset(pause.until) },
    };
    const db = this.host.readyDb();
    if (db === null) return status;
    try {
      const stats = db.transcripts.stats();
      status.queued = stats.queued;
      status.failed = stats.failed;
      if (stats.startedAt !== null) status.running_for_seconds = Math.max(0, Math.round((Date.now() - stats.startedAt) / 1000));
      if (stats.lastError !== null) {
        status.last_error = { reason: stats.lastError.reason, at: isoWithOffset(stats.lastError.at), final: stats.lastError.final };
      }
    } catch (err) {
      logError("transcribe status", err);
    }
    return status;
  }
}
