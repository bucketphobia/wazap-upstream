import test from "node:test";
import assert from "node:assert/strict";
import { AccountDb } from "../dist/db/index.js";
import { openTemp } from "./db-fixtures.mjs";

test("metadata namespace pages are bounded, ordered, literal and case-sensitive", (t) => {
  const { db } = openTemp();
  t.after(() => db.close());
  for (let i = 0; i < 1003; i++) db.setMeta(`ios_%:${String(i).padStart(4, "0")}`, String(i));
  db.setMeta("ios_other:0000", "unrelated");
  db.setMeta("IOS_%:0000", "different case");
  const first = db.scanMeta("ios_%:");
  assert.equal(first.length, 500);
  assert.equal(first[0].key, "ios_%:0000");
  assert.equal(first.at(-1).key, "ios_%:0499");
  const second = db.scanMeta("ios_%:", first.at(-1).key);
  assert.equal(second.length, 500);
  const third = db.scanMeta("ios_%:", second.at(-1).key);
  assert.deepEqual(
    third.map((item) => item.key),
    ["ios_%:1000", "ios_%:1001", "ios_%:1002"]
  );
  assert.deepEqual(db.scanMeta("ios_%:", third.at(-1).key), []);
  db.deleteMetaKeys(third.map((item) => item.key));
  assert.equal(db.getMeta("ios_%:1000"), null);
  assert.equal(db.getMeta("ios_other:0000"), "unrelated");
  assert.equal(db.getMeta("IOS_%:0000"), "different case");
});

test("metadata page deletion participates in the caller transaction and respects read-only opens", (t) => {
  const { db, path } = openTemp();
  t.after(() => db.close());
  db.setMeta("ios_v2:a", "original");
  assert.throws(
    () =>
      db.transaction(() => {
        db.deleteMetaKeys(["ios_v2:a"]);
        throw new Error("rollback");
      }),
    /rollback/
  );
  assert.equal(db.getMeta("ios_v2:a"), "original");
  const read = AccountDb.open(path, { readOnly: true });
  t.after(() => read.close());
  assert.deepEqual(
    read.scanMeta("ios_v2:").map(({ key, value }) => ({ key, value })),
    [{ key: "ios_v2:a", value: "original" }]
  );
  assert.throws(() => read.deleteMetaKeys(["ios_v2:a"]), { code: "READ_ONLY" });
  assert.throws(() => db.scanMeta("ios_v2:", "", 501), { code: "INVALID_INPUT" });
  assert.throws(() => db.deleteMetaKeys(Array(501).fill("ios_v2:a")), { code: "INVALID_INPUT" });
});
