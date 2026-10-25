import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  chmodSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sqlite } from "../dist/db/sqlite.js";
const schema = `CREATE TABLE ZWACHATSESSION(Z_PK INTEGER PRIMARY KEY,ZCONTACTJID TEXT,ZGROUPINFO INTEGER,ZPARTNERNAME TEXT);
CREATE TABLE ZWAGROUPMEMBER(Z_PK INTEGER PRIMARY KEY,ZMEMBERJID TEXT);
CREATE TABLE ZWAMESSAGE(Z_PK INTEGER PRIMARY KEY,ZCHATSESSION INTEGER,ZGROUPMEMBER INTEGER,ZISFROMME INTEGER,ZSTANZAID TEXT,ZMESSAGEDATE REAL,ZMESSAGETYPE INTEGER,ZTEXT TEXT,ZPARENTMESSAGE INTEGER);
CREATE TABLE ZWAMEDIAITEM(Z_PK INTEGER PRIMARY KEY,ZMESSAGE INTEGER,ZTITLE TEXT,ZMEDIALOCALPATH TEXT);`;
function fixture(t, ddl = schema, name = "ChatStorage.sqlite") {
  const dir = mkdtempSync(join(tmpdir(), "ios-source-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, name);
  const db = new (sqlite().DatabaseSync)(path);
  db.exec(ddl);
  db.close();
  return { path, dir };
}
const api = () => import("../dist/ios-import/source.js");
function reason(expected) {
  return (error) => {
    assert.equal(error.reason, expected);
    assert.equal(error.code, "INVALID_ID");
    assert.doesNotMatch(error.message, /ios-source-|ChatStorage|private|SELECT|ZWAMESSAGE/);
    return true;
  };
}
function snapshot(dir) {
  return Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name))]));
}
test("immutable baseline misses committed WAL-only rows and source refuses without mutation", async (t) => {
  const { path, dir } = fixture(t);
  const writer = new (sqlite().DatabaseSync)(path);
  t.after(() => writer.close());
  writer.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO ZWAMESSAGE(Z_PK,ZTEXT) VALUES(1,'private');"
  );
  const baseline = new (sqlite().DatabaseSync)(`${pathToFileURL(path).href}?mode=ro&immutable=1`, { readOnly: true });
  assert.equal(baseline.prepare("SELECT count(*) n FROM ZWAMESSAGE").get().n, 0);
  baseline.close();
  const before = snapshot(dir);
  const { openIosSource } = await api();
  assert.throws(() => openIosSource(path), reason("source_incomplete"));
  assert.deepEqual(snapshot(dir), before);
});
test("accepts minimal schema, extras, escaped filename, empty WAL and stale SHM readonly", async (t) => {
  const { path, dir } = fixture(t, schema + "ALTER TABLE ZWAMESSAGE ADD COLUMN EXTRA BLOB;", "private #?%.sqlite");
  writeFileSync(`${path}-wal`, "");
  writeFileSync(`${path}-shm`, "stale");
  const before = snapshot(dir);
  const { openIosSource } = await api();
  const source = openIosSource(path);
  try {
    assert.equal(source.format, "coredata-v1");
    source.assertCurrent();
    assert.throws(() => source.db.exec("INSERT INTO ZWAMESSAGE(Z_PK) VALUES(1)"), /readonly/);
  } finally {
    source.close();
  }
  assert.deepEqual(snapshot(dir), before);
});
test("accepts checkpointed WAL-mode archive without changing header or companions", async (t) => {
  const { path } = fixture(t);
  const writer = new (sqlite().DatabaseSync)(path);
  writer.exec("PRAGMA journal_mode=WAL; INSERT INTO ZWAMESSAGE(Z_PK) VALUES(1); PRAGMA wal_checkpoint(TRUNCATE);");
  const before = readFileSync(path);
  const { openIosSource } = await api();
  const source = openIosSource(path);
  try {
    assert.equal(source.db.prepare("SELECT count(*) n FROM ZWAMESSAGE").get().n, 1);
  } finally {
    source.close();
    writer.close();
  }
  assert.deepEqual(readFileSync(path), before);
});
for (const suffix of ["-wal", "-journal"])
  for (const kind of ["nonempty", "directory", "symlink", "unreadable"]) {
    test(`refuses ${kind} ${suffix} companion`, async (t) => {
      const { path, dir } = fixture(t);
      const companion = `${path}${suffix}`;
      if (kind === "directory") mkdirSync(companion);
      else if (kind === "symlink") symlinkSync(join(dir, "absent"), companion);
      else {
        writeFileSync(companion, kind === "nonempty" ? "pending" : "");
        if (kind === "unreadable") chmodSync(companion, 0);
      }
      const { assertIosStandaloneSource, openIosSource } = await api();
      assert.throws(() => assertIosStandaloneSource(path), reason("source_incomplete"));
      assert.throws(() => openIosSource(path), reason("source_incomplete"));
    });
  }
