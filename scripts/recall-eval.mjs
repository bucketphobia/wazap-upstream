/**
 * Score recall against a fixed case set, so prompt/model/floor changes are
 * measured instead of eyeballed. Talks to the running daemon over its MCP
 * HTTP endpoint — the service must be up and the index `ready`.
 *
 *   node scripts/recall-eval.mjs <cases.json> [--daemon <path>] [--json]
 *
 * cases.json:
 *   { "limit": 5, "cases": [
 *     { "query": "when are we meeting", "expect": "Monday" },
 *     { "query": "...", "expect": ["needle a", "needle b"] },   // any match wins
 *     { "query": "...", "expectNone": true },                  // index must not answer
 *     { "query": "...", "expect": "...", "chat_id": "...", "from": "me",
 *       "since": "2026-09-01", "until": "2026-09-10" }         // optional filters
 *   ] }
 *
 * "expect" needles match case-insensitively against a hit's indexed text.
 * The summary reports the band between the worst expected hit and the best
 * noise hit — where a similarity floor can still separate them. The real
 * case set is private data; keep it outside the repo (e.g. in the data dir)
 * and point the script at it. See scripts/recall-eval.example.json.
 *
 * Exit 1 when any case fails, so a release check can run it.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const casesFile = args.find((a) => !a.startsWith("--"));
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const daemonFile = flag("--daemon") ?? join(process.env.WAZAP_DATA_DIR ?? join(homedir(), ".wazap"), "daemon.json");
const asJson = args.includes("--json");

if (!casesFile) {
  console.error("usage: node scripts/recall-eval.mjs <cases.json> [--daemon <path>] [--json]");
  process.exit(2);
}

const daemon = JSON.parse(readFileSync(daemonFile, "utf8"));
const suite = JSON.parse(readFileSync(casesFile, "utf8"));
const cases = suite.cases ?? [];
const defaultLimit = suite.limit ?? 5;

const client = new Client({ name: "wazap-recall-eval", version: "0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${daemon.token}` } },
  })
);

const fold = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const snippet = (text, n = 70) => (text.length > n ? `${text.slice(0, n)}…` : text).replace(/\n/g, " ");

const report = [];
let failures = 0;
let minExpectedSim = Infinity;
let maxNoiseSim = -Infinity;

for (const c of cases) {
  const limit = c.limit ?? defaultLimit;
  const result = await client.callTool({
    name: "search",
    arguments: {
      query: c.query,
      limit,
      ...(c.chat_id ? { chat_id: c.chat_id } : {}),
      ...(c.from ? { from: c.from } : {}),
      ...(c.since ? { since: c.since } : {}),
      ...(c.until ? { until: c.until } : {}),
    },
  });
  const answer = result.structuredContent;
  if (answer !== undefined && answer.mode !== "hybrid") {
    const why = answer.recall_unavailable;
    console.error(`search answered mode ${answer.mode}, not a meaning search: ${why === undefined ? "is recall on?" : `${why.code}: ${why.message}${why.fix ? ` ${why.fix}` : ""}`}`);
    process.exit(2);
  }
  const hits = answer?.messages ?? [];
  const hitText = (h) => h.text ?? "";
  const needles = c.expect === undefined ? [] : fold(Array.isArray(c.expect) ? c.expect.join("\n") : c.expect).split("\n");
  const match = c.expectNone
    ? null
    : hits.findIndex((h) => needles.some((n) => n !== "" && fold(hitText(h)).includes(n)));

  if (c.expectNone) {
    const top = hits[0];
    const pass = hits.length === 0;
    if (top) maxNoiseSim = Math.max(maxNoiseSim, top.similarity);
    if (!pass) failures++;
    report.push({ query: c.query, kind: "negative", pass, noise: hits.length, topSim: top?.similarity ?? null });
    if (!asJson)
      console.log(
        `${pass ? "PASS" : "FAIL"}  negative  "${c.query}" → ${hits.length === 0 ? "no hits" : `${hits.length} hits (top sim ${(top.similarity ?? 0).toFixed(3)}: "${snippet(hitText(top))}")`}`
      );
  } else {
    const pass = match !== -1;
    if (!pass) failures++;
    const matched = pass ? hits[match] : null;
    if (matched) minExpectedSim = Math.min(minExpectedSim, matched.similarity);
    // Hits above a missing expected one are calibration noise only when the
    // query genuinely has an answer that lost — count them toward noise.
    if (!pass && hits[0]) maxNoiseSim = Math.max(maxNoiseSim, hits[0].similarity ?? 0);
    report.push({
      query: c.query,
      kind: "positive",
      pass,
      rank: pass ? match + 1 : null,
      sim: matched?.similarity ?? null,
      hits: hits.length,
      topText: snippet(matched ? hitText(matched) : hitText(hits[0] ?? {})),
    });
    if (!asJson)
      console.log(
        `${pass ? "PASS" : "FAIL"}  positive  "${c.query}" → ${
          pass
            ? `#${match + 1} sim ${matched.similarity?.toFixed(3) ?? "- (words)"}${matched.from_index ? " (index only)" : ""}: "${snippet(hitText(matched))}"`
            : `expected needle absent in ${hits.length} hits`
        }`
      );
  }
}

await client.close();

const summary = {
  total: cases.length,
  passed: cases.length - failures,
  failed: failures,
  minExpectedSimilarity: minExpectedSim === Infinity ? null : minExpectedSim,
  maxNoiseSimilarity: maxNoiseSim === -Infinity ? null : maxNoiseSim,
  separable:
    minExpectedSim !== Infinity && maxNoiseSim !== -Infinity ? maxNoiseSim < minExpectedSim : null,
  cases: report,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const band =
    summary.minExpectedSimilarity !== null && summary.maxNoiseSimilarity !== null
      ? `floor band (${summary.maxNoiseSimilarity.toFixed(3)}, ${summary.minExpectedSimilarity.toFixed(3)})${summary.separable ? "" : " — OVERLAP, no clean floor"}`
      : summary.minExpectedSimilarity !== null
        ? `min expected sim ${summary.minExpectedSimilarity.toFixed(3)}; negatives clean, no noise sampled`
        : "not enough data for a floor band";
  console.log(`\n${summary.passed}/${summary.total} passed · ${band}`);
}
process.exit(failures === 0 ? 0 : 1);
