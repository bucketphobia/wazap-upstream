import { createHash, timingSafeEqual } from "node:crypto";
import { HttpSessions } from "./http-sessions.js";
import { httpPostBudget } from "./http-budget.js";
import { httpError, httpRequestLog, logLabel, noteSessionOutcome } from "./http-log.js";
import { withCode } from "./error-code.js";
import { createServer, type Server } from "node:http";
import { createConnection } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isInitializeRequest, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response, NextFunction } from "express";
import type { AccountBinding, AccountSource } from "./account-hub.js";
import { WAZAP_VERSION, paths, writesHints, type Config } from "./config.js";
import { answerFormatFor, possibleFormats, type AnswerFormat, type CredentialKind } from "./client-name.js";
import { APPROVE_PATH, OAUTH_SCOPES, WazapOAuthProvider } from "./oauth.js";
import { loadSkills, registerSkillPrompts, skillInstructions } from "./skills.js";
import type { CallTracker } from "./tool-runtime.js";
import { anyAccountAllowsWrites, registerTools } from "./tools.js";
import { log } from "./logger.js";
import { replayHandshake, revivedProtocolVersion, serveMcp, type McpTransport } from "./mcp-http.js";
import { sessionIds } from "./session-id.js";
import { serveOnHello } from "./hello.js";
import { MEDIA_LINK_ROUTE, mediaLinksFor, serveMediaLink } from "./media-links.js";
import type { ConnectionStatus } from "./wa-types.js";

const UNHEALTHY_AFTER_MS = 2 * 60 * 1000;
/**
 * A session nobody has touched in a day is abandoned, not kept. Cloud agents
 * come back to a conversation hours later; a session costs about 200 KiB of
 * heap now that the catalogue is shared, and one swept anyway is revived on
 * its next call.
 */
export const MCP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** A client that never closes can still pile up sessions; past this, the idlest goes. */
export const MCP_SESSION_MAX = 64;
/** No one credential holds more than this many of them. */
export { MCP_SESSIONS_PER_OWNER } from "./http-sessions.js";
const MCP_SESSION_SWEEP_MS = 5 * 60 * 1000;

/**
 * How long an idle keep-alive socket stays open. A tunnel (cloudflared keeps
 * pooled origin connections for 90 s, tailscaled's proxy similarly) must
 * always be the side that gives up an idle socket: if Node closed it first, a
 * POST the tunnel sends on it at that moment would come back as a 502, and a
 * proxy does not replay a POST. On Node 22 headersTimeout counts from a
 * request's first byte, not from the socket's last activity, so an idle
 * keep-alive socket outliving it is not cut, while headers that trickle in
 * still are.
 */
export const HTTP_KEEP_ALIVE_MS = 120_000;
/** Whole headers within this, or 408; slowloris protection. */
export const HTTP_HEADERS_TIMEOUT_MS = 10_000;
/** A whole request body within this; never cuts a response, however long it streams. */
export const HTTP_REQUEST_TIMEOUT_MS = 30_000;
/**
 * How often Node looks for requests past those two bounds. Its default, 30 s,
 * let headers trickle in for up to 40 s; it walks only requests still being
 * received, so a second costs next to nothing.
 */
export const HTTP_TIMEOUT_CHECK_MS = 1_000;

