/**
 * What the tool list costs an assistant, measured on the wire: an SDK client
 * lists the tools of a real McpServer, and each tool's share is counted in
 * bytes of JSON.
 *
 * Tokens are bytes / BYTES_PER_TOKEN, 2.45: what loading all 23 remote tool
 * definitions measured on Claude (about 10,400 tokens for 25,400 bytes). The
 * old figure, bytes / 4, is reported beside it for comparison; it undercounted
 * the list by about 40%.
 *
 * - metric 1 (the budget): name + description + inputSchema + annotations, in
 *   a session that can write. Clients send this to the model on every
 *   conversation. Measured for a local session (stdio) and a remote one (a
 *   cloud agent over HTTP, which is not shown file_path or save_to).
 * - metric 2 (reported): outputSchema.
 *
 *   npm run build && node scripts/tool-budget.mjs [--read] [--local] [--json] [--check]
 *
 * `--check` fails when metric 1 is over MAX_LIST_TOKENS or a description is
 * over MAX_DESCRIPTION_CHARS; test/tool-budget.test.mjs holds the same lines.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pathToFileURL } from "node:url";

import { registerTools } from "../dist/tools.js";

/** Bytes of tool-list JSON per Claude token, as measured (see above). */
export const BYTES_PER_TOKEN = 2.45;
/** Metric 1 in measured tokens: 23,275 bytes, tighter than the 24,000 the old 6,000 at 4 bytes allowed. */
export const MAX_LIST_TOKENS = 9500;
export const MAX_OUTPUT_SCHEMA_TOKENS = 13000;
export const MAX_DESCRIPTION_CHARS = 300;

const bytes = (value) => (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), "utf8"));
const tokens = (n) => Math.round(n / BYTES_PER_TOKEN);
const oldTokens = (n) => Math.round(n / 4);

/**
 * The tools/list an SDK client receives, and each tool's share of it.
 * `remote`: a session over HTTP that cannot use this machine's files.
 */
export async function measureToolBudget({ allowWrite = true, remote = false, format } = {}) {
  const server = new McpServer({ name: "wazap-budget", version: "1" });
  // Listing never reaches the accounts; a handler would.
  registerTools(server, {}, { allowWrite, allowLocalFiles: !remote, legacyReads: remote, ...(format === undefined ? {} : { format }) });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "budget", version: "1" });
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    const rows = tools.map((tool) => {
      const description = bytes(tool.name) + bytes(tool.description);
      const input = bytes(tool.inputSchema);
      const annotations = bytes(tool.annotations);
      return {
        name: tool.name,
        description_chars: tool.description.length,
        description_bytes: description,
        input_bytes: input,
        annotations_bytes: annotations,
        list_bytes: description + input + annotations,
        output_bytes: bytes(tool.outputSchema),
        title_bytes: bytes(tool.title),
      };
    });
    const sum = (key) => rows.reduce((n, row) => n + row[key], 0);
    return {
      session: `${remote ? "remote" : "local"} ${allowWrite ? "write" : "read"}`,
      tools: rows.length,
      rows,
      list_bytes: sum("list_bytes"),
      list_tokens: tokens(sum("list_bytes")),
      list_tokens_at_4: oldTokens(sum("list_bytes")),
      output_bytes: sum("output_bytes"),
      output_tokens: tokens(sum("output_bytes")),
      title_bytes: sum("title_bytes"),
      wire_bytes: bytes({ tools }),
      raw: tools,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

function table(report) {
  const pad = (value, width) => String(value).padStart(width);
  const lines = [
    `${report.session} session: ${report.tools} tools (tokens at ${BYTES_PER_TOKEN} bytes each)`,
    `${"tool".padEnd(20)}${pad("desc ch", 8)}${pad("desc tk", 8)}${pad("input tk", 9)}${pad("annot tk", 9)}${pad("list tk", 8)}${pad("output tk", 10)}`,
  ];
  for (const row of report.rows) {
    lines.push(
      `${row.name.padEnd(20)}${pad(row.description_chars, 8)}${pad(tokens(row.description_bytes), 8)}${pad(tokens(row.input_bytes), 9)}${pad(tokens(row.annotations_bytes), 9)}${pad(tokens(row.list_bytes), 8)}${pad(tokens(row.output_bytes), 10)}`
    );
  }
  lines.push(
    `metric 1 (name + description + inputSchema + annotations): ${report.list_bytes} bytes ≈ ${report.list_tokens} tokens (budget ${MAX_LIST_TOKENS}; ${report.list_tokens_at_4} at the old 4 bytes a token)`,
    `metric 2 (outputSchema): ${report.output_bytes} bytes ≈ ${report.output_tokens} tokens (guide ${MAX_OUTPUT_SCHEMA_TOKENS})`,
    `titles, not counted: ${report.title_bytes} bytes ≈ ${tokens(report.title_bytes)} tokens`,
    `tools/list's result, as JSON: ${report.wire_bytes} bytes (the SSE answer that carries it adds its envelope)`
  );
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const allowWrite = !args.includes("--read");
  const reports = [];
  if (!args.includes("--remote")) reports.push(await measureToolBudget({ allowWrite }));
  if (!args.includes("--local")) reports.push(await measureToolBudget({ allowWrite, remote: true }));
  if (args.includes("--json")) {
    console.log(JSON.stringify(reports.map(({ raw: _raw, ...rest }) => rest), null, 2));
  } else {
    console.log(reports.map(table).join("\n\n"));
  }
  if (args.includes("--check")) {
    for (const report of reports) {
      const long = report.rows.filter((row) => row.description_chars > MAX_DESCRIPTION_CHARS).map((row) => row.name);
      if (report.list_tokens > MAX_LIST_TOKENS || long.length > 0) {
        console.error(`${report.session} over budget: ${report.list_tokens} tokens${long.length ? `; descriptions over ${MAX_DESCRIPTION_CHARS} characters: ${long.join(", ")}` : ""}`);
        process.exitCode = 1;
      }
    }
  }
}
