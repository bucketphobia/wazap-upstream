/** The explicit desktop/offline import command. Never shares a writer with serve. */
import { accountPolicy, resolveAccount } from "../accounts.js";
import { paths, type Config } from "../config.js";
import { AccountDb } from "../db/index.js";
import { WazapError } from "../errors.js";
import { releaseLock, writeLock } from "../lock.js";
import { say } from "../logger.js";
import { readTranscribeSettings } from "../transcribe/index.js";
import { importIos } from "./index.js";

export async function runIosImport(config: Config): Promise<void> {
  if (config.args[0] !== "ios" || !config.args[1])
    throw new WazapError(
      "INVALID_ID",
      "Usage: wazap import ios <ChatStorage.sqlite> [--media <dir>] [--dry-run] [--reset] [--json]"
    );
  if (config.importReset && config.dryRun)
    throw new WazapError("INVALID_ID", "--reset changes import state and cannot be used with --dry-run.");
  if (!config.persistHistory && !config.dryRun)
    throw new WazapError("INVALID_ID", "iPhone import needs WAZAP_PERSIST_HISTORY=1.");
  const { paths: account, account: record } = resolveAccount(config.dataDir, config.accountId);
  const lock = paths(config.dataDir).lockFile;
  // Dry runs need no writer and must not create or migrate the target database.
  if (!config.dryRun && !writeLock(lock))
    throw new WazapError("SERVICE_ERROR", "Stop the server before running an iPhone import.");
  let db: AccountDb | null = null;
  try {
    db = AccountDb.open(account.databaseFile, { readOnly: config.dryRun });
    if (!config.dryRun) await db.resume();
    const settings = readTranscribeSettings(process.env, config.dataDir);
    const permitted = !(settings.provider === "openai" && accountPolicy(record, config).readOnly && !settings.allowApi);
    const report = await importIos({
      db,
      source: config.args[1],
      media: config.importMedia,
      dryRun: config.dryRun,
      explicit: true,
      reset: config.importReset,
      settings: permitted ? settings : undefined,
    });
    say(
      config.json
        ? JSON.stringify(report)
        : `iPhone import: ${report.state}; ${report.inserted} inserted, ${report.skippedExisting} existing, ${report.quarantined} quarantined.`
    );
  } finally {
    db?.close();
    if (!config.dryRun) releaseLock(lock);
  }
}
