/**
 * The link's own watch, as opposed to the account's (src/service/health.ts): how long the link
 * has been down, whether the owner was told, and a watchdog for what Baileys' own keepalive does
 * not catch. Part of WhatsAppService (src/whatsapp.ts), which tells it every status change and
 * lends it the socket through LinkHost. Only the server runs it: a short-lived command (status
 * --live, a resync) neither alerts nor touches the state on disk.
 *
 * - The outage clock starts at the first status that is not `connected` while the account has a
 *   session, and stops at `connected`. It is kept in `link.json` beside the account's database,
 *   so the exit that hands a long outage to the supervisor does not restart it, nor tell it twice.
 *   A clean stop forgets an outage nobody was told about; the next start counts from itself.
 * - Alerts, posted as the webhook's `alert` event and logged on stderr: `disconnected` once the
 *   link has been down ALERT_AFTER_MS, `recovered` when it comes back after one, and
 *   `relink_required` at once when WhatsApp unlinked the device or the credentials are corrupt.
 *   Each at most once per outage, across restarts.
 * - The watchdog ticks every WATCH_TICK_MS. A tick later than WAKE_GAP_MS past its time means the
 *   machine slept (or the process was frozen): a socket that looks connected is pinged, one that
 *   was still connecting is replaced, and a reconnect waiting out its backoff runs now. Asleep is
 *   not down, so an outage the owner was not told about moves its clock forward by the sleep.
 *   Between wakes, a connected socket is pinged every PROBE_EVERY_MS and replaced after
 *   PROBE_FAILURES_TO_RECONNECT unanswered pings; a socket stuck connecting for CONNECT_STUCK_MS is
 *   replaced; and a link left down with no reconnect on its way gets one.
 *
 * Nothing here deletes credentials or decides a session is gone: replacing a socket goes through
 * the same paced reconnect a dropped link does.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { writeJsonFile } from "../accounts.js";
import { isoWithOffset } from "../messages.js";
import { log, logError } from "../logger.js";
import type { ConnectionStatus, LinkInfo } from "../wa-types.js";

export const WATCH_TICK_MS = 15_000;
/** A tick this much later than due means the clock jumped: the machine slept or the process was stopped. */
export const WAKE_GAP_MS = 30_000;
/** A link down this long is worth a message to the owner. A wake or a WhatsApp restart takes seconds. */
export const ALERT_AFTER_MS = 5 * 60_000;
/** How often a socket that says it is connected is asked to prove it, on top of Baileys' own keepalive. */
export const PROBE_EVERY_MS = 5 * 60_000;
export const PROBE_TIMEOUT_MS = 20_000;
/** Unanswered pings in a row before a socket is replaced; one is enough right after a wake. */
export const PROBE_FAILURES_TO_RECONNECT = 2;
/** Baileys gives up an opening socket after 20 s; one still connecting after this is wedged. */
export const CONNECT_STUCK_MS = 2 * 60_000;
/** A link down this long with no reconnect scheduled or running gets one. */
export const STALLED_DOWN_MS = 60_000;
/** While the link is down, the record is touched this often, so the next process can tell how fresh it is. */
export const SEEN_EVERY_MS = 60_000;
/**
 * An outage nobody was told about, in a record older than this, was left by a process that is not
 * running any more (stopped hard, crashed long ago): its clock starts again with this process.
 * The exit wazap makes for its supervisor is back within seconds.
 */
export const RECORD_STALE_MS = 3 * 60_000;

/** The record's name in the account folder. A logout removes it with the session it was about. */
export const LINK_FILE = "link.json";

export type LinkAlertKind = "disconnected" | "recovered" | "relink_required";

export interface LinkAlert {
  alert: LinkAlertKind;
  status: ConnectionStatus;
  at: number;
  downSince: number | null;
  /** How long the link was down, for `recovered`; how long it has been, for `disconnected`. */
  downForMs: number | null;
  reason: string | null;
  /** The outage is the session's credentials gone missing, whose way out differs from a network's. */
  credentialsMissing?: boolean;
}

/** What a ping of the live socket found: an answer, none, or no socket left to ask (replaced, closed). */
export type ProbeResult = "alive" | "dead" | "gone";

