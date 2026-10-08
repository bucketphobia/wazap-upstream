/**
 * Any OpenAI-compatible /audio/transcriptions endpoint, over plain fetch.
 * Audio and the API key go only to the configured endpoint, never a redirect.
 * Errors contain neither provider bodies nor transport exception excerpts.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WazapError } from "../errors.js";
import { discardResponse, readBoundedJson, ResponseLimitError } from "../http-response.js";
import { markFailure, type FailureKind } from "./failure.js";
import { redact } from "./settings.js";
import type { Provider, Readiness, TranscribeOpts, TranscribeSettings, Transcript } from "./types.js";

const TIMEOUT_MS = 2 * 60 * 1000;
const RETRY_AFTER_MS = 2000;
const RESPONSE_MAX_BYTES = 1024 * 1024;
const KEY_FIX = "Run `wazap config transcribe openai`";

const MIME: Record<string, string> = {
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
};

function failed(message: string, key: string | null, fix?: string, kind: FailureKind = "transient", reason = "provider failed"): WazapError {
  const error = new WazapError("TRANSCRIBE_FAILED", redact(message, key), fix === undefined ? undefined : redact(fix, key));
  return markFailure(error, kind, reason);
}

/** The caller gave up on the call (its account is being removed): not the note's fault. */
function cancelled(): WazapError {
  return markFailure(new WazapError("TRANSCRIBE_FAILED", "Transcription request was cancelled."), "waiting", "stopping");
}

/**
 * What an HTTP refusal means for another attempt: a refused key is not the
 * note's fault, a busy or failing server may answer later, and any other 4xx
 * is the provider refusing this audio as input.
 */
function refusal(status: number): { kind: FailureKind; reason: string } {
  if (status === 401 || status === 403) return { kind: "paused", reason: `provider refused the key (HTTP ${status})` };
  if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) {
    return { kind: "transient", reason: `provider unavailable (HTTP ${status})` };
  }
  return { kind: "permanent", reason: `provider refused the audio (HTTP ${status})` };
}

async function post(settings: TranscribeSettings, key: string, file: string, language: string, signal?: AbortSignal): Promise<Response> {
  const bytes = await readFile(file);
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), basename(file));
  form.append("model", settings.apiModel);
  form.append("response_format", "json");
  if (language !== "auto") form.append("language", language);
  return fetch(`${settings.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: settings.apiAuthHeader === "x-bf-vk" ? { "x-bf-vk": key } : { Authorization: `Bearer ${key}` },
    body: form,
    redirect: "error",
    signal: signal === undefined ? AbortSignal.timeout(TIMEOUT_MS) : AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), signal]),
  });
}

export const openaiProvider: Provider = {
  kind: "api",
  async transcribe(settings: TranscribeSettings, file: string, opts: TranscribeOpts): Promise<Transcript> {
    if (!existsSync(file)) throw new WazapError("FILE_NOT_FOUND", `No such file: ${file}`);
    const key = settings.apiKey;
    if (key === null) throw new WazapError("TRANSCRIBE_UNAVAILABLE", "No transcription API key is set.", KEY_FIX);
    const language = opts.language ?? settings.language;

    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await post(settings, key, file, language, opts.signal);
      } catch (err) {
        if (opts.signal?.aborted === true) throw cancelled();
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        throw failed(
          timedOut ? "Transcription request timed out after 2 minutes." : "Transcription request failed.",
          key,
          undefined,
          "transient",
          timedOut ? "provider timed out" : "provider unreachable"
        );
      }
      if (response.ok) break;
      await discardResponse(response);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt > 0) {
        const meaning = refusal(response.status);
        throw failed(
          `Transcription API returned HTTP ${response.status}.`,
          key,
          response.status === 401 || response.status === 403 ? KEY_FIX : undefined,
          meaning.kind,
          meaning.reason
        );
      }
      try {
        await sleep(RETRY_AFTER_MS, undefined, opts.signal === undefined ? {} : { signal: opts.signal });
      } catch {
        throw cancelled();
      }
    }

    let parsed: unknown;
    try {
      parsed = await readBoundedJson(response, RESPONSE_MAX_BYTES);
    } catch (err) {
      throw failed(
        err instanceof ResponseLimitError
          ? "Transcription API response exceeded 1 MiB."
          : "Transcription API sent no readable JSON.",
        key,
        undefined,
        "transient",
        "provider answer unreadable"
      );
    }
    if (parsed === null || typeof parsed !== "object" || !("text" in parsed) || typeof parsed.text !== "string") {
      throw failed("Transcription API sent no text field.", key, undefined, "transient", "provider answer unreadable");
    }
    return {
      text: parsed.text.replace(/\s+/g, " ").trim(),
      ...("language" in parsed && typeof parsed.language === "string" ? { language: parsed.language } : {}),
      ...("duration" in parsed &&
      typeof parsed.duration === "number" &&
      Number.isFinite(parsed.duration) &&
      parsed.duration >= 0
        ? { duration_seconds: Math.round(parsed.duration) }
        : {}),
    };
  },

  async ready(settings: TranscribeSettings): Promise<Readiness> {
    if (settings.apiKey === null) return { ok: false, detail: "no transcription API key is set", fix: KEY_FIX };
    return { ok: true, detail: `${settings.apiModel} at ${new URL(settings.baseUrl).host}` };
  },
};
