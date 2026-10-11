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
  dir: string
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
