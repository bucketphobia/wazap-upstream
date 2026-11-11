/**
 * What the tool list costs an assistant, measured the way a client receives it
 * (scripts/tool-budget.mjs): an SDK client lists the tools, and each tool's
 * name, description, input schema and annotations are counted, a token being
 * 2.45 bytes of JSON as measured on Claude. Clients send this to the model on
 * every conversation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BYTES_PER_TOKEN, MAX_DESCRIPTION_CHARS, MAX_LIST_TOKENS, measureToolBudget } from "../scripts/tool-budget.mjs";
import { HOST_FILE_ARGS } from "../dist/tool-catalogue.js";

test("a session that can write lists its tools within the token budget, locally and remotely", async () => {
  for (const remote of [false, true]) {
    const report = await measureToolBudget({ allowWrite: true, remote });
    assert.equal(report.tools, 23);
    assert.ok(report.list_tokens <= MAX_LIST_TOKENS, `${report.session}: ${report.list_tokens} tokens, over ${MAX_LIST_TOKENS}`);
    // The measured ratio, not the 4 bytes a token the budget used to assume.
    assert.equal(report.list_tokens, Math.round(report.list_bytes / BYTES_PER_TOKEN));
    assert.ok(report.list_tokens_at_4 < report.list_tokens);
  }
});

test("every description fits in 300 characters", async () => {
  const report = await measureToolBudget({ allowWrite: true });
  const long = report.rows.filter((row) => row.description_chars > MAX_DESCRIPTION_CHARS).map((row) => `${row.name} (${row.description_chars})`);
  assert.deepEqual(long, []);
});

test("account_id is named on each tool and explained once, in the server's instructions", async () => {
  const report = await measureToolBudget({ allowWrite: true });
  for (const tool of report.raw) {
    const described = tool.inputSchema.properties.account_id?.description ?? "";
    assert.ok(described.length <= 20, `${tool.name}: "${described}"`);
  }
  const { loadSkills, skillInstructions } = await import("../dist/skills.js");
  assert.match(skillInstructions(loadSkills()), /account_id/);
});

test("a session without writes lists the reads, remember and reminder", async () => {
  const report = await measureToolBudget({ allowWrite: false });
  assert.equal(report.tools, 15);
  assert.ok(report.raw.some((tool) => tool.name === "reminder"));
  assert.ok(report.raw.some((tool) => tool.name === "remember"));
});

test("no advertised schema names its JSON Schema dialect", async () => {
  for (const remote of [false, true]) {
    const report = await measureToolBudget({ allowWrite: true, remote });
    for (const tool of report.raw) {
      assert.equal(tool.inputSchema.$schema, undefined, `${tool.name} inputSchema`);
      assert.equal(tool.outputSchema?.$schema, undefined, `${tool.name} outputSchema`);
    }
  }
});

test("a remote session is not shown the host-file arguments it would be refused, and no note about them", async () => {
  const local = await measureToolBudget({ allowWrite: true });
  const remote = await measureToolBudget({ allowWrite: true, remote: true });
  const named = (report) =>
    report.raw.filter((tool) => HOST_FILE_ARGS.some((arg) => arg in tool.inputSchema.properties)).map((tool) => tool.name).sort();
  assert.deepEqual(named(local), ["get_media", "manage_group", "send_message"]);
  assert.deepEqual(named(remote), []);
  for (const tool of remote.raw) {
    assert.doesNotMatch(tool.description, /remote session cannot use/, tool.name);
    // Nothing points at an argument that is gone.
    assert.doesNotMatch(JSON.stringify(tool.inputSchema), /#\/properties\/(file_path|save_to)/, tool.name);
    assert.ok("account_id" in tool.inputSchema.properties, `${tool.name} keeps account_id`);
  }
  assert.ok(remote.list_bytes < local.list_bytes);
});
