/**
 * The bridge between Node's HTTP objects and the MCP SDK's web-standard
 * Streamable HTTP transport, written here instead of taken from the SDK's
 * Node wrapper for three reasons:
 *
 * - The answer streams through wazap's own hands, so it can be compressed
 *   with a flush after every SSE event (http-compress.ts).
 * - A session can be revived under the id a client already holds, through the
 *   transport's public handleRequest alone (replayHandshake), with no reach
 *   into the wrapper's private fields.
 * - No @hono/node-server conversion and no new request listener per request.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Writable } from "node:stream";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { acceptsGzip, COMPRESS_MIN_BYTES, gzipStream, gzipWhole, SYNC_FLUSH } from "./http-compress.js";

export type McpTransport = WebStandardStreamableHTTPServerTransport;

/**
 * How long a POST's SSE answer may hold its headers back to see whether the
 * whole answer is small (sent as it is) or not (compressed). Body bytes are
 * never held for it: a kilobyte, or the end of the answer, ends the wait.
 */
export const COMPRESS_HOLD_MS = 20;

/** Hop-by-hop headers, and credentials the transport never needs to see. */
const DROPPED_HEADERS = new Set([
  "authorization",
  "cookie",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
]);

/** The request as the web-standard transport reads it; the body travels parsed, beside it. */
export function webRequest(req: IncomingMessage & { originalUrl?: string }): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || DROPPED_HEADERS.has(name)) continue;
    if (Array.isArray(value)) for (const one of value) headers.append(name, one);
    else headers.set(name, value);
  }
  return new Request(new URL(req.originalUrl ?? req.url ?? "/mcp", "http://localhost"), { method: req.method ?? "GET", headers });
}

/** Hand one HTTP request to a session's transport and stream its answer back. */
export async function serveMcp(
  transport: McpTransport,
  req: IncomingMessage & { originalUrl?: string },
  res: ServerResponse,
  parsedBody?: unknown
): Promise<void> {
  const messages = Array.isArray(parsedBody) ? (parsedBody as unknown[]) : [parsedBody];
  const requests = messages.flatMap((message) => (isRequest(message) ? [message.id] : []));
  // Requests that share one stream with others: ending it for one of them
  // would lose the others' answers.
  const shared = requests.length > 1 ? sharedIds(transport) : undefined;
  if (shared !== undefined) for (const id of requests) shared.add(id);
  try {
    const response = await transport.handleRequest(webRequest(req), parsedBody === undefined ? {} : { parsedBody });
    // The transport has passed each cancel on, so the handler it names has
    // its signal aborted: the SDK will never send that request's answer.
    for (const message of messages) endCancelled(transport, message);
    // Only POST answers carry results worth compressing. The GET stream holds
    // notifications and keep-alives for as long as the session lives, and an
    // encoder held open that long would cost memory for nothing.
    const post = req.method === "POST";
    await writeResponse(response, res, post && acceptsGzip(req.headers["accept-encoding"]), post);
  } finally {
    if (shared !== undefined) for (const id of requests) shared.delete(id);
  }
}

type RequestId = string | number;

function isRequest(message: unknown): message is { id: RequestId; method: string } {
  const { id, method } = (message ?? {}) as { id?: unknown; method?: unknown };
  return typeof method === "string" && (typeof id === "string" || typeof id === "number");
}

/** Per session, the ids of requests whose POST carried others too, while it is answered. */
const batched = new WeakMap<McpTransport, Set<RequestId>>();

function sharedIds(transport: McpTransport): Set<RequestId> {
  let ids = batched.get(transport);
  if (ids === undefined) {
    ids = new Set();
    batched.set(transport, ids);
  }
  return ids;
}

/**
 * A request its client cancelled (notifications/cancelled) is never answered:
 * the SDK drops the result of an aborted handler. Its POST stream would stay
 * open all the same, with a keep-alive every 15 s and, compressed, its
 * encoder, until the client goes away, and a shutdown would wait on it as on
 * a call under way. The client no longer reads it, so it ends here, through
 * the transport's public closeSSEStream. A batch's stream is left alone: the
 * other requests in it still owe their answers.
 */
function endCancelled(transport: McpTransport, message: unknown): void {
  const { method, params } = (message ?? {}) as { method?: unknown; params?: { requestId?: unknown } };
  if (method !== "notifications/cancelled") return;
  const id = params?.requestId;
  if ((typeof id !== "string" && typeof id !== "number") || batched.get(transport)?.has(id)) return;
  transport.closeSSEStream(id);
}

/**
 * A web Response onto a Node ServerResponse: status, headers, then the body,
 * compressed when `compress` and worth it. `vary` marks an answer whose
 * encoding depends on Accept-Encoding, whichever one this client got.
 */
export async function writeResponse(response: Response, res: ServerResponse, compress: boolean, vary = compress): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  if (vary) res.setHeader("Vary", "Accept-Encoding");
  const body = response.body;
  if (body === null) {
    res.end();
    return;
  }
  const sse = (response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream");
  if (!sse) {
    const whole = Buffer.from(await response.arrayBuffer());
    await endWith(res, whole, compress);
    return;
  }
  const reader = body.getReader();
  let gone = false;
  // The client left: stop reading, which tells the transport the stream is gone.
  const onClose = (): void => {
    if (res.writableFinished) return;
    gone = true;
    void reader.cancel().catch(() => {});
  };
  res.once("close", onClose);
  try {
    if (compress) await streamCompressed(reader, res, () => gone);
    else await streamPlain(reader, res, () => gone);
  } catch {
    // A stream that failed mid-answer cannot be answered again; end the connection.
    void reader.cancel().catch(() => {});
    res.destroy();
  } finally {
    res.off("close", onClose);
  }
}

