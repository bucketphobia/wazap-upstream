/**
 * The memory limit on the native helpers get_media runs (pdftoppm, sips,
 * ffmpeg) is read from the operating system while they run. It must read the
 * real resident size on every platform the package ships for: Linux's statm
 * counts pages, which are 16 or 64 KiB on some arm64 kernels, so it reads
 * VmRSS in kB; Windows has no /bin/ps, so it asks tasklist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { NativeMemoryError, residentBytes, runNative, tasklistBytes, vmRssBytes } from "../dist/native-run.js";

test("Linux: VmRSS is read in kB, whatever the page size", () => {
  const status = "Name:\tpdftoppm\nState:\tR (running)\nVmPeak:\t  901234 kB\nVmSize:\t  900000 kB\nVmRSS:\t  524288 kB\nRssAnon:\t  520000 kB\n";
  assert.equal(vmRssBytes(status), 524288 * 1024);
  assert.equal(vmRssBytes("Name:\tzombie\nState:\tZ (zombie)\n"), null, "a zombie has no VmRSS line");
});

test("Windows: tasklist's memory column, grouped in any locale", () => {
  assert.equal(tasklistBytes('"pdftoppm.exe","4242","Console","1","123,456 K"\r\n'), 123456 * 1024);
  assert.equal(tasklistBytes('"ffmpeg.exe","4242","Console","1","123.456 K"\r\n'), 123456 * 1024);
  assert.equal(tasklistBytes('"ffmpeg.exe","4242","Console","1","123 456 K"\r\n'), 123456 * 1024);
  assert.equal(tasklistBytes("INFO: No tasks are running which match the specified criteria.\r\n"), null);
  assert.equal(tasklistBytes(""), null);
});

test("this platform's reading is the process's resident size, and null once it is gone", { skip: process.platform === "win32" }, async () => {
  const rss = await residentBytes(process.pid);
  const own = process.memoryUsage().rss;
  assert.ok(rss !== null && rss > own / 2 && rss < own * 2, `read ${rss}, the process says ${own}`);
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  assert.equal(await residentBytes(child.pid), null);
});

test("a child that grows past its limit is killed for it", { skip: process.platform === "win32", timeout: 20_000 }, async () => {
  const grow = "const keep = []; setInterval(() => keep.push(Buffer.alloc(16 * 1024 * 1024, 1)), 20);";
  await assert.rejects(runNative(process.execPath, ["-e", grow], { timeoutMs: 15_000, maxRssBytes: 200 * 1024 * 1024 }), (err) => {
    assert.ok(err instanceof NativeMemoryError, String(err));
    return true;
  });
});
