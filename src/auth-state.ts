import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BufferJSON,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type CacheStore,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from "baileys";
import type { ILogger } from "baileys/lib/Utils/logger.js";
import { AccountDb, StorageError } from "./db/index.js";
import { RESET_FIX, WazapError } from "./errors.js";
import { logError } from "./logger.js";

export interface LinkedAccount {
  /** Canonical `<digits>@s.whatsapp.net`. */
  id: string;
  name: string;
  number: string;
}

const CREDS_FILE = "creds.json";

/**
 * A key id becomes a filename. `/` and `:` keep their historic escapes, and
 * `+` and `=` stay as they are — base64 app-state key ids carry them, and the
 * files already on disk hold those names. Every other byte outside a plain
 * name — `\` included, a separator on Windows — folds to `_`, so an id read
 * off the wire can never walk out of `dir`.
 */
function fileFor(dir: string, name: string): string {
  return join(dir, name.replace(/\//g, "__").replace(/:/g, "-").replace(/[^A-Za-z0-9._@+=-]/g, "_"));
}

/**
 * Baileys' useMultiFileAuthState contract, with every write done as
 * tmp-file-then-rename. The stock implementation truncates the target before
 * writing, so a kill -9 in that window leaves unreadable creds and the account
 * has to be re-linked.
 */
export async function useAtomicAuthState(
  dir: string,
  /**
   * The caller read these credentials a moment ago: a file gone since is a read that failed, not a
   * fresh session whose first save would write over it once the disk is back.
   */
  options: { expectLinked?: boolean } = {}
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    // The folder the credentials live in, not there or not writable for now, is not a corrupt session.
    throw new CredentialsReadError((err as NodeJS.ErrnoException | null)?.code ?? "unknown error");
  }

  const queues = new Map<string, Promise<unknown>>();
  const serialize = <T>(path: string, task: () => Promise<T>): Promise<T> => {
    const next = (queues.get(path) ?? Promise.resolve()).then(task, task);
    queues.set(
      path,
      next.catch(() => undefined)
    );
    return next;
  };

  const writeData = (value: unknown, name: string): Promise<void> => {
    const path = fileFor(dir, name);
    return serialize(path, async () => {
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(value, BufferJSON.replacer), { mode: 0o600 });
      await rename(tmp, path);
    });
  };

  const readData = async (name: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(fileFor(dir, name), "utf8"), BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const removeData = (name: string): Promise<void> => {
    const path = fileFor(dir, name);
    return serialize(path, () => unlink(path).catch(() => undefined));
  };

  const stored = await readCreds(dir);
  if (stored === null && options.expectLinked === true) throw new CredentialsReadError("ENOENT");
  const creds = stored ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
              }
              data[id] = value as SignalDataTypeMap[T];
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            const bucket = data[category as keyof typeof data] ?? {};
            for (const id in bucket) {
              const value = bucket[id];
              const name = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, name) : removeData(name));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, CREDS_FILE),
  };
}

/** Signal keys the socket's cache holds at most: sessions, sender keys, lid mappings, the newest used kept. */
export const SIGNAL_KEY_CACHE_MAX = 2_000;
/** How long a cached Signal key is served before the file is read again (Baileys' own default). */
export const SIGNAL_KEY_CACHE_TTL_MS = 5 * 60_000;

/**
 * A bounded cache for Baileys' Signal key store: at most `max` keys, each for
 * `ttlMs`, the least recently used dropped first. Dropping is always safe — the
 * files stay the store — where node-cache's own bound throws on a full cache,
 * which would fail the write it was caching.
 */
export class BoundedKeyCache implements CacheStore {
  private readonly entries = new Map<string, { value: unknown; until: number }>();

  constructor(
    private readonly max = SIGNAL_KEY_CACHE_MAX,
    private readonly ttlMs = SIGNAL_KEY_CACHE_TTL_MS,
    private readonly now: () => number = () => performance.now()
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    if (entry.until <= this.now()) return undefined;
    this.entries.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, until: this.now() + this.ttlMs });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.max) break;
      this.entries.delete(oldest);
    }
  }

  del(key: string): void {
    this.entries.delete(key);
  }

  flushAll(): void {
    this.entries.clear();
  }
}