function isAuthorized(header: string | undefined, expected: string): boolean {
  const prefix = "Bearer ";
  if (!header || !header.startsWith(prefix)) return false;
  const got = Buffer.from(header.slice(prefix.length).trim());
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Who a session is for and what it hooks into, beyond the permissions that shape it. */
interface SessionOpts {
  client?: string;
  draftIdentity?: string;
  stopping?: AbortSignal;
  calls?: CallTracker;
  /** Already worked out by the caller (sessionShape), so it is not worked out twice. */
  shape?: SessionShape;
  /** The answer format, when no shape is given (stdio): `full` when absent. */
  format?: AnswerFormat;
}

/**
 * The one place a session is built, so the workflows reach stdio and HTTP alike:
 * a client that never installed the skill files still gets them here.
 */
function buildMcpServer(hub: AccountSource, config: Config, allowWrite: boolean, allowLocalFiles: boolean, opts: SessionOpts = {}): McpServer {
  const shape = opts.shape ?? sessionShape(hub, config, allowWrite, allowLocalFiles, opts.format ?? "full");
  const server = new McpServer({ name: "wazap", version: WAZAP_VERSION }, { instructions: shape.instructions });
  // A link to an original is for a remote session on a server the internet reaches; a local one has the file.
  const links = allowLocalFiles ? null : mediaLinksFor(config);
  registerTools(server, hub, {
    allowWrite: shape.writes,
    // remember's edits are local state, not WhatsApp writes: they answer to
    // the credential alone, so a read token cannot change shared notes or a
    // #private tag — and a write credential on a read-only server still can.
    allowLocalEdits: allowWrite,
    allowLocalFiles,
    legacyReads: shape.legacyReads,
    format: shape.format,
    ...(links === null ? {} : { mediaLinks: links }),
    client: opts.client ?? LOCAL_CLIENT,
    ...(opts.draftIdentity === undefined ? {} : { draftIdentity: opts.draftIdentity }),
    ...(opts.stopping === undefined ? {} : { stopping: opts.stopping }),
    ...(opts.calls === undefined ? {} : { calls: opts.calls }),
    ...(config.maxInFlight === undefined ? {} : { maxInFlight: config.maxInFlight }),
    ...(config.maxInFlightTotal === undefined ? {} : { maxInFlightTotal: config.maxInFlightTotal }),
  });
  registerSkillPrompts(server, loadSkills(), { legacyReads: shape.legacyReads });
  return server;
}

/**
 * What a session is handed at initialize, which its client keeps for as long
 * as it holds the session: the tools, workflows and instructions its
 * permissions select, from this version of wazap.
 */
interface SessionShape {
  writes: boolean;
  legacyReads: boolean;
  /** Text alone, or text and structured content (client-name.ts): part of the fingerprint, so a revival restores it. */
  format: AnswerFormat;
  instructions: string;
  /**
   * A digest of all of that: a session id is signed with it (session-id.ts),
   * so a session is revived only by a process that would hand its client the
   * same, and a client whose tools or instructions changed gets the 404 that
   * makes it initialize again and read them.
   */
  fingerprint: string;
}

function sessionShape(hub: AccountSource, config: Config, allowWrite: boolean, allowLocalFiles: boolean, format: AnswerFormat): SessionShape {
  const writes = allowWrite && !config.readOnly && anyAccountAllowsWrites(hub);
  return shapeFor(writes, !allowLocalFiles, namedAccounts(hub), format);
}

/**
 * One shape per permission key and roster, shared by every session that has
 * it. The roster is part of the key, so an account added or renamed while
 * serving reaches the next session; a handful of keys at most.
 */
const shapeCache = new Map<string, SessionShape>();

function shapeFor(writes: boolean, legacyReads: boolean, accounts: ReturnType<typeof namedAccounts>, format: AnswerFormat): SessionShape {
  const key = JSON.stringify([writes, legacyReads, accounts, format]);
  let shape = shapeCache.get(key);
  if (shape === undefined) {
    if (shapeCache.size >= 32) shapeCache.clear();
    const skills = loadSkills();
    const instructions = skillInstructions(skills, { allowWrite: writes, accounts, legacyReads });
    // Everything the client keeps, itself and not only what decides it: the
    // instructions, the workflows' text and the tools/list this session
    // publishes (allowLocalFiles is !legacyReads), so a tool whose schema or
    // description changed (get_media's detail and pages) or a workflow
    // rewritten within one version still gets the 404 and a fresh initialize.
    // The answer format too: a revival, which never sees the client's name,
    // finds the format the id was minted with by which fingerprint it carries.
    const catalogue = registerTools.catalogue({ allowWrite: writes, legacyReads, allowLocalFiles: !legacyReads, format });
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([WAZAP_VERSION, writes, legacyReads, format, instructions, skills, catalogue]))
      .digest("base64url");
    shape = { writes, legacyReads, format, instructions, fingerprint };
    shapeCache.set(key, shape);
  }
  return shape;
}

/** The live accounts as the instructions name them; none when the roster cannot be read. */
function namedAccounts(hub: AccountSource): Array<{ id: string; name: string; default: boolean }> {
  try {
    const primary = hub.defaultBinding().id;
    return hub.bindings().map((binding) => ({ id: binding.id, name: hub.record(binding.id)?.name ?? binding.id, default: binding.id === primary }));
  } catch {
    return [];
  }
}

/**
 * The SDK's session transport, loaded on the first initialize rather than on
 * the bind path daemon.json waits on, and warmed just after the bind
 * (startHttpEndpoint) so that first initialize does not pay for it either.
 */
let transportModule: Promise<typeof import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js")> | undefined;
function loadTransportModule(): NonNullable<typeof transportModule> {
  transportModule ??= import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
  return transportModule;
}

/** The OAuth routes that take a body before any credential is checked. */
const OAUTH_BODY_ROUTES = ["/authorize", "/token", "/register", "/revoke", APPROVE_PATH];
/** A registration with many redirect URIs is a few KiB; nothing an OAuth route takes comes near this. */
export const OAUTH_BODY_MAX_BYTES = 64 * 1024;

/**
 * 415 for a compressed body, 413 for a declared length past the cap. A body
 * sent chunked, with no length, still meets the parsers' own 100 KiB limit.
 */
function refuseOAuthBody(req: Request, res: Response, next: NextFunction): void {
  const encoding = req.headers["content-encoding"];
  if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
    res.status(415).json({ error: "invalid_request", error_description: "Compressed request bodies are not accepted" });
    return;
  }
  const length = Number(req.headers["content-length"] ?? 0);
  if (!Number.isFinite(length) || length > OAUTH_BODY_MAX_BYTES) {
    res.status(413).json({ error: "invalid_request", error_description: "Request body too large" });
    return;
  }
  next();
}

/** A POST to /mcp from a read credential, or sent without a length: every tool call fits in it. */
export const MCP_BODY_MAX_BYTES = 100 * 1024;
/**
 * A write credential's POST with a declared length: send_message's
 * data_base64 at its 5 MB (about 6.7 MB as base64; 7.1 MB as JSON when wrapped
 * with CRLF every 76 characters, each line break four bytes of escapes) and
 * the rest of the call, and no more.
 */
export const MCP_WRITE_BODY_MAX_BYTES = 8 * 1024 * 1024;
/** Bodies past MCP_BODY_MAX_BYTES being read and served at once, every credential together: four of the largest. */
export const MCP_LARGE_BODIES_MAX_BYTES = 4 * MCP_WRITE_BODY_MAX_BYTES;

const NO_ROOM_TO_REVIVE = (live: number): string => `HTTP MCP session not revived: every session it could replace is answering a request (${live} live)`;

/** Every anonymous loopback reader shares this owner; such sessions are never revived. */
const ANONYMOUS_OWNER = "anonymous";

