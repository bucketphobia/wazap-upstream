import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { httpRequestLog, logLabel } from "../dist/http-log.js";

test("log labels strip quotes, backslashes, terminal escapes and line separators, and stay bounded", () => {
  const label = logLabel('a"b\\c\nd\r\te\x1b\u2028' + "x".repeat(1000));
  assert.equal(label.length, 60);
  assert.match(label, /^abcdex+$/);
});

test("aborted HTTP requests use the same sanitized route/RPC fields", () => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const req = {
      method: "POST",
      originalUrl: "/authorize?state=SECRET",
      body: { method: { toString: "invalid" } },
      headers: { accept: "SECRET" },
    };
    const res = Object.assign(new EventEmitter(), { writableEnded: false });
    let next = false;
    httpRequestLog(req, res, () => {
      next = true;
    });
    res.emit("close");
    assert.equal(next, true);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /HTTP POST \/authorize rpc=other .*client closed/);
    assert.doesNotMatch(lines[0], /SECRET/);
  } finally {
    console.error = original;
  }
});

test("the request line counts the body bytes written, strings by their UTF-8 length, and says the encoding", () => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const req = { method: "POST", originalUrl: "/mcp", body: { method: "tools/list" }, headers: { accept: "application/json, text/event-stream" } };
    const headers = { "content-encoding": "gzip" };
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableEnded: true,
      getHeader: (name) => headers[name],
      write: () => true,
      end: () => undefined,
    });
    httpRequestLog(req, res, () => {});
    res.write("ăî");
    res.write(Buffer.alloc(10));
    res.end(new Uint8Array(5), () => {});
    res.emit("finish");
    assert.match(lines[0], /HTTP POST \/mcp rpc=tools\/list .* -> 200 \(\d+ms\) bytes=19 enc=gzip$/);
  } finally {
    console.error = original;
  }
});
