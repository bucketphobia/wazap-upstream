import { z } from "zod";
import type { AccountSource } from "./account-hub.js";
import { renderGetStatus } from "./account-resolve.js";
import { draftContextEnabled } from "./accounts.js";
import {
  createToolRegistrar,
  type ContentBlock,
  type ToolArgs,
  type ToolCtx,
  type ToolDef,
  type ToolHints,
  type ToolResult,
} from "./tool-runtime.js";
export { toolError, type ToolCtx, type RegisterOpts } from "./tool-runtime.js";
import { CATCHUP_INPUT, CATCHUP_OUTPUT, privateRule, runCatchUp } from "./catchup.js";
import { coverageNote, indexCoverageNote, searchCoverage } from "./coverage.js";
import { describeTarget, looksUnnamed, renderDraft, type DraftPayload, type DraftView } from "./drafts.js";
import { ERROR_GUIDE, WazapError, asWazapError } from "./errors.js";
import { FIND_CONTACT_OUTPUT, runFindContact } from "./find-contact.js";
import { LIST_CONTACTS_INPUT, runListContacts } from "./list-contacts.js";
import { freshnessNote, readFreshness } from "./freshness.js";
import { mediaCaptionOf } from "./media-details.js";
import { captionTravels, mimeOfSource } from "./outgoing-media.js";
import { getMessageView, getMessageViewAcross, resolveMessageId, resolveMessageIdAcross } from "./message-ref.js";
import { clockLabel } from "./messages.js";
import { RateLimiter } from "./ratelimit.js";
import {
  assertSendable,
  draftTargetOf,
  hasSendRules,
  noteConfirming,
  noteDraftTarget,
  sendPolicyOf,
  type SendPolicy,
} from "./send-guard.js";
import {
  resolveSenderFilter,
  withSenderIdentity,
  type IdentifiedMessage,
  type IdentifiedRecallAnswer,
} from "./sender-identity.js";
import { MESSAGE_TYPES } from "./wa-types.js";
import type {
  ChatSummary,
  ContactSummary,
  HandledResult,
  JoinGroupResult,
  JoinRequest,
  MessageView,
  OutgoingTarget,
  RecallAnswer,
  SentMessage,
  SearchAnswer,
  Synced,
  Preview,
  UnconfirmedSend,
  WaitResult,
  WhatsAppApi,
} from "./wa-types.js";

export { anyAccountAllowsWrites } from "./account-resolve.js";

/** Explained once, in the server's instructions and in learn; each tool only names it. */
const ACCOUNT_ID = z.string().min(1).describe("Account id");

/** A message in an answer: the keys every one has, and the rest as they come (learn describes them). */
const MESSAGE_OUT = z.object({ message_id: z.string(), chat_id: z.string(), text: z.string(), timestamp: z.string() }).passthrough();
const OPEN_OBJECT = z.object({}).passthrough();

/**
 * What the assistant must say or do about an answer, in the structured
 * content: a client such as Claude Code hands the model that, not the text, so
 * guidance living only in the text never reaches it. Short, imperative, in
 * English; the text keeps its longer wording.
 */
const NOTES = z.array(z.string()).optional().describe("Caveats to act on or tell the user");

const LIST_CHATS_OUTPUT = {
  filter: z.string(),
  count: z.number(),
  chats: z.array(
    z
      .object({
        chat_id: z.string(),
        name: z.string(),
        type: z.string(),
        unread_count: z.number(),
        last_message: z.object({ private: z.literal(true).optional().describe("Tagged #private: no words") }).passthrough().nullable().optional(),
      })
      .passthrough()
  ),
  sync: z.string(),
  account_id: z.string(),
};

/** A message in a broad read, which may be someone's kept #private (src/private-contacts.ts). */
const BROAD_MESSAGE_OUT = MESSAGE_OUT.extend({ private: z.literal(true).optional().describe("Tagged #private: no words") }).passthrough();

const READ_OUTPUT = {
  chat_id: z.string(),
  types: z.array(z.string()).optional(),
  hours: z.number().optional(),
  count: z.number(),
  omitted: z.number().optional().describe("Older stories left out by limit"),
  preview_count: z.number(),
  messages: z.array(BROAD_MESSAGE_OUT),
  unconfirmed_sends: z
    .array(z.object({ draft_id: z.string(), text: z.string(), handed_at: z.string(), state: z.literal("unknown") }))
    .optional()
    .describe("Sends WhatsApp has not echoed yet: outcome unknown, not failed"),
  older: z
    .object({ asked_phone: z.literal(true), received: z.number() })
    .optional()
    .describe("before ran past the local history: the phone was asked, and sent this many"),
  notes: NOTES,
  sync: z.string(),
  account_id: z.string(),
};

const WAIT_OUTPUT = {
  count: z.number(),
  messages: z.array(BROAD_MESSAGE_OUT),
  cursor: z.string().describe("Pass to the next call"),
  timed_out: z.boolean(),
  cursor_reset: z.boolean().describe("The cursor was from another run; the wait started now"),
  account_id: z.string(),
};

/** get_message answers the message itself: its fields are open, as every message's are. */
const MESSAGE_OUTPUT = MESSAGE_OUT.extend({ account_id: z.string() }).passthrough();

const GROUP_INFO_OUTPUT = {
  chat_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  owner: z.string().nullable(),
  created_at: z.string().nullable(),
  participant_count: z.number(),
  participants: z.array(z.object({ contact_id: z.string(), name: z.string(), is_admin: z.boolean() })),
  announcement_only: z.boolean(),
  i_am_admin: z.boolean(),
  info_locked: z.boolean(),
  member_add_mode: z.enum(["admins", "all"]),
  join_approval: z.boolean(),
  disappearing_seconds: z.number(),
  community: z.object({ is_community: z.boolean(), parent_group_id: z.string().nullable() }).optional(),
  invite_link: z.string().optional(),
  account_id: z.string(),
};

const EDIT_OUTPUT = { message_id: z.string(), chat_id: z.string(), text: z.string(), timestamp: z.string(), account_id: z.string() };
const REACT_OUTPUT = { message_id: z.string(), emoji: z.string(), account_id: z.string() };
const DELETE_OUTPUT = { message_id: z.string(), for_everyone: z.boolean(), account_id: z.string() };

const SEARCH_OUTPUT = {
  query: z.string(),
  mode: z.enum(["hybrid", "words", "keyword_fallback"]).describe("keyword_fallback: meaning search could not run, see recall_unavailable"),
  from_resolved: z.string().optional(),
  count: z.number(),
  messages: z.array(
    MESSAGE_OUT.extend({
      score: z.number().optional(),
      matched: z.enum(["words", "meaning", "both"]).optional(),
      similarity: z.number().nullable().optional(),
      from_index: z.boolean().optional().describe("Kept only as text: no media, reply or forward"),
    }).passthrough()
  ),
  scan_capped: z.boolean().optional().describe("Older matches may be missing: narrow the search"),
  private_omitted: z.number().optional().describe("Matches from people tagged #private, left out: chat_id or from shows them"),
  searched_back_to: z.string().optional().describe("Older messages were not searched: narrow the search"),
  coverage: OPEN_OBJECT.nullable().optional().describe("null: it could not be counted"),
  index: OPEN_OBJECT.optional(),
  recall_unavailable: z.object({ code: z.string(), message: z.string(), fix: z.string().optional() }).optional(),
  freshness: OPEN_OBJECT.nullable(),
  notes: NOTES,
  sync: z.string(),
  account_id: z.string(),
};

/** What keeps search from matching by meaning: off, a failing or refusing embedding server, or one still starting. search answers by words instead. */
const MEANING_FAILURES: ReadonlySet<string> = new Set(["RECALL_UNAVAILABLE", "RECALL_FAILED", "RECALL_BAD_INPUT", "TIMEOUT"]);

const MEDIA_OUTPUT = {
  message_id: z.string(),
  type: z.string().nullable(),
  caption: z.string().nullable(),
  original_filename: z.string().nullable(),
  sender: OPEN_OBJECT.nullable(),
  path: z.string().optional(),
  mime: z.string().optional(),
  size: z.number().optional(),
  filename: z.string().optional().describe("The name it was saved under"),
  image_attached: z.boolean().optional().describe("The photo, or a small preview of it, is attached"),
  transcript: z
    .object({ text: z.string(), language: z.string().optional(), duration_seconds: z.number().optional(), provider: z.string(), cached: z.boolean() })
    .optional(),
  transcript_unavailable: z.object({ code: z.string(), message: z.string(), fix: z.string().optional() }).optional(),
  account_id: z.string(),
};

/** Transcripts made for get_media, whichever session asks: ten runs a minute for the process, since the API provider bills each one. */
const TRANSCRIBE_BUCKET = new RateLimiter(10, undefined, "Transcribe");

const MANAGE_GROUP_OUTPUT = {
  action: z.string(),
  group_id: z.string().nullable(),
  applied: z.string().optional(),
  participants: z.array(z.object({ id: z.string(), status: z.enum(["ok", "invite_needed", "failed"]), reason: z.string().optional() })).optional(),
  invite_link: z.string().optional(),
  profile_pic_url: z.string().nullable().optional(),
  join_requests: z.array(OPEN_OBJECT).optional(),
  status: z.enum(["preview", "joined", "pending_approval"]).optional().describe("join: preview joins nothing"),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  participant_count: z.number().nullable().optional(),
  join_approval: z.boolean().nullable().optional(),
  next: z.string().optional().describe("join preview: the step after the user's yes"),
  account_id: z.string(),
};

const REMEMBER_OUTPUT = {
  chat_id: z.string(),
  name: z.string(),
  note: z.string().optional(),
  tags: z.array(z.string()).optional(),
  fields: z.record(z.string()).optional(),
  number: z.string().nullable().optional(),
  is_my_contact: z.boolean().optional(),
  is_business: z.boolean().optional(),
  handled: z.object({ ask_id: z.string().nullable(), ask_text: z.string().nullable() }).optional().describe("The ask taken off the waiting list; null when nothing was open"),
  account_id: z.string(),
};

