/**
 * What a reader sees of the account database: a stored message as a view, a
 * chat as a summary, a contact as a card, and the stored protobuf a send path
 * quotes. Part of WhatsAppService (src/whatsapp.ts), which lends the database
 * through ViewsHost; names and ids come from AccountIdentity.
 */

import { proto, type Chat as BaileysChat, type WAMessage, type WAMessageKey } from "baileys";
import type { AccountDb, ChatRecord, Receipt as StoredReceipt, StoredMessage } from "../db/index.js";
import { WazapError } from "../errors.js";
import { isGroupId, isNoiseJid } from "../ids.js";
import { buildMessageView, formatAge, isoWithOffset, messageIdFor, phoneOf, viewText } from "../messages.js";
import { PRIVATE_TEXT, type PrivatePeople } from "../private-contacts.js";
import { raiseStatus, raiseUser, type Receipt } from "../store.js";
import type { TranscriptRecord } from "../transcribe/index.js";
import type { ChatFilter, ChatSummary, ContactSummary, MessageType, MessageView } from "../wa-types.js";
import { realName, type AccountIdentity } from "./identity.js";

/** The deleted or expired message's words no longer answer anything; the row is gone to readers. */
export function missingMessage(messageId: string): WazapError {
  return new WazapError(
    "MESSAGE_NOT_FOUND",
    `No message "${messageId}" is loaded.`,
    "Use a message_id from read_messages or search"
  );
}

/** What viewsOfStored reads once for a whole list of messages. */
interface ViewLookups {
  marks: ReturnType<AccountDb["messages"]["marksOf"]>;
  nameFor: (jid: string, pushName?: string) => string;
  noteFor: (jid: string) => string | undefined;
  contactIdFor: (jid: string) => number | null;
}

/** What the service lends the views: read at each call, so a reopened database is seen at once. */
export interface ViewsHost {
  db(): AccountDb;
  readyDb(): AccountDb | null;
  /** A message a read found past its deadline becomes a tombstone there and then. */
  settleExpired(db: AccountDb, id: string): void;
  transcriptOf(message: StoredMessage): TranscriptRecord | undefined;
}

export class MessageViews {
  constructor(
    private readonly host: ViewsHost,
    private readonly identity: AccountIdentity
  ) {}

  /** The stored message a reader may see under any spelling of its id, or MESSAGE_NOT_FOUND. */
  storedOrThrow(messageId: string): StoredMessage {
    const db = this.host.db();
    const message = db.messages.get(messageId);
    if (message !== null) return message;
    this.host.settleExpired(db, messageId);
    throw missingMessage(messageId);
  }

  /**
   * The protobuf of a message a reader may see, for the send paths that quote,
   * forward, react to or edit it. A row the database holds only as text (from
   * the old recall index) stands in with its key and time.
   */
  /**
   * The stored message for an action that needs its key: a message held only
   * as text answers with a key and its timestamp, enough to react to, edit or
   * delete it. An action that needs its content asks contentOrThrow.
   */
  messageOrThrow(messageId: string): WAMessage {
    const message = this.storedOrThrow(messageId);
    return this.rawOf(message) ?? this.keyOnly(message);
  }

  /**
   * The stored message with its content, for a quote or a forward: Baileys
   * reads the content of both, and one held only as text (words carried over
   * from an older recall index) has none to give, so it is refused here.
   */
  contentOrThrow(messageId: string): WAMessage {
    const message = this.storedOrThrow(messageId);
    const raw = this.rawOf(message);
    if (raw === null || !raw.message) {
      throw new WazapError(
        "MESSAGE_NOT_FOUND",
        `Message ${messageId} is held only as text, so it cannot be quoted or forwarded.`,
        "Send its words as a new message, without reply_to"
      );
    }
    return raw;
  }

  chatOfOrThrow(messageId: string): string {
    return this.storedOrThrow(messageId).chatJid;
  }

