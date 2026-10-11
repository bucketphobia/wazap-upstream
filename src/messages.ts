/**
 * Message shaping. Pure: no socket, no store, no I/O — everything the store
 * knows (display names, lid→pn) arrives through MessageViewContext.
 */

import { getContentType, proto, type WAMessage, type WAMessageContent, type WAMessageKey } from "baileys";
import type { Receipt } from "./store.js";
import type { TranscriptRecord } from "./transcribe/index.js";
import type {
  CallDirection,
  CallInfo,
  CallKind,
  CallOutcome,
  Delivery,
  DeliveryStatus,
  EventParty,
  EventResponses,
  MessageType,
  MessageView,
  PollResults,
  SystemEvent,
  SystemEventAction,
  Voter,
} from "./wa-types.js";

/** protobuf 64-bit fields arrive as a number or a Long. */
type ProtoLong = number | { toNumber?: () => number } | null | undefined;

export function protoNumber(value: ProtoLong): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return value;
  return typeof value.toNumber === "function" ? value.toNumber() : undefined;
}

export function messageTimestampMs(raw: WAMessage): number {
  const seconds = protoNumber(raw.messageTimestamp);
  return seconds === undefined ? Date.now() : seconds * 1000;
}

/** Stable across restarts. Not stable if the chat's own jid is later remapped
 * from a LID to a phone number, which is why wazap does not remap chat jids. */
export function messageIdFor(key: WAMessageKey, chatId: string): string {
  return `${key.fromMe ? "true" : "false"}_${chatId}_${key.id ?? ""}`;
}

interface Rule {
  type: MessageType | ((m: WAMessageContent) => MessageType);
  tag: string | ((m: WAMessageContent) => string);
  /** Real text, which replaces the tag entirely. */
  text?: (m: WAMessageContent) => string | null | undefined;
  /** A caption, which follows the tag. */
  caption?: (m: WAMessageContent) => string | null | undefined;
  /** Shown after the tag only when there is no caption. */
  detail?: (m: WAMessageContent) => string | null | undefined;
}

function coords(lat: ProtoLong, lng: ProtoLong): string | undefined {
  const a = protoNumber(lat);
  const b = protoNumber(lng);
  return a === undefined || b === undefined ? undefined : `${a.toFixed(2)}, ${b.toFixed(2)}`;
}

function pollName(m: WAMessageContent): string | undefined {
  const inner = m.pollCreationMessageV4?.message;
  return (
    m.pollCreationMessage?.name ??
    m.pollCreationMessageV2?.name ??
    m.pollCreationMessageV3?.name ??
    m.pollCreationMessageV5?.name ??
    inner?.pollCreationMessage?.name ??
    undefined
  );
}

const POLL: Rule = { type: "poll", tag: "[poll]", detail: pollName };

function viewOnceInner(m: WAMessageContent): WAMessageContent | undefined {
  return (
    m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.viewOnceMessageV2Extension?.message ?? undefined
  );
}

const VIEW_ONCE: Rule = {
  type: "view_once",
  tag: (m) => (viewOnceInner(m)?.videoMessage ? "[view-once video]" : "[view-once photo]"),
};

const SYSTEM_TEXT = "[system message]";
const DELETED_TEXT = "[deleted]";

function isRevoke(m: WAMessageContent): boolean {
  return m.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE;
}

const PROTOCOL: Rule = {
  type: (m) => (isRevoke(m) ? "deleted" : "system"),
  tag: (m) => (isRevoke(m) ? DELETED_TEXT : SYSTEM_TEXT),
};

const SYSTEM: Rule = { type: "system", tag: SYSTEM_TEXT };

/** Names the payload, so a bug report says which one to add. */
const UNKNOWN: Rule = {
  type: "unknown",
  tag: (m) => {
    const key = getContentType(m) ?? Object.keys(m).find((name) => m[name as keyof WAMessageContent] != null);
    return key ? `[unsupported: ${key}]` : "[unsupported message]";
  },
};

/** Payloads WhatsApp exchanges with its own clients; no person ever sent one. */
const CONTROL_KEYS: ReadonlyArray<keyof WAMessageContent> = ["messageContextInfo", "senderKeyDistributionMessage"];

/**
 * The protocol messages that report something a person did. Baileys enumerates
 * exactly these as cross-user in Utils/process-message.js — every other type is
 * one device talking to another. MESSAGE_EDIT is cross-user too, but wazap
 * applies the edit to the message it edits, so its envelope is not a second
 * message to show.
 */
const REPORTABLE_PROTOCOL_TYPES: ReadonlySet<number> = new Set([
  proto.Message.ProtocolMessage.Type.REVOKE,
  proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
  proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
]);

/** The parts that are there, as one line: "order · 2 items", "Pisici · caption". */
function joined(...parts: Array<string | null | undefined>): string | undefined {
  const kept = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return kept.length > 0 ? kept.join(" · ") : undefined;
}

/**
 * A business message as the person reads it: title, body and footer, then what
 * they can tap. Only the labels: a button also carries the URL, number or
 * one-time code it acts on, and none of that is something anyone wrote.
 */
function tappable(
  lines: Array<string | null | undefined>,
  kind: "buttons" | "options",
  labels: Array<string | null | undefined>
): string | undefined {
  const text = lines
    .map((line) => line?.trim())
    .filter(Boolean)
    .join("\n");
  const choices = joined(...labels);
  return [text, choices ? `(${kind}: ${choices})` : ""].filter(Boolean).join("\n") || undefined;
}

/** A native-flow button keeps its label in JSON, beside the link or the code to copy. */
function flowLabel(json: string | null | undefined): string | undefined {
  if (!json) return undefined;
  try {
    const params = JSON.parse(json) as Record<string, unknown>;
    return typeof params.display_text === "string" ? params.display_text : undefined;
  } catch {
    return undefined;
  }
}

function interactiveText(message: proto.Message.IInteractiveMessage | null | undefined): string | undefined {
  if (!message) return undefined;
  return tappable(
    [message.header?.title, message.header?.subtitle, message.body?.text, message.footer?.text],
    "buttons",
    (message.nativeFlowMessage?.buttons ?? []).map((button) => flowLabel(button.buttonParamsJson))
  );
}

/** A template arrives hydrated or as an interactive message; banks and couriers send both. */
function templateText(m: WAMessageContent): string | undefined {
  const template = m.templateMessage;
  const hydrated = template?.hydratedFourRowTemplate ?? template?.hydratedTemplate;
  if (!hydrated) return interactiveText(template?.interactiveMessageTemplate);
  return tappable(
    [hydrated.hydratedTitleText, hydrated.hydratedContentText, hydrated.hydratedFooterText],
    "buttons",
    (hydrated.hydratedButtons ?? []).map(
      (button) => (button.quickReplyButton ?? button.urlButton ?? button.callButton)?.displayText
    )
  );
}

function orderTag(m: WAMessageContent): string {
  const order = m.orderMessage;
  const items = order?.itemCount ?? 0;
  const total = protoNumber(order?.totalAmount1000);
  return `[${joined(
    "order",
    items > 0 ? `${items} item${items === 1 ? "" : "s"}` : undefined,
    total !== undefined && order?.totalCurrencyCode ? `${(total / 1000).toFixed(2)} ${order.totalCurrencyCode}` : undefined
  )}]`;
}

function scheduledCallTag(m: WAMessageContent): string {
  const call = m.scheduledCallCreationMessage;
  const kind = call?.callType === proto.Message.ScheduledCallCreationMessage.CallType.VIDEO ? "video" : "voice";
  const at = protoNumber(call?.scheduledTimestampMs);
  return `[${joined(`scheduled ${kind} call`, at ? isoWithOffset(at) : undefined)}]`;
}

