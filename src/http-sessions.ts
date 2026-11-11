import type { McpTransport } from "./mcp-http.js";
import { logError } from "./logger.js";

interface Session {
  transport: McpTransport;
  owner: string;
  lastSeen: number;
  /** POSTs being answered on it right now: a tool call under way among them. */
  busy: number;
}

/** How many sessions one credential may hold before its idlest goes. */
export const MCP_SESSIONS_PER_OWNER = 32;

/** How many ids of sessions their clients ended are remembered, newest kept. */
export const MCP_ENDED_SESSIONS_KEPT = 1024;

/**
 * Session ids are routing hints, not credentials. Check ownership before touching TTL.
 *
 * Past a cap the idlest session goes, and a session answering a request is
 * never the idlest while one that is not exists: making room must not cut a
 * tool call off.
 */
export class HttpSessions {
  private readonly sessions = new Map<string, Session>();
  /** Ids whose client ended them with DELETE, oldest first. */
  private readonly endedIds = new Set<string>();

  constructor(private readonly max: number) {}

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  get(id: string, owner: string): McpTransport | undefined {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) return undefined;
    session.lastSeen = Date.now();
    return session.transport;
  }

  /**
   * A POST is being answered on this session: until the returned release, it
   * is not evicted while another can go, and its end counts as use, so a
   * session that has just finished a long call is not the idlest.
   */
  hold(id: string, transport: McpTransport): () => void {
    const session = this.sessions.get(id);
    if (session === undefined || session.transport !== transport) return () => {};
    session.busy++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      session.busy--;
      session.lastSeen = Date.now();
    };
  }

  /** How many sessions are live; what the per-credential and overall caps bound. */
  get size(): number {
    return this.sessions.size;
  }

  /** Whether one more session for `owner` fits under both caps without closing any. */
  hasRoom(owner: string): boolean {
    return this.sessions.size < this.max && this.owned(owner).length < this.ownerMax;
  }

  /**
   * Whether one more session for `owner` can be made without closing one
   * that is answering a request: there is room, or an idle one to give way.
   */
  canAdmit(owner: string): boolean {
    const owned = this.owned(owner);
    if (owned.length >= this.ownerMax) return owned.some(([, session]) => session.busy === 0);
    return this.sessions.size < this.max || [...this.sessions.values()].some((session) => session.busy === 0);
  }

  /**
   * Register a session, closing the idlest past either cap. With `spareBusy`
   * (a revival), a session answering a request is never closed for it: the
   * new one is refused instead (false), and whoever made it closes it.
   */
  add(id: string, transport: McpTransport, owner: string, spareBusy = false): boolean {
    this.sessions.set(id, { transport, owner, lastSeen: Date.now(), busy: 0 });
    const pick = (pool: Array<[string, Session]>): string | undefined =>
      idlest(pool.filter(([other, session]) => other !== id && (!spareBusy || session.busy === 0)));
    const owned = this.owned(owner);
    if (owned.length > this.ownerMax) {
      const victim = pick(owned);
      if (victim === undefined && spareBusy) return this.refuse(id);
      if (victim !== undefined) this.drop(victim);
    }
    while (this.sessions.size > this.max) {
      const victim = pick([...this.sessions]);
      if (victim === undefined) return spareBusy ? this.refuse(id) : true;
      this.drop(victim);
    }
    return true;
  }

  /** Whether `transport` is the session registered under `id`. */
  holds(id: string, transport: McpTransport): boolean {
    return this.sessions.get(id)?.transport === transport;
  }

  private refuse(id: string): false {
    this.sessions.delete(id);
    return false;
  }

  private get ownerMax(): number {
    return Math.min(MCP_SESSIONS_PER_OWNER, this.max);
  }

  private owned(owner: string): Array<[string, Session]> {
    return [...this.sessions].filter(([, session]) => session.owner === owner);
  }

  /**
   * A transport that closed leaves the registry, unless a revival has since
   * put a new one under the same id: an old transport's close must not drop it.
   */
  forget(id: string, transport?: McpTransport): void {
    if (transport !== undefined && this.sessions.get(id)?.transport !== transport) return;
    this.sessions.delete(id);
  }

  /**
   * The client ended this session (DELETE), which the specification says is
   * for good: its id answers 404 from now on and is never revived, while this
   * process remembers it.
   */
  end(id: string): void {
    this.endedIds.delete(id);
    this.endedIds.add(id);
    if (this.endedIds.size > MCP_ENDED_SESSIONS_KEPT) this.endedIds.delete(this.endedIds.values().next().value!);
  }

  ended(id: string): boolean {
    return this.endedIds.has(id);
  }

  private drop(id: string): void {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (session) void session.transport.close().catch((err: unknown) => logError("session close", err));
  }

  sweep(cutoff: number): void {
    for (const [id, session] of this.sessions) if (session.lastSeen < cutoff && session.busy === 0) this.drop(id);
  }

  close(): void {
    for (const id of this.sessions.keys()) this.drop(id);
  }
}

/** The session to give way: the least recently used of those answering nothing, else of all. */
function idlest(candidates: Array<[string, Session]>): string | undefined {
  const pick = (pool: Array<[string, Session]>): string | undefined =>
    pool.reduce<[string, Session] | undefined>((best, entry) => (best === undefined || entry[1].lastSeen < best[1].lastSeen ? entry : best), undefined)?.[0];
  return pick(candidates.filter(([, session]) => session.busy === 0)) ?? pick(candidates);
}
