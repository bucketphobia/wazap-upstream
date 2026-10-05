import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AccountRegistry, accountPolicy, draftContextEnabled, parseAccountId, resolveAccount } from "../dist/accounts.js";
import { accountPaths, paths } from "../dist/config.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, DEFAULT_ACCOUNT, offlineConfig, openService } from "./helpers.mjs";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function dataDir() {
  return mkdtempSync(join(tmpdir(), "wazap-accounts-"), { mode: 0o700 });
}

function wazap(dir, args) {
  return run(process.execPath, [binary, ...args, "--data-dir", dir], {
    env: { ...process.env, WAZAP_NO_UPDATE_CHECK: "1" },
  });
}

test("parseAccountId accepts a 32-character slug and refuses the rest", () => {
  assert.equal(parseAccountId("default"), "default");
  assert.equal(parseAccountId("a"), "a");
  assert.equal(parseAccountId("work-2"), "work-2");
  assert.throws(
    () => parseAccountId("Default"),
    (err) => err.code === "INVALID_ID"
  );
  assert.throws(
    () => parseAccountId("-work"),
    (err) => err.code === "INVALID_ID"
  );
  assert.throws(
    () => parseAccountId("a".repeat(33)),
    (err) => err.code === "INVALID_ID"
  );
});

test("a missing accounts.json is a default account in memory, not a crash", () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  assert.equal(registry.defaultId(), "default");
  assert.equal(existsSync(paths(dir).accountsFile), false);
  const account = registry.get("default");
  assert.equal(account.id, "default");
  assert.equal(account.enabled, true);
  assert.equal(account.owner, null);
});

test("add, list, enable, disable and remove persist through a reload", () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  registry.add("work", "Work phone");
  assert.equal(statSync(paths(dir).accountsFile).mode & 0o777, 0o600);
  assert.equal(statSync(accountPaths(dir, "work").root).mode & 0o777, 0o700);

  const loaded = AccountRegistry.load(dir);
  assert.deepEqual(
    loaded.all().map((account) => account.id),
    ["default", "work"]
  );
  assert.equal(loaded.get("work").name, "Work phone");
  loaded.disable("work");
  assert.equal(AccountRegistry.load(dir).get("work").enabled, false);
  loaded.enable("work");
  assert.equal(AccountRegistry.load(dir).get("work").enabled, true);

  loaded.remove("work");
  assert.equal(existsSync(accountPaths(dir, "work").root), false);
  assert.equal(AccountRegistry.load(dir).get("work"), undefined);
  assert.equal(AccountRegistry.load(dir).defaultId(), "default");
});

test("remove refuses the last account and a missing id", () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  assert.throws(
    () => registry.remove("default"),
    (err) => err.code === "INVALID_ID"
  );
  registry.add("work");
  assert.throws(
    () => registry.remove("nope"),
    (err) => err.code === "INVALID_ID"
  );
});

test("resolveAccount uses --account or the default, and unknown ids fail", () => {
  const dir = dataDir();
  AccountRegistry.load(dir).add("work");
  assert.equal(resolveAccount(dir).account.id, "default");
  assert.equal(resolveAccount(dir, "work").account.id, "work");
  assert.throws(
    () => resolveAccount(dir, "ghost"),
    (err) => err.code === "INVALID_ID"
  );
});

test("getStatus carries the registry id and name", () => {
  const { svc } = connectedService(WhatsAppService, {
    prefix: "wazap-acct-status-",
    id: "1@s.whatsapp.net",
    name: "Ada",
  });
  const status = svc.getStatus();
  assert.equal(status.account_id, "default");
  assert.equal(status.account_name, "default");
  assert.equal(status.enabled, true);
  assert.equal(status.write_tools, false);
  assert.equal(status.account.name, "Ada");
});

test("wazap account list on a fresh dir prints the synthesized default", async () => {
  const dir = dataDir();
  const { stderr } = await wazap(dir, ["account", "list"]);
  assert.match(stderr, /default {2}enabled {2}not linked {2}\(default\)/);
});

