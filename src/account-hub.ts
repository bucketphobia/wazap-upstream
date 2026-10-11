/**
 * One process, N WhatsApp sockets. The registry names the accounts; this holds
 * a live service for each enabled one, with its own reconnect loop and write
 * bucket. MCP tools resolve a service per call. The roster follows accounts.json
 * while the process runs: `reload` starts what was added or enabled and stops
 * what was disabled or removed.
 */

import { AccountRegistry, type AccountRecord } from "./accounts.js";
import { accountPaths, type Config } from "./config.js";
import { WazapError } from "./errors.js";
import { log, logError } from "./logger.js";
import { logoutAccount, type LogoutOutcome } from "./logout.js";
import type { WhatsAppApi } from "./wa-types.js";
import { WhatsAppService } from "./whatsapp.js";

const FIX_ENABLE = "Run `wazap account enable <id>` or `wazap account add <id>`";
const FIX_LIST = "Run `wazap account list`";

/** What a reload changed. `kept` would have been stopped, but a server needs one account to serve. */
export interface RosterChange {
  added: string[];
  removed: string[];
  kept: string[];
}

/** A live socket plus the registry id that owns it. Tools never recover the id from getStatus. */
export interface AccountBinding {
  readonly id: string;
  readonly wa: WhatsAppApi;
}

/** What HTTP, stdio and `registerTools` use to pick an account. */
export interface AccountSource {
  binding(id: string): AccountBinding | undefined;
  defaultBinding(): AccountBinding;
  bindings(): AccountBinding[];
  findByChat(jid: string): AccountBinding[];
  findByMessage(id: string): AccountBinding[];
  findByDraft(id: string): AccountBinding[];
  record(id: string): AccountRecord | undefined;
  records(): AccountRecord[];
  /** The record on disk, which may be newer than the snapshot `record` reads. */
  recordOnDisk(id: string): AccountRecord | undefined;
  /**
   * Re-read accounts.json into the running roster. Throws what the registry
   * throws on a missing or malformed policy, and then changes nothing.
   */
  reload(): void;
  /** Persist the linked jid on the account's record, after link_account lands it. */
  noteOwner(id: string, owner: string): void;
}

function bind(id: string, wa: WhatsAppApi): AccountBinding {
  return { id, wa };
}

function readSingletonId(wa: WhatsAppApi): string {
  try {
    const id = wa.getStatus().account_id;
    return typeof id === "string" && id.length > 0 ? id : "default";
  } catch {
    return "default";
  }
}

function readSingletonName(wa: WhatsAppApi, fallback: string): string {
  try {
    const name = wa.getStatus().account_name;
    return typeof name === "string" && name.length > 0 ? name : fallback;
  } catch {
    return fallback;
  }
}

/** One live service as a hub, so existing tests can keep passing a stub `wa`. */
export function singletonSource(wa: WhatsAppApi): AccountSource {
  const id = readSingletonId(wa);
  const binding = bind(id, wa);
  const self = (): AccountRecord => ({
    id,
    name: readSingletonName(wa, id),
    enabled: true,
    owner: null,
  });
  return {
    binding: (requested) => (requested === id ? binding : undefined),
    defaultBinding: () => binding,
    bindings: () => [binding],
    findByChat: (jid) => (typeof wa.hasChat === "function" && wa.hasChat(jid) ? [binding] : []),
    findByMessage: (mid) => (typeof wa.hasMessage === "function" && wa.hasMessage(mid) ? [binding] : []),
    findByDraft: (did) => (typeof wa.hasDraft === "function" && wa.hasDraft(did) ? [binding] : []),
    record: (requested) => (requested === id ? self() : undefined),
    records: () => [self()],
    // The stub has no disk: what it knows is all there is.
    recordOnDisk: (requested) => (requested === id ? self() : undefined),
    reload: () => {},
    noteOwner: () => {},
  };
}

export class AccountHub implements AccountSource {
  private readonly services = new Map<string, WhatsAppService>();
  private known = new Map<string, AccountRecord>();
  private defaultId: string;
  private readonly givenUp = new Set<string>();
  /** Accounts a logout or a removal is working on; a reload leaves them to it. */
  private readonly held = new Set<string>();
  /** Services taken off the roster and still stopping. */
  private readonly stopping = new Set<Promise<void>>();
  /** Logout and removal run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private started = false;
  private closed = false;
  private readonly config: Config;
  private readonly dataDir: string;
  /** Process exit hook. Fires only after every enabled account has given up. */
  onGiveUp: (() => void) | null = null;

  constructor(config: Config, registry: AccountRegistry) {
    this.config = config;
    this.dataDir = config.dataDir;
    // Seal legacy policy presence, even if no account can be started.
    registry.seal();
    const records = registry.all();
    this.known = new Map(records.map((account) => [account.id, { ...account }]));
    this.defaultId = registry.defaultId();
    const enabled = records.filter((account) => account.enabled);
    if (enabled.length === 0) {
      throw new WazapError("INVALID_ID", "No enabled account to serve.", FIX_ENABLE);
    }
    for (const account of enabled) this.spawn(account);
  }

