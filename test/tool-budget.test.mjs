/**
 * What the tool list costs an assistant, measured the way a client receives it
 * (scripts/tool-budget.mjs): an SDK client lists the tools, and each tool's
 * name, description, input schema and annotations are counted, a token being
 * 4 bytes of JSON. Clients send this to the model on every conversation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_DESCRIPTION_CHARS, MAX_LIST_TOKENS, measureToolBudget } from "../scripts/tool-budget.mjs";

test("a session that can write lists its tools within the token budget", async () => {
  const report = await measureToolBudget({ allowWrite: true });
  assert.equal(report.tools, 21);
  assert.ok(report.list_tokens <= MAX_LIST_TOKENS, `${report.list_tokens} tokens, over ${MAX_LIST_TOKENS}`);
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

test("a session without writes lists the reads and remember", async () => {
  const report = await measureToolBudget({ allowWrite: false });
  assert.equal(report.tools, 14);
  assert.ok(report.raw.some((tool) => tool.name === "remember"));
});