test("wazap account add/remove/enable/disable round-trip through the binary", async () => {
  const dir = dataDir();
  await wazap(dir, ["account", "add", "work", "--name", "Work"]);
  const listed = await wazap(dir, ["account", "list"]);
  assert.match(listed.stderr, /work {2}enabled {2}not linked/);
  assert.match(listed.stderr, /Work|work/);

  await wazap(dir, ["account", "disable", "work"]);
  assert.match((await wazap(dir, ["account", "list"])).stderr, /work {2}disabled/);

  await wazap(dir, ["account", "enable", "work"]);
  assert.match((await wazap(dir, ["account", "list"])).stderr, /work {2}enabled/);

  await wazap(dir, ["account", "remove", "work", "--yes"]);
  assert.equal(existsSync(accountPaths(dir, "work").root), false);
  assert.doesNotMatch((await wazap(dir, ["account", "list"])).stderr, /^work /m);
});

test("setWebhook persists url and secret through a reload", () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  registry.add("work", "Work");
  registry.setWebhook("work", { url: "https://hooks.example/work///", secret: "work-secret" });
  const loaded = AccountRegistry.load(dir).get("work");
  assert.equal(loaded.webhook_url, "https://hooks.example/work");
  assert.equal(loaded.webhook_secret, "work-secret");
  assert.equal(AccountRegistry.load(dir).get("default").webhook_url, undefined);
});

test("setWebhook refuses an empty url or secret", () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  registry.add("work", "Work");
  assert.throws(
    () => registry.setWebhook("work", { url: "   " }),
    (err) => {
      assert.equal(err.code, "INVALID_ID");
      assert.match(err.message, /webhook_url/);
      return true;
    }
  );
  assert.throws(
    () => registry.setWebhook("work", { secret: "" }),
    (err) => {
      assert.equal(err.code, "INVALID_ID");
      assert.match(err.message, /webhook_secret/);
      return true;
    }
  );
  assert.equal(AccountRegistry.load(dir).get("work").webhook_url, undefined);
  assert.equal(AccountRegistry.load(dir).get("work").webhook_secret, undefined);
});

test("a bad webhook_url in accounts.json is refused", () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  registry.save();
  writeFileSync(
    paths(dir).accountsFile,
    JSON.stringify({
      v: 2,
      default: "default",
      accounts: [{ id: "default", name: "default", enabled: true, owner: null, webhook_url: "" }],
    })
  );
  assert.throws(
    () => AccountRegistry.load(dir),
    (err) => {
      assert.equal(err.code, "INVALID_ID");
      assert.match(err.message, /webhook_url/);
      return true;
    }
  );
});

test("an unknown webhook_events in accounts.json is refused, naming the account and the token", () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  registry.add("work", "Work");
  writeFileSync(
    paths(dir).accountsFile,
    JSON.stringify({
      v: 2,
      default: "default",
      accounts: [{ id: "work", name: "Work", enabled: true, owner: null, webhook_events: "connection,frobnicate" }],
    })
  );
  assert.throws(
    () => AccountRegistry.load(dir),
    (err) => {
      assert.equal(err.code, "INVALID_ID");
      assert.match(err.message, /Account "work".*webhook_events.*frobnicate/);
      assert.match(err.fix, /accounts\.json/);
      return true;
    }
  );
});

