/** Bounded, credential-owned previews for chat mutations. Restarting forgets approvals. */
import { createHash, randomUUID } from "node:crypto";
import { describeTarget, DRAFT_TTL_MS } from "./drafts.js";
import { WazapError } from "./errors.js";
import type { ToolArgs, ToolCtx } from "./tool-runtime.js";
import type { ChatAction, ChatActionOptions, ChatActionResult, OutgoingTarget, WhatsAppApi } from "./wa-types.js";

interface ActionDraft {
  id: string;
  owner: string;
  accountId: string;
  service: WhatsAppApi;
  linkedOwner: string;
  target: OutgoingTarget;
  action: ChatAction;
  options: ChatActionOptions;
  expires: number;
  messageHash?: string;
  work?: Promise<ChatActionResult>;
}

const drafts = new Map<string, ActionDraft>();
const CAP = 500;
const OWNER_CAP = 20;
const FIX = "Call manage_chat without confirmation_id, show its preview, then ask for a new yes before confirming.";

function missing(): WazapError {
  return new WazapError("CHAT_ACTION_NOT_FOUND", "No chat-action preview available to this identity and account.", FIX);
}

export function staleChatAction(): WazapError {
  return new WazapError("CHAT_ACTION_STALE", "The conversation, account or target changed since this preview; nothing was changed.", FIX);
}

export function requireChatAction(id: string, owner: string, accountId?: string): ActionDraft {
  const draft = drafts.get(id);
  if (!draft || draft.owner !== owner || (accountId !== undefined && draft.accountId !== accountId)) throw missing();
  if (draft.expires <= Date.now() && draft.work === undefined) {
    drafts.delete(id);
    throw new WazapError("CHAT_ACTION_EXPIRED", "The chat-action preview expired after 15 minutes.", FIX);
  }
  return draft;
}

function checkSource(draft: ActionDraft, ctx: ToolCtx): void {
  if (ctx.accountId !== draft.accountId || ctx.wa !== draft.service || ctx.hub.binding(draft.accountId)?.wa !== draft.service ||
      ctx.wa.getStatus().account?.id !== draft.linkedOwner) throw staleChatAction();
  const policy = ctx.hub.recordOnDisk(draft.accountId);
  if (!ctx.allowWrite || !policy?.enabled || policy.writes === false || ctx.hub.record(draft.accountId)?.writes === false || ctx.wa.getStatus().read_only) {
    throw new WazapError("READ_ONLY", "This account no longer allows this chat action.", "Restore write access deliberately, then preview the action again.");
  }
}

function optionsOf(args: ToolArgs): ChatActionOptions {
  return {
    ...(args.mute_hours === undefined ? {} : { muteHours: args.mute_hours as number }),
    ...(args.message_id === undefined ? {} : { messageId: args.message_id as string }),
    ...(args.pin_hours === undefined ? {} : { pinHours: args.pin_hours as number }),
  };
}

const textHash = (text: string) => createHash("sha256").update(text).digest("hex");

function checkOptions(action: ChatAction, options: ChatActionOptions): void {
  const messageAction = ["pin_message", "unpin_message", "star_message", "unstar_message"].includes(action);
  if ((options.muteHours !== undefined && action !== "mute") ||
      (options.pinHours !== undefined && action !== "pin_message") ||
      (options.messageId !== undefined && !messageAction) || (messageAction && !options.messageId)) {
    throw new WazapError("INVALID_ID", "The message or duration arguments do not match this chat action.", "Use message_id for message actions, mute_hours for mute and pin_hours for pin_message.");
  }
}

