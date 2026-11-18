/** Opening a WhatsApp socket for the sole purpose of linking a device. */

import { setTimeout as sleep } from "node:timers/promises";
import makeWASocket, { Browsers, DisconnectReason, type UserFacingSocketConfig, type WASocket } from "baileys";
import { readLinkedAccount, useAtomicAuthState, withoutAppStateSync, type LinkedAccount } from "./auth-state.js";
import { WazapError, asWazapError } from "./errors.js";
import { logError } from "./logger.js";

/**
 * The browser identity sent at handshake. WhatsApp closes the socket with 428
 * before offering a QR for Browsers.macOS("Desktop") (verified 2026-08-22 on
 * baileys 7.0.0-rc14); "Chrome" is accepted.
 */
export const WA_BROWSER = Browsers.macOS("Chrome");

/** Baileys' default logger is a pino instance writing JSON to stdout. */
type SocketLogger = NonNullable<UserFacingSocketConfig["logger"]>;
const SILENT_LOGGER: SocketLogger = {
  level: "silent",
  child: () => SILENT_LOGGER,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** The seam the tests replace; production always opens a real WhatsApp socket, for pairing and for the service. */
export const socketFactory = { open: makeWASocket };

/** How long a pairing code stays good for, and how long a link attempt runs. */
export const PAIRING_TIMEOUT_MS = 120_000;
/** How long WhatsApp gets to hand back the code before the attempt is abandoned. */
const CODE_TIMEOUT_MS = 10_000;

type Attempt =
  { kind: "open" } | { kind: "restart" } | { kind: "closed"; statusCode?: number } | { kind: "failed"; error: unknown };

export interface LinkOptions {
  deadline: number;
  /** Ends the session early, the way the deadline does. */
  abort?: AbortSignal;
  /** Every QR the server offers. Absent when the caller only reuses stored credentials. */
  onQr?: (qr: string, sock: WASocket) => Promise<void>;
}

/**
 * A socket run until it is open, retrying across the restart WhatsApp demands
 * right after a successful pairing. The returned socket is the caller's to end.
 */
export async function linkSession(authDir: string, opts: LinkOptions): Promise<WASocket> {
  let current: WASocket | null = null;
  let expired = false;
  const giveUp = (): void => {
    expired = true;
    void current?.end(undefined);
  };
  const timer = setTimeout(giveUp, Math.max(0, opts.deadline - Date.now()));
  opts.abort?.addEventListener("abort", giveUp, { once: true });

  try {
    for (;;) {
      // Also checked here: a restart landing just before the deadline would
      // otherwise open a socket the timer can no longer reach.
      if (expired) throw timedOut();
      const { state, saveCreds } = await useAtomicAuthState(authDir);
      // This socket pairs and nothing else. It has no store, so anything it
      // syncs is thrown away — and WhatsApp sends the history and the address
      // book once. Refusing the history keeps it out of Baileys' sync state
      // machine, which is what would otherwise bump `accountSyncCounter` and
      // leave the service permanently past its own first sync.
      const sock = socketFactory.open({
        auth: withoutAppStateSync(state),
        browser: WA_BROWSER,
        markOnlineOnConnect: false,
        shouldSyncHistoryMessage: () => false,
        logger: SILENT_LOGGER,
      });
      current = sock;
      sock.ev.on("creds.update", () => void saveCreds().catch((err: unknown) => logError("creds save", err)));

      const attempt = await new Promise<Attempt>((resolve) => {
        sock.ev.on("connection.update", (update) => {
          if (update.qr && opts.onQr) {
            void opts.onQr(update.qr, sock).catch((error: unknown) => resolve({ kind: "failed", error }));
          }
          if (update.connection === "open") resolve({ kind: "open" });
          if (update.connection === "close") {
            const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
              ?.output?.statusCode;
            resolve(
              statusCode === DisconnectReason.restartRequired ? { kind: "restart" } : { kind: "closed", statusCode }
            );
          }
        });
      });

      if (attempt.kind === "open") return sock;
      await sock.end(undefined);
      current = null;
      if (attempt.kind === "restart") continue;
      if (expired) throw timedOut();
      if (attempt.kind === "failed") throw asWazapError(attempt.error);
      if (attempt.statusCode === DisconnectReason.loggedOut) {
        throw new WazapError(
          "SESSION_EXPIRED",
          "WhatsApp rejected the link. The code may have expired or been entered wrong.",
          "Call link_account again for a new code"
        );
      }
      throw new WazapError(
        "WHATSAPP_ERROR",
        `WhatsApp closed the connection (code ${attempt.statusCode ?? "unknown"}).`
      );
    }
  } finally {
    clearTimeout(timer);
    opts.abort?.removeEventListener("abort", giveUp);
  }
}

function timedOut(): WazapError {
  return new WazapError("TIMEOUT", "WhatsApp did not answer in time.", "Check your connection and try again");
}

/** The freshly linked account. `creds.update` can land a beat after the connection opens. */
export async function settledAccount(sock: WASocket, authDir: string): Promise<LinkedAccount> {
  const number = (sock.user?.id ?? "").split(":")[0]!.split("@")[0]!;
  const fromSocket: LinkedAccount = { id: `${number}@s.whatsapp.net`, name: sock.user?.name ?? "", number };
  if (fromSocket.name) return fromSocket;
  await sleep(750);
  return readLinkedAccount(authDir) ?? fromSocket;
}

/** The 8 characters WhatsApp issues, grouped the way the phone shows them. */
export function prettyCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export interface Pairing {
  code: string;
  expiresAt: number;
  /** Resolves once the socket opens and the account has settled; rejects on expiry or rejection. */
  done: Promise<LinkedAccount>;
  /** Ends the link early, the way the deadline does; `done` then rejects. */
  cancel: () => void;
}

/**
 * A pairing code, handed back as soon as WhatsApp issues it; the link itself
 * runs on in `done`. That socket is ended before `done` resolves, so the caller
 * can open the real one without ever holding two on the same session.
 */
export async function startPairing(authDir: string, phone: string, deadlineMs: number): Promise<Pairing> {
  const deadline = Date.now() + deadlineMs;
  const abort = new AbortController();
  let issue!: (code: string) => void;
  let refuse!: (err: unknown) => void;
  const issued = new Promise<string>((resolve, reject) => {
    issue = resolve;
    refuse = reject;
  });

  let requested = false;
  const done = (async () => {
    const sock = await linkSession(authDir, {
      deadline,
      abort: abort.signal,
      onQr: async (_qr, socket) => {
        if (requested) return;
        requested = true;
        issue(await socket.requestPairingCode(phone));
      },
    });
    try {
      return await settledAccount(sock, authDir);
    } finally {
      await sock.end(undefined);
    }
  })();
  done.catch(refuse);

  const codeTimer = setTimeout(() => refuse(timedOut()), Math.min(CODE_TIMEOUT_MS, deadlineMs));
  try {
    return { code: await issued, expiresAt: deadline, done, cancel: () => abort.abort() };
  } catch (err) {
    abort.abort();
    throw err;
  } finally {
    clearTimeout(codeTimer);
  }
}
