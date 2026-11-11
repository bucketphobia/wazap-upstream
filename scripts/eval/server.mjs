#!/usr/bin/env node
/**
 * The assistant evaluation's wazap: the real MCP endpoint (startHttpEndpoint)
 * over a fictional world on fake sockets. Dev only, never packaged.
 *
 *   node scripts/eval/server.mjs [--fixture eval/fixtures/world.json] [--case eval/cases/P18.json]
 *     [--port 0] [--out <dir>] [--anchor "YYYY-MM-DD HH:MM"] [--data-root <dir>]
 *     [--oauth --public-url https://… --password … --state-dir <dir>]
 *
 * Prints one line `READY {json}` on stdout (the MCP URL, the write and read
 * tokens, the control URL and its token, the anchor) and keeps serving until
 * SIGTERM or POST /eval/stop.
 *
 * What it records, as JSONL in --out (and over the control API):
 *   trace.jsonl   every tool call the server ran: tool, arguments, the account
 *                 it resolved to, the error code, the MCP session, the turn;
 *   effects.jsonl every write that reached a fake socket — what would have
 *                 reached WhatsApp.
 *
 * Control, on a separate loopback port with its own token: GET /eval/state,
 * /eval/trace, /eval/effects, /eval/refs; POST /eval/reset, /eval/turn,
 * /eval/hooks, /eval/expire-drafts, /eval/inject, /eval/send-fault, /eval/stop.
 *
 * Guarantees: no socket to WhatsApp can open (socketFactory.open throws), the
 * data lives in a fresh directory that may not be ~/.wazap or inside it, the
 * live service's ports are refused, and every WAZAP_* of the calling shell is
 * dropped before wazap loads.
 */
import { anchorFor, anchorSentence, calendarWords, setClock } from "./clock.mjs";

import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const DEFAULT_WORLD = join(REPO_ROOT, "eval", "fixtures", "world.json");
/** The ports a real wazap listens on: the default HTTP port and the owner's service. */
export const LIVE_PORTS = Object.freeze([8766, 8767]);

// ---------------------------------------------------------------------------
// Safety.
// ---------------------------------------------------------------------------