  async start(): Promise<void> {
    this.started = true;
    await Promise.all([...this.services].map(([id, wa]) => this.startService(id, wa)));
  }

  async stop(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.services.values()].map((wa) => wa.stop()));
    await this.settled();
  }

  get(id: string): WhatsAppService | undefined {
    return this.services.get(id);
  }

  default(): WhatsAppService {
    return this.services.get(this.primaryId())!;
  }

  all(): WhatsAppService[] {
    return [...this.services.values()];
  }

  binding(id: string): AccountBinding | undefined {
    const wa = this.services.get(id);
    return wa === undefined ? undefined : bind(id, wa);
  }

  defaultBinding(): AccountBinding {
    const id = this.primaryId();
    return bind(id, this.services.get(id)!);
  }

  bindings(): AccountBinding[] {
    return [...this.services].map(([id, wa]) => bind(id, wa));
  }

  findByChat(jid: string): AccountBinding[] {
    return this.bindings().filter((row) => row.wa.hasChat(jid));
  }

  findByMessage(id: string): AccountBinding[] {
    return this.bindings().filter((row) => row.wa.hasMessage(id));
  }

  findByDraft(id: string): AccountBinding[] {
    return this.bindings().filter((row) => row.wa.hasDraft(id));
  }

  record(id: string): AccountRecord | undefined {
    const found = this.known.get(id);
    return found === undefined ? undefined : { ...found };
  }

  records(): AccountRecord[] {
    return [...this.known.values()].map((account) => ({ ...account }));
  }

  /** The registry re-read from disk: write admission trusts this, never the snapshot. */
  recordOnDisk(id: string): AccountRecord | undefined {
    return AccountRegistry.load(this.dataDir).get(id);
  }

  /**
   * Bring the roster in line with accounts.json, synchronously: a service for
   * every enabled account that has none, and none for an account that is gone
   * or disabled. Stopping continues in the background; `settled` waits for it.
   * A malformed or missing policy throws before anything changes. The last
   * running account is never stopped this way, since a server with nothing to
   * serve is one that `serve` refuses to start.
   */
  reload(): RosterChange {
    const change: RosterChange = { added: [], removed: [], kept: [] };
    if (this.closed) return change;
    const registry = AccountRegistry.load(this.dataDir);
    const records = registry.all();
    this.known = new Map(records.map((account) => [account.id, { ...account }]));
    this.defaultId = registry.defaultId();

    const enabled = new Map(records.filter((account) => account.enabled).map((account) => [account.id, account]));
    const leaving = [...this.services.keys()].filter((id) => !enabled.has(id) && !this.held.has(id));
    const arriving = [...enabled.values()].filter((account) => !this.services.has(account.id) && !this.held.has(account.id));

    for (const account of arriving) {
      const wa = this.spawn(account);
      change.added.push(account.id);
      if (this.started) void this.startService(account.id, wa);
    }
    if (this.services.size === leaving.length) {
      change.kept.push(...leaving);
      if (leaving.length > 0) log(`accounts: no other enabled account, so ${leaving.join(", ")} keeps running`);
    } else {
      for (const id of leaving) {
        this.retire(id);
        change.removed.push(id);
      }
    }
    if (change.added.length > 0 || change.removed.length > 0) {
      log(
        `accounts: ${[...change.added.map((id) => `+${id}`), ...change.removed.map((id) => `-${id}`)].join(" ")}`
      );
      this.checkGiveUp();
    }
    return change;
  }

  /** Every service a reload or a removal took off the roster has finished stopping. */
  async settled(): Promise<void> {
    while (this.stopping.size > 0) await Promise.all([...this.stopping]);
  }

  /**
   * `wazap logout` against this running process. The account's service stops
   * first, so its socket is closed and a pairing in flight is cancelled; then
   * the logout runs exactly as the CLI runs it with the server down, and a
   * fresh service, not linked, takes the old one's place.
   */
  logout(id: string): Promise<LogoutOutcome> {
    return this.serialized(async () => {
      if (this.closed) throw new WazapError("SERVICE_ERROR", "The server is shutting down.", "Run the command again");
      if (AccountRegistry.load(this.dataDir).get(id) === undefined) {
        throw new WazapError("INVALID_ID", `No account "${id}".`, FIX_LIST);
      }
      this.held.add(id);
      const old = this.services.get(id);
      try {
        await old?.stop();
        const outcome = await logoutAccount(this.dataDir, id);
        const record = this.known.get(id);
        if (record !== undefined && outcome !== "not_linked") record.owner = null;
        return outcome;
      } finally {
        // Also when the logout failed: a stopped service must not go on answering.
        this.held.delete(id);
        this.restore(id, old);
        this.reloadQuietly();
      }
    });
  }

  /**
   * `wazap account remove` against this running process: the service stops
   * before its folder is deleted, so nothing writes into a folder being removed.
   */
  remove(id: string): Promise<void> {
    return this.serialized(async () => {
      if (this.closed) throw new WazapError("SERVICE_ERROR", "The server is shutting down.", "Run the command again");
      const registry = AccountRegistry.load(this.dataDir);
      if (registry.get(id) === undefined) throw new WazapError("INVALID_ID", `No account "${id}".`, FIX_LIST);
      if (registry.all().length <= 1) {
        throw new WazapError("INVALID_ID", "Cannot remove the last account.", "Add another account first");
      }
      if (this.services.has(id) && this.services.size === 1) {
        throw new WazapError(
          "INVALID_ID",
          `Cannot remove "${id}" while the server runs: it is the only account being served.`,
          "Enable another account first, or stop the server"
        );
      }
      this.held.add(id);
      const old = this.services.get(id);
      try {
        // Its folder is about to go: a transcription under way is cancelled, not waited for.
        old?.abortTranscription();
        this.retire(id);
        await this.settled();
        // Loaded again: another command may have changed the registry while the service stopped.
        AccountRegistry.load(this.dataDir).remove(id);
        this.known.delete(id);
      } finally {
        // A removal that failed leaves the account in the registry: serve it again now.
        this.held.delete(id);
        this.restore(id, old);
        this.reloadQuietly();
      }
    });
  }

  noteOwner(id: string, owner: string): void {
    try {
      AccountRegistry.load(this.dataDir).setOwner(id, owner);
      const record = this.known.get(id);
      if (record !== undefined) record.owner = owner;
    } catch (err) {
      // A linked session still works; the display field is what is lost.
      logError(`owner persist ${id}`, err);
    }
  }

  private primaryId(): string {
    if (this.services.has(this.defaultId)) return this.defaultId;
    for (const id of this.known.keys()) if (this.services.has(id)) return id;
    return this.services.keys().next().value!;
  }

  /** A service for the account, on the roster. Callbacks from a service that has since been replaced are ignored. */
  private spawn(account: AccountRecord): WhatsAppService {
    const wa = new WhatsAppService(this.config, account, accountPaths(this.dataDir, account.id));
    wa.onGiveUp = () => {
      if (this.services.get(account.id) === wa) this.noteGiveUp(account.id);
    };
    // An account that came back is no longer one of those the process would exit for.
    wa.onRecovered = () => {
      if (this.services.get(account.id) === wa) this.givenUp.delete(account.id);
    };
    wa.onLinked = (linked) => {
      if (this.services.get(account.id) === wa) this.noteOwner(account.id, linked.id);
    };
    this.services.set(account.id, wa);
    this.givenUp.delete(account.id);
    return wa;
  }

  private startService(id: string, wa: WhatsAppService): Promise<void> {
    return wa.start().catch((err: unknown) => {
      logError(`whatsapp start ${id}`, err);
      if (this.services.get(id) === wa) this.noteGiveUp(id);
    });
  }

  private retire(id: string): void {
    const wa = this.services.get(id);
    if (wa === undefined) return;
    this.services.delete(id);
    this.givenUp.delete(id);
    const stopped = wa
      .stop()
      .catch((err: unknown) => logError(`whatsapp stop ${id}`, err))
      .finally(() => this.stopping.delete(stopped));
    this.stopping.add(stopped);
  }

  /**
   * After a logout or a removal stopped `old`, whether it worked or threw: the
   * account is served by a fresh service if it is still meant to be, and a
   * stopped service never stays on the roster. An unreadable registry cannot
   * say the account went, so the snapshot decides; write admission still
   * refuses on that registry. Never throws, so the original error is the one
   * the caller sees.
   */
  private restore(id: string, old: WhatsAppService | undefined): void {
    if (old === undefined || this.closed) return;
    const current = this.services.get(id);
    if (current !== undefined && current !== old) return;
    try {
      let record: AccountRecord | undefined;
      let readable = true;
      try {
        record = AccountRegistry.load(this.dataDir).get(id);
      } catch {
        readable = false;
      }
      const wanted = readable ? record?.enabled === true : this.known.has(id);
      const others = [...this.services.keys()].some((key) => key !== id);
      if (!wanted && others) {
        this.services.delete(id);
        this.givenUp.delete(id);
        return;
      }
      // The roster is never left empty, as a reload never empties it.
      const source = record ?? this.known.get(id);
      if (source === undefined) return;
      const fresh = this.spawn(source);
      if (this.started) void this.startService(id, fresh);
    } catch (err) {
      logError(`accounts restore ${id}`, err);
    }
  }

  private reloadQuietly(): void {
    try {
      this.reload();
    } catch (err) {
      logError("accounts reload", err);
    }
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  private noteGiveUp(id: string): void {
    if (this.givenUp.has(id)) return;
    this.givenUp.add(id);
    logError("whatsapp", `account ${id}: reconnects exhausted`);
    this.checkGiveUp();
  }

  private checkGiveUp(): void {
    if (this.services.size === 0 || ![...this.services.keys()].every((id) => this.givenUp.has(id))) return;
    this.onGiveUp?.();
  }
}
