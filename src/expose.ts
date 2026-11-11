import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ask } from "./cli.js";
import { paths, writesHints, type Config } from "./config.js";
import { REAL_PROBES, commandOnPath, type Probes } from "./connect.js";
import { DEPS, ensureDeps } from "./deps.js";
import { WazapError } from "./errors.js";
import { say } from "./logger.js";
import {
  SUPERVISORS,
  TUNNEL_LABELS,
  installedService,
  secureLogs,
  servicePath,
  tunnelsTo,
  writeService,
  type Installed,
  type Supervisor,
  type UnitSpec,
  writeUnit,
} from "./service.js";
import { setEnvSetting } from "./settings.js";
import { maskKey, which } from "./transcribe/index.js";
import { box, brand, dim, info, next, ok, shortPath, warn } from "./ui.js";

export type Readiness = { ok: true } | { ok: false; fix: string };

export interface TunnelProvider {
  name: "tailscale" | "cloudflare";
  describe: string;
  /** The binary is on PATH. */
  available(): boolean;
  /** Signed in, with somewhere to publish. */
  ready(): Readiness;
  /** Where agents will reach the server. Asked of the user once when the provider cannot know it. */
  publicUrl(port: number, stored: string | null): Promise<string>;
  /** Bring the tunnel up. Providers that need a process of their own return its argv from `command`. */
  open(port: number, url: string): void;
  close(port: number): void;
  /** argv a supervisor unit runs to hold the tunnel open, or null when the provider holds it itself. */
  command(port: number): string[] | null;
}

interface Ran {
  status: number;
  stdout: string;
}

function run(argv: readonly string[]): Ran {
  const [command, ...args] = argv;
  const result = spawnSync(command!, args, { encoding: "utf8" });
  if (result.error) return { status: -1, stdout: "" };
  return { status: result.status ?? -1, stdout: result.stdout ?? "" };
}

function runOrThrow(argv: readonly string[], repair: string): void {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
  if (result.status === 0) return;
  const detail = ((result.stderr ?? "").trim() || (result.stdout ?? "").trim() || String(result.error?.message)).split(
    "\n"
  )[0]!;
  throw new WazapError("SERVICE_ERROR", `\`${argv.join(" ")}\` failed: ${detail}`, repair);
}

const TAILSCALE_UP_FIX = "run `tailscale up`, then `wazap expose tailscale` again";

/** `Self.DNSName` from `tailscale status --json`, without its trailing dot. */
function tailscaleName(): string | null {
  const result = run(["tailscale", "status", "--json"]);
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { BackendState?: unknown; Self?: { DNSName?: unknown } };
    if (parsed.BackendState !== "Running") return null;
    const dns = parsed.Self?.DNSName;
    return typeof dns === "string" && dns !== "" ? dns.replace(/\.$/, "") : null;
  } catch {
    return null;
  }
}

const tailscale: TunnelProvider = {
  name: "tailscale",
  describe: "Tailscale Funnel",
  available: () => commandOnPath("tailscale"),
  ready: () =>
    tailscaleName() === null
      ? {
          ok: false,
          fix: `${TAILSCALE_UP_FIX}; Funnel also needs MagicDNS and HTTPS on in the Tailscale admin console`,
        }
      : { ok: true },
  publicUrl: async (_port, _stored) => {
    const name = tailscaleName();
    if (name === null)
      throw new WazapError("SERVICE_ERROR", "Tailscale has no name for this machine.", TAILSCALE_UP_FIX);
    return `https://${name}`;
  },
  open: (port) => {
    runOrThrow(["tailscale", "funnel", "--bg", String(port)], "run `tailscale funnel status` to see what it refused");
  },
  close: () => {
    run(["tailscale", "funnel", "--https=443", "off"]);
  },
  // tailscaled holds the funnel itself, so there is nothing for a supervisor to keep alive.
  command: () => null,
};

function cloudflaredCert(): string {
  return join(homedir(), ".cloudflared", "cert.pem");
}

const CLOUDFLARE_TUNNEL = "wazap";

