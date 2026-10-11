/**
 * What `wazap logout` does to one account, whichever process runs it: the CLI
 * when nothing holds the data dir, or the running server when it does.
 */

import { DisconnectReason, type WASocket } from "baileys";
import { AccountRegistry } from "./accounts.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { clearSession, readLinkedAccount } from "./auth-state.js";
import { LINK_FILE } from "./service/link.js";
import { accountPaths } from "./config.js";
import { WazapError } from "./errors.js";
import { logError } from "./logger.js";
import { linkSession } from "./pairing.js";
import { fail, info, ok, warn } from "./ui.js";

export const LOGOUT_TIMEOUT_MS = 10_000;

/**
 * - `not_linked`: nothing to unlink, nothing deleted.
 * - `logged_out`: WhatsApp confirmed the unlink, or the credentials were unreadable.
 * - `already_unlinked`: the phone had removed the device first.
 * - `unlink_unconfirmed`: WhatsApp was not told; the device may still be listed.
 *
 * Every outcome but `not_linked` deleted the credentials, and only them. The
 * account database (`wazap.sqlite`) stays: the same number linking again finds
 * its history, and a different number linking sets it aside (see
 * `WhatsAppService.claimDatabase`); a logout binds it to the number first, so
 * that holds even before the account's first start on this version. Legacy
 * files from before the database are not touched; they follow their own week
 * (`src/legacy-files.ts`).
 * `wazap account remove` is what deletes the folder.
 */
export type LogoutOutcome = "not_linked" | "logged_out" | "already_unlinked" | "unlink_unconfirmed";

export const LOGOUT_OUTCOMES: readonly LogoutOutcome[] = [
  "not_linked",
  "logged_out",
  "already_unlinked",
  "unlink_unconfirmed",
];

/**
 * WhatsApp answers 401 both when a pairing code was wrong and when the phone has
 * already removed this device. At logout the second reading is the true one, so
 * the pairing-time wording must not surface as an error here.
 */
export function alreadyUnlinked(err: unknown): boolean {
  if (err instanceof WazapError) return err.code === "SESSION_EXPIRED";
  return (err as { output?: { statusCode?: number } } | null)?.output?.statusCode === DisconnectReason.loggedOut;
}

function withDeadline<T>(work: Promise<T>, deadline: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new WazapError("TIMEOUT", message)), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}

/**
 * Tell WhatsApp to unlink the account, then delete its credentials and forget
 * its owner, keeping the account database. Nothing else may hold a socket on
 * these credentials: the CLI holds the session lock, the server has stopped the
 * account's service.
 */
export async function logoutAccount(
  dataDir: string,
  id: string,
  timeoutMs = LOGOUT_TIMEOUT_MS
): Promise<LogoutOutcome> {
  const storage = accountPaths(dataDir, id);
  // The outage record is about the session being thrown away, and it is what keeps a server retrying
  // a credentials file it believes is only missing for now: a logout ends both, linked or not.
  rmSync(join(storage.root, LINK_FILE), { force: true });
  let linked = null;
  let unreadable = false;
  try {
    linked = readLinkedAccount(storage.authDir);
  } catch {
    // Unreadable creds are exactly what logout exists to clear, so keep going.
    unreadable = true;
  }
  if (!linked && !unreadable) return "not_linked";

  let outcome: LogoutOutcome = "logged_out";
  if (linked) {
    const deadline = Date.now() + timeoutMs;
    let sock: WASocket | null = null;
    try {
      sock = await linkSession(storage.authDir, { deadline });
      await withDeadline(sock.logout(), deadline, "WhatsApp did not confirm the unlink in time.");
    } catch (err: unknown) {
      if (alreadyUnlinked(err)) {
        outcome = "already_unlinked";
      } else {
        logError("unlink from WhatsApp", err);
        outcome = "unlink_unconfirmed";
      }
    } finally {
      // A process that goes on running must not keep a socket a timeout left open.
      if (sock !== null) void Promise.resolve(sock.end(undefined)).catch(() => {});
    }
  }

  clearSession(storage);
  AccountRegistry.load(dataDir).setOwner(id, null);
  return outcome;
}

/** The lines a logout prints, the same whether the CLI or the running server did the work. */
export function logoutLines(outcome: LogoutOutcome): string[] {
  switch (outcome) {
    case "not_linked":
      return [info("Not linked.")];
    case "logged_out":
      return [ok("Logged out. Local credentials deleted.")];
    case "already_unlinked":
      return [info("WhatsApp had already unlinked this device."), ok("Logged out. Local credentials deleted.")];
    case "unlink_unconfirmed":
      return [
        warn("Could not tell WhatsApp to unlink; remove this device from your phone if it is still listed."),
        ok("Logged out. Local credentials deleted."),
      ];
    default: {
      const _never: never = outcome;
      return [fail(String(_never))];
    }
  }
}