test("standalone guard accepts arbitrary readable main bytes without parsing", async (t) => {
  const { path } = fixture(t);
  writeFileSync(path, "binding test bytes");
  const { assertIosStandaloneSource, openIosSource } = await api();
  assertIosStandaloneSource(path);
  assert.throws(() => openIosSource(path), reason("source_not_database"));
});
for (const ddl of [
  schema.replace("CREATE TABLE ZWAGROUPMEMBER(Z_PK INTEGER PRIMARY KEY,ZMEMBERJID TEXT);", ""),
  schema.replace(",ZTEXT TEXT", ""),
  schema.replace(
    "CREATE TABLE ZWAGROUPMEMBER(Z_PK INTEGER PRIMARY KEY,ZMEMBERJID TEXT);",
    "CREATE VIEW ZWAGROUPMEMBER AS SELECT 1 Z_PK, 'x' ZMEMBERJID;"
  ),
  schema.replaceAll("Z_PK INTEGER PRIMARY KEY", "Z_PK TEXT PRIMARY KEY"),
  schema.replace("Z_PK INTEGER PRIMARY KEY,ZCHATSESSION", "Z_PK INTEGER,ZCHATSESSION"),
  schema + "INSERT INTO ZWAMESSAGE(Z_PK) VALUES(0);",
  schema
    .replace("Z_PK INTEGER PRIMARY KEY,ZCHATSESSION", "Z_PK INTEGER,ZCHATSESSION")
    .replace("ZPARENTMESSAGE INTEGER);", "ZPARENTMESSAGE INTEGER,PRIMARY KEY(Z_PK,ZCHATSESSION));"),
])
  test("refuses unsupported physical schema or pagination key", async (t) => {
    const { path } = fixture(t, ddl);
    const { openIosSource } = await api();
    assert.throws(() => openIosSource(path), reason("source_schema_unsupported"));
  });
test("header-shaped corrupt database produces sanitized corruption error", async (t) => {
  const { path } = fixture(t);
  const bytes = Buffer.alloc(4096);
  bytes.write("SQLite format 3\0");
  writeFileSync(path, bytes);
  const { openIosSource } = await api();
  assert.throws(() => openIosSource(path), reason("source_corrupt"));
});
test("guards alias and canonical companions, appearing companions and source replacement", async (t) => {
  const { path, dir } = fixture(t);
  const alias = join(dir, "alias.sqlite");
  symlinkSync(path, alias);
  const { openIosSource } = await api();
  for (const base of [path, alias]) {
    const source = openIosSource(alias);
    writeFileSync(`${base}-wal`, "pending");
    try {
      assert.throws(() => source.assertCurrent(), reason("source_incomplete"));
    } finally {
      source.close();
      rmSync(`${base}-wal`);
    }
  }
  const source = openIosSource(path);
  renameSync(path, `${path}.old`);
  writeFileSync(path, readFileSync(`${path}.old`));
  try {
    assert.throws(() => source.assertCurrent(), reason("source_changed"));
  } finally {
    source.close();
  }
});

