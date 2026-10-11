import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { WAZAP_VERSION, defaultDataDir, writesHints, type Config } from "./config.js";
import type { Check } from "./doctor.js";
import { WazapError } from "./errors.js";
import { say } from "./logger.js";
import { dim, fail, fix, info, next, nextHint, ok, shortPath } from "./ui.js";

export interface McpEntry {
  command: string;
  args: string[];
}

/** `command` shells out to the client's own CLI; the other two edit a config file. */
type Format = "command" | "json" | "toml";

export interface Probes {
  exists: (path: string) => boolean;
  onPath: (command: string) => boolean;
}

export interface ClientSpec {
  name: string;
  describe: string;
  file: () => string | null;
  format: Format;
  keyPath: readonly string[];
  next: string;
  /** A macOS app `setup` can restart itself, instead of leaving `next` to the user. */
  relaunch?: { app: string };
  /** Whether this client looks installed. Required: a client `setup` cannot look for is not one it can offer. */
  detect: (probe: Probes) => boolean;
  /** A desktop app launched by the window manager, so it inherits GUI_PATH rather than the shell PATH. */
  gui: boolean;
}

function claudeDesktopFile(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

export const CLIENTS: readonly ClientSpec[] = [
  {
    name: "claude-code",
    describe: "Claude Code",
    file: () => null,
    format: "command",
    keyPath: [],
    next: "Run `claude mcp list` to confirm.",
    detect: (probe) => probe.onPath("claude"),
    gui: false,
  },
  {
    name: "claude-desktop",
    describe: "Claude Desktop",
    file: claudeDesktopFile,
    format: "json",
    keyPath: ["mcpServers", "whatsapp"],
    next: "Restart Claude Desktop.",
    relaunch: { app: "Claude" },
    detect: (probe) => probe.exists(dirname(claudeDesktopFile())),
    gui: true,
  },
  {
    name: "cursor",
    describe: "Cursor",
    file: () => join(homedir(), ".cursor", "mcp.json"),
    format: "json",
    keyPath: ["mcpServers", "whatsapp"],
    next: "Reload the Cursor window.",
    detect: (probe) => probe.exists(join(homedir(), ".cursor")),
    gui: false,
  },
  {
    name: "codex",
    describe: "Codex CLI",
    file: () => join(homedir(), ".codex", "config.toml"),
    format: "toml",
    keyPath: ["mcp_servers", "whatsapp"],
    next: "Restart Codex.",
    detect: (probe) => probe.exists(join(homedir(), ".codex")),
    gui: false,
  },
  {
    name: "gemini",
    describe: "Gemini CLI",
    file: () => join(homedir(), ".gemini", "settings.json"),
    format: "json",
    keyPath: ["mcpServers", "whatsapp"],
    next: "Restart the Gemini CLI.",
    detect: (probe) => probe.exists(join(homedir(), ".gemini")),
    gui: false,
  },
];

export const CLIENT_NAMES: string = CLIENTS.map((client) => client.name).join(", ");

const OTHER_CLIENTS: string = CLIENTS.slice(1)
  .map((client) => client.name)
  .join(", ");

export function connectNext(): string {
  return next("wazap connect claude-code", `(or ${OTHER_CLIENTS})`);
}

export function isNpxPath(binPath: string): boolean {
  return /[\\/]_npx[\\/]/.test(binPath);
}

const PATH_EXTENSIONS = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];