function pollResults(m: WAMessageContent): string | undefined {
  const poll = m.pollResultSnapshotMessage;
  const votes = (poll?.pollVotes ?? []).map((vote) =>
    vote.optionName ? `${vote.optionName}: ${protoNumber(vote.optionVoteCount) ?? 0}` : undefined
  );
  return joined(poll?.name, ...votes);
}

/**
 * One table drives both messageType and messageText, so the reported type and
 * the placeholder can never disagree.
 */
const RULES: Partial<Record<keyof WAMessageContent, Rule>> = {
  conversation: { type: "text", tag: "[text]", text: (m) => m.conversation },
  extendedTextMessage: { type: "text", tag: "[text]", text: (m) => m.extendedTextMessage?.text },
  imageMessage: { type: "image", tag: "[image]", caption: (m) => m.imageMessage?.caption },
  // A GIF on WhatsApp is an mp4 with a flag; the reader deserves the word.
  videoMessage: {
    type: "video",
    tag: (m) => (m.videoMessage?.gifPlayback ? "[gif]" : "[video]"),
    caption: (m) => m.videoMessage?.caption,
  },
  ptvMessage: { type: "video", tag: "[video]", caption: (m) => m.ptvMessage?.caption },
  audioMessage: {
    type: (m) => (m.audioMessage?.ptt ? "voice" : "audio"),
    // The duration goes inside the brackets, the way a call's does: everything
    // after the tag is caption territory, and this is not a caption.
    tag: (m) => {
      const kind = m.audioMessage?.ptt ? "voice message" : "audio";
      const seconds = audioSeconds(m);
      return seconds === undefined ? `[${kind}]` : `[${kind} · ${clockLabel(seconds)}]`;
    },
  },
  documentMessage: {
    type: "document",
    tag: "[document]",
    caption: (m) => m.documentMessage?.caption,
    detail: (m) => m.documentMessage?.fileName,
  },
  stickerMessage: { type: "sticker", tag: "[sticker]" },
  lottieStickerMessage: { type: "sticker", tag: "[sticker]" },
  // The header WhatsApp sends before the photos of an album; the photos follow
  // as messages of their own, so this is a notice, not content.
  // An edit WhatsApp encrypted with the message's own secret; the new text
  // is not readable from a linked device, only the fact of the edit.
  secretEncryptedMessage: {
    type: "system",
    tag: (m) => (m.secretEncryptedMessage?.secretEncType === 1 ? "[edited an event]" : "[edited a message]"),
  },
  albumMessage: {
    type: "system",
    tag: (m) => {
      const n = (m.albumMessage?.expectedImageCount ?? 0) + (m.albumMessage?.expectedVideoCount ?? 0);
      return n > 0 ? `[album · ${n} items]` : "[album]";
    },
  },
  locationMessage: {
    type: "location",
    tag: "[location]",
    detail: (m) =>
      m.locationMessage?.name ?? coords(m.locationMessage?.degreesLatitude, m.locationMessage?.degreesLongitude),
  },
  liveLocationMessage: {
    type: "location",
    tag: "[location]",
    detail: (m) =>
      m.liveLocationMessage?.caption ??
      coords(m.liveLocationMessage?.degreesLatitude, m.liveLocationMessage?.degreesLongitude),
  },
  contactMessage: { type: "contact", tag: "[contact]", detail: (m) => m.contactMessage?.displayName },
  contactsArrayMessage: { type: "contact", tag: "[contact]", detail: (m) => m.contactsArrayMessage?.displayName },
  pollCreationMessage: POLL,
  pollCreationMessageV2: POLL,
  pollCreationMessageV3: POLL,
  pollCreationMessageV4: POLL,
  pollCreationMessageV5: POLL,
  reactionMessage: { type: "reaction", tag: "[reaction]", detail: (m) => m.reactionMessage?.text },
  // What a business or a bot sends is still words for the person reading it,
  // so it reads and searches as text rather than hiding as a system line.
  templateMessage: { type: "text", tag: "[template]", text: templateText },
  interactiveMessage: {
    type: "text",
    tag: "[interactive message]",
    text: (m) => interactiveText(m.interactiveMessage),
  },
  buttonsMessage: {
    type: "text",
    tag: "[buttons]",
    text: (m) =>
      tappable(
        [m.buttonsMessage?.text, m.buttonsMessage?.contentText, m.buttonsMessage?.footerText],
        "buttons",
        (m.buttonsMessage?.buttons ?? []).map((button) => button.buttonText?.displayText)
      ),
  },
  listMessage: {
    type: "text",
    tag: "[list]",
    text: (m) =>
      tappable(
        [m.listMessage?.title, m.listMessage?.description, m.listMessage?.footerText],
        "options",
        (m.listMessage?.sections ?? []).flatMap((section) => (section.rows ?? []).map((row) => row.title))
      ),
  },
  // A tap is the person's answer, in the words that were on the button.
  buttonsResponseMessage: {
    type: "text",
    tag: "[button reply]",
    text: (m) => m.buttonsResponseMessage?.selectedDisplayText,
  },
  listResponseMessage: { type: "text", tag: "[list reply]", text: (m) => m.listResponseMessage?.title },
  templateButtonReplyMessage: {
    type: "text",
    tag: "[button reply]",
    text: (m) => m.templateButtonReplyMessage?.selectedDisplayText,
  },
  // WhatsApp keeps this one off linked devices on purpose; the phone is the
  // only place it can be read, and saying so beats a bare "unsupported".
  placeholderMessage: { type: "unknown", tag: "[message not shown on linked devices; read it on the phone]" },
  requestPhoneNumberMessage: { type: "text", tag: "[asked for your phone number]" },
  // The order's id, token and seller stay out: they are keys, not something said.
  orderMessage: {
    type: "text",
    tag: orderTag,
    caption: (m) => m.orderMessage?.message,
    detail: (m) => m.orderMessage?.orderTitle,
  },
  productMessage: {
    type: "text",
    tag: "[product]",
    caption: (m) => joined(m.productMessage?.product?.title, m.productMessage?.body),
  },
  statusMentionMessage: { type: "text", tag: "[mentioned you in their status]" },
  scheduledCallCreationMessage: {
    type: "text",
    tag: scheduledCallTag,
    detail: (m) => m.scheduledCallCreationMessage?.title,
  },
  pollResultSnapshotMessage: { type: "poll", tag: "[poll results]", detail: pollResults },
  newsletterAdminInviteMessage: {
    type: "text",
    tag: "[channel admin invite]",
    caption: (m) => joined(m.newsletterAdminInviteMessage?.newsletterName, m.newsletterAdminInviteMessage?.caption),
  },
  stickerPackMessage: {
    type: "sticker",
    tag: (m) => {
      const count = m.stickerPackMessage?.stickers?.length ?? 0;
      return `[${joined("sticker pack", count > 0 ? `${count} stickers` : undefined)}]`;
    },
    caption: (m) => joined(m.stickerPackMessage?.name, m.stickerPackMessage?.caption),
  },
  eventMessage: {
    type: "event",
    tag: (m) => (m.eventMessage?.isCanceled ? "[canceled event]" : "[event]"),
    // Name, start and place on one line, the description under it. The join
    // link is a way into the call, as good as an invite code, and stays out.
    caption: (m) => {
      const event = m.eventMessage;
      const start = protoNumber(event?.startTime);
      const place = event?.location?.name ?? event?.location?.address;
      const header = joined(event?.name, start ? isoWithOffset(start * 1000) : undefined, place);
      return [header, event?.description?.trim()].filter(Boolean).join("\n") || undefined;
    },
  },
  // The invite code lets anyone who holds it into the group, so only the
  // group's name and the caption are shown.
  groupInviteMessage: {
    type: "invite",
    tag: "[group invite]",
    caption: (m) => joined(m.groupInviteMessage?.groupName, m.groupInviteMessage?.caption),
  },
  // A vote lands on its poll and a response on its event, the way a reaction
  // lands on its target. One still shown as a line of its own is waiting for a
  // poll or event this device has not loaded, or could not read.
  pollUpdateMessage: { type: "system", tag: "[vote on a poll that is not loaded]" },
  encEventResponseMessage: { type: "system", tag: "[response to an event that is not loaded]" },
  // Notices about something a person did; groupEventOf puts the name in front.
  pinInChatMessage: { type: "system", tag: "[pinned a message]" },
  keepInChatMessage: { type: "system", tag: "[kept a message]" },
  messageHistoryBundle: { type: "system", tag: "[shared the chat history]" },
  viewOnceMessage: VIEW_ONCE,
  viewOnceMessageV2: VIEW_ONCE,
  viewOnceMessageV2Extension: VIEW_ONCE,
  protocolMessage: PROTOCOL,
  senderKeyDistributionMessage: SYSTEM,
  messageContextInfo: SYSTEM,
};

