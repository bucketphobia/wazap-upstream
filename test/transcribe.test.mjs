import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MODELS,
  PROVIDERS,
  classifyFailure,
  markFailure,
  downloadFile,
  maskKey,
  modelSpec,
  modelUrl,
  openaiProvider,
  readTranscribeSettings,
  redact,
  requireSafeUrl,
  stripPasted,
  transcribeFile,
  transcribeReady,
} from "../dist/transcribe/index.js";
import { WazapError } from "../dist/errors.js";

const KEY = `sk-proj-${"a".repeat(40)}Z9x7`;

function scratch(label) {
  return mkdtempSync(join(tmpdir(), `wazap-transcribe-${label}-`));
}

/** Closes idle keep-alive sockets first, or close() waits on undici's pool. */
async function withServer(handler, body) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await body(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

test("readTranscribeSettings defaults to transcription off", () => {
  const dir = scratch("settings");
  const settings = readTranscribeSettings({}, dir);
  assert.deepEqual(settings, {
    provider: null,
    language: "auto",
    auto: false,
    model: "turbo",
    whisperBin: null,
    apiKey: null,
    allowApi: false,
    apiAuthHeader: "Authorization",
    baseUrl: "https://api.openai.com/v1",
    apiModel: "gpt-4o-mini-transcribe",
    modelsDir: join(dir, "models"),
  });
});

test("API permission is explicit, defaults off, and does not enable the provider", () => {
  const dir = scratch("api-permission");
  assert.equal(readTranscribeSettings({}, dir).allowApi, false);
  assert.equal(readTranscribeSettings({ WAZAP_TRANSCRIBE_ALLOW_API: "1" }, dir).provider, null);
  const enabled = readTranscribeSettings({ WAZAP_TRANSCRIBE: "openai", WAZAP_TRANSCRIBE_ALLOW_API: "1" }, dir);
  assert.equal(enabled.allowApi, true);
  assert.equal(enabled.auto, false);
  assert.equal(readTranscribeSettings({ WAZAP_TRANSCRIBE: "openai", WAZAP_TRANSCRIBE_ALLOW_API: "1", WAZAP_TRANSCRIBE_AUTO: "1" }, dir).auto, true);
  assert.throws(() => readTranscribeSettings({ WAZAP_TRANSCRIBE_ALLOW_API: "maybe" }, dir), { code: "INVALID_ID" });
});

test("transcription auth header allows only Authorization or x-bf-vk", () => {
  const dir = scratch("auth-header");
  assert.equal(readTranscribeSettings({ WAZAP_TRANSCRIBE_AUTH_HEADER: "x-bf-vk" }, dir).apiAuthHeader, "x-bf-vk");
  assert.throws(() => readTranscribeSettings({ WAZAP_TRANSCRIBE_AUTH_HEADER: "Cookie" }, dir), { code: "INVALID_ID" });
});

test("Bifrost transcription uses the selected virtual-key header and exact model route", async () => {
  const file = audioFile();
  const seen = [];
  await withServer(async (req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization, key: req.headers["x-bf-vk"], body: await readBody(req) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: "synthetic" }));
  }, (url) => openaiProvider.transcribe(readTranscribeSettings({
    WAZAP_TRANSCRIBE: "openai", WAZAP_TRANSCRIBE_ALLOW_API: "1", WAZAP_TRANSCRIBE_API_KEY: KEY,
    WAZAP_TRANSCRIBE_AUTH_HEADER: "x-bf-vk", WAZAP_TRANSCRIBE_URL: url + "/openai",
    WAZAP_TRANSCRIBE_MODEL: "openai/owner-selected-transcribe",
  }, scratch("bifrost")), file, { language: "ar" }));
  assert.equal(seen[0].url, "/openai/audio/transcriptions");
  assert.equal(seen[0].authorization, undefined);
  assert.equal(seen[0].key, KEY);
  assert.match(seen[0].body, /openai\/owner-selected-transcribe/);
  assert.match(seen[0].body, /name="language"/);
  assert.match(seen[0].body, /\r\nar\r\n/);
});