/** The first `name` on `pathEnv`, or null. */
export function commandPath(
  name: string,
  pathEnv: string = process.env.PATH ?? "",
  exists: (p: string) => boolean = existsSync
): string | null {
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const ext of PATH_EXTENSIONS) {
      const candidate = join(dir, `${name}${ext}`);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export function commandOnPath(
  name: string,
  pathEnv: string = process.env.PATH ?? "",
  exists: (p: string) => boolean = existsSync
): boolean {
  return commandPath(name, pathEnv, exists) !== null;
}

/** Where this wazap lives: a stable global install, a checkout, or the npx cache. */
export type Install = { kind: "global" | "checkout" | "npx"; script: string };

/**
 * The npx cache is a throwaway copy, so nothing that has to survive a reboot may
 * point at it. Everything that used to re-derive this asks here instead.
 */
export function whereInstalled(
  binPath: string = process.argv[1] ?? "",
  pathEnv: string = process.env.PATH ?? "",
  exists?: (p: string) => boolean
): Install {
  const script = binPath === "" ? "" : resolve(binPath);
  if (isNpxPath(binPath)) return { kind: "npx", script };
  const onPath = commandPath("wazap", pathEnv, exists);
  if (onPath) {
    try {
      if (realpathSync(onPath) === realpathSync(script)) return { kind: "global", script };
    } catch {
      // A package path or a direct launcher can still be classified when inspecting another host.
      if (/[/\\]node_modules[/\\]wazap(?:-mcp)?[/\\]/.test(script) || resolve(onPath) === script)
        return { kind: "global", script };
    }
  }
  return { kind: "checkout", script };
}

const GLOBAL_FIX = "run `npm i -g wazap-mcp` yourself (sudo on some Linux installs), then `wazap setup` again";

/** `npm i -g wazap-mcp@<this version>`, so setup and the global install agree. */
export function installGlobally(version: string = WAZAP_VERSION, npm = "npm"): Check {
  const result = spawnSync(npm, ["install", "-g", `wazap-mcp@${version}`], { stdio: "inherit" });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error === undefined ? `exit ${result.status ?? -1}` : result.error.message;
    return {
      name: "install",
      state: "fail",
      detail: `npm install -g wazap-mcp@${version} failed (${detail})`,
      fix: GLOBAL_FIX,
    };
  }
  return { name: "install", state: "ok", detail: `wazap-mcp@${version} installed globally` };
}

/** Where a global install puts its bins. `npm bin -g` printed this until npm 9 dropped it. */
export function globalBinDir(npm = "npm"): string | null {
  const result = spawnSync(npm, ["prefix", "-g"], { encoding: "utf8" });
  const prefix = result.status === 0 ? (result.stdout ?? "").trim() : "";
  if (prefix === "") return null;
  return process.platform === "win32" ? prefix : join(prefix, "bin");
}

function wazapIn(dir: string, exists: (p: string) => boolean): string | null {
  for (const ext of PATH_EXTENSIONS) {
    const candidate = join(dir, `wazap${ext}`);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * A `wazap` that will still exist after npm clears the npx cache. Prefers
 * `npm prefix -g` over PATH, because npx puts its throwaway bin first.
 */
export function stableWazap(
  exists: (p: string) => boolean = existsSync,
  pathEnv: string = process.env.PATH ?? "",
  dir: string | null = globalBinDir()
): string | null {
  if (dir !== null) {
    const fromPrefix = wazapIn(dir, exists);
    if (fromPrefix !== null) return fromPrefix;
  }
  const onPath = commandPath("wazap", pathEnv, exists);
  if (onPath !== null && !isNpxPath(onPath)) return onPath;
  return null;
}

export const REAL_PROBES: Probes = { exists: existsSync, onPath: (command) => commandOnPath(command) };

/** Enough of `spawnSync` for the three commands a relaunch runs, so a test can record them. */
type Runner = (command: string, args: readonly string[], options: { encoding: "utf8" }) => { status: number | null };

const QUIT_WAIT_MS = 10_000;
const QUIT_POLL_MS = 250;

/** Whether a macOS app of this name has a process right now. */
export function appRunning(
  app: string,
  platform: NodeJS.Platform = process.platform,
  run: Runner = spawnSync
): boolean {
  if (platform !== "darwin") return false;
  return run("pgrep", ["-x", app], { encoding: "utf8" }).status === 0;
}

/** Quit and reopen a macOS app. Returns false when the app was not running, so nothing to do. */
export function relaunch(app: string, platform: NodeJS.Platform = process.platform, run: Runner = spawnSync): boolean {
  if (!appRunning(app, platform, run)) return false;
  run("osascript", ["-e", `tell application "${app}" to quit`], { encoding: "utf8" });
  // Reopening an app that is still tearing down gets the dying instance back.
  for (let waited = 0; waited < QUIT_WAIT_MS && appRunning(app, platform, run); waited += QUIT_POLL_MS) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, QUIT_POLL_MS);
  }
  run("open", ["-a", app], { encoding: "utf8" });
  return true;
}

