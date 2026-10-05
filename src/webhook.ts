/**
 * W1 outbound webhook: three live events (`message_received`, `message_sent`
 * and `connection`), of which only `message_received` is posted unless
 * `WAZAP_WEBHOOK_EVENTS` asks for more. Global URL, secret, event list, chat
 * allowlist, coalescing window and the optional 401 retry live in `.env`; an
 * account may override any of them. This module is the settings, the payloads
 * and a single POST; the durable queue that decides when to post, and retries,
 * is src/webhook-outbox.ts. Who a message may be posted for is
 * src/webhook-filter.ts. Nothing here throws into the WhatsApp or MCP path.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { WAZAP_VERSION } from "./config.js";
import { WazapError, asWazapError } from "./errors.js";
import { logError } from "./logger.js";
import { normalizeSendRule } from "./send-guard.js";
import { redact, stripPasted } from "./transcribe/index.js";
import { discardResponse } from "./http-response.js";
import { withCode } from "./error-code.js";
import type { ConnectionStatus, HealthState, MessageType, MessageView, WebhookDelivery, WebhookInfo } from "./wa-types.js";

export const WEBHOOK_EVENTS = ["message_received", "message_sent", "connection"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** What `webhook test` posts when `--event` does not name another one. */
export const WEBHOOK_EVENT = "message_received" as const;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_TEXT_MAX = 2000;
/** `webhook test` retries a probe that may pass on its own this soon; the outbox has its own schedule. */
export const WEBHOOK_TEST_RETRY_DELAYS_MS = [200, 500] as const;
/** Failed events in a row before doctor calls delivery broken rather than flaky. */
export const WEBHOOK_FAILING_AFTER = 3;
export const WEBHOOK_ON_FIX = "run `wazap config webhook on`";
export const WEBHOOK_URL_FIX = "set WAZAP_WEBHOOK_URL to an https:// URL, or http:// on 127.0.0.1";
export const WEBHOOK_TEST_FIX = "run `wazap webhook test`";
export const WEBHOOK_EVENT_FIX = `pass one of ${WEBHOOK_EVENTS.join(", ")}`;
export const WEBHOOK_EVENTS_DEFAULT: readonly WebhookEvent[] = ["message_received"] as const;
export const WEBHOOK_EVENTS_FIX = `set WAZAP_WEBHOOK_EVENTS to all or a comma-separated list of ${WEBHOOK_EVENTS.join(", ")}`;
export const WEBHOOK_AUTH_FIX =
  "run `wazap config webhook auth` and paste what the receiver expects: `Bearer <token>` for Authorization, or `<Header-Name>: <value>`";
/** A burst waits at most this long after its first message, however fast the chat keeps going. */
export const WEBHOOK_COALESCE_MAX_S = 300;
/** The same limit `remember` stores a tag under. A longer one could never match. */
const WEBHOOK_TAG_MAX = 40;
const WEBHOOK_CHATS_MAX = 200;
export const WEBHOOK_CHATS_FIX =
  'set WAZAP_WEBHOOK_CHATS to comma-separated chat ids or numbers, `none` for an empty list, or run `wazap config webhook chats off`';
export const WEBHOOK_TAG_FIX = 'set WAZAP_WEBHOOK_TAG to a short label like "autopeloc", or run `wazap config webhook tag off`';
export const WEBHOOK_COALESCE_FIX = `set WAZAP_WEBHOOK_COALESCE to a whole number of seconds from 1 to ${WEBHOOK_COALESCE_MAX_S}, or off`;
export const WEBHOOK_RETRY_401_FIX = "set WAZAP_WEBHOOK_RETRY_401 to on or off";