/** What kind of credential a request carries, for the log: never which one. */
function credentialKind(req: AuthedRequest): CredentialKind {
  if (req.oauthClient !== undefined) return "oauth";
  if (req.localFiles === true) return "local";
  if (req.sessionOwner === ANONYMOUS_OWNER) return "anonymous";
  return "token";
}

/**
 * Who connects, once per session: the client's own name and version, the
 * protocol it speaks, what kind of credential it holds and which public name
 * (tunnel) it came through. Bounded labels only, never a token or an id: this
 * is how the owner learns which cloud clients actually use the server.
 */
function logInitialize(req: AuthedRequest, format: AnswerFormat): void {
  const params = (req.body as { params?: { protocolVersion?: unknown; clientInfo?: { name?: unknown; version?: unknown } } }).params;
  const text = (value: unknown, limit: number): string => (typeof value === "string" ? logLabel(value, limit) : "");
  const client = [text(params?.clientInfo?.name, 60), text(params?.clientInfo?.version, 24)].filter(Boolean).join(" ") || "unnamed";
  log(
    `MCP initialize: client="${client}" protocol=${text(params?.protocolVersion, 16) || "-"} credential=${credentialKind(req)} host=${text(req.headers.host, 80) || "-"} answers=${format}`
  );
}

/** A download link's path (MEDIA_LINK_ROUTE), as Express matches it: case-insensitively. */
function isMediaLinkPath(path: string): boolean {
  return /^\/media\/[^/]+\/?$/i.test(path);
}

/** /mcp as Express routes it: in any case, with or without a trailing slash, so /mcp/ and /MCP are served as /mcp is. */
function isMcpPath(path: string): boolean {
  return /^\/mcp\/?$/i.test(path);
}

/** stdio, the daemon's loopback bridge and anonymous loopback reads: this machine's own clients, each named per call (client-name.ts). */
const LOCAL_CLIENT = "local";

type AuthedRequest = Request & {
  mcpWrite?: boolean;
  oauthClient?: string;
  /** Who the credential names (ToolCtx.client), never the token itself. */
  client?: string;
  sessionOwner?: string;
  /** The stable identity a session's drafts answer to (RegisterOpts.draftIdentity). */
  draftIdentity?: string;
  localFiles?: boolean;
};

/**
 * Who a session belongs to: never the raw token, which session state does not
 * keep. A static token is its SHA-256 fingerprint. An OAuth credential is its
 * grant — the client and the scopes it was granted — not the access token of
 * the day, so the daily rotation keeps the agent's sessions and its POST
 * budget; a narrower refresh is a different owner. Every request still
 * verifies its token, so revocation and expiry answer 401 all the same.
 */
function sessionOwner(auth: string, access: { write: boolean; localFiles: boolean; oauthClient?: string; scopes?: readonly string[] }): string {
  const prefix = `${access.write ? "write" : "read"}:${access.localFiles ? "local" : "remote"}`;
  if (access.oauthClient !== undefined) return `${prefix}:oauth:${access.oauthClient}:${[...(access.scopes ?? [])].sort().join(" ")}`;
  return `${prefix}:${createHash("sha256").update(auth.slice("Bearer ".length).trim()).digest("hex")}`;
}

/**
 * Who a session's drafts answer to. A remote credential is a stable identity,
 * so its drafts survive a dropped or reinitialized HTTP session — an async
 * confirm over a fresh connection is the same client. An OAuth draft answers
 * to the client the grant belongs to, so a rotated access token keeps it.
 * The daemon's own credential (localFiles) and anonymous readers keep
 * per-session drafts: processes sharing that channel stay distinct sessions.
 */
function draftIdentity(owner: string, access: { localFiles: boolean; oauthClient?: string }): string | undefined {
  if (access.localFiles) return undefined;
  return access.oauthClient === undefined ? owner : `oauth:${access.oauthClient}`;
}

/**
 * The local client's session. Its server is built once the client's
 * initialize has said who it is, so an assistant gets its answers as text
 * (client-name.ts) like any other session; until then nothing is answered.
 */
export async function runStdio(hub: AccountSource, config: Config): Promise<void> {
  await serveOnHello(new StdioServerTransport(), (client) =>
    buildMcpServer(hub, config, true, true, { format: answerFormatFor(config.answerFormat, client?.name) })
  );
  log("MCP server ready on stdio.");
}

export interface AccountHealth {
  account_id: string;
  status: ConnectionStatus;
  since: string;
}

export interface HealthBody {
  ok: boolean;
  status: ConnectionStatus;
  since: string;
  default: AccountHealth;
  accounts: AccountHealth[];
}

function rowOf(row: AccountBinding): AccountHealth {
  const s = row.wa.getStatus();
  return { account_id: row.id, status: s.status, since: s.status_since };
}

function isFresh(since: string): boolean {
  return Date.now() - Date.parse(since) <= UNHEALTHY_AFTER_MS;
}

/** Liveness for /healthz: default account on top, every live account listed. */
export function healthBody(hub: AccountSource): HealthBody {
  const accounts = hub.bindings().map(rowOf);
  const primary = rowOf(hub.defaultBinding());
  const ok = accounts.some((row) => row.status === "connected" || isFresh(row.since));
  return { ok, status: primary.status, since: primary.since, default: primary, accounts };
}

/** One bearer token and what it unlocks. */
export interface Credential {
  token: string;
  write: boolean;
  /**
   * What sessions on this token are called (ToolCtx.client): `token:<label>`,
   * or `local` for the daemon's bridge, which each call then names after its
   * MCP client (client-name.ts). Never derived from the token itself,
   * so a rotated secret keeps its catch-up mark. `token:write` / `token:read`
   * by default.
   */
  label?: string;
  /** Only the private daemon/bridge credential is granted host file access. Never inferred from peer IP. */
  localFiles?: boolean;
}

