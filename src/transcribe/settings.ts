/**
 * The one place the transcription environment becomes typed. Nothing downstream
 * reads process.env, so a bad URL or provider name is refused once, here, and
 * the API key is handled by these helpers alone.
 */
import { join } from "node:path";
import { WazapError } from "../errors.js";
import type { ModelAlias, ProviderName, TranscribeSettings } from "./types.js";

const DEFAULT_URL = "https://api.openai.com/v1";
const DEFAULT_API_MODEL = "gpt-4o-mini-transcribe";
const MODEL_ALIASES: readonly ModelAlias[] = ["turbo", "large-v3", "medium"];
const OFF = new Set(["", "off", "0", "no", "none", "false"]);

/** Trims whitespace, then one matching pair of surrounding quotes, then again. */
export function stripPasted(raw: string): string {
  const trimmed = raw.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const quoted = trimmed.length >= 2 && (first === '"' || first === "'") && first === last;
  return quoted ? trimmed.slice(1, -1).trim() : trimmed;
}

/** `set (…abcd)` or `not set`. Never the key, whatever its length. */
export function maskKey(key: string | null | undefined): string {
  if (key === null || key === undefined || key === "") return "not set";
  return key.length < 4 ? "set" : `set (…${key.slice(-4)})`;
}

/** Deletes every occurrence of the key, so no error can carry it outward. */
export function redact(text: string, key: string | null | undefined): string {
  if (key === null || key === undefined || key === "") return text;
  return text.split(key).join("");
}

/**
 * Audio and the key go to the explicitly configured HTTP or HTTPS endpoint.
 * HTTP sends both in plaintext; HTTPS is the default. Redirects are refused
 * by the provider, and credentials belong in the separate key setting.
 */
export function requireSafeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WazapError("INVALID_ID", "Invalid transcription URL.", "Set WAZAP_TRANSCRIBE_URL to an http:// or https:// URL");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new WazapError(
      "INVALID_ID",
      "Transcription base URLs must not contain credentials, a query or a fragment.",
      "Use a base endpoint URL and set WAZAP_TRANSCRIBE_API_KEY separately"
    );
  }
  if (parsed.protocol === "https:" || parsed.protocol === "http:") return url;
  throw new WazapError(
    "INVALID_ID",
    "Transcription URLs must use HTTP or HTTPS.",
    "Set WAZAP_TRANSCRIBE_URL to the final http:// or https:// endpoint"
  );
}

function parseProvider(raw: string | undefined): ProviderName | null {
  const value = stripPasted(raw ?? "").toLowerCase();
  if (OFF.has(value)) return null;
  if (value === "local" || value === "openai") return value;
  throw new WazapError(
    "INVALID_ID",
    `Unknown transcription provider "${value}".`,
    "Set WAZAP_TRANSCRIBE to local, openai or off"
  );
}

function parseModel(raw: string | undefined): ModelAlias {
  const value = stripPasted(raw ?? "").toLowerCase();
  if (value === "") return "turbo";
  if ((MODEL_ALIASES as readonly string[]).includes(value)) return value as ModelAlias;
  throw new WazapError(
    "INVALID_ID",
    `Unknown whisper model "${value}".`,
    `Set WAZAP_WHISPER_MODEL to one of: ${MODEL_ALIASES.join(", ")}`
  );
}

/** off disables background work; auto preserves provider behavior; on also opts in own API notes. */
function autoMode(raw: string | undefined, fallback: boolean): { enabled: boolean; own: boolean } {
  const value = stripPasted(raw ?? "").toLowerCase();
  if (value === "") return { enabled: fallback, own: false };
  if (["off", "0", "false", "no"].includes(value)) return { enabled: false, own: false };
  if (["auto", "1", "true", "yes"].includes(value)) return { enabled: true, own: false };
  if (value === "on") return { enabled: true, own: true };
  throw new WazapError("INVALID_ID", "WAZAP_TRANSCRIBE_AUTO must be off, auto or on.", "Use off (0), auto (1) or on for all eligible new voice notes");
}

function orNull(raw: string | undefined): string | null {
  const value = stripPasted(raw ?? "");
  return value === "" ? null : value;
}

function apiPermission(raw: string | undefined): boolean {
  const value = stripPasted(raw ?? "").toLowerCase();
  if (OFF.has(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  throw new WazapError("INVALID_ID", "WAZAP_TRANSCRIBE_ALLOW_API must be on or off.", "Set it to 1 only after approving audio uploads and provider charges");
}

function authHeader(raw: string | undefined): "Authorization" | "x-bf-vk" {
  const value = stripPasted(raw ?? "Authorization").toLowerCase();
  if (value === "authorization") return "Authorization";
  if (value === "x-bf-vk") return "x-bf-vk";
  throw new WazapError("INVALID_ID", "Unsupported transcription credential header.", "Set WAZAP_TRANSCRIBE_AUTH_HEADER to Authorization or x-bf-vk");
}

export function readTranscribeSettings(env: NodeJS.ProcessEnv, dataDir: string): TranscribeSettings {
  const provider = parseProvider(env.WAZAP_TRANSCRIBE);
  const url = orNull(env.WAZAP_TRANSCRIBE_URL) ?? DEFAULT_URL;
  const allowApi = apiPermission(env.WAZAP_TRANSCRIBE_ALLOW_API);
  const automatic = autoMode(env.WAZAP_TRANSCRIBE_AUTO, !(provider === "openai" && allowApi));
  return {
    provider,
    language: "auto",
    auto: provider !== null && automatic.enabled,
    autoOwn: automatic.own,
    model: parseModel(env.WAZAP_WHISPER_MODEL),
    whisperBin: orNull(env.WAZAP_WHISPER_BIN),
    apiKey: orNull(env.WAZAP_TRANSCRIBE_API_KEY) ?? orNull(env.OPENAI_API_KEY),
    allowApi,
    apiAuthHeader: authHeader(env.WAZAP_TRANSCRIBE_AUTH_HEADER),
    baseUrl: requireSafeUrl(url.replace(/\/+$/, "")),
    apiModel: orNull(env.WAZAP_TRANSCRIBE_MODEL) ?? DEFAULT_API_MODEL,
    modelsDir: join(dataDir, "models"),
  };
}
