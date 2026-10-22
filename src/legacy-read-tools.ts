/** Compatibility for remote connectors whose cached catalogue predates 1.0. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assessSearch, parseMoment } from "./search-query.js";
import { checkSearchSource, finalizeSearch, searchOwner, SEARCH_CHANGED } from "./search-finalize.js";
import { resolveToolAccount } from "./account-resolve.js";
import { resolveMessageId, resolveMessageIdAcross } from "./message-ref.js";
import { privateRule } from "./catchup.js";
import { compactRecent } from "./recent-compact.js";
import { WazapError } from "./errors.js";
import { MESSAGE_TYPES, type MessageView, type RecentConversation, type RecentMessageRefs, type SearchContext, type WhatsAppApi } from "./wa-types.js";
import type { ToolArgs, ToolCtx, ToolDef, ToolResult } from "./tool-runtime.js";

const account = {
  account_id: z.string().min(1).optional().describe("Account id"),
  account_ids: z.array(z.string().min(1)).min(1).max(50).optional(),
  all_accounts: z.boolean().optional(),
};
const readHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const TTL = 15 * 60_000;
type RecentRow = Omit<RecentConversation, "messages"> & { account_id: string; messages: RecentConversation["messages"] };
type Snapshot = { owner: string; expires: number; sync: string; hours: number; filter: "all" | "unread" | "groups" | "individual"; compact: boolean; accounts: string[]; includeSystem: boolean; types?: typeof MESSAGE_TYPES[number][];
  sources: Map<string, { instance: symbol; owner: string | null }>;
  refs: Array<RecentMessageRefs & { account_id: string }> };
const pages = new Map<string, Snapshot>();
const sourceIds = new WeakMap<WhatsAppApi, symbol>();

function sourceStamp(wa: WhatsAppApi) {
  let instance = sourceIds.get(wa);
  if (instance === undefined) { instance = Symbol(); sourceIds.set(wa, instance); }
  return { instance, owner: wa.getStatus().account?.id ?? null };
}

function result(payload: Record<string, unknown>, images: ToolResult["content"] = []): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }, ...images], structuredContent: payload };
}

function selected(args: ToolArgs, ctx: ToolCtx) {
  if (args.account_id !== undefined && (args.account_ids !== undefined || args.all_accounts === true)) {
    throw new WazapError("INVALID_ID", "Choose account_id or account_ids/all_accounts, not both.");
  }
  const ids = args.account_ids as string[] | undefined;
  return ids !== undefined
    ? [...new Set(ids)].map((id) => resolveToolAccount(ctx.hub, { account_id: id }, { name: "get_status", write: false }))
    : args.all_accounts === true ? ctx.hub.bindings() : [{ id: ctx.accountId, wa: ctx.wa }];
}

/** Return a message-bounded page; cursors are snapshots, not offsets into a moving inbox. */
async function recent(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const owner = `${ctx.client}:${ctx.accountId}`;
  for (const [key, page] of pages) if (page.expires <= Date.now()) pages.delete(key);
  let page: Snapshot;
  if (args.cursor !== undefined) {
    const saved = pages.get(args.cursor as string);
    if (!saved || saved.owner !== owner) throw new WazapError("CURSOR_EXPIRED", "This recent-message page expired.", "Start again without cursor");
    page = { ...saved, sync: "done" };
  } else {
    const refs: Snapshot["refs"] = [];
    let sync = "done";
    const bindings = selected(args, ctx);
    const sources = new Map(bindings.map((binding) => [binding.id, sourceStamp(binding.wa)]));
    for (const binding of bindings) {
      const found = await binding.wa.recentMessageRefs({ hours: args.hours as number, filter: args.filter as "all", includeSystem: args.include_system as boolean,
        types: args.types as typeof MESSAGE_TYPES[number][] | undefined });
      if (found.sync !== "done") sync = found.sync;
      refs.push(...found.data.map((ref) => ({ ...ref, account_id: binding.id })));
    }
    refs.sort((a, b) => b.last_activity.localeCompare(a.last_activity));
    page = { owner, expires: Date.now() + TTL, refs, sources, sync, hours: args.hours as number, filter: args.filter as "all", compact: args.compact === true, accounts: bindings.map((b) => b.id), includeSystem: args.include_system as boolean, types: args.types as typeof MESSAGE_TYPES[number][] | undefined };
  }
  let remaining = args.limit as number;
  const conversations: RecentRow[] = [];
  const rest: Snapshot["refs"] = [];
  const checkSources = () => {
    const bindings = new Map(page.accounts.map((id) => [id, resolveToolAccount(ctx.hub, { account_id: id }, { name: "get_status", write: false })]));
    for (const { id, wa } of bindings.values()) {
      const expected = page.sources.get(id)!, current = sourceStamp(wa);
      if (expected.instance !== current.instance || expected.owner !== current.owner) {
        throw new WazapError("CURSOR_EXPIRED", "The account behind this recent-message page changed.", "Start again without cursor");
      }
      const sync = wa.getStatus().sync;
      if (sync !== "done") page.sync = sync;
    }
    return bindings;
  };
  const bindings = checkSources();
  const privacy = new Map<string, Awaited<ReturnType<typeof privateRule>>>();
  for (const ref of page.refs) {
    if (remaining === 0) { rest.push(ref); continue; }
    const binding = bindings.get(ref.account_id)!;
    if (!privacy.has(binding.id)) privacy.set(binding.id, await privateRule(ctx.hub, binding.id));
    const found = await binding.wa.readRecentMessages(ref, remaining, { hours: page.hours, filter: page.filter, includeSystem: page.includeSystem,
      types: page.types, private: privacy.get(binding.id) });
    if (found.sync !== "done") page.sync = found.sync;
    const row = found.data.conversation;
    if (row !== null) {
      conversations.push({ ...row, account_id: binding.id });
      remaining -= row.messages.length;
    }
    if (found.data.remaining !== null) rest.push({ ...found.data.remaining, account_id: binding.id });
  }
  let next: string | null = null;
  if (rest.length) {
    if (pages.size >= 16) pages.delete(pages.keys().next().value!);
    next = randomUUID();
    pages.set(next, { ...page, refs: rest });
  }
  const images: ToolResult["content"] = [];
  if (args.include_previews === true) {
    for (const id of page.accounts) {
      const wa = resolveToolAccount(ctx.hub, { account_id: id }, { name: "get_status", write: false }).wa;
      const ids = conversations.filter((row) => row.account_id === id).flatMap((row) => row.messages.filter((m) => !m.private).map((m) => m.message_id));
      for (const preview of await wa.previews(ids, Math.max(0, 12 - images.length))) images.push({ type: "image", data: preview.base64, mimeType: preview.mime });
    }
  }
  // Re-link or roster replacement may happen while a read or preview awaits.
  checkSources();
  // Compact must reach structured-only clients too. The cursor still budgets original messages.
  const rendered = page.compact ? conversations.map((row) => ({ ...row, ...compactRecent(row.messages) })) : conversations;
  const payload = { hours: page.hours, filter: page.filter, conversation_count: conversations.length,
    message_count: conversations.reduce((n, row) => n + row.messages.length, 0), conversations: rendered,
    ...(page.compact ? { compact: true, shown_message_count: rendered.reduce((n, row) => n + ("shown_message_count" in row ? row.shown_message_count as number : 0), 0),
      line_count: rendered.reduce((n, row) => n + row.messages.length, 0) } : {}),
    next_cursor: next, partial: next !== null || page.sync !== "done", sync: page.sync,
    account_id: page.accounts.length === 1 ? page.accounts[0] : null,
    notes: ["Available synced history only; an unanswered request may have been handled outside WhatsApp."] };
  const answer = result(payload, images);
  if (page.compact) answer.content[0] = { type: "text", text: rendered.map((row) => {
    const omitted = "omitted" in row ? Object.entries(row.omitted as Record<string, number>).map(([type, count]) => `${count} ${type}`) : [];
    return `${row.chat_name}:\n${[...row.messages.map((m) => `${m.from_me ? "me" : m.sender.name}: ${m.text}`),
      ...(omitted.length ? [`[omitted: ${omitted.join(", ")}]`] : [])].join("\n")}`;
  }).join("\n\n") || "No recent messages in the available history." };
  return answer;
}

