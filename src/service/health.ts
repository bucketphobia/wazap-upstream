/**
 * What WhatsApp says about the account itself, as opposed to the link: a ban,
 * a temporary ban, a session another client took over, a client too old to be
 * let in, and the "reachout timelock" that stops a restricted account starting
 * chats with people it has never written to. Part of WhatsAppService
 * (src/whatsapp.ts), which feeds it the close codes, the timelock updates and
 * the refused sends it sees, and asks it before a send whether one may start.
 *
 * The close codes follow what WhatsApp's own web client and whatsmeow read off
 * the same wire: 401 logged out, 402 temporarily banned (with `code` and
 * `expire` on the failure node), 403 locked or banned (with WhatsApp's words in
 * `logout_message_header`), 406 banned, 440 replaced, 405 and 409 a client
 * WhatsApp no longer takes. Everything else is a dropped link, retried.
 */

import { WazapError } from "../errors.js";
import { isoWithOffset } from "../messages.js";
import type { HealthInfo, HealthState, NewChatCapStatus } from "../wa-types.js";

/** How a close is handled. */
export type CloseVerdict =
  | { kind: "logged_out" }
  | { kind: "transient" }
  | { kind: "banned" | "session_replaced" | "client_outdated"; detail: string | null; code: number }
  | { kind: "temporarily_banned"; until: number | null; reason: string | null; code: number };

/** The reachout timelock as Baileys reports it (fetchAccountReachoutTimelock, connection.update). */
export interface ReachoutLock {
  isActive?: boolean;
  timeEnforcementEnds?: Date | string | number;
  enforcementType?: string;
}

/** WhatsApp's report on its cap on first messages to new people (fetchNewChatMessageCap, message-capping.update). */
export interface NewChatCapReport {
  capping_status?: string;
  used_quota?: number;
  total_quota?: number;
  cycle_end_timestamp?: string | number;
}

const CAP_STATUSES: Record<string, NewChatCapStatus> = {
  NONE: "none",
  FIRST_WARNING: "first_warning",
  SECOND_WARNING: "second_warning",
  CAPPED: "capped",
};