async function endWith(res: ServerResponse, whole: Buffer, compress: boolean): Promise<void> {
  if (compress && whole.length >= COMPRESS_MIN_BYTES) {
    const packed = await gzipWhole(whole);
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Content-Length", packed.length);
    res.end(packed);
    return;
  }
  res.setHeader("Content-Length", whole.length);
  res.end(whole);
}

type Reader = ReadableStreamDefaultReader<Uint8Array>;

async function streamPlain(reader: Reader, res: ServerResponse, gone: () => boolean): Promise<void> {
  res.flushHeaders();
  for (;;) {
    const { done, value } = await reader.read();
    if (done || gone()) break;
    if (!res.write(value)) await drained(res);
  }
  if (!gone()) res.end();
}

async function streamCompressed(reader: Reader, res: ServerResponse, gone: () => boolean): Promise<void> {
  const held: Buffer[] = [];
  let size = 0;
  let ended = false;
  let read = reader.read();
  const deadline = Date.now() + COMPRESS_HOLD_MS;
  for (;;) {
    const next = await within(read, deadline - Date.now());
    if (next === undefined) break;
    if (next.done) {
      ended = true;
      break;
    }
    held.push(Buffer.from(next.value));
    size += next.value.byteLength;
    read = reader.read();
    if (size >= COMPRESS_MIN_BYTES) break;
  }
  if (gone()) return;
  if (ended) {
    await endWith(res, Buffer.concat(held), true);
    return;
  }
  res.setHeader("Content-Encoding", "gzip");
  res.flushHeaders();
  const gzip = gzipStream();
  gzip.on("error", () => res.destroy());
  // A client that stopped reading and then left would otherwise strand the
  // encoder, and the answer inside it, for good: the pipe only unpipes from a
  // closed response, and the encoder never drains. After a finished answer
  // this destroys an encoder that has nothing left to give.
  res.once("close", () => gzip.destroy());
  gzip.pipe(res);
  const over = (): boolean => gone() || gzip.destroyed;
  // Each event leaves compressed at once: a sync flush after every chunk the
  // transport writes, keep-alive comments included.
  const send = async (chunk: Buffer): Promise<void> => {
    if (!gzip.write(chunk)) await drained(gzip);
    if (gzip.destroyed) return;
    await new Promise<void>((resolve) => {
      gzip.once("close", resolve);
      gzip.flush(SYNC_FLUSH, () => {
        gzip.off("close", resolve);
        resolve();
      });
    });
  };
  for (const chunk of held) {
    if (over()) break;
    await send(chunk);
  }
  while (!over()) {
    const next = await read;
    if (next.done || over()) break;
    await send(Buffer.from(next.value));
    read = reader.read();
  }
  if (over()) gzip.destroy();
  else gzip.end();
}

/** The read, or undefined once `ms` passes first. */
async function within<T>(pending: Promise<T>, ms: number): Promise<T | undefined> {
  if (ms <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Until the stream wants more, or can never want more. */
function drained(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      stream.off("drain", done);
      stream.off("close", done);
      stream.off("error", done);
      resolve();
    };
    stream.once("drain", done);
    stream.once("close", done);
    stream.once("error", done);
  });
}

/** What a revived session's handshake says the client speaks: the version it last sent, when supported. */
export function revivedProtocolVersion(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && SUPPORTED_PROTOCOL_VERSIONS.includes(value) ? value : LATEST_PROTOCOL_VERSION;
}

const HANDSHAKE_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

/**
 * Put a new transport, made with the session id the client holds, through
 * the handshake that client already did once: initialize, then initialized,
 * the way any client sends them. Only the transport's public handleRequest is
 * used; if a future SDK answers it differently, this throws rather than
 * serving a half-made session (test/session-revival.test.mjs).
 */
export async function replayHandshake(transport: McpTransport, sessionId: string, protocolVersion: string): Promise<void> {
  const initialize = {
    jsonrpc: "2.0",
    id: "wazap-session-revival",
    method: "initialize",
    // The client's own name and capabilities went with the process that held the session.
    params: { protocolVersion, capabilities: {}, clientInfo: { name: "", version: "" } },
  };
  const answer = await transport.handleRequest(new Request("http://localhost/mcp", { method: "POST", headers: HANDSHAKE_HEADERS }), {
    parsedBody: initialize,
  });
  const text = await answer.text();
  const data = text.split("\n").find((line) => line.startsWith("data:"));
  const envelope = data === undefined ? undefined : (JSON.parse(data.slice(5)) as { result?: unknown });
  if (answer.status !== 200 || transport.sessionId !== sessionId || envelope?.result === undefined) {
    throw new Error(`session revival: initialize answered ${answer.status}`);
  }
  const initialized = await transport.handleRequest(
    new Request("http://localhost/mcp", { method: "POST", headers: { ...HANDSHAKE_HEADERS, "mcp-session-id": sessionId } }),
    { parsedBody: { jsonrpc: "2.0", method: "notifications/initialized" } }
  );
  await initialized.body?.cancel();
  if (initialized.status !== 202) throw new Error(`session revival: initialized answered ${initialized.status}`);
}