test("webhook_chats and webhook_tag round-trip, and a bad chat is refused", () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  registry.add("work", "Work");
  registry.setWebhookChats("work", ["+40 722 000 002", "120363000000000001@g.us"]);
  registry.setWebhookTag("work", "#Autopeloc");
  registry.setWebhookCoalesce("work", 90);
  registry.setWebhookRetry401("work", true);
  const work = AccountRegistry.load(dir).get("work");
  assert.deepEqual(work.webhook_chats, ["40722000002", "120363000000000001@g.us"]);
  assert.equal(work.webhook_tag, "autopeloc");
  assert.equal(work.webhook_coalesce, 90);
  assert.equal(work.webhook_retry_401, true);

  writeFileSync(
    paths(dir).accountsFile,
    JSON.stringify({
      v: 2,
      default: "default",
      accounts: [{ id: "work", name: "Work", enabled: true, owner: null, webhook_chats: ["not a chat"] }],
    })
  );
  assert.throws(
    () => AccountRegistry.load(dir),
    (err) => {
      assert.equal(err.code, "INVALID_ID");
      assert.match(err.message, /webhook_chats/);
      return true;
    }
  );
});

test("config writes --account stores the override in accounts.json, not .env", async () => {
  const dir = dataDir();
  await wazap(dir, ["account", "add", "work"]);
  const { stderr } = await wazap(dir, ["config", "writes", "off", "--account", "work"]);
  assert.match(stderr, /writes: off for work/);
  assert.equal(existsSync(join(dir, ".env")), false);
  const file = JSON.parse(readFileSync(paths(dir).accountsFile, "utf8"));
  assert.equal(file.accounts.find((account) => account.id === "work").writes, false);
});

test("draft_context is on unless the record says false; the setter records only the exception", () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  registry.add("work", "Work");
  assert.equal(draftContextEnabled(registry.get("work")), true);
  registry.setDraftContext("work", false);
  assert.equal(AccountRegistry.load(dir).get("work").draft_context, false);
  assert.equal(draftContextEnabled(AccountRegistry.load(dir).get("work")), false);
  assert.equal(draftContextEnabled(AccountRegistry.load(dir).get("default")), true, "another account is untouched");
  registry.setDraftContext("work", true);
  assert.equal("draft_context" in AccountRegistry.load(dir).get("work"), false);

  writeFileSync(
    paths(dir).accountsFile,
    JSON.stringify({ v: 2, default: "default", accounts: [{ id: "default", name: "default", enabled: true, owner: null, draft_context: "no" }] })
  );
  assert.throws(() => AccountRegistry.load(dir), (err) => err.code === "INVALID_ID" && /draft_context/.test(err.message));
});

test("config draft-context off --account turns one account's draft context off in accounts.json, and config shows it", async () => {
  const dir = dataDir();
  await wazap(dir, ["account", "add", "work"]);
  const { stderr } = await wazap(dir, ["config", "draft-context", "off", "--account", "work"]);
  assert.match(stderr, /draft context \(work\): off/);
  const file = JSON.parse(readFileSync(paths(dir).accountsFile, "utf8"));
  assert.equal(file.accounts.find((account) => account.id === "work").draft_context, false);
  assert.equal(file.accounts.find((account) => account.id === "default").draft_context, undefined);
  assert.match((await wazap(dir, ["config", "--account", "work"])).stderr, /draft context: off \(accounts\.json\)/);
  assert.match((await wazap(dir, ["config"])).stderr, /draft context: on \(default\)/);
  await wazap(dir, ["config", "draft-context", "on", "--account", "work"]);
  assert.match((await wazap(dir, ["config", "--account", "work"])).stderr, /draft context: on \(default\)/);
  await assert.rejects(wazap(dir, ["config", "draft-context", "maybe"]), (err) => /draft-context on\|off/.test(err.stderr));
});

test("config writes without --account still writes WAZAP_READ_ONLY", async () => {
  const dir = dataDir();
  await wazap(dir, ["config", "writes", "off"]);
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /WAZAP_READ_ONLY=1/);
});

test("a directory named accounts.json is an error, not a synthesized default", () => {
  const dir = dataDir();
  mkdirSync(join(dir, "accounts.json"));
  assert.throws(
    () => AccountRegistry.load(dir),
    (err) => {
      assert.equal(err.code, "INVALID_ID");
      assert.match(err.message, /missing or unreadable/);
      return true;
    }
  );
});

