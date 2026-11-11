/**
 * wait_for_messages for one account: the last arrivals, numbered so a cursor
 * can resume from them, and the waits parked until the next one lands. Part
 * of WhatsAppService (src/whatsapp.ts), which notes each arrival as it stores
 * it and lends its guards through WaitsHost.
 */

import { randomUUID } from "node:crypto";
import type { WAMessage } from "baileys";
import type { AccountDb } from "../db/index.js";
import { isGroupId, isNoiseJid } from "../ids.js";
import { messageIdFor, messageType } from "../messages.js";
import { withoutPrivateQuote, withoutWords } from "../private-contacts.js";
import type { WaitOptions, WaitResult } from "../wa-types.js";
import type { AccountIdentity } from "./identity.js";
import type { MessageViews } from "./views.js";

/** How many arrivals wait_for_messages can replay to a cursor before it has to say it lost track. */
const ARRIVALS_KEPT = 500;

/** After the first matching arrival, how long a wait keeps collecting the rest of the burst. */
const ARRIVAL_SETTLE_MS = 1_000;

/** What the service lends the waits, read at each call. */
export interface WaitsHost {
  readyDb(): AccountDb | null;
  stopped(): boolean;
  guarded<T>(work: () => Promise<T>): Promise<T>;
  ensureConnected(): void;
  /** A group message that @-mentions the linked account or replies to one of its messages. */
  addressesMe(raw: WAMessage): boolean;
}

export class MessageWaits {
  /** Inbound messages as they land, newest last, so a wait can resume from a cursor. */
  private readonly arrivals: Array<{ seq: number; sid: string; jid: string }> = [];
  private arrivalSeq = 0;
  private readonly bootId = randomUUID().slice(0, 8);
  private arrivalWaiters: Array<() => void> = [];

  constructor(
    private readonly host: WaitsHost,
    private readonly identity: AccountIdentity,
    private readonly views: MessageViews
  ) {}

  /**
   * Block until something arrives that matches, or until the deadline. The
   * first match starts a short settle so a burst of messages comes back as
   * one answer. A cursor from this run replays what landed since it, so a
   * loop of calls misses nothing between them; one from another run is
   * refused and the wait starts from now, and says so.
   */
  waitForMessages(opts: WaitOptions): Promise<WaitResult> {
    return this.host.guarded(async () => {
      this.host.ensureConnected();
      const chatJid = opts.chatId === undefined ? undefined : this.identity.resolveId(opts.chatId);
      const parsed = this.parseCursor(opts.cursor);
      let since = parsed.seq;
      const deadline = Date.now() + opts.timeoutMs;
      const matching = (): typeof this.arrivals =>
        this.arrivals.filter((a) => a.seq > since && this.arrivalMatches(a, chatJid, opts.addressedToMe));

      let found = matching();
      let timedOut = false;
      // A cancelled call, or a server draining before it stops, ends the wait
      // now with what has arrived, as if the deadline had come.
      const signal = opts.signal;
      if (found.length === 0) {
        while (!this.host.stopped() && !signal?.aborted && Date.now() < deadline) {
          await this.nextArrival(deadline - Date.now(), false, signal);
          found = matching();
          if (found.length > 0) break;
        }
        if (found.length === 0) timedOut = true;
      }
      if (found.length > 0 && !signal?.aborted) {
        await this.nextArrival(Math.min(ARRIVAL_SETTLE_MS, Math.max(0, deadline - Date.now())), true, signal);
        found = matching();
      }
      const last = found.length > 0 ? found[found.length - 1]!.seq : Math.max(since, this.arrivalSeq);
      since = last;
      const db = this.host.readyDb();
      // A chat named by chat_id reads whole, theirs or a group's: only a wait on every chat leaves #private words out.
      const people = db === null || chatJid !== undefined ? null : this.identity.privateScope(opts.private);
      // A message deleted or expired since it arrived is not handed out.
      const messages = found.flatMap((a) => {
        const message = db?.messages.get(a.sid) ?? null;
        if (message === null) return [];
        const view = this.views.viewOfStored(message);
        if (people === null) return [view];
        return [people.message(message) ? withoutWords(view) : withoutPrivateQuote(view, people)];
      });
      return {
        messages,
        cursor: `${this.bootId}:${last}`,
        timed_out: timedOut,
        cursor_reset: parsed.reset,
      };
    });
  }

  private arrivalMatches(
    arrival: { sid: string; jid: string },
    chatJid: string | undefined,
    addressedToMe: boolean
  ): boolean {
    if (chatJid !== undefined && arrival.jid !== chatJid) return false;
    if (!addressedToMe || !isGroupId(arrival.jid)) return true;
    const message = this.host.readyDb()?.messages.get(arrival.sid) ?? null;
    const raw = message === null ? null : this.views.rawOf(message);
    return raw !== null && this.host.addressesMe(raw);
  }

  private parseCursor(cursor: string | undefined): { seq: number; reset: boolean } {
    if (cursor === undefined) return { seq: this.arrivalSeq, reset: false };
    const [boot, rest] = cursor.split(":");
    const seq = Number(rest);
    const oldest = this.arrivals[0]?.seq ?? this.arrivalSeq;
    if (
      boot !== this.bootId ||
      !Number.isInteger(seq) ||
      seq > this.arrivalSeq ||
      (seq < oldest - 1 && this.arrivals.length > 0)
    ) {
      return { seq: this.arrivalSeq, reset: true };
    }
    return { seq, reset: false };
  }

  /** Resolves on the next arrival or after `ms`; a settle rides out the burst and ends only on the deadline, a stop or `signal`. */
  private nextArrival(ms: number, settle = false, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const waiter = (): void => {
        if (!settle || this.host.stopped()) done();
      };
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        const at = this.arrivalWaiters.indexOf(waiter);
        if (at !== -1) this.arrivalWaiters.splice(at, 1);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      this.arrivalWaiters.push(waiter);
      if (signal?.aborted) done();
      else signal?.addEventListener("abort", done, { once: true });
    });
  }

  noteArrivals(stored: readonly WAMessage[]): void {
    let landed = false;
    for (const raw of stored) {
      if (raw.key.fromMe || !raw.key.remoteJid) continue;
      if (messageType(raw) === "system") continue;
      const jid = this.identity.canonical(raw.key.remoteJid);
      if (isNoiseJid(jid)) continue;
      this.arrivals.push({ seq: ++this.arrivalSeq, sid: messageIdFor(raw.key, jid), jid });
      landed = true;
    }
    while (this.arrivals.length > ARRIVALS_KEPT) this.arrivals.shift();
    if (landed) this.wakeArrivalWaiters();
  }

  wakeArrivalWaiters(): void {
    const waiters = this.arrivalWaiters;
    this.arrivalWaiters = [];
    for (const waiter of waiters) waiter();
  }
}
