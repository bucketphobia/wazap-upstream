import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { greetNext, leftoverFix, leftoverRefusal, parseLinkChoice, tunnelRefusal } from "../dist/cli.js";
import { SUPERVISORS } from "../dist/service.js";
import { TOOL_NAMES } from "../dist/tools.js";
import { childEnv, spawnWazap, waitFor } from "./helpers.mjs";
import { runSmoke } from "./smoke-stdio.mjs";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

/** The CLI writes to stderr, because stdout belongs to the MCP protocol. */
function wazap(...args) {
  return run(process.execPath, [binary, ...args], { env: { ...process.env, WAZAP_NO_UPDATE_CHECK: "1" } });
}

test("--help explains every command and exits 0", async () => {
  const { stderr } = await wazap("--help");
  for (const fragment of [
    "wazap login",
    "wazap status",
    "wazap logout",
    "wazap webhook test",
    "wazap account",
    "wazap migrate rollback",
    "--account",
    "--data-dir",
    "--read-only",
  ]) {
    assert.ok(stderr.includes(fragment), `--help must mention ${fragment}`);
  }
});

test("retired and deprecated settings in .env warn once each and the command still succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-retired-"));
  // 0.23.1's .env.example shipped `WAZAP_TRANSPORT=stdio`, commented; someone uncommented it.
  writeFileSync(join(dir, ".env"), "WAZAP_RATE_LIMIT=5\nWAZAP_TRANSPORT=stdio\n");
  const { stdout, stderr } = await run(process.execPath, [binary, "status", "--json", "--data-dir", dir], {
    env: childEnv(),
  });
  assert.equal(JSON.parse(stdout).data_dir, dir, "stdout stays the report");
  assert.equal(stderr.match(/WAZAP_RATE_LIMIT is no longer read/g)?.length, 1);
  assert.match(stderr, /WAZAP_RATE_LIMIT is no longer read and was ignored: writes are limited to 20 a minute/);
  assert.equal(stderr.match(/WAZAP_TRANSPORT is deprecated/g)?.length, 1);
  assert.match(stderr, /stdio is the default; remove WAZAP_TRANSPORT/);
  assert.doesNotMatch(stderr, /pass `--http`/);
});

test("WAZAP_TRANSPORT=http without --http still serves HTTP, and says once that the flag is the supported way", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-transport-env-"));
  const probe = createNetServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const { child, stderr } = spawnWazap({
    dataDir,
    args: ["serve"],
    env: { WAZAP_TRANSPORT: "http", WAZAP_HOST: "127.0.0.1", WAZAP_PORT: String(port), WAZAP_NO_SHARE: "1" },
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });
  const health = await waitFor(
    () =>
      fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) }).then(
        (res) => res.json(),
        () => null
      ),
    20_000,
    "wazap serve to answer HTTP on the port WAZAP_PORT named"
  );
  assert.equal(typeof health.status, "string");
  const log = stderr.join("");
  assert.equal(log.match(/WAZAP_TRANSPORT=http still works but is deprecated/g)?.length, 1, log);
  assert.match(log, /goes away in 2\.0: pass `--http` instead, as in `wazap serve --http`/);
});

test("--version prints the package version and exits 0", async () => {
  const { stderr } = await wazap("--version");
  const { version } = JSON.parse(
    await import("node:fs").then((fs) => fs.readFileSync(join(dirname(binary), "..", "package.json"), "utf8"))
  );
  assert.equal(stderr.trim(), version);
});

test("status on an empty data dir reports nothing linked, without touching WhatsApp", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-status-"));
  const { stderr } = await wazap("status", "--data-dir", dataDir);
  assert.match(stderr, /linked: no/);
  assert.match(stderr, new RegExp(`data dir: ${dataDir}`));
  assert.match(stderr, /server: not running/);
});

test("an HTTP server with no token and no sign-in is refused while a unit tunnels to its port", () => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-tunnel-refusal-"));
  const supervisor = { name: "systemd", available: () => true, unitFile: (label) => join(dir, label) };
  writeFileSync(
    join(dir, "tunnel.service"),
    "[Service]\nExecStart=/usr/bin/cloudflared tunnel --url http://127.0.0.1:8766 run\n"
  );
  const open = { httpHost: "127.0.0.1", httpPort: 8766, readToken: null, publicUrl: null, oauthPassword: null };

  const refusal = tunnelRefusal(open, [supervisor]);
  assert.equal(refusal.message, "Refusing to serve 127.0.0.1:8766 without a token: tunnel.service tunnels to it.");
  assert.match(refusal.fix, /^Set WAZAP_READ_TOKEN, or WAZAP_PUBLIC_URL and WAZAP_OAUTH_PASSWORD for sign-in/);
  assert.ok(refusal.fix.includes(`systemctl --user disable --now tunnel.service; rm ${join(dir, "tunnel.service")}`));

  assert.equal(tunnelRefusal({ ...open, readToken: "r".repeat(32) }, [supervisor]), null, "a read token closes it");
  const signIn = { ...open, publicUrl: "https://wazap.example", oauthPassword: "x".repeat(12) };
  assert.equal(tunnelRefusal(signIn, [supervisor]), null, "so does sign-in");
  assert.equal(tunnelRefusal({ ...open, httpPort: 8767 }, [supervisor]), null, "a tunnel to another port is not ours");
  assert.equal(tunnelRefusal({ ...open, httpPort: 0 }, [supervisor]), null, "an ephemeral port has no tunnel");
  assert.equal(tunnelRefusal(open, [{ ...supervisor, available: () => false }]), null);
});

