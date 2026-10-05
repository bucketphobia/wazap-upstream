/**
 * The `#private` tag: someone the user keeps out of what an assistant is
 * handed without asking. Their words — a message's text, caption, transcript,
 * quote, a link's or a file's preview, a poll's text — reach the assistant only
 * when the call names them: their chat (`chat_id`), a message of theirs
 * (`message_id`, get_message and get_media) or them as the author (search's
 * `from`). A group named by `chat_id` reads whole. Everywhere else the words
 * stay out and the metadata stays in: who, when, in which chat, what kind, how
 * many.
 *
 * - catch_up counts them without quoting (src/catchup-scan.ts);
 * - find_contact's draft context keeps only the user's style for them;
 * - search without `chat_id` leaves their messages out before its limit and
 *   counts them in `private_omitted`, and a quote of theirs loses its words;
 * - wait_for_messages without `chat_id` keeps what arrived from them without
 *   its words (withoutWords), marked `private`; waiting on a chat, theirs or a
 *   group's, names it;
 * - list_chats keeps the last message of their chat, or theirs in a group,
 *   without its words, marked `private`;
 * - read_messages on "status" keeps their stories without text, caption or
 *   preview, marked `private`: a story is never asked for by name.
 *
 * The tag goes with the person, not only their chat: what they write in a
 * group is theirs too. A broad read takes the whole set once per call and per
 * account (privatePeople), and with several accounts a person tagged on any of
 * them is tagged on all: the accounts pass each other the jids (taggedJids,
 * the tools' privateRule). With a webhook allowlist configured, a `#private`
 * contact is left out of it too, even when listed or tagged for it
 * (src/webhook-filter.ts). With no allowlist the webhook is unchanged.
 *
 * Tags are stored normalized (lowercase, without "#"), so the tag a user files
 * as "#private" or "Private" is `private`. Groups carry no tags.
 */
import { chatKindOf, type AccountDb } from "./db/index.js";
import type { MessageView } from "./wa-types.js";

export const PRIVATE_TAG = "private";

/** What stands in for the words of a message kept #private: never empty, like every message's text. */
export const PRIVATE_TEXT = "[private]";

/** Whether a contact's stored tags include `#private`. */
export function hasPrivateTag(tags: readonly string[] | null | undefined): boolean {
  return tags?.includes(PRIVATE_TAG) === true;
}

/** Whether the person behind a chat (any spelling of their jid) carries `#private`; false for a group or a stranger. */
export function isPrivateChat(db: AccountDb, chatJid: string): boolean {
  return chatKindOf(chatJid) === "direct" && isPrivateSender(db, chatJid);
}

/**
 * Whether the person who wrote a message (its sender's phone jid or lid)
 * carries `#private`: their words in a group are left out like their chat.
 * Null, the user's own message, is never private.
 */
export function isPrivateSender(db: AccountDb, senderJid: string | null | undefined): boolean {
  if (senderJid === null || senderJid === undefined || chatKindOf(senderJid) !== "direct") return false;
  return hasPrivateTag(db.identity.notes(senderJid)?.tags);
}

/** Everyone kept #private for one call on one account, read once. */
export interface PrivatePeople {
  /** Nobody is: every check answers false. */
  readonly none: boolean;
  /** Every contact row that is one of them (digest.tagged). */
  readonly contactIds: ReadonlySet<number>;
  /** Their numbers and lids, the other accounts' included. */
  readonly jids: ReadonlySet<string>;
  /** Their chat with the user. */
  chat(chat: { jid: string; contactId: number | null }): boolean;
  /** Written by one of them; null, the user's own, never is. */
  sender(senderId: number | null): boolean;
  /** A stored message in their chat, or written by them anywhere; each chat is looked up once. */
  message(message: { chatId: number; chatJid: string; senderId: number | null }): boolean;
  /** A number or lid that is one of them, as a call names an author or a draft context a person; "me" never is. */
  names(jid: string): boolean;
}

/**
 * The people tagged #private on this account, and those another account of
 * the call tagged, named by `others` (their numbers and lids): the one read a
 * catch-up and a broad read each make per account.
 */
export function privatePeople(db: AccountDb, others: readonly string[] = []): PrivatePeople {
  const { contactIds, jids } = db.digest.tagged(PRIVATE_TAG, others);
  const none = contactIds.size === 0 && jids.size === 0;
  const chat = (row: { jid: string; contactId: number | null }): boolean =>
    (row.contactId !== null && contactIds.has(row.contactId)) || jids.has(row.jid);
  const sender = (senderId: number | null): boolean => senderId !== null && contactIds.has(senderId);
  const chats = new Map<number, boolean>();
  return {
    none,
    contactIds,
    jids,
    chat,
    sender,
    message(message) {
      if (none) return false;
      if (sender(message.senderId)) return true;
      let theirs = chats.get(message.chatId);
      if (theirs === undefined) {
        const row = db.identity.chatById(message.chatId);
        theirs = jids.has(message.chatJid) || (row !== null && chat(row));
        chats.set(message.chatId, theirs);
      }
      return theirs;
    },
    names(jid) {
      if (none || jid === "me") return false;
      return jids.has(jid) || db.identity.contactIdsOf(jid).some((id) => contactIds.has(id));
    },
  };
}

/**
 * A message of someone kept #private, as a broad read hands it out: who, when,
 * in which chat and what kind, and none of its words — no text, caption,
 * transcript, quote, mention, file name, poll or reaction — marked `private`.
 */
export function withoutWords(view: MessageView): MessageView {
  const { message_id, chat_id, from_me, sender, type, timestamp, age, has_media, media, call, system, forwarded, edited, delivery } = view;
  return {
    message_id,
    chat_id,
    from_me,
    sender,
    type,
    text: PRIVATE_TEXT,
    timestamp,
    age,
    has_media,
    ...(media === undefined ? {} : { media: { mime: media.mime, ...(media.size === undefined ? {} : { size: media.size }) } }),
    ...(call === undefined ? {} : { call }),
    ...(system === undefined ? {} : { system: { action: system.action, ...(system.actor === undefined ? {} : { actor: system.actor }), targets: system.targets } }),
    forwarded,
    edited,
    ...(delivery === undefined ? {} : { delivery }),
    private: true,
  };
}

/** A message that quotes someone kept #private keeps the quote's id and author, not its words, unless the call named that author (`named`, a jid). */
export function withoutPrivateQuote(view: MessageView, people: PrivatePeople, named?: string): MessageView {
  if (view.quoted === undefined || view.quoted.sender === named || !people.jids.has(view.quoted.sender)) return view;
  return { ...view, quoted: { ...view.quoted, text: PRIVATE_TEXT } };
}
