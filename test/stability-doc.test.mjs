/**
 * `docs/stability.md` is the 1.0 contract, and a contract that drifts from the
 * code is worse than none. This reads the document as claims and checks each
 * against what the build actually is: the tool registry, the schema version,
 * the constants, `.env.example`, `package.json` and the CI matrix. Nothing here
 * asserts the document against itself.
 *
 * It also reads `test/integration-contract.test.mjs` for the three lists that
 * file pins on an integration's behalf — the six tools, the eight connection
 * statuses and the definitely-unsent codes — so the document cannot name a
 * different set than the test that holds the integration contract.
 *
 * Only files and `dist` are read: no clock, no disk size, no platform.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DRAFT_TTL_MS } from "../dist/drafts.js";
import { ERROR_GUIDE } from "../dist/errors.js";
import { SCHEMA_VERSION } from "../dist/db/index.js";
import { PRE_MIGRATION_TTL_MS, preMigrationName } from "../dist/db/pre-migration.js";
import { TOOL_NAMES, registerTools } from "../dist/tools.js";
import { WEBHOOK_EVENTS, WEBHOOK_TEXT_MAX } from "../dist/webhook.js";
import { asToolSource, READ_TOOL_COUNT, TOOL_COUNT } from "./helpers.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFileSync(join(root, file), "utf8");

const DOC = "docs/stability.md";
const doc = read(DOC);
const contractTest = read("test/integration-contract.test.mjs");

/** Number words the document writes out, so a prose count is still a number to check. */
const WORDS = { five: 5, six: 6, seven: 7, eight: 8, thirteen: 13, fourteen: 14, twenty: 20 };
const asNumber = (word) => (word.toLowerCase() in WORDS ? WORDS[word.toLowerCase()] : Number(word));

/** Every `…` span of the document that is one bare identifier. */
function identifiers(text) {
  return [...text.matchAll(/`([^`\n]+)`/g)]
    .map(([, span]) => span)
    .filter((span) => /^[A-Za-z][A-Za-z0-9_]*$/.test(span));
}

/** The document's `## n. Title` section, heading excluded. */
function section(number) {
  const start = doc.indexOf(`\n## ${number}. `);
  assert.notEqual(start, -1, `${DOC} has no section ${number}`);
  const body = doc.slice(doc.indexOf("\n", start + 1));
  const next = body.indexOf("\n## ");
  return next === -1 ? body : body.slice(0, next);
}

/** The paragraph of the document that starts with `opening`. */
function paragraph(opening) {
  const start = doc.indexOf(opening);
  assert.notEqual(start, -1, `${DOC} no longer says "${opening}"`);
  const end = doc.indexOf("\n\n", start);
  return doc.slice(start, end === -1 ? undefined : end);
}

/** A capture the document has to carry, so a rewritten sentence fails loudly instead of passing. */
function claim(pattern, what) {
  const match = doc.match(pattern);
  assert.ok(match, `${DOC} no longer states ${what}`);
  return match[1];
}

/** A `const NAME = [ "a", "b" ]` of the integration contract test, as its strings. */
function contractList(name) {
  const start = contractTest.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `test/integration-contract.test.mjs no longer declares ${name}`);
  const body = contractTest.slice(start, contractTest.indexOf("];", start));
  return [...body.matchAll(/"([^"]+)"/g)].map(([, value]) => value);
}

/** The keys of the integration contract test's `INTEGRATION_CALLS`: the tools an integration calls. */
function contractTools() {
  const start = contractTest.indexOf("const INTEGRATION_CALLS = {");
  assert.notEqual(start, -1, "test/integration-contract.test.mjs no longer declares INTEGRATION_CALLS");
  const body = contractTest.slice(start, contractTest.indexOf("\n};", start));
  return [...body.matchAll(/^ {2}([a-z_]+):/gm)].map(([, name]) => name);
}

/** The registered tools, as a client sees them. */
function registered() {
  const tools = new Map();
  registerTools({ registerTool: (name, meta) => tools.set(name, meta) }, asToolSource({}), { allowWrite: true });
  return tools;
}

const tools = registered();
/** Every argument name and every enum value the tools accept. */
const vocabulary = new Set(TOOL_NAMES);
for (const meta of tools.values()) {
  for (const [arg, shape] of Object.entries(meta.inputSchema ?? {})) {
    vocabulary.add(arg);
    const def = shape?._def?.innerType?._def ?? shape?._def;
    for (const value of def?.values ?? []) vocabulary.add(value);
  }
  const out = meta.outputSchema;
  for (const key of Object.keys(out?.shape ?? out ?? {})) vocabulary.add(key);
}
/** The webhook fields the webhook tests read off a delivered body. */
for (const file of ["test/webhook.test.mjs", "test/webhook-outbox.test.mjs", "test/webhook-filter.test.mjs", "test/integration-contract.test.mjs"]) {
  for (const [, field] of read(file).matchAll(/\b(?:body|webhook)\.([a-z][a-z0-9_]*)/g)) vocabulary.add(field);
}
/** The answer fields the integration contract test reads off the six tools, which declare no output schema. */
for (const [, field] of contractTest.matchAll(/\b(?:draft|confirmed|code|applied|status|book|entry)\.([a-z][a-z0-9_]*)/g)) vocabulary.add(field);
for (const event of WEBHOOK_EVENTS) vocabulary.add(event);