test(
  "serve --http refuses to start, and takes no lock, while a tunnel in its HOME reaches the port",
  { skip: SUPERVISORS.some((supervisor) => supervisor.available()) ? false : "no launchd or systemd here" },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "wazap-tunnel-home-"));
    const dataDir = mkdtempSync(join(tmpdir(), "wazap-tunnel-data-"));
    const port = 41_877;
    // One of each, so whichever supervisor this machine has finds its own kind.
    const agents = join(home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(
      join(agents, "com.example.tunnel.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>Label</key>\n\t<string>com.example.tunnel</string>\n\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>cloudflared</string>\n\t\t<string>--url</string>\n\t\t<string>http://127.0.0.1:${port}</string>\n\t</array>\n</dict>\n</plist>\n`
    );
    const units = join(home, ".config", "systemd", "user");
    mkdirSync(units, { recursive: true });
    writeFileSync(
      join(units, "example-tunnel.service"),
      `[Service]\nExecStart=/usr/bin/cloudflared tunnel --url http://localhost:${port} run\n`
    );

    const serving = run(process.execPath, [binary, "serve", "--http", "--port", String(port), "--data-dir", dataDir], {
      env: childEnv({ HOME: home }),
      timeout: 30_000,
    });
    await assert.rejects(serving, (err) => {
      assert.equal(err.code, 1, err.stderr);
      assert.match(
        err.stderr,
        new RegExp(
          `Refusing to serve 127\\.0\\.0\\.1:${port} without a token: (com\\.example\\.tunnel|example-tunnel\\.service) tunnels to it\\.`
        )
      );
      assert.match(err.stderr, /WAZAP_READ_TOKEN/);
      return true;
    });
    assert.equal(existsSync(join(dataDir, "server.lock")), false, "a refused server must not hold the session");
  }
);

test("an unknown command fails with a pointer to --help", async () => {
  await assert.rejects(wazap("frobnicate"), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /--help/);
    return true;
  });
});

test("the built server answers MCP over stdio with no WhatsApp session", async () => {
  const { toolNames, status } = await runSmoke();
  assert.deepEqual([...toolNames].sort(), [...TOOL_NAMES].sort());
  assert.equal(status.status, "not_linked");
});

test("`contacts resync` on an unlinked data dir stops at NOT_LINKED, and frees the lock", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-contacts-"));
  await assert.rejects(wazap("contacts", "resync", "--data-dir", dataDir), (err) => {
    assert.match(err.stderr, /No WhatsApp account is linked/);
    return true;
  });
  assert.equal(existsSync(join(dataDir, "server.lock")), false, "a refused command must not leave the session held");
});

test("`contacts` with no verb, or the wrong one, points at the one that exists", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-contacts-"));
  for (const args of [["contacts"], ["contacts", "refresh"]]) {
    await assert.rejects(wazap(...args, "--data-dir", dataDir), (err) => {
      assert.match(err.stderr, /wazap contacts resync/);
      assert.ok(!err.stderr.includes("--help"), `${args.join(" ")} dumped the user into --help`);
      return true;
    });
  }
});

test("greetNext on an unlinked install points at setup, not login", () => {
  const lines = greetNext({ linked: false, credentials_readable: true, server_pid: null }).join("\n");
  assert.match(lines, /wazap setup/);
  assert.ok(!lines.includes("wazap login"), lines);
});

test("greetNext on an unlinked leftover still points at setup, and names kill", () => {
  const lines = greetNext({ linked: false, credentials_readable: true, server_pid: 85007 }).join("\n");
  assert.match(lines, /A server is already running \(pid 85007\)/);
  assert.match(lines, /stop it first: kill 85007/);
  assert.match(lines, /wazap setup/);
});

test("greetNext on a linked leftover does not send the user back through setup", () => {
  const lines = greetNext({ linked: true, credentials_readable: true, server_pid: 9 }).join("\n");
  assert.match(lines, /A server is already running \(pid 9\)/);
  assert.ok(!lines.includes("wazap setup"), lines);
  assert.ok(!lines.includes("kill 9"), lines);
});

test("leftoverFix is the one line login and logout print", () => {
  assert.equal(leftoverFix(85007), "stop it first: kill 85007");
});

test("leftoverFix names service stop for a service-held pid, since kill would respawn it", () => {
  assert.equal(leftoverFix(85007, true), "stop it first: `wazap service stop`");
});