const cloudflare: TunnelProvider = {
  name: "cloudflare",
  describe: "Cloudflare Tunnel",
  available: () => commandOnPath("cloudflared"),
  ready: () =>
    existsSync(cloudflaredCert())
      ? { ok: true }
      : { ok: false, fix: "run `cloudflared tunnel login`, then `wazap expose cloudflare` again" },
  publicUrl: async (_port, stored) => {
    if (stored !== null) return stored;
    const answer = (await ask(`${brand("?")} Hostname on your Cloudflare domain (e.g. wazap.example.com): `)).trim();
    const host = answer.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
      throw new WazapError("SERVICE_ERROR", `"${answer}" is not a hostname.`, "run `wazap expose cloudflare` again");
    }
    return `https://${host}`;
  },
  open: (_port, url) => {
    // Both are idempotent in effect but not in exit code: a tunnel that exists
    // and a name already routed to it are the state we want, not a failure.
    run(["cloudflared", "tunnel", "create", CLOUDFLARE_TUNNEL]);
    runOrThrow(
      ["cloudflared", "tunnel", "route", "dns", "--overwrite-dns", CLOUDFLARE_TUNNEL, new URL(url).hostname],
      "check that the domain is on this Cloudflare account"
    );
  },
  close: () => {},
  // --no-autoupdate: the supervisor keeps cloudflared running and the package
  // manager updates it; a self-update restarts the tunnel on its own schedule,
  // dropping every call and SSE stream it carries at that moment. The origin
  // keep-alive needs no flag: cloudflared pools idle connections for 90 s and
  // wazap keeps them open for 120 (server.ts HTTP_KEEP_ALIVE_MS).
  command: (port) => [
    which("cloudflared") ?? "cloudflared",
    "tunnel",
    "--no-autoupdate",
    "run",
    "--url",
    `http://127.0.0.1:${port}`,
    CLOUDFLARE_TUNNEL,
  ],
};

export const PROVIDERS: readonly TunnelProvider[] = [tailscale, cloudflare];

export const PROVIDER_NAMES: string = PROVIDERS.map((provider) => provider.name).join(", ");

function findProvider(name: string, providers: readonly TunnelProvider[]): TunnelProvider {
  const found = providers.find((provider) => provider.name === name);
  if (found === undefined) {
    throw new WazapError("INVALID_ID", `Unknown tunnel provider "${name}".`, `Pick one of: ${PROVIDER_NAMES}`);
  }
  return found;
}

function requireService(config: Config, registry: readonly Supervisor[]): Installed {
  const found = installedService(config.dataDir, registry);
  if (found === null) {
    throw new WazapError(
      "SERVICE_ERROR",
      "A public URL needs the background service: something has to stay up for the tunnel to reach.",
      "run `wazap service install`"
    );
  }
  return found;
}

/** 24 characters out of 18 random bytes. The whole identity layer of the consent page. */
function newPassword(): string {
  return randomBytes(18).toString("base64url");
}

function tunnelUnit(label: string, argv: readonly string[], logDir: string): UnitSpec {
  return {
    label,
    describe: "wazap public tunnel",
    argv,
    env: { HOME: homedir(), PATH: servicePath(argv[0]!) },
    logDir,
  };
}

const PUBLIC_HEALTH_MS = 10_000;

async function publicHealth(url: string): Promise<number | null> {
  try {
    const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(PUBLIC_HEALTH_MS) });
    return response.status;
  } catch {
    return null;
  }
}

const HANDOVER =
  "Give an agent the URL only. It signs in on your consent page with this password; wazap status shows who holds a grant.";

