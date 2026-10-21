/** A compact page keeps actionable details and the ids behind grouped text. */
import { mediaCaptionOf } from "./media-details.js";
import type { MessageType, MessageView } from "./wa-types.js";

type CompactMessage = MessageView & { message_ids?: string[]; first_timestamp?: string };

function useful(message: MessageView): boolean {
  if (message.private) return true;
  switch (message.type) {
    case "deleted": case "sticker": case "reaction": case "view_once": return false;
    case "image": case "video": return mediaCaptionOf(message) !== null;
    case "document": return mediaCaptionOf(message) !== null || Boolean(message.media?.filename);
    case "voice": case "audio": return Boolean(message.transcript?.trim());
    case "call": case "location": case "contact": case "poll": case "system": return true;
    case "text": return /[\p{L}\p{N}]/u.test(message.text);
    default: return /[\p{L}\p{N}]/u.test(message.text.replace(/^\[[^\]]*\]\s*/, ""));
  }
}

/** Quotes, reactions and other per-message details must not be attributed to a different message. */
function plain(message: MessageView): boolean {
  return message.type === "text" && !message.private && !message.forwarded && !message.quoted && !message.mentions?.length
    && !message.reactions?.length && !message.edited;
}

export function compactRecent(messages: readonly MessageView[]) {
  const shown: CompactMessage[] = [];
  const omitted: Partial<Record<MessageType, number>> = {};
  let retained = 0;
  let previous: MessageView | undefined;
  for (const message of messages) {
    if (!useful(message)) {
      omitted[message.type] = (omitted[message.type] ?? 0) + 1;
      previous = undefined;
      continue;
    }
    retained++;
    const last = shown.at(-1);
    if (last && previous && plain(previous) && plain(message)
      && previous.sender.id === message.sender.id && previous.from_me === message.from_me) {
      shown[shown.length - 1] = { ...message, text: `${last.text}\n${message.text}`,
        message_ids: [...(last.message_ids ?? [last.message_id]), message.message_id],
        first_timestamp: last.first_timestamp ?? last.timestamp };
    } else shown.push({ ...message });
    previous = message;
  }
  return { messages: shown, omitted, shown_message_count: retained };
}