  /**
   * The stored protobuf as the plain object Baileys hands out: only the fields
   * it carries, so a key without a participant has none, as on the wire.
   * Null for a row that carries only text.
   */
  rawOf(message: StoredMessage): WAMessage | null {
    if (message.raw === null) return null;
    try {
      const decoded = proto.WebMessageInfo.decode(message.raw);
      return proto.WebMessageInfo.toObject(decoded, { longs: Number }) as unknown as WAMessage;
    } catch {
      return null;
    }
  }

  keyOnly(message: StoredMessage): WAMessage {
    return {
      key: { remoteJid: message.chatJid, fromMe: message.fromMe, id: message.keyId },
      messageTimestamp: Math.floor(message.ts / 1000),
    };
  }

  /** What Baileys asks for when it retries a send or opens a poll vote: the stored protobuf's content. */
  storedProto(key: WAMessageKey): proto.IMessage | undefined {
    const db = this.host.readyDb();
    if (db === null || !key.remoteJid || !key.id) return undefined;
    const message = db.messages.get(messageIdFor(key, this.identity.canonical(key.remoteJid)));
    return (message === null ? null : this.rawOf(message))?.message ?? undefined;
  }

  /** The words a reader sees for a message: its rendering, and the transcript after it. */
  viewTextOf(message: StoredMessage): string {
    const raw = this.rawOf(message);
    if (raw !== null) return viewText(raw, this.host.transcriptOf(message));
    const text = message.text ?? "";
    return message.transcript === null ? text : `${text} "${message.transcript}"`;
  }

  /**
   * Views of many stored messages: their reactions, votes and receipts read in
   * three queries for the lot, and each name and note looked up once.
   */
  viewsOfStored(messages: readonly StoredMessage[]): MessageView[] {
    if (messages.length <= 1) return messages.map((message) => this.viewOfStored(message));
    const lookups = this.viewLookups(messages);
    return messages.map((message) => this.viewOfStored(message, lookups));
  }

  viewLookups(messages: readonly StoredMessage[]): ViewLookups {
    const marks = this.host.db().messages.marksOf(messages.map((message) => message.id));
    const names = new Map<string, string>();
    const notes = new Map<string, string | undefined>();
    const contactIds = new Map<string, number | null>();
    const lookups: ViewLookups = {
      marks,
      nameFor: (jid, pushName) => {
        const key = `${jid}\u0000${pushName ?? ""}`;
        let name = names.get(key);
        if (name === undefined) {
          name = this.identity.displayName(jid, pushName);
          names.set(key, name);
        }
        return name;
      },
      noteFor: (jid) => {
        if (!notes.has(jid)) notes.set(jid, this.identity.noteFor(jid));
        return notes.get(jid);
      },
      contactIdFor: (jid) => {
        if (!contactIds.has(jid)) contactIds.set(jid, this.host.db().identity.contactIdOf(jid));
        return contactIds.get(jid) ?? null;
      },
    };
    return lookups;
  }

  viewOfStored(message: StoredMessage, lookups?: ViewLookups): MessageView {
    const raw = this.rawOf(message);
    if (raw === null) return this.textOnlyView(message);
    const db = this.host.db();
    const nameOf = lookups?.nameFor ?? ((jid: string, pushName?: string) => this.identity.displayName(jid, pushName));
    const noteOf = lookups?.noteFor ?? ((jid: string) => this.identity.noteFor(jid));
    const chatJid = message.chatJid;
    const sender = raw.key.fromMe
      ? this.identity.ownJid()
      : chatJid.endsWith("@s.whatsapp.net")
        ? chatJid
        : this.identity.canonical(raw.key.participant || raw.participant || raw.key.remoteJid || "") || this.identity.ownJid();
    // The pushName is what the sender calls themselves: a person the message
    // mentions, or who reacted or voted, must not borrow it.
    const view = buildMessageView(raw, {
      canonical: (jid) => this.identity.canonical(jid),
      nameFor: (jid) => nameOf(jid, jid === sender ? (raw.pushName ?? undefined) : undefined),
      noteFor: (jid) => noteOf(jid),
      ownId: this.identity.ownJid(),
      chatId: chatJid,
      edited: message.editedAt !== null,
      reactions: (lookups === undefined ? db.messages.reactions(message.sid) : (lookups.marks.reactions.get(message.id) ?? [])).flatMap(
        (reaction) => (reaction.jid === null ? [] : [{ emoji: reaction.emoji, sender: reaction.jid }])
      ),
      votes: (lookups === undefined ? db.messages.votes(message.sid) : (lookups.marks.votes.get(message.id) ?? [])).flatMap((vote) => {
        const choice = parseChoice(vote.choice);
        return vote.jid === null || choice === null ? [] : [{ voter: vote.jid, choice }];
      }),
      receipt: this.receiptOf(message, lookups === undefined ? undefined : (lookups.marks.receipts.get(message.id) ?? [])),
      transcript: this.host.transcriptOf(message),
    });
    // A payload wazap does not model has no protobuf field to keep it: what it
    // read as when it arrived is what the row says.
    if (message.type === "unknown" && view.type !== "unknown") {
      view.type = "unknown";
      view.text = message.text ?? view.text;
    }
    return this.withSenderContact(view, message, lookups);
  }

