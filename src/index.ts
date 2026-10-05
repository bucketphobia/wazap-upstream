#!/usr/bin/env node
// First, so no module below it can print to stdout while it loads.
import "./console-guard-install.js";
import { BANNER } from "./banner.js";
import {
  runAccount,
  runContacts,
  runEmbed,
  runGreet,
  runLogin,
  runLogout,
  runMigrate,
  runServe,
  runStatus,
  runTranscribe,
} from "./cli.js";
import { runBackup } from "./backup-cli.js";
import { BAILEYS_VERSION, WAZAP_VERSION, parseCli, pickDefaultAction, settingWarnings } from "./config.js";
import { migrateLayout } from "./migrate.js";
import { CLIENT_NAMES, runConnect } from "./connect.js";
import { SKILL_TARGET_NAMES, runSkills } from "./skills.js";
import { PROVIDER_NAMES, runExpose } from "./expose.js";
import { SERVICE_VERBS, runService } from "./service.js";
import { runSetup } from "./setup.js";
import { runUpdate } from "./update.js";
import { runConfig, runWebhook } from "./settings.js";
import { WazapError } from "./errors.js";
import { logError, say } from "./logger.js";
import { fail, fix, warn } from "./ui.js";

// A promise that fails with nobody listening must still be seen. A thrown
// exception outside any await means the process state is no longer
// trustworthy, so it goes down loudly for its supervisor to bring back.
process.on("unhandledRejection", (err) => logError("unhandled rejection", err));
process.on("uncaughtException", (err) => {
  logError("uncaught exception", err);
  process.exit(1);
});

const USAGE = `${BANNER}

Usage:
  wazap [serve] [--http] [--host <host>] [--port <port>]   Run the MCP server (default: stdio)
  wazap login [--phone +15550100] [--code]              Link a WhatsApp account (QR by default)
  wazap setup [--agent] [--client <name>]                  Link, connect your client and finish, in one command
  wazap connect <client> [--dry-run]                       Register wazap with an MCP client
  wazap skills install [<harness>] [--dry-run]              Copy the five skills into a harness, or into every one found
  wazap service ${SERVICE_VERBS}
                                                           Keep the server running in the background, under launchd or systemd
  wazap expose [tailscale|cloudflare|off]                  Give the running service a public https URL cloud agents can reach
  wazap config [writes on|off] [transcribe local|openai|off] [recall local|off] [webhook on|off|chats|tag|coalesce] [draft-context on|off]
                                                           Show the effective settings, or change one
  wazap webhook test [--event <name>] [--account <id>]     POST a test event to the configured webhook
  wazap transcribe download [--model <alias>]              Fetch the whisper.cpp model into the data dir
  wazap transcribe test <audio file>                       Transcribe a local file with the configured provider
  wazap embed download [--model <alias>]                   Fetch the llama.cpp embedding model for semantic recall
  wazap contacts resync                                    Fetch the phone's address book from WhatsApp again
  wazap update [--dry-run]                                 Upgrade wazap, then the service and the skills that follow it
  wazap status [--live] [--json] [--account <id>]          Check the install, the session and the server
  wazap logout [--account <id>]                            Unlink and delete local credentials
  wazap account add <id> [--name <name>] [--json]          Add an account slot; --json: {account_id, created, enabled}, 0 if it exists
  wazap account remove|enable|disable|default <id>         Change an account, or delete its local data
  wazap account list                                       List accounts in this data dir
  wazap backup <path> [--account <id>] [--force]           Copy an account database to <path>; the messages in it are not encrypted
  wazap migrate rollback                                   Undo a flat-layout move into accounts/

Clients for wazap connect: ${CLIENT_NAMES}.
Harnesses for wazap skills install: ${SKILL_TARGET_NAMES}. wazap setup does this for the clients it connects.
Tunnel providers for wazap expose: ${PROVIDER_NAMES}.

Options:
  --data-dir <path>   Where wazap keeps its data (default ~/.wazap, or $WAZAP_DATA_DIR)
  --account <id>      With login, logout, status, contacts, backup, config writes|webhook, webhook test:
                      pick this account. A running server applies account add|enable|disable|default|remove
  --event <name>      With webhook test: message_received (default), message_sent or connection
  --name <name>       With account add: a display name
  --read-only         Refuse every write; the write tools are not registered at all
  --http              Serve Streamable HTTP instead of stdio
  --host <host>       HTTP bind address (default 127.0.0.1)
  --port <port>       HTTP port (default 8766)
  --code              Log in with an 8-character pairing code instead of the QR
  --phone <number>    Your number in international format; implies --code
  --agent             With setup: print the procedure for an AI agent on stdout, then exit
  --client <name>     With setup: connect this client instead of the detected ones (repeatable)
  --no-global         With setup: keep running from the npx cache instead of installing globally
  --no-brew           Never offer to install a missing whisper-cpp, ffmpeg or tailscale with Homebrew
  --relaunch          With setup: restart Claude Desktop after connecting it, without asking
  --transcribe <how>  With setup: answer the transcription question (local, openai or off)
  --service           With setup: keep wazap running on this machine, without asking
  --expose            With setup: also give it a public URL cloud agents can reach
  --model <alias>     With transcribe download: turbo (default), large-v3 or medium.
                      With embed download: embeddinggemma-300m (default) or e5-base-multilingual
  --dry-run           With connect, skills install, service install or update: print what would happen, and do nothing
  --force             With backup: replace a file already at the destination
  --live              With status: reach WhatsApp for real, then close the connection
  --json              With status, --version or account add: print one JSON object on stdout
  --writes            Allow the agent to write, without login asking
  --no-writes         Keep the agent read-only, without login asking
  -y, --yes           Do not ask anything at the end of login
  -h, --help          Show this help
  -v, --version       Show the version; with --json, one JSON object on stdout

Environment: WAZAP_DATA_DIR, WAZAP_READ_ONLY, WAZAP_PERSIST_HISTORY, WAZAP_HOST, WAZAP_PORT, WAZAP_READ_TOKEN, WAZAP_WRITE_TOKEN,
WAZAP_PUBLIC_URL, WAZAP_OAUTH_PASSWORD, WAZAP_TRUST_PROXY, WAZAP_TRANSCRIBE, WAZAP_TRANSCRIBE_API_KEY,
WAZAP_RECALL, WAZAP_WEBHOOK, WAZAP_WEBHOOK_URL, WAZAP_WEBHOOK_SECRET, WAZAP_WEBHOOK_EVENTS, WAZAP_WEBHOOK_AUTH,
WAZAP_WEBHOOK_CHATS, WAZAP_WEBHOOK_TAG, WAZAP_WEBHOOK_COALESCE, WAZAP_WEBHOOK_RETRY_401,
WAZAP_RETENTION, WAZAP_PRE_MIGRATION_BACKUP.
An optional <data-dir>/.env is loaded if present.`;