const MEDIA_KEYS: ReadonlyArray<keyof WAMessageContent> = [
  "imageMessage",
  "videoMessage",
  "ptvMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
];

interface MediaNode {
  mimetype?: string | null;
  fileLength?: ProtoLong;
  fileName?: string | null;
  jpegThumbnail?: Uint8Array | null;
  fileSha256?: Uint8Array | null;
}

/** Media whose WhatsApp envelope carries a JPEG preview of a few KB. */
const THUMBNAIL_KEYS: ReadonlyArray<keyof WAMessageContent> = [
  "imageMessage",
  "videoMessage",
  "ptvMessage",
  "documentMessage",
];

/** Envelopes that only wrap another message; the inner one is the real content. */
function unwrapEnvelopes(content: WAMessageContent | null | undefined): WAMessageContent | undefined {
  let current = content ?? undefined;
  for (let depth = 0; depth < 5 && current; depth++) {
    const inner =
      current.deviceSentMessage?.message ??
      current.ephemeralMessage?.message ??
      current.documentWithCaptionMessage?.message ??
      // A photo or video sent as part of an album, or in reply to a story:
      // the real message sits one level down.
      current.associatedChildMessage?.message;
    if (!inner) break;
    current = inner;
  }
  return current;
}

function ruleFor(
  content: WAMessageContent | undefined,
  key = content ? getContentType(content) : undefined,
): { rule: Rule; content: WAMessageContent } {
  if (!content) return { rule: UNKNOWN, content: {} };
  const rule = key ? RULES[key] : undefined;
  if (rule) return { rule, content };
  // Only when the control keys are all there is. A payload wazap does not model
  // yet usually carries messageContextInfo alongside it, and calling that a
  // system message would hide someone's event, album or order behind
  // "[system message]" and then out of the digest.
  if (key === undefined && (content.messageContextInfo || content.senderKeyDistributionMessage)) {
    return { rule: SYSTEM, content };
  }
  return { rule: UNKNOWN, content };
}

function stubKind(raw: WAMessage): MessageType | undefined {
  const stub = raw.messageStubType;
  if (stub === null || stub === undefined) return undefined;
  if (stub === proto.WebMessageInfo.StubType.REVOKE) return "deleted";
  return stub === proto.WebMessageInfo.StubType.UNKNOWN ? undefined : "system";
}

/** The name a stub type goes by, so a notice wazap does not spell out still says which one it is. */
function stubTypeName(raw: WAMessage): string | undefined {
  return proto.WebMessageInfo.StubType[raw.messageStubType ?? -1];
}

/** The sentence for one notice. `self` is a change someone made to themselves: joining, leaving. */
type Say = (actor: string, targets: string, value: string | undefined, self: boolean) => string;

interface GroupStub {
  action: SystemEventAction;
  /** What messageStubParameters holds: everyone the change touched, the new value, or nothing to show. */
  params: "participants" | "value" | "none" | "request";
  say: Say;
}

/** A group notice before any name is looked up: the jids exactly as the stub carries them. */
interface GroupEvent {
  spec: GroupStub;
  /** Who made the change, as the key names them; undefined when WhatsApp did not say. */
  actor: string | undefined;
  fromMe: boolean;
  targets: string[];
  value: string | undefined;
  /** The message a pin or a keep points at; its message_id needs the chat, so the view builds it. */
  target?: WAMessageKey;
}

/** A setting WhatsApp reports as on/off in a live notice and as true/false in synced history. */
function toggle(on: string, off: string, unclear: string): Say {
  return (actor, _targets, value) => {
    const state = value === "on" || value === "true" ? on : value === "off" || value === "false" ? off : unclear;
    return `${actor} ${state}`;
  };
}

const StubType = proto.WebMessageInfo.StubType;

const PIN: GroupStub = { action: "pin_message", params: "none", say: (actor) => `${actor} pinned a message` };
const UNPIN: GroupStub = { action: "unpin_message", params: "none", say: (actor) => `${actor} unpinned a message` };
const KEEP: GroupStub = { action: "keep_message", params: "none", say: (actor) => `${actor} kept a message` };
const UNKEEP: GroupStub = { action: "unkeep_message", params: "none", say: (actor) => `${actor} unkept a message` };

/** What an admin hands a new member: the messages from before they joined. */
const SHARE_HISTORY: GroupStub = {
  action: "share_history",
  params: "participants",
  say: (actor, targets, value) => {
    const count = value === undefined ? "" : ` (${value} message${value === "1" ? "" : "s"})`;
    return `${actor} shared the chat history${count}${targets ? ` with ${targets}` : ""}`;
  },
};

const GROUP_STUBS: Partial<Record<number, GroupStub>> = {
  // The one parameter is whoever pinned, the same jid the key names; the stub
  // says neither which message nor whether it was an unpin.
  [StubType.PINNED_MESSAGE_IN_CHAT]: PIN,
  [StubType.GROUP_CREATE]: {
    action: "create",
    params: "value",
    say: (actor, _targets, value) => (value ? `${actor} created the group "${value}"` : `${actor} created the group`),
  },
  [StubType.GROUP_PARTICIPANT_ADD]: {
    action: "add",
    params: "participants",
    say: (actor, targets, _value, self) => (self ? `${targets} joined` : `${actor} added ${targets}`),
  },
  [StubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN]: {
    action: "add",
    params: "participants",
    say: (actor, targets) => `${actor} added ${targets} after a request to join`,
  },
  [StubType.GROUP_PARTICIPANT_INVITE]: {
    action: "join_via_link",
    params: "participants",
    say: (actor, targets) => `${targets || actor} joined using the invite link`,
  },
  [StubType.GROUP_PARTICIPANT_REMOVE]: {
    action: "remove",
    params: "participants",
    say: (actor, targets, _value, self) => (self ? `${targets} left` : `${actor} removed ${targets}`),
  },
  [StubType.GROUP_PARTICIPANT_LEAVE]: {
    action: "leave",
    params: "participants",
    say: (actor, targets) => `${targets || actor} left`,
  },
  [StubType.GROUP_PARTICIPANT_PROMOTE]: {
    action: "promote",
    params: "participants",
    say: (actor, targets) => `${actor} made ${targets} admin`,
  },
  [StubType.GROUP_PARTICIPANT_DEMOTE]: {
    action: "demote",
    params: "participants",
    say: (actor, targets) => `${actor} dismissed ${targets} as admin`,
  },
  [StubType.GROUP_PARTICIPANT_CHANGE_NUMBER]: {
    action: "change_number",
    params: "participants",
    say: (actor) => `${actor} changed their phone number`,
  },
  [StubType.GROUP_CHANGE_SUBJECT]: {
    action: "set_subject",
    params: "value",
    say: (actor, _targets, value) => (value ? `${actor} renamed the group to "${value}"` : `${actor} renamed the group`),
  },
  [StubType.GROUP_CHANGE_DESCRIPTION]: {
    action: "set_description",
    params: "value",
    say: (actor) => `${actor} changed the group description`,
  },
  // A removed photo and a synced one both arrive without the new photo's id, so
  // "removed" cannot be told apart from "changed" and is not claimed.
  [StubType.GROUP_CHANGE_ICON]: {
    action: "set_picture",
    params: "none",
    say: (actor) => `${actor} changed the group photo`,
  },
  // The parameter is the new invite code, and the code lets anyone in: not a thing to print.
  [StubType.GROUP_CHANGE_INVITE_LINK]: {
    action: "reset_invite_link",
    params: "none",
    say: (actor) => `${actor} reset the invite link`,
  },
  [StubType.GROUP_CHANGE_ANNOUNCE]: {
    action: "set_announcement_only",
    params: "value",
    say: toggle(
      "allowed only admins to send messages",
      "allowed every member to send messages",
      "changed who can send messages"
    ),
  },
  [StubType.GROUP_CHANGE_RESTRICT]: {
    action: "set_info_locked",
    params: "value",
    say: toggle(
      "allowed only admins to edit the group info",
      "allowed every member to edit the group info",
      "changed who can edit the group info"
    ),
  },
  [StubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE]: {
    action: "set_join_approval",
    params: "value",
    say: toggle(
      "turned on admin approval for new members",
      "turned off admin approval for new members",
      "changed admin approval for new members"
    ),
  },
  [StubType.GROUP_MEMBER_ADD_MODE]: {
    action: "set_add_mode",
    params: "value",
    say: (actor, _targets, value) =>
      value === "all_member_add"
        ? `${actor} allowed every member to add others`
        : value === "admin_add"
          ? `${actor} allowed only admins to add members`
          : `${actor} changed who can add members`,
  },
  // A request to join a group that needs an admin's approval: who asked, then
  // what became of the request. The request method that follows is not shown.
  [StubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD]: {
    action: "join_request",
    params: "request",
    say: (actor, targets, value) =>
      value === "created"
        ? `${targets} asked to join`
        : value === "revoked"
          ? `${targets} withdrew their request to join`
          : value === "rejected"
            ? `${actor} rejected ${targets}'s request to join`
            : `${targets}'s request to join changed`,
  },
};