/** The installed clients, in table order. */
export function detectClients(probe: Probes = REAL_PROBES): ClientSpec[] {
  return CLIENTS.filter((client) => client.detect(probe));
}

/**
 * How the client should launch wazap. A checkout written as `wazap` would point
 * the client at a command that does not exist.
 */
export function entryFor(install: Install): McpEntry {
  if (install.kind === "npx") return { command: "npx", args: ["-y", "wazap-mcp"] };
  if (install.kind === "global") return { command: "wazap", args: [] };
  return { command: "node", args: [install.script] };
}

export function launcher(binPath: string, pathEnv: string, exists?: (p: string) => boolean): McpEntry {
  return entryFor(whereInstalled(binPath, pathEnv, exists));
}

/** The PATH a GUI app gets from launchd, which is not the user's shell PATH. */
export const GUI_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin";

export function mcpEntry(config: Config, spec: ClientSpec, install: Install = whereInstalled()): McpEntry {
  const entry = entryFor(install);
  // The global `wazap` bin is a symlink into the package, and launchd's PATH has
  // neither it, nor npx, nor the bare `node` a checkout entry would name, so a
  // GUI client gets this Node and the script behind it.
  if (spec.gui && (entry.command === "wazap" || install.kind === "checkout")) {
    entry.command = process.execPath;
    entry.args = [realpathSync(install.script)];
  }
  if (config.dataDir !== defaultDataDir()) entry.args.push("--data-dir", config.dataDir);
  if (config.readOnly) entry.args.push("--read-only");
  return entry;
}

const GLOBAL_INSTALL_FIX = "run `npm i -g wazap-mcp`, then `wazap connect claude-desktop` again";

/** Whether the client can still find the command once it is launched without a shell. */
export function launchCheck(
  spec: ClientSpec,
  entry: McpEntry,
  pathEnv: string = GUI_PATH,
  exists?: (p: string) => boolean,
  platform: NodeJS.Platform = process.platform
): Check {
  if (!spec.gui) {
    return { name: "launch", state: "ok", detail: `${spec.describe} runs \`${entry.command}\` from your shell PATH` };
  }
  if (platform !== "darwin") return { name: "launch", state: "info", detail: "not checked on this platform" };
  if (isAbsolute(entry.command) || commandOnPath(entry.command, pathEnv, exists)) {
    return {
      name: "launch",
      state: "ok",
      detail: `${spec.describe} can start \`${entry.command}\` without your shell PATH`,
    };
  }
  return {
    name: "launch",
    state: "fail",
    detail: `${spec.describe} starts without your shell PATH and cannot find \`${entry.command}\``,
    fix: GLOBAL_INSTALL_FIX,
  };
}

type Writer = (spec: ClientSpec, entry: McpEntry, dryRun: boolean) => void;

const WRITERS: Record<Format, Writer> = {
  command: runClientCommand,
  json: writeJsonEntry,
  toml: writeTomlEntry,
};

export function findClient(name: string): ClientSpec {
  const spec = CLIENTS.find((client) => client.name === name);
  if (!spec) {
    throw new WazapError("INVALID_ID", `Unknown client "${name}".`, `Pick one of: ${CLIENT_NAMES}`);
  }
  return spec;
}

export function connectClient(spec: ClientSpec, config: Config, install?: Install): void {
  WRITERS[spec.format](spec, mcpEntry(config, spec, install), config.dryRun);
}

export function runConnect(config: Config): void {
  const spec = findClient(config.args[0] ?? "");
  connectClient(spec, config);
  say(nextHint(spec.next));
  for (const line of writesHints(config)) say(info(line));
}

/** Null only when the file is absent; an unreadable file must never be overwritten. */
function readTextOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WazapError(
      "INVALID_ID",
      `${file} cannot be read.`,
      "Fix its permissions or move the file aside, then run this again."
    );
  }
}

