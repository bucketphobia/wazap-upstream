/**
 * A server built only once its client has said who it is. Over stdio the
 * server exists before any message, but what it lists and answers depends on
 * the client (an assistant gets its answers as text, client-name.ts), so the
 * transport is started first, its first message (the initialize) read, and the
 * server that answers it built from the client it names. That message and
 * every one after it then reach the server in order, as if it had been
 * listening all along.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest, type Implementation, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { withCode } from "./error-code.js";
import { log } from "./logger.js";

/** What `build` hands back: anything that serves a transport, an McpServer or a low-level Server. */
interface Connectable {
  connect(transport: Transport): Promise<void>;
}

/**
 * The real transport, seen by the server it was held for: messages that
 * arrived before the server was built come first, then the live ones.
 */
class HeldTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private live = false;

  constructor(
    private readonly inner: Transport,
    private readonly held: JSONRPCMessage[]
  ) {
    inner.onclose = () => this.onclose?.();
    inner.onerror = (error) => this.onerror?.(error);
    inner.onmessage = (message) => {
      if (this.live) this.onmessage?.(message);
      else this.held.push(message);
    };
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  async start(): Promise<void> {
    // The inner transport is already reading; the server's own connect only sets the handlers.
    queueMicrotask(() => {
      for (const message of this.held.splice(0)) this.onmessage?.(message);
      this.live = true;
    });
  }

  send(message: JSONRPCMessage, options?: Parameters<Transport["send"]>[1]): Promise<void> {
    return this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

/**
 * Start `transport` now and serve it with what `build` makes from the client
 * the first message names (undefined when that message is not an initialize).
 * Returns once the transport is reading, not when a client arrives; a build
 * that fails is logged and `onFailure` decides what follows.
 */
export async function serveOnHello(
  transport: Transport,
  build: (client: Implementation | undefined) => Connectable | Promise<Connectable>,
  onFailure: (err: unknown) => void = (err) => log(`MCP session could not start${withCode(err)}`)
): Promise<void> {
  const held: JSONRPCMessage[] = [];
  let hello: (message: JSONRPCMessage) => void = () => {};
  const first = new Promise<JSONRPCMessage>((resolve) => {
    hello = resolve;
  });
  transport.onmessage = (message) => {
    held.push(message);
    if (held.length === 1) hello(message);
  };
  await transport.start();
  void first
    .then(async (message) => {
      const client = isInitializeRequest(message) ? message.params.clientInfo : undefined;
      const server = await build(client);
      await server.connect(new HeldTransport(transport, held));
    })
    .catch(onFailure);
}
