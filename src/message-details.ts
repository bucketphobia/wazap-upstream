import type { WAMessageContent } from "baileys";
import type { MessageButton, MessageView, SharedContact } from "./wa-types.js";

type Details = Pick<MessageView, "location" | "contacts" | "buttons">;

function number(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nativeButton(name: string, json: string | null | undefined): MessageButton {
  let params: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(json ?? "{}");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) params = parsed as Record<string, unknown>;
  } catch {
    return { kind: "unknown", name, ...(json == null ? {} : { parameters_json: json }) };
  }
  const label = typeof params.display_text === "string" ? { label: params.display_text } : {};
  if (name === "cta_url" && typeof params.url === "string") return { ...label, kind: "url", url: params.url };
  if (name === "cta_call" && typeof params.phone_number === "string") return { ...label, kind: "call", phone_number: params.phone_number };
  if (name === "cta_copy" && typeof params.copy_code === "string") return { ...label, kind: "copy", code: params.copy_code };
  if (name === "quick_reply" && typeof params.id === "string") return { ...label, kind: "reply", id: params.id };
  return { ...label, kind: "unknown", name, ...(json == null ? {} : { parameters_json: json }) };
}

function nativeButtons(message: WAMessageContent["interactiveMessage"], buttons: MessageButton[], card?: MessageButton["card"]): void {
  for (const button of message?.nativeFlowMessage?.buttons ?? []) {
    buttons.push({ ...nativeButton(button.name ?? "", button.buttonParamsJson), ...(card === undefined ? {} : { card }) });
  }
  for (const [index, item] of (message?.carouselMessage?.cards ?? []).entries()) {
    nativeButtons(item, buttons, {
      index,
      ...(item.header?.title == null ? {} : { title: item.header.title }),
      ...(item.header?.subtitle == null ? {} : { subtitle: item.header.subtitle }),
      ...(item.body?.text == null ? {} : { body: item.body.text }),
    });
  }
}

/** Full-message payload details; nothing here follows or executes sender-provided actions. */
export function detailsOf(content: WAMessageContent | undefined): Details {
  if (!content) return {};
  const details: Details = {};
  const location = content.locationMessage ?? content.liveLocationMessage;
  if (location) {
    const fixed = content.locationMessage;
    details.location = {
      latitude: number(location.degreesLatitude),
      longitude: number(location.degreesLongitude),
      live: Boolean(content.liveLocationMessage || fixed?.isLive),
      ...(fixed?.name == null ? {} : { name: fixed.name }),
      ...(fixed?.address == null ? {} : { address: fixed.address }),
      ...(fixed?.url == null ? {} : { url: fixed.url }),
      ...(fixed?.comment == null ? {} : { comment: fixed.comment }),
      ...(content.liveLocationMessage?.caption == null ? {} : { caption: content.liveLocationMessage.caption }),
      accuracy_meters: number(location.accuracyInMeters),
      speed_mps: number(location.speedInMps),
      heading_degrees: number(location.degreesClockwiseFromMagneticNorth),
    };
  }
  const cards = content.contactsArrayMessage?.contacts ?? (content.contactMessage ? [content.contactMessage] : undefined);
  if (cards) details.contacts = cards.map((card): SharedContact => ({
    ...(card.displayName == null ? {} : { display_name: card.displayName }),
    ...(card.vcard == null ? {} : { vcard: card.vcard }),
  }));
  const template = content.templateMessage;
  const hydrated = template?.hydratedFourRowTemplate ?? template?.hydratedTemplate;
  const interactive = content.interactiveMessage ?? template?.interactiveMessageTemplate;
  const buttons: MessageButton[] = [];
  nativeButtons(interactive, buttons);
  for (const button of hydrated?.hydratedButtons ?? []) {
    if (button.urlButton) buttons.push({ kind: "url", label: button.urlButton.displayText ?? undefined, url: button.urlButton.url ?? "" });
    else if (button.callButton) buttons.push({ kind: "call", label: button.callButton.displayText ?? undefined, phone_number: button.callButton.phoneNumber ?? "" });
    else if (button.quickReplyButton) buttons.push({ kind: "reply", label: button.quickReplyButton.displayText ?? undefined, id: button.quickReplyButton.id ?? "" });
  }
  for (const button of content.buttonsMessage?.buttons ?? []) {
    if (button.nativeFlowInfo) buttons.push(nativeButton(button.nativeFlowInfo.name ?? "", button.nativeFlowInfo.paramsJson));
    else buttons.push({ kind: "reply", label: button.buttonText?.displayText ?? undefined, id: button.buttonId ?? "" });
  }
  if (buttons.length > 0) details.buttons = buttons;
  return details;
}
