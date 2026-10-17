import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills } from "../dist/skills.js";

test("skill frontmatter loads equally with LF, CRLF and mixed line endings", () => {
  const text = "---\nname: example\ndescription: Use when testing skill loading.\n---\n\n# Example\n\nBody text.\n";
  for (const content of [text, text.replaceAll("\n", "\r\n"), text.replace("---\n", "---\r\n")]) {
    const root = mkdtempSync(join(tmpdir(), "wazap-line-endings-"));
    const directory = join(root, "example");
    mkdirSync(directory);
    writeFileSync(join(directory, "SKILL.md"), content);
    assert.deepEqual(loadSkills(root), [
      { name: "example", description: "Use when testing skill loading.", body: "# Example\n\nBody text." },
    ]);
  }
});