function realOrResolved(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function inside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Throws when `dir` is, or is inside, a real wazap data directory. */
export function assertSafeDataRoot(dir, env = process.env) {
  const target = realOrResolved(dir);
  const forbidden = [join(homedir(), ".wazap")];
  if (env.WAZAP_DATA_DIR) forbidden.push(env.WAZAP_DATA_DIR);
  for (const live of forbidden) {
    const real = realOrResolved(live);
    if (inside(target, real) || inside(target, resolve(live))) {
      throw new Error(`eval server: refusing to use ${dir}: it is a real wazap data directory (${live})`);
    }
  }
  if (existsSync(join(target, "server.lock")) || existsSync(join(target, "accounts.json"))) {
    throw new Error(`eval server: refusing to use ${dir}: it already holds a wazap data directory`);
  }
  return target;
}

export function assertSafePort(port) {
  if (LIVE_PORTS.includes(Number(port))) {
    throw new Error(`eval server: refusing port ${port}: a real wazap listens there`);
  }
  return Number(port);
}

// ---------------------------------------------------------------------------
// Arguments.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { fixture: DEFAULT_WORLD, port: 0, oauth: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "--fixture":
        out.fixture = resolve(next());
        break;
      case "--case":
        out.case = resolve(next());
        break;
      case "--port":
        out.port = Number(next());
        break;
      case "--out":
        out.out = resolve(next());
        break;
      case "--anchor":
        out.anchor = next();
        break;
      case "--data-root":
        out.dataRoot = next();
        break;
      case "--write-token":
        out.writeToken = next();
        break;
      case "--read-token":
        out.readToken = next();
        break;
      case "--oauth":
        out.oauth = true;
        break;
      case "--public-url":
        out.publicUrl = next();
        break;
      case "--password":
        out.password = next();
        break;
      case "--state-dir":
        out.stateDir = resolve(next());
        break;
      case "--quiet":
        out.quiet = true;
        break;
      default:
        throw new Error(`Unknown argument ${arg}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The server.
// ---------------------------------------------------------------------------

const token = (prefix) => `${prefix}-${randomBytes(12).toString("hex")}`;

function sameSecret(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJsonBody(req) {
  return new Promise((done, fail) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        done(body ? JSON.parse(body) : {});
      } catch (err) {
        fail(err);
      }
    });
    req.on("error", fail);
  });
}

/** The `{ error, message }` an error result carries as its first text block, or null. */
function textError(result) {
  try {
    const body = JSON.parse(result?.content?.find((block) => block.type === "text")?.text ?? "");
    return body !== null && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

/** A case file's world patch, and the case. */
export function caseWorld(casePath) {
  const theCase = casePath ? JSON.parse(readFileSync(casePath, "utf8")) : null;
  return { patch: theCase?.fixture?.patch, theCase };
}

/**
 * Start the evaluation server in this process. The caller must have imported
 * scripts/eval/clock.mjs first (this module does).
 */
export async function startEvalServer(options = {}) {
  const liveDataDir = process.env.WAZAP_DATA_DIR;
  for (const key of Object.keys(process.env)) if (key.startsWith("WAZAP_")) delete process.env[key];
  Object.assign(process.env, {
    WAZAP_NO_UPDATE_CHECK: "1",
    WAZAP_NO_SHARE: "1",
    WAZAP_TRANSCRIBE: "off",
    WAZAP_WEBHOOK: "off",
    WAZAP_RECALL: "local",
    WAZAP_RECALL_MIN_SIMILARITY: "0.3",
  });

  const port = assertSafePort(options.port ?? 0);
  const dataRoot = assertSafeDataRoot(options.dataRoot ?? join(tmpdir(), "wazap-eval"), { WAZAP_DATA_DIR: liveDataDir });
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });

  const [{ McpServer }, { socketFactory }, { startHttpEndpoint }, fixture, { startEmbedStub }, { sqlite }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("../../dist/pairing.js"),
    import("../../dist/server.js"),
    import("./fixture.mjs"),
    import("./embed-stub.mjs"),
    import("../../dist/db/sqlite.js"),
  ]);

  // Nothing in this process may open a real WhatsApp connection.
  socketFactory.open = () => {
    throw new Error("eval server: real WhatsApp sockets are disabled");
  };

  const embed = await startEmbedStub();
  process.env.WAZAP_EMBED_URL = embed.url;

  const say = options.quiet ? () => {} : (line) => process.stderr.write(`[eval] ${line}\n`);
  const state = {
    turn: 0,
    session: null,
    label: options.label ?? null,
    out: options.out ?? null,
    trace: [],
    effects: [],
    faults: [],
    timers: new Set(),
    world: null,
    worldDir: null,
    anchorMs: 0,
    patch: options.patch,
    fixture: options.fixture ?? DEFAULT_WORLD,
    generation: 0,
  };
  const startedAt = Date.now();

  const writeLine = (name, entry) => {
    if (!state.out) return;
    mkdirSync(state.out, { recursive: true });
    appendFileSync(join(state.out, name), `${JSON.stringify(entry)}\n`);
  };

  // Server-side trace: every tool any session registers is wrapped here, in
  // this process, so the trace needs no seam in src and works on any version.
  const writeSessions = new WeakSet();
  const original = McpServer.prototype.registerTool;
  if (!original.__evalWrapped) {
    const wrapped = function registerTool(name, config, callback) {
      if (name === "send_message") writeSessions.add(this);
      // An arrow keeps `this`: the session's McpServer, write or read.
      return original.call(this, name, config, async (args, extra) => {
        const started = Date.now();
        const entry = {
          seq: state.trace.length + 1,
          generation: state.generation,
          turn: state.turn,
          session: state.session,
          mcp_session: extra?.sessionId ?? null,
          write_session: writeSessions.has(this),
          at: new Date(started).toISOString(),
          tool: name,
          args: args ?? {},
        };
        try {
          const result = await callback(args, extra);
          // A text-format session (an assistant's) sends no structured content; the answer keeps it under
          // this symbol (src/tool-runtime.ts STRUCTURED_COPY), never on the wire, for this trace.
          const structured = result?.structuredContent ?? result?.[Symbol.for("wazap/structured-copy")] ?? null;
          // A tool with an outputSchema answers an error as text only: { error, message, fix }.
          const failure = result?.isError ? (structured ?? textError(result)) : null;
          Object.assign(entry, {
            ms: Date.now() - started,
            account: typeof structured?.account_id === "string" ? structured.account_id : null,
            is_error: result?.isError === true,
            error: result?.isError ? (failure?.error ?? "UNKNOWN") : null,
            message: result?.isError ? (failure?.message ?? null) : null,
            result: structured,
            text: (result?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n"),
            images: (result?.content ?? []).filter((block) => block.type === "image").length,
          });
          return result;
        } catch (err) {
          Object.assign(entry, { ms: Date.now() - started, is_error: true, error: "THREW", message: String(err?.message ?? err) });
          throw err;
        } finally {
          state.trace.push(entry);
          writeLine("trace.jsonl", entry);
        }
      });
    };
    wrapped.__evalWrapped = true;
    McpServer.prototype.registerTool = wrapped;
  }

  const onEffect = (effect) => {
    effect.turn = state.turn;
    effect.session = state.session;
    effect.generation = state.generation;
    effect.at = new Date(effect.at).toISOString();
    writeLine("effects.jsonl", effect);
  };

  async function build({ patch, anchor } = {}) {
    for (const timer of state.timers) clearTimeout(timer);
    state.timers.clear();
    if (state.world) {
      await state.world.hub.stop().catch(() => {});
      if (state.worldDir) rmSync(state.worldDir, { recursive: true, force: true });
    }
    state.generation += 1;
    state.turn = 0;
    state.session = null;
    state.trace.length = 0;
    state.effects.length = 0;
    state.faults.length = 0;
    const merged = fixture.loadWorld(state.fixture, patch);
    state.anchorMs = anchorFor(anchor ?? options.anchor, merged.clock?.time ?? "15:30");
    setClock(state.anchorMs);
    state.worldDir = mkdtempSync(join(dataRoot, "world-"));
    state.world = await fixture.buildWorld({
      world: merged,
      anchorMs: state.anchorMs,
      dataDir: state.worldDir,
      effects: state.effects,
      faults: state.faults,
      onEffect,
    });
    say(`world ${state.generation} ready (${[...state.world.parts.keys()].join(", ")}) at ${new Date(state.anchorMs).toString()}`);
    return info();
  }

  const current = () => {
    if (!state.world) throw new Error("the world is being rebuilt");
    return state.world.hub;
  };
  /** The hub the endpoint serves, swapped under it on reset so the URL and OAuth survive. */
  const source = {
    binding: (id) => current().binding(id),
    defaultBinding: () => current().defaultBinding(),
    bindings: () => current().bindings(),
    findByChat: (jid) => current().findByChat(jid),
    findByMessage: (id) => current().findByMessage(id),
    findByDraft: (id) => current().findByDraft(id),
    record: (id) => current().record(id),
    records: () => current().records(),
    recordOnDisk: (id) => current().recordOnDisk(id),
    reload: () => current().reload(),
    noteOwner: (id, owner) => current().noteOwner(id, owner),
  };

  await build({ patch: options.patch });

  const tokens = { write: options.writeToken ?? token("eval-write"), read: options.readToken ?? token("eval-read") };
  const controlToken = token("eval-control");
  const stop = new AbortController();
  const config = { ...fixture.evalConfig(state.worldDir) };
  let oauth;
  if (options.oauth) {
    if (!options.publicUrl || !options.password) throw new Error("--oauth needs --public-url and --password");
    const stateDir = options.stateDir ?? join(homedir(), ".wazap-eval", "oauth");
    assertSafeDataRoot(stateDir, { WAZAP_DATA_DIR: liveDataDir });
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const { WazapOAuthProvider } = await import("../../dist/oauth.js");
    oauth = new WazapOAuthProvider({
      publicUrl: new URL(options.publicUrl),
      password: options.password,
      stateFile: join(stateDir, "oauth.json"),
    });
    Object.assign(config, { publicUrl: options.publicUrl, oauthPassword: options.password, trustedProxies: ["loopback"] });
  }
  const mcpPort = await startHttpEndpoint(source, config, {
    host: "127.0.0.1",
    port,
    openRead: false,
    signal: stop.signal,
    oauth,
    credentials: [
      // An assistant's session, not a builder's: the evaluation measures what ChatGPT or Claude
      // get, so the draft rules that hold for local and OAuth clients hold here too. The label is
      // also catch_up's mark key, so the two sessions keep their own marks.
      { token: tokens.write, write: true, localFiles: false, label: "local:eval" },
      { token: tokens.read, write: false, label: "local:eval-read" },
    ],
  });

  // ---- control ------------------------------------------------------------

  function part(accountId) {
    const found = state.world.parts.get(accountId ?? state.world.defaultAccount);
    if (!found) throw new Error(`No account "${accountId}"`);
    return found;
  }

  function rows(svc, sql, ...params) {
    const { DatabaseSync } = sqlite();
    const reader = new DatabaseSync(svc.db.path, { readOnly: true });
    try {
      return reader.prepare(sql).all(...params);
    } finally {
      reader.close();
    }
  }

  async function snapshot() {
    const accounts = {};
    const now = Date.now();
    for (const [id, { svc, people }] of state.world.parts) {
      let waiting;
      try {
        waiting = (await svc.getUnanswered(0, 336, 50)).data.map((entry) => ({ chat_id: entry.chat_id, name: entry.name, ask: entry.ask?.text ?? null }));
      } catch (err) {
        waiting = [{ error: String(err?.message ?? err) }];
      }
      const drafts = rows(svc, "SELECT draft_id, chat_jid, state, expires_at FROM sends ORDER BY created_at").map((row) => ({
        draft_id: row.draft_id,
        chat_id: row.chat_jid,
        state: row.state === "draft" && Number(row.expires_at) <= now ? "expired" : row.state,
      }));
      const contacts = {};
      for (const person of people.values()) {
        if (person.me) continue;
        const notes = svc.db.identity.notes(person.jid);
        contacts[person.key] = {
          jid: person.jid,
          note: notes?.note ?? null,
          tags: notes?.tags ?? [],
          fields: notes?.fields ?? {},
        };
      }
      accounts[id] = { status: svc.getStatus().status, waiting, drafts, contacts };
    }
    return {
      now: new Date(now).toISOString(),
      anchor: new Date(state.anchorMs).toISOString(),
      generation: state.generation,
      turn: state.turn,
      session: state.session,
      trace_count: state.trace.length,
      effects_count: state.effects.length,
      accounts,
    };
  }

  function expireDrafts(accountId) {
    const targets = accountId ? [part(accountId)] : [...state.world.parts.values()];
    let expired = 0;
    const { DatabaseSync } = sqlite();
    for (const { svc } of targets) {
      const writer = new DatabaseSync(svc.db.path);
      try {
        writer.exec("PRAGMA busy_timeout = 5000");
        expired += Number(writer.prepare("UPDATE sends SET expires_at = ? WHERE state = 'draft'").run(Date.now() - 1).changes);
      } finally {
        writer.close();
      }
    }
    return { expired };
  }

  function schedule(ms, work) {
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      try {
        work();
      } catch (err) {
        say(`scheduled work failed: ${err?.message ?? err}`);
      }
    }, ms);
    state.timers.add(timer);
  }

  function inject({ after_ms = 0, message }) {
    const spec = fixture.resolveRefs(message, state.world.refs);
    const generation = state.generation;
    schedule(after_ms, () => {
      if (generation === state.generation) fixture.deliver(state.world, spec);
    });
    return { scheduled_in_ms: after_ms };
  }

  function sendFault({ account, chat, mode = "timeout", echo_after_ms, once = true }) {
    const target = part(account);
    const jid = fixture.resolveRefs(chat, state.world.refs);
    const chatJid = typeof jid === "string" && jid.includes("@") ? jid : `${String(jid).replace(/\D/g, "")}@s.whatsapp.net`;
    const generation = state.generation;
    const fault = { account: target.spec.id, jid: chatJid, mode, once };
    if (echo_after_ms !== undefined) {
      fault.onRelay = ({ message, keyId }) => {
        schedule(echo_after_ms, () => {
          if (generation !== state.generation) return;
          target.sock.ev.emit("messages.upsert", {
            type: "append",
            messages: [{ key: { remoteJid: chatJid, fromMe: true, id: keyId }, message, messageTimestamp: Math.floor(Date.now() / 1000) }],
          });
        });
      };
    }
    state.faults.push(fault);
    return { account: fault.account, jid: chatJid, mode, echo_after_ms: echo_after_ms ?? null };
  }

  async function applyHook(hook) {
    switch (hook.hook) {
      case "expire_drafts":
        return expireDrafts(hook.account);
      case "inject":
        return inject(hook);
      case "send_fault":
        return sendFault(hook);
      case "status": {
        const { svc } = part(hook.account);
        svc.status = hook.status;
        return { status: hook.status };
      }
      default:
        throw new Error(`Unknown hook "${hook.hook}"`);
    }
  }

  function info() {
    return {
      generation: state.generation,
      anchor: new Date(state.anchorMs).toISOString(),
      anchor_sentence: anchorSentence(state.anchorMs),
      calendar: calendarWords(state.anchorMs),
      accounts: [...state.world.parts.keys()],
      default_account: state.world.defaultAccount,
    };
  }

  const control = http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const peer = req.socket.remoteAddress ?? "";
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer)) return reply(403, { error: "loopback only" });
      if (!sameSecret(req.headers["x-eval-control"], controlToken)) return reply(401, { error: "control token" });
      const url = new URL(req.url, "http://127.0.0.1");
      const body = req.method === "POST" ? await readJsonBody(req) : {};
      switch (`${req.method} ${url.pathname}`) {
        case "GET /eval/state":
          return reply(200, await snapshot());
        case "GET /eval/trace":
          return reply(200, state.trace);
        case "GET /eval/effects":
          return reply(200, state.effects);
        case "GET /eval/refs":
          return reply(200, { ...state.world.refs, calendar: calendarWords(state.anchorMs) });
        case "GET /eval/info":
          return reply(200, info());
        case "POST /eval/reset":
          if (body.out !== undefined) state.out = body.out ? resolve(body.out) : null;
          return reply(200, await build({ patch: body.patch, anchor: body.anchor }));
        case "POST /eval/turn":
          state.turn = Number(body.turn ?? state.turn);
          state.session = body.session ?? state.session;
          writeLine("marks.jsonl", { at: new Date().toISOString(), turn: state.turn, session: state.session, label: body.label ?? null });
          return reply(200, { turn: state.turn, session: state.session });
        case "POST /eval/hooks": {
          const results = [];
          for (const hook of body.hooks ?? []) results.push(await applyHook(hook));
          return reply(200, { results });
        }
        case "POST /eval/expire-drafts":
          return reply(200, expireDrafts(body.account));
        case "POST /eval/inject":
          return reply(200, inject(body));
        case "POST /eval/send-fault":
          return reply(200, sendFault(body));
        case "POST /eval/stop":
          reply(200, { stopping: true });
          setImmediate(() => void shutdown());
          return undefined;
        default:
          return reply(404, { error: "no such control" });
      }
    } catch (err) {
      return reply(500, { error: String(err?.message ?? err) });
    }
  });
  await new Promise((done) => control.listen(0, "127.0.0.1", done));

  let stopping = null;
  async function shutdown() {
    stopping ??= (async () => {
      for (const timer of state.timers) clearTimeout(timer);
      stop.abort();
      control.close();
      await state.world?.hub.stop().catch(() => {});
      await embed.close();
      if (state.worldDir) rmSync(state.worldDir, { recursive: true, force: true });
      options.onStop?.();
    })();
    return stopping;
  }

  return {
    mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
    controlUrl: `http://127.0.0.1:${control.address().port}`,
    controlToken,
    tokens,
    info,
    state,
    snapshot,
    build,
    applyHook,
    shutdown,
    startedAt,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { patch, theCase } = caseWorld(args.case);
  const server = await startEvalServer({ ...args, patch, label: theCase?.id, onStop: () => process.exit(0) });
  const ready = {
    mcp_url: server.mcpUrl,
    control_url: server.controlUrl,
    control_token: server.controlToken,
    tokens: server.tokens,
    pid: process.pid,
    ...server.info(),
  };
  process.stdout.write(`READY ${JSON.stringify(ready)}\n`);
  const bye = () => void server.shutdown();
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realOrResolved(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`[eval] ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
