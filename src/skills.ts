import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectClients } from "./connect.js";
import type { Config } from "./config.js";
import { WazapError } from "./errors.js";
import { log, say } from "./logger.js";
import { READ_ONLY_RULE, SEND_RULE } from "./send-guard.js";
import { info, nextHint, ok, shortPath } from "./ui.js";

export interface SkillTarget {
  name: string;
  describe: string;
  /** Where the five directories go. */
  dir: () => string;
  next: string;
}

/**
 * Each path is the one that harness's own docs name today. Codex is the
 * one that moved: `~/.codex/skills` still loads, but its docs call that
 * location deprecated and put user skills in `~/.agents/skills`, which Cursor
 * reads too.
 */
export const SKILL_TARGETS: readonly SkillTarget[] = [
  {
    name: "claude-code",
    describe: "Claude Code",
    dir: () => join(homedir(), ".claude", "skills"),
    next: "Restart Claude Code.",
  },
  {
    name: "codex",
    describe: "Codex CLI",
    dir: () => join(homedir(), ".agents", "skills"),
    next: "Restart Codex. Cursor reads this directory too.",
  },
  {
    name: "cursor",
    describe: "Cursor",
    dir: () => join(homedir(), ".cursor", "skills"),
    next: "Reload the Cursor window.",
  },
  {
    name: "agents",
    describe: "This project, any agent",
    dir: () => join(process.cwd(), ".agents", "skills"),
    next: "Commit .agents/skills to share them with whoever clones this repo.",
  },
];

export const SKILL_TARGET_NAMES: string = SKILL_TARGETS.map((target) => target.name).join(", ");

/** One workflow: what it is for, and the markdown that teaches it. */
export interface Skill {
  name: string;
  description: string;
  body: string;
}