/** A Streamable HTTP listener: where it binds and who may talk to it. */
export interface Endpoint {
  host: string;
  port: number;
  credentials: Credential[];
  /** No read token configured, so an unauthenticated request gets the read tools. Never with OAuth on. */
  openRead: boolean;
  /** Hosted agents sign in here instead of carrying a token. */
  oauth?: WazapOAuthProvider;
  /** Aborting it closes the listener and every session on it. */
  signal?: AbortSignal;
  /** Test seams for the session bounds below; production takes the constants. */
  sessionTtlMs?: number;
  sessionMax?: number;
  sessionSweepMs?: number;
}

const TAKEN_PROBE_MS = 500;

/**
 * Node sets SO_REUSEADDR on every listen. On Darwin that (and an IPv4/IPv6
 * split between two listen()s) lets a second bind on a taken host:port
 * succeed, so the listening callback fires and we never see EADDRINUSE.
 * Something already accepting there is taken, even if bind would share.
 */
function takenListenPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, signal: AbortSignal.timeout(TAKEN_PROBE_MS) });
    socket.unref();
    let settled = false;
    const done = (taken: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(taken);
    };
    socket.once("connect", () => done(true));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      done(err.name === "AbortError" || err.code === "ABORT_ERR");
    });
  });
}

/**
 * Probe a fixed port, then exclusive listen. exclusive stops cluster handle
 * sharing; it does not clear Darwin SO_REUSEADDR. The probe is that check.
 * Port 0 has nothing to probe.
 */
async function listenHttp(server: Server, host: string, port: number): Promise<number> {
  if (port !== 0 && (await takenListenPort(host, port))) {
    const err: NodeJS.ErrnoException = new Error(`listen EADDRINUSE: address already in use ${host}:${port}`);
    err.code = "EADDRINUSE";
    throw err;
  }
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host, exclusive: true }, () => {
      server.removeListener("error", reject);
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        server.close();
        reject(new Error(`listen on ${host}:${port} returned no AddressInfo`));
        return;
      }
      resolve(bound.port);
    });
  });
}

