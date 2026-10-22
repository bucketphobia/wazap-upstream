/**
 * Read-side sender identity: what search, get_message and
 * get_media report about who wrote a message, and how the `from` filter
 * resolves a name. The service renders a sender's `id` and best `name`; this
 * module adds the two pieces an agent still cannot tell apart — the number
 * behind the id, and whether the shown name is the user's own address-book
 * entry or the name the sender publishes.
 */

import { WazapError } from "./errors.js";
import { contactLabel } from "./contact-display.js";
import { isGroupId } from "./ids.js";
import { phoneOf } from "./messages.js";
import { realName } from "./service/identity.js";
import type {
  ContactSummary,
  MessageSender,
  MessageView,
  RecallAnswer,
  RecallHit,
  WhatsAppApi,
} from "./wa-types.js";

/** Where the shown `name` came from: the user's address book, the sender's own published name, or no name at all. */
export type NameSource = "contact" | "pushname" | "none";

/**
 * The sender contract of every read tool: `id` is the canonical WhatsApp id —
 * a `<digits>@s.whatsapp.net`, or a `…@lid` only while WhatsApp has never
 * revealed the number it pairs with — `phone` is that number or null,
 * `contact_name` is the address-book name or null, and `pushname` is the name
 * the sender publishes, when that is the name `name` shows. For a saved
 * contact `name` already is the address-book name, so `pushname` stays null:
 * wazap keeps the sender's own pushname but the service does not surface it.
 *
 * `is_saved` says whether the sender is in the user's address book, and
 * `name_source` says which of the two names `name` shows — `contact` for the
 * saved name, `pushname` for the one the sender's side publishes, `none` when
 * only a number, an "unknown (lid …NNNN)" placeholder or the user's own name
 * is there to show. `!is_saved` means treat the name as claimed, not known.
 *
 * `phone` is null rather than absent — the field must always be there, so an
 * agent can tell "no number exists" apart from "the field was not filled in".
 * MessageSender.phone is `string | undefined`, so the override needs Omit.
 */
export interface SenderIdentity extends Omit<MessageSender, "phone"> {
  phone: string | null;
  contact_name: string | null;
  pushname: string | null;
  is_saved: boolean;
  name_source: NameSource;
}

export interface IdentifiedMessage extends Omit<MessageView, "sender"> {
  sender: SenderIdentity;
}

/** Recall hits and answers whose messages went through withSenderIdentity. */
export interface IdentifiedHit extends Omit<RecallHit, "message"> {
  message: IdentifiedMessage;
}

export interface IdentifiedRecallAnswer extends Omit<RecallAnswer, "hits"> {
  hits: IdentifiedHit[];
}

const UNKNOWN_LID = /^unknown \(lid …\d+\)$/;

/** "me", jids and phone numbers the service resolves itself; a name is the only input that needs lookup. */
function isIdOrPhone(value: string): boolean {
  return value === "me" || value.includes("@") || /^\+?\d[\d\s\-().]*$/.test(value);
}

interface NamedCandidate {
  id: string;
  name: string;
  number: string | null;
}

/**
 * The `from` filter of search. "me", an id or a phone go
 * straight through; anything else is a name and must pick out exactly one
 * person — a saved contact name, a notify name or a last-seen pushname via
 * the address book's index, then a one-to-one chat's display name for someone
 * who only ever wrote and was never saved. No match and several matches are
 * both explicit errors; an exact name beats a substring when it is unique.
 */
export async function resolveSenderFilter(wa: WhatsAppApi, from: string | undefined): Promise<string | undefined> {
  if (from === undefined) return undefined;
  const value = from.trim();
  if (value === "" || isIdOrPhone(value)) return value;

  // One person must not count twice: a lid-keyed contact's `number` already
  // carries its paired phone, and a chat's id digits are that phone, so the
  // dedupe key is the number whenever one is known.
  const named: NamedCandidate[] = [];
  const seen = new Set<string>();
  const push = (id: string, name: string, number: string | null) => {
    const key = number ?? id;
    if (seen.has(key)) return;
    seen.add(key);
    named.push({ id, name, number });
  };

  const contacts = (await wa.searchContacts?.(value, 10).catch(() => undefined)) ?? [];
  for (const c of contacts) push(c.contact_id, c.name, c.number);

  const chats = (await wa.listChats?.("individual", 1000).catch(() => undefined))?.data ?? [];
  const needle = value.toLowerCase();
  for (const chat of chats) {
    const digits = chat.chat_id.split("@")[0] ?? "";
    const number = chat.chat_id.endsWith("@s.whatsapp.net") && /^\d+$/.test(digits) ? digits : null;
    if (realName(chat.name) && chat.name.toLowerCase().includes(needle)) push(chat.chat_id, chat.name, number);
  }

  const exact = named.filter((n) => n.name.toLowerCase() === needle);
  const pool = exact.length > 0 ? exact : named;
  if (pool.length === 1) return pool[0]!.id;
  if (pool.length === 0) {
    throw new WazapError(
      "CONTACT_NOT_FOUND",
      `No contact or chat is named "${value}".`,
      'Call find_contact with the name to see the closest matches, then pass its chat_id as "from"'
    );
  }
  throw new WazapError(
    "INVALID_ID",
    `"${value}" names more than one person: ${pool.map((n) => contactLabel(n.name, n.id, n.number)).join(", ")}.`,
    'Pass "from" as the contact_id or phone number of the one you mean'
  );
}

