/**
 * The README is short because the reference lives in docs/. That only works
 * while the links between them hold, and a link is exactly what a move breaks
 * quietly: the file still renders, the reader lands nowhere.
 *
 * So: every relative link and every `#anchor` in README.md and docs/*.md is
 * resolved here, against the files on disk and against the headings they
 * actually carry, with GitHub's own slugs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFileSync(join(root, file), "utf8");

/**
 * A link is written the way the web writes one, so it is resolved with posix
 * segments and only joined to the checkout for the read: the same answer on a
 * machine whose separator is a backslash.
 */
const resolveFrom = (page, target) => posix.normalize(posix.join(posix.dirname(page), target));

/** Markdown the repo publishes and cross-links. */
const PAGES = ["README.md", ...readdirSync(join(root, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`)];

/**
 * GitHub's heading slug: lowercased, everything but word characters, spaces and
 * hyphens dropped, spaces to hyphens, and a repeat of an earlier slug numbered.
 */
function slugs(markdown) {
  const seen = new Map();
  const out = new Set();
  for (const [, text] of withoutCode(markdown).matchAll(/^#{1,6} +(.+?)\s*$/gm)) {
    const base = text
      .replace(/`/g, "")
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Fenced blocks hold shell and JSON, not links, and a `#` there is a comment. */
const withoutCode = (markdown) => markdown.replace(/^```[\s\S]*?^```/gm, "");

/** Every `[text](target)` outside a fenced block, with the line it sits on. */
function links(markdown) {
  const found = [];
  const body = withoutCode(markdown);
  for (const match of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    found.push({ target: match[1], line: body.slice(0, match.index).split("\n").length });
  }
  return found;
}

const cache = new Map();
const slugsOf = (file) => {
  if (!cache.has(file)) cache.set(file, slugs(read(file)));
  return cache.get(file);
};

test("every relative link in the README and in docs/ lands on a file that exists", () => {
  assert.ok(PAGES.length >= 10, `only ${PAGES.length} pages scanned`);
  for (const page of PAGES) {
    for (const { target, line } of links(read(page))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
      const [path] = target.split("#");
      const resolved = resolveFrom(page, path);
      assert.ok(existsSync(join(root, resolved)), `${page}:${line} links to ${target}, which is not in the repo`);
    }
  }
});

test("every #anchor in the README and in docs/ names a heading that exists", () => {
  for (const page of PAGES) {
    for (const { target, line } of links(read(page))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const hash = target.indexOf("#");
      if (hash < 0) continue;
      const anchor = target.slice(hash + 1);
      const path = hash === 0 ? page : resolveFrom(page, target.slice(0, hash));
      if (!existsSync(join(root, path)) || !path.endsWith(".md")) continue;
      assert.ok(slugsOf(path).has(anchor), `${page}:${line} points at #${anchor}, which ${path} has no heading for`);
    }
  }
});

test("the README names every page in docs/, so the reference cannot be written into a file nobody reaches", () => {
  const readme = read("README.md");
  for (const page of PAGES) {
    if (page === "README.md") continue;
    assert.ok(readme.includes(`](${page})`), `README links to no ${page}`);
  }
});

/**
 * CLAUDE.md: ".env.example and the README's Settings table list every WAZAP_* a
 * user sets, and nothing else." The table is in docs/settings.md since the
 * README got short; the rule is the same one.
 */
test("the settings table and .env.example name the same WAZAP_* settings", () => {
  const documented = new Set([...read("docs/settings.md").matchAll(/^\| `(WAZAP_[A-Z0-9_]+)`(?: \/ `(WAZAP_[A-Z0-9_]+)`)? \|/gm)].flatMap((m) => m.slice(1)).filter(Boolean));
  const shipped = new Set([...read(".env.example").matchAll(/^# ?(WAZAP_[A-Z0-9_]+)=/gm)].map((m) => m[1]));
  assert.ok(shipped.size >= 15, `.env.example reads as ${shipped.size} settings`);
  assert.deepEqual([...documented].sort(), [...shipped].sort());
});
