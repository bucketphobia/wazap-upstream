/**
 * What manage_chat and delete_message do to a chat or a message on WhatsApp:
 * archive, pin, mute, read marks, pinned and starred messages, clear, delete,
 * block, and deleting a message for everyone or for this account alone —
 * with the forgetting on this machine that each one asks for. Part of
 * WhatsAppService (src/whatsapp.ts), which lends its guards and its cleanup
 * barrier through ChatsHost.
 */

import { proto, type WAMessage, type WASocket } from "baileys";
import { WazapError } from "../errors.js";
import { isGroupId, isNoiseJid } from "../ids.js";
import type { AccountContacts } from "./contacts.js";
import type { AccountGroups } from "./groups.js";
import type { AccountIdentity } from "./identity.js";
import type { AccountIngest, MessageRef } from "./ingest.js";
import type { AccountSends } from "./send.js";
import type { AccountStorage } from "./storage.js";
import type { MessageViews } from "./views.js";
import type { ChatAction, ChatActionOptions, ChatActionResult } from "../wa-types.js";

/** How long after sending WhatsApp lets a message be deleted for everyone. */
const RETRACT_WINDOW_MS = 2 * 24 * 3_600_000;

/** How long a pinned message stays pinned, by the hours manage_chat takes: WhatsApp's 24 hours, 7 days and 30 days. */
const PIN_SECONDS: Record<number, 86_400 | 604_800 | 2_592_000> = { 24: 86_400, 168: 604_800, 720: 2_592_000 };

/** What the service lends the chat actions, read at each call. */
export interface ChatsHost {
  guarded<T>(work: () => Promise<T>): Promise<T>;
  /** The socket for a write: connected, not read-only, within the rate limit. */
  beginWrite(): WASocket;
  /** The same, from mark_read's own bucket, so read marks do not spend the sends'. */
  beginReadMark(): WASocket;
  /** Queued purges, folds, expiry sweeps and file cleanup have finished. */
  storageIdle(): Promise<void>;
}

export class AccountChats {
  constructor(
    private readonly host: ChatsHost,
    private readonly identity: AccountIdentity,
    private readonly views: MessageViews,
    private readonly storage: AccountStorage,
    private readonly groups: AccountGroups,
    private readonly sends: AccountSends,
    private readonly ingest: AccountIngest,
    private readonly contacts: AccountContacts
  ) {}

  /**
   * A chat cleared or deleted for this account, by manage_chat or on the phone.
   * The barrier is stored and every message at or before it hidden before this
   * returns, so an event handler need not wait; the rows, their vectors and
   * their files go in chunks behind it. A deleted chat also leaves the chat
   * list until a new message arrives.
   */
  forgetChat(jid: string, deleted: boolean): Promise<void> {
    const db = this.storage.db;
    const at = Date.now();
    if (deleted) db.identity.upsertChat({ jid, archived: false, pinned: null, unread: 0, proto: null });
    const purge = deleted ? db.messages.deleteChat(jid, at) : db.messages.clearChat(jid, at);
    return purge.then(() => this.storage.scheduleFileCleanup());
  }

  deleteMessage(messageId: string, forEveryone: boolean): Promise<{ message_id: string; for_everyone: boolean }> {
    return this.host.guarded(async () => {
      const stored = this.views.storedOrThrow(messageId);
      const raw = this.views.messageOrThrow(messageId);
      const chat = stored.chatJid;
      const target: MessageRef = { chatJid: chat, fromMe: stored.fromMe, keyId: stored.keyId };
      if (!forEveryone) {
        // Only the linked account's copy goes, whoever sent it and however old:
        // WhatsApp syncs that to the account's other devices, and nobody else
        // sees a change.
        const sock = this.host.beginWrite();
        const timestamp = Math.floor(stored.ts / 1000);
        await sock.chatModify({ deleteForMe: { deleteMedia: false, key: raw.key, timestamp } }, chat);
        this.storage.requireCleanupOwner();
        this.ingest.retract([target], stored.ts);
        await this.host.storageIdle();
        return { message_id: messageId, for_everyone: false };
      }
      let key = raw.key;
      if (stored.fromMe) {
        if (Date.now() - stored.ts > RETRACT_WINDOW_MS) {
          throw new WazapError("RETRACT_WINDOW_EXPIRED", `Message ${messageId} is older than 2 days.`);
        }
      } else if (isGroupId(chat)) {
        // Someone else's message comes down only by a group admin's hand. Baileys
        // sends it as an admin revoke, and the key must name who sent it. Baileys
        // documents no time limit for that, so the 2-day window is not assumed here.
        await this.groups.assertGroupAdmin(chat, "delete_message");
        const participant = raw.key.participant || raw.participant;
        if (!participant) {
          throw new WazapError(
            "WHATSAPP_ERROR",
            `WhatsApp did not say who sent ${messageId}, so it cannot be deleted as an admin.`
          );
        }
        key = { ...raw.key, participant };
      } else {
        throw new WazapError("NOT_OWN_MESSAGE", `Message ${messageId} was not sent by the linked account.`);
      }
      const { sock, jid } = await this.sends.prepareSend(chat);
      await sock.sendMessage(jid, { delete: key });
      this.storage.requireCleanupOwner();
      // Deleted means out of the index too — the text does not get to linger on.
      this.ingest.retract([target], stored.ts);
      await this.host.storageIdle();
      return { message_id: messageId, for_everyone: true };
    });
  }

