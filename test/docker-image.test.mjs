/**
 * The runtime image as its Dockerfile builds it. Building it is
 * `npm run check:linux`'s business, and slow; these read the file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dockerfile = readFileSync(fileURLToPath(new URL("../Dockerfile", import.meta.url)), "utf8");
/** The instructions of the last stage, the image that ships, one per line, comments dropped. */
const runtime = dockerfile
  .split(/^FROM /m)
  .at(-1)
  .split("\n")
  .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));

/**
 * Every COPY of the app comes after the packages, so a release, which changes
 * only the app, reuses the cached package layer: `docker compose pull` fetches
 * the app's layers again, not ffmpeg's and poppler's libraries.
 */
test("the image installs its system packages before it copies the app", () => {
  const apk = runtime.findIndex((line) => /^RUN apk add\b/.test(line));
  const copy = runtime.findIndex((line) => /^COPY\b/.test(line));
  assert.ok(apk !== -1, "the image installs packages with apk");
  assert.ok(copy !== -1, "the image copies the app");
  assert.ok(apk < copy, `apk add (instruction ${apk}) comes before the first COPY (instruction ${copy})`);
  assert.ok(!runtime.slice(copy).some((line) => /\bapk\b/.test(line)), "no package is installed after the app is copied");
});

/**
 * A PDF may name one of the standard fonts (Helvetica, Times, Courier) without
 * embedding it, as FPDF and ReportLab invoices do. With no font installed,
 * poppler draws that text as nothing and still exits 0: the page picture beside
 * the text layer is blank. Liberation has those fonts' metrics.
 */
test("the image installs fonts for the PDF text poppler draws", () => {
  const apk = runtime.find((line) => /^RUN apk add\b/.test(line)) ?? "";
  assert.match(apk, /\bpoppler-utils\b/);
  assert.match(apk, /\bfont-liberation\b/, apk);
});
