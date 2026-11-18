/**
 * `wazap proxy`: an MCP server on stdio that serves its client from the session
 * the running server holds (the background service, usually), and never holds
 * the session itself. Where a plain bridge (src/bridge.ts) exits when the
 * holder goes so that its client's restart can take the session over, the
 * proxy stays: it waits for the holder to come back (a `service restart`, an
 * update) and carries on over the new one, so an agent that runs wazap as a
 * subprocess beside the service never loses its tools and never competes with
 * the service for the session.
 *
 * It reaches the holder on its loopback endpoint with the local token from
 * `daemon.json` (mode 600, in the data dir): no OAuth, nothing in the client's
 * config. A tool call is forwarded once and never retried: a call that was in
 * flight when the holder went answers NOT_CONNECTED, with its outcome unknown,
 * since replaying a write could send a message twice.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  GetPromptRequestSchema,
  GetPromptResultSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  type CallToolResult,
  type Implementation,
} from "@modelcontextprotocol/sdk/types.js";
import { setTimeout as sleep } from "node:timers/promises";
import { bridgedCall } from "./bridge.js";
import { WAZAP_VERSION } from "./config.js";
import { daemonHealthy, readDaemon, type DaemonInfo } from "./daemon.js";
import { serveOnHello } from "./hello.js";
import { log } from "./logger.js";

const HEARTBEAT_MS = 1_000;
const POLL_MS = 250;
/** How long a request waits for a holder before it answers that none is there. */
export const PROXY_WAIT_MS = 30_000;
/** How long the client's initialize waits for the holder's capabilities and instructions. */
const HELLO_WAIT_MS = 15_000;

export interface ProxyOptions {
  daemonFile: string;
  /** Per request; tests shorten it. */
  waitMs?: number;
  helloWaitMs?: number;
}

interface Upstream {
  client: Client;
  daemon: DaemonInfo;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: there, but not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A tool answer in wazap's own error shape, so the agent reads code, message and fix as from any tool. */
export function proxyError(code: string, message: string, fix: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, message, fix }) }] };
}

const NO_HOLDER = (): CallToolResult =>
  proxyError(
    "NOT_CONNECTED",
    "The wazap server is not running (or is restarting), so there is no session to answer from.",
    "Wait a few seconds and retry; if it lasts, run `wazap service status` (or `wazap service start`)"
  );

const DROPPED = (): CallToolResult =>
  proxyError(
    "NOT_CONNECTED",
    "The wazap server restarted while this call was running; whether it took effect is unknown.",
    "Call get_status; before repeating a write, read the chat to check it did not already happen"
  );

/**
 * The holder this proxy talks to, kept current: dropped when its pid gives up
 * the sidecar or dies, and replaced by whichever server publishes one next.
 */
export class UpstreamLink {
  private current: Upstream | null = null;
  private connecting: Promise<Upstream | null> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /** Set once the client's server exists: every connection after that tells the client to list the tools again. */
  onConnect: (() => void) | null = null;

  constructor(
    private readonly daemonFile: string,
    private readonly clientInfo: () => Implementation
  ) {}