/**
 * A participant as a group notice names them. A live notice carries JSON with
 * a lid and, when WhatsApp sent one, the number; synced history a bare jid.
 * The number wins, since a lid alone often cannot be put to a name.
 */
function stubParty(param: string): string | undefined {
  if (!param.startsWith("{")) return param.includes("@") ? param : undefined;
  try {
    const party = JSON.parse(param) as Record<string, unknown>;
    return [party.phoneNumber, party.pn, party.id, party.lid].find(
      (jid): jid is string => typeof jid === "string" && jid.includes("@")
    );
  } catch {
    return undefined;
  }
}

/** A member label arrives as a protocol message rather than a stub, but it is the same kind of notice. */
const MEMBER_LABEL: GroupStub = {
  action: "set_member_label",
  params: "value",
  say: (actor, _targets, value) =>
    value ? `${actor} set their member label to "${value}"` : `${actor} cleared their member label`,
};

/**
 * The disappearing-messages timer, which WhatsApp sends as a protocol message
 * in a group and in a one-to-one chat alike. `value` is the new timer in
 * seconds; none, or zero, turned it off.
 */
const DISAPPEARING: GroupStub = {
  action: "set_disappearing",
  params: "value",
  say: (actor, _targets, value) =>
    value ? `${actor} turned on disappearing messages: ${timerLabel(Number(value))}` : `${actor} turned off disappearing messages`,
};

/** Payloads that are a notice about something a person did, spelled out by groupEventOf. */
const EVENT_PAYLOADS: ReadonlySet<keyof WAMessageContent> = new Set([
  "protocolMessage",
  "pinInChatMessage",
  "keepInChatMessage",
  "messageHistoryBundle",
]);

/** Baileys types the parameters as any; only strings are ever a jid or a value. */
function stubParams(raw: WAMessage): string[] {
  return (Array.isArray(raw.messageStubParameters) ? raw.messageStubParameters : []).filter(
    (param: unknown): param is string => typeof param === "string"
  );
}

function groupEventOf(raw: WAMessage, content: WAMessageContent | undefined): GroupEvent | undefined {
  // A pin in a one-to-one chat has no participant: the other side made it.
  const chat = raw.key.remoteJid ?? "";
  const actor = raw.key.participant || raw.participant || (chat && !chat.endsWith("@g.us") ? chat : undefined);
  const fromMe = Boolean(raw.key.fromMe);
  const protocol = content?.protocolMessage;
  if (protocol?.type === proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE) {
    return { spec: MEMBER_LABEL, actor, fromMe, targets: [], value: protocol.memberLabel?.label || undefined };
  }
  if (protocol?.type === proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING) {
    const seconds = protoNumber(protocol.ephemeralExpiration) ?? 0;
    return { spec: DISAPPEARING, actor, fromMe, targets: [], value: seconds > 0 ? String(seconds) : undefined };
  }
  const pin = content?.pinInChatMessage;
  if (pin) {
    const unpin = pin.type === proto.Message.PinInChatMessage.Type.UNPIN_FOR_ALL;
    const target = pin.key?.id ? (pin.key as WAMessageKey) : undefined;
    return { spec: unpin ? UNPIN : PIN, actor, fromMe, targets: [], value: undefined, target };
  }
  const keep = content?.keepInChatMessage;
  if (keep) {
    const undo = keep.keepType === proto.KeepType.UNDO_KEEP_FOR_ALL;
    const target = keep.key?.id ? (keep.key as WAMessageKey) : undefined;
    return { spec: undo ? UNKEEP : KEEP, actor, fromMe, targets: [], value: undefined, target };
  }
  const bundle = content?.messageHistoryBundle;
  if (bundle) {
    const history = bundle.messageHistoryMetadata;
    const count = protoNumber(history?.messageCount);
    return {
      spec: SHARE_HISTORY,
      actor,
      fromMe,
      targets: (history?.historyReceivers ?? []).filter((jid) => jid.includes("@")),
      value: count ? String(count) : undefined,
    };
  }
  const spec = GROUP_STUBS[raw.messageStubType ?? -1];
  if (!spec) return undefined;
  const params = stubParams(raw);
  return {
    spec,
    actor,
    fromMe,
    targets:
      spec.params === "participants"
        ? params.flatMap((param) => {
            const jid = stubParty(param);
            return jid ? [jid] : [];
          })
        : spec.params === "request"
          ? [stubParty(params[0] ?? "")].filter((jid): jid is string => jid !== undefined)
          : [],
    // A request carries who asked first and the request's state second.
    value: spec.params === "value" ? params[0] || undefined : spec.params === "request" ? params[1] || undefined : undefined,
  };
}

/** Bracketed like every other placeholder, so a notice never reads as words someone typed. */
function eventLine(event: GroupEvent, actor: string, targets: string[], self: boolean): string {
  return `[${event.spec.say(actor, targets.join(", "), event.value, self)}]`;
}

/** A jid on a line with no address book behind it: the number, never a lid's digits. */
function bareLabel(jid: string): string {
  const digits = jid.split("@")[0] ?? "";
  return jid.endsWith("@lid") ? `unknown (lid …${digits.slice(-4)})` : digits || jid;
}

function eventText(event: GroupEvent): string {
  const actor = event.fromMe ? "You" : event.actor ? bareLabel(event.actor) : "Someone";
  const self = event.targets.length === 1 && event.targets[0] === event.actor;
  return eventLine(event, actor, event.targets.map(bareLabel), self);
}

/** Whole days, the way WhatsApp offers the timer; anything else as a duration. */
function timerLabel(seconds: number): string {
  const days = seconds / 86_400;
  return Number.isInteger(days) ? `${days} day${days === 1 ? "" : "s"}` : durationLabel(seconds);
}