  manageChat(chatId: string, action: ChatAction, opts: ChatActionOptions = {}): Promise<ChatActionResult> {
    return this.host.guarded(async () => {
      const sock = action === "mark_read" ? this.host.beginReadMark() : this.host.beginWrite();
      const jid = this.identity.resolveId(chatId);
      const last = this.views.lastMessageOf(jid);
      const lastMessages = last ? [last] : [];
      const muteHours = opts.muteHours ?? 8;
      let detail = "";
      let messageId: string | undefined;

      switch (action) {
        case "archive":
        case "unarchive":
          await sock.chatModify({ archive: action === "archive", lastMessages }, jid);
          break;
        case "pin":
        case "unpin":
          await sock.chatModify({ pin: action === "pin" }, jid);
          break;
        case "mute":
          await sock.chatModify({ mute: muteHours * 3_600_000 }, jid);
          detail = ` for ${muteHours}h`;
          break;
        case "unmute":
          await sock.chatModify({ mute: null }, jid);
          break;
        case "mark_read":
          if (last) await sock.readMessages([last.key]);
          // WhatsApp sends this device no echo of its own read, so the count is cleared here, or the chat stays unread.
          this.storage.db.identity.upsertChat({ jid, unread: 0 });
          break;
        case "mark_unread":
          await sock.chatModify({ markRead: false, lastMessages }, jid);
          break;
        case "pin_message":
        case "unpin_message": {
          const hours = opts.pinHours ?? 168;
          const time = PIN_SECONDS[hours];
          if (time === undefined) {
            throw new WazapError("INVALID_ID", `pin_hours must be 24, 168 or 720, not ${hours}.`, "Pass pin_hours as 24, 168 or 720");
          }
          const raw = this.messageInChat(opts.messageId, jid, action);
          messageId = opts.messageId;
          // A pin is a message to the chat, so every member sees it; WhatsApp ignores the time on an unpin.
          const type = action === "pin_message" ? proto.PinInChat.Type.PIN_FOR_ALL : proto.PinInChat.Type.UNPIN_FOR_ALL;
          await sock.sendMessage(jid, { pin: raw.key, type, time });
          if (action === "pin_message") detail = ` for ${hours}h`;
          break;
        }
        case "star_message":
        case "unstar_message": {
          const raw = this.messageInChat(opts.messageId, jid, action);
          messageId = opts.messageId;
          const starred = [{ id: raw.key.id ?? "", fromMe: Boolean(raw.key.fromMe) }];
          await sock.chatModify({ star: { messages: starred, star: action === "star_message" } }, jid);
          break;
        }
        case "clear":
        case "delete":
          await sock.chatModify(action === "clear" ? { clear: true, lastMessages } : { delete: true, lastMessages }, jid);
          this.storage.requireCleanupOwner();
          // The same forgetting the phone's own clear or delete gets, done now rather than on WhatsApp's echo.
          await this.forgetChat(jid, action === "delete");
          await this.host.storageIdle();
          break;
        case "block":
        case "unblock":
          if (isGroupId(jid) || isNoiseJid(jid)) {
            throw new WazapError(
              "INVALID_ID",
              `"${action}" works only on a one-to-one chat, and ${jid} is not one.`,
              "Pass the chat_id of a person"
            );
          }
          await sock.updateBlockStatus(jid, action);
          if (action === "block") this.contacts.blocked.add(jid);
          else this.contacts.blocked.delete(jid);
          break;
      }

      return { chat_id: jid, action, applied: `${action}${detail}`, ...(messageId ? { message_id: messageId } : {}) };
    });
  }

  /** A message named by a chat action must be in that chat, or the action would land on another one. */
  private messageInChat(messageId: string | undefined, jid: string, action: ChatAction): WAMessage {
    if (messageId === undefined) {
      throw new WazapError(
        "INVALID_ID",
        `The "${action}" action needs a message_id.`,
        "Pass a message_id from read_messages on this chat"
      );
    }
    const raw = this.views.messageOrThrow(messageId);
    const chat = this.views.chatOfOrThrow(messageId);
    if (chat !== jid) {
      throw new WazapError(
        "MESSAGE_NOT_FOUND",
        `Message ${messageId} is not in ${jid}; it belongs to ${chat}.`,
        "Pass the chat_id the message belongs to, or a message_id from read_messages on this chat"
      );
    }
    return raw;
  }
}
