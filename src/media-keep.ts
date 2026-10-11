/**
 * Kept media: the settings that say which arriving media wazap downloads at
 * once and keeps beside the account database, so get_media still has it after
 * WhatsApp's servers let it go. The account part that does the keeping is
 * src/service/keep.ts; this file only reads the settings.
 *
 * A value that does not parse turns keeping off and costs a warning line at
 * startup (settingWarnings): a typo never makes wazap download more, or keep
 * more, than the person asked for.
 */

/**
 * A chat id or a phone number as send rules spell it (normalizeSendRule in
 * src/send-guard.ts, which this file cannot import without pulling the message
 * parser into config): `user@domain`, or the digits of a number.
 */
function chatEntry(entry: string): string | null {
  const trimmed = entry.trim();
  const at = trimmed.lastIndexOf("@");
  if (at !== -1) {
    const user = trimmed.slice(0, at).split(":")[0] ?? "";
    const domain = trimmed.slice(at + 1).toLowerCase();
    if (user !== "" && domain !== "") return `${user}@${domain}`;
  }
  const digits = trimmed.replace(/^\+/, "").replace(/[\s\-().]/g, "");
  return /^\d{3,}$/.test(digits) ? digits : null;
}

/** Which chats' media is kept. */
export type MediaKeepPolicy = "off" | "unmuted" | "all" | "chats";

/** The message types a kept file can come from. A view-once message is never one of them. */
export const MEDIA_KEEP_TYPES = ["image", "voice", "audio", "document", "video", "sticker"] as const;
export type MediaKeepType = (typeof MEDIA_KEEP_TYPES)[number];

export interface MediaKeepSettings {
  policy: MediaKeepPolicy;
  /** Chat ids and phone numbers: the only chats under `chats`, and kept even while muted under `unmuted`. */
  chats: string[];
  types: ReadonlySet<MediaKeepType>;
  /** A file bigger than this is not kept. */
  maxFileBytes: number;
  /** All of an account's kept files together stay under this; the oldest go first. */
  quotaBytes: number;
  /** A kept file older than this is removed; 0 keeps files until the quota needs the room. */
  maxAgeMs: number;
  /** What did not parse; non-empty means policy is `off`. */
  problems: string[];
}

const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export const MEDIA_KEEP_DEFAULTS = {
  policy: "unmuted" as MediaKeepPolicy,
  types: ["image", "voice", "audio", "document"] as MediaKeepType[],
  maxFileMb: 16,
  quotaMb: 1024,
  days: 90,
};

/** get_media never downloads more than 100 MB, so no kept file is bigger either. */
export const MEDIA_KEEP_MAX_FILE_MB = 100;
/** A quota beyond 1 TB is a typo, not a plan. */
const MEDIA_KEEP_MAX_QUOTA_MB = 1024 * 1024;
const MEDIA_KEEP_MAX_DAYS = 3650;
const MEDIA_KEEP_CHATS_MAX = 500;

/** Keeping nothing: what a service gets when its config says nothing, and what a bad value falls back to. */
export const MEDIA_KEEP_OFF: MediaKeepSettings = {
  policy: "off",
  chats: [],
  types: new Set(),
  maxFileBytes: 0,
  quotaBytes: 0,
  maxAgeMs: 0,
  problems: [],
};

function wholeNumber(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number, problems: string[]): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    problems.push(`${key} must be a whole number from ${min} to ${max}`);
    return fallback;
  }
  return Number(raw);
}

/**
 * The kept-media settings from the environment (`.env` already loaded):
 * WAZAP_MEDIA_KEEP, WAZAP_MEDIA_KEEP_CHATS, WAZAP_MEDIA_KEEP_TYPES,
 * WAZAP_MEDIA_KEEP_MAX_MB, WAZAP_MEDIA_KEEP_QUOTA_MB and WAZAP_MEDIA_KEEP_DAYS.
 * Never throws: what does not parse is in `problems`, and keeping is off.
 */
export function mediaKeepSettings(env: NodeJS.ProcessEnv = process.env): MediaKeepSettings {
  const problems: string[] = [];
  const rawPolicy = (env.WAZAP_MEDIA_KEEP ?? "").trim().toLowerCase();
  let policy: MediaKeepPolicy = MEDIA_KEEP_DEFAULTS.policy;
  if (rawPolicy !== "") {
    if (["off", "0", "false", "no"].includes(rawPolicy)) policy = "off";
    else if (["unmuted", "all", "chats"].includes(rawPolicy)) policy = rawPolicy as MediaKeepPolicy;
    else problems.push("WAZAP_MEDIA_KEEP must be off, unmuted, all or chats");
  }

  const chats: string[] = [];
  const tokens = (env.WAZAP_MEDIA_KEEP_CHATS ?? "").split(",").map((token) => token.trim()).filter((token) => token !== "");
  if (tokens.length > MEDIA_KEEP_CHATS_MAX) problems.push(`WAZAP_MEDIA_KEEP_CHATS holds at most ${MEDIA_KEEP_CHATS_MAX} chats`);
  else {
    for (const token of tokens) {
      const normalized = chatEntry(token);
      if (normalized === null) {
        problems.push("WAZAP_MEDIA_KEEP_CHATS takes chat ids and phone numbers, comma-separated");
        break;
      }
      if (!chats.includes(normalized)) chats.push(normalized);
    }
  }
  if (policy === "chats" && chats.length === 0 && problems.length === 0) {
    problems.push("WAZAP_MEDIA_KEEP=chats needs WAZAP_MEDIA_KEEP_CHATS");
  }

  let types: MediaKeepType[] = MEDIA_KEEP_DEFAULTS.types;
  const rawTypes = env.WAZAP_MEDIA_KEEP_TYPES?.trim();
  if (rawTypes !== undefined && rawTypes !== "") {
    const asked = rawTypes.split(",").map((token) => token.trim().toLowerCase()).filter((token) => token !== "");
    const unknown = asked.filter((token) => !(MEDIA_KEEP_TYPES as readonly string[]).includes(token));
    if (unknown.length > 0 || asked.length === 0) problems.push(`WAZAP_MEDIA_KEEP_TYPES takes ${MEDIA_KEEP_TYPES.join(", ")}`);
    else types = asked as MediaKeepType[];
  }

  const maxFileMb = wholeNumber(env, "WAZAP_MEDIA_KEEP_MAX_MB", MEDIA_KEEP_DEFAULTS.maxFileMb, 1, MEDIA_KEEP_MAX_FILE_MB, problems);
  const quotaMb = wholeNumber(env, "WAZAP_MEDIA_KEEP_QUOTA_MB", MEDIA_KEEP_DEFAULTS.quotaMb, 1, MEDIA_KEEP_MAX_QUOTA_MB, problems);
  const days = wholeNumber(env, "WAZAP_MEDIA_KEEP_DAYS", MEDIA_KEEP_DEFAULTS.days, 0, MEDIA_KEEP_MAX_DAYS, problems);

  if (problems.length > 0) return { ...MEDIA_KEEP_OFF, problems };
  if (policy === "off") return MEDIA_KEEP_OFF;
  return {
    policy,
    chats,
    types: new Set(types),
    maxFileBytes: maxFileMb * MB,
    quotaBytes: quotaMb * MB,
    maxAgeMs: days * DAY_MS,
    problems,
  };
}

/** One startup warning line per kept-media setting that did not parse. */
export function mediaKeepWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  return mediaKeepSettings(env).problems.map((problem) => `${problem}; media is not being kept until it is fixed.`);
}