  start(): void {
    this.heartbeat = setInterval(() => this.check(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  get daemon(): DaemonInfo | null {
    return this.current?.daemon ?? null;
  }

  /** Whether the sidecar still names the holder we are connected to, and it lives. */
  private stillCurrent(up: Upstream): boolean {
    return readDaemon(this.daemonFile)?.pid === up.daemon.pid && alive(up.daemon.pid);
  }

  private check(): void {
    const up = this.current;
    if (up !== null && !this.stillCurrent(up)) this.drop(up, `the session holder (pid ${up.daemon.pid}) went away`);
    // Waiting for a holder is not left to the next request: the client hears of the tools as soon as one is up.
    if (this.current === null && this.connecting === null && !this.closed) {
      this.connecting = this.tryConnect().finally(() => {
        this.connecting = null;
      });
    }
  }

  /**
   * The holder no longer knows our session (it expired after a day idle, or was the idlest past the
   * cap): a request it answered 404 never reached a tool, so it is safe to send again on a new one.
   */
  forget(up: Upstream): void {
    this.drop(up, `the session holder (pid ${up.daemon.pid}) forgot this session`);
  }

  private drop(up: Upstream, reason: string): void {
    if (this.current !== up) return;
    this.current = null;
    log(`${reason}; waiting for it to come back`);
    void up.client.close().catch(() => {});
  }

  /** The live holder, connecting to one if needed, waiting up to `waitMs` for one to appear. */
  async get(waitMs: number): Promise<Upstream | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const up = this.current;
      if (up !== null) {
        if (this.stillCurrent(up)) return up;
        this.drop(up, `the session holder (pid ${up.daemon.pid}) went away`);
      }
      if (this.closed) return null;
      this.connecting ??= this.tryConnect().finally(() => {
        this.connecting = null;
      });
      const got = await this.connecting;
      if (got !== null) return got;
      if (Date.now() >= deadline) return null;
      await sleep(POLL_MS);
    }
  }

  private async tryConnect(): Promise<Upstream | null> {
    const daemon = readDaemon(this.daemonFile);
    if (daemon === null || !alive(daemon.pid)) return null;
    if (!(await daemonHealthy(daemon.port, 2_000))) return null;
    const info = this.clientInfo();
    const client = new Client({ name: info.name, version: info.version });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${daemon.token}` } },
        })
      );
    } catch {
      await client.close().catch(() => {});
      return null;
    }
    const up: Upstream = { client, daemon };
    client.onclose = () => this.drop(up, `the session holder (pid ${daemon.pid}) closed the connection`);
    client.onerror = () => {
      if (!this.stillCurrent(up)) this.drop(up, `lost the session holder (pid ${daemon.pid})`);
    };
    this.current = up;
    log(`sharing the WhatsApp session held by pid ${daemon.pid} (wazap ${daemon.version})`);
    this.onConnect?.();
    return up;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    const up = this.current;
    this.current = null;
    await up?.client.close().catch(() => {});
  }
}

/** The holder answered that it does not know the session: nothing was run. */
export function sessionLost(err: unknown): boolean {
  return err instanceof StreamableHTTPError && err.code === 404;
}

const failedOn = new WeakMap<object, Upstream>();

/** One request on the live holder, sent again once on a new session when the holder had forgotten ours. */
async function forward<T>(link: UpstreamLink, waitMs: number, send: (up: Upstream) => Promise<T>): Promise<{ up: Upstream; result: T } | null> {
  for (let attempt = 0; ; attempt++) {
    const up = await link.get(waitMs);
    if (up === null) return null;
    try {
      return { up, result: await send(up) };
    } catch (err) {
      if (attempt === 0 && sessionLost(err)) {
        link.forget(up);
        continue;
      }
      // Kept beside the error, never on it: the upstream holds the loopback token.
      if (typeof err === "object" && err !== null) failedOn.set(err, up);
      throw err;
    }
  }
}

/** Serve stdio from whatever server holds the session in this data dir, across its restarts. */
export async function runProxy(opts: ProxyOptions): Promise<void> {
  const waitMs = opts.waitMs ?? PROXY_WAIT_MS;
  let hello: Implementation | undefined;
  const link = new UpstreamLink(opts.daemonFile, () => hello ?? { name: "wazap-proxy", version: WAZAP_VERSION });
  link.start();

  await serveOnHello(new StdioServerTransport(), async (client) => {
    hello = client;
    const first = await link.get(opts.helloWaitMs ?? HELLO_WAIT_MS);
    const caps = first?.client.getServerCapabilities() ?? {};
    const server = new Server(first?.client.getServerVersion() ?? { name: "wazap", version: WAZAP_VERSION }, {
      // Prompts are always offered: a holder that starts later still has them, and an empty list costs nothing.
      capabilities: { tools: { ...(caps.tools ?? {}), listChanged: true }, prompts: { ...(caps.prompts ?? {}) } },
      ...(first?.client.getInstructions() === undefined ? {} : { instructions: first.client.getInstructions() }),
    });
    link.onConnect = () => {
      // A new holder may be a new version with other tools, or the first one after a start with none:
      // the client asks for the list again.
      void server.sendToolListChanged().catch(() => {});
    };

    server.setRequestHandler(ListToolsRequestSchema, async (req) => {
      const done = await forward(link, waitMs, (up) => up.client.request({ method: "tools/list", params: req.params }, ListToolsResultSchema));
      return done?.result ?? { tools: [] };
    });
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      try {
        const done = await forward(link, waitMs, (up) =>
          up.client.request({ method: "tools/call", params: bridgedCall(req.params, server.getClientVersion()?.name) }, CallToolResultSchema)
        );
        return done?.result ?? NO_HOLDER();
      } catch (err) {
        // The holder went mid-call: never replayed, since the call may have run.
        const up = typeof err === "object" && err !== null ? failedOn.get(err) : undefined;
        if (up !== undefined && (link.daemon?.pid !== up.daemon.pid || !alive(up.daemon.pid))) return DROPPED();
        throw err;
      }
    });
    server.setRequestHandler(ListPromptsRequestSchema, async (req) => {
      const done = await forward(link, waitMs, async (up) =>
        up.client.getServerCapabilities()?.prompts ? up.client.request({ method: "prompts/list", params: req.params }, ListPromptsResultSchema) : { prompts: [] }
      );
      return done?.result ?? { prompts: [] };
    });
    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const done = await forward(link, waitMs, (up) => up.client.request({ method: "prompts/get", params: req.params }, GetPromptResultSchema));
      if (done === null) throw new Error("The wazap server is not running; retry in a few seconds.");
      return done.result;
    });
    return server;
  });

  // Our own client leaving is the end: the upstream stream would otherwise hold the event loop open.
  const leave = (): void => {
    void link.close().finally(() => process.exit(0));
  };
  process.stdin.on("end", leave);
  process.stdin.on("close", leave);
}
