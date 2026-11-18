/**
 * A service follows an upgrade of its own install: the version on disk is
 * watched, the drift is reported, and the unit's own install is what counts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { unitScript } from "../dist/service.js";
import { installedDrift, versionOnDisk, watchInstalledVersion } from "../dist/version-watch.js";

test("an upgrade fires once the new version has settled on two checks, never on one read mid-install", () => {
  const reads = ["1.7.4", "1.8.0", null, "1.8.0", "1.8.0", "1.8.0"];
  const fired = [];
  const watch = watchInstalledVersion({ running: "1.7.4", read: () => (reads.length > 0 ? reads.shift() : "1.8.0"), everyMs: 3_600_000, onUpgrade: (v) => fired.push(v) });
  try {
    watch.tick(); // same version
    watch.tick(); // first sight of 1.8.0
    assert.deepEqual(fired, []);
    watch.tick(); // unreadable mid-install: starts over
    watch.tick(); // first sight again
    assert.deepEqual(fired, []);
    watch.tick(); // settled
    assert.deepEqual(fired, ["1.8.0"]);
    watch.tick();
    assert.deepEqual(fired, ["1.8.0"], "the restart is asked for once");
  } finally {
    watch.stop();
  }
});

test("the drift is the version on disk only when it differs from the running one", () => {
  assert.equal(installedDrift("1.7.4", () => "1.7.4"), null);
  assert.equal(installedDrift("1.7.4", () => null), null);
  assert.equal(installedDrift("1.7.4", () => "1.8.0"), "1.8.0");
});

test("the unit's own install is read from its command, so a service on another prefix is told apart", () => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-unit-"));
  try {
    const pkg = join(dir, "prefix", "lib", "node_modules", "wazap-mcp");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "wazap-mcp", version: "1.7.3" }));
    const script = join(pkg, "dist", "index.js");
    const plist = join(dir, "com.wazap.server.plist");
    writeFileSync(
      plist,
      `<plist><dict><key>ProgramArguments</key>\n<array>\n<string>/usr/local/bin/node</string>\n<string>${script}</string>\n<string>serve</string>\n</array></dict></plist>`
    );
    assert.deepEqual(unitScript({ supervisor: "launchd", unitFile: plist }), { script, version: "1.7.3" });
    const unit = join(dir, "wazap.service");
    writeFileSync(unit, `[Service]\nExecStart=/usr/bin/node ${script} serve --http\n`);
    assert.deepEqual(unitScript({ supervisor: "systemd", unitFile: unit }), { script, version: "1.7.3" });
    assert.equal(unitScript({ supervisor: "launchd", unitFile: join(dir, "missing.plist") }), null);
    assert.equal(versionOnDisk(join(dir, "nope.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
