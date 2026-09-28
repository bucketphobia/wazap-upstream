import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { AccountSource } from "./account-hub.js";
import { attachAccountId, resolveToolAccount, stringArg } from "./account-resolve.js";
import { CLIENT_META_KEY, isAssistantClient, LOCAL_CLIENT, localClient } from "./client-name.js";
import { draftStale, SessionDrafts } from "./drafts.js";
import { asWazapError, WazapError } from "./errors.js";
import { RateLimiter } from "./ratelimit.js";
import { requireDraftOwner } from "./send-guard.js";
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
  wa: WhatsAppApi;
  hub: AccountSource;
  allowWrite: boolean;
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
}

/** MCP tool annotations, stated per tool for its most far-reaching action. */
export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: z.ZodRawShape;
  /** The structured content's shape, when the tool declares one; an object schema may leave keys open. */
  outputSchema?: z.ZodRawShape | z.AnyZodObject;
  /** Registered only in a session that can write, and refused on an account that cannot. */
  write: boolean;
  hints: ToolHints;
  /** Per-tool budget, separate from the account's write budget. */
  rate?: number;
  handler: (args: ToolArgs, ctx: ToolCtx) => Promise<ToolResult>;
}

export interface RegisterOpts {
  allowWrite: boolean;
  /** Trusted local stdio defaults to true; every HTTP session explicitly sets its capability. */
  allowLocalFiles?: boolean;
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
}

/** Agents fan out: Claude Code routinely sends several tool calls at once, and wait_for_messages holds one for up to 55 s. */
const MAX_IN_FLIGHT = 8;
const MAX_IN_FLIGHT_TOTAL = 32;

export function toolError(err: WazapError): ToolResult {
  const payload: Record<string, unknown> = { error: err.code, message: err.message };
  if (err.fix) payload.fix = err.fix;
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
  return function registerTools(server: McpServer, hub: AccountSource, opts: RegisterOpts): void {
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
    for (const def of defs) {
      if (def.write && !opts.allowWrite) continue;
      const own = buckets.get(def.name);
      server.registerTool(
        def.name,
        {
          title: def.title,
          description:
            def.description +
            (opts.allowLocalFiles === false && (def.schema.file_path || def.schema.save_to)
              ? "\nThis remote session cannot use file_path or save_to. Use public HTTP(S) URLs, forward existing messages, or get_media without save_to."
              : ""),
          inputSchema: def.schema,
          ...(def.outputSchema === undefined ? {} : { outputSchema: def.outputSchema }),
          annotations: def.hints,
        },
        async (args: unknown, extra?: { _meta?: Record<string, unknown> }): Promise<ToolResult> => {
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
            admitted = true;
            // Reject before any lookup/stat/read/write, including directory overrides on read tools.
            if (opts.allowLocalFiles === false && (parsed.file_path !== undefined || parsed.save_to !== undefined)) {
              throw new WazapError(
                "MEDIA_ACCESS_DENIED",
                "This MCP session cannot access arbitrary host files or choose download directories.",
                "Use a public HTTP(S) media URL, forward an existing WhatsApp message, or get_media without save_to"
              );
            }
            own?.take();
            let resolveArgs = parsed;
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
              wa: resolved.wa,
              hub,
              allowWrite: opts.allowWrite,
              accountId: resolved.id,
              draftOwner,
              client: clientOf(extra),
            });
            const draftId = result.structuredContent?.status === "draft" ? result.structuredContent.draft_id : undefined;
            if (typeof draftId === "string") sessionDrafts.note(draftId, call);
            return attachAccountId(result, resolved.id);
          } catch (err) {
            const id = resolved?.id ?? stringArg(parsed, "account_id");
            if (def.outputSchema !== undefined) return schemaSafeError(asWazapError(err), id);
            const result = toolError(asWazapError(err));
            return id === undefined ? result : attachAccountId(result, id);
          } finally {
            if (admitted) { inFlight--; sessionInFlight--; }
          }
        }
      );
    }
  };
}