// ------------------------------------------------------------- 1. the tools

test("the tool list the document prints is the registry, argument for argument", () => {
  const listing = paragraph("The 21, each with what it requires:");
  const rows = [...listing.matchAll(/`([a-z_]+)`\s*\(([^)]*)\)/g)].map(([, name, args]) => [name, identifiers(args)]);
  assert.deepEqual(
    rows.map(([name]) => name).sort(),
    [...TOOL_NAMES].sort(),
    "the document lists different tools than the registry holds"
  );
  for (const [name, args] of rows) {
    const shape = tools.get(name)?.inputSchema;
    assert.ok(shape, `${DOC} lists ${name}, which is not registered`);
    const required = Object.keys(shape).filter((arg) => shape[arg].isOptional() === false);
    assert.deepEqual(args, required, `${DOC} states the wrong required arguments for ${name}`);
  }
});

test("every identifier the document quotes is one the build actually has", () => {
  const known = new Set([...vocabulary, ...Object.keys(ERROR_GUIDE)]);
  // Type-only, so it is not in dist: read the union the storage errors declare.
  for (const [, code] of read("src/db/errors.ts").matchAll(/"([A-Z][A-Z_]+)"/g)) known.add(code);
  for (const [, name] of read("src/config.ts").matchAll(/^export const ([A-Z][A-Z_]+)/gm)) known.add(name);
  for (const [, name] of read("src/config.ts").matchAll(/(WAZAP_[A-Z0-9_]+)/g)) known.add(name);
  for (const [, name] of read(".env.example").matchAll(/(WAZAP_[A-Z0-9_]+)/g)) known.add(name);
  for (const span of identifiers(doc)) {
    if (!span.includes("_")) continue;
    assert.ok(known.has(span), `${DOC} quotes \`${span}\`, which no tool, error code or setting defines`);
  }
});

test("the counts the document states are the registry's own", () => {
  assert.equal(Number(claim(/registers exactly (\d+) tools/, "how many tools there are")), TOOL_NAMES.length);
  assert.equal(TOOL_COUNT, TOOL_NAMES.length, "helpers and the registry disagree before the document is even read");
  assert.equal(
    Number(claim(/without writes sees (\d+) of them/, "how many tools a read session sees")),
    READ_TOOL_COUNT
  );
  const withSchema = [...tools.values()].filter((meta) => meta.outputSchema !== undefined).length;
  assert.equal(
    asNumber(claim(/\n(\w+) declare an output schema/, "how many tools declare an output schema")),
    withSchema
  );
  assert.equal(
    Number(claim(/one of the (\d+) codes/, "how many error codes there are")),
    Object.keys(ERROR_GUIDE).length
  );
  assert.equal(
    asNumber(claim(/The (\w+) skills under/, "how many skills ship")),
    readdirSync(join(root, "skills")).length
  );
});

test("the integration six are the six the contract test pins, with mark_read still an action", () => {
  const six = contractTools();
  assert.equal(six.length, 6, `the contract test now pins ${six.length} tools`);
  const actions = tools.get("manage_chat").inputSchema.action._def.values;
  const cited = identifiers(paragraph("Six tools are an exact contract for an integration:"));
  assert.deepEqual(
    cited.filter((name) => !actions.includes(name)).sort(),
    [...six].sort(),
    "the document names different tools than the contract test pins on an integration's behalf"
  );
  for (const name of six) assert.ok(TOOL_NAMES.includes(name), `${name} is no longer a tool`);
  assert.ok(
    cited.includes("mark_read") && actions.includes("mark_read"),
    "the document and manage_chat must agree on mark_read"
  );
});

test("the statuses and the definitely-unsent codes are the contract test's lists", () => {
  assert.equal(
    asNumber(claim(/from the (\w+)\s+statuses\s+an\s+integration\s+maps/, "how many statuses an integration maps")),
    contractList("CONNECTION_STATUSES").length
  );
  const unsent = contractList("DEFINITELY_UNSENT");
  const cited = identifiers(paragraph('- The codes an integration sorts as "definitely not sent"'));
  assert.deepEqual([...cited].sort(), [...unsent].sort());
  for (const code of unsent) assert.ok(code in ERROR_GUIDE, `${code} is no longer an error code`);
});

// ------------------------------------------------------- 2. what it promises

