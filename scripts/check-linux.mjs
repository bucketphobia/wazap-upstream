/**
 * Run the tests a change touches on Linux, on the Node versions CI runs, in a
 * container: the platform a contributor's laptop is not.
 *
 * A test that passed on macOS failed in CI because ext4 refuses the sparse file
 * of a petabyte the test made (EFBIG), and main stood red until it was fixed.
 * CI is not a safety net for everyone who works on this (the free plan's minutes
 * run out), and the whole suite in a container is slow, so this runs only what
 * the change reaches: the tests it edits, the tests that import a module it
 * edits, and the documents' guards when it edits a document.
 *
 *   npm run check:linux                 # what changed since main, on both Node versions
 *   npm run check:linux -- wizard ui    # these test files (names or paths)
 *   npm run check:linux -- --all        # the whole suite, serially: slow
 *   npm run check:linux -- --node 24    # one Node version: 22.16.0, 24 or both
 *   npm run check:linux -- --dry-run    # say what would run and stop
 *
 * The tree goes into the container as the working tree is, uncommitted edits
 * included, without node_modules or dist; the container installs and builds its
 * own. Tests run one file at a time and one test at a time (`--test-concurrency=1`),
 * because a container with a few CPUs shared by parallel files fails timing tests
 * that nothing in the change touched.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The images match CI's matrix: the oldest Node package.json accepts, and the newest LTS. */
export const IMAGES = { "22.16.0": "node:22.16.0-bookworm", 24: "node:24-bookworm" };

/** What reads a document, a skill or a manifest: the tests that fail when one of them drifts. */
export const DOCUMENT_GUARDS = ["docs-links", "tool-names", "distribution", "stability-doc", "skills"];

const DOCUMENT_PATHS = [/^docs\//, /^skills\//, /^README\.md$/, /^CLAUDE\.md$/, /^CHANGELOG\.md$/, /^package\.json$/, /^manifest\.json$/, /^server\.json$/, /^\.claude-plugin\//, /^\.env\.example$/];

/**
 * The test files a set of changed paths reaches. `readTest` gives a test's text,
 * so "imports the changed module" is read, not guessed from names.
 */
export function testsFor(changed, tests, readTest) {
  const picked = new Set();
  const named = (name) => `test/${name}.test.mjs`;
  for (const path of changed) {
    if (/^test\/[^/]+\.test\.mjs$/.test(path) && tests.includes(path)) picked.add(path);
    const source = /^src\/(.+)\.ts$/.exec(path);
    if (source !== null) {
      const dist = `dist/${source[1]}.js`;
      for (const test of tests) if (readTest(test).includes(`../${dist}`)) picked.add(test);
    }
    if (DOCUMENT_PATHS.some((pattern) => pattern.test(path))) {
      for (const guard of DOCUMENT_GUARDS) if (tests.includes(named(guard))) picked.add(named(guard));
    }
  }
  return [...picked].sort();
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}

/** Everything that differs from main: commits since the merge-base, edits, staged and new files. */
function changedPaths() {
  const base = ["origin/main", "main"].map((ref) => git(["merge-base", "HEAD", ref])?.trim()).find(Boolean) ?? "HEAD";
  const lists = [
    git(["diff", "--name-only", base]),
    git(["ls-files", "--others", "--exclude-standard"]),
  ];
  return [...new Set(lists.flatMap((list) => (list ?? "").split("\n").filter(Boolean)))];
}

function allTests() {
  return readdirSync(join(root, "test"))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `test/${name}`)
    .sort();
}

/** "wizard", "wizard.test.mjs" and "test/wizard.test.mjs" all name one file. */
function resolveNamed(names, tests) {
  return names.map((name) => {
    const path = name.startsWith("test/") ? name : `test/${name.replace(/\.test\.mjs$/, "")}.test.mjs`;
    if (!tests.includes(path)) throw new Error(`no test file ${path}`);
    return path;
  });
}

export function parseArgs(argv) {
  const options = { all: false, dryRun: false, node: "both", names: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") options.all = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--node") options.node = argv[++i] ?? "";
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else options.names.push(arg);
  }
  if (!["both", ...Object.keys(IMAGES)].includes(String(options.node))) {
    throw new Error(`--node takes 22.16.0, 24 or both, not "${options.node}"`);
  }
  return options;
}

