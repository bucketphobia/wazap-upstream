/**
 * End-to-end check of the shipped binary: spawn `dist/index.js` against an empty
 * data directory and talk MCP JSON-RPC to it over stdio, the way Claude Desktop
 * does. Proves an unlinked install still starts, lists its tools, and answers
 * get_status with not_linked instead of hanging or crashing.
 *
 * Rerun on its own with:  node test/smoke-stdio.mjs
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

import { TOOL_NAMES } from "../dist/tools.js";
import { BINARY, mcpClient, spawnWazap } from "./helpers.mjs";

const EXPECTED_TOOL_COUNT = TOOL_NAMES.length;
const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
const SKILL_NAMES = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/** The markdown a prompt has to hand back: the SKILL.md minus its frontmatter. */
function skillBody(name) {
  return readFileSync(join(skillsDir, name, "SKILL.md"), "utf8")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .trim();
}

export async function runSmoke({
  binary = BINARY,
  log = () => {},
  args = [],
  env = {},
  dataDir = mkdtempSync(join(tmpdir(), "wazap-smoke-")),
  keepDataDir = false,
  expectedTools = EXPECTED_TOOL_COUNT,
  expectReadOnly = false,
} = {}) {
  const { child, stderr } = spawnWazap({ dataDir, args, env, binary });
  const { request, notify } = mcpClient(child);

  try {
    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "wazap-smoke", version: "0" },
    });
    assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
    assert.equal(init.result.serverInfo.name, "wazap");
    const instructions = init.result.instructions ?? "";
    assert.match(instructions, /Call `learn` when unsure/, "the instructions name `learn` for when the agent is unsure");
    for (const name of SKILL_NAMES) {
      assert.ok(instructions.includes(name), `the instructions never name ${name}: ${instructions}`);
    }
    log(
      `initialize ok — ${init.result.serverInfo.name} ${init.result.serverInfo.version}, ${instructions.length} chars of instructions`
    );

    notify("notifications/initialized", {});

    const list = await request("tools/list", {});
    assert.equal(list.error, undefined, `tools/list failed: ${JSON.stringify(list.error)}`);
    const names = list.result.tools.map((t) => t.name).sort();
    assert.equal(names.length, expectedTools, `expected ${expectedTools} tools, got ${names.length}: ${names}`);
    log(`tools/list ok — ${names.length} tools`);

    const prompts = await request("prompts/list", {});
    assert.equal(prompts.error, undefined, `prompts/list failed: ${JSON.stringify(prompts.error)}`);
    assert.deepEqual(prompts.result.prompts.map((p) => p.name).sort(), SKILL_NAMES);
    log(`prompts/list ok — ${SKILL_NAMES.length} workflows`);

    const inbox = await request("prompts/get", { name: "whatsapp-inbox", arguments: {} });
    assert.equal(inbox.error, undefined, `prompts/get failed: ${JSON.stringify(inbox.error)}`);
    assert.equal(inbox.result.messages.length, 1);
    assert.equal(inbox.result.messages[0].content.text, skillBody("whatsapp-inbox"));
    log("prompts/get ok — whatsapp-inbox carries its SKILL.md body");

    const status = await request("tools/call", { name: "get_status", arguments: {} });
    assert.equal(status.error, undefined, `get_status failed: ${JSON.stringify(status.error)}`);
    const structured = status.result.structuredContent;
    assert.equal(structured.status, "not_linked", `expected not_linked, got ${structured.status}`);
    assert.equal(structured.read_only, expectReadOnly);
    assert.equal(structured.data_dir, dataDir);
    log(`get_status ok — status=${structured.status} data_dir=${structured.data_dir}`);

    return { toolNames: names, status: structured };
  } catch (err) {
    log(`stderr from the server:\n${stderr.join("")}`);
    throw err;
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    if (!keepDataDir) rmSync(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSmoke({ log: (line) => console.log(line) }).then(
    () => console.log("stdio smoke test passed"),
    (err) => {
      console.error(`stdio smoke test FAILED: ${err.message}`);
      process.exit(1);
    }
  );
}
