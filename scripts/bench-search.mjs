/**
 * Retrieval quality and latency, not assistant answer quality. Fictional
 * questions use either a deterministic embed stub or the user's installed
 * local model. --private-cases instead evaluates a backup of real history;
 * its report keeps case numbers and aggregates, never queries or message text.
 * Neither mode opens a WhatsApp connection or writes the source data dir.
 *
 * node scripts/bench-search.mjs --model real --runs 10 --json report.json
 * node scripts/bench-search.mjs --root /path/to/baseline --model real
 * node scripts/bench-search.mjs --private-cases ~/.wazap/recall-eval-real.json --model real
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { startEmbedStub } from "./eval/embed-stub.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  options: {
    root: { type: "string", default: repository },
    model: { type: "string", default: "stub" },
    "data-dir": { type: "string", default: join(homedir(), ".wazap") },
    runs: { type: "string", default: "10" },
    "private-cases": { type: "string" },
    json: { type: "string" },
    tool: { type: "string", default: "search_messages" },
    "no-context": { type: "boolean", default: false },
    limit: { type: "string" },
    "compact-query": { type: "boolean", default: false },
    diagnose: { type: "boolean", default: false },
    "context-model-experiment": { type: "boolean", default: false },
    compare: { type: "string" },
    "require-pass": { type: "boolean", default: false },
  },
});
const runs = Number(args.runs);
if (!Number.isInteger(runs) || runs < 1 || runs > 100 || !["stub", "real"].includes(args.model))
  throw new Error("Use --runs 1..100 and --model stub|real");
const fromRoot = (path) => import(pathToFileURL(join(args.root, path)).href);
const [
  { WhatsAppService },
  { connectedService, schemaCheckedTools, fakeSocket },
  { parseCli, accountPaths },
  { backupDatabase },
] = await Promise.all([
  fromRoot("dist/whatsapp.js"),
  fromRoot("test/helpers.mjs"),
  fromRoot("dist/config.js"),
  fromRoot("dist/db/index.js"),
]);
const { QUERY_STOPWORDS } = await fromRoot("dist/db/vectors.js");
const dataDir = mkdtempSync(join(tmpdir(), "wazap-bench-search-"));
const stub = args.model === "stub" ? await startEmbedStub() : null;
const source = args["data-dir"];
let svc;
const fold = (text) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)].toFixed(3);
};
try {
  for (const key of Object.keys(process.env)) if (key.startsWith("WAZAP_")) delete process.env[key];
  process.env.WAZAP_NO_UPDATE_CHECK = "1";
  let settings = [];
  if (args.model === "real") {
    if (!existsSync(join(source, ".env")) || !existsSync(join(source, "models")))
      throw new Error("The local recall model must already be installed");
    settings = readFileSync(join(source, ".env"), "utf8")
      .split("\n")
      .filter((line) => /^WAZAP_(RECALL|EMBED_MODEL|EMBED_URL|EMBED_BIN|RECALL_MIN_SIMILARITY)=/.test(line));
    symlinkSync(join(source, "models"), join(dataDir, "models"));
  } else
    settings = [
      "WAZAP_RECALL=local",
      "WAZAP_EMBED_MODEL=embeddinggemma-300m",
      `WAZAP_EMBED_URL=${stub.url}`,
      "WAZAP_RECALL_MIN_SIMILARITY=0.3",
    ];
  writeFileSync(join(dataDir, ".env"), [...settings, "WAZAP_TRANSCRIBE=off", "WAZAP_WEBHOOK=off"].join("\n") + "\n");
  const config = { ...parseCli(["serve", "--data-dir", dataDir]).config, share: false, transport: "stdio" };
  let suite;
  const ids = new Map();
  if (args["private-cases"]) {
    const registry = JSON.parse(readFileSync(join(source, "accounts.json"), "utf8"));
    const account = registry.accounts.find((a) => a.default) ?? registry.accounts.find((a) => a.id === "default");
    if (!account) throw new Error("No default source account");
    const paths = accountPaths(dataDir, account.id);
    mkdirSync(paths.root, { recursive: true });
    await backupDatabase(accountPaths(source, account.id).databaseFile, paths.databaseFile);
    svc = new WhatsAppService(config, { ...account }, paths);
    const sock = fakeSocket();
    svc.sockClient = sock;
    svc.wireEvents(sock, ++svc.generation);
    svc.account = { id: account.owner, name: "bench", number: account.owner?.split("@")[0] };
    svc.status = "connected";
    svc.initialSyncDone = true;
    suite = JSON.parse(readFileSync(args["private-cases"], "utf8"));
  } else {
    suite = JSON.parse(readFileSync(join(repository, "eval/search-questions.json"), "utf8"));
    const f = connectedService(WhatsAppService, {
      prefix: "wazap-bench-fictional-",
      id: "40700000001@s.whatsapp.net",
      name: "Owner",
      config: { ...config, persistHistory: true },
    });
    svc = f.svc;
    const chats = new Map();
    for (const [chat] of suite.messages)
      if (!chats.has(chat)) chats.set(chat, `40700000${String(chats.size + 10).padStart(3, "0")}@s.whatsapp.net`);
    const now = Math.floor(Date.now() / 1000);
    f.sock.ev.emit(
      "contacts.upsert",
      [...chats].map(([name, id]) => ({ id, name }))
    );
    f.sock.ev.emit("messages.upsert", {
      type: "append",
      messages: suite.messages.map(([chat, key, offset, text]) => {
        const jid = chats.get(chat);
        ids.set(key, `false_${jid}_${key}`);
        return {
          key: { remoteJid: jid, fromMe: false, id: key },
          messageTimestamp: now + offset,
          message: { conversation: text },
        };
      }),
    });
  }
  await svc.bootStorage();
  await svc.recallIdle();
  if (svc.getStatus().recall?.state !== "ready") throw new Error("Recall must be ready for this comparison");
  if (args["context-model-experiment"]) {
    // The data here is an immutable throwaway copy. This is an ablation,
    // deliberately not runtime code: it measures whether a contextual model
    // is worth its query-time embedding work before adding a durable index.
    const { contextRows, renderContexts } = await import(
      pathToFileURL(join(repository, "dist/service/search-context.js")).href
    );
    const { unitVector } = await fromRoot("dist/db/index.js");
    const original = svc.recall.bind(svc);
    const cache = new Map();
    svc.recall = async (query, chatId, limit, opts = {}) => {
      const result = await original(query, chatId, Math.max(30, limit), { ...opts, includeContext: false });
      const people = chatId ? null : svc.identity.privateScope(opts.private);
      const author = opts.from && people?.names(opts.from) ? opts.from : undefined;
      const contexts = new Map();
      const work = result.data.hits.flatMap((hit) => {
        const message = svc.db.messages.get(hit.message.message_id);
        if (message === null) return [];
        const rows = contextRows(svc.db, message, opts, people, author);
        contexts.set(message.id, rows);
        const text =
          `${svc.identity.displayName(message.chatJid)}\n` +
          rows
            .map((m) => `${svc.identity.displayName(m.senderJid ?? "")}: ${m.text ?? ""} ${m.transcript ?? ""}`)
            .join("\n");
        return [{ hit, message, text: text.slice(0, 4000) }];
      });
      const missing = work.filter((w) => !cache.has(w.text));
      for (let i = 0; i < missing.length; i += 8) {
        const batch = missing.slice(i, i + 8);
        const vectors = await svc.recallIndex.recallEmbed(
          batch.map((w) => w.text),
          "document"
        );
        vectors.forEach((vector, j) => cache.set(batch[j].text, unitVector(vector)));
      }
      const vector = unitVector(await svc.recallIndex.queryVector(query));
      const score = (w) => {
        const context = cache.get(w.text);
        return vector.reduce((sum, x, i) => sum + x * context[i], 0);
      };
      work.sort((a, b) => score(b) - score(a) || b.hit.score - a.hit.score);
      const top = work.slice(0, limit);
      result.data.hits = top.map((w) => w.hit);
      result.data.contexts = renderContexts(
        top.map((w) => w.message),
        contexts,
        svc.views,
        people,
        author,
        query
      );
      return result;
    };
  }
  const { call } = schemaCheckedTools(svc, { allowWrite: false, legacyReads: true });
  const report = {
    version: JSON.parse(readFileSync(join(args.root, "package.json"), "utf8")).version,
    model: args.model === "stub" ? "deterministic stub (not model quality)" : "installed local model",
    private: Boolean(args["private-cases"]),
    modelAlias: svc.recallIndex.recallEnv.model,
    node: process.version,
    runs,
    tool: args.tool,
    context: !args["no-context"],
    contextModelExperiment: args["context-model-experiment"],
    messages: suite.messages?.length,
    cases: [],
    timings: {},
    metrics: {},
  };
  const elapsed = [];
  const firstCalls = [];
  for (const [index, c] of suite.cases.entries()) {
    const query = args["compact-query"]
      ? (c.query.match(/[\p{L}\p{N}]+/gu) ?? [])
          .filter((word) => word.length > 1 && !QUERY_STOPWORDS.has(fold(word)))
          .join(" ") || c.query
      : c.query;
    const input = {
      query,
      limit: args.limit ? Number(args.limit) : (c.limit ?? suite.limit ?? 5),
      ...(args["no-context"] ? { include_context: false } : {}),
      ...(c.chat_id ? { chat_id: c.chat_id } : {}),
      ...(c.from ? { from: c.from } : {}),
      ...(c.since ? { since: c.since } : {}),
      ...(c.until ? { until: c.until } : {}),
    };
    const tool = args["private-cases"] ? "search" : args.tool;
    svc.recallIndex.queryVectors.clear();
    const started = performance.now();
    const first = await call(tool, input);
    firstCalls.push(performance.now() - started);
    if (first.isError) throw new Error(`Search failed at case ${index + 1}`);
    const answer = first.structuredContent;
    const hits = answer.messages ?? [];
    const expect = c.expect === undefined ? [] : [c.expect].flat().map(fold);
    const matches = (m) =>
      c.expectId ? m.message_id === ids.get(c.expectId) : expect.some((needle) => fold(m.text ?? "").includes(needle));
    const hitRank = hits.findIndex(matches);
    const contexts = answer.contexts ?? [];
    const evidenceRank = hits.findIndex(
      (hit) => matches(hit) || contexts.find((ctx) => ctx.anchor_id === hit.message_id)?.messages.some(matches)
    );
    const kind = c.expectNone ? "negative" : c.expectAmbiguous ? "ambiguous" : "positive";
    const unavailable =
      answer.mode === "keyword_fallback" || answer.accounts?.some((a) => a.mode === "keyword_fallback");
    const pass =
      !unavailable &&
      (kind === "negative"
        ? hits.length === 0
        : kind === "ambiguous"
          ? answer.assessment?.state === "ambiguous"
          : evidenceRank >= 0);
    const gold =
      args.diagnose && expect.length ? expect.flatMap((query) => svc.db.search.text({ query, limit: 20 }).items) : [];
    report.cases.push({
      id: c.id ?? `case-${index + 1}`,
      kind,
      pass,
      hitRank: hitRank < 0 ? null : hitRank + 1,
      evidenceRank: evidenceRank < 0 ? null : evidenceRank + 1,
      count: hits.length,
      mode: answer.mode,
      assessment: answer.assessment?.state ?? null,
      ...(unavailable ? { unavailable: true } : {}),
      ...(args["private-cases"]
        ? {}
        : {
            topSources: hits.map((h) => ({
              key: h.message_id.split("_").at(-1),
              matched: h.matched,
              similarity: h.similarity,
            })),
          }),
    });
    if (args.diagnose)
      Object.assign(report.cases.at(-1), {
        goldSources: new Set(gold.map((m) => m.sid)).size,
        longestSource: Math.max(0, ...gold.map((m) => (m.text ?? "").length + (m.transcript ?? "").length)),
      });
    for (let i = 0; i < runs; i++) {
      const at = performance.now();
      const again = await call(tool, input);
      if (again.isError) throw new Error(`Repeated search failed at case ${index + 1}`);
      elapsed.push(performance.now() - at);
    }
  }
  const positives = report.cases.filter((c) => c.kind === "positive");
  const negatives = report.cases.filter((c) => c.kind === "negative");
  const ambiguous = report.cases.filter((c) => c.kind === "ambiguous");
  report.metrics = {
    k: args.limit ? Number(args.limit) : (suite.limit ?? 5),
    positive: positives.length,
    unavailable: report.cases.filter((c) => c.unavailable).length,
    hitRecallAtK: positives.filter((c) => c.hitRank !== null).length / (positives.length || 1),
    evidenceRecallAtK: positives.filter((c) => c.evidenceRank !== null).length / (positives.length || 1),
    evidenceMRR:
      positives.reduce((n, c) => n + (c.evidenceRank === null ? 0 : 1 / c.evidenceRank), 0) / (positives.length || 1),
    negatives: negatives.length,
    correctNoMatches: negatives.filter((c) => c.pass).length,
    ambiguous: ambiguous.length,
    correctlyFlaggedAmbiguous: ambiguous.filter((c) => c.pass).length,
  };
  report.timings = {
    firstQuery: {
      samples: firstCalls.length,
      p50: percentile(firstCalls, 0.5),
      p95: percentile(firstCalls, 0.95),
      max: Math.max(...firstCalls),
    },
    repeated: { samples: elapsed.length, p50: percentile(elapsed, 0.5), p95: percentile(elapsed, 0.95) },
  };
  if (args.compare) {
    const before = JSON.parse(readFileSync(args.compare, "utf8"));
    const byId = new Map(report.cases.map((c) => [c.id, c]));
    const regressions = before.cases.filter((c) => c.pass && !byId.get(c.id)?.pass).map((c) => c.id);
    report.comparison = { formerlyPassing: before.cases.filter((c) => c.pass).length, regressions };
    if (regressions.length) process.exitCode = 1;
  }
  if (report.cases.some((c) => c.unavailable)) process.exitCode = 2;
  if (args["require-pass"] && report.cases.some((c) => !c.pass)) process.exitCode = 1;
  if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify(
      { version: report.version, model: report.model, metrics: report.metrics, timings: report.timings },
      null,
      2
    )
  );
} finally {
  await svc?.stop();
  await stub?.close();
  rmSync(dataDir, { recursive: true, force: true });
}