/** Headers wazap sets itself, and the ones fetch owns: the auth setting cannot replace them. */
const RESERVED_HEADERS = new Set([
  "content-type",
  "content-length",
  "user-agent",
  "host",
  "connection",
  "transfer-encoding",
  "x-wazap-event",
  "x-wazap-signature",
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export const WEBHOOK_KINDS = ["text", "audio", "image", "other"] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];

export type WebhookConnectionStatus = "linked" | "disconnected" | "expired";

const OFF = new Set(["", "off", "0", "no", "none", "false"]);
const ON = new Set(["on", "1", "true", "yes"]);
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** A header the receiver asks for on top of wazap's signature: `Authorization` unless the setting names another. */
export interface WebhookAuth {
  name: string;
  value: string;
}

/**
 * Which chats a message event may name. Absent (`null` on the ready settings)
 * posts every chat, as before. Present posts a chat on the list or, for a
 * direct chat, one whose contact carries `tag`. An empty list and no tag posts
 * nothing. Groups match the list only.
 */
export interface WebhookFilter {
  chats: readonly string[];
  tag: string | null;
}

/** How long a chat's messages wait to share one POST, and the latest that wait may run. */
export interface WebhookCoalesce {
  windowMs: number;
  capMs: number;
}

export type WebhookSettings =
  | { kind: "off" }
  | {
      kind: "ready";
      url: string;
      secret: string;
      events: readonly WebhookEvent[];
      auth?: WebhookAuth;
      /** Null posts every chat. */
      filter: WebhookFilter | null;
      /** Null posts one event per message. */
      coalesce: WebhookCoalesce | null;
      /** A 401 is retried on the same schedule as a 5xx. Off unless asked. */
      retryUnauthorized: boolean;
    }
  | { kind: "invalid"; detail: string; fix: string };

/**
 * Per-account values win over the global ones. `filter` set, even empty,
 * replaces the global allowlist rather than merging with it; left unset, the
 * global allowlist applies. `coalesce` null forces the window off.
 */
export interface WebhookOverride {
  url?: string;
  secret?: string;
  events?: string;
  auth?: string;
  filter?: WebhookFilter | null;
  coalesce?: number | null;
  retryUnauthorized?: boolean;
}

/** The account the payload names, and whose override the sink prefers. */
export interface WebhookAccount {
  id: string;
  name: string;
  webhook_url?: string;
  webhook_secret?: string;
  webhook_events?: string;
  webhook_auth?: string;
  /** Present, even empty, replaces the global chat list. */
  webhook_chats?: readonly string[];
  /** Present replaces the global tag. The chats and the tag together are the account's filter. */
  webhook_tag?: string;
  /** Seconds. `0` forces coalescing off for this account. */
  webhook_coalesce?: number;
  webhook_retry_401?: boolean;
}

export type WebhookReady = Extract<WebhookSettings, { kind: "ready" }>;

/** The JSON body of a message event. HMAC is over this exact UTF-8 string. */
export interface WebhookMessagePayload {
  event: "message_received" | "message_sent";
  from: string;
  /** The sender's contact in this account's database: one id however the sender is spelled, kept when the number behind a lid becomes known. */
  contact_id: number | null;
  /** The sender's number in E.164 (`+40…`), when WhatsApp revealed it. */
  phone: string | null;
  chat_id: string;
  ts: string;
  timestamp: string;
  text: string;
  truncated: boolean;
  kind: WebhookKind;
  from_me: boolean;
  is_self_chat: boolean;
  message_id: string;
  account_id: string;
  account_name: string;
  /**
   * Set only when this POST carries more than one message from the chat.
   * The fields above stay the latest message, so a reader that ignores what
   * it does not know still sees that one.
   */
  count?: number;
  message_ids?: string[];
  texts?: string[];
  /** The first message's `ts` and `timestamp`. */
  first_ts?: string;
  first_timestamp?: string;
}

/** What WhatsApp says about the account itself, as get_status's `health` says it. */
export interface WebhookHealth {
  state: HealthState;
  until: string | null;
  reason: string | null;
}

export interface WebhookConnectionPayload {
  event: "connection";
  status: WebhookConnectionStatus;
  timestamp: string;
  account_id: string;
  account_name: string;
  /** Absent only on an event queued by a wazap older than the field. */
  health?: WebhookHealth;
}

export type WebhookPayload = WebhookMessagePayload | WebhookConnectionPayload;

/** The preview and whether it had to be cut, so the payload never decides twice. */
export interface WebhookText {
  text: string;
  truncated: boolean;
}

/** A message event, as the service knows it at the moment it posts. */
export interface WebhookMessageEvent {
  event: "message_received" | "message_sent";
  view: MessageView;
  account: Pick<WebhookAccount, "id" | "name">;
  isSelfChat: boolean;
}

export interface WebhookConnectionEvent {
  status: WebhookConnectionStatus;
  account: Pick<WebhookAccount, "id" | "name">;
  at: number;
  health?: WebhookHealth;
}

export type WebhookTestResult = { ok: true } | { ok: false; error: string; fix: string };

/**
 * One POST: the HTTP status when there was one, and on a failure whether the
 * same request may pass later (a timeout, an unreachable host, 408, 425, 429,
 * 5xx) or is refused for good (any other 4xx).
 */
export type WebhookAttempt =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string; fix: string; retry: boolean };

