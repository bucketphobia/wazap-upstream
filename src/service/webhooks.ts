/**
 * What the account posts to the webhook: live messages both ways, queued in
 * the transaction that stores them, the connection's changes, the body of an
 * event as it is posted, and the webhook block of get_status. Part of
 * WhatsAppService (src/whatsapp.ts), which keeps the sink and the outbox,
 * where tests replace or read them, and lends them through WebhooksHost.
 */

import type { WAMessage } from "baileys";
import type { AccountRecord } from "../accounts.js";
import type { EventRecord, StoredMessage } from "../db/index.js";
import { webhookAllowsMessage } from "../webhook-filter.js";
import { logError } from "../logger.js";
import { isUserMessage, messageIdFor } from "../messages.js";
import {
  asConnectionPayload,
  asWebhookPayload,
  webhookConnectionStatus,
  type WebhookConnectionPayload,
  type WebhookHealth,
  type WebhookPayload,
  type WebhookSink,
} from "../webhook.js";
import {
  CONNECTION_LANE,
  WEBHOOK_TRANSCRIPT_WAIT_MS,
  chatLane,
  undeliveredFailure,
  type WebhookOutbox,
} from "../webhook-outbox.js";
import type { ConnectionStatus, StatusInfo } from "../wa-types.js";
import type { AccountIdentity } from "./identity.js";
import type { AccountSends } from "./send.js";
import type { AccountStorage } from "./storage.js";
import type { MessageViews } from "./views.js";
import type { AccountVoice } from "./voice.js";

/** What the service lends the webhook glue, read at each call. */
export interface WebhooksHost {
  stopped(): boolean;
  statusSince(): number;
  webhook(): WebhookSink;
  outbox(): WebhookOutbox;
  /** What WhatsApp says about the account itself, for the connection event. */
  health(): WebhookHealth;
}

export class AccountWebhooks {
  /** The last connection status queued for the consumer, so several internal states collapse into one event. */
  /** The status and health state last queued, so several internal states collapse into one event. */
  private lastWebhookKey: string | null = null;

  constructor(
    private readonly host: WebhooksHost,
    private readonly identity: AccountIdentity,
    private readonly views: MessageViews,
    private readonly storage: AccountStorage,
    private readonly sends: AccountSends,
    private readonly voice: AccountVoice,
    private readonly accountRecord: AccountRecord
  ) {}

  /**
   * Several internal states map to one thing a consumer acts on, so the guard is
   * on the mapped status, and it advances only once the event is in the outbox,
   * which retries it for a day and keeps the order the link moved in. A change
   * the webhook does not subscribe to is not queued and does not advance it.
   */
  queueConnectionWebhook(status: ConnectionStatus): void {
    const mapped = webhookConnectionStatus(status);
    const health = this.host.health();
    // A restriction that comes or goes while linked is news too; the same status and state twice is not.
    const key = mapped === null ? null : `${mapped}|${health.state}`;
    if (mapped === null || key === this.lastWebhookKey || this.host.stopped()) return;
    const settings = this.host.webhook().settings();
    if (settings.kind !== "ready" || !settings.events.includes("connection")) return;
    const db = this.storage.readyDb();
    if (db === null) {
      this.host.outbox().dropped(`connection ${mapped}`);
      return;
    }
    // A status change is dated when the link moved; a health change while the link stayed, now.
    const at = this.lastWebhookKey?.split("|")[0] === mapped ? Date.now() : this.host.statusSince();
    try {
      db.events.enqueue({
        kind: "connection",
        lane: CONNECTION_LANE,
        messageId: null,
        payload: JSON.stringify(asConnectionPayload({ status: mapped, account: this.accountRecord, at, health })),
        createdAt: at,
      });
    } catch (err) {
      this.host.outbox().dropped(`connection ${mapped}`, err);
      return;
    }
    this.lastWebhookKey = key;
    this.host.outbox().nudge();
  }