/**
 * Notices with nobody to put a name to, spelled out. A stub in neither this
 * table nor GROUP_STUBS still names its type.
 */
const STUB_NOTICES: Partial<Record<number, (params: string[]) => string>> = {
  // Live, the parameter is Baileys' decryption error; from synced history there
  // is none. Either way nothing of the message reached this device, and the
  // phone may not have it either, so the line promises no more than "may".
  [StubType.CIPHERTEXT]: () =>
    "[missing message: it could not be decrypted on this device; it may still be on the phone]",
  // The second parameter is a lid: whose default timer it is, not shown.
  [StubType.DISAPPEARING_MODE]: ([seconds]) => {
    const value = Number(seconds);
    return value > 0
      ? `[disappearing messages on by default: new messages disappear after ${timerLabel(value)}]`
      : "[default disappearing messages changed]";
  },
  [StubType.BLOCK_CONTACT]: ([blocked]) =>
    blocked === "true"
      ? "[you blocked this contact]"
      : blocked === "false"
        ? "[you unblocked this contact]"
        : "[this contact's block status changed]",
  // The parameters carry the usernames; which one is old and which new is not
  // documented, so neither is printed.
  [StubType.CHANGE_USERNAME]: () => "[this contact changed their username]",
  // The linked group's jid, then what reads as its name.
  [StubType.COMMUNITY_LINK_SUB_GROUP]: ([, name]) =>
    name ? `[the group "${name}" was added to the community]` : "[a group was added to the community]",
  [StubType.BIZ_PRIVACY_MODE_INIT_FB]: () => "[this business uses a secure service from Meta to manage this chat]",
  [StubType.BIZ_PRIVACY_MODE_TO_FB]: () => "[this business now uses a secure service from Meta to manage this chat]",
};

/** Nobody picked up. Which word that is depends on which end of the call you were. */
type Unanswered = "no answer";

const CALL_OUTCOMES: Partial<Record<number, CallOutcome | Unanswered>> = {
  [proto.Message.CallLogMessage.CallOutcome.CONNECTED]: "answered",
  [proto.Message.CallLogMessage.CallOutcome.ACCEPTED_ELSEWHERE]: "answered",
  [proto.Message.CallLogMessage.CallOutcome.ONGOING]: "answered",
  [proto.Message.CallLogMessage.CallOutcome.REJECTED]: "rejected",
  [proto.Message.CallLogMessage.CallOutcome.MISSED]: "no answer",
  [proto.Message.CallLogMessage.CallOutcome.FAILED]: "no answer",
  [proto.Message.CallLogMessage.CallOutcome.SILENCED_BY_DND]: "no answer",
  [proto.Message.CallLogMessage.CallOutcome.SILENCED_UNKNOWN_CALLER]: "no answer",
};

const CALL_STUB_KINDS: Partial<Record<number, CallKind>> = {
  [proto.WebMessageInfo.StubType.CALL_MISSED_VOICE]: "voice",
  [proto.WebMessageInfo.StubType.CALL_MISSED_VIDEO]: "video",
  [proto.WebMessageInfo.StubType.CALL_MISSED_GROUP_VOICE]: "voice",
  [proto.WebMessageInfo.StubType.CALL_MISSED_GROUP_VIDEO]: "video",
};

function settle(outcome: CallOutcome | Unanswered, direction: CallDirection): CallOutcome {
  if (outcome !== "no answer") return outcome;
  return direction === "outgoing" ? "unanswered" : "missed";
}

/**
 * Calls never reach the RULES table: `getContentType` looks for a key
 * containing "Message" and the proto field is spelled `callLogMesssage`, so it
 * reports undefined and a call arriving next to messageContextInfo would render
 * as "[system message]". Hence this runs before the table, not inside it.
 */
function callFrom(raw: WAMessage, content: WAMessageContent | undefined): CallInfo | undefined {
  const direction: CallDirection = raw.key?.fromMe ? "outgoing" : "incoming";
  const logged = content?.callLogMesssage;
  if (logged) {
    const outcome = settle(CALL_OUTCOMES[logged.callOutcome ?? -1] ?? "no answer", direction);
    const seconds = protoNumber(logged.durationSecs);
    const participants = (logged.participants ?? []).flatMap((one) => (one.jid ? [one.jid] : []));
    return {
      kind: logged.isVideo ? "video" : "voice",
      direction,
      outcome,
      ...(outcome === "answered" && seconds !== undefined && seconds > 0 ? { duration_seconds: seconds } : {}),
      ...(participants.length > 0 ? { participants } : {}),
    };
  }
  const stub = CALL_STUB_KINDS[raw.messageStubType ?? -1];
  if (stub) return { kind: stub, direction, outcome: settle("no answer", direction) };
  if (content?.call != null) return { kind: "voice", direction, outcome: settle("no answer", direction) };
  return undefined;
}

/** A duration WhatsApp attached to a recording. Zero means it said nothing. */
function audioSeconds(content: WAMessageContent): number | undefined {
  const seconds = protoNumber(content.audioMessage?.seconds);
  return seconds === undefined || seconds <= 0 ? undefined : seconds;
}

