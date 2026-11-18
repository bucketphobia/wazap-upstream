/**
 * The version installed on disk against the version this process runs. npm
 * replaces a global install's files under a running server without telling it,
 * so a service updated by `npm i -g`, `wazap update` or a package manager keeps
 * running the old code until something restarts it. The server the supervisor
 * runs watches its own package.json and, once a different version has settled
 * there, stops cleanly so the supervisor (launchd KeepAlive, systemd
 * Restart=always) starts the new one. Any server reports the drift in
 * get_status.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WAZAP_VERSION } from "./config.js";

/** This build's own package.json: the file an upgrade of this install rewrites. */
export const PACKAGE_FILE: string = fileURLToPath(new URL("../package.json", import.meta.url));

/** How often the service looks; an upgrade is picked up within two of these. */
export const VERSION_CHECK_MS = 60_000;

/** The version in a package.json, or null when it cannot be read (mid-install, removed). */
export function versionOnDisk(file: string = PACKAGE_FILE): string | null {
  try {
    const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
    return typeof version === "string" && version !== "" ? version : null;
  } catch {
    return null;
  }
}

/** The installed version when it is not the one running, else null. */
export function installedDrift(running: string = WAZAP_VERSION, read: () => string | null = versionOnDisk): string | null {
  const onDisk = read();
  return onDisk !== null && onDisk !== running ? onDisk : null;
}

export interface VersionWatchOptions {
  running?: string;
  read?: () => string | null;
  everyMs?: number;
  /** Called once, with the version that settled on disk. */
  onUpgrade: (installed: string) => void;
}

/**
 * Calls `onUpgrade` once the version on disk has differed from the running one
 * on two checks in a row with the same value: npm writes package.json and
 * dist/ over several seconds, and one read in the middle is not an upgrade.
 * Returns the stop function; `tick` is exposed for tests.
 */
export function watchInstalledVersion(opts: VersionWatchOptions): { stop: () => void; tick: () => void } {
  const running = opts.running ?? WAZAP_VERSION;
  const read = opts.read ?? versionOnDisk;
  let seen: string | null = null;
  let fired = false;
  const tick = (): void => {
    if (fired) return;
    const drift = installedDrift(running, read);
    if (drift === null) {
      seen = null;
      return;
    }
    if (seen === drift) {
      fired = true;
      opts.onUpgrade(drift);
      return;
    }
    seen = drift;
  };
  const timer = setInterval(tick, opts.everyMs ?? VERSION_CHECK_MS);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
