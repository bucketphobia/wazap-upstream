/** Synthetic recent-page benchmark. Build first; never opens a real account.
 * --root can point at another built checkout (including test/helpers.mjs) for comparison.
 * node scripts/bench-recent.mjs --at 2026-10-21T20:00:00Z --json /tmp/recent.json
 */
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const { values } = parseArgs({ options: {
  root: { type: "string", default: fileURLToPath(new URL("..", import.meta.url)) },
  messages: { type: "string", default: "1000,10000,50000" },
  samples: { type: "string", default: "6" }, at: { type: "string" }, json: { type: "string" },
} });
const root = resolve(values.root);
const counts = values.messages.split(",").map(Number);
const samples = Number(values.samples);
const at = values.at === undefined ? Date.now() : Date.parse(values.at);
if (!Number.isFinite(at) || !Number.isInteger(samples) || samples < 1 || counts.some((n) => !Number.isInteger(n) || n < 100 || n > 200_000)) throw new Error("Invalid benchmark parameters");
const { WhatsAppService } = await import(pathToFileURL(resolve(root, "dist/whatsapp.js")));
const { connectedService, schemaCheckedTools } = await import(pathToFileURL(resolve(root, "test/helpers.mjs")));
const { version } = JSON.parse(await (await import("node:fs/promises")).readFile(resolve(root, "package.json"), "utf8"));
const stats = (values) => {
  const s = [...values].sort((a, b) => a - b), mid = Math.floor(s.length / 2);
  return { n: s.length, median_ms: +(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2).toFixed(3), min_ms: +s[0].toFixed(3), max_ms: +s.at(-1).toFixed(3) };
};
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const fingerprint = (r) => createHash("sha256").update(JSON.stringify(canonical(r.structuredContent.conversations))).digest("hex");
const out = { node: process.version, version, at: new Date(at).toISOString(), synthetic: true, chats: 100, limit: 25, warmup_pairs: 1, scenarios: [] };
const realNow = Date.now;
Date.now = () => at;
try {
  for (const count of counts) {
    const { svc } = connectedService(WhatsAppService, { prefix: "wazap-bench-recent-", id: "40700000001@s.whatsapp.net", name: "Synthetic owner" });
    try {
      const chats = Array.from({ length: 100 }, (_, i) => `4071${String(i).padStart(7, "0")}@s.whatsapp.net`);
      svc.db.transaction(() => svc.db.messages.upsertMany(Array.from({ length: count }, (_, i) => ({
        chatJid: chats[i % 100], keyId: `BENCH${i}`, fromMe: false, ts: at - 1000 - (count - i) * 1000,
        type: "text", text: `Mesaj sintetic ${i}. Poți verifica documentul?`,
      }))));
      const api = schemaCheckedTools(svc, { allowWrite: false, allowLocalFiles: false, legacyReads: true, client: `bench-recent-${count}` });
      const original = svc.views.viewOfStored.bind(svc.views);
      let views = 0;
      svc.views.viewOfStored = (...args) => { views++; return original(...args); };
      const rows = [];
      for (let i = 0; i <= samples; i++) {
        views = 0;
        const start = performance.now(), first = await api.call("get_recent_messages", { hours: 24, limit: 25, compact: true });
        const first_ms = performance.now() - start, first_views = views;
        if (first.isError || !first.structuredContent.next_cursor) throw new Error("First page failed or has no continuation");
        views = 0;
        const startNext = performance.now(), next = await api.call("get_recent_messages", { cursor: first.structuredContent.next_cursor, limit: 25 });
        const next_ms = performance.now() - startNext;
        if (next.isError) throw new Error("Continuation failed");
        const row = { first_ms, next_ms, first_views, next_views: views, first_count: first.structuredContent.message_count, next_count: next.structuredContent.message_count, first_hash: fingerprint(first), next_hash: fingerprint(next) };
        if (i > 0) rows.push(row);
      }
      const scenario = { messages: count, first_page: stats(rows.map((s) => s.first_ms)), next_page: stats(rows.map((s) => s.next_ms)), samples: rows };
      out.scenarios.push(scenario);
      console.error(JSON.stringify({ messages: count, first_page: scenario.first_page, next_page: scenario.next_page, first_views: rows[0].first_views, next_views: rows[0].next_views }));
    } finally {
      // The whole synthetic directory is removed next; avoid separately
      // purging every row during teardown, outside the measured operations.
      svc.config.persistHistory = true;
      await svc.stop();
      rmSync(svc.config.dataDir, { recursive: true, force: true });
    }
  }
} finally { Date.now = realNow; }
if (values.json) writeFileSync(values.json, JSON.stringify(out, null, 2) + "\n");
