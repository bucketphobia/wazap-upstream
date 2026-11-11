/**
 * `wazap expose`, against a fake tunnel provider and a fake supervisor. Nothing
 * here runs tailscale or cloudflared, and nothing reaches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { paths } from "../dist/config.js";
import { PROVIDERS, runExpose } from "../dist/expose.js";
import { SUPERVISORS, installService, readService, serverUnit, tunnelsTo } from "../dist/service.js";

const URL_LINE = "https://box.example.ts.net";

function dataDir() {
  return mkdtempSync(join(tmpdir(), "wazap-expose-"), { mode: 0o700 });
}

let nextPort = 42_000;

function config(dir, overrides = {}) {
  return { dataDir: dir, httpPort: nextPort++, dryRun: false, args: [], oauthPassword: null, sources: { port: "flag" }, ...overrides };
}

function fakeSupervisor(dir) {
  const calls = [];
  return {
    calls,
    name: "launchd",
    available: () => true,
    logDir: () => join(dir, "logs"),
    unitFile: (label) => join(dir, `${label}.unit`),
    render: (unit) => `label ${unit.label}\nargv ${unit.argv.join(" ")}\n`,
    start: (ref) => calls.push(`start ${ref.label}`),
    stop: (ref) => calls.push(`stop ${ref.label}`),
    restart: (ref) => calls.push(`restart ${ref.label}`),
    remove: (ref) => {
      calls.push(`remove ${ref.label}`);
      rmSync(ref.unitFile, { force: true });
    },
    pid: () => 4242,
    logs: (ref) => [`tail ${ref.label}`],
  };
}

function fakeProvider({ available = true, ready = { ok: true }, command = null } = {}) {
  const calls = [];
  return {
    calls,
    name: "tailscale",
    describe: "Fake Funnel",
    available: () => available,
    ready: () => ready,
    publicUrl: async (_port, stored) => stored ?? URL_LINE,
    open: (port, url) => calls.push(`open ${port} ${url}`),
    close: (port) => calls.push(`close ${port}`),
    command: () => command,
  };
}

async function captured(work) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    await work();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

/** A data dir with the service already installed, which is what expose requires. */
async function exposable() {
  const dir = dataDir();
  const supervisor = fakeSupervisor(dir);
  await captured(() => installService(config(dir), supervisor, 0));
  supervisor.calls.length = 0;
  return { dir, supervisor };
}

function env(dir) {
  const text = readFileSync(paths(dir).envFile, "utf8");
  return Object.fromEntries(
    text
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
  );
}

test("expose writes the public URL and a password into a 0600 .env, and says both once", async () => {
  const { dir, supervisor } = await exposable();
  const provider = fakeProvider();
  const output = await captured(() => runExpose(config(dir), [provider], [supervisor]));

  const settings = env(dir);
  assert.equal(settings.WAZAP_PUBLIC_URL, URL_LINE);
  assert.equal(settings.WAZAP_OAUTH_PASSWORD.length, 24, "the consent password is 24 characters");
  assert.equal(statSync(paths(dir).envFile).mode & 0o777, 0o600, "the password must not be world-readable");

  assert.equal(readService(dir).tunnel.url, URL_LINE);
  assert.deepEqual(provider.calls, [`open ${readService(dir).port} ${URL_LINE}`]);
  assert.ok(supervisor.calls.includes("restart com.wazap.server"), `restart never happened: ${supervisor.calls}`);

  assert.match(output, new RegExp(`${URL_LINE}/mcp`));
  assert.match(output, /Give an agent the URL only\./);
  assert.doesNotMatch(output, /bearer|write token|read token/i, "an agent gets the URL, not a static token");
  const shown = output.split(settings.WAZAP_OAUTH_PASSWORD).length - 1;
  assert.equal(shown, 1, "the password is printed exactly once, or the user cannot trust where it went");
});