const hint = (readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean): ToolHints => ({
  readOnlyHint,
  destructiveHint,
  idempotentHint,
  openWorldHint,
});

/**
 * Each tool's annotations, true of its most far-reaching action, on one rule:
 * - readOnlyHint: the tool changes nothing on WhatsApp and nothing the user
 *   keeps in wazap (notes, tags, details, handled). Not a change: wazap's own
 *   bookkeeping (catch_up's mark, the caches), a file saved where a local call
 *   asked (get_media's save_to), a transcript the user configured (billed by
 *   the provider they chose, at most ten a minute). So catch_up and get_media
 *   are read-only and remember is not: a client that confirms every tool that
 *   is not read-only asks for remember alone. A session over OAuth cannot pass
 *   save_to, so get_media only reads there, and a dialog on every voice note
 *   would break "what does it say?". F2-6's ChatGPT arm checks it.
 * - openWorldHint: the tool reaches WhatsApp or a provider. A read that only
 *   mirrors WhatsApp still reaches it (older history, group metadata, the
 *   address book), so only learn, get_status and remember are closed-world.
 */
const HINTS: Record<string, ToolHints> = {
  learn: hint(true, false, true, false),
  get_status: hint(true, false, true, false),
  // It starts a pairing on WhatsApp.
  link_account: hint(false, false, false, true),
  list_chats: hint(true, false, true, true),
  read_messages: hint(true, false, true, true),
  // Read-only by the rule above: the mark it moves is wazap's, though a repeat answers differently.
  catch_up: hint(true, false, false, true),
  // The user's notes, kept locally: not read-only, never WhatsApp, and filing the same thing twice changes nothing.
  remember: hint(false, false, true, false),
  wait_for_messages: hint(true, false, true, true),
  search: hint(true, false, true, true),
  get_message: hint(true, false, true, true),
  find_contact: hint(true, false, true, true),
  list_contacts: hint(true, false, true, true),
  get_group_info: hint(true, false, true, true),
  // Read-only by the rule above, though save_to writes another file on each call: not idempotent.
  get_media: hint(true, false, false, true),
  // A draft is not a send, but each call makes another.
  send_message: hint(false, false, false, true),
  // Confirming a draft again answers the same receipt.
  confirm_send: hint(false, false, true, true),
  // The earlier text is gone for everyone.
  edit_message: hint(false, true, true, true),
  delete_message: hint(false, true, true, true),
  react_to_message: hint(false, false, true, true),
  // clear, delete and block, beside mark_read.
  manage_chat: hint(false, true, false, true),
  // remove, leave, revoke_invite_link.
  manage_group: hint(false, true, false, true),
};

function tool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  schema: S;
  outputSchema?: z.ZodRawShape | z.AnyZodObject;
  write: boolean;
  rate?: number;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolCtx) => Promise<ToolResult>;
}): ToolDef {
  const hints = HINTS[def.name];
  if (hints === undefined) throw new Error(`${def.name} has no annotations in HINTS`);
  return {
    ...def,
    hints,
    schema: { ...def.schema, account_id: ACCOUNT_ID.optional() },
    handler: def.handler as (args: ToolArgs, ctx: ToolCtx) => Promise<ToolResult>,
  };
}

function ok(text: string, structured: Record<string, unknown>, extra: ContentBlock[] = []): ToolResult {
  return { content: [{ type: "text", text }, ...extra], structuredContent: structured };
}

/** `notes`, only when there is one. */
function notesField(notes: ReadonlyArray<string | null>): { notes?: string[] } {
  const kept = notes.filter((note): note is string => note !== null && note !== "");
  return kept.length === 0 ? {} : { notes: kept };
}

function synced<T>(result: Synced<T>, rest: Record<string, unknown>): Record<string, unknown> {
  return { ...rest, sync: result.sync };
}

/** `scan_capped`, and how far back a capped search got: older messages were not searched, which is not "none exist". */
function scanCapFields(result: SearchAnswer): Record<string, unknown> {
  return result.scanCapped === undefined
    ? { scan_capped: false }
    : { scan_capped: true, searched_back_to: result.scanCapped.searchedBackTo };
}

function scanCapNote(result: SearchAnswer): string | null {
  if (result.scanCapped === undefined) return null;
  return `The search stopped at its scan limit; messages before ${result.scanCapped.searchedBackTo.slice(0, 10)} were not searched — narrow it with chat_id, since/until or a longer query.`;
}

function scanCapNotice(result: SearchAnswer): string | null {
  if (result.scanCapped === undefined) return null;
  return `Messages before ${result.scanCapped.searchedBackTo.slice(0, 10)} were not searched: narrow it with chat_id, since/until or a longer query; never say none exist.`;
}

const LEXICAL_CAP_NOTE =
  'More messages hold these words than were ranked, so older matches may be missing: narrow it with chat_id or since/until, or pass match: "words" to list them newest first.';

/** `private_omitted`, only when a search left someone #private out. */
function privateFields(omitted: number | undefined): Record<string, unknown> {
  return omitted === undefined ? {} : { private_omitted: omitted };
}

function privateNote(omitted: number | undefined): string | null {
  if (omitted === undefined) return null;
  return `${omitted} ${omitted === 1 ? "match" : "matches"} from people tagged #private left out: name the chat (chat_id) or the person (from) to search them.`;
}

const chatId = z.string().min(1).describe("Chat id, or a phone number");

const messageId = z.string().min(5);

const messageTypes = z
  .array(z.enum([...MESSAGE_TYPES]))
  .optional()
  .describe('Only these types; limit counts them, so ["call"] gives that many calls');

const includePreviews = z
  .boolean()
  .default(false)
  .describe("Attach a small image of each photo, up to 12");

/** Previews are 5-15 KB each; a dozen keep one answer small and the first call under the client's timeout. */
const MAX_PREVIEWS = 12;

const GUIDE = `# wazap: WhatsApp for your AI agent

The user's own WhatsApp account: chats, messages, media, contacts, groups.
Call get_status when anything fails, and link_account when it says not_linked.

## Ids and accounts
- chat_id: \`<digits>@s.whatsapp.net\` for a person, \`<id>@g.us\` for a group, or
  a phone number in international format. Pass ids back exactly as given.
- message_id: the full id from read_messages, search or catch_up.
- account_id: the account a call is about (\`default\`, \`work\`); get_status
  lists them. Optional everywhere. Without it, a chat or message only one account
  knows picks that account; catch_up and find_contact cover every account; other
  reads use the default; a write to a chat no account knows fails AMBIGUOUS_ACCOUNT.

## Workflows
- Catch up: catch_up() gives who waits on a reply, mentions, missed calls,
  people, groups and stories, every account at once; more.cursor brings the rest.
  An ask the user handled elsewhere: remember(chat_id, handled: true).
- One chat: read_messages(chat_id), older with before; chat_id "status" reads
  stories. To stay on the line, wait_for_messages with the cursor it returns.
- Find something said: search(query) matches meaning and words; match: "words"
  for an exact string. get_message shows one message in full; get_media gives its
  file, a photo as an image, a voice note's transcript (its file with save_to).
- Who someone is: find_contact(name) before drafting ("mama", "Ana de la
  contabilitate"). resolved gives the chat_id; ambiguous or not_found: ask the
  user, never guess. remember keeps what the user says about a person (note,
  tags, fields such as relatie), on this machine; find_contact(tag) lists a tag.
  list_contacts pages the whole address book (saved name, number, last chat);
  address_book_synced false means it has not arrived yet.
- #private: a person's words come only when a call names them: their chat_id,
  a message_id of theirs, search's from; a group's chat_id reads whole. Elsewhere
  their entries say private, with no words, and search counts private_omitted.
  Fetch them only when asked.
- Send: send_message drafts text, media, a poll, a location or a forward, and
  sends nothing. Show the preview; after the user's yes, confirm_send(draft_id)
  is the only call that sends. A draft lasts 15 minutes. Fix style_check.warnings
  before showing a draft the user did not dictate. To mention someone, pass
  mention_ids and write @<number> in the text. unnamed_recipient: the name shown
  is not a saved contact; say so.
- At once, no draft: react_to_message, edit_message, delete_message, manage_chat,
  manage_group. Say what will change and wait for a yes. delete_message with
  for_everyone: false removes a message for the linked account only;
  delete_message takes someone else's message for everyone only in a group where
  the account is admin. manage_group join previews an invite until confirm: true.
  Most group actions (settings, list_join_requests, set_picture) need admin:
  get_group_info first.

## Message shape
text is never empty: media and notices read as "[image] caption", "[voice
message · 0:42]", "[deleted]", "[poll] question". A transcribed voice note
carries transcript. sender: {id, name, phone, is_saved, contact_name, pushname,
name_source}; with is_saved false the name is self-given. An unknown sender reads
"unknown (lid …1234)", never lid digits. mentions: [{id, name}]; reactions and
votes ride on their message, get_message says who. The user's own messages carry
delivery: {status, read_by, delivered_to}, as far as receipts reached this device.
A call has type "call" and call: {kind, direction, outcome, duration_seconds}. A
notice has type "system" and system: {action, actor, targets, value}: report a
membership change from it, never from who posted nearby. timestamp is ISO 8601.

## Errors
A failure is { error, message, fix }. Per code:
${(Object.keys(ERROR_GUIDE) as Array<keyof typeof ERROR_GUIDE>).map((code) => `- ${code}: ${ERROR_GUIDE[code]}`).join("\n")}
`;

