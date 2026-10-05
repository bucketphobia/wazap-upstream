/**
 * Which chats the webhook may post once an allowlist is configured.
 *
 * No filter posts every chat, as it always has. A filter posts a message when
 * the chat is listed, or when the chat is a direct chat and its contact
 * carries the tag (`remember` writes the tag; it is read here, so adding or
 * removing it takes effect without a restart). A group matches only when its
 * chat id is listed: a member's tag does not pull the group in. A contact
 * tagged `#private` never matches, not even when listed or tagged as well,
 * and neither does a message they wrote in a group that is listed.
 */
import { chatKindOf, type AccountDb, type StoredMessage } from "./db/index.js";
import { isPrivateChat, isPrivateSender } from "./private-contacts.js";
import { addressMatches, type SendTarget } from "./send-guard.js";
import type { WebhookFilter } from "./webhook.js";

export function webhookAllowsMessage(db: AccountDb, filter: WebhookFilter | null, message: StoredMessage): boolean {
  if (filter === null) return true;
  if (isPrivateChat(db, message.chatJid)) return false;
  if (!message.fromMe && isPrivateSender(db, message.senderJid)) return false;
  if (filter.chats.length > 0 && chatListed(db, filter.chats, message.chatJid)) return true;
  if (filter.tag !== null && chatKindOf(message.chatJid) === "direct" && contactHasTag(db, message.chatJid, filter.tag)) {
    return true;
  }
  return false;
}

function chatListed(db: AccountDb, chats: readonly string[], chatJid: string): boolean {
  const number = phoneDigits(db, chatJid);
  const target: SendTarget = number === undefined ? { chat_id: chatJid } : { chat_id: chatJid, number };
  return chats.some((entry) => addressMatches(entry, target));
}

/** The digits a phone-number rule can match: the chat's own number, or the number paired with its lid. */
function phoneDigits(db: AccountDb, chatJid: string): string | undefined {
  const canonical = db.identity.canonicalJid(chatJid);
  if (canonical.endsWith("@s.whatsapp.net")) {
    const user = canonical.split("@")[0] ?? "";
    if (/^\d+$/.test(user)) return user;
  }
  const phone = db.identity.phoneOfLid(chatJid);
  if (phone === null) return undefined;
  const digits = phone.split("@")[0] ?? "";
  return /^\d+$/.test(digits) ? digits : undefined;
}

/** The tag `remember` filed on the person behind this direct chat, in whatever spelling the chat uses. */
function contactHasTag(db: AccountDb, chatJid: string, tag: string): boolean {
  if (db.identity.notes(chatJid)?.tags.includes(tag) === true) return true;
  const phone = db.identity.phoneOfLid(chatJid);
  return phone !== null && db.identity.notes(phone)?.tags.includes(tag) === true;
}