const WEBHOOK_REACH_FIX = "check the webhook URL is reachable and returns 2xx";

export type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Test seams and the account whose override the sink prefers. */
export interface WebhookSinkOptions {
  post?: WebhookFetch;
  /** What `webhook test` waits between retries of a probe. */
  retryDelays?: readonly number[];
  account?: WebhookAccount;
}

/** The one place the webhook environment becomes typed. */
export function readWebhookSettings(
  env: NodeJS.ProcessEnv = process.env,
  override: WebhookOverride = {}
): WebhookSettings {
  const raw = stripPasted(env.WAZAP_WEBHOOK ?? "");
  const flag = raw.toLowerCase();
  if (OFF.has(flag)) return { kind: "off" };
  if (!ON.has(flag)) {
    return {
      kind: "invalid",
      detail: `unknown setting "${raw}"`,
      fix: "set WAZAP_WEBHOOK to on or off",
    };
  }

  const overrideUrl = stripPasted(override.url ?? "");
  const overrideSecret = stripPasted(override.secret ?? "");
  const urlRaw = (overrideUrl || stripPasted(env.WAZAP_WEBHOOK_URL ?? "")).replace(/\/+$/, "");
  const secret = overrideSecret || stripPasted(env.WAZAP_WEBHOOK_SECRET ?? "");
  const overrideEvents = stripPasted(override.events ?? "");
  const eventsRaw = overrideEvents || stripPasted(env.WAZAP_WEBHOOK_EVENTS ?? "");
  const missingUrl = urlRaw === "";
  const missingSecret = secret === "";
  if (missingUrl && missingSecret) {
    return { kind: "invalid", detail: "on without a URL or a secret", fix: WEBHOOK_ON_FIX };
  }
  if (missingUrl) return { kind: "invalid", detail: "on without a URL", fix: WEBHOOK_ON_FIX };
  if (missingSecret) return { kind: "invalid", detail: "on without a secret", fix: WEBHOOK_ON_FIX };

  const authRaw = stripPasted(override.auth ?? "") || stripPasted(env.WAZAP_WEBHOOK_AUTH ?? "");

  try {
    const auth = parseWebhookAuth(authRaw);
    return {
      kind: "ready",
      url: requireWebhookUrl(urlRaw),
      secret,
      events: parseWebhookEvents(eventsRaw),
      ...(auth === null ? {} : { auth }),
      filter: resolveWebhookFilter(env, override),
      coalesce: resolveWebhookCoalesce(env, override),
      retryUnauthorized: resolveWebhookRetry401(env, override),
    };
  } catch (err) {
    const failure = asWazapError(err);
    return { kind: "invalid", detail: failure.message, fix: failure.fix ?? WEBHOOK_URL_FIX };
  }
}

function resolveWebhookFilter(env: NodeJS.ProcessEnv, override: WebhookOverride): WebhookFilter | null {
  if (override.filter !== undefined) return override.filter;
  const chatsSet = Object.prototype.hasOwnProperty.call(env, "WAZAP_WEBHOOK_CHATS");
  const tagRaw = stripPasted(env.WAZAP_WEBHOOK_TAG ?? "");
  const tag = tagRaw === "" ? null : requireWebhookTag(tagRaw);
  if (!chatsSet && tag === null) return null;
  return { chats: chatsSet ? parseWebhookChats(stripPasted(env.WAZAP_WEBHOOK_CHATS ?? "")) : [], tag };
}

function resolveWebhookCoalesce(env: NodeJS.ProcessEnv, override: WebhookOverride): WebhookCoalesce | null {
  if (override.coalesce !== undefined) {
    if (override.coalesce === null || override.coalesce === 0) return null;
    return coalesceOf(requireCoalesceSeconds(override.coalesce));
  }
  if (!Object.prototype.hasOwnProperty.call(env, "WAZAP_WEBHOOK_COALESCE")) return null;
  const raw = stripPasted(env.WAZAP_WEBHOOK_COALESCE ?? "");
  if (raw === "" || OFF.has(raw.toLowerCase())) return null;
  return coalesceOf(requireCoalesceSeconds(raw));
}