/** Serve /mcp and /healthz on one address. Resolves with the bound port, so port 0 works. */
export async function startHttpEndpoint(hub: AccountSource, config: Config, endpoint: Endpoint): Promise<number> {
  // express is only needed once a listener is actually bound; a stdio server
  // with sharing off and a bridge onto a running daemon never reach here.
  const { default: express } = await import("express");
  const app = express();
  app.use(httpRequestLog);

  // Shutting down: what is under way finishes (drainHttpEndpoints), nothing
  // new starts. The listener closes at once, so a new connection is refused;
  // a request on a connection already open gets 503 with Retry-After. Either
  // way the client's session is revived by the next process.
  const stopping = new AbortController();
  let draining = false;
  // What a drain waits for: answers still being written (a POST to /mcp, a
  // download link's file or its HEAD), and tool calls still running whether or not
  // anyone reads their answer, so a send whose client left is not cut off by
  // the accounts stopping under it. A call its client cancelled has no answer
  // to write (serveMcp ends its stream).
  let answersInFlight = 0;
  let callsInFlight = 0;
  let quiet: (() => void) | undefined;
  const settledOne = (): void => {
    if (answersInFlight === 0 && callsInFlight === 0) quiet?.();
  };
  const calls: CallTracker = {
    begin: () => {
      callsInFlight++;
    },
    end: () => {
      callsInFlight--;
      settledOne();
    },
  };
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (draining) {
      res.setHeader("Connection", "close");
      res.setHeader("Retry-After", "2");
      res.status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: "Server is restarting; retry shortly." }, id: null });
      return;
    }
    if ((req.method === "POST" && isMcpPath(req.path)) || ((req.method === "GET" || req.method === "HEAD") && isMediaLinkPath(req.path))) {
      answersInFlight++;
      res.once("close", () => {
        answersInFlight--;
        settledOne();
      });
    }
    next();
  });

  if (endpoint.openRead && !endpoint.oauth) {
    log(
      "WARNING: no WAZAP_READ_TOKEN set, the /mcp endpoint is UNAUTHENTICATED. " +
        "Set WAZAP_READ_TOKEN before exposing this server beyond localhost."
    );
  }

  const oauth = endpoint.oauth;
  // A server that advertises sign-in must not also answer strangers.
  const openRead = endpoint.openRead && !oauth;
  let resourceMetadataUrl: string | null = null;
  if (oauth) {
    // The OAuth stack (the SDK's auth router and its own limiter) is the one
    // part of this endpoint only a public server pays for, so it loads here.
    const [{ mcpAuthRouter, getOAuthProtectedResourceMetadataUrl }, { rateLimit }] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/auth/router.js"),
      import("express-rate-limit"),
    ]);
    // A private/LAN address is not automatically a proxy. Trust only configured
    // peers and use Express's same right-to-left XFF resolution for every limiter.
    app.set("trust proxy", config.trustedProxies ?? ["loopback"]);
    // These routes parse bodies before anyone has authenticated, with the
    // SDK's own default-inflate parsers: refuse what they would inflate
    // (body-parser GHSA-27r3-jxmh-p828) and anything far past what an OAuth
    // request needs, before a byte of it is read.
    app.use(OAUTH_BODY_ROUTES, refuseOAuthBody);
    app.use(
      mcpAuthRouter({
        provider: oauth,
        issuerUrl: oauth.issuerUrl,
        resourceServerUrl: oauth.resourceUrl,
        resourceName: "wazap",
        scopesSupported: [...OAUTH_SCOPES],
        serviceDocumentationUrl: new URL("https://github.com/razvangirgiz/wazap#self-host"),
        // A confidential client's secret would otherwise expire after thirty
        // days and its refresh token with it, which is a monthly password.
        clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
      })
    );
    app.post(
      APPROVE_PATH,
      rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }),
      express.urlencoded({ extended: false, inflate: false, limit: OAUTH_BODY_MAX_BYTES }),
      oauth.approve
    );
    log(`OAuth on: agents sign in at ${oauth.issuerUrl.href}`);
    resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(oauth.resourceUrl);
  }

  // The first credential the bearer token matches decides the session's tools,
  // so a leaked read token can never message anyone. An OAuth token carries
  // the scope the person picked on the consent page.
  const bearerAccess = async (
    auth: string | undefined
  ): Promise<{ write: boolean; localFiles: boolean; oauthClient?: string; scopes?: string[]; client: string } | null> => {
    const credential = endpoint.credentials.find((entry) => isAuthorized(auth, entry.token));
    if (credential) {
      const client = credential.label ?? `token:${credential.write ? "write" : "read"}`;
      return { write: credential.write, localFiles: credential.localFiles === true, client };
    }
    if (oauth && auth?.startsWith("Bearer ")) {
      try {
        const info = await oauth.verifyAccessToken(auth.slice("Bearer ".length).trim());
        return {
          write: info.scopes.includes("write"),
          localFiles: false,
          oauthClient: info.clientId,
          scopes: info.scopes,
          client: `oauth:${info.clientId}`,
        };
      } catch {
        // An unknown or expired token opens nothing.
      }
    }
    return null;
  };

  const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const access = await bearerAccess(req.headers.authorization);
    if (access) {
      (req as AuthedRequest).mcpWrite = access.write;
      (req as AuthedRequest).oauthClient = access.oauthClient;
      (req as AuthedRequest).client = access.client;
      (req as AuthedRequest).localFiles = access.localFiles;
      const owner = sessionOwner(req.headers.authorization!, access);
      (req as AuthedRequest).sessionOwner = owner;
      const identity = draftIdentity(owner, access);
      if (identity !== undefined) (req as AuthedRequest).draftIdentity = identity;
      next();
      return;
    }
    if (openRead) {
      // Anonymous loopback access is not ambient browser authority. Use raw
      // Host/Origin, never forwarded headers, to reject DNS rebinding and CSRF.
      // A loopback name is what defeats rebinding; the port may differ from the
      // socket's when a container or forwarder maps it (127.0.0.1:9000 -> 8766).
      const host = req.headers.host?.toLowerCase();
      const localHosts = ["localhost", "127.0.0.1", "[::1]"];
      const allowed = host !== undefined && localHosts.includes(host.replace(/:\d{1,5}$/, ""));
      if (!allowed || (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)) {
        res.status(403).json({ error: "Anonymous MCP requires a loopback Host and same-origin requests. Use a bearer token." });
        return;
      }
      (req as AuthedRequest).mcpWrite = false;
      (req as AuthedRequest).client = LOCAL_CLIENT;
      (req as AuthedRequest).sessionOwner = ANONYMOUS_OWNER;
      next();
      return;
    }
    // RFC 6750: a token that came and was refused is invalid_token, so the client
    // knows to refresh or sign in again; a request that sent none gets no error.
    const challenge: string[] = [];
    if (req.headers.authorization) {
      challenge.push('error="invalid_token"', 'error_description="The bearer token is unknown or has expired"');
    }
    if (resourceMetadataUrl) challenge.push(`resource_metadata="${resourceMetadataUrl}"`);
    if (challenge.length > 0) res.setHeader("WWW-Authenticate", `Bearer ${challenge.join(", ")}`);
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" },
      id: null,
    });
  };

  // Session-based Streamable HTTP (the SDK's canonical pattern). It serves the
  // GET SSE stream and DELETE that full MCP clients open; a stateless server
  // 404s the GET and makes such clients hang until they time out.
  const sessions = new HttpSessions(endpoint.sessionMax ?? MCP_SESSION_MAX);
  const sessionTtlMs = endpoint.sessionTtlMs ?? MCP_SESSION_TTL_MS;
  const sweep = setInterval(() => {
    sessions.sweep(Date.now() - sessionTtlMs);
  }, endpoint.sessionSweepMs ?? MCP_SESSION_SWEEP_MS);
  sweep.unref();

  const ids = sessionIds(paths(config.dataDir).sessionKeyFile);
  /** What a session for this request's credential is handed, in this answer format: its tools, workflows and instructions. */
  const shapeOf = (req: AuthedRequest, format: AnswerFormat): SessionShape => sessionShape(hub, config, req.mcpWrite === true, req.localFiles === true, format);
  /** An initialize's answer format: from the client it names, whatever credential it holds. */
  const formatOf = (req: AuthedRequest): AnswerFormat => {
    const client = (req.body as { params?: { clientInfo?: { name?: unknown } } } | undefined)?.params?.clientInfo?.name;
    return answerFormatFor(config.answerFormat, client);
  };
  /**
   * The shape a session id was minted with, if it was minted for this owner:
   * a later request does not say which client it is, so each format the
   * setting allows is tried against the id's signature, never assumed.
   */
  const mintedShape = (req: AuthedRequest, owner: string, sid: string): SessionShape | undefined =>
    possibleFormats(config.answerFormat)
      .map((format) => shapeOf(req, format))
      .find((shape) => ids.verify(sid, owner, shape.fingerprint));
  /**
   * A new session for this credential: its transport, the McpServer behind it
   * with the tools the credential unlocks, and its place in the registry once
   * the transport has its id (a fresh one signed with its owner and shape, or
   * the one being revived).
   */
  const openSession = async (req: AuthedRequest, owner: string, shape: SessionShape, revivedId?: string): Promise<McpTransport> => {
    const { WebStandardStreamableHTTPServerTransport } = await loadTransportModule();
    const transport: McpTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => revivedId ?? ids.mint(owner, shape.fingerprint),
      onsessioninitialized: (sid: string) => {
        sessions.add(sid, transport, owner, revivedId !== undefined);
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.forget(sid, transport);
    };
    // The session's tools are fixed at init by the token it authenticated with.
    const server = buildMcpServer(hub, config, req.mcpWrite === true, req.localFiles === true, {
      client: req.client ?? LOCAL_CLIENT,
      ...(req.draftIdentity === undefined ? {} : { draftIdentity: req.draftIdentity }),
      stopping: stopping.signal,
      calls,
      shape,
    });
    await server.connect(transport);
    return transport;
  };

  /**
   * Whether a session this process does not hold may be brought back for
   * this request, and with what. Only for the credential the id was minted
   * for, while wazap would hand its client the same tools and instructions,
   * and never once its client ended it.
   *
   * A POST may make room by closing an idle session, never one answering a
   * request. A GET (an SDK client reconnecting its notification stream) only
   * takes a free place: one that made room would close another client's
   * stream, whose own reconnect would make room in turn, round and round, and
   * every call under way on those sessions would be cut off.
   */
  const revivable = (req: AuthedRequest, owner: string, sid: string): SessionShape | undefined => {
    if ((req.method !== "POST" && req.method !== "GET") || owner === ANONYMOUS_OWNER || sessions.ended(sid)) return undefined;
    const shape = mintedShape(req, owner, sid);
    if (shape === undefined) return undefined;
    if (req.method === "GET" ? sessions.hasRoom(owner) : sessions.canAdmit(owner)) return shape;
    if (req.method === "POST") log(NO_ROOM_TO_REVIVE(sessions.size));
    return undefined;
  };

  /**
   * A session this process does not hold, brought back for the credential it
   * was minted for: after a restart, the idle sweep or an eviction, the
   * client's next call is served instead of costing it a 404 and a fresh
   * handshake. The new session counts against the caps like any other, and
   * two calls racing to revive the same id share one revival.
   */
  const reviving = new Map<string, Promise<McpTransport | undefined>>();
  const revive = (req: AuthedRequest, owner: string, sid: string, shape: SessionShape): Promise<McpTransport | undefined> => {
    let pending = reviving.get(sid);
    if (pending === undefined) {
      pending = (async () => {
        const transport = await openSession(req, owner, shape, sid);
        try {
          await replayHandshake(transport, sid, revivedProtocolVersion(req.headers["mcp-protocol-version"]));
        } catch (err) {
          await transport.close().catch(() => {});
          throw err;
        }
        // Refused a place, because every session it could replace took a
        // request meanwhile; or ended for good by a DELETE that raced it.
        const placed = sessions.holds(sid, transport);
        if (!placed || sessions.ended(sid)) {
          if (!placed) log(NO_ROOM_TO_REVIVE(sessions.size));
          await transport.close().catch(() => {});
          return undefined;
        }
        log(`HTTP MCP session revived for a ${credentialKind(req)} credential (${sessions.size} live)`);
        return transport;
      })();
      reviving.set(sid, pending);
      void pending.then(
        () => reviving.delete(sid),
        () => reviving.delete(sid)
      );
    }
    return pending;
  };

  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionId = req.headers["mcp-session-id"];
      const owner = (req as AuthedRequest).sessionOwner;
      if (owner === undefined) throw new Error("MCP request bypassed authentication");
      let transport = typeof sessionId === "string" ? sessions.get(sessionId, owner) : undefined;
      if (transport) noteSessionOutcome(res, "reused");
      // Do not reveal whether a foreign session exists, or permit reinitializing it.
      if (!transport && typeof sessionId === "string" && sessions.has(sessionId)) {
        noteSessionOutcome(res, "lost");
        res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
        return;
      }

      if (!transport && req.method === "POST" && isInitializeRequest(req.body)) {
        const shape = shapeOf(req as AuthedRequest, formatOf(req as AuthedRequest));
        logInitialize(req as AuthedRequest, shape.format);
        transport = await openSession(req as AuthedRequest, owner, shape);
        noteSessionOutcome(res, "new");
      } else if (!transport && typeof sessionId === "string") {
        const shape = revivable(req as AuthedRequest, owner, sessionId);
        if (shape !== undefined) {
          transport = await revive(req as AuthedRequest, owner, sessionId, shape).catch((err: unknown) => {
            // A revival that fails leaves the client where it was before revivals: a 404 and a fresh initialize.
            log(`HTTP MCP session revival failed${withCode(err)}`);
            return undefined;
          });
          if (transport) noteSessionOutcome(res, "revived");
        }
      }

      if (!transport) {
        // An id we do not hold and did not mint for this credential is a 404,
        // which the spec tells a client to answer with a fresh initialize. No id
        // at all means initialize never happened, and that stays a 400.
        if (typeof sessionId === "string" && sessionId !== "") {
          // A client ending a session this process lost ends it all the same.
          if (req.method === "DELETE" && owner !== ANONYMOUS_OWNER && mintedShape(req as AuthedRequest, owner, sessionId) !== undefined) {
            sessions.end(sessionId);
          }
          noteSessionOutcome(res, "lost");
          res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
          return;
        }
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid session ID (send initialize first)" },
          id: null,
        });
        return;
      }

      // A session answering a POST is not the one to close for room.
      if (req.method === "POST" && typeof sessionId === "string") res.once("close", sessions.hold(sessionId, transport));
      await serveMcp(transport, req, res, req.method === "POST" ? req.body : undefined);
      // Ended by its client: the next call with this id is a 404, never a revival.
      if (req.method === "DELETE" && typeof sessionId === "string" && res.statusCode === 200) sessions.end(sessionId);
    } catch (err) {
      log(`HTTP MCP handler failed${withCode(err)}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  const authed = (req: Request, res: Response, next: NextFunction): void => {
    requireAuth(req, res, next).catch(next);
  };
  // A read credential's call fits in 100 KiB; only a write credential may send a file inside one (send_message's
  // data_base64), with its length declared up front, and only while the large bodies under way leave room.
  const smallBody = express.json({ limit: MCP_BODY_MAX_BYTES, inflate: false });
  const largeBody = express.json({ limit: MCP_WRITE_BODY_MAX_BYTES, inflate: false });
  // A body past its limit is answered as JSON-RPC, so an MCP client shows the agent the limit and what to do instead
  // (the SDK puts the answer's text in the error it throws), not an anonymous 413.
  const tooLarge = (req: Request, res: Response): void => {
    const write = (req as AuthedRequest).mcpWrite === true;
    const message = write
      ? `Request too large: a call to wazap carries at most ${MCP_WRITE_BODY_MAX_BYTES / 1_048_576} MB, its length declared, which holds send_message's data_base64 at its 5 MB. Put a larger file at a public URL and pass url instead.`
      : `Request too large: a call from a read-only connection carries at most ${MCP_BODY_MAX_BYTES / 1024} KB.`;
    res.status(413).json({ jsonrpc: "2.0", error: { code: -32600, message }, id: null });
  };
  const parsed =
    (req: Request, res: Response, next: NextFunction) =>
    (err?: unknown): void => {
      if (typeof err === "object" && err !== null && "status" in err && err.status === 413 && !res.headersSent) tooLarge(req, res);
      else next(err);
    };
  let largeInFlight = 0;
  const mcpBody = (req: Request, res: Response, next: NextFunction): void => {
    const declared = Number(req.headers["content-length"]);
    if ((req as AuthedRequest).mcpWrite === true && Number.isFinite(declared) && declared > MCP_WRITE_BODY_MAX_BYTES) {
      tooLarge(req, res);
      return;
    }
    if ((req as AuthedRequest).mcpWrite !== true || !Number.isFinite(declared) || declared <= MCP_BODY_MAX_BYTES) {
      smallBody(req, res, parsed(req, res, next));
      return;
    }
    if (largeInFlight + declared > MCP_LARGE_BODIES_MAX_BYTES) {
      res.setHeader("Retry-After", "2");
      res.status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many large requests at once; retry shortly." }, id: null });
      return;
    }
    largeInFlight += declared;
    res.once("close", () => {
      largeInFlight -= declared;
    });
    largeBody(req, res, parsed(req, res, next));
  };
  app.post("/mcp", authed, httpPostBudget((req) => (req as AuthedRequest).sessionOwner!, Date.now, config.httpPostBudget), mcpBody, handleMcp);
  app.get("/mcp", authed, handleMcp);
  app.delete("/mcp", authed, handleMcp);

  // Open to anyone, so a stranger gets liveness only: `ok`, and the default
  // socket's `status` / `since`. Which accounts exist is behind a token, read or
  // write, and names, phone and data dir stay behind it in get_status. A socket
  // that has been anything but connected for two minutes is a real outage, and
  // a 503 is what a tunnel or a monitor can act on; a reconnect in progress is
  // not. One dead account does not 503 the process while another is still up.
  app.get("/healthz", (req: Request, res: Response, next: NextFunction) => {
    const body = healthBody(hub);
    bearerAccess(req.headers.authorization)
      .then((access) => {
        const { ok, status, since } = body;
        res.status(ok ? 200 : 503).json(access === null ? { ok, status, since } : body);
      })
      .catch(next);
  });

  // Signed links to originals (src/media-links.ts): only on a server with a public URL. The link is the
  // capability, so no bearer token is asked; the route has a limiter of its own. Its answer is the file as
  // it is, with the headers serveMediaLink sets: compression is serveMcp's, for /mcp alone. Express answers
  // HEAD through this route too; serveMediaLink answers that one without fetching the file.
  const links = mediaLinksFor(config);
  if (links !== null) {
    const { rateLimit } = await import("express-rate-limit");
    app.set("trust proxy", config.trustedProxies ?? ["loopback"]);
    app.get(
      MEDIA_LINK_ROUTE,
      rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }),
      (req: Request, res: Response, next: NextFunction) => {
        serveMediaLink(hub, links, String(req.params.token ?? ""), res, { head: req.method === "HEAD" }).catch(next);
      }
    );
  }

  app.use(httpError);
  const server = createServer(
    {
      headersTimeout: HTTP_HEADERS_TIMEOUT_MS,
      requestTimeout: HTTP_REQUEST_TIMEOUT_MS,
      connectionsCheckingInterval: HTTP_TIMEOUT_CHECK_MS,
      keepAliveTimeout: HTTP_KEEP_ALIVE_MS,
      maxHeaderSize: 16 * 1024,
    },
    app
  );
  server.maxConnections = 256;
  let closed = false;
  const onAbort = (): void => {
    if (closed) return;
    closed = true;
    live.delete(drain);
    stopping.abort();
    clearInterval(sweep);
    sessions.close();
    server.closeAllConnections();
    server.close();
  };
  /**
   * Stop taking requests, let the POSTs and link downloads under way answer
   * for up to `ms` — a wait among them answers now with what it has — then
   * close everything.
   */
  const drain = async (ms: number): Promise<void> => {
    if (closed) return;
    draining = true;
    server.close();
    stopping.abort();
    if (answersInFlight > 0 || callsInFlight > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        quiet = resolve;
        timer = setTimeout(resolve, ms);
      });
      clearTimeout(timer);
      if (answersInFlight > 0 || callsInFlight > 0) {
        log(`HTTP shutdown: ${callsInFlight} call(s) and ${answersInFlight} answer(s) still under way after ${Math.round(ms / 1000)} s; closing them`);
      }
    }
    onAbort();
  };
  const signal = endpoint.signal;
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) {
    onAbort();
    throw signal.reason instanceof Error ? signal.reason : new Error("The listen was aborted");
  }
  let port: number;
  try {
    port = await listenHttp(server, endpoint.host, endpoint.port);
  } catch (err) {
    signal?.removeEventListener("abort", onAbort);
    clearInterval(sweep);
    sessions.close();
    server.close();
    throw err;
  }
  live.add(drain);
  // Warm what the first initialize after a restart would otherwise pay for:
  // the transport module, the catalogue each kind of credential here gets,
  // and one handshake through a session nobody holds. After the bind, so
  // daemon.json and the tunnel never wait on it.
  setImmediate(() => {
    if (closed) return;
    void warmUp().catch((err: unknown) => log(`HTTP warm-up failed${withCode(err)}`));
  });
  const warmUp = async (): Promise<void> => {
    const { WebStandardStreamableHTTPServerTransport } = await loadTransportModule();
    const kinds = new Set(endpoint.credentials.map((credential) => `${credential.write}:${credential.localFiles === true}`));
    if (oauth || openRead) kinds.add("false:false");
    if (oauth) kinds.add("true:false");
    for (const kind of kinds) {
      // Each answer format the setting allows: an assistant's session and a program's list different catalogues.
      for (const format of possibleFormats(config.answerFormat)) {
        if (closed) return;
        const [write, localFiles] = kind.split(":");
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => "warm-up" });
        await buildMcpServer(hub, config, write === "true", localFiles === "true", { format }).connect(transport);
        await replayHandshake(transport, "warm-up", LATEST_PROTOCOL_VERSION);
        await transport.close();
      }
    }
  };
  return port;
}