/** Preview construction does contact/message reads, never beginWrite or a chat mutation. */
export async function previewChatAction(args: ToolArgs, ctx: ToolCtx): Promise<Record<string, unknown>> {
  const action = args.action as ChatAction;
  const options = optionsOf(args);
  checkOptions(action, options);
  const linkedOwner = ctx.wa.getStatus().account?.id;
  if (!linkedOwner) throw new WazapError("NOT_CONNECTED", "No linked account can own this preview.", "Call get_status.");
  const contact = await ctx.wa.getContact(args.chat_id as string);
  const target = { chat_id: contact.contact_id, name: contact.name, ...(contact.number ? { number: contact.number } : {}) };
  if ((action === "block" || action === "unblock") && !target.chat_id.endsWith("@s.whatsapp.net") && !target.chat_id.endsWith("@lid")) {
    throw new WazapError("INVALID_ID", "Blocking works only on a person's chat.", "Pass the chat_id of a person.");
  }
  let messageText: string | undefined;
  let messageHash: string | undefined;
  if (options.messageId) {
    const message = await ctx.wa.getMessage(options.messageId);
    if (message.chat_id !== target.chat_id) throw new WazapError("MESSAGE_NOT_FOUND", "The message is not in the previewed chat.");
    messageText = message.text.slice(0, 300);
    messageHash = textHash(message.text);
  }
  const draft: ActionDraft = { id: `ca_${randomUUID()}`, owner: ctx.draftOwner, accountId: ctx.accountId,
    service: ctx.wa, linkedOwner, target, action, options, expires: Date.now() + DRAFT_TTL_MS, messageHash };
  checkSource(draft, ctx);
  for (const [id, row] of drafts) if (row.expires <= Date.now()) drafts.delete(id);
  const owned = [...drafts.values()].filter((row) => row.owner === draft.owner);
  if (owned.length >= OWNER_CAP) drafts.delete(owned[0]!.id);
  if (drafts.size >= CAP) drafts.delete(drafts.keys().next().value!);
  drafts.set(draft.id, draft);
  const scope = action === "clear" || action === "delete" ? "All messages in this chat, for the linked account only; local history and index are removed too." :
    action === "block" ? "This account will block this person." : action === "unblock" ? "This account will unblock this person." :
      action === "pin_message" || action === "unpin_message" ? "Every member of this chat can see this change." : "This changes the linked account's chat state.";
  const duration = action === "mute" ? `\nDuration: ${options.muteHours ?? 8} hours` : action === "pin_message" ? `\nDuration: ${options.pinHours ?? 168} hours` : "";
  const reference = target.number ? "" : `\nChat reference: ${target.chat_id}`;
  const preview = `Account: ${ctx.accountId}\nChat: ${describeTarget(target)}${reference}\nAction: ${action}${duration}\n${scope}` +
    (options.messageId ? `\nMessage: ${options.messageId}\n${messageText}` : "");
  return { status: "preview", confirmation_id: draft.id, chat_id: target.chat_id, action, target: { ...target }, preview,
    expires_at: new Date(draft.expires).toISOString(), ...(options.messageId ? { message_id: options.messageId } : {}),
    next: "Show this preview. After the user's yes, call manage_chat with the returned chat_id, action and confirmation_id, and the same account_id. No mutation has run. Never automatically retry an unknown outcome." };
}

/** A confirm uses only frozen arguments; retries join the same attempt, including failures. */
export async function confirmChatAction(args: ToolArgs, ctx: ToolCtx): Promise<ChatActionResult> {
  const draft = requireChatAction(args.confirmation_id as string, ctx.draftOwner, ctx.accountId);
  if (args.chat_id !== draft.target.chat_id || args.action !== draft.action ||
      args.mute_hours !== undefined || args.message_id !== undefined || args.pin_hours !== undefined) {
    throw new WazapError("INVALID_ID", "Confirm only the previewed chat_id, action and confirmation_id; options are frozen in the preview.", FIX);
  }
  checkSource(draft, ctx);
  if (draft.work !== undefined) return draft.work;
  // Claim before awaiting contact resolution: concurrent confirms must join one promise.
  draft.work = (async () => {
    const current = await ctx.wa.getContact(draft.target.chat_id);
    if (draft.options.messageId) {
      const message = await ctx.wa.getMessage(draft.options.messageId);
      if (message.chat_id !== draft.target.chat_id || textHash(message.text) !== draft.messageHash) throw staleChatAction();
    }
    checkSource(draft, ctx);
    if (draft.expires <= Date.now()) throw new WazapError("CHAT_ACTION_EXPIRED", "The chat-action preview expired before execution.", FIX);
    if (current.contact_id !== draft.target.chat_id || current.name !== draft.target.name ||
        (current.number ?? undefined) !== draft.target.number) throw staleChatAction();
    try {
      return await ctx.wa.manageChat(draft.target.chat_id, draft.action, draft.options);
    } catch {
      throw new WazapError("CHAT_ACTION_OUTCOME_UNKNOWN", "The chat action was attempted but its outcome is unknown; this confirmation will never run it again.",
        "Inspect the chat state and tell the user; do not preview or repeat the action without a new explicit request.");
    }
  })();
  return draft.work;
}
