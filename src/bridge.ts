import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
} from "@modelcontextprotocol/sdk/types.js";
import { CLIENT_META_KEY } from "./client-name.js";
import { WAZAP_VERSION } from "./config.js";
import { readDaemon, type DaemonInfo } from "./daemon.js";
import { serveOnHello } from "./hello.js";
import { log } from "./logger.js";

const HEARTBEAT_MS = 1_000;

/**
 * A tool call as the bridge forwards it: under the name of the client it
 * serves, since to the session holder the bridge itself is the client, and
 * catch_up keeps a mark per client (client-name.ts).
 */
export function bridgedCall<P extends { _meta?: Record<string, unknown> }>(params: P, clientName: string | undefined): P {
  return clientName === undefined ? params : { ...params, _meta: { ...params._meta, [CLIENT_META_KEY]: clientName } };
}

/**
 * Serve this client from the session another process already owns: an MCP server
 * on our stdio, every tool call forwarded to the daemon's loopback endpoint and
 * its answer returned untouched.
 *
 * `daemonFile` is here because the heartbeat re-reads the sidecar, and DaemonInfo
 * carries no path.
 */
export async function runBridge(daemon: DaemonInfo, daemonFile: string): Promise<void> {
  let left = false;
  /** Exit 1 so the client restarts us, and the restart becomes the new daemon. */
  const leave = (reason: string): void => {
    if (left) return;
    left = true;
    log(`${reason}, exiting so the next start can own the session`);
    process.exit(1);
  };

  // A dead daemon does not close the client: the transport retries its stream and
  // reports nothing, measured. So the liveness of the pid is ours to watch.
  const heartbeat = setInterval(() => {
    if (readDaemon(daemonFile)?.pid !== daemon.pid) {
      leave(`the session holder (pid ${daemon.pid}) gave up the session`);
      return;
    }
    try {
      process.kill(daemon.pid, 0);
    } catch {
      leave(`the session holder (pid ${daemon.pid}) is gone`);
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  // The daemon's session is opened under our client's own name, once it has
  // said it: the session holder shapes a session's answers by the client
  // (text alone for an assistant, client-name.ts), and the bridge passes them
  // on untouched.
  await serveOnHello(
    new StdioServerTransport(),
    async (hello) => {
      const client = new Client({ name: hello?.name ?? "wazap-bridge", version: hello?.version ?? WAZAP_VERSION });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${daemon.token}` } },
        })
      );

      const caps = client.getServerCapabilities() ?? {};
      const server = new Server(client.getServerVersion() ?? { name: "wazap", version: daemon.version }, {
        // Only what we forward: the daemon has no resources, and we have no handler
        // for them. The SDK refuses a handler for a capability we did not declare,
        // so the prompts pair is registered under the same condition.
        capabilities: { tools: caps.tools ?? {}, ...(caps.prompts ? { prompts: caps.prompts } : {}) },
        instructions: client.getInstructions(),
      });
      server.setRequestHandler(ListToolsRequestSchema, (req) =>
        client.request({ method: "tools/list", params: req.params }, ListToolsResultSchema)
      );
      server.setRequestHandler(CallToolRequestSchema, (req) =>
        client.request({ method: "tools/call", params: bridgedCall(req.params, server.getClientVersion()?.name) }, CallToolResultSchema)
      );
      if (caps.prompts) {
        server.setRequestHandler(ListPromptsRequestSchema, (req) =>
          client.request({ method: "prompts/list", params: req.params }, ListPromptsResultSchema)
        );
        server.setRequestHandler(GetPromptRequestSchema, (req) =>
          client.request({ method: "prompts/get", params: req.params }, GetPromptResultSchema)
        );
      }
      client.onclose = () => leave(`the session holder (pid ${daemon.pid}) closed the connection`);
      client.onerror = () => leave(`lost the connection to the session holder (pid ${daemon.pid})`);
      return server;
    },
    () => leave(`could not open a session with the session holder (pid ${daemon.pid})`)
  );
  log(`sharing the WhatsApp session held by pid ${daemon.pid}`);

  // Our own client leaving is not a failure. The upstream stream holds the event
  // loop open, so without this the bridge outlives the client it was started for.
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
}