/** A WhatsApp timestamp in seconds, or already in milliseconds; null when there is none. */
function whenOf(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** A temporary ban longer than this is treated as a ban: no reconnect is scheduled for it. */
export const TEMP_BAN_RETRY_MAX_MS = 7 * 24 * 3_600_000;

/** The Boom error Baileys closes with: `output.statusCode`, and the failure node's attributes on `data`. */
function codeOf(error: unknown): number | undefined {
  const code = (error as { output?: { statusCode?: unknown } } | undefined)?.output?.statusCode;
  return typeof code === "number" ? code : undefined;
}

function dataOf(error: unknown): Record<string, unknown> {
  const data = (error as { data?: unknown } | undefined)?.data;
  if (data === null || typeof data !== "object") return {};
  // A stream error carries the child node ({ tag, attrs }); a failure node carries its attributes directly.
  const attrs = (data as { attrs?: unknown }).attrs;
  return attrs !== null && typeof attrs === "object" ? { ...(data as object), ...(attrs as object) } : (data as Record<string, unknown>);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Whether WhatsApp itself closed the session: a `<failure>` node ("Connection Failure") or a
 * `<stream:error>` ("Stream Errored"). A proxy or firewall that refuses the WebSocket with the
 * same HTTP status arrives as "WebSocket Error (...)" and says nothing about the account.
 */
function fromWhatsApp(error: unknown): boolean {
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" && /^(Connection Failure|Stream Errored)/.test(message);
}

/** Baileys' own `logout()` ends the socket with this, before WhatsApp has said anything. */
function ownLogout(error: unknown): boolean {
  return (error as { message?: unknown } | undefined)?.message === "Intentional Logout";
}

/** Reads a close the way WhatsApp's own clients do. Unknown codes, and closes WhatsApp did not send, are a dropped link. */
export function classifyClose(error: unknown, now: number = Date.now()): CloseVerdict {
  const code = codeOf(error);
  const data = dataOf(error);
  // Only WhatsApp, or this process's own logout, unlinks the device. A proxy, a captive portal or a
  // firewall that answers the WebSocket upgrade with 401 says nothing about the session, and reading
  // it as a logout would invite a new link that throws good credentials away.
  if (code === 401) return fromWhatsApp(error) || ownLogout(error) ? { kind: "logged_out" } : { kind: "transient" };
  if (!fromWhatsApp(error)) return { kind: "transient" };
  if (code === 402) {
    const expire = Number(data.expire);
    return {
      kind: "temporarily_banned",
      until: Number.isFinite(expire) && expire > 0 ? now + expire * 1000 : null,
      reason: text(data.code) ?? (typeof data.code === "number" ? String(data.code) : null),
      code,
    };
  }
  if (code === 403 || code === 406) {
    const words = [text(data.logout_message_header), text(data.logout_message_subtext)].filter((part) => part !== null);
    return { kind: "banned", detail: words.length > 0 ? words.join(" ") : null, code };
  }
  if (code === 440 || data.type === "replaced") return { kind: "session_replaced", detail: null, code: code ?? 440 };
  if (code === 405 || code === 409) return { kind: "client_outdated", detail: null, code };
  return { kind: "transient" };
}

/** What the account can and cannot do right now, as far as WhatsApp has told this process. */
export class AccountHealth {
  private state: HealthState = "ok";
  private since: number | null = null;
  private until: number | null = null;
  private reason: string | null = null;
  private detail: string | null = null;
  private lastSendError: { code: string; at: number } | null = null;
  private cap: { status: NewChatCapStatus; used: number | null; total: number | null; ends: number | null } | null = null;
  /** Wakes the state when a timelock or a capped cycle ends, so the lift is told when it happens, not when someone asks. */
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * `onChange` hears a change the link does not carry: a timelock or a cap that comes or goes while
   * connected. A close or an open is not announced here; the status change that goes with it is.
   */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly onChange: () => void = () => {}
  ) {}

  /** A close that is about the account: its state until something says otherwise. */
  noteClose(verdict: CloseVerdict): void {
    if (verdict.kind === "logged_out" || verdict.kind === "transient") return;
    this.set(verdict.kind, {
      until: verdict.kind === "temporarily_banned" ? verdict.until : null,
      reason: verdict.kind === "temporarily_banned" ? verdict.reason : null,
      detail: verdict.kind === "temporarily_banned" ? null : verdict.detail,
    });
  }

  /** The link came up: a ban or a replaced session is over; a reachout timelock is not, it has its own clock. */
  noteOpen(): void {
    if (this.state !== "ok" && this.state !== "reachout_restricted") this.clear();
  }

  noteReachout(lock: ReachoutLock | null | undefined): void {
    if (!lock) return;
    const before = this.effectiveState();
    if (lock.isActive === true) {
      const ends = lock.timeEnforcementEnds === undefined ? NaN : new Date(lock.timeEnforcementEnds).getTime();
      this.set("reachout_restricted", {
        until: Number.isFinite(ends) ? ends : null,
        reason: text(lock.enforcementType),
        detail: null,
      });
    } else if (lock.isActive === false && this.state === "reachout_restricted") {
      this.clear();
    }
    if (this.effectiveState() !== before) this.onChange();
    this.armExpiry();
  }

  /** WhatsApp's cap on first messages to new people, as it reported it; an unknown status is ignored. */
  noteNewChatCap(report: NewChatCapReport | null | undefined): void {
    const status = report?.capping_status === undefined ? undefined : CAP_STATUSES[report.capping_status];
    if (report === null || report === undefined || status === undefined) return;
    const before = this.effectiveState();
    // An update may carry only what changed: what it leaves out stays as the last report said,
    // while that report's cycle lasts. Counts are not kept past a NONE, which may be a new cycle.
    const previous = this.cap !== null && (this.cap.ends === null || this.cap.ends > this.now()) ? this.cap : null;
    const kept = status === "none" ? null : previous;
    this.cap = {
      status,
      used: typeof report.used_quota === "number" ? report.used_quota : (kept?.used ?? null),
      total: typeof report.total_quota === "number" ? report.total_quota : (kept?.total ?? null),
      ends: whenOf(report.cycle_end_timestamp) ?? previous?.ends ?? null,
    };
    if (this.effectiveState() !== before) this.onChange();
    this.armExpiry();
  }

  /** A logout or a new link: the cap and the timelock were the old session's word, and the next connect asks again. */
  forgetSession(): void {
    this.cap = null;
    if (this.state === "reachout_restricted") this.clear();
    this.armExpiry();
  }

  /** Stop the expiry timer: the service is stopping. */
  dispose(): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private armExpiry(): void {
    this.dispose();
    const ends = [
      this.state === "reachout_restricted" ? this.until : null,
      this.cap !== null && this.cap.status !== "none" ? this.cap.ends : null,
    ].filter((at): at is number => at !== null);
    if (ends.length === 0) return;
    const wait = Math.min(...ends) - this.now();
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.effectiveState();
      this.armExpiry();
    }, Math.max(0, Math.min(wait, 2_147_483_647)) + 1);
    this.expiryTimer.unref?.();
  }

  /** A send WhatsApp refused after it left: kept for get_status, whatever the code. */
  noteSendError(code: string): void {
    this.lastSendError = { code, at: this.now() };
  }

  /** A state that stops every write: the account is banned, temporarily banned, taken over, or too old. */
  blocksWrites(): boolean {
    return this.state !== "ok" && this.state !== "reachout_restricted";
  }

  /** Whether a first message to someone never written to would be refused, and add to the restriction. */
  blocksNewChats(): boolean {
    const state = this.effectiveState();
    return state === "reachout_restricted" || state === "new_chats_capped";
  }

  /**
   * The state as of now: a timelock or a capped cycle whose end has passed is over, whoever asks
   * first, and the one that holds wins; a cap shows only while nothing graver does.
   */
  private effectiveState(): HealthState {
    const now = this.now();
    if (this.state === "reachout_restricted" && this.until !== null && this.until <= now) {
      this.clear();
      this.onChange();
    }
    // A cycle that ended takes its cap and its warnings with it.
    if (this.cap !== null && this.cap.status !== "none" && this.cap.ends !== null && this.cap.ends <= now) {
      const wasCapped = this.cap.status === "capped";
      this.cap = { ...this.cap, status: "none", used: null };
      if (wasCapped && this.state === "ok") this.onChange();
    }
    if (this.state === "ok" && this.cap?.status === "capped") return "new_chats_capped";
    return this.state;
  }

  /** The refusal a write gets while the account is restricted: nothing left wazap, and retrying is what not to do. */
  refusal(what: "write" | "new_chat" | "read" | "link"): WazapError {
    const state = this.effectiveState();
    const until = this.until === null ? "" : ` until ${isoWithOffset(this.until)}`;
    const said = this.detail === null ? "" : ` WhatsApp says: "${this.detail}"`;
    // A read or a link sent nothing to begin with; saying so would read as a write refused.
    const unsent = what === "read" || what === "link" ? "." : "; nothing was sent.";
    switch (state) {
      case "new_chats_capped": {
        const cap = this.cap!;
        const used = cap.used !== null && cap.total !== null ? ` (${cap.used} of ${cap.total} used)` : "";
        const ends = cap.ends === null ? "" : ` until ${isoWithOffset(cap.ends)}`;
        return new WazapError(
          "ACCOUNT_RESTRICTED",
          `WhatsApp's cap on first messages to people who have not written is used up for this cycle${used}${ends}${unsent}`,
          "Do not retry: reply only in chats that already have messages, and wait for the next cycle"
        );
      }
      case "reachout_restricted":
        return new WazapError(
          "ACCOUNT_RESTRICTED",
          `WhatsApp restricts this account from starting chats with people it has not written to${until}${unsent}`,
          what === "new_chat"
            ? "Do not retry: reply only in chats that already have messages, and wait for the restriction to end"
            : "Wait for the restriction to end"
        );
      case "temporarily_banned":
        return new WazapError(
          "ACCOUNT_RESTRICTED",
          `WhatsApp has temporarily banned this account${until}${unsent}${said}`,
          this.until !== null && this.until - this.now() <= TEMP_BAN_RETRY_MAX_MS
            ? "Stop sending until the ban ends; wazap tries the link once more when it does"
            : "Stop sending; restart wazap once WhatsApp has lifted the ban"
        );
      case "banned":
        return new WazapError(
          "ACCOUNT_RESTRICTED",
          `WhatsApp has banned or locked this account${unsent}${said}`,
          "Open WhatsApp on the phone to see what it says; wazap will not reconnect on its own"
        );
      case "session_replaced":
        return new WazapError(
          "ACCOUNT_RESTRICTED",
          `Another client took over this account's session${unsent}`,
          "Stop the other wazap or WhatsApp Web using these credentials, then restart this one"
        );
      case "client_outdated":
        return new WazapError(
          "ACCOUNT_RESTRICTED",
          `WhatsApp no longer accepts this version of the client${unsent}`,
          "Update wazap (`npx wazap-mcp update`), then restart it"
        );
      default:
        return new WazapError("ACCOUNT_RESTRICTED", "WhatsApp restricts this account; nothing was sent.");
    }
  }

  /**
   * Whether pairing again would throw away a session that comes back on its own: a temporary ban
   * ends, a replaced session is still good, an outdated client needs an update, not a new link.
   * A ban proper is the one state a new link may be what the owner needs.
   */
  blocksLink(): boolean {
    return this.state === "temporarily_banned" || this.state === "session_replaced" || this.state === "client_outdated";
  }

  /** When a temporary ban ends, if it said. */
  banEndsAt(): number | null {
    return this.state === "temporarily_banned" ? this.until : null;
  }

  info(): HealthInfo {
    const { state, until } = this.summary();
    return {
      state,
      since: this.since === null ? null : isoWithOffset(this.since),
      until,
      reason: this.reason,
      detail: this.detail,
      last_send_error: this.lastSendError === null ? null : { code: this.lastSendError.code, at: isoWithOffset(this.lastSendError.at) },
      new_chat_cap:
        this.cap === null
          ? null
          : { status: this.cap.status, used: this.cap.used, total: this.cap.total, cycle_ends: this.cap.ends === null ? null : isoWithOffset(this.cap.ends) },
    };
  }

  /** One line for get_status's hint, or null while nothing is wrong. */
  hint(): string | null {
    if (this.effectiveState() !== "ok") return this.refusal("write").message;
    const cap = this.cap;
    if (cap === null || (cap.status !== "first_warning" && cap.status !== "second_warning")) return null;
    const used = cap.used !== null && cap.total !== null ? `: ${cap.used} of ${cap.total} used this cycle` : "";
    const which = cap.status === "first_warning" ? "a first" : "a second";
    return `WhatsApp gave ${which} warning about first messages to people who have not written${used}. Slow down; past the cap they are refused.`;
  }

  /** The state for a webhook event: what, until when, and WhatsApp's code for it. */
  summary(): { state: HealthState; until: string | null; reason: string | null } {
    const state = this.effectiveState();
    if (state === "new_chats_capped") {
      const ends = this.cap?.ends ?? null;
      return { state, until: ends === null ? null : isoWithOffset(ends), reason: null };
    }
    return { state, until: this.until === null ? null : isoWithOffset(this.until), reason: this.reason };
  }

  private set(state: HealthState, fields: { until: number | null; reason: string | null; detail: string | null }): void {
    if (this.state !== state) this.since = this.now();
    this.state = state;
    this.until = fields.until;
    this.reason = fields.reason;
    this.detail = fields.detail;
  }

  private clear(): void {
    this.state = "ok";
    this.since = null;
    this.until = null;
    this.reason = null;
    this.detail = null;
  }
}
