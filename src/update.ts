import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WAZAP_VERSION, type Config } from "./config.js";
import { commandPath, installGlobally, whereInstalled, type Install } from "./connect.js";
import { checkLines, isNewer, latestVersion, type Check } from "./doctor.js";
import { asWazapError } from "./errors.js";
import { say } from "./logger.js";
import { installedService, unitScript, writeService, type Installed } from "./service.js";
import { detectedTargets, installSkills, skillState, type SkillState, type SkillTarget } from "./skills.js";
import { ok } from "./ui.js";

export type UpdateStep =
  | { kind: "npm"; version: string }
  | { kind: "note"; text: string }
  | { kind: "service-restart" }
  | { kind: "skills"; targets: SkillTarget[] };

/** Everything about this machine the plan depends on, so planning itself touches nothing. */
export interface UpdateProbes {
  install: Install;
  service: Installed | null;
  targets: readonly { target: SkillTarget; state: SkillState }[];
}

export interface UpdatePlan {
  current: string;
  latest: string | null;
  install: Install;
  steps: UpdateStep[];
}

const REGISTRY_SILENT = "the npm registry did not answer, so there is no version to compare against";

function upgradeNote(install: Install, latest: string): string {
  return install.kind === "npx"
    ? `run \`npx wazap-mcp@${latest} setup\` to refresh the npx cache and the clients`
    : "git pull && npm run build";
}

/**
 * What an upgrade takes here, in execution order. An npm step makes every
 * installed copy of the skills stale, so it drags the rest of the plan with it.
 * A harness holding none of them is left alone: installing is `setup` and
 * `skills install`, and a user who removed the copies means it.
 */
export function planUpdate(probes: UpdateProbes, registryLatest: string | null): UpdatePlan {
  const current = WAZAP_VERSION;
  const upgrading = registryLatest !== null && isNewer(registryLatest, current);
  const steps: UpdateStep[] = [];

  if (registryLatest === null) steps.push({ kind: "note", text: REGISTRY_SILENT });
  else if (upgrading) {
    steps.push(
      probes.install.kind === "global"
        ? { kind: "npm", version: registryLatest }
        : { kind: "note", text: upgradeNote(probes.install, registryLatest) }
    );
  }

  const service = probes.service;
  if (service !== null && (upgrading || service.record.installedVersion !== current)) {
    steps.push({ kind: "service-restart" });
  }

  const behind = probes.targets.filter(
    (probe) => probe.state !== "missing" && (upgrading || probe.state === "stale")
  );
  if (behind.length > 0) steps.push({ kind: "skills", targets: behind.map((probe) => probe.target) });

  return { current, latest: registryLatest, install: probes.install, steps };
}

function describeStep(step: UpdateStep): string {
  switch (step.kind) {
    case "npm":
      return `npm install -g wazap-mcp@${step.version}`;
    case "note":
      return step.text;
    case "service-restart":
      return "restart the background service";
    case "skills":
      return `copy the skills into ${step.targets.map((target) => target.name).join(", ")}`;
  }
}

export function planLines(plan: UpdatePlan): string[] {
  const head = `wazap ${plan.current} · ${plan.install.kind} install · ${plan.latest === null ? "latest unknown" : `latest ${plan.latest}`}`;
  return [head, ...plan.steps.map((step, index) => `  ${index + 1}. ${describeStep(step)}`)];
}

/**
 * The skills of the package the npm step just installed. This process is still
 * the old one, so its own `skills/` is the version being replaced.
 */
function installedSkills(): string | undefined {
  const bin = commandPath("wazap");
  if (bin === null) return undefined;
  const dir = resolve(dirname(realpathSync(bin)), "..", "skills");
  return existsSync(dir) ? dir : undefined;
}

function restartService(config: Config, installed: string | null): Check {
  const found = installedService(config.dataDir);
  if (found === null) return { name: "service", state: "info", detail: "nothing installed to restart" };
  try {
    found.supervisor.restart(found.record);
  } catch (err) {
    const failure = asWazapError(err);
    return { name: "service", state: "fail", detail: failure.message, fix: failure.fix };
  }
  // A restart picks up whatever the unit's own install holds, which is the one
  // npm just upgraded only when the unit runs it: another node or prefix stays behind.
  const runs = unitScript(found.record);
  const expected = installed ?? WAZAP_VERSION;
  if (runs !== null && runs.version !== null && runs.version !== expected) {
    writeService(config.dataDir, { ...found.record, installedVersion: runs.version });
    return {
      name: "service",
      state: "warn",
      detail: `restarted ${found.record.label}, but it runs ${runs.script} (${runs.version}), another install than the one updated (${expected})`,
      fix: `run \`wazap service install\` to point it at this install, or upgrade that one with its own npm: \`${join(dirname(runs.script), "..", "..", "..", "..", "bin", "npm")} i -g wazap-mcp@${expected}\``,
    };
  }
  writeService(config.dataDir, { ...found.record, installedVersion: runs?.version ?? expected });
  return { name: "service", state: "ok", detail: `restarted ${found.record.label} (now ${runs?.version ?? expected})` };
}

function copySkills(config: Config, targets: SkillTarget[], source: string | undefined): Check {
  try {
    for (const target of targets) installSkills(target, config.dryRun, source);
  } catch (err) {
    const failure = asWazapError(err);
    return { name: "skills", state: "fail", detail: failure.message, fix: failure.fix };
  }
  return { name: "skills", state: "ok", detail: `installed for ${targets.map((target) => target.name).join(", ")}` };
}

/** `installed` is the version the npm step put on disk, or null when none ran. */
function runStep(config: Config, step: UpdateStep, installed: string | null): Check {
  switch (step.kind) {
    case "npm":
      return installGlobally(step.version);
    case "note":
      return { name: "note", state: "info", detail: step.text };
    case "service-restart":
      return restartService(config, installed);
    case "skills":
      return copySkills(config, step.targets, installed === null ? undefined : installedSkills());
  }
}

export async function runUpdate(config: Config): Promise<void> {
  const probes: UpdateProbes = {
    install: whereInstalled(),
    service: installedService(config.dataDir),
    targets: detectedTargets().map((target) => ({ target, state: skillState(target) })),
  };
  const plan = planUpdate(probes, await latestVersion());
  for (const line of planLines(plan)) say(line);
  if (config.dryRun) return;

  if (plan.steps.length === 0) {
    say(ok(`${plan.current} is current; service and skills match`));
    return;
  }

  say("");
  let installed: string | null = null;
  for (const step of plan.steps) {
    const check = runStep(config, step, installed);
    for (const line of checkLines(check)) say(line);
    if (check.state === "fail") process.exit(1);
    if (step.kind === "npm") installed = step.version;
  }
  say(ok(installed === null ? "Update complete" : `Updated to ${installed}`));
}