function resolveWebhookRetry401(env: NodeJS.ProcessEnv, override: WebhookOverride): boolean {
  if (override.retryUnauthorized !== undefined) return override.retryUnauthorized;
  const raw = stripPasted(env.WAZAP_WEBHOOK_RETRY_401 ?? "");
  if (raw === "") return false;
  const flag = raw.toLowerCase();
  if (ON.has(flag)) return true;
  if (OFF.has(flag)) return false;
  throw new WazapError("INVALID_ID", `Unknown webhook retry setting "${raw}".`, WEBHOOK_RETRY_401_FIX);
}

/**
 * Chat ids and phone numbers, comma-separated, as `WAZAP_WEBHOOK_CHATS` or
 * `wazap config webhook chats` takes them. An empty string is an empty list.
 * A bad entry fails the webhook rather than being skipped.
 */
export function parseWebhookChats(raw: string): string[] {
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
  if (tokens.length > WEBHOOK_CHATS_MAX) {
    throw new WazapError("INVALID_ID", `A webhook allowlist holds at most ${WEBHOOK_CHATS_MAX} chats.`, WEBHOOK_CHATS_FIX);
  }
  const chats: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    let normalized: string;
    try {
      normalized = normalizeSendRule(token);
    } catch (err) {
      throw new WazapError("INVALID_ID", asWazapError(err).message, WEBHOOK_CHATS_FIX);
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    chats.push(normalized);
  }
  return chats;
}

/** The same spelling `remember` stores: lowercase, no leading "#", spaces as hyphens. */
export function normalizeWebhookTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/^#+/, "").replace(/\s+/g, "-");
}

export function requireWebhookTag(raw: string): string {
  const tag = normalizeWebhookTag(raw);
  if (tag === "" || tag.length > WEBHOOK_TAG_MAX) {
    throw new WazapError("INVALID_ID", `"${raw}" is not a usable webhook tag.`, WEBHOOK_TAG_FIX);
  }
  return tag;
}

export function requireCoalesceSeconds(raw: string | number): number {
  const seconds = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > WEBHOOK_COALESCE_MAX_S) {
    throw new WazapError(
      "INVALID_ID",
      `Webhook coalescing must be a whole number of seconds from 1 to ${WEBHOOK_COALESCE_MAX_S}.`,
      WEBHOOK_COALESCE_FIX
    );
  }
  return seconds;
}

/** The window and the cap for a coalescing setting of `seconds`. The cap is twice the window, and never past five minutes. */
export function coalesceOf(seconds: number): WebhookCoalesce {
  const windowMs = seconds * 1000;
  return { windowMs, capMs: Math.min(windowMs * 2, WEBHOOK_COALESCE_MAX_S * 1000) };
}

/**
 * What `wazap config` and status say about the allowlist. Null when none is
 * configured. `empty` posts no message events.
 */
export function describeWebhookFilter(filter: WebhookFilter | null): string | null {
  if (filter === null) return null;
  if (filter.chats.length === 0 && filter.tag === null) return "empty";
  const parts: string[] = [];
  if (filter.tag !== null) parts.push(`tag ${filter.tag}`);
  if (filter.chats.length > 0) {
    const n = filter.chats.length;
    parts.push(`${n} ${n === 1 ? "chat" : "chats"}`);
  }
  return parts.join(", ");
}

/** The parenthetical `on (host)` doctor and status use, with the filter and the window when they are set. */
export function webhookReadyDetail(settings: WebhookReady): string {
  const host = new URL(settings.url).host;
  const notes: string[] = [];
  const filter = describeWebhookFilter(settings.filter);
  if (filter !== null) notes.push(filter === "empty" ? "filter empty" : `filter ${filter}`);
  if (settings.coalesce !== null) {
    notes.push(`coalesce ${settings.coalesce.windowMs / 1000}s, by ${settings.coalesce.capMs / 1000}s`);
  }
  if (settings.retryUnauthorized) notes.push("retry 401");
  return notes.length === 0 ? `on (${host})` : `on (${host}); ${notes.join("; ")}`;
}

/**
 * The body is posted over this URL and the secret signs it, so plain http is
 * refused unless it points back at this machine.
 */
export function requireWebhookUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WazapError("INVALID_ID", "Invalid webhook URL.", WEBHOOK_URL_FIX);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new WazapError(
      "INVALID_ID",
      "Webhook URLs must not contain userinfo credentials or a fragment.",
      WEBHOOK_URL_FIX
    );
  }
  if (parsed.protocol === "https:") return url;
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (parsed.protocol === "http:" && LOOPBACK.has(host)) return url;
  throw new WazapError("INVALID_ID", "Refusing a non-https webhook URL.", WEBHOOK_URL_FIX);
}