/** The `skills/` folder shipped in the npm package, next to `dist/`. */
function packagedSkills(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

/** Frontmatter is a `---` block of one-line values. */
function parseSkill(text: string): Skill | null {
  text = text.replace(/\r\n/g, "\n");
  const close = text.startsWith("---\n") ? text.indexOf("\n---\n", 3) : -1;
  if (close === -1) return null;
  const front = text.slice(4, close + 1);
  const field = (key: string): string => new RegExp(`^${key}: (.+)$`, "m").exec(front)?.[1]?.trim() ?? "";
  const name = field("name");
  const description = field("description");
  if (name === "" || description === "") return null;
  return { name, description, body: text.slice(close + 5).trim() };
}

/** Every packaged workflow, by name. Empty rather than fatal: the server serves tools either way. */
export function loadSkills(dir: string = packagedSkills()): Skill[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => parseSkill(readFileSync(join(dir, entry.name, "SKILL.md"), "utf8")))
      .filter((skill): skill is Skill => skill !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    log(`no workflows to offer: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** The skill's own H1, which is what a prompt picker shows. */
function skillTitle(skill: Skill): string {
  return /^# (.+)$/m.exec(skill.body)?.[1]?.trim() ?? skill.name;
}

/**
 * A description through the sentence that names its triggers, which every skill
 * has. What follows is the read-only note the tool annotations already carry,
 * and the instructions block has a budget.
 */
function trigger(description: string): string {
  const sentence = /\bUse (?:when|for)\b[^.]*\./.exec(description);
  return sentence === null ? description : description.slice(0, sentence.index + sentence[0].length);
}

/** What the session's instructions depend on besides the skills. */
export interface InstructionOptions {
  /** Whether this session has the send tools; true unless said otherwise. */
  allowWrite?: boolean;
  /** The live accounts, the default marked: named when there are several, so "Business" reaches its account_id. */
  accounts?: ReadonlyArray<{ id: string; name: string; default: boolean }>;
}

/** Accounts named one by one at most; past it, how many there are and where they are named. */
const MAX_NAMED_ACCOUNTS = 8;

function accountsLine(accounts: InstructionOptions["accounts"]): string | null {
  if (accounts === undefined || accounts.length < 2) return null;
  if (accounts.length > MAX_NAMED_ACCOUNTS) return `${accounts.length} accounts: get_status names them.`;
  const named = accounts.map((account) => {
    const labels = [account.name !== account.id ? account.name : null, account.default ? "default" : null].filter((label) => label !== null);
    return labels.length === 0 ? account.id : `${account.id} (${labels.join(", ")})`;
  });
  return `Accounts: ${named.join(", ")}.`;
}

/**
 * What the client shows its model before the first tool call. Short on purpose:
 * the bodies are the prompts, this is only the index to them. A session that
 * only reads is told so, so a request to send is answered, never pretended.
 */
export function skillInstructions(skills: readonly Skill[], options: InstructionOptions = {}): string {
  const accounts = accountsLine(options.accounts);
  const intro =
    "Call `learn` first: it returns every tool, the id formats and every error code with what to do about it. " +
    "With several WhatsApp accounts, `get_status` lists them and every tool takes `account_id`: without it, a chat or message only one account knows picks that account, `catch_up` and `find_contact` cover them all, other reads use the default, and a write to a chat no account knows fails AMBIGUOUS_ACCOUNT. " +
    "An agent that should act as messages arrive calls `wait_for_messages` in a loop with the cursor it returns, instead of polling." +
    (accounts === null ? "" : ` ${accounts}`);
  const rule = options.allowWrite === false ? READ_ONLY_RULE : SEND_RULE;
  if (skills.length === 0) return `${intro}\n\n${rule}`;
  return [
    intro,
    "",
    "The workflows behind these tools:",
    ...skills.map((skill) => `- **${skill.name}**: ${trigger(skill.description)}`),
    "",
    `Each one is available in full as the MCP prompt of the same name. ${rule}`,
  ].join("\n");
}

/** The same workflows a skill-aware harness reads off disk, for every client that has no skills directory. */
export function registerSkillPrompts(server: McpServer, skills: readonly Skill[]): void {
  for (const skill of skills) {
    server.registerPrompt(skill.name, { title: skillTitle(skill), description: skill.description }, async () => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: skill.body } }],
    }));
  }
}

/** The target for a `connect` client, or undefined when that client reads the workflows off the server. */
export function skillTargetFor(client: string): SkillTarget | undefined {
  return SKILL_TARGETS.find((target) => target.name === client);
}

function findSkillTarget(name: string): SkillTarget {
  const target = skillTargetFor(name);
  if (!target) {
    throw new WazapError("INVALID_ID", `Unknown harness "${name}".`, `Pick one of: ${SKILL_TARGET_NAMES}`);
  }
  return target;
}

/** `source` is the packaged skills of another install, which is how `update` copies from the new one. */
export function installSkills(target: SkillTarget, dryRun: boolean, source: string = packagedSkills()): void {
  const skills = loadSkills(source);
  if (skills.length === 0) {
    throw new WazapError(
      "FILE_NOT_FOUND",
      "This wazap install ships no skills/ directory.",
      "Upgrade with `npm i -g wazap-mcp@latest`, or run this from a checkout."
    );
  }

  const dir = target.dir();
  say(info(`${target.describe} · ${dryRun ? "would copy into" : "copying into"} ${shortPath(dir)}`));
  for (const skill of skills) {
    // Overwriting is the point: this is how an upgrade reaches an already
    // installed harness, and re-running it must land in the same place.
    if (!dryRun) cpSync(join(source, skill.name), join(dir, skill.name), { recursive: true, force: true });
    say(`  ${ok(skill.name)}`);
  }
}

export type SkillState = "installed" | "stale" | "missing";

/**
 * Compared by content, because an upgrade that rewrote a skill leaves a copy
 * that exists and is wrong. `missing` means none of them is there, which is
 * either a harness that never got them or a user who removed them; a copy
 * with some skills absent, such as one a release added since, is `stale`.
 */
export function skillState(target: SkillTarget): SkillState {
  const dir = target.dir();
  const packaged = packagedSkills();
  let present = 0;
  let same = 0;
  const skills = loadSkills();
  for (const skill of skills) {
    const installed = join(dir, skill.name, "SKILL.md");
    if (!existsSync(installed)) continue;
    present += 1;
    if (readFileSync(installed, "utf8") === readFileSync(join(packaged, skill.name, "SKILL.md"), "utf8")) same += 1;
  }
  if (present === 0 && skills.length > 0) return "missing";
  return same === skills.length ? "installed" : "stale";
}

export function runSkills(config: Config): void {
  if (config.args[0] !== "install") {
    throw new WazapError(
      "INVALID_ID",
      `Unknown skills command "${config.args[0]}".`,
      "Run `wazap skills install <harness>`"
    );
  }

  const named = config.args[1];
  const targets = named === undefined ? detectedTargets() : [findSkillTarget(named)];
  if (targets.length === 0) {
    throw new WazapError(
      "INVALID_ID",
      "No skill-aware harness found on this machine.",
      `Pick one of: ${SKILL_TARGET_NAMES}`
    );
  }

  for (const target of targets) {
    installSkills(target, config.dryRun);
    say(nextHint(target.next));
  }
}

/** The installed clients that keep skills on disk, in table order. */
export function detectedTargets(): SkillTarget[] {
  return detectClients()
    .map((client) => skillTargetFor(client.name))
    .filter((target): target is SkillTarget => target !== undefined);
}