/**
 * The key types the cache serves: the ones a send or a receive reads once per
 * device, and that Baileys (7.0.0-rc14) never edits in place once read. A
 * session or a sender key is deserialized into new objects; an identity key, a
 * pre-key and a lid mapping are compared or copied as read.
 *
 * Every other type is read from its file each time, as it was before the
 * cache, because the cache would hand every reader the one object it holds.
 * relayMessage marks devices as given the sender key in the sender-key-memory
 * map it read, before its transaction commits; a send that then fails would
 * leave the marks in a cached map, and the next send would skip those devices.
 * A user's device list is pushed onto likewise. A type a later Baileys adds is
 * not cached either, until someone checks how it is used.
 */
export const CACHED_KEY_TYPES: ReadonlySet<keyof SignalDataTypeMap> = new Set<keyof SignalDataTypeMap>([
  "session",
  "sender-key",
  "identity-key",
  "pre-key",
  "lid-mapping",
]);

/**
 * The auth state the service's socket runs on: the same credentials, and the
 * key store behind Baileys' cache for CACHED_KEY_TYPES, so a send to a group of
 * 250 devices reads its sessions from memory instead of 250 JSON files (59 ms
 * of parsing on the main thread, measured). Every write still goes to the
 * files, in the same call, under the cache's own lock (Baileys'
 * makeCacheableSignalKeyStore); one process owns the folder (server.lock), so
 * nothing else changes them meanwhile.
 */
export function cachedAuthState(state: AuthenticationState, logger?: ILogger, cache: CacheStore = new BoundedKeyCache()): AuthenticationState {
  const files: SignalKeyStore = {
    get: (type, ids) => state.keys.get(type, ids),
    // Baileys puts a write in the cache before the files take it. One the files
    // refused empties the cache before the error goes back (the cache's lock is
    // still held), so the next read is the files' again, never a key no file holds.
    set: async (data) => {
      try {
        await state.keys.set(data);
      } catch (err) {
        await cache.flushAll();
        throw err;
      }
    },
  };
  const cached = makeCacheableSignalKeyStore(files, logger, cache);
  return {
    creds: state.creds,
    keys: {
      get: (type, ids) => (CACHED_KEY_TYPES.has(type) ? cached.get(type, ids) : state.keys.get(type, ids)),
      // A transaction commits every type it wrote in one call. Each part goes
      // its own way, and the call returns once both have settled, so no write
      // is still landing when Baileys retries a commit or reports it failed.
      set: async (data) => {
        const inCache: SignalDataSet = {};
        const direct: SignalDataSet = {};
        for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          const target: Record<string, unknown> = CACHED_KEY_TYPES.has(type) ? inCache : direct;
          target[type] = data[type];
        }
        const writes: Promise<void>[] = [];
        for (const [part, store] of [
          [inCache, cached],
          [direct, state.keys],
        ] as const) {
          if (Object.keys(part).length > 0) writes.push((async () => store.set(part))());
        }
        const refused = (await Promise.allSettled(writes)).find((result) => result.status === "rejected");
        if (refused !== undefined) throw refused.reason;
      },
    },
  };
}

/**
 * The stored credentials could not be read for a reason that may pass (EMFILE, EIO, EACCES, a disk
 * not there yet after a wake). Not "nothing is linked": reading it that way would start a fresh
 * session whose first save writes over the real one. The caller retries instead.
 */
export class CredentialsReadError extends WazapError {
  declare readonly fix: string;
  constructor(readonly errno: string) {
    super(
      "SERVICE_ERROR",
      errno === "ENOENT" ? "The stored credentials file is missing." : `The stored credentials could not be read (${errno}).`,
      errno === "ENOENT" ? CREDENTIALS_MISSING_FIX : CREDENTIALS_READ_FIX
    );
    this.name = "CredentialsReadError";
  }
}

/** A running session's credentials gone from under it: usually a disk not mounted yet, sometimes gone for good. */
export const CREDENTIALS_MISSING_FIX =
  "wazap retries until the file is back (a data disk not mounted yet); if it is gone for good, run `wazap logout`, then link again";

/** What to do about credentials the file system would not read: never a logout, which deletes them. */
export const CREDENTIALS_READ_FIX =
  "check that the user wazap runs as owns the account's auth folder and can read it, then retry; do not log out";