test("rejects unreadable, missing, nonregular and encrypted source without leaking details", async (t) => {
  const { path, dir } = fixture(t);
  const { assertIosStandaloneSource, openIosSource, IosSourceError } = await api();
  chmodSync(path, 0);
  try {
    assert.throws(() => assertIosStandaloneSource(path), reason("source_unreadable"));
  } finally {
    chmodSync(path, 0o600);
  }
  assert.throws(() => openIosSource(join(dir, "private-absent")), reason("source_unreadable"));
  assert.throws(() => openIosSource(dir), reason("source_unreadable"));
  writeFileSync(path, Buffer.alloc(4096, 0xc7));
  assert.throws(
    () => openIosSource(path),
    (error) => {
      assert.ok(error instanceof IosSourceError);
      return reason("source_not_database")(error);
    }
  );
});
test("empty regular journal is safe, appearing journal and alias retarget are detected", async (t) => {
  const { path, dir } = fixture(t);
  writeFileSync(`${path}-journal`, "");
  const alias = join(dir, "private-alias");
  symlinkSync(path, alias);
  const { openIosSource } = await api();
  const source = openIosSource(alias);
  try {
    writeFileSync(`${path}-journal`, "pending");
    assert.throws(() => source.assertCurrent(), reason("source_incomplete"));
  } finally {
    source.close();
    rmSync(`${path}-journal`);
  }
  const second = openIosSource(alias);
  const replacement = join(dir, "replacement");
  writeFileSync(replacement, readFileSync(path));
  rmSync(alias);
  symlinkSync(replacement, alias);
  try {
    assert.throws(() => second.assertCurrent(), reason("source_changed"));
  } finally {
    second.close();
  }
});

for (const table of ["ZWACHATSESSION", "ZWAGROUPMEMBER", "ZWAMESSAGE", "ZWAMEDIAITEM"]) {
  for (const value of ["0", "-1", "9007199254740992", "9223372036854775807"]) {
    test(`refuses ${table} key ${value} before returning a source`, async (t) => {
      const { path } = fixture(t, schema + `INSERT INTO ${table}(Z_PK) VALUES(${value});`);
      const before = readFileSync(path);
      const { openIosSource } = await api();
      assert.throws(() => openIosSource(path), reason("source_schema_unsupported"));
      assert.deepEqual(readFileSync(path), before);
    });
  }
  for (const form of ["descending", "without-rowid"]) {
    test(`refuses ${table} ${form} primary key without a rowid alias`, async (t) => {
      const ddl = schema.replace(new RegExp(`CREATE TABLE ${table}\\([^;]+;`), (definition) =>
        form === "descending"
          ? definition.replace("INTEGER PRIMARY KEY", "INTEGER PRIMARY KEY DESC")
          : definition.replace(");", ") WITHOUT ROWID;")
      );
      const { path } = fixture(t, ddl);
      const { openIosSource } = await api();
      assert.throws(() => openIosSource(path), reason("source_schema_unsupported"));
    });
  }
}
test("accepts maximum safe rowid keys in all required tables", async (t) => {
  const inserts = ["ZWACHATSESSION", "ZWAGROUPMEMBER", "ZWAMESSAGE", "ZWAMEDIAITEM"]
    .map((table) => `INSERT INTO ${table}(Z_PK) VALUES(1),(9007199254740991);`)
    .join("");
  const { path } = fixture(t, schema + inserts);
  const { openIosSource } = await api();
  const source = openIosSource(path);
  try {
    source.assertCurrent();
  } finally {
    source.close();
  }
});

test("accepts nonempty lowercase table and column names", async (t) => {
  const inserts = ["zwachatsession", "zwagroupmember", "zwamessage", "zwamediaitem"]
    .map((table) => `INSERT INTO ${table}(z_pk) VALUES(1),(2);`)
    .join("");
  const { path } = fixture(t, schema.toLowerCase() + inserts);
  const { openIosSource } = await api();
  const source = openIosSource(path);
  try {
    source.assertCurrent();
    assert.equal(source.db.prepare("SELECT count(*) n FROM zwamessage").get().n, 2);
  } finally {
    source.close();
  }
});