test("a second expose keeps the password it already generated, and only masks it", async () => {
  const { dir, supervisor } = await exposable();
  await captured(() => runExpose(config(dir), [fakeProvider()], [supervisor]));
  const first = env(dir).WAZAP_OAUTH_PASSWORD;

  const output = await captured(() => runExpose(config(dir, { oauthPassword: first }), [fakeProvider()], [supervisor]));

  assert.equal(env(dir).WAZAP_OAUTH_PASSWORD, first, "a re-run must never rotate the password agents signed in with");
  assert.ok(!output.includes(first), "an already-known password is never printed in the clear again");
  assert.match(output, new RegExp(`set \\(…${first.slice(-4).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
});

test("expose off clears the URL, keeps the password, and takes the tunnel unit with it", async () => {
  const { dir, supervisor } = await exposable();
  const provider = fakeProvider({ command: ["/opt/bin/faketunnel", "run"] });
  await captured(() => runExpose(config(dir), [provider], [supervisor]));
  const password = env(dir).WAZAP_OAUTH_PASSWORD;
  const unitFile = supervisor.unitFile("com.wazap.tunnel");
  assert.equal(existsSync(unitFile), true, "a provider with a command needs a unit of its own");

  const output = await captured(() =>
    runExpose(config(dir, { args: ["off"], oauthPassword: password }), [provider], [supervisor])
  );

  assert.equal(env(dir).WAZAP_PUBLIC_URL, "", "OAuth stays off while no public URL is set");
  assert.equal(env(dir).WAZAP_OAUTH_PASSWORD, password, "off must not cost the user their password");
  assert.equal(readService(dir).tunnel, undefined);
  assert.equal(existsSync(unitFile), false, "the tunnel unit outlived `expose off`");
  assert.ok(provider.calls.includes(`close ${readService(dir).port}`));
  assert.match(output, /consent password is kept/);
});

/** A launchd agent someone wrote by hand, holding cloudflared open to `target`. */
function tunnelPlist(dir, label, target) {
  const file = join(dir, `${label}.plist`);
  writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${label}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/opt/homebrew/bin/cloudflared</string>
\t\t<string>tunnel</string>
\t\t<string>--url</string>
\t\t<string>${target}</string>
\t\t<string>run</string>
\t</array>
</dict>
</plist>
`
  );
  return file;
}

test("expose off keeps sign-in on while a tunnel wazap did not open still reaches the port", async () => {
  const { dir, supervisor } = await exposable();
  const provider = fakeProvider({ command: ["/opt/bin/faketunnel", "run"] });
  await captured(() => runExpose(config(dir), [provider], [supervisor]));
  const { WAZAP_PUBLIC_URL: url, WAZAP_OAUTH_PASSWORD: password } = env(dir);
  const port = readService(dir).port;
  const theirs = tunnelPlist(dir, "com.example.wazap.tunnel", `http://127.0.0.1:${port}`);
  tunnelPlist(dir, "com.example.elsewhere", `http://127.0.0.1:${port + 1}`);
  supervisor.calls.length = 0;

  await assert.rejects(
    captured(() => runExpose(config(dir, { args: ["off"], oauthPassword: password }), [provider], [supervisor])),
    (err) => {
      assert.equal(
        err.message,
        `wazap's tunnel is off, but com.example.wazap.tunnel still tunnels to port ${port}, so sign-in stays on.`
      );
      assert.match(err.fix, /launchctl bootout gui\/\d+\/com\.example\.wazap\.tunnel; rm /);
      assert.ok(err.fix.includes(theirs), `the fix names the unit file: ${err.fix}`);
      return true;
    }
  );

  assert.equal(env(dir).WAZAP_PUBLIC_URL, url, "sign-in must stay on while the port is still reachable from outside");
  assert.equal(existsSync(theirs), true, "a unit wazap did not write is never removed");
  assert.ok(
    !supervisor.calls.some((call) => call.includes("com.example")),
    `stopped a unit it does not own: ${supervisor.calls}`
  );
  assert.equal(existsSync(supervisor.unitFile("com.wazap.tunnel")), false, "wazap's own tunnel still goes");
  assert.equal(readService(dir).tunnel, undefined);
});

test("tunnelsTo finds the units whose command reaches the port on loopback, and nothing else", () => {
  const port = 8766;
  const dir = dataDir();
  const launchd = fakeSupervisor(dir);
  tunnelPlist(dir, "com.example.tunnel", `http://127.0.0.1:${port}`);
  tunnelPlist(dir, "com.example.localhost", `http://localhost:${port}/`);
  tunnelPlist(dir, "com.example.longer-port", `http://127.0.0.1:${port}0`);
  tunnelPlist(dir, "com.example.remote", `http://10.0.0.2:${port}`);
  // wazap's own server unit names the host and the port apart; it is not a tunnel.
  const server = serverUnit({ label: "com.wazap.server", node: "/n", script: "/s", dataDir: "/d", port, logDir: "/l" });
  writeFileSync(join(dir, "com.wazap.server.plist"), SUPERVISORS.find((s) => s.name === "launchd").render(server));

  const found = tunnelsTo(launchd, port);
  assert.deepEqual(
    found.map((unit) => unit.label),
    ["com.example.localhost", "com.example.tunnel"]
  );
  assert.match(found[1].stop, /^launchctl bootout gui\/\d+\/com\.example\.tunnel; rm .*com\.example\.tunnel\.plist$/);

  const unitDir = dataDir();
  const systemd = { ...fakeSupervisor(unitDir), name: "systemd" };
  writeFileSync(
    join(unitDir, "tunnel.service"),
    `[Service]\nExecStart=/usr/bin/cloudflared tunnel --url http://127.0.0.1:${port} run\n`
  );
  writeFileSync(
    join(unitDir, "noted.service"),
    `[Unit]\nDescription=forwards 127.0.0.1:${port}\n[Service]\nExecStart=/usr/bin/true\n`
  );
  assert.deepEqual(tunnelsTo(systemd, port), [
    {
      label: "tunnel.service",
      unitFile: join(unitDir, "tunnel.service"),
      stop: `systemctl --user disable --now tunnel.service; rm ${join(unitDir, "tunnel.service")}`,
    },
  ]);
  assert.deepEqual(tunnelsTo(fakeSupervisor(join(dir, "missing")), port), [], "no unit dir is no tunnel");
});

test("a provider that is not ready fails with its own repair, and changes nothing", async () => {
  const { dir, supervisor } = await exposable();
  const provider = fakeProvider({ ready: { ok: false, fix: "run `tailscale up` first" } });

  await assert.rejects(runExpose(config(dir), [provider], [supervisor]), (err) => {
    assert.match(err.message, /Fake Funnel is not ready\./);
    assert.equal(err.fix, "run `tailscale up` first");
    return true;
  });
  assert.equal(existsSync(paths(dir).envFile), false, "a refused expose must write no settings");
  assert.equal(readService(dir).tunnel, undefined);
});

test("a provider whose binary is missing says so before anything else", async () => {
  const { dir, supervisor } = await exposable();
  const provider = fakeProvider({ available: false });
  await assert.rejects(runExpose(config(dir, { args: ["tailscale"] }), [provider], [supervisor]), (err) => {
    assert.match(err.message, /not installed on this machine/);
    return true;
  });
});

test("expose with no service installed points at the command that installs one", async () => {
  const dir = dataDir();
  await assert.rejects(runExpose(config(dir), [fakeProvider()], [fakeSupervisor(dir)]), (err) => {
    assert.equal(err.fix, "run `wazap service install`");
    return true;
  });
});

test("expose with no argument takes the first provider that is installed", async () => {
  const { dir, supervisor } = await exposable();
  const absent = { ...fakeProvider({ available: false }), name: "cloudflare" };
  const present = fakeProvider();
  await captured(() => runExpose(config(dir), [absent, present], [supervisor]));
  assert.equal(readService(dir).tunnel.provider, "tailscale");
});

test("expose with nothing installed offers Tailscale, then stops at `tailscale up`", async () => {
  const { dir, supervisor } = await exposable();
  // The binary is on PATH while the provider still says no: the state a fresh
  // `brew install tailscale` leaves, with nothing for ensureDeps left to do.
  const probes = { exists: () => false, onPath: (command) => command === "tailscale" };
  const output = await captured(() =>
    runExpose(config(dir), [fakeProvider({ available: false })], [supervisor], probes)
  );

  assert.match(output, /Tailscale is installed\./);
  assert.match(output, /tailscale up/);
  assert.equal(readService(dir).tunnel, undefined, "the tunnel waits for `tailscale up`");
});

test("expose with nothing installed and no Homebrew keeps its own repair", async () => {
  const { dir, supervisor } = await exposable();
  const probes = { exists: () => false, onPath: () => false };
  await assert.rejects(runExpose(config(dir), [fakeProvider({ available: false })], [supervisor], probes), (err) => {
    assert.match(err.message, /No tunnel provider is installed\./);
    assert.match(err.fix, /install Tailscale or cloudflared/);
    return true;
  });
});

test("the real providers are a registry of two, each naming its own binary", () => {
  assert.deepEqual(
    PROVIDERS.map((provider) => provider.name),
    ["tailscale", "cloudflare"]
  );
  assert.equal(PROVIDERS[0].command(8766), null, "tailscaled holds the funnel itself");
  // A self-update would restart the tunnel under every call it carries; the supervisor and the package manager own that.
  assert.deepEqual(PROVIDERS[1].command(8766).slice(1), ["tunnel", "--no-autoupdate", "run", "--url", "http://127.0.0.1:8766", "wazap"]);
});

test("cloudflare is not ready until `cloudflared tunnel login` has been run", () => {
  const home = mkdtempSync(join(tmpdir(), "wazap-cf-home-"));
  const original = process.env.HOME;
  process.env.HOME = home;
  try {
    const readiness = PROVIDERS[1].ready();
    assert.equal(readiness.ok, false);
    assert.match(readiness.fix, /cloudflared tunnel login/);
  } finally {
    process.env.HOME = original;
    writeFileSync(join(home, "checked"), "");
  }
});
