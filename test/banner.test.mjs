import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BANNER_ART, LOGO_ART, LOGO_COLUMNS, TAGLINE, banner } from "../dist/banner.js";

test("a window wide enough gets the bubble beside the wordmark", () => {
  const lines = banner(LOGO_COLUMNS).split("\n");
  assert.equal(lines.join("\n"), LOGO_ART);
  assert.ok(lines[0].startsWith("╭"));
  assert.ok(lines.at(-1).endsWith(TAGLINE));
  for (const line of lines) assert.ok(line.length <= LOGO_COLUMNS, line);
});

test("a narrower window, or no window at all, gets the wordmark alone", () => {
  for (const columns of [LOGO_COLUMNS - 1, undefined]) {
    assert.equal(banner(columns), `${BANNER_ART}\n${TAGLINE}`);
  }
});

test("every wordmark row starts in the same column", () => {
  const words = BANNER_ART.split("\n");
  const rows = LOGO_ART.split("\n").slice(1, 1 + words.length);
  rows.forEach((line, i) => assert.ok(line.endsWith(words[i]), line));
  assert.equal(new Set(rows.map((line, i) => line.length - words[i].length)).size, 1);
});

test("the README shows the same logo the CLI prints", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(`\`\`\`\n${LOGO_ART}\n\`\`\``));
});
