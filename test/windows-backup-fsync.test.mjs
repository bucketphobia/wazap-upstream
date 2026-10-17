import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a backup flush succeeds when fsync requires a writable handle", () => {
  const directory = mkdtempSync(join(tmpdir(), "wazap-flush-"));
  const moduleUrl = new URL("../dist/db/index.js", import.meta.url).href;
  const code = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import assert from "node:assert/strict";
    const originalOpen = fs.openSync;
    const originalSync = fs.fsyncSync;
    const modes = new Map();
    let flushed = 0;
    fs.openSync = (...args) => {
      const descriptor = originalOpen(...args);
      modes.set(descriptor, args[1]);
      return descriptor;
    };
    // Windows FlushFileBuffers rejects handles opened without write access.
    fs.fsyncSync = (descriptor) => {
      if (modes.get(descriptor) === "r") {
        throw Object.assign(new Error("flush requires write access"), { code: "EBADF" });
      }
      flushed++;
      return originalSync(descriptor);
    };
    syncBuiltinESMExports();
    const { AccountDb } = await import(${JSON.stringify(moduleUrl)});
    const db = AccountDb.open(${JSON.stringify(join(directory, "live.sqlite"))});
    await db.backup(${JSON.stringify(join(directory, "copy.sqlite"))});
    db.close();
    assert.ok(flushed > 0);
    const copy = AccountDb.open(${JSON.stringify(join(directory, "copy.sqlite"))});
    copy.close();
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