/** Only a file that is not there means nothing is linked; any other failure to read it is thrown. */
function missingOrThrow(err: unknown): null {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return null;
  throw new CredentialsReadError(typeof code === "string" ? code : "unknown error");
}

/** Stored credentials, or null when nothing is linked yet. */
async function readCreds(dir: string): Promise<AuthenticationCreds | null> {
  let text: string;
  try {
    text = await readFile(fileFor(dir, CREDS_FILE), "utf8");
  } catch (err) {
    return missingOrThrow(err);
  }
  try {
    return JSON.parse(text, BufferJSON.reviver) as AuthenticationCreds;
  } catch {
    throw new WazapError("SESSION_CORRUPT", `Stored credentials in ${dir} are unreadable.`, RESET_FIX);
  }
}

/** The linked account, or null when no account is linked. Throws SESSION_CORRUPT, or CredentialsReadError. */
export function readLinkedAccount(dir: string): LinkedAccount | null {
  let text: string;
  try {
    text = readFileSync(fileFor(dir, CREDS_FILE), "utf8");
  } catch (err) {
    return missingOrThrow(err);
  }
  let creds: AuthenticationCreds;
  try {
    creds = JSON.parse(text, BufferJSON.reviver) as AuthenticationCreds;
  } catch {
    throw new WazapError("SESSION_CORRUPT", `Stored credentials in ${dir} are unreadable.`, RESET_FIX);
  }
  // Baileys itself treats an account with `me` as linked (socket.js: `if (!creds.me)`
  // pairs a device, else logs in). `registered` is only ever set by the
  // pairing-code flow, so a QR-linked session would look unlinked forever.
  if (!creds.me?.id) return null;
  const number = creds.me.id.split(":")[0]!.split("@")[0]!;
  return { id: `${number}@s.whatsapp.net`, name: creds.me.name || "", number };
}

export function clearAuth(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * What a logout deletes: the credentials. The account database stays for the
 * same number to link again, and an earlier wazap's `store.json` is a legacy
 * file now, imported once and then moved aside on its own schedule.
 *
 * Given the account folder, the database is first tied to the number the
 * credentials name, created when the account never started on this version:
 * a different number linking later then sets it aside and marks the fresh one
 * `skipped`, instead of importing the earlier number's legacy files into its
 * own history. A database that already names another number keeps it. Not for
 * a service holding the database open: it claimed it at start.
 */
export function clearSession(p: { authDir: string; root?: string }): void {
  if (p.root !== undefined) bindAccountDatabase(p.root, p.authDir);
  clearAuth(p.authDir);
}

function bindAccountDatabase(root: string, authDir: string): void {
  let owner: string | null;
  try {
    owner = readLinkedAccount(authDir)?.id ?? null;
  } catch {
    return;
  }
  if (owner === null) return;
  let db: AccountDb | null = null;
  try {
    db = AccountDb.open(join(root, "wazap.sqlite"), { now: () => Date.now() });
    db.bindOwner(owner);
  } catch (err) {
    if (!(err instanceof StorageError) || err.code !== "OWNER_MISMATCH") logError("bind the account database to its number", err);
  } finally {
    db?.close();
  }
}

const APP_STATE_SYNC_VERSION = "app-state-sync-version";

/**
 * The same auth state with the app state sync journal held at zero: reads of it
 * find nothing and writes to it are dropped, every other key type untouched.
 *
 * WhatsApp delivers the phone's address book to a companion as `contactAction`
 * mutations in the app state sync, once per stored collection version. Whichever
 * socket saves those versions consumes that one delivery; every later connection
 * resyncs from the version it left behind and receives nothing. The login socket
 * has no store to put contacts in, so it must leave the journal for the service
 * that follows.
 */
export function withoutAppStateSync(state: AuthenticationState): AuthenticationState {
  return {
    creds: state.creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) =>
        type === APP_STATE_SYNC_VERSION ? {} : state.keys.get(type, ids),
      set: async (data) => {
        const rest = { ...data };
        delete rest[APP_STATE_SYNC_VERSION];
        await state.keys.set(rest);
      },
    },
  };
}
