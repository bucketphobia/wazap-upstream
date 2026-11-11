/**
 * What each tool's answer costs an agent, measured on the evaluation's
 * fixture world (eval/fixtures/world.json, anchored at a fixed day): the real
 * HTTP endpoint answers a program's session (the full format, text and
 * structured content side by side) and an assistant's (the text format, the
 * text alone), and each answer's bytes are counted. Tokens are characters /
 * CHARS_PER_TOKEN (2.2, src/catchup.ts), the ratio measured on Claude for
 * these answers; images are counted apart.
 *
 *   npm run build && node scripts/answer-budget.mjs [--json] [--check]
 *
 * `--check` fails when a text answer, the text session's tool list, the
 * instructions or learn's index is past its line in MAX_BYTES;
 * test/answer-budget.test.mjs holds the same lines. A change that makes an
 * answer longer on purpose moves its line, in the same commit.
 */
import "./eval/clock.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { startEvalServer } from "./eval/server.mjs";
import { CHARS_PER_TOKEN } from "../dist/catchup.js";

/** The fixed day the fixture world is built at, so the sizes do not move with the calendar. */
export const ANCHOR = "2026-11-10 15:30";

/** The calls measured, in order: a label, the tool and its arguments from the world's references. */
export const ANSWER_CALLS = [
  ["learn", "learn", () => ({})],
  ["learn all", "learn", () => ({ topic: "all" })],
  ["get_status", "get_status", () => ({})],
  ["list_chats 20", "list_chats", () => ({ limit: 20 })],
  ["read_messages 20", "read_messages", (r) => ({ chat_id: r.groups.bloc12.jid, limit: 20 })],
  ["read_messages 60", "read_messages", (r) => ({ chat_id: r.groups.bloc12.jid, limit: 60 })],
  ["read_messages previews", "read_messages", (r) => ({ chat_id: r.contacts.ana_vasile.jid, include_previews: true })],
  ["catch_up 48h", "catch_up", () => ({ hours: 48 })],
  ["catch_up 14d ids", "catch_up", () => ({ hours: 336, ids: true })],
  ["search apă caldă", "search", () => ({ query: "apă caldă" })],
  ["search factura enel", "search", () => ({ query: "factura enel" })],
  ["get_message", "get_message", (r) => ({ message_id: r.messages.party_address.id })],
  ["find_contact Ana", "find_contact", () => ({ name: "Ana" })],
  ["find_contact mama", "find_contact", () => ({ name: "mama" })],
  ["list_contacts", "list_contacts", () => ({})],
  ["get_group_info", "get_group_info", (r) => ({ group_id: r.groups.bloc12.jid })],
  ["get_media photo", "get_media", (r) => ({ message_id: r.messages.meter_photo.id })],
  ["get_media pdf", "get_media", (r) => ({ message_id: r.messages.extras_pdf.id })],
  ["get_media voice", "get_media", (r) => ({ message_id: r.messages.elena_voice.id })],
  ["send_message", "send_message", (r) => ({ chat_id: r.contacts.mihai.jid, text: "Vin și eu sâmbătă, ne vedem la 5." })],
  ["manage_chat preview", "manage_chat", (r) => ({ chat_id: r.contacts.mihai.jid, action: "archive" })],
];

/**
 * The lines the sizes may not pass, in bytes: what this version measures,
 * plus about a tenth. `text` is what an assistant's session receives of each
 * answer; the rest is what every assistant conversation starts with.
 */
export const MAX_BYTES = {
  text: {
    learn: 400,
    "learn all": 8_900,
    get_status: 750,
    "list_chats 20": 2_600,
    "read_messages 20": 2_700,
    "read_messages 60": 7_700,
    "read_messages previews": 1_200,
    "catch_up 48h": 3_000,
    "catch_up 14d ids": 4_100,
    "search apă caldă": 1_600,
    "search factura enel": 5_200,
    get_message: 250,
    "find_contact Ana": 1_100,
    "find_contact mama": 800,
    list_contacts: 1_050,
    get_group_info: 600,
    "get_media photo": 250,
    "get_media pdf": 600,
    "get_media voice": 220,
    send_message: 550,
    "manage_chat preview": 560,
  },
  /** tools/list of a remote write session in the text format: no outputSchema. */
  tools_list_text: 26_000,
  instructions: 3_700,
};

const bytes = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
const tokens = (n) => Math.round(n / CHARS_PER_TOKEN);

