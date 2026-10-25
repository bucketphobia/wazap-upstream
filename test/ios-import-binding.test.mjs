import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openTemp, ME, PEER } from "./db-fixtures.mjs";
import { authorizeIosArchive, initializeIosBinding, sealIosBindingBeforeOwnerChange } from "../dist/ios-import/binding.js";
const hash = createHash("sha256").update("archive A").digest("hex");
const changedArchive = (e) => e.code === "INVALID_ID" && e.message === "The iPhone archive changed since this import began.";
const invalid = (e) => e.code === "INVALID_ID" && !e.message.includes(ME) && !e.message.includes("archive A");
function fixture(t) {
  const f = openTemp();
  f.db.bindOwner(ME);
  t.after(() => { if (f.db.isOpen) f.db.close(); });
  const root = dirname(f.path);
  const marker = join(root, "ios-import-binding.json");
  const source = join(root, "archive.sqlite");
  writeFileSync(source, "archive A");
  return { ...f, root, marker, source };
}
const read = (f) => JSON.parse(readFileSync(f.marker, "utf8"));
test("fresh accounts await their source; existing unknown archives pause", async (t) => {
  const f = fixture(t);
  initializeIosBinding(f.db);
  assert.equal(read(f).state, "awaiting-source");
  assert.equal((await authorizeIosArchive(f)).hash, hash);
  assert.equal(read(f).owner, ME);
  assert.equal(statSync(f.marker).mode & 0o777, 0o600);
  const g = fixture(t);
  mkdirSync(join(g.root, "import"));
  writeFileSync(join(g.root, "import", "ChatStorage.sqlite"), "old");
  initializeIosBinding(g.db);
  assert.equal(existsSync(g.marker), false);
  await assert.rejects(authorizeIosArchive(g), invalid);
});
test("binding survives A to B to A ownership changes", async (t) => {
  const f = fixture(t);
  await authorizeIosArchive({ ...f, explicit: true });
  const original = readFileSync(f.marker, "utf8");
  sealIosBindingBeforeOwnerChange(f.db);
  f.db.setMeta("owner", PEER);
  await assert.rejects(authorizeIosArchive(f), invalid);
  sealIosBindingBeforeOwnerChange(f.db);
  assert.equal(readFileSync(f.marker, "utf8"), original);
  f.db.setMeta("owner", ME);
  assert.equal((await authorizeIosArchive(f)).hash, hash);
});
test("missing bindings migrate matching progress only after checking source bytes", async (t) => {
  const f = fixture(t);
  await assert.rejects(authorizeIosArchive({ ...f, savedHash: "a".repeat(64) }), changedArchive);
  assert.equal(existsSync(f.marker), false);
  await authorizeIosArchive({ ...f, savedHash: hash });
  assert.equal(read(f).sha256, hash);
});
test("rotation seals progress or requires selection and preserves malformed markers", (t) => {
  const f = fixture(t);
  f.db.setMeta("ios_import_v1", JSON.stringify({ hash }));
  sealIosBindingBeforeOwnerChange(f.db);
  assert.equal(read(f).sha256, hash);
  const g = fixture(t);
  sealIosBindingBeforeOwnerChange(g.db);
  assert.equal(read(g).state, "selection-required");
  writeFileSync(g.marker, "{private malformed");
  sealIosBindingBeforeOwnerChange(g.db);
  assert.equal(readFileSync(g.marker, "utf8"), "{private malformed");
});
test("explicit reselection repairs malformed and foreign markers; reset alone cannot", async (t) => {
  const f = fixture(t);
  writeFileSync(f.marker, "{private malformed");
  await assert.rejects(authorizeIosArchive({ ...f, explicit: true }), invalid);
  await assert.rejects(authorizeIosArchive({ ...f, reselect: true }), invalid);
  await authorizeIosArchive({ ...f, explicit: true, reselect: true });
  f.db.setMeta("owner", PEER);
  await authorizeIosArchive({ ...f, explicit: true, reselect: true });
  assert.equal(read(f).owner, PEER);
});
test("changed bytes cannot inherit an existing binding", async (t) => {
  const f = fixture(t);
  await authorizeIosArchive({ ...f, explicit: true });
  writeFileSync(f.source, "archive B");
  await assert.rejects(authorizeIosArchive({ ...f, explicit: true }), changedArchive);
});
test("dry inventory never mutates missing or malformed bindings", async (t) => {
  const f = fixture(t);
  await authorizeIosArchive({ ...f, dryRun: true });
  assert.equal(existsSync(f.marker), false);
  writeFileSync(f.marker, "broken");
  await authorizeIosArchive({ ...f, dryRun: true, explicit: true, reselect: true });
  assert.equal(readFileSync(f.marker, "utf8"), "broken");
});
test("guards reject changed owner, source mutation, and closed database", async (t) => {
  const f = fixture(t);
  const auth = await authorizeIosArchive({ ...f, explicit: true });
  auth.assertCurrent();
  f.db.setMeta("owner", PEER);
  assert.throws(auth.assertCurrent, invalid);
  f.db.setMeta("owner", ME);
  writeFileSync(f.source, "changed");
  assert.throws(auth.assertCurrent, invalid);
  const g = fixture(t);
  const dry = await authorizeIosArchive({ ...g, dryRun: true });
  g.db.close();
  assert.throws(dry.assertCurrent, invalid);
  await assert.rejects(authorizeIosArchive({ ...g, dryRun: true }), invalid);
});
test("marker directories and non-file sources fail safely", async (t) => {
  const f = fixture(t);
  mkdirSync(f.marker);
  await assert.rejects(authorizeIosArchive({ ...f, explicit: true }), invalid);
  assert.throws(() => sealIosBindingBeforeOwnerChange(f.db));
  const g = fixture(t);
  unlinkSync(g.source);
  mkdirSync(g.source);
  await assert.rejects(authorizeIosArchive({ ...g, dryRun: true }), invalid);
});

