import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { AccountSource } from "./account-hub.js";
import { attachAccountId, resolveToolAccount, stringArg } from "./account-resolve.js";
import { CLIENT_META_KEY, isAssistantClient, LOCAL_CLIENT, localClient, type AnswerFormat } from "./client-name.js";
import { draftStale, SessionDrafts } from "./drafts.js";
import { asWazapError, ERROR_GUIDE, WazapError } from "./errors.js";
import { RateLimiter } from "./ratelimit.js";
import { requireDraftOwner } from "./send-guard.js";
import { requireChatAction, staleChatAction } from "./chat-action-drafts.js";
import { buildToolCatalogue, publishToolCatalogue } from "./tool-catalogue.js";
import type { MediaLinks } from "./media-links.js";
import type { WhatsAppApi } from "./wa-types.js";

export type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export type ToolArgs = Record<string, unknown>;

export interface ToolCtx {
  /** Give remote connectors workflows that work with their cached read names. */
  legacyReads?: boolean;
  /**
   * What the session's client receives of each answer (client-name.ts): the
   * text alone, or the text and the structured content. What a budget
   * (catch_up's) is spent on. `full` when absent.
   */
  format?: AnswerFormat;
  /**
   * Whether the session may touch this machine's files (RegisterOpts.allowLocalFiles):
   * stdio and the daemon's own bridge. A remote session is shown media, never
   * handed a path it cannot open, and nothing is written for it.
   */
  localFiles?: boolean;
  /** Signed links to originals: a remote session on a server with a public URL (src/media-links.ts). */
  mediaLinks?: MediaLinks;
  /** Internal only: the cached multi-account adapter finalizes all sources together after its awaits. */
  deferSearchFinalization?: boolean;
  wa: WhatsAppApi;
  hub: AccountSource;
  allowWrite: boolean;
  /**
   * The credential's own right to change local state (remember's notes, tags
   * and handled marks), independent of whether any account may write to
   * WhatsApp: a read credential has it false even on a writable server, and a
   * write credential keeps it true on a read-only one.
   */
  allowLocalEdits: boolean;
  accountId: string;
  /**
   * The identity the session's drafts answer to: the credential's stable
   * identity on HTTP (RegisterOpts.draftIdentity), or an opaque id minted at
   * registration where no credential names one. Stored with the drafts, never
   * shown to or taken from a caller.
   */
  draftOwner: string;
  /**
   * Who the session's credential names, stable across its sessions and token
   * rotations: `oauth:<client_id>`, `token:<label>`, or for stdio and the
   * daemon's own clients `local:<MCP client name>` (client-name.ts). What
   * catch_up keeps its mark under.
   */
  client: string;
  /**
   * Aborts when the client cancels this call or its session closes. A wait
   * honours it by stopping early (wait_for_messages, a download, a
   * transcription another call started); nothing that writes does.
   */
  signal?: AbortSignal;
  /**
   * Aborts when the server serving this session is shutting down: a wait
   * answers now with what it has, so the shutdown need not wait out its
   * timeout. Unlike `signal`, the answer is still delivered.
   */
  stopping?: AbortSignal;
}

/** MCP tool annotations, stated per tool for its most far-reaching action. */
export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDef {
  /** Callable for cached remote connectors, never advertised by tools/list. */
  legacyRead?: boolean;
  name: string;
  title: string;
  description: string;
  schema: z.ZodRawShape;
  /** The structured content's shape, when the tool declares one; an object schema may leave keys open. */
  outputSchema?: z.ZodRawShape | z.ZodObject;
  /** Registered only in a session that can write, and refused on an account that cannot. */
  write: boolean;
  hints: ToolHints;
  /** Per-tool budget, separate from the account's write budget. */
  rate?: number;
  handler: (args: ToolArgs, ctx: ToolCtx) => Promise<ToolResult>;
}