/**
 * `WAZAP_WEBHOOK_AUTH` as an operator typed it: `Bearer <token>` (or any
 * value) goes out as `Authorization`, and `<Header-Name>: <value>` as that
 * header, for a receiver that wants `X-Api-Key` or the like. Unset is null.
 * The value is a credential: no error here repeats it.
 */
export function parseWebhookAuth(raw: string): WebhookAuth | null {
  const typed = raw.trim();
  if (typed === "") return null;
  // A header line puts a token, a colon and a space first; "Bearer abc:def" has a space before its colon.
  const named = /^([^\s:]+):\s*(.*)$/.exec(typed);
  const auth = named !== null ? { name: named[1]!, value: named[2]!.trim() } : { name: "Authorization", value: typed };
  if (!HEADER_NAME.test(auth.name)) {
    throw new WazapError("INVALID_ID", "The webhook auth header has a name no HTTP header can have.", WEBHOOK_AUTH_FIX);
  }
  if (RESERVED_HEADERS.has(auth.name.toLowerCase())) {
    throw new WazapError("INVALID_ID", `The webhook auth cannot set ${auth.name}: wazap sets it itself.`, WEBHOOK_AUTH_FIX);
  }
  if (auth.value === "") {
    throw new WazapError("INVALID_ID", `The webhook auth names ${auth.name} but gives it no value.`, WEBHOOK_AUTH_FIX);
  }
  // A line break would start a header of its own; no printable value needs a control character.
  if ([...auth.value].some((char) => (char < " " && char !== "\t") || char === "\u007f")) {
    throw new WazapError("INVALID_ID", "The webhook auth value holds a line break or a control character.", WEBHOOK_AUTH_FIX);
  }
  return auth;
}