/**
 * A sender still reading as a lid is usually a pairing wazap never learned:
 * for a group, one metadata fetch pairs every participant it can; for a chat
 * filed under the lid itself, a one-page read runs the account's own lid→number
 * table over it. Both leave the store changed, so the message is re-rendered
 * afterwards rather than patched — a recall "index only" hit has no protobuf to
 * re-render and keeps its stored view.
 */
async function relearnViews(wa: WhatsAppApi, messages: MessageView[]): Promise<MessageView[]> {
  const chats = new Set<string>();
  for (const m of messages) {
    if (!m.from_me && m.sender.id.endsWith("@lid")) chats.add(m.chat_id);
  }
  if (chats.size === 0) return messages;
  for (const chatId of chats) {
    if (isGroupId(chatId)) {
      // groupMetadata is what pairs a participant lid with its number; the
      // result is cached, so a still-unreadable group does not refetch forever.
      await wa.getGroupInfo?.(chatId).catch(() => undefined);
    } else {
      await wa.readMessages?.(chatId, 1).catch(() => undefined);
    }
  }
  return Promise.all(
    messages.map(async (m) => {
      if (m.from_me || !m.sender.id.endsWith("@lid") || !chats.has(m.chat_id)) return m;
      return (await wa.getMessage?.(m.message_id).catch(() => undefined)) ?? m;
    })
  );
}

/** The contact row for a number, when there is one — by exact number, not a substring. */
async function contactOf(wa: WhatsAppApi, phone: string): Promise<ContactSummary | undefined> {
  if (wa.contactByNumber) return wa.contactByNumber(phone).catch(() => undefined);
  const matches = (await wa.searchContacts?.(phone, 10).catch(() => undefined)) ?? [];
  return matches.find((c) => c.number === phone);
}

/**
 * MessageViews with the full sender contract filled in. Group senders still
 * keyed by lid get one re-learning pass first; then every sender gains
 * `phone` (null for a lid WhatsApp never paired), `contact_name` (the saved
 * address-book name, or null) and `pushname` (the name the sender publishes
 * when that is what `name` shows, else null).
 */
export async function withSenderIdentity(wa: WhatsAppApi, messages: MessageView[]): Promise<IdentifiedMessage[]> {
  const relearned = await relearnViews(wa, messages);
  const contacts = new Map<string, Promise<ContactSummary | undefined>>();
  const lookup = (phone: string): Promise<ContactSummary | undefined> => {
    let pending = contacts.get(phone);
    if (!pending) {
      pending = contactOf(wa, phone);
      contacts.set(phone, pending);
    }
    return pending;
  };
  return Promise.all(
    relearned.map(async (m) => {
      const phone = phoneOf(m.sender.id);
      const contact = phone === undefined ? undefined : await lookup(phone);
      const published =
        realName(m.sender.name) !== "" && !UNKNOWN_LID.test(m.sender.name) ? m.sender.name : null;
      const contactName = contact?.is_my_contact ? contact.name : null;
      const pushname = m.from_me || contact?.is_my_contact ? null : published;
      const sender: SenderIdentity = {
        ...m.sender,
        phone: phone ?? null,
        contact_name: contactName,
        pushname,
        is_saved: contact?.is_my_contact === true,
        name_source: contactName !== null ? "contact" : pushname !== null ? "pushname" : "none",
      };
      return { ...m, sender };
    })
  );
}

/** The same name-source question for a contact row: its own saved name, the name it publishes, or no usable name. */
export function nameSourceOf(contact: Pick<ContactSummary, "is_my_contact" | "name">): NameSource {
  if (contact.is_my_contact) return "contact";
  return realName(contact.name) !== "" && !UNKNOWN_LID.test(contact.name) ? "pushname" : "none";
}
