import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openaiProvider } from "../dist/transcribe/openai.js";
import { readTranscribeSettings, requireSafeUrl } from "../dist/transcribe/settings.js";
import { WebhookSink, requireWebhookUrl, readWebhookSettings } from "../dist/webhook.js";

const SECRET = "synthetic-signing-key";
const PRIVATE = "synthetic-private-url-token";

function audio(t, baseUrl = "https://provider.example/v1") {
  const dir = mkdtempSync(join(tmpdir(), "wazap-sinks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "note.ogg");
  writeFileSync(file, "OggS synthetic audio");
  const settings = readTranscribeSettings(
    { WAZAP_TRANSCRIBE: "openai", WAZAP_TRANSCRIBE_URL: baseUrl, WAZAP_TRANSCRIBE_API_KEY: SECRET },
    dir
  );
  return { file, settings };
}

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  return `http://127.0.0.1:${server.address().port}`;
}

function sink(post, url = `https://hooks.example/${PRIVATE}?token=${PRIVATE}`) {
  return new WebhookSink(
    { WAZAP_WEBHOOK: "on", WAZAP_WEBHOOK_URL: url, WAZAP_WEBHOOK_SECRET: SECRET },
    { post, retryDelays: [] }
  );
}

for (const status of [301, 302, 303, 307, 308]) {
  test(`transcription refuses HTTP ${status} without following audio or credentials to another endpoint`, async (t) => {
    let targetHits = 0;
    const target = await listen(t, (req, res) => {
      targetHits++;
      req.resume();
      res.end('{"text":"unexpected"}');
    });
    let sourceHits = 0;
    const source = await listen(t, (req, res) => {
      sourceHits++;
      req.resume();
      res.writeHead(status, { location: `${target}/stolen` });
      res.end();
    });
    const { file, settings } = audio(t, source);
    await assert.rejects(openaiProvider.transcribe(settings, file, {}), { code: "TRANSCRIBE_FAILED" });
    assert.equal(sourceHits, 1);
    assert.equal(targetHits, 0);
  });
}

test("webhook redirects never forward payloads or signatures", async (t) => {
  let targetHits = 0;
  const target = await listen(t, (req, res) => {
    targetHits++;
    req.resume();
    res.end();
  });
  const source = await listen(t, (req, res) => {
    req.resume();
    res.writeHead(307, { location: target });
    res.end();
  });
  const result = await sink(globalThis.fetch, source).sendTest();
  assert.equal(result.ok, false);
  assert.equal(targetHits, 0);
});

for (const status of [200, 401, 500]) {
  test(`webhook HTTP ${status} cancels unread response bodies`, async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status }
    );
    const result = await sink(async () => response).sendTest();
    assert.equal(result.ok, status === 200);
    assert.equal(cancelled, true);
  });
}

test("webhook failures keep URL secrets, payload echoes and transport messages out of diagnostics", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  const failing = sink(async () => {
    throw Error(`request ${PRIVATE}: ${SECRET}; private payload excerpt`);
  });
  const result = await failing.sendTest();
  const serialized = JSON.stringify({ result, info: failing.info(), logs });
  for (const secret of [PRIVATE, SECRET, "private payload excerpt"]) assert.ok(!serialized.includes(secret), secret);
  assert.match(result.error, /hooks.example/);
});

for (const status of [400, 401, 403]) {
  test(`transcription HTTP ${status} discards provider error bodies instead of echoing them`, async (t) => {
    const { file, settings } = audio(t);
    let cancelled = false;
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(`private transcript ${PRIVATE} ${SECRET}`));
              c.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status }
        )
    );
    await assert.rejects(openaiProvider.transcribe(settings, file, {}), (err) => {
      assert.equal(err.code, "TRANSCRIBE_FAILED");
      assert.match(err.message, new RegExp(String(status)));
      assert.ok(!err.message.includes(PRIVATE));
      assert.ok(!err.message.includes(SECRET));
      return true;
    });
    assert.equal(cancelled, true);
  });
}

for (const responseBody of [`not JSON: ${PRIVATE}`, "null", "[]", '{"text":123}']) {
  test(`invalid transcription JSON is a typed, secret-safe failure (${responseBody.slice(0, 12)})`, async (t) => {
    const { file, settings } = audio(t);
    t.mock.method(globalThis, "fetch", async () => new Response(responseBody));
    await assert.rejects(openaiProvider.transcribe(settings, file, {}), (err) => {
      assert.equal(err.code, "TRANSCRIBE_FAILED");
      assert.ok(!err.message.includes(PRIVATE));
      return true;
    });
  });
}

test("transcription network exceptions do not echo endpoint tokens or transport details", async (t) => {
  const { file, settings } = audio(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw Error(`failed https://provider.example/${PRIVATE} ${SECRET}`);
  });
  await assert.rejects(openaiProvider.transcribe(settings, file, {}), (err) => {
    assert.equal(err.code, "TRANSCRIBE_FAILED");
    assert.ok(!err.message.includes(PRIVATE));
    assert.ok(!err.message.includes(SECRET));
    return true;
  });
});

for (const declared of [4 * 1024 * 1024, undefined, 1]) {
  test(`transcription response size is bounded (Content-Length ${declared ?? "absent"})`, async (t) => {
    const { file, settings } = audio(t);
    let cancelled = false;
    let chunks = 0;
    const response = new Response(
      new ReadableStream({
        pull(c) {
          chunks++;
          c.enqueue(new TextEncoder().encode(chunks === 1 ? '{"text":"' : "a".repeat(64 * 1024)));
          if (chunks === 40) {
            c.enqueue(new TextEncoder().encode('"}'));
            c.close();
          }
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: declared === undefined ? {} : { "content-length": String(declared) } }
    );
    t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(openaiProvider.transcribe(settings, file, {}), { code: "TRANSCRIBE_FAILED" });
    assert.equal(cancelled, true);
    assert.ok(chunks < 40, "stop reading as soon as the cap is reached");
  });
}

for (const validate of [requireSafeUrl, requireWebhookUrl]) {
  test(`${validate.name} never quotes invalid URL input`, () => {
    const invalidUrls = [`not-a-url-${PRIVATE}`, `ftp://remote.example/${PRIVATE}`];
    if (validate === requireWebhookUrl) invalidUrls.push(`http://remote.example/${PRIVATE}`);
    for (const url of invalidUrls) {
      assert.throws(
        () => validate(url),
        (err) => {
          assert.equal(err.code, "INVALID_ID");
          assert.ok(!err.message.includes(PRIVATE));
          return true;
        }
      );
    }
    assert.throws(() => validate(`https://user:${PRIVATE}@provider.example/v1`), { code: "INVALID_ID" });
  });
}

test("transcription base URLs reject query/fragment ambiguity; webhook token queries remain supported", () => {
  for (const suffix of [`?token=${PRIVATE}`, `#${PRIVATE}`])
    assert.throws(() => requireSafeUrl(`https://provider.example/v1${suffix}`), { code: "INVALID_ID" });
  assert.equal(
    readWebhookSettings({
      WAZAP_WEBHOOK: "on",
      WAZAP_WEBHOOK_URL: `https://hooks.example/?token=${PRIVATE}`,
      WAZAP_WEBHOOK_SECRET: SECRET,
    }).kind,
    "ready"
  );
});

test("transcription readiness shows only the endpoint host, not a secret-bearing path", async (t) => {
  const { settings } = audio(t, `https://provider.example/${PRIVATE}`);
  const ready = await openaiProvider.ready(settings);
  assert.ok(!ready.detail.includes(PRIVATE));
  assert.match(ready.detail, /provider.example/);
});
