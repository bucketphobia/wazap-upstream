/**
 * The one place the recall environment becomes typed. A bad value is refused
 * here, once, and the caller decides between feature-off and a crash — the
 * server always chooses off.
 */
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WazapError } from "../errors.js";
import { stripPasted } from "../transcribe/index.js";
import { EMBED_MODELS } from "./models.js";
import type { EmbedApiSettings, EmbedModelAlias, RecallSettings } from "./types.js";

const OFF = new Set(["", "off", "0", "no", "none", "false"]);
const ON = new Set(["local", "on", "1", "yes", "true"]);
const MODEL_ALIASES: readonly EmbedModelAlias[] = ["embeddinggemma-300m", "e5-base-multilingual"];
/** The shared llama-server is stopped after this long without an embed; the next one starts it again. */
const EMBED_IDLE_MS = 30 * 60_000;

function parseEnabled(raw: string | undefined): boolean {
  const value = stripPasted(raw ?? "").toLowerCase();
  if (OFF.has(value)) return false;
  if (ON.has(value) || value === "openai") return true;
  throw new WazapError("INVALID_ID", `Unknown recall mode "${value}".`, "Set WAZAP_RECALL to local or off");
}

function parseModel(raw: string | undefined): EmbedModelAlias {
  const value = stripPasted(raw ?? "").toLowerCase();
  if (value === "") return "embeddinggemma-300m";
  if ((MODEL_ALIASES as readonly string[]).includes(value)) return value as EmbedModelAlias;
  throw new WazapError(
    "INVALID_ID",
    `Unknown embedding model "${value}".`,
    `Set WAZAP_EMBED_MODEL to one of: ${MODEL_ALIASES.join(", ")}`
  );
}

/**
 * The env wins over the model's own floor — a cosine that means "real match"
 * is the model's to price, the override is the user's.
 */
function parseMinSimilarity(raw: string | undefined, fallback: number): number {
  const value = stripPasted(raw ?? "");
  if (value === "") return fallback;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  throw new WazapError(
    "INVALID_ID",
    `WAZAP_RECALL_MIN_SIMILARITY must be a number between 0 and 1, got "${value}".`,
    "Fix WAZAP_RECALL_MIN_SIMILARITY or remove it"
  );
}

function parseUrl(raw: string | undefined): string | null {
  const value = stripPasted(raw ?? "");
  if (value === "") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
    if (url.username || url.password || url.search || url.hash) throw new Error("credentials or suffix");
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new WazapError("INVALID_ID", "WAZAP_EMBED_URL must be an HTTP(S) URL without credentials, query or fragment.", "Fix or remove WAZAP_EMBED_URL");
  }
}

export function readRecallSettings(env: NodeJS.ProcessEnv, dataDir: string): RecallSettings {
  if (stripPasted(env.WAZAP_RECALL ?? "").toLowerCase() === "openai") {
    const api = readApiSettings(env);
    const floor = requiredApi(env, "WAZAP_EMBED_API_MIN_SIMILARITY");
    const minSimilarity = Number(floor);
    if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
      throw new WazapError("INVALID_ID", "WAZAP_EMBED_API_MIN_SIMILARITY must be a number between 0 and 1.");
    }
    const space = [api.url, api.model, api.dims];
    // Preserve the existing default space; opting into retrieval-purpose semantics
    // changes embeddings and must refill retained documents under a new identity.
    if (api.inputType !== "none") space.push(api.inputType);
    const identity = createHash("sha256").update(JSON.stringify(space)).digest("hex");
    return { enabled: true, model: "embeddinggemma-300m", api, indexModel: `openai:${identity}`,
      embedBin: null, embedUrl: null, modelsDir: join(dataDir, "models"), embedIdleMs: EMBED_IDLE_MS, minSimilarity };
  }
  const embedBin = stripPasted(env.WAZAP_EMBED_BIN ?? "");
  const model = parseModel(env.WAZAP_EMBED_MODEL);
  return {
    enabled: parseEnabled(env.WAZAP_RECALL),
    model,
    embedBin: embedBin === "" ? null : embedBin,
    embedUrl: parseUrl(env.WAZAP_EMBED_URL),
    modelsDir: join(dataDir, "models"),
    embedIdleMs: EMBED_IDLE_MS,
    minSimilarity: parseMinSimilarity(env.WAZAP_RECALL_MIN_SIMILARITY, EMBED_MODELS[model].defaultMinSimilarity),
  };
}

/** Configuration errors name the field only: pasted values may contain secrets. */
function requiredApi(env: NodeJS.ProcessEnv, name: string): string {
  const value = stripPasted(env[name] ?? "");
  if (!value || /[\r\n\0]/u.test(value)) throw new WazapError("INVALID_ID", `${name} is required and must be a single line.`);
  return value;
}

function readApiSettings(env: NodeJS.ProcessEnv): EmbedApiSettings {
  let url: URL;
  try {
    url = new URL(requiredApi(env, "WAZAP_EMBED_API_URL"));
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("transport");
    if (url.username || url.password || url.search || url.hash) throw new Error("suffix");
  } catch {
    throw new WazapError("INVALID_ID", "WAZAP_EMBED_API_URL must use HTTPS (or loopback HTTP), without credentials, query or fragment.");
  }
  const dims = Number(requiredApi(env, "WAZAP_EMBED_API_DIMS"));
  if (!Number.isInteger(dims) || dims < 1 || dims > 4096) throw new WazapError("INVALID_ID", "WAZAP_EMBED_API_DIMS must be an integer from 1 to 4096.");
  const header = stripPasted(env.WAZAP_EMBED_AUTH_HEADER ?? "Authorization").toLowerCase();
  if (header !== "authorization" && header !== "x-bf-vk") throw new WazapError("INVALID_ID", "WAZAP_EMBED_AUTH_HEADER must be Authorization or x-bf-vk.");
  const inputType = stripPasted(env.WAZAP_EMBED_API_INPUT_TYPE ?? "none").toLowerCase();
  if (inputType !== "none" && inputType !== "direct" && inputType !== "extra_params") {
    throw new WazapError("INVALID_ID", "WAZAP_EMBED_API_INPUT_TYPE must be none, direct or extra_params.");
  }
  return { url: url.href.replace(/\/+$/, ""), key: requiredApi(env, "WAZAP_EMBED_API_KEY"),
    model: requiredApi(env, "WAZAP_EMBED_API_MODEL"), dims, authHeader: header === "authorization" ? "Authorization" : "x-bf-vk", inputType };
}