export interface RegisterOpts {
  /** Remote connectors may retain the pre-1.0 read catalogue until refreshed. */
  legacyReads?: boolean;
  /**
   * The session's answer format, decided at its initialize (client-name.ts).
   * `text`: no tool is registered or listed with an outputSchema and no answer
   * carries structured content, only its text and image blocks. `full` when absent.
   */
  format?: AnswerFormat;
  allowWrite: boolean;
  /**
   * The credential's right to change local state (see ToolCtx.allowLocalEdits).
   * Falls back to `allowWrite`, which is what every session built before this
   * flag meant: credential, global read-only and account writes folded together.
   */
  allowLocalEdits?: boolean;
  /** Trusted local stdio defaults to true; every HTTP session explicitly sets its capability. */
  allowLocalFiles?: boolean;
  /** Where get_media mints links to originals; only a remote session on a server with a public URL has it. */
  mediaLinks?: MediaLinks;
  /** Tool calls this session may have running at once. */
  maxInFlight?: number;
  /** Tool calls every session together may have running at once. */
  maxInFlightTotal?: number;
  /** See ToolCtx.client; `local` when omitted, which names each call after the MCP client making it. */
  client?: string;
  /**
   * The authenticated identity drafts of this session answer to (server.ts),
   * so a confirm arriving over a reinitialized HTTP connection still reaches
   * them. Omitted — stdio, the daemon's bridge and anonymous readers — keeps
   * drafts owned by this registration alone.
   */
  draftIdentity?: string;
  /** See ToolCtx.stopping: the HTTP endpoint's shutdown. */
  stopping?: AbortSignal;
  /** Told when each call starts running and when it settles: what the HTTP endpoint's shutdown waits on. */
  calls?: CallTracker;
}

/** Tool calls under way somewhere, counted as they start and settle. */
export interface CallTracker {
  begin(): void;
  end(): void;
}

/**
 * Where a text-format answer keeps the structured content it does not send:
 * a symbol, so it never reaches the wire (JSON drops it) but an in-process
 * observer of the registered handler — the evaluation's trace — still reads
 * what the call answered.
 */
export const STRUCTURED_COPY: unique symbol = Symbol.for("wazap/structured-copy");

/**
 * An answer as a text-format session receives it: its text and image blocks,
 * no structured content. Every renderer puts what an agent needs to act in
 * its text (tools.ts), so nothing a follow-up call takes is lost.
 */
export function textOnly(result: ToolResult): ToolResult {
  const { structuredContent, ...rest } = result;
  return structuredContent === undefined ? rest : { ...rest, [STRUCTURED_COPY]: structuredContent };
}

/** Agents fan out: Claude Code routinely sends several tool calls at once, and wait_for_messages holds one for up to 55 s. */
const MAX_IN_FLIGHT = 8;
const MAX_IN_FLIGHT_TOTAL = 32;

/**
 * A refusal as `{ error, message, fix }`: the error's own fix, or else what
 * the guide says to do about its code (ERROR_GUIDE), so every refusal says
 * what to do, an unexpected exception (WHATSAPP_ERROR) included.
 */
export function toolError(err: WazapError): ToolResult {
  const payload: Record<string, unknown> = { error: err.code, message: err.message, fix: err.fix || ERROR_GUIDE[err.code] };
  if (err.details !== undefined) Object.assign(payload, err.details);
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}

/**
 * An error from a tool that declares an outputSchema: `{ error, message, fix }`
 * and the account it concerns, as text, with no structured content. SDK
 * clients check structured content against the schema on errors too, and an
 * error is not the tool's shape.
 */