test("readTranscribeSettings accepts both provider names", () => {
  const dir = scratch("settings");
  assert.equal(readTranscribeSettings({ WAZAP_TRANSCRIBE: "local" }, dir).provider, "local");
  assert.equal(readTranscribeSettings({ WAZAP_TRANSCRIBE: "openai" }, dir).provider, "openai");
  assert.equal(readTranscribeSettings({ WAZAP_TRANSCRIBE: " OpenAI " }, dir).provider, "openai");
});

test("readTranscribeSettings treats off, empty and 0 as no provider", () => {
  const dir = scratch("settings");
  for (const value of ["off", "", "0", "no", "none", "false"]) {
    assert.equal(readTranscribeSettings({ WAZAP_TRANSCRIBE: value }, dir).provider, null, value);
  }
});

test("auto follows the provider, and WAZAP_TRANSCRIBE_AUTO=0 turns it off", () => {
  const dir = scratch("settings");
  assert.equal(readTranscribeSettings({ WAZAP_TRANSCRIBE: "openai" }, dir).auto, true);
  assert.equal(readTranscribeSettings({ WAZAP_TRANSCRIBE: "openai", WAZAP_TRANSCRIBE_AUTO: "0" }, dir).auto, false);
  assert.equal(readTranscribeSettings({ WAZAP_TRANSCRIBE_AUTO: "1" }, dir).auto, false);
});

test("OPENAI_API_KEY is the fallback, and WAZAP_TRANSCRIBE_API_KEY wins", () => {
  const dir = scratch("settings");
  assert.equal(readTranscribeSettings({ OPENAI_API_KEY: "from-openai" }, dir).apiKey, "from-openai");
  assert.equal(
    readTranscribeSettings({ OPENAI_API_KEY: "from-openai", WAZAP_TRANSCRIBE_API_KEY: "from-wazap" }, dir).apiKey,
    "from-wazap"
  );
});

test("readTranscribeSettings refuses a provider name it does not know", () => {
  const dir = scratch("settings");
  assert.throws(
    () => readTranscribeSettings({ WAZAP_TRANSCRIBE: "whisper" }, dir),
    (err) => {
      assert.equal(err.code, "INVALID_ID");
      assert.match(err.fix, /local, openai or off/);
      return true;
    }
  );
});

test("readTranscribeSettings refuses a whisper model it does not know", () => {
  const dir = scratch("settings");
  assert.equal(readTranscribeSettings({ WAZAP_WHISPER_MODEL: "medium" }, dir).model, "medium");
  assert.throws(() => readTranscribeSettings({ WAZAP_WHISPER_MODEL: "tiny" }, dir), { code: "INVALID_ID" });
});

test("a key pasted with quotes and spaces is stored bare", () => {
  const dir = scratch("settings");
  assert.equal(readTranscribeSettings({ WAZAP_TRANSCRIBE_API_KEY: '  "sk-test-1234"  ' }, dir).apiKey, "sk-test-1234");
});

test("trailing slashes are stripped from WAZAP_TRANSCRIBE_URL", () => {
  const dir = scratch("settings");
  assert.equal(
    readTranscribeSettings({ WAZAP_TRANSCRIBE_URL: "https://llm.example/v1///" }, dir).baseUrl,
    "https://llm.example/v1"
  );
});

