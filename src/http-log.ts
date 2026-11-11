import type { Request, Response, NextFunction } from "express";
import { log } from "./logger.js";

const ROUTES = new Set([
  "/mcp",
  "/healthz",
  "/authorize",
  "/token",
  "/register",
  "/revoke",
  "/oauth/approve",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
]);
const METHODS = new Set(["GET", "POST", "DELETE", "OPTIONS", "HEAD", "PUT", "PATCH"]);
const RPC_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "prompts/list",
  "prompts/get",
  "resources/list",
  "resources/read",
  "resources/templates/list",
  "resources/subscribe",
  "resources/unsubscribe",
  "logging/setLevel",
  "completion/complete",
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
  "notifications/roots/list_changed",
]);

/** Human labels are bounded, single-line printable text, never raw log fields. */
export function logLabel(value: string, limit = 60): string {
  return value.replace(/[^\x20-\x7e]|["\\]/g, "").slice(0, limit);
}

/** What a session lookup came to, for the log: a bounded label, never the id. */
export type SessionOutcome = "new" | "reused" | "revived" | "lost";
const SESSION_OUTCOME = Symbol("wazap.sessionOutcome");

export function noteSessionOutcome(res: Response, outcome: SessionOutcome): void {
  (res as Response & { [SESSION_OUTCOME]?: SessionOutcome })[SESSION_OUTCOME] = outcome;
}

/** Body bytes as they leave for the socket, after any compression. */
function countBytes(res: Response): () => number {
  let bytes = 0;
  const size = (chunk: unknown, encoding: unknown): number => {
    if (typeof chunk === "string") return Buffer.byteLength(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
    if (chunk instanceof Uint8Array) return chunk.byteLength;
    return 0;
  };
  if (typeof res.write !== "function" || typeof res.end !== "function") return () => bytes;
  const write = res.write.bind(res) as (...args: unknown[]) => boolean;
  const end = res.end.bind(res) as (...args: unknown[]) => Response;
  (res as { write: unknown }).write = (...args: unknown[]): boolean => {
    bytes += size(args[0], args[1]);
    return write(...args);
  };
  (res as { end: unknown }).end = (...args: unknown[]): Response => {
    if (typeof args[0] !== "function") bytes += size(args[0], args[1]);
    return end(...args);
  };
  return () => bytes;
}

/** Only known route and RPC names are logged: queries and arbitrary paths may contain credentials. */
export function httpRequestLog(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const bytes = countBytes(res);
  const path = req.originalUrl.split(/[?#]/)[0] ?? "";
  // A media link's path is its token, a capability: only the route is logged, whatever the case Express matched it in.
  const route = ROUTES.has(path) ? path : /^\/media\//i.test(path) ? "/media/<redacted>" : "/other";
  const method = METHODS.has(req.method) ? req.method : "OTHER";
  const prefix = (): string => {
    const value: unknown =
      req.body && typeof req.body === "object" ? (req.body as { method?: unknown }).method : undefined;
    const rpc = value === undefined ? "-" : typeof value === "string" && RPC_METHODS.has(value) ? value : "other";
    const accept = req.headers.accept ?? "";
    const formats =
      [accept.includes("application/json") ? "json" : null, accept.includes("text/event-stream") ? "sse" : null]
        .filter(Boolean)
        .join("+") || "other";
    return `HTTP ${method} ${route} rpc=${rpc} ${req.headers.authorization ? "auth" : "noauth"} accept="${formats}"`;
  };
  res.on("finish", () => {
    const agent = logLabel(req.headers["user-agent"] ?? "");
    const client = (req as Request & { oauthClient?: string }).oauthClient;
    const tag = (agent ? ` client="${agent}"` : "") + (client ? ` oauth_client=${logLabel(client)}` : "");
    const encoding = res.getHeader("content-encoding") === "gzip" ? "gzip" : "identity";
    const session = (res as Response & { [SESSION_OUTCOME]?: SessionOutcome })[SESSION_OUTCOME];
    log(`${prefix()} -> ${res.statusCode} (${Date.now() - start}ms) bytes=${bytes()} enc=${encoding}${session ? ` session=${session}` : ""}${tag}`);
  });
  res.on("close", () => {
    if (!res.writableEnded) log(`${prefix()} -> client closed before response (${Date.now() - start}ms) bytes=${bytes()}`);
  });
  next();
}

/** Express's development error handler logs parser errors with excerpts of request bodies. */
export function httpError(_err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(new Error("HTTP request failed"));
    return;
  }
  const status = typeof _err === "object" && _err !== null && "status" in _err ? _err.status : undefined;
  const code = status === 400 || status === 413 || status === 415 ? status : 500;
  res.status(code).json({ error: code === 500 ? "Internal server error" : "Invalid HTTP request" });
}