test("accountPolicy: --read-only wins, writes false turns one account off", () => {
  const account = { ...DEFAULT_ACCOUNT, writes: true };
  assert.equal(accountPolicy(account, { readOnly: true, rateLimitPerMinute: 20 }).readOnly, true);
  assert.equal(
    accountPolicy({ ...DEFAULT_ACCOUNT, writes: false }, { readOnly: false, rateLimitPerMinute: 20 }).readOnly,
    true
  );
  assert.equal(accountPolicy(DEFAULT_ACCOUNT, { readOnly: false, rateLimitPerMinute: 20 }).readOnly, false);
  assert.equal(
    accountPolicy({ ...DEFAULT_ACCOUNT, rate_limit: 5 }, { readOnly: false, rateLimitPerMinute: 20 }).rateLimit,
    5
  );
});

test("WhatsAppService honors writes and rate_limit from the record", () => {
  const config = offlineConfig("wazap-acct-policy-", { readOnly: false, rateLimitPerMinute: 20 });
  const svc = openService(WhatsAppService, config);
  assert.equal(svc.getStatus().read_only, false);
  assert.equal(svc.getStatus().rate_limit, 20);

  const locked = new WhatsAppService(
    config,
    { ...DEFAULT_ACCOUNT, writes: false, rate_limit: 3 },
    accountPaths(config.dataDir, "default")
  );
  assert.equal(locked.getStatus().read_only, true);
  assert.equal(locked.getStatus().rate_limit, 3);
});

test("account remove without --yes on a non-TTY refuses", async () => {
  const dir = dataDir();
  await wazap(dir, ["account", "add", "work"]);
  await assert.rejects(wazap(dir, ["account", "remove", "work"]), (err) => {
    assert.match(err.stderr, /without --yes/);
    return true;
  });
  assert.equal(existsSync(accountPaths(dir, "work").root), true);
});

test("unknown --account through the binary fails", async () => {
  const dir = dataDir();
  await assert.rejects(wazap(dir, ["status", "--account", "ghost"]), (err) => {
    assert.match(err.stderr, /No account "ghost"/);
    return true;
  });
});

test("serve refuses --account", async () => {
  const dir = dataDir();
  await assert.rejects(wazap(dir, ["serve", "--account", "default"]), (err) => {
    assert.match(err.stderr, /starts every enabled account/);
    return true;
  });
});

test("config writes --account shows the override on wazap config", async () => {
  const dir = dataDir();
  await wazap(dir, ["account", "add", "work"]);
  await wazap(dir, ["config", "writes", "off", "--account", "work"]);
  const { stderr } = await wazap(dir, ["config", "--account", "work"]);
  assert.match(stderr, /writes: off \(accounts\.json\)/);
});

test("status --json on one account keeps linked/account and adds accounts[]", async () => {
  const dir = dataDir();
  mkdirSync(join(dir, "auth"), { recursive: true });
  writeFileSync(
    join(dir, "auth", "creds.json"),
    JSON.stringify({ registered: true, me: { id: "15550100:1@s.whatsapp.net", name: "Test" } })
  );
  const { stdout, stderr } = await wazap(dir, ["status", "--json"]);
  const report = JSON.parse(stdout);
  assert.equal(report.linked, true);
  assert.equal(report.account.name, "Test");
  assert.equal(report.accounts.length, 1);
  assert.equal(report.accounts[0].id, "default");
  assert.equal(report.accounts[0].account.name, "Test");
  assert.doesNotMatch(stderr, /accounts:/);
});