async function main(): Promise<void> {
  const invocation = parseCli();
  if (invocation.kind === "help") {
    say(USAGE);
    return;
  }
  if (invocation.kind === "version") {
    // Plain, it is for a person, on stderr like every other line; --json is for a script, on stdout.
    if (invocation.json) {
      process.stdout.write(`${JSON.stringify({ version: WAZAP_VERSION, baileys: BAILEYS_VERSION, node: process.versions.node })}\n`);
      return;
    }
    say(WAZAP_VERSION);
    return;
  }

  const { config } = invocation;
  for (const line of settingWarnings()) say(warn(line));
  // Rollback is the inverse of this move. Running it first would re-apply a
  // half-finished migrate and then fail to undo it. The other exempt commands
  // never open account state, and `service stop` is how a lock that blocks the
  // migration is released.
  const MIGRATE_EXEMPT: ReadonlySet<string> = new Set([
    "migrate",
    "service",
    "connect",
    "skills",
    "expose",
    "update",
    "transcribe",
    "embed",
  ]);
  if (!MIGRATE_EXEMPT.has(config.command)) migrateLayout(config.dataDir);
  switch (config.command) {
    case "serve":
      if (pickDefaultAction(config, process.stdin.isTTY === true, process.stderr.isTTY === true) === "greet") {
        await runGreet(config);
        return;
      }
      await runServe(config);
      return;
    case "login":
      await runLogin(config);
      return;
    case "setup":
      await runSetup(config);
      return;
    case "connect":
      runConnect(config);
      return;
    case "skills":
      runSkills(config);
      return;
    case "service":
      await runService(config);
      return;
    case "expose":
      await runExpose(config);
      return;
    case "config":
      await runConfig(config);
      return;
    case "transcribe":
      await runTranscribe(config);
      return;
    case "embed":
      await runEmbed(config);
      return;
    case "contacts":
      await runContacts(config);
      return;
    case "update":
      await runUpdate(config);
      return;
    case "status":
      await runStatus(config);
      return;
    case "logout":
      await runLogout(config);
      return;
    case "webhook":
      await runWebhook(config);
      return;
    case "account":
      await runAccount(config);
      return;
    case "backup":
      await runBackup(config);
      return;
    case "migrate":
      runMigrate(config);
      return;
    default: {
      const _exhaustive: never = config.command;
      return _exhaustive;
    }
  }
}

main().catch((err: unknown) => {
  say(fail(err instanceof Error ? err.message : String(err)));
  if (err instanceof WazapError && err.fix) say(fix(err.fix));
  process.exit(1);
});