  /**
   * The sender's contact id, the person as the account database knows them: it
   * stays the same when a lid's number becomes known, where `id` changes. The
   * row's own sender for someone else's message; a lookup by id for the
   * account's own, which the row does not name.
   */
  private withSenderContact(view: MessageView, message: StoredMessage, lookups?: ViewLookups): MessageView {
    const contactId =
      !message.fromMe && message.senderId !== null
        ? message.senderId
        : (lookups?.contactIdFor(view.sender.id) ?? this.host.db().identity.contactIdOf(view.sender.id));
    if (contactId !== null) {
      const { id, ...rest } = view.sender;
      view.sender = { id, contact_id: contactId, ...rest };
    }
    return view;
  }

  /**
   * How far one of the account's own messages got: the status it was stored
   * with, raised by every receipt since, each person's latest moments. The
   * account itself is no recipient.
   */
  private receiptOf(message: StoredMessage, stored?: readonly StoredReceipt[]): Receipt | undefined {
    if (!message.fromMe) return undefined;
    const merged: Receipt = {};
    if (message.status !== null) raiseStatus(merged, message.status);
    for (const receipt of stored ?? this.host.db().messages.receipts(message.sid)) {
      if (receipt.jid === null || this.identity.isMe(receipt.jid)) continue;
      raiseUser(merged, receipt.jid, {
        ...(receipt.deliveredAt === null ? {} : { delivered: receipt.deliveredAt }),
        ...(receipt.readAt === null ? {} : { read: receipt.readAt }),
        ...(receipt.playedAt === null ? {} : { played: receipt.playedAt }),
      });
    }
    return merged.status === undefined ? undefined : merged;
  }

  /** A message the database holds only as text: enough to quote it, name its chat and sender, and date it. */
  private textOnlyView(message: StoredMessage): MessageView {
    const sender = message.fromMe ? this.identity.ownJid() : (message.senderJid ?? message.chatJid);
    const phone = phoneOf(sender);
    const note = this.identity.noteFor(sender);
    return this.withSenderContact({
      message_id: message.sid,
      chat_id: message.chatJid,
      from_me: message.fromMe,
      sender: {
        id: sender,
        name: this.identity.displayName(sender),
        ...(phone !== undefined ? { phone } : {}),
        ...(note !== undefined ? { note } : {}),
      },
      type: message.type as MessageType,
      text: this.viewTextOf(message),
      timestamp: isoWithOffset(message.ts),
      age: formatAge(message.ts),
      has_media: false,
      forwarded: false,
      edited: message.editedAt !== null,
    }, message);
  }

  /** The newest message of a chat a reader may see, as the protobuf a chat action names. */
  lastMessageOf(chatJid: string): WAMessage | null {
    const last = this.host.readyDb()?.messages.chatPage(chatJid, { limit: 1 }).items[0];
    return last === undefined ? null : (this.rawOf(last) ?? this.keyOnly(last));
  }

