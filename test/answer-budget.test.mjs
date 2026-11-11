/**
 * What each tool's answer costs an assistant, on the evaluation's fixture
 * world (scripts/answer-budget.mjs): a text answer, the text session's tool
 * list and the instructions each stay under their line, so an answer that
 * grows does so in a commit that moves the line. The structured copy is
 * reported, not bounded: it is the program contract, and an assistant's
 * session never receives it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ANSWER_CALLS, MAX_BYTES, measureAnswers, overBudget } from "../scripts/answer-budget.mjs";

test("every measured answer, the text session's tool list and the instructions stay under their lines", async () => {
  const report = await measureAnswers();
  assert.equal(report.rows.length, ANSWER_CALLS.length);
  assert.deepEqual(Object.keys(MAX_BYTES.text).sort(), ANSWER_CALLS.map(([label]) => label).sort(), "a line for every call, and no stale one");
  assert.deepEqual(overBudget(report), []);
  // The text session is the full one less its output schemas, nothing else.
  assert.equal(report.tools_list_text, report.tools_list_text_without_output_schema);
  assert.ok(report.tools_list_text < report.tools_list_full / 2, `${report.tools_list_text} vs ${report.tools_list_full}`);
  // A read is several times cheaper as text than as structured content, which is what Claude Code used to be fed.
  const read = report.rows.find((row) => row.label === "read_messages 60");
  assert.ok(read.text_bytes * 3 < read.structured_bytes, `${read.text_bytes} text vs ${read.structured_bytes} structured`);
  for (const row of report.rows) assert.ok(row.text_bytes > 0, `${row.label} answered no text`);
});