test("status --json is linked when any account is, not only the selected", async () => {
  const dir = dataDir();
  AccountRegistry.load(dir).add("work");
  mkdirSync(accountPaths(dir, "work").authDir, { recursive: true });
  writeFileSync(
    join(accountPaths(dir, "work").authDir, "creds.json"),
    JSON.stringify({ registered: true, me: { id: "40700000002:5@s.whatsapp.net", name: "Work" } })
  );
  const { stdout } = await wazap(dir, ["status", "--json"]);
  const report = JSON.parse(stdout);
  assert.equal(report.linked, true, "a linked work must not read as unlinked because default is not");
  assert.equal(report.account, null, "the selected account is still the unlinked default");
  assert.equal(report.accounts.length, 2);
  assert.equal(report.accounts[1].account.name, "Work");
  // The human layout prints the per-account block only without --json.
  const human = await wazap(dir, ["status"]);
  assert.match(human.stderr, /accounts:/);
  const creds = report.checks.find((check) => check.name === "credentials");
  assert.equal(creds.state, "ok");
  assert.match(creds.detail, /readable \(work\)/);
});

test("wazap account default moves the default, and a running server gets the restart hint", async () => {
  const dir = dataDir();
  await wazap(dir, ["account", "add", "work"]);
  const { stderr } = await wazap(dir, ["account", "default", "work"]);
  assert.match(stderr, /Default account: "work"/);
  assert.equal(JSON.parse(readFileSync(paths(dir).accountsFile, "utf8")).default, "work");
  assert.match((await wazap(dir, ["account", "list"])).stderr, /work {2}enabled {2}not linked {2}\(default\)/);

  await wazap(dir, ["account", "default", "default"]);
  assert.equal(JSON.parse(readFileSync(paths(dir).accountsFile, "utf8")).default, "default");
});

test("wazap account default refuses an unknown id", async () => {
  const dir = dataDir();
  await assert.rejects(wazap(dir, ["account", "default", "ghost"]), (err) => {
    assert.match(err.stderr, /No account "ghost"/);
    assert.match(err.stderr, /wazap account list/);
    return true;
  });
});

test("account add/enable/disable/default warn that a running server they cannot reach needs a restart", async () => {
  const dir = dataDir();
  writeFileSync(paths(dir).lockFile, `${process.pid}\n`, { mode: 0o600 });
  const running = new RegExp(`A server is running \\(pid ${process.pid}\\); restart it`);
  assert.match((await wazap(dir, ["account", "add", "work"])).stderr, running);
  assert.match((await wazap(dir, ["account", "disable", "work"])).stderr, running);
  assert.match((await wazap(dir, ["account", "enable", "work"])).stderr, running);
  assert.match((await wazap(dir, ["account", "default", "work"])).stderr, running);
});

test("account remove on a client-held lock names the kill, not a service verb", async () => {
  const dir = dataDir();
  await wazap(dir, ["account", "add", "work"]);
  writeFileSync(paths(dir).lockFile, `${process.pid}\n`, { mode: 0o600 });
  await assert.rejects(wazap(dir, ["account", "remove", "work", "--yes"]), (err) => {
    assert.match(err.stderr, new RegExp(`stop it first: kill ${process.pid}`));
    assert.doesNotMatch(err.stderr, /service stop/);
    return true;
  });
  assert.equal(existsSync(accountPaths(dir, "work").root), true);
});

test("account list shows the remembered owner of an unlinked account, masked", async () => {
  const dir = dataDir();
  const registry = AccountRegistry.load(dir);
  registry.add("work", "Work");
  registry.setOwner("work", "40700000002:5@s.whatsapp.net");
  const { stderr } = await wazap(dir, ["account", "list"]);
  assert.match(stderr, /work {2}enabled {2}was \+40 7xx xxx xxx/);
  assert.ok(!stderr.includes("40700000002"), "the owner must be masked");
});

test("config writes on --account under a global read-only says so", async () => {
  const dir = dataDir();
  await wazap(dir, ["account", "add", "work"]);
  await wazap(dir, ["config", "writes", "off"]);
  const { stderr } = await wazap(dir, ["config", "writes", "on", "--account", "work"]);
  assert.match(stderr, /writes: on for work/);
  assert.match(stderr, /Global read-only is still on/);
  const file = JSON.parse(readFileSync(paths(dir).accountsFile, "utf8"));
  assert.equal(file.accounts.find((account) => account.id === "work").writes, true);
});