/** What the service lends the watch, read at each call. */
export interface LinkHost {
  status(): ConnectionStatus;
  statusSince(): number;
  lastError(): string | null;
  /** When the live socket was opened, or null when there is none. */
  socketSince(): number | null;
  /** The reconnect that is waiting, if any: a backoff, or the one try a dated temporary ban gets. */
  reconnectPending(): "backoff" | "ban" | null;
  starting(): boolean;
  /** False when a start cannot succeed however often it is tried (the account database failed). */
  canStart(): boolean;
  probe(timeoutMs: number): Promise<ProbeResult>;
  /** Drop the live socket, if any, and reconnect through the paced schedule. Never touches credentials. */
  forceReconnect(reason: string): void;
  /** A backoff wait cut short: the reconnect it was waiting for runs now, with a fresh budget. */
  retryNow(reason: string): void;
  /** Queue the alert for the webhook; false when it cannot be queued yet (the database is still opening). */
  alert(alert: LinkAlert): boolean;
}

/** `link.json`: the outage still open, and whether the owner was told. Times in ms since the epoch. */
interface LinkRecord {
  down_since: number | null;
  /**
   * The outage is a session's credentials gone from under it: kept through a clean stop and past
   * the stale window, since it is what keeps the next process from reading the account as unlinked.
   */
  credentials_missing?: boolean;
  /** The last time a process watching this outage was alive. */
  seen_at: number | null;
  alerted: "disconnected" | "relink_required" | null;
  last_outage: { from: number; to: number } | null;
}

const NO_SESSION: ReadonlySet<ConnectionStatus> = new Set(["not_linked", "linking"]);
const RELINK: ReadonlySet<ConnectionStatus> = new Set(["logged_out", "session_corrupt"]);
const REASON_MAX = 300;
const PENDING_MAX = 4;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** An error line fit for a webhook body: no credentials a proxy URL may carry, and short. */
export function alertReason(text: string | null): string | null {
  if (text === null) return null;
  const clean = text.replace(/\/\/[^\s/@]*@/g, "//").replace(/\s+/g, " ").trim();
  if (clean === "") return null;
  return clean.length > REASON_MAX ? `${clean.slice(0, REASON_MAX - 1)}…` : clean;
}

export class LinkMonitor {
  private downSince: number | null = null;
  /** The outage clock was started by this process's own boot, not by a link that went down. */
  private bootClock = false;
  private alerted: LinkRecord["alerted"] = null;
  private lastOutage: LinkRecord["last_outage"] = null;
  private wakes = 0;
  private lastWakeAt: number | null = null;
  private forced = 0;
  private lastForced: { at: number; reason: string } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick: number | null = null;
  private lastProbeAt: number | null = null;
  private probeFailures = 0;
  private probing = false;
  private disposed = false;
  private lastSeenSave = 0;
  private credentialsMissing = false;
  /**
   * The credentials file itself is not there right now (ENOENT), as opposed to unreadable (EACCES,
   * EIO): only then may an alert suggest a logout, which would throw readable credentials away.
   */
  private credentialsGone = false;
  /** Alerts the webhook could not queue yet, tried again at each tick. */
  private pending: LinkAlert[] = [];

  /**
   * `file` null runs the watch without one: nothing is read or written, and nothing is alerted,
   * which is what a short-lived command gets.
   */
  constructor(
    private readonly host: LinkHost,
    private readonly file: string | null,
    private readonly now: () => number = Date.now
  ) {
    if (file !== null) this.load(file);
  }

  /** Start ticking. The status at this moment is the first the watch hears. */
  arm(): void {
    if (this.file === null || this.disposed || this.timer !== null) return;
    this.lastTick = this.now();
    this.noteStatus(this.host.status(), true);
    this.timer = setInterval(() => this.tick(), WATCH_TICK_MS);
    this.timer.unref?.();
  }