// ---- catch_up (F2-2) --------------------------------------------------------
// The digest itself is src/catchup.ts; each account's side is catchup-scan.ts.
const CATCH_UP: ToolDef = tool({
  name: "catch_up",
  title: "Catch up on what the user missed",
  description: `What the user missed, all accounts, within budget_tokens: waiting (every open ask of 14 days, whatever the window), mentions, calls, people, groups, stories. account_id narrows it to one account; get_status names them. The mark moves first; a lost answer is since: "previous". more.cursor: the rest.`,
  schema: CATCHUP_INPUT,
  outputSchema: CATCHUP_OUTPUT,
  write: false,
  handler: async (args, { hub, wa, accountId, client }) => runCatchUp(args, { hub, wa, accountId, client }),
});
// ---- end catch_up -------------------------------------------------------------

const TOOLS: readonly ToolDef[] = [
  tool({
    name: "learn",
    title: "Learn how to use the WhatsApp tools",
    description: `The guide to these tools: ids, account_id with several accounts, the workflows, the message shape and what to do about each error code. Read it once, before the other tools; it never touches WhatsApp.`,
    schema: {},
    write: false,
    // Prose, once: the guide is not repeated as structured content.
    handler: async () => ({ content: [{ type: "text", text: GUIDE }] }),
  }),

  tool({
    name: "get_status",
    title: "Get the WhatsApp connection status",
    description: `Whether the account works: status (connected, not_linked, linking with its pairing code…), sync, how fresh the history is, webhook delivery, versions. accounts lists every account, with default. Call it on NOT_CONNECTED, NOT_LINKED or SYNC_IN_PROGRESS.`,
    schema: {},
    write: false,
    handler: async (_args, { wa, hub, allowWrite }) => renderGetStatus(wa.getStatus(), allowWrite, hub),
  }),

  tool({
    name: "link_account",
    title: "Link a WhatsApp account",
    description: `Pair wazap with the user's WhatsApp when get_status says not_linked, logged_out, session_corrupt or auth_failure. Show the user the code it returns: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead. Then poll get_status every 10 s until connected.`,
    schema: { phone: z.string().describe("e.g. +15550100") },
    write: false,
    rate: 2,
    handler: async ({ phone }, { wa }) => {
      const pairing = await wa.link(phone);
      const next =
        "Show the user the code and the steps, then call get_status every 10 seconds until it says connected.";
      const text = [
        `# Pairing code: ${pairing.code}`,
        `- **number**: ${pairing.phone_masked}`,
        `- **expires**: ${pairing.expires_at}`,
        "",
        "On their phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead → enter the code.",
        next,
      ].join("\n");
      return ok(text, { ...pairing, next });
    },
  }),

  tool({
    name: "list_chats",
    title: "List WhatsApp chats",
    description: `Conversations, most recently active first: chat_id, name, type, unread count, last message, and whether archived, pinned, muted or left. Use it to find a chat_id.`,
    schema: {
      filter: z.enum(["all", "unread", "groups", "individual", "archived"]).default("all").describe('"all" leaves out archived'),
      limit: z.number().int().min(1).max(100).default(20),
    },
    outputSchema: LIST_CHATS_OUTPUT,
    write: false,
    handler: async ({ filter, limit }, ctx) => {
      const result = await ctx.wa.listChats(filter, limit, { private: await privateRule(ctx.hub, ctx.accountId) });
      return ok(
        renderChats(result.data, filter),
        synced(result, { filter, count: result.data.length, chats: result.data })
      );
    },
  }),

  tool({
    name: "read_messages",
    title: "Read messages from a WhatsApp chat",
    description: `Read one chat, oldest to newest: the latest messages, or older ones with before (wazap asks the phone when the local history runs out). chat_id "status" reads the stories people posted, newest first, from the last hours (at most a day); they show nowhere else.`,
    schema: {
      chat_id: chatId.describe('Chat id from another tool, a phone number, or "status" for stories'),
      limit: z.number().int().min(1).max(200).default(20),
      before: messageId.optional().describe("The oldest message_id you have"),
      types: messageTypes,
      include_previews: includePreviews,
      hours: z.number().int().min(1).max(24).optional().describe('"status" only: how far back, 24 by default'),
    },
    outputSchema: READ_OUTPUT,
    write: false,
    handler: async ({ chat_id, limit, before, types, include_previews, hours }, ctx) => {
      const { wa } = ctx;
      if (isStatusChat(chat_id)) {
        if (before !== undefined) {
          throw new WazapError("INVALID_ID", "Stories are not paged: before does not apply to status.", "Pass hours (1-24) instead");
        }
        const window = hours ?? 24;
        const result = await wa.getStories(window, { private: await privateRule(ctx.hub, ctx.accountId) });
        const matching = types === undefined ? result.data : result.data.filter((m) => types.includes(m.type));
        const stories = matching.slice(0, limit);
        // A story of someone tagged #private gets no preview: what it shows is its words.
        const open = stories.filter((m) => m.private !== true);
        const previews = include_previews ? await wa.previews(newestFirst(open), MAX_PREVIEWS) : [];
        const omitted = matching.length - stories.length;
        const note = [previewNote(open, previews, include_previews), omitted > 0 ? `${omitted} older stories left out; raise limit for them.` : null]
          .filter(Boolean)
          .join(" ");
        const notes = notesField([previewGap(open, previews, include_previews), omitted > 0 ? `${omitted} older stories left out: raise limit for them.` : null]);
        return ok(
          renderStories(stories, window, previewLabels(previews), note || null),
          synced(result, {
            chat_id: "status",
            hours: window,
            ...(types === undefined ? {} : { types }),
            count: stories.length,
            ...(omitted > 0 ? { omitted } : {}),
            preview_count: previews.length,
            messages: stories,
            ...notes,
          }),
          previewBlocks(previews)
        );
      }
      if (hours !== undefined) {
        throw new WazapError("INVALID_ID", 'hours applies to chat_id "status" only.', "Page back through a chat with before instead");
      }
      const result = await wa.readMessages(chat_id, limit, before, types);
      const previews = include_previews ? await wa.previews(newestFirst(result.data), MAX_PREVIEWS) : [];
      const unconfirmed = result.unconfirmedSends ?? [];
      const noOlder = result.older?.received === 0 ? OLDER_NONE_NOTE : null;
      return ok(
        renderMessages(
          `Messages in ${chat_id}`,
          result.data,
          previewLabels(previews),
          [
            ...unconfirmed.map((send) => `${unconfirmedNote(send)} Its words: ${JSON.stringify(truncate(send.text, 160))}.`),
            noOlder,
            previewNote(result.data, previews, include_previews),
          ]
            .filter(Boolean)
            .join(" ") || null
        ),
        synced(result, {
          chat_id,
          types,
          count: result.data.length,
          preview_count: previews.length,
          messages: result.data,
          ...(unconfirmed.length === 0 ? {} : { unconfirmed_sends: unconfirmed }),
          ...(result.older === undefined ? {} : { older: { asked_phone: true, received: result.older.received } }),
          ...notesField([...unconfirmed.map(unconfirmedNote), noOlder, previewGap(result.data, previews, include_previews)]),
        }),
        previewBlocks(previews)
      );
    },
  }),
  CATCH_UP,

  tool({
    name: "remember",
    title: "Remember something about a person",
    description: `Keep what the user says about someone, locally, never on WhatsApp: a note, tags, details find_contact matches ({"relatie": "mama"}), or handled: true for an ask dealt with elsewhere. #private keeps their words out of what you did not ask about them by name; #no-catchup keeps them out of catch_up.`,
    schema: {
      chat_id: chatId,
      note: z.string().max(200).optional().describe('"" removes it'),
      add_tags: z.array(z.string().min(1).max(40)).max(30).optional().describe('e.g. ["client"]'),
      remove_tags: z.array(z.string().min(1).max(40)).optional(),
      fields: z.record(z.string().max(200)).optional().describe('e.g. {"nickname": "Mișu", "role": "contabil"}; "" deletes a key'),
      remove_fields: z.array(z.string().min(1).max(40)).optional(),
      handled: z.literal(true).optional().describe("Off catch_up's waiting until they write again"),
    },
    outputSchema: REMEMBER_OUTPUT,
    write: false,
    handler: async ({ chat_id, note, add_tags, remove_tags, fields, remove_fields, handled }, { wa }) => {
      const details = add_tags !== undefined || remove_tags !== undefined || fields !== undefined || remove_fields !== undefined;
      if (!details && note === undefined && handled === undefined) {
        throw new WazapError("INVALID_ID", "Nothing to remember.", "Pass note, add_tags, remove_tags, fields, remove_fields or handled: true");
      }
      const lines: string[] = [];
      let card: ContactSummary | undefined;
      // Details first: they are the edit most likely to be refused, and a refusal must leave nothing half-filed.
      if (details) {
        card = await wa.updateContactDetails(chat_id, { addTags: add_tags, removeTags: remove_tags, fields, removeFields: remove_fields });
      }
      if (note !== undefined) {
        card = await wa.setContactNote(chat_id, note);
        lines.push(card.note ? `Noted for ${card.name}: ${card.note}` : `Removed the note on ${card.name}.`);
      }
      if (details && card !== undefined) lines.push(renderContactCard(card));
      let marked: HandledResult | undefined;
      if (handled === true) {
        marked = await wa.markHandled(chat_id);
        lines.push(
          marked.ask_id
            ? `${marked.name} is off the waiting list until they write again. Handled: "${truncate(marked.ask_text ?? "", 120)}"`
            : `${marked.name} had nothing open; nothing to mark.`
        );
      }
      const structured: Record<string, unknown> = card === undefined
        ? { chat_id: marked!.chat_id, name: marked!.name }
        : { ...card, chat_id: card.contact_id };
      delete structured.contact_id;
      if (marked !== undefined) structured.handled = { ask_id: marked.ask_id, ask_text: marked.ask_text };
      return ok(lines.join("\n"), structured);
    },
  }),

  tool({
    name: "wait_for_messages",
    title: "Wait for new WhatsApp messages",
    description: `Wait for messages from other people, up to timeout_seconds, and return them with a cursor: pass it to the next call so nothing that lands between calls is missed. addressed_to_me wakes only for direct messages, mentions and replies to the user. For agents that stay on the line.`,
    schema: {
      timeout_seconds: z.number().int().min(1).max(55).default(30),
      chat_id: chatId.optional(),
      addressed_to_me: z.boolean().default(false),
      cursor: z.string().min(1).optional().describe("From the previous call"),
    },
    outputSchema: WAIT_OUTPUT,
    write: false,
    handler: async ({ timeout_seconds, chat_id, addressed_to_me, cursor }, ctx) => {
      const result = await ctx.wa.waitForMessages({
        timeoutMs: timeout_seconds * 1000,
        chatId: chat_id,
        addressedToMe: addressed_to_me,
        cursor,
        ...(chat_id === undefined ? { private: await privateRule(ctx.hub, ctx.accountId) } : {}),
      });
      return ok(renderWait(result), { ...result, count: result.messages.length });
    },
  }),

  tool({
    name: "search",
    title: "Search WhatsApp messages",
    description: `Find messages by meaning and by words at once, in every chat or one: a paraphrase or another language still hits. match: "words" for exact words (a number, a URL). since, until and from narrow it; coverage and freshness say how much history was searched.`,
    schema: {
      query: z.string().min(1),
      match: z.enum(["hybrid", "words"]).default("hybrid").describe('"words": only messages holding the words'),
      chat_id: chatId.optional(),
      limit: z.number().int().min(1).max(50).default(20),
      since: z.string().min(4).optional().describe("ISO date or time"),
      until: z.string().min(4).optional().describe("ISO date or time"),
      from: z.string().min(1).optional().describe('"me", a number, an id, or a name only one person has'),
    },
    outputSchema: SEARCH_OUTPUT,
    write: false,
    handler: async ({ query, match, chat_id, limit, since, until, from }, ctx) => {
      const { wa } = ctx;
      const resolvedFrom = await resolveSenderFilter(wa, from);
      const sinceMs = parseMoment(since, "since");
      const untilMs = parseMoment(until, "until", true);
      // Without a chat, someone tagged #private is left out unless from names them (src/private-contacts.ts).
      const filters = { sinceMs, untilMs, from: resolvedFrom, ...(chat_id === undefined ? { private: await privateRule(ctx.hub, ctx.accountId) } : {}) };
      const scope = [
        chat_id ? `in ${chat_id}` : null,
        from ? `from ${from}` : null,
        since ? `since ${since}` : null,
        until ? `until ${until}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const title = `Search results for "${query}"${scope ? ` (${scope})` : ""}`;
      const echo = { query, ...(resolvedFrom === undefined ? {} : { from_resolved: resolvedFrom }) };

      let unavailable: WazapError | null = null;
      if (match !== "words") {
        let result: Synced<RecallAnswer> | null = null;
        try {
          result = await wa.recall(query, chat_id, limit, filters);
        } catch (err) {
          if (!(err instanceof WazapError) || !MEANING_FAILURES.has(err.code)) throw err;
          // Meaning search off, failing or still starting: the history still answers by its words.
          unavailable = err;
        }
        if (result !== null) {
          const identified = await withSenderIdentity(
            wa,
            result.data.hits.map((hit) => hit.message)
          );
          const hits = result.data.hits.map((hit, i) => ({ ...hit, message: identified[i]! }));
          const fresh = await readFreshness(wa, chat_id);
          const capped = result.data.lexicalCapped === true;
          const answer: IdentifiedRecallAnswer = { hits, index: result.data.index, lexicalCapped: capped };
          // While the index is still catching up renderRecall says so itself; the coverage line only repeats it.
          const note = [
            capped ? LEXICAL_CAP_NOTE : null,
            privateNote(result.data.privateOmitted),
            result.data.index.state === "indexing" ? null : indexCoverageNote(result.data.index),
            freshnessNote(fresh),
          ]
            .filter(Boolean)
            .join(" ");
          return ok(
            `${renderRecall(title, answer)}${note ? `\n${note}` : ""}`,
            synced(result, {
              ...echo,
              mode: "hybrid",
              count: hits.length,
              messages: hits.map(({ message, ...rank }) => ({ ...message, ...rank })),
              scan_capped: capped,
              ...privateFields(result.data.privateOmitted),
              index: result.data.index,
              freshness: fresh,
              ...notesField([
                weakMatches(hits) ? WEAK_NOTE : null,
                result.data.index.state === "indexing" ? "The meaning index is still catching up: more matches may appear." : null,
                capped ? LEXICAL_CAP_NOTE : null,
                privateNote(result.data.privateOmitted),
                freshnessNote(fresh),
              ]),
            })
          );
        }
      }

      const found = await wa.searchMessages(query, chat_id, limit, filters);
      const messages = await withSenderIdentity(wa, found.data);
      const fresh = await readFreshness(wa, chat_id);
      const cov = searchCoverage(wa, chat_id, { sinceMs, untilMs });
      const fallback =
        unavailable === null
          ? null
          : `Meaning search is unavailable (${unavailable.message}); these results match the words only.${unavailable.fix ? ` ${unavailable.fix}` : ""}`;
      const note = [fallback, scanCapNote(found), privateNote(found.privateOmitted), coverageNote(cov, chat_id !== undefined), freshnessNote(fresh)]
        .filter(Boolean)
        .join(" ");
      return ok(
        renderMessages(title, messages, new Map(), note),
        synced(found, {
          ...echo,
          mode: unavailable === null ? "words" : "keyword_fallback",
          ...(unavailable === null
            ? {}
            : { recall_unavailable: { code: unavailable.code, message: unavailable.message, ...(unavailable.fix ? { fix: unavailable.fix } : {}) } }),
          count: messages.length,
          messages,
          ...scanCapFields(found),
          ...privateFields(found.privateOmitted),
          coverage: cov,
          freshness: fresh,
          ...notesField([
            unavailable === null ? null : "Meaning search is unavailable, so these match the words only: recall_unavailable says why.",
            scanCapNotice(found),
            privateNote(found.privateOmitted),
            freshnessNote(fresh),
          ]),
        })
      );
    },
  }),

  tool({
    name: "get_message",
    title: "Get one WhatsApp message in full",
    description: `One message in full: the message it quotes, each reaction with who left it, poll votes and event answers by person, its media, and on the user's own messages who it reached and who read it. Without account_id the id is looked for on every account.`,
    // account_id is named again here so the handler sees it typed: an explicit
    // id keeps the lookup on that one account instead of walking the bindings.
    schema: { message_id: messageId, account_id: ACCOUNT_ID.optional() },
    outputSchema: MESSAGE_OUTPUT,
    write: false,
    handler: async ({ message_id, account_id }, { wa, hub, accountId }) => {
      const resolved = { id: accountId, wa };
      const { binding, message } =
        account_id === undefined
          ? await getMessageViewAcross(hub, resolved, message_id)
          : { binding: resolved, message: await getMessageView(wa, message_id) };
      const [identified] = await withSenderIdentity(binding.wa, [message]);
      const view = identified ?? message;
      const text = [renderMessages("Message", [view]), reactionLine(view), voteLines(view), deliveryLines(view)]
        .filter(Boolean)
        .join("\n");
      return ok(text, {
        ...(view as unknown as Record<string, unknown>),
        account_id: binding.id,
      });
    },
  }),

  tool({
    name: "find_contact",
    title: "Find who the user means",
    description: `Who a name, nickname, relationship ("mama"), group, number or id means, before drafting. resolved: contact.chat_id, with number, note, tags, details and, in a write session, context. ambiguous or not_found: ask the user; never send to a guess. A name on several accounts: see fix. tag: its people.`,
    schema: {
      name: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('What the user calls them ("Ana", "mamei", "fotbal"), or a number or id'),
      qualifier: z.string().max(100).optional().describe('Tells two apart: "contabilitate", a group, the last 4 digits'),
      kind: z.enum(["person", "group", "any"]).default("any"),
      tag: z.string().min(1).optional().describe("List everyone filed under this tag instead"),
      limit: z.number().int().min(1).max(50).optional().describe("Ambiguous: at most 5 per account; a tag list: up to 50"),
      include_context: z.boolean().default(true).describe("Recent messages and the user's style, when resolved in a write session"),
    },
    outputSchema: FIND_CONTACT_OUTPUT,
    write: false,
    handler: async (args, ctx) => runFindContact(args, ctx),
  }),
  // ---- end find_contact ----------------------------------------------------

  tool({
    name: "list_contacts",
    title: "List the phone's address book",
    description: `The phone's address book on one account, a page at a time: saved name, phone (E.164), chat_id, contact_id, and when the last direct message was and its direction. No message words; #private people left out. address_book_synced false: not arrived yet.`,
    schema: LIST_CONTACTS_INPUT,
    // No outputSchema: an integration calls it and reads structuredContent.error on a refusal (src/list-contacts.ts).
    write: false,
    handler: async (args, ctx) => runListContacts(args, ctx),
  }),

  tool({
    name: "get_group_info",
    title: "Get WhatsApp group info",
    description: `A group's name, description, owner and participants (up to 500), whether the account is admin, its settings (info_locked, member_add_mode, join_approval, disappearing_seconds), its community, and the invite link for an admin. Call it before manage_group.`,
    schema: { group_id: chatId.describe("<id>@g.us") },
    outputSchema: GROUP_INFO_OUTPUT,
    write: false,
    handler: async ({ group_id }, { wa }) => {
      const info = await wa.getGroupInfo(group_id);
      const text = [
        `# ${info.name} (${info.participant_count} participants)`,
        `- **chat_id**: \`${info.chat_id}\``,
        info.description ? `- **description**: ${info.description}` : null,
        info.owner ? `- **owner**: ${info.owner}` : null,
        info.created_at ? `- **created**: ${info.created_at}` : null,
        `- **admins only can post**: ${info.announcement_only} · **you are admin**: ${info.i_am_admin}`,
        `- **admins only can edit info**: ${info.info_locked} · **who can add members**: ${info.member_add_mode} · **join approval**: ${info.join_approval} · **disappearing messages**: ${disappearingLabel(info.disappearing_seconds)}`,
        info.community?.is_community ? "- **community**: this group is a community" : null,
        info.community?.parent_group_id ? `- **in community**: \`${info.community.parent_group_id}\`` : null,
        info.invite_link ? `- **invite link**: ${info.invite_link}` : null,
        "",
        "## Participants",
        ...info.participants.map(
          (p) =>
            `- ${p.name}${p.is_admin ? " (admin)" : ""}${looksUnnamed({ chat_id: p.contact_id, name: p.name }) ? " [unnamed]" : ""} — \`${p.contact_id}\``
        ),
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
      return ok(text, info as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "get_media",
    title: "Get the media of a WhatsApp message",
    description: `What a message's media holds: a voice note or audio as its transcript (kept once made; an API provider bills it), or with save_to its file; a photo attached as an image; any file saved at path on the machine running wazap. MEDIA_UNAVAILABLE: WhatsApp no longer has it.`,
    schema: {
      message_id: messageId,
      save_to: z.string().min(1).optional().describe("Absolute directory; default <data-dir>/media. A recording: its file, and no new transcript"),
      language: z.string().min(2).max(16).optional().describe('What is spoken, e.g. "ro"'),
      // The handler branches on whether it was given, like get_message.
      account_id: ACCOUNT_ID.optional(),
    },
    outputSchema: MEDIA_OUTPUT,
    write: false,
    handler: async ({ message_id, save_to, language, account_id }, { wa, hub, accountId }) => {
      const resolved = { id: accountId, wa };
      const found =
        account_id === undefined
          ? await resolveMessageIdAcross(hub, resolved, message_id)
          : { binding: resolved, sid: await resolveMessageId(wa, message_id) };
      const source = found.binding.wa;
      // The envelope's type, caption, filename and sender live on the message, not the file.
      const view = await getMessageView(source, found.sid).catch(() => undefined);
      const [identified] = view === undefined ? [] : await withSenderIdentity(source, [view]);
      const structured: Record<string, unknown> = {
        message_id,
        account_id: found.binding.id,
        type: view?.type ?? null,
        caption: view === undefined ? null : mediaCaptionOf(view),
        original_filename: view?.media?.filename ?? null,
        sender: identified?.sender ?? null,
      };
      const lines: string[] = [];
      const extra: ContentBlock[] = [];

      let transcribed = false;
      if (view?.type === "voice" || view?.type === "audio") {
        // save_to asks for the file: a transcript on hand comes along, and none is made. Without it, one is made,
        // and the bucket is spent only when a provider runs.
        const saving = save_to !== undefined;
        try {
          const result = await source.transcribeAudio(found.sid, language, saving ? { cachedOnly: true } : { limit: TRANSCRIBE_BUCKET });
          structured.transcript = result;
          transcribed = true;
          const clock = result.duration_seconds === undefined ? "" : ` ${clockLabel(result.duration_seconds)}`;
          const facts = [result.language, result.provider, result.cached ? "cached" : null].filter(Boolean).join(", ");
          lines.push(`Transcribed${clock} (${facts}): "${result.text}"`);
        } catch (err) {
          // No transcript (off, failing, timed out, over its rate, refused read-only): the file stands in for it.
          // A failure that is the message's own (gone, expired) comes back from the download below.
          if (!saving) {
            const reason = asWazapError(err);
            structured.transcript_unavailable = { code: reason.code, message: reason.message, ...(reason.fix ? { fix: reason.fix } : {}) };
            lines.push(`No transcript: ${reason.message}${reason.fix ? ` ${reason.fix}` : ""}`);
          }
        }
      }

      if (!transcribed || save_to !== undefined) {
        const media = await source.downloadMedia(found.sid, save_to);
        const { inline_base64, ...file } = media;
        Object.assign(structured, file);
        lines.push(`Saved ${media.mime} (${Math.round(media.size / 1024)} KB) to:\n${media.path}`);
        if (inline_base64) {
          extra.push({ type: "image", data: inline_base64, mimeType: media.mime });
          lines.push("(image attached inline)");
        } else if (view?.type === "image" || view?.type === "video") {
          // Too big to attach whole: a small JPEG still shows what it is.
          const [preview] = await source.previews([found.sid], 1).catch(() => []);
          if (preview !== undefined) {
            extra.push({ type: "image", data: preview.base64, mimeType: preview.mime });
            lines.push("(preview attached)");
          }
        }
      }
      if (extra.length > 0) structured.image_attached = true;
      return ok(lines.join("\n"), structured, extra);
    },
  }),

  tool({
    name: "send_message",
    title: "Draft a WhatsApp message",
    description: `Drafts text, media, polls, locations, forwards; sends nothing. Call it as soon as you have recipient and text: it returns draft_id and preview (recipient, number, exact text). Show that preview; confirm_send only on a yes to this text and recipient — a send in the same request is that yes.`,
    schema: {
      chat_id: chatId,
      text: z.string().max(65536).describe('The message, or the caption, poll question or place name; "" for a forward, a voice note or audio'),
      reply_to: messageId.optional(),
      mention_ids: z.array(z.string().min(1)).max(50).optional().describe("Chat ids to @-mention; write @<number> in text for each"),
      file_path: z.string().min(1).optional().describe("Media: absolute path on the machine running wazap"),
      url: z.string().url().optional().describe("Media: public http(s) URL"),
      as: z.enum(["document", "voice", "gif"]).optional().describe("Media: a plain document, a voice note, a looping GIF"),
      options: z.array(z.string().min(1).max(100)).min(2).max(12).optional().describe("Poll answers"),
      multi_select: z.boolean().optional().describe("Poll: several answers allowed"),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      address: z.string().max(500).optional().describe("Location: shown under the name"),
      forward: messageId.optional().describe("Forward this message; text \"\""),
    },
    write: true,
    handler: async (args, ctx) => draftAndGuard(sendPayload(args), ctx),
  }),
  tool({
    name: "edit_message",
    title: "Edit a WhatsApp message you sent",
    description: `Replace the text of a message the linked account sent. WhatsApp allows it for 15 minutes after sending; later, send a correction instead.`,
    schema: {
      message_id: messageId,
      text: z.string().min(1).max(65536),
    },
    outputSchema: EDIT_OUTPUT,
    write: true,
    handler: async ({ message_id, text }, { wa }) => {
      const sent = await wa.editMessage(message_id, text);
      return ok(`Edited ${message_id}:\n> ${sent.text}`, sent as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "react_to_message",
    title: "React to a WhatsApp message",
    description: `React to a message with one emoji, or pass "" to take your reaction off.`,
    schema: {
      message_id: messageId,
      emoji: z.string().max(8),
    },
    outputSchema: REACT_OUTPUT,
    write: true,
    handler: async ({ message_id, emoji }, { wa }) => {
      const result = await wa.reactToMessage(message_id, emoji);
      const text = emoji ? `Reacted ${emoji} to ${message_id}` : `Removed the reaction from ${message_id}`;
      return ok(text, result as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "confirm_send",
    title: "Send a drafted WhatsApp message",
    description: `Send a draft the user approved — this text, this recipient: the only call that sends, once per draft. A yes about something else: show the preview again and ask. Expired, missing or stale: draft again, show the new preview, ask again. SEND_OUTCOME_UNKNOWN: read_messages, never redo it unasked.`,
    schema: {
      draft_id: z.string().min(1).describe("From send_message"),
    },
    write: true,
    handler: async ({ draft_id }, { wa, hub, accountId, draftOwner }) => {
      const policy = liveSendPolicy(hub, accountId);
      const ref = draftTargetOf(draft_id);
      if (hasSendRules(policy)) {
        if (ref === undefined) {
          throw new WazapError(
            "SEND_BLOCKED",
            `The recipient of draft ${draft_id} is not on record, so the send rules of account "${accountId}" cannot be checked.`,
            "Draft the message again with send_message, then confirm_send"
          );
        }
        assertSendable(policy, ref.target, accountId);
      }
      noteConfirming(draft_id);
      const sent = await wa.confirm(draft_id, draftOwner);
      return ok(sentText(sent, ref?.target), sent as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "delete_message",
    title: "Delete a WhatsApp message",
    description: `Delete a message; confirm with the user first. for_everyone: true retracts it for everyone within 2 days: the account's own message, or anyone's in a group where it is admin. for_everyone: false removes any message from the linked account's devices only.`,
    schema: {
      message_id: messageId,
      for_everyone: z.boolean(),
    },
    outputSchema: DELETE_OUTPUT,
    write: true,
    handler: async ({ message_id, for_everyone }, { wa }) => {
      const result = await wa.deleteMessage(message_id, for_everyone);
      const scope = result.for_everyone ? "for everyone" : "for the linked account only";
      return ok(`Deleted ${message_id} ${scope}`, result as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "manage_chat",
    title: "Manage a WhatsApp chat",
    description: `Change a chat on WhatsApp at once, with no draft: archive, pin, mute, mark_read or mark_unread; pin_message (for everyone) or star_message on a message_id; clear or delete it for the linked account; block a person. Say what will change and wait for a yes.`,
    schema: {
      chat_id: chatId,
      action: z
        .enum([
          "archive",
          "unarchive",
          "pin",
          "unpin",
          "mute",
          "unmute",
          "mark_read",
          "mark_unread",
          "pin_message",
          "unpin_message",
          "star_message",
          "unstar_message",
          "clear",
          "delete",
          "block",
          "unblock",
        ]),
      mute_hours: z.number().int().min(1).max(720).optional().describe("mute: 8 by default"),
      message_id: messageId.optional().describe("pin_message, star_message and their undo; in chat_id"),
      pin_hours: z
        .union([z.literal(24), z.literal(168), z.literal(720)])
        .optional()
        .describe("pin_message: 168 by default"),
    },
    write: true,
    handler: async ({ chat_id, action, mute_hours, message_id, pin_hours }, { wa }) => {
      const result = await wa.manageChat(chat_id, action, {
        muteHours: mute_hours,
        messageId: message_id,
        pinHours: pin_hours,
      });
      return ok(result.applied, result as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "manage_group",
    title: "Manage a WhatsApp group",
    description: `Create a group, join one from an invite (preview first, then confirm: true), or administer one: members, name, description, photo, invite link, join requests, settings, leave. Most actions need admin. Every change shows to all members at once: say what will change, wait for a yes.`,
    schema: {
      action: z.enum([
        "create",
        "join",
        "add",
        "remove",
        "promote",
        "demote",
        "leave",
        "set_subject",
        "set_description",
        "set_picture",
        "remove_picture",
        "get_invite_link",
        "revoke_invite_link",
        "list_join_requests",
        "approve_join_requests",
        "reject_join_requests",
        "set_announcement_only",
        "set_info_locked",
        "set_add_mode",
        "set_join_approval",
        "set_disappearing",
      ]),
      group_id: chatId.optional().describe('"<id>@g.us"; every action but create and join'),
      participant_ids: z.array(z.string().min(1)).max(256).optional().describe("create, add, remove, promote, demote, approve or reject"),
      value: z
        .string()
        .max(2048)
        .optional()
        .describe('The name (create, set_subject) or description; "on"/"off"; set_add_mode "admins"/"all"; set_disappearing "off"/"24h"/"7d"/"90d"'),
      file_path: z.string().min(1).optional().describe("set_picture: local JPEG, PNG or WebP"),
      url: z.string().url().optional().describe("set_picture: public image URL"),
      invite: z.string().min(1).max(512).optional().describe("join: a chat.whatsapp.com link or its code"),
      message_id: messageId.optional().describe('join: an invite message instead'),
      confirm: z.boolean().default(false).describe("join: true joins, after the user said yes to the preview"),
    },
    outputSchema: MANAGE_GROUP_OUTPUT,
    write: true,
    handler: async ({ action, group_id, participant_ids, value, file_path, url, invite, message_id, confirm }, { wa }) => {
      if (action === "create") {
        const name = value?.trim() ?? "";
        if (name === "" || participant_ids === undefined || participant_ids.length === 0) {
          throw new WazapError("INVALID_ID", "create needs the group's name in value and at least one participant.", 'manage_group({ action: "create", value: "Bloc 12", participant_ids: ["+40722…"] })');
        }
        if (name.length > 100) throw new WazapError("TEXT_TOO_LONG", "A group name holds at most 100 characters.", "Shorten the name");
        const result = await wa.createGroup(name, participant_ids);
        const text = [`Group "${name}" created: ${result.chat_id}`, ...renderParticipants(result.participants)].join("\n");
        return ok(text, { action, group_id: result.chat_id, name, applied: `created "${name}"`, participants: result.participants });
      }
      if (action === "join") {
        const result = await wa.joinGroup({ invite, messageId: message_id, confirm: confirm === true });
        return ok(renderJoin(result), { action, ...result, ...(result.status === "preview" ? { next: JOIN_NEXT } : {}) });
      }
      if (group_id === undefined) {
        throw new WazapError("INVALID_ID", `${action} needs group_id.`, 'Pass the group\'s chat id ("<id>@g.us"), from list_chats or find_contact');
      }
      const result = await wa.manageGroup(group_id, action, participant_ids, value, { file_path, url });
      const text = [
        result.applied,
        ...renderParticipants(result.participants ?? []),
        ...renderJoinRequests(result.join_requests ?? []),
      ].join("\n");
      return ok(text, result as unknown as Record<string, unknown>);
    },
  }),
];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

export const registerTools = createToolRegistrar(TOOLS);

function renderChats(chats: ChatSummary[], filter: string): string {
  if (chats.length === 0) return `No chats found (filter: ${filter}).`;
  const lines = [`# WhatsApp chats — ${filter} (${chats.length})`, ""];
  for (const c of chats) {
    const flags = [
      c.type === "group" ? "group" : null,
      c.unread_count > 0 ? `${c.unread_count} unread` : null,
      c.pinned ? "pinned" : null,
      c.muted_until ? "muted" : null,
      c.archived ? "archived" : null,
      c.left ? "left" : null,
    ].filter(Boolean);
    lines.push(`## ${c.name}${flags.length ? ` [${flags.join(", ")}]` : ""}${c.note ? ` · ${c.note}` : ""}`);
    lines.push(`- **chat_id**: \`${c.chat_id}\``);
    if (c.last_message) {
      lines.push(
        `- **last**: ${c.last_message.from_me ? "me: " : ""}${truncate(c.last_message.text, 160)} (${c.last_message.timestamp})`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** What read_messages takes for the stories: "status", or WhatsApp's own id for them. */
function isStatusChat(chatId: string): boolean {
  const id = chatId.trim().toLowerCase();
  return id === "status" || id === "status@broadcast";
}

/** A date or an ISO timestamp as epoch ms; a bare date for `until` means the end of that day. */
function parseMoment(value: string | undefined, field: string, endOfDay = false): number | undefined {
  if (value === undefined) return undefined;
  const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  const ms = Date.parse(bareDate ? `${value.trim()}T${endOfDay ? "23:59:59.999" : "00:00:00"}` : value);
  if (Number.isNaN(ms)) {
    throw new WazapError(
      "INVALID_ID",
      `${field} is not a date: "${value}".`,
      'Pass "2026-09-01" or an ISO timestamp like "2026-09-01T14:00:00+03:00"'
    );
  }
  return ms;
}

function newestFirst(messages: MessageView[]): string[] {
  return [...messages].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).map((m) => m.message_id);
}

/** message_id → "preview 3", numbered the way the image blocks are attached. */
function previewLabels(previews: Preview[]): Map<string, string> {
  return new Map(previews.map((p, i) => [p.message_id, `preview ${i + 1}`]));
}

function previewBlocks(previews: Preview[]): ContentBlock[] {
  return previews.map((p) => ({ type: "image", data: p.base64, mimeType: p.mime }));
}

/** The line under the title that says what was attached and what could not be. */
function previewNote(messages: MessageView[], previews: Preview[], asked: boolean): string | null {
  if (!asked) return null;
  const photos = messages.filter((m) => m.type === "image").length;
  const missing = photos - previews.length;
  const parts = [
    previews.length > 0
      ? `${previews.length} preview${previews.length === 1 ? "" : "s"} attached, numbered in the order of the image blocks`
      : null,
    missing > 0
      ? `${missing} photo${missing === 1 ? "" : "s"} without a preview (over the ${MAX_PREVIEWS} per call, expired, not JPEG, or out of time; call again for more)`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `${parts.join("; ")}.` : null;
}

/** A page past the local history that the phone, asked for it, sent nothing for. */
const OLDER_NONE_NOTE = "The phone was asked for older messages and sent none: older history may still exist there. Say so; do not say there are none.";

/** A send handed to WhatsApp that has not echoed: unknown, which a read that does not show it yet cannot turn into failed. */
function unconfirmedNote(send: UnconfirmedSend): string {
  return `A message handed to WhatsApp at ${send.handed_at.slice(11, 16)} has not echoed yet: its outcome is unknown, not failed.`;
}

/** The photos an asked-for preview could not be made for, as a note; null when none is missing. */
function previewGap(messages: MessageView[], previews: Preview[], asked: boolean): string | null {
  if (!asked) return null;
  const missing = messages.filter((m) => m.type === "image").length - previews.length;
  if (missing <= 0) return null;
  return `${missing} photo${missing === 1 ? "" : "s"} without a preview (over ${MAX_PREVIEWS} per call, expired, not JPEG, or out of time): call again for more.`;
}

/** The sender's name, with the user's note on them the first time they appear in this rendering. */
function senderLabel(m: AnyMessage, introduced: Set<string>): string {
  if (m.from_me) return "me";
  if (!m.sender.note || introduced.has(m.sender.id)) return m.sender.name;
  introduced.add(m.sender.id);
  return `${m.sender.name} · ${m.sender.note}`;
}

const JOIN_NEXT = 'Show this to the user; after their yes, call manage_group again with action "join", the same invite or message_id and confirm: true.';

/** A manage_group join answer: the preview and the step after it, or where the join landed. */
function renderJoin(r: JoinGroupResult): string {
  const name = r.name ? `"${r.name}"` : "the group";
  if (r.status === "joined") return `Joined ${name}${r.group_id ? `: \`${r.group_id}\`` : ""}.`;
  if (r.status === "pending_approval") {
    return `Asked to join ${name}. An admin of the group must approve the request before the account is in.`;
  }
  const facts = [
    r.participant_count === null ? null : `${r.participant_count} members`,
    r.join_approval === null ? null : r.join_approval ? "an admin must approve new members" : "no approval needed",
  ].filter(Boolean);
  return [
    `Group invite: ${name}${facts.length ? ` (${facts.join(", ")})` : ""}. Not joined.`,
    r.description ? `Description: ${r.description}` : null,
    r.group_id ? `group_id: \`${r.group_id}\`` : null,
    "",
    'Show this to the user. After they say yes, call manage_group again with action "join", the same invite or message_id and confirm: true.',
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** A rendered message, with or without the resolved sender identity fields. */
type AnyMessage = MessageView | IdentifiedMessage;

/** "❤️×2 😍": each emoji once, in the order it first came, counted when more than one person chose it. */
function reactionTag(reactions: ReadonlyArray<{ emoji: string }>): string {
  const counts = new Map<string, number>();
  for (const { emoji } of reactions) counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
  return [...counts].map(([emoji, n]) => (n > 1 ? `${emoji}×${n}` : emoji)).join(" ");
}

/** Who left which reaction, for the one message get_message renders: "reactions: ❤️ Medeea, 😍 Lory". */
function reactionLine(m: AnyMessage): string | null {
  if (!m.reactions?.length) return null;
  return `  reactions: ${m.reactions.map((r) => `${r.emoji} ${r.name}`).join(", ")}`;
}

/** "3 votes" on a poll, "2 going · 1 maybe" on an event: how many, and who only in get_message. */
function voteTag(m: AnyMessage): string | null {
  if (m.poll) return m.poll.voters > 0 ? `${m.poll.voters} vote${m.poll.voters === 1 ? "" : "s"}` : null;
  if (!m.event_responses) return null;
  const { going, maybe, not_going } = m.event_responses;
  const counts: Array<[number, string]> = [
    [going.length, "going"],
    [maybe.length, "maybe"],
    [not_going.length, "not going"],
  ];
  const parts = counts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Who chose what, for the one message get_message renders: "Da (2): Ana, Dan" per option, "going: Ana · maybe: Dan" for an event. */
function voteLines(m: AnyMessage): string | null {
  const names = (voters: ReadonlyArray<{ name: string }>): string => voters.map((v) => v.name).join(", ");
  if (m.poll) {
    const lines = m.poll.options.map(
      (option) => `  ${option.name} (${option.votes})${option.voters.length > 0 ? `: ${names(option.voters)}` : ""}`
    );
    return lines.length > 0 ? lines.join("\n") : null;
  }
  if (!m.event_responses) return null;
  const { going, maybe, not_going } = m.event_responses;
  const groups: Array<[string, ReadonlyArray<{ name: string }>]> = [
    ["going", going],
    ["maybe", maybe],
    ["not going", not_going],
  ];
  const parts = groups.filter(([, voters]) => voters.length > 0).map(([label, voters]) => `${label}: ${names(voters)}`);
  return parts.length > 0 ? `  ${parts.join(" · ")}` : null;
}

/** "read", "delivered", "sent" on the user's own messages; "read by 3" in a group once members did. */
function deliveryTag(m: AnyMessage): string | null {
  if (!m.delivery) return null;
  const readers = m.delivery.read_by?.length ?? 0;
  return readers > 0 ? `read by ${readers}` : m.delivery.status;
}

/** Who has it, for the one message get_message renders: "read by: Ana (14:02), Dan (14:05)". */
function deliveryLines(m: AnyMessage): string | null {
  const who = (label: string, receivers?: ReadonlyArray<{ name: string; at: string }>): string | null =>
    receivers?.length ? `  ${label}: ${receivers.map((r) => `${r.name} (${r.at.slice(11, 16)})`).join(", ")}` : null;
  const lines = [who("read by", m.delivery?.read_by), who("delivered to", m.delivery?.delivered_to)].filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : null;
}

function renderMessages(
  title: string,
  messages: ReadonlyArray<AnyMessage>,
  labels: Map<string, string> = new Map(),
  note: string | null = null
): string {
  if (messages.length === 0) return `${title}: no messages found.${note ? ` ${note}` : ""}`;
  const lines = [`# ${title} (${messages.length})`, ""];
  if (note) lines.splice(1, 0, note);
  const introduced = new Set<string>();
  for (const m of messages) {
    const tags = [
      labels.get(m.message_id) ?? null,
      m.type !== "text" ? m.type : null,
      m.forwarded ? "forwarded" : null,
      m.edited ? "edited" : null,
      m.quoted ? "reply" : null,
      m.reactions?.length ? reactionTag(m.reactions) : null,
      m.mentions?.length ? `mentions ${m.mentions.map((person) => person.name).join(", ")}` : null,
      voteTag(m),
      deliveryTag(m),
    ].filter(Boolean);
    lines.push(
      `- **${senderLabel(m, introduced)}** · ${m.age}${tags.length ? ` [${tags.join(", ")}]` : ""} · id: \`${m.message_id}\``
    );
    if (m.quoted) lines.push(`  > ${truncate(m.quoted.text, 160)}`);
    lines.push(`  ${truncate(m.text, 500)}`);
  }
  return lines.join("\n");
}

/**
 * Under ~0.55 cosine, embeddinggemma matches are usually coincidental — the
 * agent must not present them as found facts. A hit whose words matched is
 * not a guess, whatever its similarity.
 */
function weakMatches(hits: ReadonlyArray<{ matched?: string; similarity?: number | null }>): boolean {
  if (hits.length === 0) return false;
  const best = Math.max(0, ...hits.map((h) => h.similarity ?? 0));
  return hits.every((h) => h.matched === "meaning") && best < 0.55;
}

const WEAK_NOTE = "Weak matches only: the query may have no real answer; treat these as guesses, not facts.";

/**
 * Ranked hits with the date always on the line and the score that ordered
 * them. "index only" warns that wazap holds the message only as text, so
 * get_media has nothing to open.
 */
function renderRecall(title: string, answer: RecallAnswer | IdentifiedRecallAnswer): string {
  const { hits, index } = answer;
  const catchingUp =
    index.state === "indexing"
      ? `The index is still catching up: ${index.indexed} indexed, ${index.pending} pending — more matches may appear.`
      : null;
  if (hits.length === 0) {
    return `${title}: no messages found.${catchingUp ? ` ${catchingUp}` : ""}`;
  }
  const lines = [`# ${title} (${hits.length})`, ""];
  if (weakMatches(hits)) {
    const best = Math.max(0, ...hits.map((h) => h.similarity ?? 0));
    lines.push(
      `Weak matches only (best similarity ${best.toFixed(2)}): the query may have no real answer — treat these as guesses.`,
      ""
    );
  }
  if (catchingUp) lines.push(catchingUp, "");
  const introduced = new Set<string>();
  for (const hit of hits) {
    const m = hit.message;
    const tags = [
      `score ${hit.score.toFixed(3)}`,
      hit.matched === "both" ? "words + meaning" : hit.matched,
      hit.from_index ? "index only" : null,
      m.type !== "text" ? m.type : null,
      m.quoted ? "reply" : null,
      m.edited ? "edited" : null,
    ].filter(Boolean);
    lines.push(
      `- [${m.timestamp}] **${senderLabel(m, introduced)}** · \`${m.chat_id}\` [${tags.join(", ")}] · id: \`${m.message_id}\``
    );
    if (m.quoted) lines.push(`  > ${truncate(m.quoted.text, 160)}`);
    lines.push(`  ${truncate(m.text, 500)}`);
  }
  return lines.join("\n");
}

function renderStories(
  stories: MessageView[],
  hours: number,
  labels: Map<string, string>,
  note: string | null
): string {
  if (stories.length === 0) return `No stories in the last ${hours}h.`;
  const lines = [`# Stories · last ${hours}h (${stories.length})`, ""];
  if (note) lines.splice(1, 0, note);
  let author = "";
  for (const m of stories) {
    if (m.sender.id !== author) {
      author = m.sender.id;
      lines.push(`## ${m.sender.name} — \`${m.sender.id}\``);
    }
    const label = labels.get(m.message_id);
    lines.push(`- ${m.age} · ${truncate(m.text, 300)}${label ? ` (${label})` : ""} · id: \`${m.message_id}\``);
  }
  return lines.join("\n");
}

function renderWait(result: WaitResult): string {
  const tail = [
    `cursor: \`${result.cursor}\``,
    result.cursor_reset ? "The cursor was from another run; this wait started from now." : null,
  ]
    .filter(Boolean)
    .join("\n");
  if (result.messages.length === 0) return `Nothing arrived before the timeout.\n${tail}`;
  const lines = [`# ${result.messages.length} new message${result.messages.length === 1 ? "" : "s"}`, ""];
  let chat = "";
  const introduced = new Set<string>();
  for (const m of result.messages) {
    if (m.chat_id !== chat) {
      chat = m.chat_id;
      lines.push(`## \`${chat}\``);
    }
    lines.push(`- [${m.timestamp}] ${senderLabel(m, introduced)}: ${truncate(m.text, 500)} · id: \`${m.message_id}\``);
  }
  lines.push("", tail);
  return lines.join("\n");
}

/** The card a contact mutation answers with: who it is plus the local filing. */
function renderContactCard(c: ContactSummary): string {
  const lines = [
    `# ${c.name}`,
    `- **contact_id**: \`${c.contact_id}\``,
    c.number ? `- **number**: ${c.number}` : null,
    c.note ? `- **note**: ${c.note}` : null,
    c.tags?.length ? `- **tags**: ${c.tags.map((t) => `#${t}`).join(" ")}` : null,
    ...Object.entries(c.fields ?? {}).map(([key, value]) => `- **${key}**: ${value}`),
    `- **saved**: ${c.is_my_contact} · **business**: ${c.is_business}`,
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

function renderParticipants(participants: Array<{ id: string; status: string; reason?: string }>): string[] {
  return participants.map((p) => `- ${p.id}: ${p.status}${p.reason ? ` (${p.reason})` : ""}`);
}

function renderJoinRequests(requests: JoinRequest[]): string[] {
  return requests.map((r) => {
    const details = [r.requested_at ? `asked ${r.requested_at}` : null, r.method ? `via ${r.method}` : null]
      .filter((part): part is string => part !== null)
      .join(", ");
    return `- ${r.name} — \`${r.id}\`${details ? ` (${details})` : ""}`;
  });
}

/** 86400 reads as "24h" and 604800 as "7d", the way manage_group set_disappearing takes them. */
function disappearingLabel(seconds: number): string {
  if (!seconds) return "off";
  if (seconds % 86_400 !== 0) return `${seconds}s`;
  const days = seconds / 86_400;
  return days === 1 ? "24h" : `${days}d`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The step after a draft, in the structured content a client may hand the model
 * instead of the text — including what the yes has to be a yes to, since "only
 * after their yes" left both halves open: a yes about another subject was taken
 * as approval, and a send asked in the same words that dictated the text was
 * asked about a second time and never sent.
 */
const DRAFT_NEXT =
  "Show this preview to the user exactly. Call confirm_send with draft_id only when their words approve this text and this recipient: a send asked in the same request that gave the text is that approval, so send, do not ask again. A yes about something else, or one that comes after the talk moved on, is not: show this preview again and ask.";

/**
 * A draft in the wrong language is redone before it is shown: the gate's third
 * run put a Romanian message in front of an English speaker and asked to send
 * it. The warning still blocks nothing — the draft stands, and every other
 * warning leaves the step after a draft as it is. The language to write in is
 * style_check.basis.language whether basis.from is the user or, in a chat the
 * user has hardly written in, the recipient.
 */
const DRAFT_NEXT_LANGUAGE =
  "Draft again before showing anything: this text is not in the language this chat is written in (style_check.basis.language, from whoever basis.from says). Call send_message with the same message in that language, then show the preview it returns and follow its next.";

function drafted(view: DraftView): ToolResult {
  const warnings = view.style_check?.warnings ?? [];
  return ok(renderDraft(view), {
    ...view,
    next: warnings.includes("language_mismatch") ? DRAFT_NEXT_LANGUAGE : DRAFT_NEXT,
    ...notesField([
      view.unnamed_recipient === true ? "The recipient is not a saved contact: say the name shown is only their public WhatsApp name or their number." : null,
      warnings.some((warning) => warning !== "length_outlier")
        ? "Unless the user dictated these words, draft again to match style_check.warnings, then show that preview."
        : null,
      warnings.includes("length_outlier") ? "length_outlier: shorten only if nothing the user asked for is lost." : null,
    ]),
  });
}

/**
 * The account's send rules, read fresh from accounts.json: a rule written
 * while a draft waits must still fire when confirm_send comes, so the record
 * is re-read rather than trusted from registry memory.
 */
function liveSendPolicy(hub: AccountSource, accountId: string): SendPolicy {
  const record = hub.recordOnDisk(accountId);
  if (!record || !record.enabled) throw new WazapError("SEND_BLOCKED", "The account send policy is unavailable.",
    "Restore the account policy before sending; do not fall back to cached rules");
  return sendPolicyOf(record);
}

/**
 * is_my_contact is the only name with the address book behind it: a pushname
 * or a chat title is self-published, so a recipient known only that way is
 * flagged for the agent. The lookup is local; if it cannot run, the flag the
 * name's own shape set stands.
 */
async function flagUnnamed(view: DraftView, wa: WhatsAppApi): Promise<void> {
  const to = view.to;
  if (view.unnamed_recipient === true || to.chat_id.endsWith("@g.us")) return;
  if (typeof wa.searchContacts !== "function") return;
  try {
    if (typeof wa.getStatus === "function" && to.number !== undefined) {
      const own = wa.getStatus().account?.number;
      if (own !== undefined && own === to.number) return;
    }
    const hits = await wa.searchContacts(to.number ?? to.chat_id, 10);
    const hit = hits.find((c) => c.contact_id === to.chat_id || (to.number !== undefined && c.number === to.number));
    if (hit === undefined || !hit.is_my_contact) view.unnamed_recipient = true;
  } catch {
    /* the shape-based answer stands */
  }
}

interface SendArgs {
  chat_id: string;
  text: string;
  reply_to?: string;
  mention_ids?: string[];
  file_path?: string;
  url?: string;
  as?: "document" | "voice" | "gif";
  options?: string[];
  multi_select?: boolean;
  latitude?: number;
  longitude?: number;
  address?: string;
  forward?: string;
}

/**
 * What send_message drafts, from the arguments it was given: a text, or the
 * one other kind its arguments name. An argument that belongs to another kind
 * is refused, never dropped, so the preview is what the caller meant.
 */
function sendPayload(args: SendArgs): DraftPayload {
  const refuse = (message: string, fix: string): never => {
    throw new WazapError("INVALID_ID", message, fix);
  };
  const kinds = [
    args.file_path !== undefined || args.url !== undefined ? "media (file_path or url)" : null,
    args.options !== undefined ? "a poll (options)" : null,
    args.latitude !== undefined || args.longitude !== undefined ? "a location (latitude, longitude)" : null,
    args.forward !== undefined ? "a forward (forward)" : null,
  ].filter((kind): kind is string => kind !== null);
  if (kinds.length > 1) refuse(`One draft is one message; this names ${kinds.join(" and ")}.`, "Draft each with its own send_message");
  const stray = (names: Array<[keyof SendArgs, string]>): void => {
    const given = names.filter(([key]) => args[key] !== undefined).map(([, what]) => what);
    if (given.length > 0) refuse(`${given.join(", ")} ${given.length === 1 ? "does" : "do"} not apply to this draft.`, "Leave them out, or draft the kind they belong to");
  };
  const media = args.file_path !== undefined || args.url !== undefined;
  const poll = args.options !== undefined;
  const location = args.latitude !== undefined || args.longitude !== undefined;
  if (!media) stray([["as", "as"]]);
  if (!poll) stray([["multi_select", "multi_select"]]);
  if (!location) stray([["address", "address"]]);
  if (media || poll || location || args.forward !== undefined) stray([["reply_to", "reply_to"], ["mention_ids", "mention_ids"]]);
  const chatId = args.chat_id;
  if (media) {
    if (args.text.length > 1024) throw new WazapError("TEXT_TOO_LONG", "A caption holds at most 1024 characters.", "Shorten the caption, or send the rest as a text");
    const source = { file_path: args.file_path, url: args.url };
    const as = { asDocument: args.as === "document", asVoice: args.as === "voice", asGif: args.as === "gif" };
    // A caption WhatsApp would not show is refused, not dropped: the user would approve words nobody receives.
    if (args.text !== "" && !captionTravels(mimeOfSource(source), as)) {
      refuse(
        `text does not apply to ${as.asVoice ? "a voice note" : "an audio file"}: WhatsApp shows no caption on it.`,
        "A voice note or audio file carries no caption; send the words as their own send_message"
      );
    }
    return { kind: "media", chatId, source, ...(args.text === "" ? {} : { caption: args.text }), ...as };
  }
  if (poll) {
    if (args.text.trim() === "") refuse("A poll needs its question in text.", 'send_message({ chat_id, text: "Pizza?", options: ["da", "nu"] })');
    if (args.text.length > 255) throw new WazapError("TEXT_TOO_LONG", "A poll question holds at most 255 characters.", "Shorten the question");
    return { kind: "poll", chatId, question: args.text, options: args.options!, multiSelect: args.multi_select === true };
  }
  if (location) {
    if (args.latitude === undefined || args.longitude === undefined) refuse("A location needs both latitude and longitude.", "Pass both, in decimal degrees");
    if (args.text.length > 255) throw new WazapError("TEXT_TOO_LONG", "A place name holds at most 255 characters.", "Shorten the name, or put the rest in address");
    return {
      kind: "location",
      chatId,
      latitude: args.latitude!,
      longitude: args.longitude!,
      ...(args.text === "" ? {} : { name: args.text }),
      ...(args.address === undefined ? {} : { address: args.address }),
    };
  }
  if (args.forward !== undefined) {
    if (args.text !== "") refuse("A forward goes as it was; it cannot carry text.", 'Pass text: "" to forward, and send the comment as its own send_message');
    return { kind: "forward", chatId, messageId: args.forward };
  }
  if (args.text === "") refuse("The message is empty.", "Pass the words to send in text");
  return { kind: "text", chatId, text: args.text, replyTo: args.reply_to, mentionIds: args.mention_ids };
}

/**
 * Every outbound draft passes here: the account's send rules are checked on
 * the id as typed and again on the resolved recipient, and the draft's target
 * is recorded so confirm_send can re-check rules written after the draft.
 */
async function draftAndGuard(payload: DraftPayload, ctx: ToolCtx): Promise<ToolResult> {
  const policy = liveSendPolicy(ctx.hub, ctx.accountId);
  // A bare @lid may still resolve to an allowed phone inside the service; only
  // the deny list can fire on it before that resolution.
  const pre = payload.chatId.trim().endsWith("@lid") ? { allow: null, deny: policy.deny } : policy;
  assertSendable(pre, { chat_id: payload.chatId }, ctx.accountId);
  const view = await ctx.wa.draft(payload, ctx.draftOwner);
  assertSendable(policy, view.to, ctx.accountId);
  noteDraftTarget(view, ctx.accountId, ctx.draftOwner);
  await flagUnnamed(view, ctx.wa);
  if (payload.kind === "text") await checkStyle(view, payload.text, ctx);
  return drafted(view);
}

/**
 * send_message's style_check (F2-3): additive, and a failure only leaves it
 * out. An account that turned the draft context off gets no style statistics
 * here either. Where the check reads the recipient — a chat the user has
 * hardly written in, whose language only they can give — it takes the
 * `#private` rule of the call, across every linked account, like every read.
 */
async function checkStyle(view: DraftView, text: string, { wa, hub, accountId }: ToolCtx): Promise<void> {
  if (typeof wa.styleCheck !== "function") return;
  try {
    const record = hub.recordOnDisk(accountId);
    if (record === undefined || !draftContextEnabled(record)) return;
    const check = wa.styleCheck(view.to.chat_id, text, { private: await privateRule(hub, accountId) });
    if (check !== null) view.style_check = check;
  } catch {
    /* the draft stands without it */
  }
}

function sentText(sent: SentMessage, to?: OutgoingTarget): string {
  const who = to === undefined ? sent.chat_id : describeTarget(to);
  if (sent.already_sent === true) {
    return `Already sent to ${who} at ${sent.timestamp} (message_id: ${sent.message_id}); nothing was sent again:\n> ${sent.text}`;
  }
  return `Sent to ${who} at ${sent.timestamp} (message_id: ${sent.message_id}):\n> ${sent.text}`;
}
