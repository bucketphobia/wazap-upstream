import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpEndpoint } from "../dist/server.js";
import { registerTools } from "../dist/tools.js";
import { loadMedia } from "../dist/outgoing-media.js";
import { asToolSource, draftStub, offlineConfig } from "./helpers.mjs";

const CHAT = "40722123456@s.whatsapp.net";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "wazap-remote-files-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "private-test.txt");
  writeFileSync(file, "synthetic-private-data");
  let reads = 0;
  let downloads = 0;
  const store = draftStub();
  function read(source) {
    if (source?.file_path) {
      reads++;
      readFileSync(source.file_path);
    }
  }
  const wa = {
    getStatus: () => ({ status: "connected", status_since: new Date().toISOString(), read_only: false }),
    draft: async (payload) => {
      read(payload.source);
      return store.view(store.put({ chat_id: CHAT, name: "Test" }, payload));
    },
    manageGroup: async (_group, _action, _ids, _value, source) => {
      read(source);
      return { applied: "ok" };
    },
    // A directory-write attempt need not write anything to prove it reached the service.
    openMedia: async (_sid, opts) => {
      downloads++;
      const file = opts.noFile ? {} : { path: join(dir, "media", "test.txt"), filename: "test.txt" };
      return { ...file, mime: "text/plain", size: 4, source: "whatsapp", rendition: { kind: "none", note: "facts only" } };
    },
  };
  return { dir, file, hub: asToolSource(wa), reads: () => reads, downloads: () => downloads };
}

const operations = (file) => [
  ["send_message", { chat_id: CHAT, text: "", file_path: file }],
  ["manage_group", { group_id: "120363000000000001@g.us", action: "set_picture", file_path: file }],
  ["get_media", { message_id: `false_${CHAT}_msg`, save_to: "/unused/synthetic/directory" }],
];

/** A refusal's code, from structured content or, on a tool with an output schema, from its text. */
const refusal = (result) => result.structuredContent?.error ?? JSON.parse(result.content[0].text).error;

for (const index of [0, 1, 2]) {
  test(`restricted tool registration rejects local filesystem operation ${index}`, async (t) => {
    const f = fixture(t);
    const tools = new Map();
    registerTools({ registerTool: (name, _meta, handler) => tools.set(name, handler) }, f.hub, {
      allowWrite: true,
      allowLocalFiles: false,
    });
    const [name, args] = operations(f.file)[index];
    const result = await tools.get(name)(args);
    assert.equal(refusal(result), "MEDIA_ACCESS_DENIED");
    assert.equal(f.reads(), 0);
    assert.equal(f.downloads(), 0);
    assert.ok(!result.content[0].text.includes(f.file));
  });
}

test("stdio-compatible tool registration retains intentional local file access", async (t) => {
  const f = fixture(t);
  const tools = new Map();
  registerTools({ registerTool: (name, _meta, handler) => tools.set(name, handler) }, f.hub, { allowWrite: true });
  const result = await tools.get("send_message")({ chat_id: CHAT, text: "", file_path: f.file });
  assert.equal(result.structuredContent.status, "draft");
  assert.equal(f.reads(), 1);
});