test("greetNext on a service-held leftover points at service stop", () => {
  const lines = greetNext({
    linked: false,
    credentials_readable: true,
    server_pid: 85007,
    server_is_service: true,
  }).join("\n");
  assert.match(lines, /stop it first: `wazap service stop`/);
  assert.ok(!lines.includes(`kill 85007`), lines);
});

test("leftoverRefusal names a client leftover and ignores a free lock", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-leftover-"));
  assert.equal(leftoverRefusal({ dataDir }), null);
  writeFileSync(join(dataDir, "server.lock"), `${process.pid}\n`, { mode: 0o600 });
  const err = leftoverRefusal({ dataDir });
  assert.equal(err?.code, "WHATSAPP_ERROR");
  assert.equal(err?.message, `wazap is running (pid ${process.pid}).`);
  assert.equal(err?.fix, leftoverFix(process.pid));
});

test("setup on a leftover refuses before the wizard opens", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-setup-lock-"));
  writeFileSync(join(dataDir, "server.lock"), `${process.pid}\n`, { mode: 0o600 });
  await assert.rejects(wazap("setup", "--yes", "--no-writes", "--data-dir", dataDir), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, new RegExp(`stop it first: kill ${process.pid}`));
    return true;
  });
});

test("a leftover that is not a service tells login the kill command", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-login-lock-"));
  writeFileSync(join(dataDir, "server.lock"), `${process.pid}\n`, { mode: 0o600 });
  await assert.rejects(wazap("login", "--yes", "--no-writes", "--data-dir", dataDir), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, new RegExp(`wazap is running \\(pid ${process.pid}\\)`));
    assert.match(err.stderr, new RegExp(`stop it first: kill ${process.pid}`));
    return true;
  });
});

test("a leftover that is not a service tells logout the kill command", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-logout-lock-"));
  writeFileSync(join(dataDir, "server.lock"), `${process.pid}\n`, { mode: 0o600 });
  await assert.rejects(wazap("logout", "--data-dir", dataDir), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, new RegExp(`wazap is running \\(pid ${process.pid}\\)`));
    assert.match(err.stderr, new RegExp(`stop it first: kill ${process.pid}`));
    return true;
  });
});

test("a command with no arguments names its own usage, not --help", async () => {
  const cases = [
    { args: ["connect"], usage: /Pick one of: claude-code/ },
    { args: ["skills"], usage: /wazap skills install/ },
    { args: ["service"], usage: /wazap service install\|status/ },
    { args: ["transcribe"], usage: /wazap transcribe download/ },
    { args: ["contacts"], usage: /wazap contacts resync/ },
    { args: ["config", "writes"], usage: /wazap config writes on\|off/ },
    { args: ["webhook"], usage: /wazap webhook test/ },
  ];
  for (const { args, usage } of cases) {
    await assert.rejects(wazap(...args), (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, new RegExp(`Wrong arguments for \`wazap ${args[0]}\``));
      assert.match(err.stderr, usage);
      assert.ok(!err.stderr.includes("Run `wazap --help`"), `${args.join(" ")} dumped the user into --help`);
      return true;
    });
  }
});

test("parseLinkChoice treats enter and 1 as QR, 2 as a code, anything else as another try", () => {
  assert.equal(parseLinkChoice(""), "qr");
  assert.equal(parseLinkChoice("1"), "qr");
  assert.equal(parseLinkChoice("  1  "), "qr");
  assert.equal(parseLinkChoice("2"), "code");
  assert.equal(parseLinkChoice("x"), "retry");
  // A window too short for the QR makes the pairing code the default, and still honours an explicit choice.
  assert.equal(parseLinkChoice("", false), "code");
  assert.equal(parseLinkChoice("  ", false), "code");
  assert.equal(parseLinkChoice("1", false), "qr");
  assert.equal(parseLinkChoice("2", false), "code");
  assert.equal(parseLinkChoice("x", false), "retry");
  assert.equal(parseLinkChoice("", true), "qr");
});

test("`contacts resync` refuses while a server owns the session", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-contacts-"));
  writeFileSync(join(dataDir, "server.lock"), String(process.pid), { mode: 0o600 });
  await assert.rejects(wazap("contacts", "resync", "--data-dir", dataDir), (err) => {
    assert.match(err.stderr, new RegExp(`wazap is running \\(pid ${process.pid}\\)`));
    assert.match(err.stderr, /stop the server and run this again/);
    return true;
  });
});

test("greetNext never advises a logout for credentials the file system would not read", () => {
  const lines = greetNext({ linked: false, credentials_readable: false, credentials_error: "EACCES", server_pid: null }).join("\n");
  assert.doesNotMatch(lines, /logout/);
  assert.match(lines, /owns the account's auth folder/);
  const corrupt = greetNext({ linked: false, credentials_readable: false, credentials_error: null, server_pid: null }).join("\n");
  assert.match(corrupt, /wazap logout/, "a corrupt file still needs the logout");
});