function schemaSafeError(err: WazapError, accountId: string | undefined): ToolResult {
  const payload = toolError(err).structuredContent!;
  const body = accountId === undefined ? payload : { ...payload, account_id: accountId };
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

function rateLabel(name: string): string {
  const verb = name.split("_")[0] ?? name;
  return verb.charAt(0).toUpperCase() + verb.slice(1);
}

/** Built once for the tool catalogue: reconnects never reset the process-wide rate buckets. */
export function createToolRegistrar(defs: readonly ToolDef[]) {
  // Hold a slot until the actual handler settles, even if its HTTP caller
  // disconnects. Reinitializing a session cannot reset the process budget.
  let inFlight = 0;
  const buckets = new Map<string, RateLimiter>(
    defs.flatMap((def) =>
      def.rate === undefined ? [] : [[def.name, new RateLimiter(def.rate, undefined, rateLabel(def.name))] as const]
    )
  );
  // tools/list for each permission key, built on the first session that has
  // it: converting every zod schema to JSON Schema is most of what an
  // initialize costs, and the answer is the same for every such session.
  const catalogues = new Map<string, readonly Tool[]>();
  const catalogueFor = (registered: readonly ToolDef[], opts: Pick<RegisterOpts, "allowWrite" | "legacyReads" | "allowLocalFiles" | "format">): readonly Tool[] => {
    // Which definitions register depends on allowWrite and legacyReads alone; allowLocalFiles hides the
    // host-file arguments, and a text-format session is listed no outputSchema.
    const format = opts.format ?? "full";
    const key = `${opts.allowWrite}:${opts.legacyReads === true}:${opts.allowLocalFiles !== false}:${format}`;
    let tools = catalogues.get(key);
    if (tools === undefined) {
      tools = buildToolCatalogue(registered, opts.allowLocalFiles !== false, format);
      catalogues.set(key, tools);
    }
    return tools;
  };
  /** The definitions a session with these permissions registers. */
  const selected = (opts: Pick<RegisterOpts, "allowWrite" | "legacyReads">): ToolDef[] =>
    defs.filter((def) => (opts.allowWrite || !def.write) && (opts.legacyReads === true || !def.legacyRead));
  /**
   * What tools/list hands a session with these permissions: the very array
   * registerTools publishes, so a fingerprint of it (server.ts's session
   * shape) changes whenever any tool's description or schema does.
   */
  const catalogue = (opts: Pick<RegisterOpts, "allowWrite" | "legacyReads" | "allowLocalFiles" | "format">): readonly Tool[] => catalogueFor(selected(opts), opts);
  function registerTools(server: McpServer, hub: AccountSource, opts: RegisterOpts): void {
    // A session's drafts answer to its draft identity: a remote credential's
    // stable one where the server names it, so an async confirm over a fresh
    // HTTP connection still owns the draft, and otherwise an opaque id minted
    // here that no later session is ever handed again — a restart or a new
    // initialize on the local channel still requires re-drafting.
    const draftOwner = opts.draftIdentity ?? `session_${randomUUID()}`;
    // Which of this session's calls made each draft, so confirm_send can tell a
    // draft the user has just approved from one the conversation moved past.
    const sessionDrafts = new SessionDrafts();
    let sessionInFlight = 0;
    // A local session is named after its MCP client, or the client a bridge passes on; a credential's name stands.
    const clientOf = (extra?: { _meta?: Record<string, unknown> }): string => {
      const named = opts.client ?? LOCAL_CLIENT;
      if (named !== LOCAL_CLIENT) return named;
      const session = (server as { server?: { getClientVersion?(): { name?: string } | undefined } }).server;
      return localClient(extra?._meta?.[CLIENT_META_KEY] ?? session?.getClientVersion?.()?.name);
    };
    const registered = selected(opts);
    const text = opts.format === "text";
    for (const def of registered) {
      const own = buckets.get(def.name);
      server.registerTool(
        def.name,
        {
          title: def.title,
          description: def.description,
          inputSchema: def.schema,
          // The SDK refuses an answer without structured content from a tool that declares a shape.
          ...(def.outputSchema === undefined || text ? {} : { outputSchema: def.outputSchema }),
          annotations: def.hints,
        },
        async (args: unknown, extra?: { _meta?: Record<string, unknown>; signal?: AbortSignal }): Promise<ToolResult> => {
          const call = sessionDrafts.startCall();
          const parsed = (args ?? {}) as ToolArgs;
          let resolved: { id: string; wa: WhatsAppApi } | undefined;
          let admitted = false;
          try {
            if (inFlight >= (opts.maxInFlightTotal ?? MAX_IN_FLIGHT_TOTAL) || sessionInFlight >= (opts.maxInFlight ?? MAX_IN_FLIGHT)) {
              throw new WazapError("RATE_LIMITED", "Too many tool operations are still running.",
                "Wait for pending operations to finish, then retry once");
            }
            inFlight++;
            sessionInFlight++;
            opts.calls?.begin();
            admitted = true;
            // Reject before any lookup/stat/read/write, including directory overrides on read tools.
            if (opts.allowLocalFiles === false && (parsed.file_path !== undefined || parsed.save_to !== undefined)) {
              throw new WazapError(
                "MEDIA_ACCESS_DENIED",
                "This MCP session cannot access arbitrary host files or choose download directories.",
                "Use a public HTTP(S) media URL or send_message's data_base64 (up to 5 MB), forward an existing WhatsApp message, or get_media without save_to"
              );
            }
            own?.take();
            let resolveArgs = parsed;
            if (def.name === "manage_chat" && parsed.confirmation_id !== undefined) {
              const id = stringArg(parsed, "confirmation_id") ?? "";
              const ref = requireChatAction(id, draftOwner, stringArg(parsed, "account_id"));
              if (ref.work === undefined && sessionDrafts.movedOn(id, call)) throw staleChatAction();
              sessionDrafts.retried(id, call);
              resolveArgs = { ...parsed, account_id: ref.accountId };
            }
            if (def.name === "confirm_send") {
              const draftId = stringArg(parsed, "draft_id") ?? "";
              // An assistant that drafted, did something else and now confirms is
              // acting on words that answered that something else: refuse, send
              // nothing and leave the draft alone. A builder's static token keeps
              // the contract it has, approval flow and all.
              if (isAssistantClient(clientOf(extra)) && sessionDrafts.movedOn(draftId, call)) throw draftStale(draftId);
              sessionDrafts.retried(draftId, call);
              const ref = requireDraftOwner(draftId, draftOwner, stringArg(parsed, "account_id"));
              // The confirm reaches the service now, and from here its answer
              // stands — the receipt, or SEND_OUTCOME_UNKNOWN — never staleness,
              // which would have the same message drafted and sent a second time.
              sessionDrafts.forget(draftId);
              // Resolve using the recorded account even if its service has evicted the draft.
              resolveArgs = { ...parsed, account_id: ref.accountId };
            }
            resolved = resolveToolAccount(hub, resolveArgs, def);
            // A writable account registers tools for the session, not permission to
            // touch every account. Gate before draft/media/group preflight work.
            const live = def.write ? hub.recordOnDisk(resolved.id) : undefined;
            if (def.write && (!live || !live.enabled)) {
              throw new WazapError("READ_ONLY", `Account "${resolved.id}" is missing or disabled; this write is refused.`,
                `Restore the account policy deliberately; a disabled account needs \`wazap account enable ${resolved.id}\` first`);
            }
            if (
              def.write &&
              (live?.writes === false || hub.record(resolved.id)?.writes === false || resolved.wa.getStatus?.().read_only === true)
            ) {
              throw new WazapError(
                "READ_ONLY",
                `Account "${resolved.id}" is read-only, so this write is refused.`,
                `Check global and account writes settings with the user; enable deliberately and restart the server (account: ${resolved.id})`
              );
            }
            const result = await def.handler(parsed, {
              legacyReads: opts.legacyReads === true,
              format: opts.format ?? "full",
              localFiles: opts.allowLocalFiles !== false,
              ...(opts.allowLocalFiles === false && opts.mediaLinks !== undefined ? { mediaLinks: opts.mediaLinks } : {}),
              wa: resolved.wa,
              hub,
              allowWrite: opts.allowWrite,
              allowLocalEdits: opts.allowLocalEdits ?? opts.allowWrite,
              accountId: resolved.id,
              draftOwner,
              client: clientOf(extra),
              ...(extra?.signal === undefined ? {} : { signal: extra.signal }),
              ...(opts.stopping === undefined ? {} : { stopping: opts.stopping }),
            });
            const draftId = result.structuredContent?.status === "draft" ? result.structuredContent.draft_id : undefined;
            if (typeof draftId === "string") sessionDrafts.note(draftId, call);
            const confirmationId = result.structuredContent?.status === "preview" ? result.structuredContent.confirmation_id : undefined;
            if (def.name === "manage_chat" && typeof confirmationId === "string") sessionDrafts.note(confirmationId, call);
            const answer = attachAccountId(result, resolved.id);
            return text ? textOnly(answer) : answer;
          } catch (err) {
            const id = resolved?.id ?? stringArg(parsed, "account_id");
            if (def.outputSchema !== undefined || text) return schemaSafeError(asWazapError(err), id);
            const result = toolError(asWazapError(err));
            return id === undefined ? result : attachAccountId(result, id);
          } finally {
            if (admitted) { inFlight--; sessionInFlight--; opts.calls?.end(); }
          }
        }
      );
    }
    // Small test doubles only collect handlers and have no catalogue to publish.
    if ((server as { server?: unknown }).server !== undefined) publishToolCatalogue(server, catalogueFor(registered, opts));
  }
  return Object.assign(registerTools, { catalogue });
}