  /**
   * Live messages both ways, queued for the webhook in the transaction that
   * stores them, and only on the notify gate transcription uses: a history
   * sync must not post the backlog, and stubs or system notices are not events.
   * That gate is also what keeps wazap's own sends quiet in production, since
   * Baileys re-emits a local send as an `append`; `sentByWazap` is the id-level
   * backstop for an echo that does arrive as `notify`. An event the webhook
   * does not subscribe to is never written, and a message delivered twice is
   * queued once. An incoming voice note waits for its transcript, at most
   * WEBHOOK_TRANSCRIPT_WAIT_MS. A write the database refuses fails the whole
   * transaction, messages included, so none is stored without its event.
   * Returns `stored`, for the caller to go on with.
   */
  announced(stored: WAMessage[], type: string): WAMessage[] {
    if (type !== "notify" || this.host.stopped() || stored.length === 0) return stored;
    const settings = this.host.webhook().settings();
    if (settings.kind !== "ready") return stored;
    const db = this.storage.db;
    const now = Date.now();
    for (const raw of stored) {
      let sid: string;
      let event: "message_received" | "message_sent";
      try {
        if (!isUserMessage(raw)) continue;
        if (this.webhookOwnSend(raw)) continue;
        event = raw.key.fromMe ? "message_sent" : "message_received";
        if (!settings.events.includes(event)) continue;
        sid = messageIdFor(raw.key, this.identity.canonical(raw.key.remoteJid ?? ""));
      } catch (err) {
        // A message this cannot make sense of is not announced; the rest of the batch still is.
        logError("webhook", err);
        continue;
      }
      const message = db.messages.get(sid);
      if (message === null || db.events.hasMessageEvent(message.id, event)) continue;
      // A filter is read here and again at post time. Skipping the enqueue keeps
      // a chat that was never allowed out of the outbox; the second check is
      // what cancels one that was allowed and then removed.
      if (!webhookAllowsMessage(db, settings.filter, message)) continue;
      db.events.enqueue({
        kind: event,
        lane: chatLane(message.chatId),
        messageId: message.id,
        payload: JSON.stringify({ is_self_chat: this.identity.isMe(message.chatJid) }),
        createdAt: now,
        readyAt: this.webhookReadyAt(message, now),
      });
    }
    return stored;
  }

  /**
   * Seam (F1-e): whether wazap sent this message itself, so its echo is never
   * announced as `message_sent`. Runs inside the transaction that stores the
   * echo; the durable send record is what should answer it, so an echo after
   * a restart is recognised too.
   */
  private webhookOwnSend(raw: WAMessage): boolean {
    return Boolean(raw.key.fromMe && raw.key.id && this.sends.isOwnSend(raw.key.id));
  }

  /**
   * Until when a message's event may wait for its words: WEBHOOK_TRANSCRIPT_WAIT_MS
   * for a voice note the transcription queue took, due at once otherwise. The
   * queue row is written earlier in the same transaction by queueTranscript,
   * so this is the queue's own rule (`transcribable`, the history window, the
   * provider), not a copy of it.
   */
  private webhookReadyAt(message: StoredMessage, now: number): number {
    return this.voice.transcriptQueued(message) ? now + WEBHOOK_TRANSCRIPT_WAIT_MS : now;
  }

  /**
   * The transcription worker is done with a note — words stored, failed, given
   * up on, or unable to run — or with every note (`null`: the provider paused):
   * the events held for them look again now.
   */
  webhookTranscriptSettled(_sid: string | null): void {
    this.host.outbox().kick();
  }

  /**
   * False when this message must not be posted: a contact tagged `#private`,
   * or a chat the allowlist does not name. True when the settings are not
   * ready or the database cannot be read. The outbox cancels what is waiting
   * when the webhook is off or invalid, and it does not post while the
   * database is null.
   */
  allowsMessage(message: StoredMessage): boolean {
    const settings = this.host.webhook().settings();
    if (settings.kind !== "ready") return true;
    const db = this.storage.readyDb();
    if (db === null) return true;
    return webhookAllowsMessage(db, settings.filter, message);
  }

  /**
   * The body of an event as it is posted: a message event from the message as
   * the database holds it now, so an edit or a transcript that landed since it
   * was queued goes with it; a connection event as it was queued, under the
   * account's current name.
   */
  webhookPayload(event: EventRecord, message: StoredMessage | null): WebhookPayload {
    const stored = JSON.parse(event.payload) as Record<string, unknown>;
    const account = this.accountRecord;
    if (message === null) {
      return { ...(stored as unknown as WebhookConnectionPayload), account_id: account.id, account_name: account.name };
    }
    return asWebhookPayload({
      event: event.kind === "message_sent" ? "message_sent" : "message_received",
      view: this.views.viewOfStored(message),
      account,
      isSelfChat: stored.is_self_chat === true,
    });
  }

  /** get_status's webhook block: settings, and the outbox as the account database records it. */
  webhookStatus(): StatusInfo["webhook"] {
    if (this.host.webhook().settings().kind !== "ready") return this.host.webhook().info(undefined, null);
    const delivery = this.host.outbox().delivery(this.storage.readyDb());
    return this.host.webhook().info(delivery, undeliveredFailure(delivery));
  }
}