/** `sha256=<hex>` of the exact UTF-8 body, the value of `X-Wazap-Signature`. */
export function webhookSignature(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Timing-safe compare of a received signature header to the body we signed. */
export function webhookSignatureMatches(body: string, secret: string, header: string): boolean {
  const expected = Buffer.from(webhookSignature(body, secret));
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function previewText(text: string): WebhookText {
  if (text.length <= WEBHOOK_TEXT_MAX) return { text, truncated: false };
  return { text: `${text.slice(0, WEBHOOK_TEXT_MAX - 1)}…`, truncated: true };
}

/**
 * Every message type collapses into one of four buckets a consumer can switch
 * on. A recorded note (`voice`) and an attached file (`audio`) share `audio`,
 * because both carry speech and both can arrive transcribed.
 */
const KIND_BY_TYPE: Record<MessageType, WebhookKind> = {
  text: "text",
  image: "image",
  audio: "audio",
  voice: "audio",
  video: "other",
  document: "other",
  sticker: "other",
  location: "other",
  contact: "other",
  poll: "other",
  reaction: "other",
  deleted: "other",
  view_once: "other",
  call: "other",
  event: "other",
  invite: "other",
  system: "other",
  unknown: "other",
};

/**
 * `--event` as typed on the command line. The one place a string becomes an
 * event, so nothing downstream has to widen the union back to `string`.
 */
export function parseWebhookEvent(raw: string | undefined): WebhookEvent {
  if (raw === undefined) return WEBHOOK_EVENT;
  const value = raw.trim();
  const known = WEBHOOK_EVENTS.find((event) => event === value);
  if (known === undefined) {
    throw new WazapError("INVALID_ID", `Unknown webhook event "${raw}".`, WEBHOOK_EVENT_FIX);
  }
  return known;
}

/**
 * `WAZAP_WEBHOOK_EVENTS` as an operator typed it. An unset list is the 0.16.0
 * set, so a consumer that answers every POST without reading `event` keeps
 * hearing only what it already handled.
 */
export function parseWebhookEvents(raw: string): readonly WebhookEvent[] {
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
  if (tokens.length === 0) return WEBHOOK_EVENTS_DEFAULT;
  const wanted = new Set<WebhookEvent>();
  for (const token of tokens) {
    const value = token.toLowerCase();
    if (value === "all") {
      for (const event of WEBHOOK_EVENTS) wanted.add(event);
      continue;
    }
    const known = WEBHOOK_EVENTS.find((event) => event === value);
    if (known === undefined) {
      throw new WazapError("INVALID_ID", `Unknown webhook event "${token}".`, WEBHOOK_EVENTS_FIX);
    }
    wanted.add(known);
  }
  return WEBHOOK_EVENTS.filter((event) => wanted.has(event));
}

/** An event list as a phrase for a person: "messages you receive and link changes". */
export function describeWebhookEvents(events: readonly WebhookEvent[]): string {
  const phrases: Record<WebhookEvent, string> = {
    message_received: "messages you receive",
    message_sent: "messages you send from your phone or another device",
    connection: "link changes",
  };
  const list = events.map((event) => phrases[event]);
  if (list.length <= 1) return list[0] ?? "nothing";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

export function webhookKind(type: MessageType): WebhookKind {
  return KIND_BY_TYPE[type];
}

/**
 * `null` is a state nobody outside wazap can act on, so it posts nothing:
 * `linking` and `connecting` are steps on the way to `connected`, and
 * `not_linked` is the state before any credentials exist. Every credential
 * failure collapses to `expired`, the one thing a consumer does something about.
 */
const CONNECTION_STATUS: Record<ConnectionStatus, WebhookConnectionStatus | null> = {
  not_linked: null,
  linking: null,
  connecting: null,
  connected: "linked",
  disconnected: "disconnected",
  logged_out: "expired",
  session_corrupt: "expired",
  auth_failure: "expired",
};

export function webhookConnectionStatus(status: ConnectionStatus): WebhookConnectionStatus | null {
  return CONNECTION_STATUS[status];
}

/**
 * The same instant as the local-offset `ts`, never a fresh read of the clock. The
 * instant is the sender's to state, and a peer that states a nonsense one would
 * otherwise cost the whole delivery, so an unparseable `ts` costs this one field.
 */
function utcTimestamp(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
}

export function asWebhookPayload({ event, view, account, isSelfChat }: WebhookMessageEvent): WebhookMessagePayload {
  const { text, truncated } = previewText(view.transcript ?? view.text);
  return {
    event,
    from: view.sender.phone ?? view.sender.id,
    contact_id: view.sender.contact_id ?? null,
    phone: view.sender.phone === undefined ? null : `+${view.sender.phone}`,
    chat_id: view.chat_id,
    ts: view.timestamp,
    timestamp: utcTimestamp(view.timestamp),
    text,
    truncated,
    kind: webhookKind(view.type),
    from_me: view.from_me,
    is_self_chat: isSelfChat,
    message_id: view.message_id,
    account_id: account.id,
    account_name: account.name,
  };
}

/**
 * Several message payloads become one. The singular fields stay the latest
 * message. The added fields name the whole burst, oldest first. One payload
 * is returned unchanged, so a chat that only said one thing looks as it did
 * before coalescing existed.
 */
export function coalescePayloads(payloads: readonly WebhookPayload[]): WebhookPayload {
  if (payloads.length <= 1) return payloads[0]!;
  const messages = payloads.filter((payload): payload is WebhookMessagePayload => payload.event !== "connection");
  if (messages.length !== payloads.length) return payloads[payloads.length - 1]!;
  const first = messages[0]!;
  const last = messages[messages.length - 1]!;
  return {
    ...last,
    count: messages.length,
    message_ids: messages.map((payload) => payload.message_id),
    texts: messages.map((payload) => payload.text),
    first_ts: first.ts,
    first_timestamp: first.timestamp,
  };
}

export function asConnectionPayload({ status, account, at, health }: WebhookConnectionEvent): WebhookConnectionPayload {
  return {
    event: "connection",
    status,
    timestamp: new Date(at).toISOString(),
    account_id: account.id,
    account_name: account.name,
    ...(health === undefined ? {} : { health }),
  };
}

export function webhookInfo(
  settings: WebhookSettings,
  lastError: string | null,
  delivery?: WebhookDelivery
): WebhookInfo {
  switch (settings.kind) {
    case "off":
      return { enabled: false, valid: true, last_error: null };
    case "ready": {
      const filter = describeWebhookFilter(settings.filter);
      const extra = {
        ...(filter === null ? {} : { allowlist: filter }),
        ...(settings.coalesce === null ? {} : { coalesce_seconds: settings.coalesce.windowMs / 1000 }),
        ...(settings.retryUnauthorized ? { retry_unauthorized: true as const } : {}),
      };
      return delivery === undefined
        ? { enabled: true, valid: true, last_error: lastError, ...extra }
        : { enabled: true, valid: true, last_error: lastError, delivery, ...extra };
    }
    case "invalid":
      return { enabled: true, valid: false, last_error: settings.detail };
    default: {
      const _exhaustive: never = settings;
      return _exhaustive;
    }
  }
}

/**
 * The webhook as configured for one account: its settings, a single POST of a
 * payload, and the probe `webhook test` sends. Never throws.
 */
export class WebhookSink {
  /** What the last probe failed with; the outbox keeps its own record in the account database. */
  lastError: string | null = null;
  private readonly post: WebhookFetch;
  private readonly retryDelays: readonly number[];
  private readonly account?: WebhookAccount;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    opts: WebhookSinkOptions = {}
  ) {
    this.post = opts.post ?? fetch;
    this.retryDelays = opts.retryDelays ?? WEBHOOK_TEST_RETRY_DELAYS_MS;
    this.account = opts.account;
  }

  settings(): WebhookSettings {
    const account = this.account;
    const override: WebhookOverride = {
      url: account?.webhook_url,
      secret: account?.webhook_secret,
      events: account?.webhook_events,
      auth: account?.webhook_auth,
    };
    // Chats and tag are one filter: setting either replaces the global list and tag together.
    if (account?.webhook_chats !== undefined || account?.webhook_tag !== undefined) {
      override.filter = { chats: account.webhook_chats ?? [], tag: account.webhook_tag ?? null };
    }
    if (account?.webhook_coalesce !== undefined) override.coalesce = account.webhook_coalesce;
    if (account?.webhook_retry_401 !== undefined) override.retryUnauthorized = account.webhook_retry_401;
    return readWebhookSettings(this.env, override);
  }

  /** The status block; `delivery` is what the account database says about the outbox. */
  info(delivery?: WebhookDelivery, lastError: string | null = this.lastError): WebhookInfo {
    return webhookInfo(this.settings(), lastError, delivery);
  }

  async sendTest(event: WebhookEvent = WEBHOOK_EVENT): Promise<WebhookTestResult> {
    const settings = this.settings();
    switch (settings.kind) {
      case "off":
        return { ok: false, error: "Webhook is off.", fix: WEBHOOK_ON_FIX };
      case "invalid":
        return { ok: false, error: settings.detail, fix: settings.fix };
      case "ready": {
        if (!settings.events.includes(event)) {
          return {
            ok: false,
            error: `Webhook event "${event}" is not enabled.`,
            fix: enableEventFix(settings.events, event, this.account),
          };
        }
        const result = await this.probe(testPayload(event, this.account), settings);
        if (!result.ok) logError("webhook", result.error);
        return result;
      }
      default: {
        const _exhaustive: never = settings;
        return _exhaustive;
      }
    }
  }

  /** The probe goes straight out, not through the outbox, retried briefly as a live POST once was. */
  private async probe(payload: WebhookPayload, settings: WebhookReady): Promise<WebhookTestResult> {
    const attempts = 1 + this.retryDelays.length;
    let last: WebhookAttempt = { ok: false, status: null, error: "webhook POST failed", fix: WEBHOOK_REACH_FIX, retry: false };
    for (let i = 0; i < attempts; i++) {
      last = await this.attempt(payload, settings);
      if (last.ok) {
        this.lastError = null;
        return { ok: true };
      }
      const delay = this.retryDelays[i];
      // A refusal would only be refused again, and each retry is one more POST
      // the receiver has to turn away.
      if (!last.retry || delay === undefined) break;
      logError("webhook", `${last.error}; retry ${i + 1}/${this.retryDelays.length}`);
      if (delay > 0) await sleep(delay);
    }
    const failed = last as Extract<WebhookAttempt, { ok: false }>;
    this.lastError = failed.error;
    return { ok: false, error: failed.error, fix: failed.fix };
  }

  /** One signed POST of `payload`, bounded by WEBHOOK_TIMEOUT_MS. Never throws. */
  async attempt(payload: WebhookPayload, settings: WebhookReady): Promise<WebhookAttempt> {
    let body: string;
    try {
      body = JSON.stringify(payload);
    } catch (err) {
      return { ok: false, status: null, error: `Webhook delivery failed${withCode(err)}.`, fix: WEBHOOK_REACH_FIX, retry: false };
    }
    try {
      const response = await this.post(settings.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": `wazap/${WAZAP_VERSION}`,
          "x-wazap-event": payload.event,
          "x-wazap-signature": webhookSignature(body, settings.secret),
          ...(settings.auth === undefined ? {} : { [settings.auth.name]: settings.auth.value }),
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      await discardResponse(response);
      if (response.ok) return { ok: true, status: response.status };
      const host = hostOf(settings.url);
      // A 401 is a refusal unless the operator asked for it to be retried. Cursor's
      // receiver has answered 401 for a moment and then accepted the same body.
      if (retryableStatus(response.status) || (response.status === 401 && settings.retryUnauthorized)) {
        return failAttempt(response.status, `HTTP ${response.status} from ${host}`, settings, WEBHOOK_REACH_FIX, true);
      }
      const refused = refusal(response.status);
      return failAttempt(
        response.status,
        `HTTP ${response.status} from ${host}, not retried: ${refused.hint}`,
        settings,
        refused.fix,
        false
      );
    } catch (err) {
      return failAttempt(null, describePostError(err, settings.url), settings, WEBHOOK_REACH_FIX, true);
    }
  }
}

/** A list is set whole, so enabling one event means naming the ones already on. */
function enableEventFix(active: readonly WebhookEvent[], event: WebhookEvent, account?: WebhookAccount): string {
  const both = WEBHOOK_EVENTS.filter((known) => active.includes(known) || known === event).join(",");
  if (account?.webhook_events === undefined) return `set WAZAP_WEBHOOK_EVENTS=${both}, or all`;
  return `set webhook_events for "${account.id}" in accounts.json to ${both}, or all`;
}

function testPayload(event: WebhookEvent, account?: Pick<WebhookAccount, "id" | "name">): WebhookPayload {
  const now = new Date().toISOString();
  const named = { account_id: account?.id ?? "default", account_name: account?.name ?? "default" };
  if (event === "connection") return { event, status: "linked", timestamp: now, ...named, health: { state: "ok", until: null, reason: null } };
  return {
    event,
    from: "wazap",
    contact_id: null,
    phone: null,
    chat_id: "test@s.whatsapp.net",
    ts: now,
    timestamp: now,
    text: "wazap webhook test",
    truncated: false,
    kind: "text",
    from_me: event === "message_sent",
    is_self_chat: false,
    message_id: "test",
    ...named,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "configured webhook endpoint";
  }
}

function describePostError(err: unknown, url: string): string {
  const host = hostOf(url);
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
    return `timed out reaching ${host}`;
  // ECONNREFUSED, ENOTFOUND or CERT_HAS_EXPIRED is the whole diagnosis; the
  // message around it may quote the URL, and the URL may carry a token.
  return `could not reach ${host}${withCode(err)}`;
}

/** A failure line never carries the secret or the auth value, however the error around it was worded. */
function failAttempt(status: number | null, error: string, settings: WebhookReady, fix: string, retry: boolean): WebhookAttempt {
  let line = redact(error, settings.secret);
  if (settings.auth !== undefined) {
    // The whole value, then the token after its scheme: an error may quote either.
    const { value } = settings.auth;
    line = redact(line, value);
    const space = value.indexOf(" ");
    if (space !== -1) line = redact(line, value.slice(space + 1).trim());
  }
  return { ok: false, status, error: line, fix, retry };
}

/**
 * What can pass on its own: a timeout, a rate limit, a receiver that is down.
 * Any other 4xx is the receiver refusing this exact request, and it would
 * refuse the retry the same way.
 */
export function retryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

/** A hint short enough to ride on the error line, and the repair that goes with it. */
function refusal(status: number): { hint: string; fix: string } {
  if (status === 401 || status === 403) {
    return {
      hint: "the receiver refuses the request; check the API key or secret it expects",
      fix: "give the receiver the API key or secret it expects, then run `wazap webhook test`",
    };
  }
  if (status === 404 || status === 410) {
    return {
      hint: "the receiver has no endpoint at that URL",
      fix: "point the webhook URL at the receiver's endpoint, then run `wazap webhook test`",
    };
  }
  if (status === 413) {
    return {
      hint: "the receiver refuses a body this size",
      fix: "raise the receiver's request size limit, then run `wazap webhook test`",
    };
  }
  return {
    hint: "the receiver refuses the request as sent",
    fix: "check what the receiver expects and what its log says, then run `wazap webhook test`",
  };
}

/** The repair for a failure as `last_failure` words it, for a reader in another process. */
export function webhookFailureFix(failure: string): string {
  const status = Number(/^HTTP (\d{3}) from /.exec(failure)?.[1]);
  if (Number.isInteger(status) && status >= 400 && !retryableStatus(status)) return refusal(status).fix;
  return "make the receiver reachable and answer 2xx, then run `wazap webhook test`";
}
