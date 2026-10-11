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
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
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
 * Audio leaves the machine over this URL and the key rides with it, so plain
 * http is refused unless it points back at this machine.
 */
export function requireSafeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WazapError("INVALID_ID", "Invalid transcription URL.", "Set WAZAP_TRANSCRIBE_URL to an https:// URL");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new WazapError(
      "INVALID_ID",
      "Transcription base URLs must not contain credentials, a query or a fragment.",
      "Use a base endpoint URL and set WAZAP_TRANSCRIBE_API_KEY separately"
    );
  }
  if (parsed.protocol === "https:") return url;
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (parsed.protocol === "http:" && LOOPBACK.has(host)) return url;
  throw new WazapError(
    "INVALID_ID",
    "Refusing a non-https transcription URL.",
    "Use an https:// URL, or http:// on 127.0.0.1 for a local server"
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

function asBool(raw: string | undefined, fallback: boolean): boolean {
  const value = stripPasted(raw ?? "");
  if (value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function orNull(raw: string | undefined): string | null {
  const value = stripPasted(raw ?? "");
  return value === "" ? null : value;
}

export function readTranscribeSettings(env: NodeJS.ProcessEnv, dataDir: string): TranscribeSettings {
  const provider = parseProvider(env.WAZAP_TRANSCRIBE);
  const url = orNull(env.WAZAP_TRANSCRIBE_URL) ?? DEFAULT_URL;
  const allowApi = asBool(env.WAZAP_TRANSCRIBE_ALLOW_API, false);
  // Uploads allowed only by ALLOW_API wait to be asked, unless AUTO says otherwise.
  const all = stripPasted(env.WAZAP_TRANSCRIBE_AUTO ?? "").toLowerCase() === "all";
  return {
    provider,
    language: "auto",
    auto: provider !== null && (all || asBool(env.WAZAP_TRANSCRIBE_AUTO, !(provider === "openai" && allowApi))),
    autoOwn: all,
    model: parseModel(env.WAZAP_WHISPER_MODEL),
    whisperBin: orNull(env.WAZAP_WHISPER_BIN),
    apiKey: orNull(env.WAZAP_TRANSCRIBE_API_KEY) ?? orNull(env.OPENAI_API_KEY),
    allowApi,
    baseUrl: requireSafeUrl(url.replace(/\/+$/, "")),
    apiModel: orNull(env.WAZAP_TRANSCRIBE_MODEL) ?? DEFAULT_API_MODEL,
    modelsDir: join(dataDir, "models"),
  };
}