/** An MCP session on the endpoint as `clientName`, counting what crosses it. */
async function session(url, token, clientName) {
  let sid;
  let id = 0;
  const post = async (body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) },
      body: JSON.stringify(body),
    });
    sid ??= res.headers.get("mcp-session-id") ?? undefined;
    const raw = await res.text();
    const data = raw.trimStart().startsWith("{") ? raw : raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).at(-1);
    return data ? JSON.parse(data) : null;
  };
  const init = await post({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const listed = await post({ jsonrpc: "2.0", id: ++id, method: "tools/list", params: {} });
  return {
    instructions: init.result.instructions,
    tools: listed.result.tools,
    call: async (name, args) => (await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })).result,
    close: () => fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${token}`, "mcp-session-id": sid } }).catch(() => {}),
  };
}

/** Every call of ANSWER_CALLS on a fresh fixture world, and the size of what an assistant starts with. */
export async function measureAnswers() {
  const dataRoot = mkdtempSync(join(tmpdir(), "wazap-answer-budget-"));
  const server = await startEvalServer({ quiet: true, dataRoot, anchor: ANCHOR });
  try {
    const refs = server.state.world.refs;
    // An unknown client on a static token: the full format, both renderings of each answer.
    const program = await session(server.mcpUrl, server.tokens.write, "answer-budget");
    const assistant = await session(server.mcpUrl, server.tokens.write, "claude-code");
    const rows = [];
    for (const [label, name, args] of ANSWER_CALLS) {
      const result = await program.call(name, args(refs));
      const content = result?.content ?? [];
      const images = content.filter((block) => block.type === "image");
      rows.push({
        label,
        tool: name,
        text_bytes: bytes(content.filter((block) => block.type === "text").map((block) => block.text).join("\n")),
        structured_bytes: result?.structuredContent === undefined ? 0 : bytes(result.structuredContent),
        images: images.length,
        image_base64_bytes: images.reduce((n, block) => n + block.data.length, 0),
      });
    }
    const withoutOutput = (tools) => tools.map(({ outputSchema: _output, ...tool }) => tool);
    const report = {
      chars_per_token: CHARS_PER_TOKEN,
      rows,
      tools_list_full: bytes({ tools: program.tools }),
      tools_list_text: bytes({ tools: assistant.tools }),
      tools_list_text_without_output_schema: bytes({ tools: withoutOutput(assistant.tools) }),
      instructions: bytes(assistant.instructions),
    };
    await program.close();
    await assistant.close();
    return report;
  } finally {
    await server.shutdown();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

/** Every line of MAX_BYTES the report is past, as sentences. */
export function overBudget(report) {
  const over = [];
  for (const row of report.rows) {
    const max = MAX_BYTES.text[row.label];
    if (max === undefined) over.push(`${row.label}: no line in MAX_BYTES.text`);
    else if (row.text_bytes > max) over.push(`${row.label}: ${row.text_bytes} bytes of text, over ${max}`);
  }
  if (report.tools_list_text > MAX_BYTES.tools_list_text) over.push(`tools/list (text session): ${report.tools_list_text} bytes, over ${MAX_BYTES.tools_list_text}`);
  if (report.instructions > MAX_BYTES.instructions) over.push(`instructions: ${report.instructions} bytes, over ${MAX_BYTES.instructions}`);
  return over;
}

function table(report) {
  const pad = (value, width) => String(value).padStart(width);
  const lines = [
    `Answers on the fixture world (tokens at ${report.chars_per_token} characters each; images apart)`,
    `${"call".padEnd(24)}${pad("text B", 8)}${pad("text tk", 9)}${pad("struct B", 10)}${pad("struct tk", 10)}${pad("images", 8)}${pad("max", 7)}`,
  ];
  for (const row of report.rows) {
    lines.push(
      `${row.label.padEnd(24)}${pad(row.text_bytes, 8)}${pad(tokens(row.text_bytes), 9)}${pad(row.structured_bytes, 10)}${pad(tokens(row.structured_bytes), 10)}${pad(row.images, 8)}${pad(MAX_BYTES.text[row.label] ?? "-", 7)}`
    );
  }
  lines.push(
    `tools/list: ${report.tools_list_full} bytes in a full session, ${report.tools_list_text} in a text one (max ${MAX_BYTES.tools_list_text})`,
    `instructions: ${report.instructions} bytes (max ${MAX_BYTES.instructions})`
  );
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const report = await measureAnswers();
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : table(report));
  if (args.includes("--check")) {
    const over = overBudget(report);
    if (over.length > 0) {
      console.error(over.join("\n"));
      process.exitCode = 1;
    }
  }
  process.exit();
}