/** Every listening endpoint's drain, so a shutdown reaches them all. */
const live = new Set<(ms: number) => Promise<void>>();

/** How long a shutdown lets requests under way finish before it closes them. */
export const HTTP_DRAIN_MS = 10_000;

/** What a shutdown gives the accounts to stop once the HTTP drain is over. */
export const ACCOUNTS_STOP_MS = 3_000;

/**
 * The drain that fits what the supervisor allows a stop (`stopMs`, null when
 * unknown or none), leaving the accounts their time and a second spare: a
 * process killed mid-drain never stops its accounts at all.
 */
export function drainWithin(stopMs: number | null): number {
  if (stopMs === null) return HTTP_DRAIN_MS;
  return Math.max(0, Math.min(HTTP_DRAIN_MS, stopMs - ACCOUNTS_STOP_MS - 1_000));
}

/**
 * Shutdown's first step: every endpoint stops taking requests, answers the
 * ones under way (a wait at once, with what it has; other work for up to
 * `ms`), then closes. Resolves when all are closed.
 */
export async function drainHttpEndpoints(ms: number = HTTP_DRAIN_MS): Promise<void> {
  await Promise.all([...live].map((drain) => drain(ms)));
}

/** The endpoint the user asked for: WAZAP_HOST/WAZAP_PORT and the two configured tokens. */
export async function runHttp(hub: AccountSource, config: Config, extra?: Credential): Promise<number> {
  const credentials: Credential[] = [];
  if (config.readToken) credentials.push({ token: config.readToken, write: false });
  if (config.writeToken) credentials.push({ token: config.writeToken, write: true });
  if (extra) credentials.push(extra);

  const oauth =
    config.publicUrl && config.oauthPassword
      ? new WazapOAuthProvider({
          publicUrl: new URL(config.publicUrl),
          password: config.oauthPassword,
          stateFile: paths(config.dataDir).oauthFile,
        })
      : undefined;

  const port = await startHttpEndpoint(hub, config, {
    host: config.httpHost,
    port: config.httpPort,
    credentials,
    openRead: !config.readToken,
    oauth,
  });
  log(`MCP server (Streamable HTTP) on http://${config.httpHost}:${port}/mcp`);
  for (const line of writesHints(config)) log(line);
  return port;
}

/** A private endpoint on an ephemeral loopback port, reachable only with the token. */
export async function startLoopbackEndpoint(hub: AccountSource, config: Config, token: string): Promise<number> {
  const port = await startHttpEndpoint(hub, config, {
    host: "127.0.0.1",
    port: 0,
    credentials: [{ token, write: true, localFiles: true, label: LOCAL_CLIENT }],
    openRead: false,
  });
  log(`sharing this session on 127.0.0.1:${port}`);
  return port;
}
