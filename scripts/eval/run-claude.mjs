#!/usr/bin/env node
/**
 * Runs evaluation cases against headless Claude Code, one isolated evaluation
 * server per attempt, and scores the run.
 *
 *   node scripts/eval/run-claude.mjs --cases baseline-0.23 [--reps 1] [--model sonnet]
 *     [--mode assistant|claude-code] [--parallel 2] [--max-budget-usd 0.8] [--stop-at-usd 6]
 *     [--max-turns 12] [--effort <level>] [--out ~/.wazap-eval/runs] [--tool-map 1.0]
 *     [--save eval/results/<version>/<date>-<model>-<mode>.summary.json] [--compare <summary.json>]
 *
 * `--cases` takes "all", a subset of eval/subsets.json, "critical", or ids and
 * ranges ("P18,N6-N12"). Full transcripts (the CLI's stream, the server's
 * trace and effects, the end state) go to <out>/<timestamp>/<case>/<rep>/,
 * outside the repository; a summary saved under eval/results/ stays local (gitignored).
 *
 * Isolation of every Claude process: only the evaluation server as MCP
 * (--strict-mcp-config), no built-in tools (--tools ""), only wazap tools
 * allowed, dontAsk permissions, no session persistence, no skills or slash
 * commands, project settings only (from an empty temporary directory), and the
 * parent session's CLAUDE* environment removed. The run aborts when a CLI
 * reports any MCP server, tool or plugin besides the evaluation server's.
 * Fable is refused.
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { loadCases, loadToolMap, REPO_ROOT, selectCases } from "./cases.mjs";
import { controlClient } from "./client.mjs";
import { compareSummaries, renderSummary, scoreRun } from "./score.mjs";

export const SERVER_NAME = "wazap";

/** The gate's system prompt: a neutral personal assistant, plus the run's clock. */
export const ASSISTANT_PROMPT = [
  "You are a helpful personal assistant.",
  "The user's WhatsApp is connected through the wazap tools; use them when a request needs WhatsApp.",
].join(" ");

function parseArgs(argv) {
  const out = {
    cases: "smoke",
    reps: 1,
    model: "sonnet",
    mode: "assistant",
    parallel: 2,
    maxBudgetUsd: 0.8,
    stopAtUsd: 6,
    maxTurns: 12,
    out: join(homedir(), ".wazap-eval", "runs"),
    toolMap: "1.0",
    turnTimeoutMs: 300_000,
  };
  const numbers = new Set(["reps", "parallel", "maxBudgetUsd", "stopAtUsd", "maxTurns", "turnTimeoutMs"]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    const key = flag.replace(/^--/, "").replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    out[key] = numbers.has(key) ? Number(value) : value;
  }
  if (/fable/i.test(out.model)) throw new Error("The evaluation never runs on Fable.");
  if (!["assistant", "claude-code"].includes(out.mode)) throw new Error("--mode is assistant or claude-code");
  return out;
}

/** The environment a child gets: no WAZAP_* of this shell, and nothing of the Claude session this may run inside. */
export function isolatedEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("WAZAP_")) continue;
    if ((key.startsWith("CLAUDE") || key === "AI_AGENT" || key.startsWith("ANTHROPIC_")) && key !== "CLAUDE_CODE_SKIP_AUTO_UPDATE") continue;
    env[key] = value;
  }
  return { ...env, CLAUDE_CODE_SKIP_AUTO_UPDATE: "1", ...extra };
}

function claudeVersion() {
  const ran = spawnSync("claude", ["--version"], { encoding: "utf8", env: isolatedEnv() });
  return (ran.stdout || "").trim() || null;
}

// ---------------------------------------------------------------------------
// One evaluation server.
// ---------------------------------------------------------------------------

function startServer(casePath, attemptDir) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, "scripts", "eval", "server.mjs"), "--case", casePath, "--out", attemptDir, "--quiet"], {
      cwd: REPO_ROOT,
      env: isolatedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = createWriteStream(join(attemptDir, "server.log"));
    child.stderr.pipe(log);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error("evaluation server did not get ready in 60 s"));
    }, 60_000);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.startsWith("READY ")) return;
      clearTimeout(timer);
      done({ child, ready: JSON.parse(line.slice(6)) });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`evaluation server exited with ${code} before it was ready`));
    });
  });
}