/** 0:06, 3:05, 1:02:03 — a recording reads as a clock, unlike a call's "6 min". */
export function clockLabel(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const pad = (value: number): string => String(value).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const rest = pad(total % 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${rest}` : `${minutes}:${rest}`;
}

function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest} min`;
}

/** An outcome you caused reads as a suffix; one that happened to you is an adjective. */
export function callText(info: CallInfo): string {
  const duration = info.duration_seconds === undefined ? "" : ` · ${durationLabel(info.duration_seconds)}`;
  if (info.direction === "outgoing") {
    return `[outgoing ${info.kind} call${info.outcome === "answered" ? duration : ` · ${info.outcome}`}]`;
  }
  const adjective = info.outcome === "answered" ? "" : `${info.outcome} `;
  return `[${adjective}${info.kind} call${duration}]`;
}

function resolve<T>(value: T | ((m: WAMessageContent) => T), content: WAMessageContent): T {
  return typeof value === "function" ? (value as (m: WAMessageContent) => T)(content) : value;
}

/**
 * Everything the helpers below read out of one message, parsed once. A message
 * goes through several of them on every path — ingest checks isControlMessage
 * and reactionOf, a render reads type, text, media and context — and each one
 * used to unwrap the envelope and classify the payload on its own. The WeakMap
 * keys on the message object, so a later pass over the same store row is free.
 * `raw.message` is replaced (not mutated) when an edit lands, so the entry
 * carries it and recomputes when it no longer matches.
 */
interface Analysis {
  /** unwrapEnvelopes(raw.message). */
  content: WAMessageContent | undefined;
  /** getContentType(content). */
  key: keyof WAMessageContent | undefined;
  /** The RULES entry the content matched, UNKNOWN when none did. */
  rule: Rule;
  /** The view-once body when the message is one, else the content itself. */
  inner: WAMessageContent | undefined;
  stub: MessageType | undefined;
  /** The group notice a stub spells out, when wazap models that stub. */
  event: GroupEvent | undefined;
  /** The stub type's name, for a notice that is not spelled out. */
  stubName: string | undefined;
  /** The line for a stub STUB_NOTICES spells out. */
  notice: string | undefined;
  call: CallInfo | undefined;
  context: proto.IContextInfo | undefined;
  media: { mime: string; size?: number; filename?: string } | undefined;
  type: MessageType;
  /** Filled on the first messageText/viewText; not part of the parse. */
  text?: string;
}

const ANALYSES = new WeakMap<
  WAMessage,
  { message: WAMessage["message"]; stubType: WAMessage["messageStubType"]; a: Analysis }
>();

function analyze(raw: WAMessage): Analysis {
  const hit = ANALYSES.get(raw);
  if (hit && hit.message === raw.message && hit.stubType === raw.messageStubType) return hit.a;

  const content = unwrapEnvelopes(raw.message);
  // getContentType looks for a key containing "Message", and the history bundle
  // is spelled with a lowercase one, so it would never reach the table.
  const key = content
    ? (getContentType(content) ?? (content.messageHistoryBundle ? "messageHistoryBundle" : undefined))
    : undefined;
  const { rule } = ruleFor(content, key);
  const stub = stubKind(raw);
  const call = callFrom(raw, content);
  const node = key === undefined ? undefined : (content?.[key] as { contextInfo?: proto.IContextInfo | null } | null);
  const inner = content ? (viewOnceInner(content) ?? content) : undefined;
  let media: Analysis["media"];
  if (inner) {
    for (const mediaKey of MEDIA_KEYS) {
      const m = inner[mediaKey] as MediaNode | null | undefined;
      if (!m) continue;
      media = {
        mime: m.mimetype ?? "application/octet-stream",
        size: protoNumber(m.fileLength),
        filename: m.fileName ?? undefined,
      };
      break;
    }
  }

  const a: Analysis = {
    content,
    key,
    rule,
    inner,
    stub,
    event:
      (rule === UNKNOWN && stub === "system") || (key !== undefined && EVENT_PAYLOADS.has(key))
        ? groupEventOf(raw, content)
        : undefined,
    stubName: stub === "system" ? stubTypeName(raw) : undefined,
    notice: stub === "system" && rule === UNKNOWN ? STUB_NOTICES[raw.messageStubType ?? -1]?.(stubParams(raw)) : undefined,
    call,
    context: node?.contextInfo ?? undefined,
    media,
    type: "unknown",
  };
  a.type =
    call !== undefined
      ? "call"
      : stub === "deleted"
        ? "deleted"
        : rule === UNKNOWN && stub !== undefined
          ? stub
          : resolve(rule.type, content ?? {});
  ANALYSES.set(raw, { message: raw.message, stubType: raw.messageStubType, a });
  return a;
}

/** The same walk isControlMessage always did, over the parsed analysis. */
function controlFrom(a: Analysis): boolean {
  if (a.stub !== undefined) return false;
  const content = a.content;
  if (!content) return true;
  if (a.key === "protocolMessage") return !REPORTABLE_PROTOCOL_TYPES.has(content.protocolMessage?.type ?? -1);
  if (a.key !== undefined) return false;
  // getContentType ignores the control keys, so reaching here means the payload
  // is either nothing at all or nothing but control keys.
  const present = Object.keys(content).filter((name) => content[name as keyof WAMessageContent] != null);
  return present.length === 0 || present.every((name) => CONTROL_KEYS.includes(name as keyof WAMessageContent));
}

/** The same walk messageText always did, over the parsed analysis. */
function textFrom(a: Analysis): string {
  // The placeholder only says a group call was offered, so naming an outcome
  // ("missed") would claim something the payload never carried.
  if (a.call) {
    return a.content?.call != null && a.content.callLogMesssage == null ? "[group call]" : callText(a.call);
  }
  if (a.event) return eventText(a.event);
  const node = a.content ?? {};
  if (a.rule === UNKNOWN) {
    if (a.stub === "deleted") return DELETED_TEXT;
    if (a.stub === "system") return a.notice ?? (a.stubName ? `[system message · ${a.stubName}]` : SYSTEM_TEXT);
  }

  const text = a.rule.text?.(node)?.trim();
  if (text) return text;
  const tag = resolve(a.rule.tag, node);
  const caption = a.rule.caption?.(node)?.trim();
  if (caption) return `${tag} ${caption}`;
  const detail = a.rule.detail?.(node)?.trim();
  return detail ? `${tag} ${detail}` : tag;
}

/** A transcript belongs to a recording and to nothing else. */
function spokenFrom(a: Analysis, transcript: TranscriptRecord | undefined): string | undefined {
  if (!transcript?.text) return undefined;
  return a.type === "voice" || a.type === "audio" ? transcript.text : undefined;
}

/**
 * True for the machinery WhatsApp runs between devices: history-sync notices,
 * app-state and peer-data responses, sender-key distribution, bare context
 * info. They carry nothing a person did, so they are dropped rather than shown.
 */
export function isControlMessage(raw: WAMessage): boolean {
  return controlFrom(analyze(raw));
}

/**
 * A message whose whole content is a stub type: WhatsApp's own notices about
 * device linking, group membership and encryption. Baileys builds these with no
 * `message` field at all, so they have to be recognised before the usual
 * "no content, nothing to store" guard throws them away.
 */
export function isStubEvent(raw: WAMessage): boolean {
  return analyze(raw).stub !== undefined;
}

/**
 * Something a person sent or received, as opposed to a control notice, a stub
 * or a system line. The webhook posts these in both directions.
 */
export function isUserMessage(raw: WAMessage): boolean {
  const a = analyze(raw);
  if (controlFrom(a) || a.stub !== undefined) return false;
  return a.type !== "system";
}

export function messageType(raw: WAMessage): MessageType {
  return analyze(raw).type;
}

/** Never empty: media and system messages get a placeholder like "[sticker]". */
export function messageText(raw: WAMessage): string {
  const a = analyze(raw);
  return (a.text ??= textFrom(a));
}

export function callInfo(raw: WAMessage): CallInfo | undefined {
  return analyze(raw).call;
}

/**
 * Baileys' own stand-in for a group call offer. It says a call happened and
 * nothing else, so anything that names an outcome outranks it.
 */
export function isCallPlaceholder(raw: WAMessage): boolean {
  const content = analyze(raw).content;
  return content?.call != null && content.callLogMesssage == null;
}

/** How long a voice note or audio message runs, when WhatsApp said so. */
export function voiceSeconds(raw: WAMessage): number | undefined {
  const content = analyze(raw).content;
  return content === undefined ? undefined : audioSeconds(content);
}

/**
 * What the recall index stores for a message: the rendered view text when the
 * message carries words a person chose, and null when it is only a placeholder
 * — "[sticker]", "[deleted]", a call log, a reaction. A bare tag is nothing to
 * search by; a voice note becomes indexable once its transcript exists.
 */
export function searchableText(raw: WAMessage, transcript?: TranscriptRecord): string | null {
  const a = analyze(raw);
  const spoken = spokenFrom(a, transcript);
  const node = a.content ?? {};
  const type = resolve(a.rule.type, node);
  if (type === "reaction" || type === "deleted" || type === "system") return null;
  const own =
    a.rule.text?.(node)?.trim() || a.rule.caption?.(node)?.trim() || a.rule.detail?.(node)?.trim() || "";
  // Under five letters or digits there is no meaning to embed — a "🥰🥰", a
  // "Da" or a "..." only adds noise that outranks real hits on short queries.
  if ((own.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 5 && spoken === undefined) return null;
  const text = (a.text ??= textFrom(a));
  return spoken === undefined ? text : `${text} "${spoken}"`;
}

/** The message a REVOKE protocol message takes back, when there is one. */
export function revokedTargetKey(raw: WAMessage): WAMessageKey | undefined {
  if (raw.messageStubType === proto.WebMessageInfo.StubType.REVOKE && raw.key?.id) return raw.key;
  const proto_ = analyze(raw).content?.protocolMessage;
  if (proto_?.type !== proto.Message.ProtocolMessage.Type.REVOKE) return undefined;
  const key = proto_.key;
  return key?.id ? (key as WAMessageKey) : undefined;
}

/**
 * What a reader sees. searchMessages matches on this rather than on the bare
 * placeholder, so a transcript is findable by the words it puts on the screen.
 */
export function viewText(raw: WAMessage, transcript?: TranscriptRecord): string {
  const a = analyze(raw);
  const text = (a.text ??= textFrom(a));
  const spoken = spokenFrom(a, transcript);
  return spoken === undefined ? text : `${text} "${spoken}"`;
}

/** The reaction a message is, if it is one: what was reacted with, and to which message key. An empty text withdraws. */
export function reactionOf(raw: WAMessage): { text: string; targetKey: WAMessageKey } | undefined {
  const reaction = analyze(raw).content?.reactionMessage;
  if (!reaction?.key?.remoteJid) return undefined;
  return { text: reaction.text ?? "", targetKey: reaction.key as WAMessageKey };
}

/** A poll's question and its options, in the order the poll lists them. A results snapshot is not a poll anyone votes on. */
export function pollOf(raw: WAMessage): { question: string; options: string[] } | undefined {
  const m = analyze(raw).content;
  const poll =
    m?.pollCreationMessage ??
    m?.pollCreationMessageV2 ??
    m?.pollCreationMessageV3 ??
    m?.pollCreationMessageV5 ??
    m?.pollCreationMessageV4?.message?.pollCreationMessage;
  if (!poll) return undefined;
  return { question: poll.name ?? "", options: (poll.options ?? []).map((option) => option.optionName ?? "") };
}

/** An event anyone can answer going, maybe or not going. */
export function isEvent(raw: WAMessage): boolean {
  return analyze(raw).content?.eventMessage != null;
}

/** A vote on a poll or a response to an event, still encrypted: what it points at and the bytes to open. */
export interface EncryptedVote {
  kind: "poll" | "event";
  /** The poll or event, keyed the way the voter's device keyed it. */
  targetKey: WAMessageKey;
  payload: Uint8Array;
  iv: Uint8Array;
  /** When it was cast, epoch ms; a later one replaces an earlier one. */
  at: number;
}

export function voteOf(raw: WAMessage): EncryptedVote | undefined {
  const content = analyze(raw).content;
  const poll = content?.pollUpdateMessage;
  if (poll?.pollCreationMessageKey?.id && poll.vote?.encPayload && poll.vote.encIv) {
    return {
      kind: "poll",
      targetKey: poll.pollCreationMessageKey as WAMessageKey,
      payload: poll.vote.encPayload,
      iv: poll.vote.encIv,
      at: protoNumber(poll.senderTimestampMs) || messageTimestampMs(raw),
    };
  }
  const event = content?.encEventResponseMessage;
  if (event?.eventCreationMessageKey?.id && event.encPayload && event.encIv) {
    return {
      kind: "event",
      targetKey: event.eventCreationMessageKey as WAMessageKey,
      payload: event.encPayload,
      iv: event.encIv,
      at: messageTimestampMs(raw),
    };
  }
  return undefined;
}

/** The secret a poll or event was created with, which every vote on it is encrypted under. */
export function messageSecretOf(raw: WAMessage): Uint8Array | undefined {
  const secret =
    raw.message?.messageContextInfo?.messageSecret ?? analyze(raw).content?.messageContextInfo?.messageSecret;
  return secret && secret.length > 0 ? secret : undefined;
}

export function mediaInfo(raw: WAMessage): { mime: string; size?: number; filename?: string } | undefined {
  return analyze(raw).media;
}

/**
 * The SHA-256 the sender stated for the decrypted file, when the envelope
 * carries one: what a kept copy is checked against before it stands in for
 * WhatsApp's.
 */
export function mediaSha256(raw: WAMessage): Buffer | undefined {
  const inner = analyze(raw).inner;
  if (!inner) return undefined;
  for (const mediaKey of MEDIA_KEYS) {
    const node = inner[mediaKey] as MediaNode | null | undefined;
    if (!node) continue;
    const hash = node.fileSha256;
    return hash && hash.length === 32 ? Buffer.from(hash) : undefined;
  }
  return undefined;
}

/**
 * The preview WhatsApp ships inside a photo, video or document message: a JPEG
 * of a few KB, there before any download. Enough to tell a receipt from a baby.
 */
export function thumbnailOf(raw: WAMessage): { mime: string; base64: string } | undefined {
  const content = analyze(raw).inner;
  if (!content) return undefined;
  for (const key of THUMBNAIL_KEYS) {
    const node = content[key] as MediaNode | null | undefined;
    const bytes = node?.jpegThumbnail;
    if (bytes && bytes.length > 0) return { mime: "image/jpeg", base64: Buffer.from(bytes).toString("base64") };
  }
  return undefined;
}

/** Who a message @-mentions, as the jids WhatsApp put on it (lid or phone). */
export function mentionedJids(raw: WAMessage): string[] {
  return (contextInfo(raw)?.mentionedJid ?? []).filter(
    (jid): jid is string => typeof jid === "string" && jid.length > 0
  );
}

/** The author of the message this one quotes, when it is a reply. */
export function quotedSenderJid(raw: WAMessage): string | undefined {
  const context = contextInfo(raw);
  if (!context?.quotedMessage) return undefined;
  return context.participant ?? undefined;
}

function contextInfo(raw: WAMessage): proto.IContextInfo | undefined {
  return analyze(raw).context;
}

/** "just now", "5m ago", "2h ago", "3d ago" — largest whole unit. */
export function formatAge(fromMs: number, nowMs: number = Date.now()): string {
  const elapsed = Math.max(0, nowMs - fromMs);
  const days = Math.floor(elapsed / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours >= 1) return `${hours}h ago`;
  const minutes = Math.floor(elapsed / 60_000);
  return minutes >= 1 ? `${minutes}m ago` : "just now";
}

/** Local-time ISO 8601 with a numeric offset, e.g. 2026-08-22T21:30:00+03:00. */
export function isoWithOffset(ms: number): string {
  const at = new Date(ms);
  const pad = (value: number, width = 2): string => String(Math.abs(value)).padStart(width, "0");
  const offsetMinutes = -at.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const date = `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  const offset = `${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${date}T${time}${sign}${offset}`;
}

export interface MessageViewContext {
  /** Canonical form of a jid: `<digits>@s.whatsapp.net` or `<id>@g.us`. */
  canonical: (jid: string) => string;
  /** Display name for a canonical jid; never empty. */
  nameFor: (jid: string) => string;
  /** The user's note on a canonical jid, if any. */
  noteFor?: (jid: string) => string | undefined;
  /** Our own canonical jid. */
  ownId: string;
  /** Canonical chat this message belongs to. */
  chatId: string;
  edited: boolean;
  reactions: Array<{ emoji: string; sender: string }>;
  /** On a poll, the option names each voter chose; on an event, "going", "maybe" or "not_going". */
  votes?: Array<{ voter: string; choice: string[] }>;
  /** On the account's own messages, how far it got; group members by jid. */
  receipt?: Receipt;
  transcript?: TranscriptRecord;
  now?: number;
}

function senderJid(raw: WAMessage, ctx: MessageViewContext): string {
  if (raw.key.fromMe) return ctx.ownId;
  // In a one-to-one chat the other side wrote it, whatever id the key carries.
  if (ctx.chatId.endsWith("@s.whatsapp.net")) return ctx.chatId;
  // Baileys sets `participant` to "" on a direct message that arrived under a
  // lid, and "" is not "absent": `??` would keep it and hand the message to us.
  const from = raw.key.participant || raw.participant || raw.key.remoteJid || "";
  return from ? ctx.canonical(from) : ctx.ownId;
}

export function phoneOf(jid: string): string | undefined {
  const [user = "", domain] = jid.split("@");
  return domain === "s.whatsapp.net" && /^\d+$/.test(user) ? user : undefined;
}

export function buildMessageView(raw: WAMessage, ctx: MessageViewContext): MessageView {
  const a = analyze(raw);
  const timestamp = messageTimestampMs(raw);
  const sender = senderJid(raw, ctx);
  const context = a.context;
  const quoted = context?.quotedMessage ? quotedView(context, ctx) : undefined;
  const event = a.event ? eventView(a.event, ctx) : undefined;
  const text = event?.text ?? (a.text ??= textFrom(a));
  const spoken = spokenFrom(a, ctx.transcript);

  const view: MessageView = {
    message_id: messageIdFor(raw.key, ctx.chatId),
    chat_id: ctx.chatId,
    from_me: Boolean(raw.key.fromMe),
    sender: {
      id: sender,
      name: ctx.nameFor(sender),
      ...(phoneOf(sender) ? { phone: phoneOf(sender) } : {}),
      ...(ctx.noteFor?.(sender) ? { note: ctx.noteFor(sender) } : {}),
    },
    type: a.type,
    text: spoken === undefined ? text : `${text} "${spoken}"`,
    timestamp: isoWithOffset(timestamp),
    age: formatAge(timestamp, ctx.now),
    has_media: a.media !== undefined,
    forwarded: Boolean(context?.isForwarded) || (protoNumber(context?.forwardingScore) ?? 0) > 0,
    edited: ctx.edited,
  };
  if (a.media) view.media = a.media;
  if (quoted) view.quoted = quoted;
  if (spoken !== undefined) view.transcript = spoken;
  if (a.call) {
    view.call = a.call.participants
      ? { ...a.call, participants: a.call.participants.map((jid) => ctx.canonical(jid)) }
      : a.call;
  }
  if (ctx.reactions.length > 0) {
    view.reactions = ctx.reactions.map((r) => ({ ...r, name: ctx.nameFor(ctx.canonical(r.sender)) }));
  }
  const mentions = mentionsView(context, ctx);
  if (mentions.length > 0) view.mentions = mentions;
  if (event) view.system = event.system;
  const poll = pollOf(raw);
  if (poll) view.poll = pollView(poll, ctx);
  if (a.content?.eventMessage != null) view.event_responses = responsesView(ctx);
  const delivery = raw.key.fromMe && ctx.receipt ? deliveryView(ctx.receipt, ctx) : undefined;
  if (delivery) view.delivery = delivery;
  return view;
}

const DELIVERY_STATUS: Record<number, DeliveryStatus> = {
  [proto.WebMessageInfo.Status.ERROR]: "error",
  [proto.WebMessageInfo.Status.PENDING]: "pending",
  [proto.WebMessageInfo.Status.SERVER_ACK]: "sent",
  [proto.WebMessageInfo.Status.DELIVERY_ACK]: "delivered",
  [proto.WebMessageInfo.Status.READ]: "read",
  [proto.WebMessageInfo.Status.PLAYED]: "played",
};

/**
 * The status in words, and in a group who has it: a member who read it is in
 * `read_by` only, the way the phone's message info lists them. Played counts
 * as read. A one-to-one message synced from the phone carries receipts too,
 * but the only person they can name is the chat itself, so they stay out.
 */
function deliveryView(receipt: Receipt, ctx: MessageViewContext): Delivery | undefined {
  const status = receipt.status === undefined ? undefined : DELIVERY_STATUS[receipt.status];
  if (status === undefined) return undefined;
  const delivery: Delivery = { status };
  if (!ctx.chatId.endsWith("@g.us")) return delivery;
  const read: Array<[string, number]> = [];
  const delivered: Array<[string, number]> = [];
  for (const [jid, moments] of Object.entries(receipt.users ?? {})) {
    const readAt = moments.read ?? moments.played;
    if (readAt !== undefined) read.push([jid, readAt]);
    else if (moments.delivered !== undefined) delivered.push([jid, moments.delivered]);
  }
  const receivers = (list: Array<[string, number]>) =>
    list
      .sort((x, y) => x[1] - y[1])
      .map(([jid, at]) => {
        const id = ctx.canonical(jid);
        return { id, name: ctx.nameFor(id), at: isoWithOffset(at) };
      });
  if (read.length > 0) delivery.read_by = receivers(read);
  if (delivered.length > 0) delivery.delivered_to = receivers(delivered);
  return delivery;
}

/** Each person the message @-mentions, once and in the order named: a lid and its number are the same person. */
function mentionsView(context: proto.IContextInfo | undefined, ctx: MessageViewContext): Voter[] {
  const ids = new Set<string>();
  for (const jid of context?.mentionedJid ?? []) {
    if (typeof jid === "string" && jid.length > 0) ids.add(ctx.canonical(jid));
  }
  return [...ids].map((id) => ({ id, name: ctx.nameFor(id) }));
}

function voterOf(jid: string, ctx: MessageViewContext): Voter {
  const id = ctx.canonical(jid);
  return { id, name: ctx.nameFor(id) };
}

/** Every option, the ones nobody chose included, so the poll reads whole. */
function pollView(poll: { question: string; options: string[] }, ctx: MessageViewContext): PollResults {
  const votes = (ctx.votes ?? []).filter((vote) => vote.choice.length > 0);
  return {
    question: poll.question,
    options: poll.options.map((name) => {
      const voters = votes.filter((vote) => vote.choice.includes(name)).map((vote) => voterOf(vote.voter, ctx));
      return { name, votes: voters.length, voters };
    }),
    voters: votes.length,
  };
}

function responsesView(ctx: MessageViewContext): EventResponses {
  const who = (answer: string): Voter[] =>
    (ctx.votes ?? []).filter((vote) => vote.choice.includes(answer)).map((vote) => voterOf(vote.voter, ctx));
  return { going: who("going"), maybe: who("maybe"), not_going: who("not_going") };
}

function eventParty(jid: string, ctx: MessageViewContext): EventParty {
  const id = ctx.canonical(jid);
  const phone = phoneOf(id);
  return { id, name: ctx.nameFor(id), ...(phone ? { phone } : {}) };
}

/** A target by name, with the number beside it unless the name already is the number. */
function partyLabel(party: EventParty): string {
  return party.phone && party.phone !== party.name ? `${party.name} (${party.phone})` : party.name;
}

/** The notice with names looked up: the structured event, and the line that says it. */
function eventView(event: GroupEvent, ctx: MessageViewContext): { system: SystemEvent; text: string } {
  const actor = event.fromMe ? eventParty(ctx.ownId, ctx) : event.actor ? eventParty(event.actor, ctx) : undefined;
  const targets = event.targets.map((jid) => eventParty(jid, ctx));
  const self = targets.length === 1 && targets[0]?.id === actor?.id;
  // Built the way a reaction finds its target, so it matches read_messages' id.
  const value = event.target ? messageIdFor(event.target, ctx.chatId) : event.value;
  return {
    system: {
      action: event.spec.action,
      ...(actor ? { actor } : {}),
      targets,
      ...(value === undefined ? {} : { value }),
    },
    text: eventLine(event, actor?.name ?? "Someone", targets.map(partyLabel), self),
  };
}

/**
 * The message_id a reply's quote points at, spelled the way buildMessageView
 * spells it for the same context; undefined when the message quotes nothing.
 */
export function quotedMessageId(
  raw: WAMessage,
  ctx: Pick<MessageViewContext, "canonical" | "ownId" | "chatId">
): string | undefined {
  const context = analyze(raw).context;
  if (!context?.quotedMessage || !context.stanzaId) return undefined;
  const participant = context.participant ? ctx.canonical(context.participant) : ctx.ownId;
  return messageIdFor({ id: context.stanzaId, fromMe: participant === ctx.ownId, remoteJid: ctx.chatId }, ctx.chatId);
}

function quotedView(
  context: proto.IContextInfo,
  ctx: MessageViewContext
): { message_id: string; text: string; sender: string } | undefined {
  if (!context.quotedMessage || !context.stanzaId) return undefined;
  const participant = context.participant ? ctx.canonical(context.participant) : ctx.ownId;
  const key: WAMessageKey = {
    id: context.stanzaId,
    fromMe: participant === ctx.ownId,
    remoteJid: ctx.chatId,
  };
  const inner: WAMessage = { key, message: context.quotedMessage };
  return {
    message_id: messageIdFor(key, ctx.chatId),
    text: messageText(inner),
    sender: participant,
  };
}