  /**
   * A chat the list shows: one that has had a message, or that WhatsApp
   * described. A deleted chat has neither until something new arrives; the
   * status feed and noise jids are never chats.
   */
  listed(chat: ChatRecord): boolean {
    if (chat.kind === "status" || isNoiseJid(chat.jid)) return false;
    return chat.lastMessageId !== null || chat.proto !== null;
  }

  matchesChatFilter(chat: ChatRecord, filter: ChatFilter): boolean {
    const group = isGroupId(chat.jid);
    switch (filter) {
      case "unread":
        return !chat.archived && unreadOf(chat) > 0;
      case "groups":
        return !chat.archived && group;
      case "individual":
        return !chat.archived && !group;
      case "archived":
        return chat.archived;
      case "all":
        return !chat.archived;
    }
  }

  chatSummary(chat: ChatRecord, described: BaileysChat | null, people: PrivatePeople | null = null): ChatSummary {
    const jid = chat.jid;
    const last = chat.lastMessageId === null ? null : (this.host.db().messages.byIds([chat.lastMessageId])[0] ?? this.host.db().messages.lastVisible(chat.id));
    // Their chat, or what they wrote last in a group: when and who, not what.
    const hidden = last !== null && people !== null && (people.chat(chat) || people.sender(last.senderId));
    const muteEnd = chat.mutedUntil ?? 0;
    const note = this.identity.noteFor(jid);
    const phone = chat.kind === "direct" ? phoneOf(jid) : undefined;
    const summary: ChatSummary = {
      chat_id: jid,
      ...(chat.kind === "direct" && chat.contactId !== null ? { contact_id: chat.contactId } : {}),
      ...(phone === undefined ? {} : { phone: `+${phone}` }),
      name: this.identity.displayName(jid),
      type: isGroupId(jid) ? "group" : "individual",
      unread_count: unreadOf(chat),
      last_message: last
        ? {
            text: hidden ? PRIVATE_TEXT : (last.text ?? ""),
            timestamp: isoWithOffset(last.ts),
            from_me: last.fromMe,
            ...(hidden ? { private: true as const } : {}),
          }
        : null,
      ...(note ? { note } : {}),
      archived: chat.archived,
      pinned: Boolean(chat.pinned),
      muted_until: muteEnd > Date.now() ? isoWithOffset(muteEnd) : null,
    };
    // A group we left is delivered as read-only; individual chats never are.
    if (isGroupId(jid) && described?.readOnly) summary.left = true;
    return summary;
  }

  contactSummary(jid: string): ContactSummary {
    const db = this.host.db();
    const contact = db.identity.contact(jid);
    const phoneJid = jid.endsWith("@lid") ? (this.identity.lids.phoneOf(jid) ?? jid) : jid;
    const number = phoneJid.endsWith("@s.whatsapp.net") ? (phoneJid.split("@")[0] ?? null) : null;
    const notes = db.identity.notes(jid);
    const tags = [...(notes?.tags ?? [])].sort();
    return {
      contact_id: jid,
      name: this.identity.displayName(jid),
      ...(notes?.note ? { note: notes.note } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(notes && Object.keys(notes.fields).length > 0 ? { fields: notes.fields } : {}),
      number,
      is_my_contact: realName(contact?.name) !== "",
      is_business: Boolean(contact?.verifiedName),
    };
  }
}

/** A stored poll choice: the JSON array of option names; null for anything else. */
function parseChoice(choice: string): string[] | null {
  try {
    const parsed = JSON.parse(choice) as unknown;
    return Array.isArray(parsed) && parsed.every((value) => typeof value === "string") ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * What is still unread in a chat. WhatsApp's own count stays where it was when
 * the user reads on the phone, so it gives way to what this account knows: a
 * chat where the user had the last word, or where the phone's read receipts
 * reached the last message, has nothing unread.
 */
export function unreadOf(chat: ChatRecord): number {
  if (chat.unread <= 0 || chat.lastFromMe === true) return 0;
  const through = Math.max(chat.lastOwnId ?? 0, chat.readThroughId ?? 0);
  if (chat.lastMessageId !== null && through >= chat.lastMessageId) return 0;
  return chat.unread;
}