function setIn(doc: Record<string, unknown>, keyPath: readonly string[], value: unknown): void {
  let node = doc;
  for (const key of keyPath.slice(0, -1)) {
    const child = node[key];
    if (child === null || typeof child !== "object" || Array.isArray(child)) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keyPath[keyPath.length - 1]!] = value;
}

function writeJsonEntry(spec: ClientSpec, entry: McpEntry, dryRun: boolean): void {
  const file = spec.file()!;
  const current = readTextOrNull(file);
  let doc: Record<string, unknown> = {};
  if (current !== null && current.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      throw new WazapError(
        "INVALID_ID",
        `${file} is not valid JSON.`,
        "Fix the JSON or move the file aside, then run this again."
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new WazapError(
        "INVALID_ID",
        `${file} is not a JSON object.`,
        "Fix the JSON or move the file aside, then run this again."
      );
    }
    doc = parsed as Record<string, unknown>;
  }

  const value = { command: entry.command, args: entry.args };
  setIn(doc, spec.keyPath, value);
  // Indent 1 collapsed to one line: short enough to read, still spaced like JSON.
  const shown = JSON.stringify(value, null, 1).replace(/\n\s*/g, " ");
  apply(spec, file, `${JSON.stringify(doc, null, 2)}\n`, current, dryRun, shown);
}

function writeTomlEntry(spec: ClientSpec, entry: McpEntry, dryRun: boolean): void {
  const file = spec.file()!;
  const current = readTextOrNull(file);
  const header = `[${spec.keyPath.join(".")}]`;
  const args = entry.args.map((arg) => JSON.stringify(arg)).join(", ");
  const block = `${header}\ncommand = ${JSON.stringify(entry.command)}\nargs = [${args}]\n`;
  apply(spec, file, spliceTomlTable(current ?? "", header, block), current, dryRun, block.trimEnd());
}

/** Replace the table under `header`, from its header line to the next one, or append it. */
function spliceTomlTable(text: string, header: string, block: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    const base = text.trimEnd();
    return base === "" ? block : `${base}\n\n${block}`;
  }
  let end = start + 1;
  while (end < lines.length && !lines[end]!.trimStart().startsWith("[")) end++;
  // Blank lines and comments just above the next header introduce that table.
  while (end > start + 1 && /^\s*(#|$)/.test(lines[end - 1]!)) end--;
  const merged = [...lines.slice(0, start), ...block.trimEnd().split("\n"), ...lines.slice(end)].join("\n");
  return merged.endsWith("\n") ? merged : `${merged}\n`;
}

function apply(
  spec: ClientSpec,
  file: string,
  content: string,
  current: string | null,
  dryRun: boolean,
  shown: string
): void {
  const where = shortPath(file);
  const entry = shown.split("\n").map((line) => `  ${dim(line)}`);

  if (dryRun) {
    say(info(`${spec.describe} \u00b7 would write ${where}`));
    for (const line of entry) say(line);
    return;
  }
  if (content === current) {
    say(ok(`${spec.describe} \u00b7 ${where} already has this entry`));
    return;
  }

  mkdirSync(dirname(file), { recursive: true });
  let backup = "";
  if (current !== null && !existsSync(`${file}.bak`)) {
    copyFileSync(file, `${file}.bak`);
    backup = `  (backup: ${basename(file)}.bak)`;
  }
  // The config is replaced atomically, like everything else wazap writes: a
  // killed run must not hand the client a half-written file.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
  say(ok(`${spec.describe} \u00b7 wrote ${where}${backup}`));
  for (const line of entry) say(line);
}

function runClientCommand(spec: ClientSpec, entry: McpEntry, dryRun: boolean): void {
  const argv = ["mcp", "add", "whatsapp", "--", entry.command, ...entry.args];
  const shown = `claude ${argv.join(" ")}`;
  if (dryRun) {
    say(info(`${spec.describe} \u00b7 would run`));
    say(`  ${dim(shown)}`);
    return;
  }

  const result = spawnSync("claude", argv, { stdio: "inherit" });
  if (result.error !== undefined) {
    say(fail("`claude` is not on PATH."));
    say(fix(`Run this where Claude Code is installed: ${shown}`));
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
  say(ok(`${spec.describe} \u00b7 registered via claude mcp add`));
}