export function legacyReadTools(current: readonly ToolDef[]): ToolDef[] {
  const canonical = (name: string) => current.find((tool) => tool.name === name)!;
  const alias = (name: string, target: string): ToolDef => ({ ...canonical(target), name,
    description: `Compatibility read for cached connectors; refresh the catalogue to use ${target}. ${canonical(target).description}` });
  const search = alias("search_messages", "search");
  search.schema = { ...search.schema, ...account, before: z.string().optional() };
  // Each account has its own coverage and sync state. Keep those alongside the merged hits.
  delete search.outputSchema;
  search.handler = async (args, ctx) => {
    const accounts = [];
    let messages: Array<MessageView & { account_id: string; account_rank: number }> = [];
    let contexts: Array<SearchContext & { account_id: string }> = [];
    const bindings = selected(args, ctx);
    const owners = bindings.map((b) => searchOwner(b.wa));
    if (args.before !== undefined && bindings.length > 1) throw new WazapError("INVALID_ID", "A search cursor belongs to one account.", "Pass account_id with before");
    const results = await Promise.all(bindings.map((binding) => canonical("search").handler(args, { ...ctx, wa: binding.wa, accountId: binding.id, deferSearchFinalization: true })));
    for (const [i, found] of results.entries()) {
      const binding = bindings[i]!;
      if (found.isError) return found;
      const payload = found.structuredContent!;
      const hits = payload.messages as MessageView[];
      accounts.push({ account_id: binding.id, mode: payload.mode, index: payload.index, recall_unavailable: payload.recall_unavailable,
        changed_during_read: payload.changed_during_read,
        from_resolved: payload.from_resolved as string | undefined,
        coverage: payload.coverage, freshness: payload.freshness, sync: payload.sync, notes: payload.notes as string[] | undefined,
        private_omitted: payload.private_omitted as number | undefined, scan_capped: payload.scan_capped, next_before: payload.next_before });
      messages.push(...hits.map((message, rank) => ({ ...message, account_id: binding.id, account_rank: rank + 1 })));
      contexts.push(...((payload.contexts ?? []) as SearchContext[]).map((context) => ({ ...context, account_id: binding.id })));
    }
    // One account may change while another one's identity/model work awaits.
    // Refresh all rules, then re-read every source synchronously before merge.
    const rules = await Promise.all(bindings.map((b) => args.chat_id === undefined ? privateRule(ctx.hub, b.id) : undefined));
    const finalMessages: typeof messages = [];
    const finalContexts: typeof contexts = [];
    let changed = accounts.some((entry) => entry.changed_during_read === true);
    for (const [i, binding] of bindings.entries()) {
      checkSearchSource(ctx.hub, binding.id, binding.wa, owners[i]!);
      const final = finalizeSearch(binding.wa, messages.filter((m) => m.account_id === binding.id), contexts.filter((c) => c.account_id === binding.id),
        args.chat_id as string | undefined, { includeContext: args.include_context !== false, private: rules[i], from: accounts[i]!.from_resolved,
          sinceMs: parseMoment(args.since as string | undefined, "since"), untilMs: parseMoment(args.until as string | undefined, "until", true) }, args.query as string);
      finalMessages.push(...final.messages);
      finalContexts.push(...(final.contexts ?? []).map((c) => ({ ...c, account_id: binding.id })));
      changed ||= final.changed;
    }
    messages = finalMessages;
    contexts = finalContexts;
    // Preserve the database cursor order within one account, including equal timestamps.
    const modes = new Set(accounts.map((entry) => entry.mode));
    const mode = modes.size === 1 ? accounts[0]!.mode : "mixed";
    if (accounts.length > 1) messages.sort(mode === "words"
      ? (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
      : (a, b) => a.account_rank - b.account_rank || Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const shown = messages.slice(0, args.limit as number);
    const top = new Set(shown.slice(0, 5).map((m) => `${m.account_id}:${m.message_id}`));
    const assessment = assessSearch(args.query as string, shown.map((m) => ({ ...m, chat_id: `${m.account_id}:${m.chat_id}` })), mode === "words");
    return result({ query: args.query, mode, count: shown.length, messages: shown, accounts, assessment,
      ...(args.include_context === false ? {} : { contexts: contexts.filter((c) => top.has(`${c.account_id}:${c.anchor_id}`)) }),
      next_before: mode !== "hybrid" && accounts.length === 1 && shown.length === args.limit ? shown.at(-1)!.message_id : null,
      partial: changed || accounts.some((entry) => entry.scan_capped === true) || (accounts.length > 1 && messages.length >= (args.limit as number)),
      ...(changed ? { changed_during_read: true } : {}),
      notes: [...new Set([...accounts.flatMap((entry) => entry.notes ?? []), ...(changed ? [SEARCH_CHANGED] : [])])],
      private_omitted: accounts.reduce((n, entry) => n + (entry.private_omitted ?? 0), 0),
      coverage: accounts.length === 1 ? accounts[0]!.coverage : null,
      freshness: accounts.length === 1 ? accounts[0]!.freshness : null,
      ...(accounts.length === 1 && accounts[0]!.recall_unavailable !== undefined ? { recall_unavailable: accounts[0]!.recall_unavailable } : {}),
      account_id: accounts.length === 1 ? accounts[0]!.account_id : null,
      sync: accounts.some((entry) => entry.sync !== "done") ? "partial" : "done" });
  };
  const transcribe = alias("transcribe_audio", "get_media");
  delete transcribe.outputSchema;
  transcribe.handler = async (args, ctx) => {
    const answer = await canonical("get_media").handler(args, ctx);
    if (answer.isError) return answer;
    const transcript = answer.structuredContent?.transcript as Record<string, unknown> | undefined;
    if (transcript === undefined) throw new WazapError("TRANSCRIBE_UNAVAILABLE", "No transcript is available for this recording.");
    return { ...answer, structuredContent: { ...transcript, message_id: args.message_id, account_id: answer.structuredContent?.account_id } };
  };
  const download = alias("download_media", "get_media");
  delete download.outputSchema;
  download.handler = async (args, ctx) => {
    const messageId = args.message_id as string;
    const resolved = { id: ctx.accountId, wa: ctx.wa };
    const found = args.account_id === undefined
      ? await resolveMessageIdAcross(ctx.hub, resolved, messageId)
      : { binding: resolved, sid: await resolveMessageId(ctx.wa, messageId) };
    const { inline_base64, ...file } = await found.binding.wa.downloadMedia(found.sid, args.save_to as string | undefined);
    const images: ToolResult["content"] = inline_base64 ? [{ type: "image", data: inline_base64, mimeType: file.mime }] : [];
    return result({ ...file, message_id: messageId, account_id: found.binding.id }, images);
  };
  return [search, download, transcribe, alias("list_accounts", "get_status"),
    {
      name: "search_contacts", title: "Search contacts (compatibility)", description: "Compatibility read: contacts matching a name or number. Refresh the catalogue to use find_contact.",
      schema: { ...account, query: z.string().min(2), limit: z.number().int().min(1).max(50).default(10) }, write: false, hints: readHints,
      handler: async (args, ctx) => {
        const contacts = [];
        const bindings = selected(args, ctx);
        for (const binding of bindings) contacts.push(...(await binding.wa.searchContacts(args.query as string, args.limit as number)).map((c) => ({ ...c, account_id: binding.id })));
        return result({ contacts, count: contacts.length, account_id: bindings.length === 1 ? bindings[0]!.id : null });
      },
    }, {
      name: "get_recent_messages", title: "Recent messages (compatibility)", description: "Compatibility read: a bounded page of recent conversations. Refresh the catalogue to use catch_up.",
      schema: { ...account, hours: z.number().int().min(1).max(168).default(24), filter: z.enum(["all", "unread", "groups", "individual"]).default("all"),
        compact: z.boolean().default(false), include_system: z.boolean().default(false), include_previews: z.boolean().default(false),
        types: z.array(z.enum(MESSAGE_TYPES)).optional(), limit: z.number().int().min(1).max(200).default(50), cursor: z.string().max(100).optional() },
      write: false, hints: readHints, handler: recent,
    }, {
      name: "get_unanswered", title: "Unanswered candidates (compatibility)", description: "Compatibility read: requests that may need a reply, not proven obligations. Refresh the catalogue to use catch_up.",
      schema: { ...account, min_age_hours: z.number().min(0).max(336).default(0), max_age_hours: z.number().min(1).max(336).default(336), limit: z.number().int().min(1).max(50).default(20) },
      write: false, hints: readHints,
      handler: async (args, ctx) => {
        if ((args.min_age_hours as number) > (args.max_age_hours as number)) throw new WazapError("INVALID_ID", "min_age_hours must not exceed max_age_hours.");
        const chats = [];
        let sync = "done";
        const bindings = selected(args, ctx);
        for (const binding of bindings) {
          const found = await binding.wa.getUnanswered(args.min_age_hours as number, args.max_age_hours as number, args.limit as number, { private: await privateRule(ctx.hub, binding.id) });
          if (found.sync !== "done") sync = found.sync;
          chats.push(...found.data.map((c) => ({ ...c, account_id: binding.id })));
        }
        chats.sort((a, b) => (a.type === b.type ? a.waiting_since.localeCompare(b.waiting_since) : a.type === "individual" ? -1 : 1));
        const shown = chats.slice(0, args.limit as number);
        return result({ chats: shown, count: shown.length, sync, account_id: bindings.length === 1 ? bindings[0]!.id : null, notes: ["Candidates only; calls or replies outside WhatsApp may have resolved these."] });
      },
    }];
}