test("source and account changes during hashing cannot record a selection", async (t) => {
  for (const change of ["source", "owner", "close"]) {
    const f = fixture(t);
    const pending = authorizeIosArchive({ ...f, explicit: true });
    if (change === "source") writeFileSync(f.source, "changed while hashing");
    if (change === "owner") f.db.setMeta("owner", PEER);
    if (change === "close") f.db.close();
    await assert.rejects(pending, invalid);
    assert.equal(existsSync(f.marker), false);
  }
});
test("a selection made during hashing cannot be silently overwritten", async (t) => {
  const f = fixture(t);
  const pending = authorizeIosArchive({ ...f, explicit: true });
  writeFileSync(f.marker, JSON.stringify({ version: 1, state: "selection-required" }));
  await assert.rejects(pending, invalid);
  assert.equal(read(f).state, "selection-required");
});
test("same-size rewrites are checked from actual bytes on every invocation", async (t) => {
  const f = fixture(t);
  await authorizeIosArchive({ ...f, explicit: true });
  assert.equal((await authorizeIosArchive(f)).hash, hash);
  writeFileSync(f.source, "archive B");
  await assert.rejects(authorizeIosArchive(f), invalid);
  writeFileSync(f.source, "archive C");
  await assert.rejects(authorizeIosArchive(f), invalid);
  assert.equal(read(f).sha256, hash);
});

test("an awaiting selection cannot replace existing progress with a different archive", async (t) => {
  const f = fixture(t);
  f.db.setMeta("ios_import_v1", JSON.stringify({ hash }));
  initializeIosBinding(f.db);
  const before = readFileSync(f.marker, "utf8");
  writeFileSync(f.source, "archive B");
  await assert.rejects(authorizeIosArchive({ ...f, savedHash: hash }), changedArchive);
  assert.equal(readFileSync(f.marker, "utf8"), before, "a rejected source must not poison the saved selection");
  writeFileSync(f.source, "archive A");
  assert.equal((await authorizeIosArchive({ ...f, savedHash: hash })).hash, hash);
  assert.equal(read(f).sha256, hash);
});

test("an incomplete source cannot publish an archive selection", async (t) => {
  const f = fixture(t);
  writeFileSync(`${f.source}-wal`, "uncheckpointed data");
  await assert.rejects(authorizeIosArchive({ ...f, explicit: true }), (error) => error.reason === "source_incomplete");
  assert.equal(existsSync(f.marker), false);
  assert.equal(readFileSync(`${f.source}-wal`, "utf8"), "uncheckpointed data");
});

test("source companions appearing while hashing cannot publish a binding", async (t) => {
  const f = fixture(t);
  const pending = authorizeIosArchive({ ...f, explicit: true });
  writeFileSync(`${f.source}-journal`, "journal state");
  await assert.rejects(pending, (error) => error.reason === "source_incomplete");
  assert.equal(existsSync(f.marker), false);
});

test("authorization guards reject new journal state before later writes or uploads", async (t) => {
  const f = fixture(t);
  const selected = await authorizeIosArchive({ ...f, explicit: true });
  const before = readFileSync(f.marker);
  writeFileSync(`${f.source}-journal`, "journal state");
  assert.throws(() => selected.assertCurrent(), (error) => error.reason === "source_incomplete");
  assert.deepEqual(readFileSync(f.marker), before);
});

for (const when of ["before", "during"]) {
  test(`cancelled source hashing ${when} streaming cannot publish or replace selection`, async (t) => {
    const f = fixture(t);
    initializeIosBinding(f.db);
    const before = readFileSync(f.marker);
    const controller = new AbortController();
    if (when === "before") controller.abort();
    const pending = authorizeIosArchive({ ...f, explicit: true, signal: controller.signal });
    if (when === "during") controller.abort();
    await assert.rejects(pending, (error) => error.code === "SERVICE_ERROR" && /stopped/.test(error.message));
    assert.deepEqual(readFileSync(f.marker), before);
  });
}
test("graceful stop interrupts hashing between stream chunks without publishing selection", async (t) => {
  const f = fixture(t);
  writeFileSync(f.source, Buffer.alloc(256 * 1024));
  let checks = 0;
  await assert.rejects(
    authorizeIosArchive({ ...f, explicit: true, stopping: () => ++checks >= 2 }),
    (error) => error.code === "SERVICE_ERROR" && /stopped/.test(error.message)
  );
  assert.ok(checks >= 2);
  assert.equal(existsSync(f.marker), false);
});
