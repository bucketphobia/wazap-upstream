/** The shapes transcription is built from. No logic lives here. */

export type ProviderName = "local" | "openai";

/** The whisper.cpp model aliases wazap knows how to fetch. */
export type ModelAlias = "turbo" | "large-v3" | "medium";

export interface Transcript {
  text: string;
  language?: string;
  duration_seconds?: number;
}

export interface TranscribeOpts {
  /** Overrides the configured language for one call. "auto" detects. */
  language?: string;
  /** Aborts the upload or the local run: the account is being removed. */
  signal?: AbortSignal;
}

/** Why a provider cannot run right now, and what to type to fix it. */
export interface Readiness {
  ok: boolean;
  detail: string;
  fix?: string;
}

/**
 * Settings travel as the first argument rather than living inside the provider
 * so PROVIDERS can stay a plain table of stateless objects.
 */
export interface Provider {
  /** Where the audio goes: "local" keeps it on this machine, "api" uploads it. */
  readonly kind: "local" | "api";
  transcribe(settings: TranscribeSettings, file: string, opts: TranscribeOpts): Promise<Transcript>;
  ready(settings: TranscribeSettings): Promise<Readiness>;
}

/** The whole transcription environment, parsed once at the boundary. */
export interface TranscribeSettings {
  /** null means transcription is off. */
  provider: ProviderName | null;
  /** "auto" or an ISO code. */
  language: string;
  auto: boolean;
  /** local only. */
  model: ModelAlias;
  /** local only: WAZAP_WHISPER_BIN override. */
  whisperBin: string | null;
  apiKey: string | null;
  /** Explicit permission to upload audio while WhatsApp writes remain disabled. */
  allowApi: boolean;
  /** openai only, already validated https-or-loopback, no trailing slash. */
  baseUrl: string;
  /** openai only. */
  apiModel: string;
  modelsDir: string;
}

/** A transcript as the store keeps it, keyed by message id. */
export interface TranscriptRecord extends Transcript {
  provider: ProviderName;
  /** epoch ms */
  at: number;
}
