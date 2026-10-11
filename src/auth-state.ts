import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "baileys";
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
 * A key id becomes a filename. `/` and `:` keep their historic escapes; every
 * other byte outside a plain name — `\` included, a separator on Windows —
 * folds to `_`, so an id read off the wire can never walk out of `dir`.
 */
function fileFor(dir: string, name: string): string {
  return join(dir, name.replace(/\//g, "__").replace(/:/g, "-").replace(/[^A-Za-z0-9._@-]/g, "_"));
}

/**
 * Baileys' useMultiFileAuthState contract, with every write done as
 * tmp-file-then-rename. The stock implementation truncates the target before
 * writing, so a kill -9 in that window leaves unreadable creds and the account
 * has to be re-linked.
 */
export async function useAtomicAuthState(
  dir: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });

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

  const creds = (await readCreds(dir)) ?? initAuthCreds();

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

/** Stored credentials, or null when nothing is linked yet. */
async function readCreds(dir: string): Promise<AuthenticationCreds | null> {
  let text: string;
  try {
    text = await readFile(fileFor(dir, CREDS_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text, BufferJSON.reviver) as AuthenticationCreds;
  } catch {
    throw new WazapError("SESSION_CORRUPT", `Stored credentials in ${dir} are unreadable.`, RESET_FIX);
  }
}

/** The linked account, or null when no account is linked. Throws SESSION_CORRUPT. */
export function readLinkedAccount(dir: string): LinkedAccount | null {
  let text: string;
  try {
    text = readFileSync(fileFor(dir, CREDS_FILE), "utf8");
  } catch {
    return null;
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
