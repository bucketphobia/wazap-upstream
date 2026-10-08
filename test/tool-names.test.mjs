/**
 * The 1.0 names, held where prose can drift back to the 40.
 *
 * test/skills.test.mjs and test/distribution.test.mjs already refuse a retired
 * name written in backticks or called; both read a hand-kept list and a
 * hand-kept set of files. This reads the whole shipped surface for the bare
 * word too ("use get_contact" carries no backticks), takes the retired list
 * from the CHANGELOG's own migration table so a row added there is guarded
 * without a second edit, and covers the files those two do not name.
 *
 * The CHANGELOG is the one place a retired name belongs — it is the migration
 * record — so it is the table's source here and never a scanned file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { TOOL_NAMES } from "../dist/tools.js";
import { RETIRED_TOOLS } from "./helpers.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFileSync(join(root, file), "utf8");

/** Everything the package or the repo teaches a client from. */
const SHIPPED = [
  ...readdirSync(join(root, "skills")).map((dir) => `skills/${dir}/SKILL.md`),
  "README.md",
  "AGENT.md",
  "CLAUDE.md",
  "manifest.json",
  "server.json",
  ".env.example",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ...readdirSync(join(root, "docs")).map((name) => `docs/${name}`),
  ...readdirSync(join(root, "deploy")).map((name) => `deploy/${name}`),
];

/**
 * Where a retired word is the record and not a teaching:
 * - `recall` also names the feature, the setting (`wazap config recall`), the
 *   whatsapp-recall skill and the doctor check, on any of these files;
 * - the security audit keeps the name a finding was found under, beside the
 *   1.0 name it reads by now.
 */
const allowed = (file, name) => name === "recall" || (name === "download_media" && file === "docs/security-audit.md");

/** Arguments 1.0 dropped with the tools that took them. Docs name an argument in backticks, so that is how they are read. */
const RETIRED_ARGS = ["min_age_hours", "max_age_hours", "include_system", "compact"];

/** The rows of the 0.23 → 1.0 table, each still `| old | new |`. */
function migrationTable() {
  const changelog = read("CHANGELOG.md");
  const section = changelog.slice(changelog.indexOf("### 20 tools instead of 40"));
  const rows = section.slice(0, section.indexOf("\n- **")).split("\n").filter((row) => row.startsWith("| `"));
  assert.ok(rows.length >= 20, `the migration table reads as ${rows.length} rows`);
  return rows;
}

test("the retired list is the CHANGELOG's own migration table, so a row added there is guarded without a second edit", () => {
  const old = new Set();
  for (const row of migrationTable()) {
    for (const [, name] of row.slice(0, row.indexOf("|", 1)).matchAll(/`([a-z_]+)`/g)) old.add(name);
  }
  assert.ok(old.size > TOOL_NAMES.length, "the table lists the 0.23 surface, not only what stayed");
  const retired = [...old].filter((name) => !TOOL_NAMES.includes(name));
  assert.deepEqual(retired.sort(), [...RETIRED_TOOLS].sort());
});

test("no shipped document teaches a retired tool name, in backticks or in bare words", () => {
  assert.ok(SHIPPED.length >= 15, `only ${SHIPPED.length} files scanned`);
  for (const file of SHIPPED) {
    const text = read(file);
    for (const name of RETIRED_TOOLS) {
      if (allowed(file, name)) continue;
      assert.doesNotMatch(text, new RegExp(`(?<![-\\w])${name}(?![-\\w])`), `${file} names the retired ${name}`);
    }
  }
});

test("every migration row sends the reader at a tool that still exists, or says the capability went", () => {
  for (const row of migrationTable()) {
    const answer = row.slice(row.indexOf("|", 1));
    const named = [...answer.matchAll(/`([a-z_]+)`/g)].map(([, name]) => name).filter((name) => TOOL_NAMES.includes(name));
    const gone = /the same name|removed|automatic/.test(answer);
    assert.ok(named.length > 0 || gone, `the row for ${row.slice(0, 40)}… points at no tool of the 20`);
  }
});

test("no shipped document names an argument 1.0 dropped", () => {
  for (const file of SHIPPED) {
    const text = read(file);
    for (const arg of RETIRED_ARGS) {
      assert.doesNotMatch(text, new RegExp(`\`${arg}[\`:(]`), `${file} names the retired argument ${arg}`);
    }
  }
});