  /**
   * The service is stopping. A clean stop forgets an outage the owner was not told about, so a
   * restart does not count the time it was off; one they were told about stays, so the
   * `recovered` that ends it still comes.
   */
  dispose(clean: boolean): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.disposed) return;
    this.disposed = true;
    if (clean && this.file !== null && this.alerted === null && this.downSince !== null && !this.credentialsMissing) {
      this.downSince = null;
      this.save();
    }
  }

  /**
   * Whether an outage of a session is open, from this process or the one before it: what tells a
   * credentials file gone missing (a disk not mounted yet) from an account never linked, across the
   * restart the supervisor makes after a give-up.
   */
  outageOpen(): boolean {
    return this.file !== null && this.downSince !== null;
  }

  /**
   * This session's credentials could not be read (`errno`): the outage outlives any restart until
   * they are back. Only a file that is not there (ENOENT) changes what the owner is told to do.
   */
  noteCredentialsMissing(errno: string): void {
    if (this.file === null || this.disposed) return;
    this.credentialsGone = errno === "ENOENT";
    if (this.credentialsMissing) return;
    this.credentialsMissing = true;
    this.downSince ??= this.now();
    this.save();
  }

  /** The credentials read again: whatever keeps the link down now is not them. */
  noteCredentialsRead(): void {
    if (this.file === null || this.disposed) return;
    this.credentialsGone = false;
    if (!this.credentialsMissing) return;
    this.credentialsMissing = false;
    this.save();
  }

  /** A new link supersedes whatever the old session's outage was. */
  forgetSession(): void {
    if (this.file === null) return;
    this.credentialsMissing = false;
    this.credentialsGone = false;
    this.downSince = null;
    this.bootClock = false;
    this.alerted = null;
    this.save();
  }

  /** `atBoot`: the status this process started in, which starts the clock without anything having dropped. */
  noteStatus(status: ConnectionStatus, atBoot = false): void {
    if (this.file === null || this.disposed) return;
    const now = this.now();
    if (status === "connected") {
      this.probeFailures = 0;
      this.lastProbeAt = now;
      this.credentialsMissing = false;
      this.credentialsGone = false;
      if (this.downSince === null) return;
      // Back from an outage the owner was told about. A link after `relink_required` is a new
      // session (linked again, perhaps offline), not this outage's end.
      if (this.alerted === "disconnected") this.emit("recovered", status, now);
      if (this.alerted !== null || !this.bootClock) this.lastOutage = { from: this.downSince, to: now };
      this.downSince = null;
      this.bootClock = false;
      this.alerted = null;
      this.save();
      return;
    }
    // No session to lose: a pairing under way, or none (a logout took it). Nothing to tell the owner,
    // and an outage of the session that is gone is over.
    if (NO_SESSION.has(status)) {
      if (this.downSince !== null) this.forgetSession();
      return;
    }
    if (this.downSince === null) {
      this.downSince = now;
      this.bootClock = atBoot;
      this.save();
    }
    if (RELINK.has(status) && this.alerted !== "relink_required") {
      this.alerted = "relink_required";
      this.emit("relink_required", status, now);
      this.save();
    }
  }

  /** One watchdog pass. The timer calls it; tests call it with a clock of their own. */
  tick(): void {
    if (this.file === null || this.disposed) return;
    const now = this.now();
    const last = this.lastTick;
    this.lastTick = now;
    this.flush();
    // A boot still preparing its database has not tried the link yet: the clock starts with the first socket.
    if (
      this.bootClock &&
      this.alerted === null &&
      this.host.starting() &&
      this.host.status() === "connecting" &&
      this.host.socketSince() === null
    ) {
      this.downSince = now;
    }
    if (last !== null && now - last > WATCH_TICK_MS + WAKE_GAP_MS) this.woke(now, last);
    else this.watch(now);
    this.checkAlert(now);
    if (this.downSince !== null && now - this.lastSeenSave >= SEEN_EVERY_MS) this.save();
  }

  /** `before`: the last tick before the jump, so what was opened since is told apart from what predates it. */
  private woke(now: number, before: number): void {
    this.wakes += 1;
    this.lastWakeAt = now;
    const status = this.host.status();
    log(`the clock jumped ${Math.round((now - before) / 1000)}s (sleep or a frozen process); checking the WhatsApp link (${status})`);
    // Time asleep is not time down: the outage's clock moves forward by the sleep, keeping the awake
    // time before it, so the owner hears of an outage the awake machine could not fix.
    if (this.downSince !== null && this.alerted === null) {
      this.downSince = Math.min(now, this.downSince + Math.max(0, now - before - WATCH_TICK_MS));
      this.save();
    }
    if (status === "connected") {
      void this.probe(now, 1);
      return;
    }
    // A socket a reconnect opened since the wake is left to finish; only one from before the sleep is dead.
    const opened = this.host.socketSince();
    if (status === "connecting" && opened !== null && opened <= before) {
      this.force("the socket was still opening when the machine slept");
      return;
    }
    if (this.host.reconnectPending() === "backoff") this.host.retryNow("woke from sleep");
  }

  private watch(now: number): void {
    const status = this.host.status();
    if (status === "connected") {
      if (this.lastProbeAt === null || now - this.lastProbeAt >= PROBE_EVERY_MS) void this.probe(now, PROBE_FAILURES_TO_RECONNECT);
      return;
    }
    if (status === "connecting") {
      const since = this.host.socketSince();
      if (since !== null && now - since >= CONNECT_STUCK_MS) {
        this.force(`still connecting after ${Math.round((now - since) / 1000)}s`);
      } else if (
        since === null &&
        this.host.canStart() &&
        this.host.reconnectPending() === null &&
        !this.host.starting() &&
        now - this.host.statusSince() >= STALLED_DOWN_MS
      ) {
        // A start that threw before or while opening its socket leaves no socket and nothing scheduled.
        this.force("the socket never opened");
      }
      return;
    }
    if (
      status === "disconnected" &&
      this.host.reconnectPending() === null &&
      !this.host.starting() &&
      now - this.host.statusSince() >= STALLED_DOWN_MS
    ) {
      this.force("down with no reconnect scheduled");
    }
  }

  private async probe(now: number, failuresToReconnect: number): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    this.lastProbeAt = now;
    const wakes = this.wakes;
    try {
      const result = await this.host.probe(PROBE_TIMEOUT_MS);
      if (this.disposed || result === "gone") return;
      // A ping that was out when the machine slept counts as the wake's own: one silence is enough.
      if (this.wakes !== wakes) failuresToReconnect = 1;
      if (result === "alive") {
        this.probeFailures = 0;
        return;
      }
      this.probeFailures += 1;
      log(`the WhatsApp socket did not answer a ping (${this.probeFailures}/${failuresToReconnect})`);
      if (this.probeFailures >= failuresToReconnect && this.host.status() === "connected") {
        this.probeFailures = 0;
        this.force("the socket stopped answering pings");
      }
    } catch (err) {
      logError("link probe", err);
    } finally {
      this.probing = false;
    }
  }

  private force(reason: string): void {
    this.forced += 1;
    this.lastForced = { at: this.now(), reason };
    log(`replacing the WhatsApp socket: ${reason}`);
    this.host.forceReconnect(reason);
  }

  private checkAlert(now: number): void {
    if (this.downSince === null || this.alerted !== null) return;
    // A start that cannot succeed (the database failed) is not a link outage; get_status says why.
    if (!this.host.canStart()) return;
    const status = this.host.status();
    if (status === "connected" || NO_SESSION.has(status)) return;
    if (now - this.downSince < ALERT_AFTER_MS) return;
    this.alerted = "disconnected";
    this.emit("disconnected", status, now);
    this.save();
  }

  private emit(alert: LinkAlertKind, status: ConnectionStatus, at: number): void {
    const downSince = this.downSince;
    // Unreadable credentials say where they live; the receiver needs only what happened.
    const reason =
      alert === "recovered"
        ? null
        : status === "session_corrupt"
          ? "The stored credentials cannot be read."
          : alertReason(this.host.lastError());
    const minutes = downSince === null ? null : Math.round((at - downSince) / 60_000);
    log(
      alert === "recovered"
        ? `link alert: WhatsApp is back after ${minutes} min`
        : alert === "disconnected"
          ? `link alert: WhatsApp has been down ${minutes} min (${status}${reason === null ? "" : `: ${reason}`})`
          : `link alert: WhatsApp unlinked this device (${status}); it needs linking again`
    );
    this.pending.push({
      alert,
      status,
      at,
      downSince,
      downForMs: downSince === null ? null : at - downSince,
      reason,
      ...(this.credentialsGone && alert === "disconnected" ? { credentialsMissing: true } : {}),
    });
    // Bounded: a database that never opens keeps the latest few, not every flap.
    if (this.pending.length > PENDING_MAX) this.pending.splice(0, this.pending.length - PENDING_MAX);
    this.flush();
  }

  private flush(): void {
    while (this.pending.length > 0) {
      let queued: boolean;
      try {
        queued = this.host.alert(this.pending[0]!);
      } catch (err) {
        logError("link alert", err);
        queued = true;
      }
      if (!queued) return;
      const sent = this.pending.shift()!;
      if (sent.alert !== "recovered" && sent.alert === this.alerted) this.save();
    }
  }

  info(): LinkInfo {
    const now = this.now();
    return {
      down_since: this.downSince === null ? null : isoWithOffset(this.downSince),
      down_for_seconds: this.downSince === null ? null : Math.max(0, Math.round((now - this.downSince) / 1000)),
      alert_after_seconds: ALERT_AFTER_MS / 1000,
      alerted: this.alerted,
      last_outage:
        this.lastOutage === null
          ? null
          : {
              from: isoWithOffset(this.lastOutage.from),
              to: isoWithOffset(this.lastOutage.to),
              seconds: Math.round((this.lastOutage.to - this.lastOutage.from) / 1000),
            },
      wakes: this.wakes,
      last_wake_at: this.lastWakeAt === null ? null : isoWithOffset(this.lastWakeAt),
      forced_reconnects: this.forced,
      last_forced_reconnect: this.lastForced === null ? null : { at: isoWithOffset(this.lastForced.at), reason: this.lastForced.reason },
    };
  }

  /**
   * One line for get_status's hint while an outage the owner was told about lasts, or null. Only
   * while wazap is reconnecting: a link WhatsApp holds closed has its own hint (health).
   */
  hint(): string | null {
    if (this.alerted !== "disconnected" || this.downSince === null) return null;
    const status = this.host.status();
    if ((status !== "disconnected" && status !== "connecting") || !this.host.canStart()) return null;
    // Credentials gone missing have their own way out (last_error says it), which may be a new link.
    if (this.credentialsGone) return null;
    const minutes = Math.max(1, Math.round((this.now() - this.downSince) / 60_000));
    return (
      `The WhatsApp link has been down for ${minutes} min (since ${isoWithOffset(this.downSince)}). ` +
      "wazap keeps reconnecting, and restarts through its supervisor if that fails; the session is kept, so do not link again."
    );
  }

  private load(file: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return;
    }
    if (raw === null || typeof raw !== "object") return;
    const record = raw as Partial<Record<keyof LinkRecord, unknown>>;
    this.downSince = finite(record.down_since);
    this.alerted =
      this.downSince !== null && (record.alerted === "disconnected" || record.alerted === "relink_required") ? record.alerted : null;
    // Time no wazap was running is not counted, as time asleep is not; an outage already told stays told.
    const seen = finite(record.seen_at);
    this.credentialsMissing = this.downSince !== null && record.credentials_missing === true;
    if (this.alerted === null && (seen === null || this.now() - seen > RECORD_STALE_MS)) {
      // Still open, but its clock starts with this process, as for any time nobody watched.
      this.downSince = this.credentialsMissing ? this.now() : null;
    }
    const outage = record.last_outage as { from?: unknown; to?: unknown } | null | undefined;
    const from = finite(outage?.from);
    const to = finite(outage?.to);
    this.lastOutage = from !== null && to !== null && to >= from ? { from, to } : null;
  }

  private save(): void {
    if (this.file === null) return;
    try {
      if (this.downSince === null && this.lastOutage === null) {
        rmSync(this.file, { force: true });
        return;
      }
      // An account folder a removal took away is not made again for this.
      if (!existsSync(dirname(this.file))) return;
      const now = this.now();
      this.lastSeenSave = now;
      // An alert still waiting for the outbox is not told yet: a restart before it is queued tells it again.
      const told = this.pending.some((alert) => alert.alert === this.alerted) ? null : this.alerted;
      const record: LinkRecord = {
        down_since: this.downSince,
        ...(this.credentialsMissing ? { credentials_missing: true } : {}),
        seen_at: this.downSince === null ? null : now,
        alerted: told,
        last_outage: this.lastOutage,
      };
      writeJsonFile(this.file, record);
    } catch (err) {
      // A full disk costs the record, never the link.
      logError("link state", err);
    }
  }
}