test("requireSafeUrl allows https and loopback http, and nothing else", () => {
  assert.equal(requireSafeUrl("https://api.openai.com/v1"), "https://api.openai.com/v1");
  assert.equal(requireSafeUrl("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1");
  assert.equal(requireSafeUrl("http://localhost/v1"), "http://localhost/v1");
  assert.equal(requireSafeUrl("http://[::1]:9000/v1"), "http://[::1]:9000/v1");
  assert.throws(() => requireSafeUrl("http://example.com/v1"), { code: "INVALID_ID" });
  assert.throws(() => requireSafeUrl("not a url"), { code: "INVALID_ID" });
});

test("readTranscribeSettings refuses a plain-http remote URL at the boundary", () => {
  const dir = scratch("settings");
  assert.throws(
    () => readTranscribeSettings({ WAZAP_TRANSCRIBE_URL: "http://example.com/v1" }, dir),
    (err) => {
      assert.equal(err.code, "INVALID_ID");
      assert.match(err.message, /non-https/);
      return true;
    }
  );
});

test("maskKey shows the tail and never the key", () => {
  assert.equal(maskKey(null), "not set");
  assert.equal(maskKey(undefined), "not set");
  assert.equal(maskKey(""), "not set");
  assert.equal(maskKey("abc"), "set");
  const masked = maskKey(KEY);
  assert.equal(masked, "set (…Z9x7)");
  assert.equal(masked.includes(KEY), false);
});

test("redact deletes every occurrence of the key", () => {
  const message = `401 from ${KEY}: key ${KEY} is revoked`;
  const clean = redact(message, KEY);
  assert.equal(clean.includes(KEY), false);
  assert.equal(clean.includes("Z9x7"), false);
  assert.equal(clean, "401 from : key  is revoked");
  assert.equal(redact(message, null), message);
  assert.equal(redact(message, ""), message);
});

test("stripPasted removes padding and one matching pair of quotes", () => {
  assert.equal(stripPasted("  sk-1234  "), "sk-1234");
  assert.equal(stripPasted("'sk-1234'"), "sk-1234");
  assert.equal(stripPasted('  " sk-1234 "  '), "sk-1234");
  assert.equal(stripPasted('""sk-1234""'), '"sk-1234"');
  assert.equal(stripPasted('sk-"12"-34'), 'sk-"12"-34');
  assert.equal(stripPasted("'sk-1234\""), "'sk-1234\"");
});

const PAYLOAD = Buffer.from("wazap-model-bytes-".repeat(300));
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");

/** Answers a ranged request with 206 so downloadFile can actually resume. */
function payloadHandler(seenRanges) {
  return (req, res) => {
    seenRanges.push(req.headers.range ?? null);
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (range === null) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(PAYLOAD);
      return;
    }
    const start = Number(range[1]);
    res.writeHead(206, {
      "content-type": "application/octet-stream",
      "content-range": `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
    });
    res.end(PAYLOAD.subarray(start));
  };
}

test("downloadFile verifies, renames, and leaves no .part behind", async () => {
  const target = join(scratch("download"), "model.bin");
  const ranges = [];
  const result = await withServer(payloadHandler(ranges), (url) =>
    downloadFile({ url: `${url}/model.bin`, path: target, sha256: PAYLOAD_SHA, bytes: PAYLOAD.length })
  );
  assert.deepEqual(result, { path: target, bytes: PAYLOAD.length, resumed: false, alreadyPresent: false });
  assert.deepEqual(ranges, [null]);
  assert.deepEqual(readFileSync(target), PAYLOAD);
  assert.equal(existsSync(`${target}.part`), false);
});

test("downloadFile resumes from a partial file instead of refetching it", async () => {
  const target = join(scratch("download"), "model.bin");
  writeFileSync(`${target}.part`, PAYLOAD.subarray(0, 2000));
  const ranges = [];
  const result = await withServer(payloadHandler(ranges), (url) =>
    downloadFile({ url: `${url}/model.bin`, path: target, sha256: PAYLOAD_SHA, bytes: PAYLOAD.length })
  );
  assert.deepEqual(ranges, ["bytes=2000-"]);
  assert.equal(result.resumed, true);
  assert.equal(result.bytes, PAYLOAD.length);
  assert.deepEqual(readFileSync(target), PAYLOAD);
  assert.equal(existsSync(`${target}.part`), false);
});

test("downloadFile drops a digest mismatch instead of keeping it", async () => {
  const target = join(scratch("download"), "model.bin");
  const expected = "0".repeat(64);
  await assert.rejects(
    withServer(payloadHandler([]), (url) =>
      downloadFile({ url: `${url}/model.bin`, path: target, sha256: expected, bytes: PAYLOAD.length })
    ),
    (err) => {
      assert.equal(err.code, "TRANSCRIBE_FAILED");
      assert.ok(err.message.includes(PAYLOAD_SHA), err.message);
      assert.ok(err.message.includes(expected), err.message);
      return true;
    }
  );
  assert.equal(existsSync(`${target}.part`), false);
  assert.equal(existsSync(target), false);
});

test("downloadFile does not hit the network when the file is already correct", async () => {
  const target = join(scratch("download"), "model.bin");
  writeFileSync(target, PAYLOAD);
  const ranges = [];
  const result = await withServer(payloadHandler(ranges), (url) =>
    downloadFile({ url: `${url}/model.bin`, path: target, sha256: PAYLOAD_SHA, bytes: PAYLOAD.length })
  );
  assert.deepEqual(result, { path: target, bytes: PAYLOAD.length, resumed: false, alreadyPresent: true });
  assert.deepEqual(ranges, []);
});

test("downloadFile restarts when the server ignores the Range header", async () => {
  const target = join(scratch("download"), "model.bin");
  writeFileSync(`${target}.part`, PAYLOAD.subarray(0, 2000));
  const ranges = [];
  const result = await withServer(
    (req, res) => {
      ranges.push(req.headers.range ?? null);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(PAYLOAD);
    },
    (url) => downloadFile({ url: `${url}/model.bin`, path: target, sha256: PAYLOAD_SHA, bytes: PAYLOAD.length })
  );
  assert.deepEqual(ranges, ["bytes=2000-"]);
  assert.equal(result.resumed, false);
  assert.deepEqual(readFileSync(target), PAYLOAD);
});

test("downloadFile drops a .part the server refuses to resume from", async () => {
  const target = join(scratch("download"), "model.bin");
  writeFileSync(`${target}.part`, PAYLOAD.subarray(0, 2000));
  await assert.rejects(
    withServer(
      (req, res) => {
        res.writeHead(416, { "content-range": `bytes */${PAYLOAD.length}` });
        res.end();
      },
      (url) => downloadFile({ url: `${url}/model.bin`, path: target, sha256: PAYLOAD_SHA, bytes: PAYLOAD.length })
    ),
    { code: "TRANSCRIBE_FAILED" }
  );
  assert.equal(existsSync(`${target}.part`), false, "a 416 would repeat forever with the part still there");
});

test("downloadFile refuses a 206 that starts at the wrong offset", async () => {
  const target = join(scratch("download"), "model.bin");
  writeFileSync(`${target}.part`, PAYLOAD.subarray(0, 2000));
  await assert.rejects(
    withServer(
      (req, res) => {
        res.writeHead(206, { "content-range": `bytes 500-${PAYLOAD.length - 1}/${PAYLOAD.length}` });
        res.end(PAYLOAD.subarray(500));
      },
      (url) => downloadFile({ url: `${url}/model.bin`, path: target, sha256: PAYLOAD_SHA, bytes: PAYLOAD.length })
    ),
    (err) => {
      assert.equal(err.code, "TRANSCRIBE_FAILED");
      assert.match(err.message, /wrong offset/);
      return true;
    }
  );
  assert.equal(existsSync(`${target}.part`), false);
});

function audioFile() {
  const path = join(scratch("audio"), "note.ogg");
  writeFileSync(path, Buffer.from("OggS-not-really-audio"));
  return path;
}

function openaiSettings(url) {
  return readTranscribeSettings(
    { WAZAP_TRANSCRIBE: "openai", WAZAP_TRANSCRIBE_URL: `${url}/v1`, WAZAP_TRANSCRIBE_API_KEY: KEY },
    scratch("openai")
  );
}

test("openaiProvider posts the audio and parses the transcript", async () => {
  const file = audioFile();
  const seen = [];
  const transcript = await withServer(
    async (req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: await readBody(req) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "  hello   there\n", language: "en", duration: 3.7 }));
    },
    (url) => openaiProvider.transcribe(openaiSettings(url), file, {})
  );

  assert.deepEqual(transcript, { text: "hello there", language: "en", duration_seconds: 4 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/v1/audio/transcriptions");
  assert.equal(seen[0].auth, `Bearer ${KEY}`);
  assert.ok(seen[0].body.includes('name="file"; filename="note.ogg"'), seen[0].body.slice(0, 300));
  assert.ok(seen[0].body.includes("gpt-4o-mini-transcribe"));
  assert.equal(seen[0].body.includes('name="language"'), false);
});

test("openaiProvider sends the language when one is configured", async () => {
  const file = audioFile();
  const bodies = [];
  await withServer(
    async (req, res) => {
      bodies.push(await readBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "salut" }));
    },
    (url) => openaiProvider.transcribe({ ...openaiSettings(url), language: "ro" }, file, {})
  );
  assert.ok(bodies[0].includes('name="language"'));
  assert.ok(bodies[0].includes("ro"));
});

test("the language argument overrides the configured one", async () => {
  const file = audioFile();
  const bodies = [];
  await withServer(
    async (req, res) => {
      bodies.push(await readBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "hallo" }));
    },
    (url) => openaiProvider.transcribe({ ...openaiSettings(url), language: "ro" }, file, { language: "de" })
  );
  assert.ok(bodies[0].includes("de"));
  assert.equal(bodies[0].includes("\r\nro\r\n"), false);
});

test("openaiProvider retries a 429 once and then succeeds", async () => {
  const file = audioFile();
  let hits = 0;
  const transcript = await withServer(
    (req, res) => {
      hits += 1;
      req.resume();
      if (hits === 1) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "slow down" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "second try" }));
    },
    (url) => openaiProvider.transcribe(openaiSettings(url), file, {})
  );
  assert.equal(hits, 2);
  assert.deepEqual(transcript, { text: "second try" });
});

test("a 401 that echoes the key back never carries it outward", async () => {
  const file = audioFile();
  let hits = 0;
  await assert.rejects(
    withServer(
      (req, res) => {
        hits += 1;
        req.resume();
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }));
      },
      (url) => openaiProvider.transcribe(openaiSettings(url), file, {})
    ),
    (err) => {
      assert.equal(err.code, "TRANSCRIBE_FAILED");
      assert.match(err.message, /401/);
      assert.equal(err.message.includes(KEY), false);
      assert.equal(err.message.includes("Z9x7"), false);
      assert.equal(err.fix.includes(KEY), false);
      assert.equal(err.fix.includes("Z9x7"), false);
      assert.match(err.fix, /wazap config transcribe openai/);
      return true;
    }
  );
  assert.equal(hits, 1, "a 401 must not be retried");
});

test("an HTTP refusal says whether another attempt could help, and never names the key", async () => {
  const file = audioFile();
  const cases = [
    [400, "permanent", /refused the audio \(HTTP 400\)/],
    [413, "permanent", /refused the audio \(HTTP 413\)/],
    [401, "paused", /refused the key \(HTTP 401\)/],
    [403, "paused", /refused the key \(HTTP 403\)/],
  ];
  for (const [status, kind, reason] of cases) {
    await assert.rejects(
      withServer(
        (req, res) => {
          req.resume();
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `bad ${KEY}` } }));
        },
        (url) => openaiProvider.transcribe(openaiSettings(url), file, {})
      ),
      (err) => {
        const failure = classifyFailure(err);
        assert.equal(failure.kind, kind, `HTTP ${status}`);
        assert.match(failure.reason, reason);
        assert.equal(failure.reason.includes("Z9x7"), false);
        return true;
      }
    );
  }
});

test("an upload cancelled because its account is being removed ends at once, and spends no attempt", async () => {
  const file = audioFile();
  const controller = new AbortController();
  const started = Date.now();
  await assert.rejects(
    withServer(
      (req) => {
        req.resume();
        setTimeout(() => controller.abort(), 20);
      },
      (url) => openaiProvider.transcribe(openaiSettings(url), file, { signal: controller.signal })
    ),
    (err) => {
      assert.equal(err.code, "TRANSCRIBE_FAILED");
      assert.deepEqual(classifyFailure(err), { kind: "waiting", reason: "stopping" });
      return true;
    }
  );
  assert.ok(Date.now() - started < 2_000, "not after the two-minute timeout");
});

test("a failure nobody marked is classified by what it is", () => {
  const withCause = (cause) => Object.defineProperty(new WazapError("MEDIA_UNAVAILABLE", "x"), "cause", { value: cause });
  assert.deepEqual(classifyFailure(withCause({ output: { statusCode: 404 } })), {
    kind: "permanent",
    reason: "media no longer on WhatsApp (HTTP 404)",
  });
  assert.equal(classifyFailure(withCause({ output: { statusCode: 410 } })).kind, "permanent");
  assert.equal(classifyFailure(withCause({ output: { statusCode: 408 } })).kind, "transient", "a timed-out re-upload request");
  assert.equal(classifyFailure(withCause(new Error("socket hang up"))).kind, "transient");
  assert.equal(classifyFailure(new WazapError("MEDIA_UNAVAILABLE", "no media")).kind, "permanent");
  assert.equal(classifyFailure(new WazapError("FILE_TOO_LARGE", "x")).kind, "permanent");
  assert.equal(classifyFailure(new WazapError("MESSAGE_NOT_FOUND", "x")).kind, "gone");
  assert.equal(classifyFailure(new WazapError("NOT_CONNECTED", "x")).kind, "waiting");
  assert.equal(classifyFailure(new WazapError("TRANSCRIBE_UNAVAILABLE", "x")).kind, "paused", "a provider not ready pauses the worker");
  assert.equal(classifyFailure(new Error("whisper.cpp fell over")).kind, "transient", "a crash is worth another attempt");
  assert.equal(classifyFailure(markFailure(new Error("x"), "permanent", "ffmpeg could not read the audio")).reason, "ffmpeg could not read the audio");
});

test("PROVIDERS is the only branch on the provider name", () => {
  assert.deepEqual(Object.keys(PROVIDERS), ["local", "openai"]);
  for (const provider of Object.values(PROVIDERS)) {
    assert.equal(typeof provider.transcribe, "function");
    assert.equal(typeof provider.ready, "function");
  }
});

test("transcription off is a clear error with a fix, not a crash", async () => {
  const settings = readTranscribeSettings({}, scratch("off"));
  await assert.rejects(transcribeFile(settings, "/nowhere/note.ogg"), (err) => {
    assert.equal(err.code, "TRANSCRIBE_UNAVAILABLE");
    assert.match(err.fix, /wazap config transcribe/);
    return true;
  });

  const readiness = await transcribeReady(settings);
  assert.equal(readiness.ok, false);
  assert.equal(readiness.detail, "transcription is off");
  assert.match(readiness.fix, /wazap config transcribe/);
});

test("the model table is pinned by file, size and digest", () => {
  assert.deepEqual(modelSpec("turbo"), {
    alias: "turbo",
    file: "ggml-large-v3-turbo-q5_0.bin",
    bytes: 574041195,
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
  });
  assert.equal(Object.keys(MODELS).length, 3);
  for (const spec of Object.values(MODELS)) assert.match(spec.sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => modelSpec("nope"), { code: "INVALID_ID" });
  assert.equal(
    modelUrl(modelSpec("turbo")),
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
  );
});