async function exposeOn(config: Config, provider: TunnelProvider, { supervisor, record }: Installed): Promise<void> {
  if (!provider.available()) {
    throw new WazapError(
      "SERVICE_ERROR",
      `${provider.describe} is not installed on this machine.`,
      `install ${provider.name}, or run \`wazap expose ${PROVIDERS.filter((p) => p !== provider)
        .map((p) => p.name)
        .join("|")}\``
    );
  }
  const readiness = provider.ready();
  if (!readiness.ok) throw new WazapError("SERVICE_ERROR", `${provider.describe} is not ready.`, readiness.fix);

  const stored = record.tunnel?.provider === provider.name ? record.tunnel.url : null;
  const url = await provider.publicUrl(record.port, stored);
  provider.open(record.port, url);

  const argv = provider.command(record.port);
  const label = TUNNEL_LABELS[supervisor.name];
  const ref = { label, unitFile: supervisor.unitFile(label) };
  if (argv !== null) {
    secureLogs(record.logDir, label);
    writeUnit(ref.unitFile, supervisor.render(tunnelUnit(label, argv, record.logDir)));
    supervisor.restart(ref);
  }

  const p = paths(config.dataDir);
  setEnvSetting(p.envFile, "WAZAP_PUBLIC_URL", url);
  const fresh = config.oauthPassword === null;
  const password = config.oauthPassword ?? newPassword();
  if (fresh) setEnvSetting(p.envFile, "WAZAP_OAUTH_PASSWORD", password);

  writeService(config.dataDir, { ...record, tunnel: { provider: provider.name, url } });
  supervisor.restart(record);

  say(ok(`${provider.describe} · ${url}`));
  say(dim(`Stored in ${shortPath(p.envFile)}.`));
  const status = await publicHealth(url);
  say(
    status === 200
      ? ok("The public URL reaches this machine.")
      : warn(`${url}/healthz answered ${status ?? "nothing"}; the tunnel may still be coming up.`)
  );
  say("");
  say(box(`MCP URL   ${url}/mcp`, `Password  ${fresh ? password : maskKey(password)}`));
  say("");
  say(HANDOVER);
  for (const line of writesHints(config)) {
    say(info(line));
  }
}

async function exposeOff(
  config: Config,
  providers: readonly TunnelProvider[],
  { supervisor, record }: Installed
): Promise<void> {
  const label = TUNNEL_LABELS[supervisor.name];
  supervisor.remove({ label, unitFile: supervisor.unitFile(label) });
  if (record.tunnel) {
    providers.find((provider) => provider.name === record.tunnel?.provider)?.close(record.port);
  }
  const { tunnel: _dropped, ...kept } = record;

  // A tunnel wazap did not open still reaches the port, and sign-in is all that
  // stands in front of it, so sign-in stays on until that tunnel is gone too.
  const others = tunnelsTo(supervisor, record.port);
  if (others.length > 0) {
    writeService(config.dataDir, kept);
    throw new WazapError(
      "SERVICE_ERROR",
      `wazap's tunnel is off, but ${others.map((unit) => unit.label).join(", ")} ${others.length === 1 ? "still tunnels" : "still tunnel"} to port ${record.port}, so sign-in stays on.`,
      `stop it and remove its unit with \`${others.map((unit) => unit.stop).join("; ")}\`, then run \`wazap expose off\` again`
    );
  }

  setEnvSetting(paths(config.dataDir).envFile, "WAZAP_PUBLIC_URL", "");
  writeService(config.dataDir, kept);
  supervisor.restart(kept);

  say(ok("Tunnel off. Only this machine reaches wazap again."));
  say(info("The consent password is kept, so the next `wazap expose` hands agents the same one."));
}

export async function runExpose(
  config: Config,
  providers: readonly TunnelProvider[] = PROVIDERS,
  registry: readonly Supervisor[] = SUPERVISORS,
  probes: Probes = REAL_PROBES
): Promise<void> {
  const installed = requireService(config, registry);
  const named = config.args[0];
  if (named === "off") return exposeOff(config, providers, installed);

  if (named !== undefined) return exposeOn(config, findProvider(named, providers), installed);
  const first = providers.find((provider) => provider.available());
  if (first === undefined) {
    // Cloudflare needs a domain and a login, so only Tailscale is worth offering
    // here; it still needs `tailscale up`, which only its owner can answer for.
    if (await ensureDeps([DEPS.tailscale], config, probes)) {
      say(ok("Tailscale is installed."));
      say(next("tailscale up", "then run `wazap expose` again"));
      return;
    }
    throw new WazapError(
      "SERVICE_ERROR",
      "No tunnel provider is installed.",
      `install Tailscale or cloudflared, then run \`wazap expose\` (providers: ${PROVIDER_NAMES})`
    );
  }
  return exposeOn(config, first, installed);
}