test("the lifetimes and limits the document quotes are the constants", () => {
  assert.equal(Number(claim(/lapses after (\d+) minutes/, "the draft lifetime")) * 60_000, DRAFT_TTL_MS);
  assert.equal(Number(claim(/cut at (\d+) characters/, "the webhook text cut")), WEBHOOK_TEXT_MAX);
  const days = asNumber(claim(/kept (\w+) days from its own mtime/, "how long a pre-migration copy is kept"));
  assert.equal(days * 24 * 60 * 60 * 1000, PRE_MIGRATION_TTL_MS);
  for (const event of WEBHOOK_EVENTS) assert.ok(section(4).includes(`\`${event}\``), `${DOC} omits the ${event} event`);
});

test("the schema version the document states is the one the build migrates to", () => {
  assert.equal(
    Number(claim(/`PRAGMA user_version`[^\n]*\n?\s*\S*\s*is (\d+) in this release/, "the schema version")),
    SCHEMA_VERSION
  );
  const named = preMigrationName(SCHEMA_VERSION - 1);
  const quoted = claim(/`(wazap\.[^`]*pre-migration\.sqlite)`/, "the pre-migration copy's name");
  assert.equal(quoted.replace("<old version>", String(SCHEMA_VERSION - 1)), named);
});

test("every test the document names as a guard is a suite file that exists", () => {
  const suite = new Set(readdirSync(join(root, "test")).filter((name) => name.endsWith(".test.mjs")));
  const cited = [...doc.matchAll(/`(test\/[A-Za-z0-9._-]+)`/g)].map(([, file]) => file);
  assert.ok(cited.length >= 30, `${DOC} cites only ${cited.length} tests; a contract with no guards named is not one`);
  for (const file of new Set(cited)) {
    assert.ok(file.endsWith(".test.mjs"), `${file} is not a suite file`);
    assert.ok(suite.has(file.slice("test/".length)), `${DOC} names ${file}, which does not exist`);
    assert.ok(existsSync(join(root, file)));
  }
  for (const workflow of [...doc.matchAll(/`(\.github\/workflows\/[a-z-]+\.yml)`/g)].map(([, file]) => file)) {
    assert.ok(existsSync(join(root, workflow)), `${DOC} names ${workflow}, which does not exist`);
  }
});

// ----------------------------------------------------- 3. settings and Node

/** Every file under src/, as one string: a setting is read where its feature lives, not only in config.ts. */
function sourceText() {
  const walk = (dir) =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(`${dir}/${entry.name}`) : entry.name.endsWith(".ts") ? [read(`${dir}/${entry.name}`)] : []
    );
  return walk("src").join("\n");
}

test("the settings the document calls stable are exactly the ones a user is given", () => {
  const shipped = [...new Set([...read(".env.example").matchAll(/(WAZAP_[A-Z0-9_]+)/g)].map(([, name]) => name))];
  const listed = [...new Set(identifiers(paragraph("Stable: the ")).filter((span) => span.startsWith("WAZAP_")))];
  assert.deepEqual(listed.sort(), [...shipped].sort(), "the document's stable settings are not .env.example's");
  const settingsPage = read("docs/settings.md");
  const source = sourceText();
  for (const name of listed) {
    assert.ok(source.includes(name), `${name} is documented as stable but nothing under src/ reads it`);
    assert.ok(settingsPage.includes(name), `${name} is documented as stable but docs/settings.md does not list it`);
  }
  for (const count of [...doc.matchAll(/the (\d+) `WAZAP_\*`/g)].map(([, n]) => Number(n))) {
    assert.equal(count, shipped.length, "the document counts a different number of settings than it lists");
  }
});

test("the Node floor and the platforms are package.json's and CI's", () => {
  const engines = JSON.parse(read("package.json")).engines.node;
  const floor = claim(/Node (\d+\.\d+\.\d+) or newer/, "the Node floor");
  assert.equal(engines, `^${floor} || >=24.0.0`, "engines is the 22 line from the floor, then 24 and newer");
  assert.ok(section(7).includes("the 23 line lacks"), "the document says why 23 is out");
  const ci = read(".github/workflows/ci.yml");
  const matrix = [...ci.matchAll(/node: \[([^\]]+)\]/g)].flatMap(([, list]) =>
    list.split(",").map((entry) => entry.trim().replace(/"/g, ""))
  );
  const named = [...new Set([...section(7).matchAll(/Node (\d+(?:\.\d+\.\d+)?)/g)].map(([, version]) => version))];
  assert.deepEqual(named, matrix, "the document names different Node versions than CI runs");
  assert.match(ci, /runs-on: ubuntu-latest/, "the document says Linux");
  assert.ok(section(7).includes("no test or CI run exercises"), "the document says Windows is not exercised");
  assert.doesNotMatch(ci, /windows/i, "and CI has no Windows runner, or that sentence is stale");
});