test("a media URL that fails says what the session can do: a remote one is never sent to file_path, a local one never told host files are off", async () => {
  const unresolvable = {
    resolve: async () => {
      throw Object.assign(Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    },
  };
  const wa = {
    getStatus: () => ({ status: "connected", status_since: new Date().toISOString(), read_only: false }),
    // The draft fetches its URL through the public-address guard, as the service's does.
    draft: async (payload) => {
      await loadMedia(payload.source, undefined, unresolvable);
      assert.fail("the URL cannot load");
    },
  };
  for (const allowLocalFiles of [false, true]) {
    const tools = new Map();
    registerTools({ registerTool: (name, _meta, handler) => tools.set(name, handler) }, asToolSource(wa), {
      allowWrite: true,
      allowLocalFiles,
    });
    const send = async (url) => JSON.parse((await tools.get("send_message")({ chat_id: CHAT, text: "", url })).content[0].text);
    const unfetched = await send("https://nonexistent-host.invalid/poza.jpg");
    assert.equal(unfetched.error, "URL_FETCH_FAILED");
    assert.doesNotMatch(unfetched.fix, /file_path/);
    assert.match(unfetched.fix, /check it with the user, or pass the file another way the tool lists \(send_message's data_base64/);
    const loopback = await send("http://127.0.0.1:9/chart.png");
    assert.equal(loopback.error, "MEDIA_ACCESS_DENIED");
    assert.doesNotMatch(loopback.fix, /host files|route around|file_path/);
    assert.match(loopback.fix, /Pass a public http\(s\) URL without credentials/);
  }
});

async function boot(t) {
  const f = fixture(t);
  const config = offlineConfig("wazap-http-security-", { dataDir: f.dir, readOnly: false });
  const stop = new AbortController();
  t.after(() => stop.abort());
  const port = await startHttpEndpoint(f.hub, config, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    signal: stop.signal,
    credentials: [
      { token: "remote-write", write: true },
      { token: "remote-read", write: false },
      { token: "private-bridge", write: true, localFiles: true },
    ],
  });
  return { ...f, base: `http://127.0.0.1:${port}` };
}

async function connect(t, base, token) {
  const c = new Client({ name: "remote-files", version: "1" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
  );
  t.after(() => c.close());
  return c;
}

test("HTTP on loopback is still remote; only the private bridge credential opens files", async (t) => {
  const f = await boot(t);
  const remote = await connect(t, f.base, "remote-write");
  for (const [name, args] of operations(f.file)) {
    const result = await remote.callTool({ name, arguments: { ...args, localFiles: true, allowLocalFiles: true } });
    assert.equal(refusal(result), "MEDIA_ACCESS_DENIED");
  }
  assert.equal(f.reads(), 0);
  const bridge = await connect(t, f.base, "private-bridge");
  const draft = await bridge.callTool({ name: "send_message", arguments: { chat_id: CHAT, text: "", file_path: f.file } });
  assert.equal(draft.structuredContent.status, "draft");
  assert.equal(f.reads(), 1);
});

test("an HTTP read token cannot choose the download directory", async (t) => {
  const f = await boot(t);
  const reader = await connect(t, f.base, "remote-read");
  const [name, args] = operations(f.file)[2];
  assert.equal(refusal(await reader.callTool({ name, arguments: args })), "MEDIA_ACCESS_DENIED");
  assert.equal(f.downloads(), 0);
});

test("remote clients retain public URLs, and get_media writes them no file and names no path", async (t) => {
  const f = await boot(t);
  const remote = await connect(t, f.base, "remote-write");
  const draft = await remote.callTool({
    name: "send_message",
    arguments: { chat_id: CHAT, text: "", url: "https://example.com/test.jpg" },
  });
  assert.equal(draft.structuredContent.status, "draft");
  const reader = await connect(t, f.base, "remote-read");
  const result = await reader.callTool({ name: "get_media", arguments: { message_id: `false_${CHAT}_msg` } });
  assert.equal(result.structuredContent.filename, undefined);
  assert.equal(result.structuredContent.path, undefined);
  assert.equal(result.structuredContent.mime, "text/plain");
  assert.equal(f.downloads(), 1);
  assert.equal(f.reads(), 0);
});

test("HTTP logs omit query/path secrets, unsafe RPC/header fields and parser error bodies", async (t) => {
  const f = await boot(t);
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk, encoding, callback) {
    chunks.push(String(chunk));
    const done = typeof encoding === "function" ? encoding : callback;
    done?.();
    return true;
  };
  try {
    const requests = [
      [
        "/mcp?code=QUERY_SECRET&state=STATE_SECRET",
        { method: "POST", body: JSON.stringify({ method: "BAD_RPC\nFORGED_LOG" }) },
      ],
      ["/PATH_SECRET", {}],
      ["/mcp", { method: "POST", body: '{"secret":"BODY_SECRET",invalid}' }],
    ];
    for (const [path, init] of requests) {
      const res = await fetch(`${f.base}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          accept: 'application/json, HEADER_SECRET="forged"',
          authorization: "Bearer remote-read",
        },
        signal: AbortSignal.timeout(5000),
      });
      await res.text();
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    process.stderr.write = original;
  }
  const logs = chunks.join("");
  assert.match(logs, /HTTP POST \/mcp/);
  for (const marker of [
    "QUERY_SECRET",
    "STATE_SECRET",
    "PATH_SECRET",
    "BAD_RPC",
    "FORGED_LOG",
    "BODY_SECRET",
    "HEADER_SECRET",
    "remote-read",
  ]) {
    assert.ok(!logs.includes(marker), `logs leaked ${marker}`);
  }
});