/** What one container does: install, build, then each file on its own, telling the host the outcome per file. */
function containerScript(files) {
  const list = files.map((file) => `'${file}'`).join(" ");
  return `
set -e
mkdir /work && tar --warning=no-unknown-keyword -xf - -C /work && cd /work
echo "##NODE $(node -v)"
npm ci --silent > /tmp/ci.log 2>&1 || { echo "##SETUP npm ci failed"; tail -15 /tmp/ci.log; exit 3; }
npm run build --silent > /tmp/build.log 2>&1 || { echo "##SETUP the build failed"; tail -15 /tmp/build.log; exit 3; }
set +e
for f in ${list}; do
  node --test --test-reporter=tap --test-concurrency=1 --import ./test/no-color.mjs "$f" > /tmp/t.log 2>&1
  code=$?
  echo "##FILE $f $code $(grep -E '^# pass ' /tmp/t.log | grep -oE '[0-9]+' | head -1) $(grep -E '^# fail ' /tmp/t.log | grep -oE '[0-9]+' | head -1)"
  if [ $code -ne 0 ]; then grep -E '^\\s*not ok|^\\s+error:|^\\s+(actual|expected):' /tmp/t.log | grep -v '# TODO' | head -24 | sed 's/^/##DETAIL /'; fi
done
`;
}

function run(image, files) {
  const listed = git(["ls-files", "-co", "--exclude-standard"]) ?? "";
  const present = listed.split("\n").filter((path) => path !== "" && existsSync(join(root, path)));
  const tar = spawn("tar", ["--no-xattrs", "-cf", "-", "-T", "-"], { cwd: root, stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
  tar.stdin.end(present.join("\n"));
  const docker = spawn("docker", ["run", "--rm", "-i", image, "bash", "-c", containerScript(files)], { stdio: [tar.stdout, "pipe", "pipe"] });
  const failed = [];
  let setupFailed = false;
  let buffer = "";
  const onLine = (line) => {
    if (line.startsWith("##NODE ")) console.log(`\n== ${image} (${line.slice(7)})`);
    else if (line.startsWith("##SETUP ")) {
      setupFailed = true;
      console.log(`   ✗ ${line.slice(8)}`);
    } else if (line.startsWith("##FILE ")) {
      const [, file, code, pass, fail] = line.split(" ");
      const ok = code === "0";
      if (!ok) failed.push(file);
      console.log(`   ${ok ? "✓" : "✗"} ${file} — ${pass || 0} passed, ${fail || 0} failed${ok ? "" : ` (exit ${code})`}`);
    } else if (line.startsWith("##DETAIL ")) console.log(`       ${line.slice(9)}`);
    else if (setupFailed && line.trim() !== "") console.log(`       ${line}`);
  };
  docker.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach(onLine);
  });
  docker.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return new Promise((resolve) => docker.on("close", (code) => resolve({ failed, ok: code === 0 && !setupFailed && failed.length === 0 })));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tests = allTests();
  const files = options.all
    ? tests
    : options.names.length > 0
      ? resolveNamed(options.names, tests)
      : testsFor(changedPaths(), tests, (test) => readFileSync(join(root, test), "utf8"));
  const versions = options.node === "both" ? Object.keys(IMAGES) : [String(options.node)];

  if (files.length === 0) {
    console.log("Nothing changed reaches a test. Name one (`npm run check:linux -- wizard`) or pass --all.");
    return;
  }
  console.log(`${files.length} test file${files.length === 1 ? "" : "s"} on Node ${versions.join(" and ")}, Linux:`);
  for (const file of files) console.log(`  ${file}`);
  if (options.dryRun) return;

  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    console.error("Docker is not running: start Docker Desktop or OrbStack, then run this again.");
    process.exitCode = 2;
    return;
  }
  const started = Date.now();
  let allOk = true;
  for (const version of versions) {
    const result = await run(IMAGES[version], files);
    if (!result.ok) allOk = false;
  }
  console.log(`\n${allOk ? "✓ all passed" : "✗ something failed"} on Linux in ${Math.round((Date.now() - started) / 1000)} s`);
  if (!allOk) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
}