async function stopServer(server, control) {
  const exited = new Promise((done) => {
    if (server.child.exitCode !== null) done();
    else server.child.once("exit", done);
  });
  await control.stop().catch(() => server.child.kill("SIGTERM"));
  const timer = setTimeout(() => server.child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

// ---------------------------------------------------------------------------
// One Claude session: a `claude -p` process fed turns over stream-json.
// ---------------------------------------------------------------------------

class IsolationError extends Error {}

function claudeSession({ options, attemptDir, sessionIndex, mcpConfigPath, systemPrompt, anchorSentence }) {
  const cwd = mkdtempSync(join(tmpdir(), "wazap-eval-cwd-"));
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    options.model,
    "--mcp-config",
    mcpConfigPath,
    "--strict-mcp-config",
    "--tools",
    "",
    "--allowedTools",
    `mcp__${SERVER_NAME}__*`,
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--setting-sources",
    "project",
    "--max-turns",
    String(options.maxTurns),
    "--max-budget-usd",
    String(options.maxBudgetUsd),
    ...(options.effort ? ["--effort", options.effort] : []),
    ...(options.mode === "assistant" ? ["--system-prompt", `${systemPrompt}\n${anchorSentence}`] : ["--append-system-prompt", anchorSentence]),
  ];
  const child = spawn("claude", args, { cwd, env: isolatedEnv(), stdio: ["pipe", "pipe", "pipe"] });
  const stream = createWriteStream(join(attemptDir, `stream-${sessionIndex}.jsonl`));
  const stderr = createWriteStream(join(attemptDir, `claude-${sessionIndex}.stderr.log`));
  child.stderr.pipe(stderr);
  const session = {
    child,
    cwd,
    events: [],
    costUsd: 0,
    model: null,
    sessionId: null,
    exited: new Promise((done) => child.once("exit", (code, signal) => done({ code, signal }))),
    waiter: null,
    isolation: null,
    turn: null,
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    stream.write(`${line}\n`);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    session.events.push(event);
    if (event.type === "system" && event.subtype === "init") {
      session.sessionId = event.session_id;
      session.model = event.model;
      const servers = event.mcp_servers ?? [];
      const foreignTools = (event.tools ?? []).filter((tool) => !tool.startsWith(`mcp__${SERVER_NAME}__`));
      if (servers.length !== 1 || servers[0].name !== SERVER_NAME || foreignTools.length > 0 || (event.plugins ?? []).length > 0) {
        session.isolation = `init lists servers ${JSON.stringify(servers)}, other tools ${JSON.stringify(foreignTools)}, plugins ${JSON.stringify(event.plugins)}`;
      } else if (servers[0].status !== "connected") {
        session.notConnected = `the evaluation server is ${servers[0].status}`;
      }
      if ((session.isolation || session.notConnected) && session.waiter) session.waiter.fail(session.isolation ? new IsolationError(session.isolation) : new Error(session.notConnected));
      return;
    }
    if (session.turn) {
      if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) if (block.type === "text" && block.text) session.turn.texts.push(block.text);
        if (event.message?.model) session.model = event.message.model;
      } else if (event.type === "rate_limit_event" && event.rate_limit_info?.status === "rejected") {
        session.turn.rateLimited = true;
      } else if (event.type === "result") {
        session.costUsd = Math.max(session.costUsd, event.total_cost_usd ?? 0);
        const turn = session.turn;
        session.turn = null;
        session.waiter?.done({ ...turn, result: event });
      }
    }
  });
  child.once("exit", (code, signal) => {
    stream.end();
    stderr.end();
    session.waiter?.fail(new Error(`claude exited (${code ?? signal}) in the middle of a turn`));
  });
  session.send = (text, timeoutMs) =>
    new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no result within ${timeoutMs / 1000} s`)), timeoutMs);
      session.waiter = {
        done: (value) => {
          clearTimeout(timer);
          session.waiter = null;
          done(value);
        },
        fail: (err) => {
          clearTimeout(timer);
          session.waiter = null;
          fail(err);
        },
      };
      if (session.isolation) return session.waiter.fail(new IsolationError(session.isolation));
      session.turn = { texts: [], rateLimited: false };
      child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
    });
  session.close = async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 20_000);
    await session.exited;
    clearTimeout(timer);
    rmSync(cwd, { recursive: true, force: true });
  };
  return session;
}

// ---------------------------------------------------------------------------
// One attempt.
// ---------------------------------------------------------------------------

function conditionHolds(when, state) {
  if (when === undefined || when === "always") return true;
  const accounts = Object.values(state.accounts);
  if (when === "draft_open") return accounts.some((account) => account.drafts.some((draft) => draft.state === "draft"));
  if (when === "no_effects") return state.effects_count === 0;
  throw new Error(`Unknown when "${when}"`);
}

function infraFrom(result) {
  if (!result) return null;
  if (result.subtype === "error_max_turns") return null;
  if (result.subtype === "error_max_budget_usd") return "budget exceeded";
  if (result.api_error_status) return `API error ${result.api_error_status}`;
  if (result.is_error && result.subtype !== "success") return `result ${result.subtype}`;
  if (result.is_error && /rate limit|overloaded|529|429|5\d\d/i.test(String(result.result ?? ""))) return `API: ${String(result.result).slice(0, 120)}`;
  return null;
}

export async function runAttempt({ theCase, rep, options, runDir }) {
  const attemptDir = join(runDir, theCase.id, String(rep));
  mkdirSync(attemptDir, { recursive: true });
  const casePath = join(REPO_ROOT, "eval", "cases", `${theCase.id}.json`);
  const started = Date.now();
  const record = {
    case: theCase.id,
    rep,
    model_requested: options.model,
    mode: options.mode,
    turns: theCase.turns.map((turn) => ({ user: turn.user })),
    sessions: [],
    cost_usd: 0,
    infra_error: null,
    limit: null,
    started_at: new Date(started).toISOString(),
  };
  let server;
  let control;
  let session = null;
  const sessions = [];
  try {
    server = await startServer(casePath, attemptDir);
    control = controlClient(server.ready.control_url, server.ready.control_token);
    const refs = await control.refs();
    writeFileSync(join(attemptDir, "refs.json"), `${JSON.stringify(refs, null, 2)}\n`);
    record.anchor = server.ready.anchor;
    record.anchor_sentence = server.ready.anchor_sentence;
    const resolveText = (text) => text.replace(/\{\{(\w+)\}\}/g, (whole, name) => refs.calendar?.[name] ?? whole);
    record.turns = theCase.turns.map((turn) => ({ user: resolveText(turn.user) }));
    const token = theCase.session?.token === "read" ? server.ready.tokens.read : server.ready.tokens.write;
    const mcpConfigPath = join(attemptDir, "mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: "http", url: server.ready.mcp_url, headers: { Authorization: `Bearer ${token}` } } } }));
    if (theCase.setup?.length) await control.hooks(theCase.setup);

    for (const [index, turn] of theCase.turns.entries()) {
      const number = index + 1;
      if (turn.when !== undefined && !conditionHolds(turn.when, await control.state())) {
        record.turns[index].skipped = true;
        continue;
      }
      if (!session || turn.new_session) {
        if (session) await session.close();
        session = claudeSession({
          options,
          attemptDir,
          sessionIndex: sessions.length + 1,
          mcpConfigPath,
          systemPrompt: ASSISTANT_PROMPT,
          anchorSentence: server.ready.anchor_sentence,
        });
        sessions.push(session);
      }
      // Hooks run once the CLI is starting, so a message scheduled "in 15 s" lands while the turn is live.
      if (turn.before?.length) await control.hooks(turn.before);
      await control.turn(number, sessions.length);
      const outcome = await session.send(record.turns[index].user, options.turnTimeoutMs);
      const result = outcome.result;
      Object.assign(record.turns[index], {
        session: sessions.length,
        text: outcome.texts.join("\n\n"),
        final: result.result ?? null,
        subtype: result.subtype,
        num_turns: result.num_turns ?? null,
        duration_ms: result.duration_ms ?? null,
      });
      if (result.subtype === "error_max_turns") record.limit = "max_turns";
      const infra = infraFrom(result) ?? (outcome.rateLimited && result.is_error ? "rate limited" : null);
      if (infra) {
        record.infra_error = infra;
        break;
      }
    }
  } catch (err) {
    if (err instanceof IsolationError) {
      record.infra_error = `isolation: ${err.message}`;
      record.isolation_breach = true;
    } else {
      record.infra_error = String(err?.message ?? err);
    }
  } finally {
    for (const open of sessions) {
      await open.close().catch(() => {});
      record.sessions.push({ session_id: open.sessionId, model: open.model, cost_usd: open.costUsd, exit: await open.exited });
    }
    record.cost_usd = Number(sessions.reduce((total, open) => total + open.costUsd, 0).toFixed(6));
    record.models_served = [...new Set(sessions.map((open) => open.model).filter(Boolean))];
    if (control) {
      try {
        writeFileSync(join(attemptDir, "state.json"), `${JSON.stringify(await control.state(), null, 2)}\n`);
      } catch (err) {
        record.infra_error ??= `end state: ${err.message}`;
      }
    }
    if (server) await stopServer(server, control).catch(() => {});
    record.duration_ms = Date.now() - started;
    writeFileSync(join(attemptDir, "attempt.json"), `${JSON.stringify(record, null, 2)}\n`);
  }
  return record;
}

// ---------------------------------------------------------------------------
// A run.
// ---------------------------------------------------------------------------

export async function run(options) {
  const all = loadCases();
  const chosen = selectCases(all, options.cases);
  const toolMap = loadToolMap(options.toolMap);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = resolve(options.out, stamp);
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const queue = chosen.flatMap((theCase) => Array.from({ length: options.reps }, (_, i) => ({ theCase, rep: i + 1 })));
  process.stderr.write(`${queue.length} attempt(s) over ${chosen.length} case(s): ${chosen.map((c) => c.id).join(" ")}\n`);
  if (options.dryRun) return null;
  mkdirSync(runDir, { recursive: true });
  const meta = {
    wazap_version: pkg.version,
    arm: { model_requested: options.model, mode: options.mode, effort: options.effort ?? null, claude_version: claudeVersion(), max_turns: options.maxTurns, max_budget_usd: options.maxBudgetUsd },
    run: { id: stamp, cases: options.cases, reps: options.reps, parallel: options.parallel, started_at: new Date().toISOString() },
  };
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify(meta, null, 2)}\n`);

  let spent = 0;
  let stopped = null;
  const workers = Array.from({ length: Math.max(1, options.parallel) }, async () => {
    while (queue.length > 0 && !stopped) {
      const { theCase, rep } = queue.shift();
      const record = await runAttempt({ theCase, rep, options, runDir });
      spent += record.cost_usd;
      const mark = record.infra_error ? `infra: ${record.infra_error}` : "done";
      process.stderr.write(`${theCase.id}#${rep} ${mark} · $${record.cost_usd.toFixed(3)} · ${(record.duration_ms / 1000).toFixed(0)} s · total $${spent.toFixed(2)}\n`);
      if (record.isolation_breach) stopped = `isolation breach in ${theCase.id}: ${record.infra_error}`;
      else if (spent > options.stopAtUsd) stopped = `cumulative cost $${spent.toFixed(2)} passed the $${options.stopAtUsd} stop`;
    }
  });
  await Promise.all(workers);
  if (stopped) process.stderr.write(`RUN STOPPED: ${stopped}\n`);

  const finished = new Date();
  meta.run.finished_at = finished.toISOString();
  meta.run.duration_ms = finished.getTime() - Date.parse(meta.run.started_at);
  meta.run.stopped = stopped;
  meta.run.not_run = queue.map(({ theCase, rep }) => `${theCase.id}#${rep}`);
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify(meta, null, 2)}\n`);

  const summary = scoreRun(runDir, { toolMap, cases: all });
  if (options.compare) summary.comparison = compareSummaries(summary, JSON.parse(readFileSync(options.compare, "utf8")));
  writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  if (options.save) {
    const target = resolve(options.save);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`);
  }
  process.stdout.write(`${renderSummary(summary)}\nrun dir: ${runDir}\n`);
  return { runDir, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(parseArgs(process.argv.slice(2))).catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
