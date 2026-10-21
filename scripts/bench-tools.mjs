/**
 * Tool latency on a real account: copies one account's database out of a data
 * dir (read-only, through the backup path), opens a service on the copy behind
 * a stand-in socket that never reaches WhatsApp, and times the read tools the
 * way an MCP client calls them. The source data dir is never written; the copy
 * is deleted afterwards. Run `npm run build` first — this imports dist/.
 *
 *   npm run bench:tools                         # ~/.wazap, account "default"
 *   node scripts/bench-tools.mjs --data-dir <dir> --account <id> --runs 15 --json out.json
 *
 * Recall runs on the data dir's own settings (its .env), so search embeds its
 * query with the account's model; a "(new)" case forgets the query's embedding
 * before each call, a "(repeat)" case keeps it. Timings are p50/max in ms over
 * `--runs` calls after one warm-up, whose time is reported as `first`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import { z } from "zod";

import { singletonSource } from "../dist/account-hub.js";
import { accountPaths, parseCli } from "../dist/config.js";
import { backupDatabase } from "../dist/db/index.js";
import { registerTools } from "../dist/tools.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { fakeSocket } from "../test/helpers.mjs";

const { values: args } = parseArgs({
  options: {
    "data-dir": { type: "string", default: join(homedir(), ".wazap") },
    account: { type: "string", default: "default" },
    runs: { type: "string", default: "15" },
    json: { type: "string" },
  },
});
const RUNS = Number(args.runs);
const source = args["data-dir"];
const registry = JSON.parse(readFileSync(join(source, "accounts.json"), "utf8"));
const account = registry.accounts.find((a) => a.id === args.account);
if (account === undefined) throw new Error(`No account "${args.account}" in ${source}/accounts.json`);

// The copy: the account's database and the settings that pick recall's model; no auth, so nothing can link.
const dataDir = mkdtempSync(join(tmpdir(), "wazap-bench-tools-"));
const paths = accountPaths(dataDir, account.id);
const from = accountPaths(source, account.id);
mkdirSync(paths.root, { recursive: true });
await backupDatabase(from.databaseFile, paths.databaseFile);
writeFileSync(join(dataDir, "accounts.json"), JSON.stringify({ ...registry, accounts: [account] }));
const env = existsSync(join(source, ".env")) ? readFileSync(join(source, ".env"), "utf8") : "";
const kept = env.split("\n").filter((line) => /^WAZAP_(RECALL|EMBED_MODEL)=/.test(line));
writeFileSync(join(dataDir, ".env"), [...kept, "WAZAP_TRANSCRIBE=off", "WAZAP_WEBHOOK=off"].join("\n") + "\n");
// The models are read where they are.
if (existsSync(join(source, "models"))) symlinkSync(join(source, "models"), join(dataDir, "models"));

for (const key of Object.keys(process.env)) if (key.startsWith("WAZAP_")) delete process.env[key];
process.env.WAZAP_NO_UPDATE_CHECK = "1";
const config = { ...parseCli(["serve", "--data-dir", dataDir]).config, transport: "stdio", share: false };
const owner = account.owner ?? "40700000000@s.whatsapp.net";
const svc = new WhatsAppService(config, { ...account }, paths);
const sock = fakeSocket();
svc.sockClient = sock;
svc.wireEvents(sock, ++svc.generation);
svc.account = { id: owner, name: "bench", number: owner.split("@")[0] };
svc.status = "connected";
svc.initialSyncDone = true;
await svc.bootStorage();

const tools = new Map();
registerTools({ registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) }, singletonSource(svc), { allowWrite: false });
const call = async (name, input) => {
  const { meta, handler } = tools.get(name);
  const started = performance.now();
  const result = await handler(z.object(meta.inputSchema).parse(input));
  return { ms: performance.now() - started, result };
};

const chatId = (await call("list_chats", {})).result.structuredContent?.chats?.[0]?.chat_id;
const CASES = [
  ["get_status", "get_status", {}],
  ["list_chats", "list_chats", {}],
  ["read_messages", "read_messages", { chat_id: chatId }],
  ["search: word (new)", "search", { query: "factura" }],
  ["search: two words (new)", "search", { query: "mâine dimineață" }],
  ["search: question (new)", "search", { query: "când ne vedem să discutăm despre mașină?" }],
  ["search: next page (repeat)", "search", { query: "factura" }],
  ["find_contact", "find_contact", { name: "Ana" }],
  ["list_contacts", "list_contacts", {}],
  ["catch_up: 24 h", "catch_up", { hours: 24 }],
  ["catch_up: 7 days", "catch_up", { hours: 168 }],
];

const results = { node: process.version, runs: RUNS, calls: {} };
for (const [label, name, input] of CASES) {
  const times = [];
  let first = 0;
  let error = null;
  for (let i = 0; i <= RUNS; i++) {
    if (label.includes("(new)")) svc.recallIndex.queryVectors.clear();
    const { ms, result } = await call(name, input);
    if (result.isError) error = result.content?.[0]?.text?.slice(0, 160) ?? "error";
    if (i === 0) first = ms;
    else times.push(ms);
  }
  times.sort((a, b) => a - b);
  const row = { first: +first.toFixed(1), p50: +times[Math.floor(times.length / 2)].toFixed(1), max: +times.at(-1).toFixed(1), ...(error ? { error } : {}) };
  results.calls[label] = row;
  console.log(`${label.padEnd(28)} first ${String(row.first).padStart(7)}  p50 ${String(row.p50).padStart(7)}  max ${String(row.max).padStart(7)}${error ? `  ${error}` : ""}`);
}
results.rss_mb = Math.round(process.memoryUsage().rss / 1048576);
console.log(`rss ${results.rss_mb} MB`);
if (args.json) writeFileSync(args.json, JSON.stringify(results, null, 1));
await svc.stop();
rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
