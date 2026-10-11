/**
 * Transcription where it meets WhatsApp: what a voice note reads as, the cache
 * that keeps a recording from reaching a provider twice, what survives a
 * restart, and the queue that runs behind ingestion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { WhatsAppService } from "../dist/whatsapp.js";
import { clockLabel } from "../dist/messages.js";
import { registerTools } from "../dist/tools.js";
import { mkdirSync, writeFileSync } from "node:fs";

import { asToolSource, connectedService } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";

const TRANSCRIBE_ENV = [
  "WAZAP_TRANSCRIBE",
  "WAZAP_TRANSCRIBE_API_KEY",
  "WAZAP_TRANSCRIBE_AUTO",
  "WAZAP_TRANSCRIBE_MODEL",
  "WAZAP_TRANSCRIBE_URL",
  "WAZAP_TRANSCRIBE_ALLOW_API",
  "WAZAP_WHISPER_BIN",
  "WAZAP_WHISPER_MODEL",
  "OPENAI_API_KEY",
];

/**
 * The service reads the transcription environment once, in its constructor, so
 * the variables are set around that call and put back straight after. The openai
 * provider is the one whose readiness is a key and nothing else, which keeps
 * whisper.cpp and its 574 MB model out of these tests.
 */
function serviceWith(env = {}, config = {}) {
  const saved = TRANSCRIBE_ENV.map((key) => [key, process.env[key]]);
  for (const key of TRANSCRIBE_ENV) delete process.env[key];
  Object.assign(process.env, env);
  try {
    // Writes on: read-only refuses the API provider, which is what the
    // read-only test below asserts and what every other test here must not hit.
    return connectedService(WhatsAppService, {
      prefix: "wazap-transcribe-",
      id: ME,
      name: "Răzvan",
      config: { readOnly: false, ...(config ?? {}) },
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CONFIGURED = { WAZAP_TRANSCRIBE: "openai", WAZAP_TRANSCRIBE_API_KEY: "sk-test-key" };
const MANUAL = { ...CONFIGURED, WAZAP_TRANSCRIBE_AUTO: "0" };

/** A provider that spawns nothing and records how many runs overlapped. */
function mockProvider({ text = "salut", delayMs = 1 } = {}) {
  const state = { calls: 0, running: 0, peak: 0, languages: [] };
  const transcribe = async (_settings, _file, opts) => {
    state.calls++;
    state.languages.push(opts.language);
    state.running++;
    state.peak = Math.max(state.peak, state.running);
    await sleep(delayMs);
    state.running--;
    return { text, language: "ro", duration_seconds: 6 };
  };
  return { state, transcribe };
}

/** Both seams at once: no provider is spawned and no media is fetched. */
function stub(svc, provider) {
  svc.transcriber = provider.transcribe;
  svc.mediaBuffer = async () => Buffer.from("not really an ogg file");
  return provider;
}

/** Stand-in for McpServer: records what got registered and lets us call it. */
function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, meta, handler) {
      tools.set(name, { meta, handler });
    },
  };
}

const voiceNote = (id, { seconds, at = Date.now(), ptt = true } = {}) => ({
  key: { remoteJid: PEER, fromMe: false, id },
  messageTimestamp: Math.floor(at / 1000),
  message: {
    audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt, ...(seconds === undefined ? {} : { seconds }) },
  },
});

const textMessage = (id, body, at = Date.now()) => ({
  key: { remoteJid: PEER, fromMe: false, id },
  messageTimestamp: Math.floor(at / 1000),
  message: { conversation: body },
});

const sidOf = (id) => `false_${PEER}_${id}`;
const deliver = (sock, messages) => sock.ev.emit("messages.upsert", { type: "notify", messages });

test("a duration reads as a clock, whatever its size", () => {
  assert.equal(clockLabel(6), "0:06");
  assert.equal(clockLabel(42), "0:42");
  assert.equal(clockLabel(185), "3:05");
  assert.equal(clockLabel(3723), "1:02:03");
});

test("a voice note reads as its length, and as its words once it has them", async () => {
  const { svc, sock } = serviceWith();
  const at = Date.now() - 60_000;
  deliver(sock, [voiceNote("V1", { seconds: 42, at }), voiceNote("V2", { at: at + 1000 })]);

  const before = (await svc.readMessages(PEER, 10)).data;
  assert.equal(before[0].text, "[voice message · 0:42]");
  assert.equal(before[0].transcript, undefined);
  assert.equal(before[1].text, "[voice message]", "a note WhatsApp said nothing about keeps the bare placeholder");

  svc.db.messages.setTranscript(sidOf("V1"), "salut");
  const after = (await svc.readMessages(PEER, 10)).data;
  assert.equal(after[0].text, '[voice message · 0:42] "salut"');
  assert.equal(after[0].transcript, "salut", "the bare words too, so an agent need not unwrap the placeholder");
  await svc.stop();
});

test("a message is transcribed once, and the second call says as much", async () => {
  const { svc, sock } = serviceWith(MANUAL);
  const provider = stub(svc, mockProvider());
  deliver(sock, [voiceNote("V1", { seconds: 6 })]);

  const first = await svc.transcribeAudio(sidOf("V1"));
  assert.deepEqual(first, { text: "salut", language: "ro", duration_seconds: 6, provider: "openai", cached: false });

  const second = await svc.transcribeAudio(sidOf("V1"));
  assert.equal(second.cached, true);
  assert.equal(second.text, "salut");
  assert.equal(provider.state.calls, 1, "one recording must never be sent to a provider twice");
  await svc.stop();
});

test("the tool's language argument reaches the provider", async () => {
  const { svc, sock } = serviceWith(MANUAL);
  const provider = stub(svc, mockProvider());
  deliver(sock, [voiceNote("V1", { seconds: 6 })]);

  await svc.transcribeAudio(sidOf("V1"), "ro");
  assert.deepEqual(provider.state.languages, ["ro"]);
  await svc.stop();
});

test("two callers wanting the same recording share one upload", async () => {
  const { svc, sock } = serviceWith(MANUAL);
  const provider = stub(svc, mockProvider({ delayMs: 5 }));
  deliver(sock, [voiceNote("V1", { seconds: 6 })]);

  const [first, second] = await Promise.all([svc.transcribeAudio(sidOf("V1")), svc.transcribeAudio(sidOf("V1"))]);
  assert.equal(
    provider.state.calls,
    1,
    "the cache is written only after a provider has run, so the second caller has to join the first"
  );
  assert.equal(first.text, "salut");
  assert.equal(second.text, "salut");
  await svc.stop();
});

test("a transcript survives a restart, and the newest one for a message is the one kept", async () => {
  const { svc, sock } = serviceWith(MANUAL, { persistHistory: true });
  const provider = stub(svc, mockProvider());
  deliver(sock, [voiceNote("V1", { seconds: 6 })]);
  await svc.transcribeAudio(sidOf("V1"));

  const reloaded = serviceWith(MANUAL, { persistHistory: true, dataDir: svc.config.dataDir });
  stub(reloaded.svc, provider);
  const cached = await reloaded.svc.transcribeAudio(sidOf("V1"));
  assert.deepEqual(
    cached,
    { text: "salut", language: "ro", duration_seconds: 6, provider: "openai", cached: true },
    "a restart does not send the recording again, and keeps who transcribed it, in what language and how long it ran"
  );
  assert.equal(provider.state.calls, 1);

  svc.db.messages.setTranscript(sidOf("V1"), "a doua încercare");
  assert.equal((await reloaded.svc.readMessages(PEER, 5)).data[0].transcript, "a doua încercare", "the newest transcript wins");
  await reloaded.svc.stop();
  await svc.stop();
});

test("an older snapshot, written before transcripts existed, still imports", async () => {
  const { svc } = serviceWith({}, { persistHistory: true });
  mkdirSync(svc.paths.root, { recursive: true });
  writeFileSync(svc.paths.storeFile, JSON.stringify({ v: 1, chats: {}, contacts: {}, messages: {}, byChat: {} }));
  await svc.bootStorage();
  assert.equal(svc.db.getMeta("import_state"), "done");
  await svc.stop();
});

test("auto mode takes the voice notes, one at a time, and leaves the rest", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  const provider = stub(svc, mockProvider({ delayMs: 5 }));
  const at = Date.now() - 600_000;
  deliver(sock, [
    voiceNote("V1", { seconds: 6, at }),
    voiceNote("V2", { seconds: 12, at: at + 1000 }),
    voiceNote("V3", { seconds: 18, at: at + 2000 }),
    voiceNote("A1", { seconds: 30, at: at + 3000, ptt: false }),
    voiceNote("LONG", { seconds: 601, at: at + 4000 }),
    voiceNote("NOLENGTH", { at: at + 5000 }),
  ]);

  const ids = ["V1", "V2", "V3", "A1", "LONG", "NOLENGTH"].map(sidOf);
  const transcribed = () => ids.filter((sid) => svc.db.messages.get(sid)?.transcript != null);
  assert.equal(transcribed().length, 0, "ingestion returned before a single provider had finished");

  await svc.transcribeIdle();
  assert.equal(provider.state.peak, 1, "a second whisper run would fight the first one for the machine");
  assert.deepEqual(
    transcribed().sort(),
    ["V1", "V2", "V3"].map(sidOf).sort(),
    "an audio file is something the sender attached, and a recording that is long or of unknown length is a bill nobody asked for"
  );
  assert.equal(provider.state.calls, 3);
  await svc.stop();
});

test("a provider that fails on one note does not stop the queue", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  const provider = mockProvider();
  stub(svc, provider);
  const run = provider.transcribe;
  svc.transcriber = async (settings, file, opts) => {
    if (provider.state.calls === 0) {
      provider.state.calls++;
      throw new Error("whisper.cpp fell over");
    }
    return run(settings, file, opts);
  };

  const at = Date.now() - 600_000;
  const realError = console.error;
  console.error = () => {};
  try {
    deliver(sock, [voiceNote("V1", { seconds: 6, at }), voiceNote("V2", { seconds: 6, at: at + 1000 })]);
    await svc.transcribeIdle();
  } finally {
    console.error = realError;
  }

  const transcribed = ["V1", "V2"].map(sidOf).filter((sid) => svc.db.messages.get(sid)?.transcript != null);
  assert.equal(transcribed.length, 1, "the other note still gets its turn");
  const failed = ["V1", "V2"].map(sidOf).find((sid) => !transcribed.includes(sid));
  assert.deepEqual(
    svc.db.transcripts.state(failed),
    { state: "queued", attempts: 1, running: false, error: "unexpected error" },
    "and the one that failed waits for its retry"
  );
  await svc.stop();
});

test("a transcript landing during shutdown does not hold the process open", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  stub(svc, mockProvider({ delayMs: 20 }));
  svc.config.persistHistory = true;
  deliver(sock, [voiceNote("V1", { seconds: 6 })]);

  await svc.stop();
  await svc.transcribeIdle();
  assert.equal(svc.storage.expiryTimer, null, "a stopped service must not arm a fresh timer");
  assert.equal(svc.storage.accountDb.isOpen, false, "and its database is closed, not written behind the stop");
});

test("a search by words finds a word that exists only in a transcript", async () => {
  const { svc, sock } = serviceWith();
  const at = Date.now() - 60_000;
  deliver(sock, [voiceNote("V1", { seconds: 6, at }), textMessage("T1", "nimic aici", at + 1000)]);
  svc.db.messages.setTranscript(sidOf("V1"), "am uitat umbrela acasă");

  const spoken = (await svc.searchMessages("umbrela", undefined, 10)).data;
  assert.deepEqual(
    spoken.map((view) => view.message_id),
    [sidOf("V1")]
  );

  const written = (await svc.searchMessages("nimic", undefined, 10)).data;
  assert.deepEqual(
    written.map((view) => view.message_id),
    [sidOf("T1")],
    "every other message still matches on exactly what it matched on before"
  );
  await svc.stop();
});

test("transcription names the reason it cannot answer", async () => {
  const { svc, sock } = serviceWith(MANUAL);
  stub(svc, mockProvider());
  deliver(sock, [textMessage("T1", "salut")]);

  await assert.rejects(() => svc.transcribeAudio(sidOf("NOPE")), { code: "MESSAGE_NOT_FOUND" });
  await assert.rejects(() => svc.transcribeAudio(sidOf("T1")), { code: "MEDIA_UNAVAILABLE" });
  await svc.stop();

  const off = serviceWith();
  stub(off.svc, mockProvider());
  deliver(off.sock, [voiceNote("V1", { seconds: 6 })]);
  await assert.rejects(
    () => off.svc.transcribeAudio(sidOf("V1")),
    (err) => {
      assert.equal(err.code, "TRANSCRIBE_UNAVAILABLE");
      assert.match(err.fix, /wazap config transcribe/, "the fix has to name the command that turns it on");
      return true;
    }
  );
  await off.svc.stop();
});

test("a provider name wazap does not know leaves the server up and says why", async () => {
  const { svc, sock } = serviceWith({ WAZAP_TRANSCRIBE: "wishful-thinking" });
  deliver(sock, [voiceNote("V1", { seconds: 6 })]);

  assert.equal((await svc.readMessages(PEER, 10)).data.length, 1, "every other tool keeps working");
  await assert.rejects(
    () => svc.transcribeAudio(sidOf("V1")),
    (err) => {
      assert.equal(err.code, "TRANSCRIBE_UNAVAILABLE");
      assert.match(err.message, /wishful-thinking/);
      return true;
    }
  );
  await svc.stop();
});

test("no tool output carries the API key, whatever the tool", async () => {
  const key = "sk-test-key-abcd1234";
  const { svc, sock } = serviceWith({ ...MANUAL, WAZAP_TRANSCRIBE_API_KEY: key });
  stub(svc, mockProvider());
  deliver(sock, [voiceNote("V1", { seconds: 6 })]);

  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: true });
  const said = [JSON.stringify(await svc.transcribeAudio(sidOf("V1")))];
  for (const name of ["get_status", "read_messages", "search"]) {
    said.push(JSON.stringify(await server.tools.get(name).handler({ chat_id: PEER, query: "salut" })));
  }

  assert.ok(
    said.every((text) => !text.includes(key)),
    "the key belongs in .env and nowhere else"
  );
  assert.ok(
    said.some((text) => text.includes("salut")),
    "and the transcript did come back, so this is not passing vacuously"
  );
  await svc.stop();
});

test("get_media spends a bucket of its own only on a provider run, ten a minute, and past it the file still comes", async () => {
  // The bucket is the process's: this is the only test in this file that spends it.
  const { svc, sock } = serviceWith(MANUAL);
  const provider = stub(svc, mockProvider());
  deliver(sock, Array.from({ length: 12 }, (_, i) => voiceNote(`V${i + 1}`, { seconds: 6 })));
  const server = fakeServer();
  registerTools(server, asToolSource(svc), { allowWrite: true });
  const getMedia = (id, tools = server) => tools.tools.get("get_media").handler({ message_id: sidOf(id) });

  const first = await getMedia("V1");
  assert.equal(first.content[0].text, 'Transcribed 0:06 (ro, openai): "salut"');
  // A transcript on hand is no run: asked again and again, it costs nothing.
  for (let call = 0; call < 15; call++) assert.equal((await getMedia("V1")).structuredContent.transcript.cached, true);
  for (let n = 2; n <= 10; n++) assert.equal((await getMedia(`V${n}`)).structuredContent.transcript.cached, false, `V${n}`);
  assert.equal(provider.state.calls, 10);

  const limited = (await getMedia("V11")).structuredContent;
  assert.equal(limited.transcript, undefined);
  assert.equal(limited.transcript_unavailable.code, "RATE_LIMITED");
  assert.equal(limited.transcript_unavailable.message, "Transcribe rate limit reached (10/minute).");
  assert.ok(limited.path, "the recording still comes, as a file");
  assert.equal(provider.state.calls, 10);

  // An HTTP client that re-initializes gets a fresh McpServer; the bucket is the
  // process's and must not arrive fresh with it.
  const rejoined = fakeServer();
  registerTools(rejoined, asToolSource(svc), { allowWrite: true });
  assert.equal((await getMedia("V12", rejoined)).structuredContent.transcript_unavailable.code, "RATE_LIMITED", "a new session must not come with ten more");
  await svc.stop();

  // Transcription off: nothing runs, so nothing is spent, however many notes are asked for.
  const off = serviceWith();
  off.svc.mediaBuffer = async () => Buffer.from("OggS");
  deliver(off.sock, Array.from({ length: 3 }, (_, i) => voiceNote(`O${i + 1}`, { seconds: 6 })));
  const offServer = fakeServer();
  registerTools(offServer, asToolSource(off.svc), { allowWrite: true });
  for (const id of ["O1", "O2", "O3"]) {
    const out = (await getMedia(id, offServer)).structuredContent;
    assert.equal(out.transcript_unavailable.code, "TRANSCRIBE_UNAVAILABLE", `${id}: off, not over a limit`);
    assert.ok(out.path);
  }
  await off.svc.stop();
});

test("a history sync queues the voice notes of the last day, never the archive behind them", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  const provider = stub(svc, mockProvider());
  const now = Date.now();

  sock.ev.emit("messaging-history.set", {
    chats: [],
    contacts: [],
    messages: [
      voiceNote("H1", { seconds: 8, at: now - 3_600_000 }),
      voiceNote("H2", { seconds: 9, at: now - 25 * 3_600_000 }),
      voiceNote("H3", { seconds: 9, at: now - 30 * 86_400_000 }),
    ],
    isLatest: true,
  });
  await svc.ingest.historyIdle();
  await svc.transcribeIdle();
  assert.equal(provider.state.calls, 1, "a relink would otherwise transcribe every voice note in the window");
  assert.deepEqual(
    ["H1", "H2", "H3"].filter((id) => svc.db.messages.get(sidOf(id))?.transcript != null),
    ["H1"],
    "the note of the last hour is read; the ones older than a day are left to get_media"
  );
  assert.equal(svc.db.transcripts.state(sidOf("H2")), null, "and nothing older waits on the queue either");

  deliver(sock, [voiceNote("L1", { seconds: 8, at: now - 3 * 86_400_000 })]);
  await svc.transcribeIdle();
  assert.equal(provider.state.calls, 2, "a note WhatsApp delivers live is an arrival, however old its stamp");
  await svc.stop();
});

test("a voice note the user recorded is not transcribed behind their back", async () => {
  const { svc, sock } = serviceWith(CONFIGURED);
  const provider = stub(svc, mockProvider());

  deliver(sock, [{ ...voiceNote("M1", { seconds: 8 }), key: { remoteJid: PEER, fromMe: true, id: "M1" } }]);
  await svc.transcribeIdle();
  assert.equal(provider.state.calls, 0, "they know what they said");
  await svc.stop();
});

test("read-only refuses the API provider and nothing else", async () => {
  const { svc, sock } = serviceWith(MANUAL, { readOnly: true });
  stub(svc, mockProvider());
  deliver(sock, [voiceNote("R1", { seconds: 6 })]);

  await assert.rejects(
    () => svc.transcribeAudio(sidOf("R1")),
    (err) => {
      assert.equal(err.code, "READ_ONLY", "uploading the user's audio and spending their money is not a read");
      assert.match(err.fix, /WAZAP_TRANSCRIBE_ALLOW_API=1/);
      assert.match(err.fix, /transcribe local/);
      return true;
    }
  );
  await svc.stop();

  // Manual only: an automatic run would find whisper.cpp missing here and pause the process's worker.
  const local = serviceWith({ WAZAP_TRANSCRIBE: "local", WAZAP_TRANSCRIBE_AUTO: "0" }, { readOnly: true });
  stub(local.svc, mockProvider());
  deliver(local.sock, [voiceNote("R2", { seconds: 6 })]);
  await assert.rejects(
    () => local.svc.transcribeAudio(sidOf("R2")),
    (err) => {
      assert.equal(err.code, "TRANSCRIBE_UNAVAILABLE", "whisper.cpp sends nothing anywhere, so read-only has no say");
      return true;
    }
  );
  await local.svc.stop();
});

test("explicit API transcription permission preserves WhatsApp read-only tools and caches the result", async () => {
  const { svc, sock } = serviceWith({ ...MANUAL, WAZAP_TRANSCRIBE_ALLOW_API: "1" }, { readOnly: true });
  const provider = stub(svc, mockProvider({ text: "synthetic Arabic transcript" }));
  try {
    deliver(sock, [voiceNote("OPT1", { seconds: 6 })]);
    const first = await svc.transcribeAudio(sidOf("OPT1"), "ar");
    const second = await svc.transcribeAudio(sidOf("OPT1"), "ar");
    assert.equal(first.text, "synthetic Arabic transcript");
    assert.equal(second.cached, true);
    assert.equal(provider.state.calls, 1);
    assert.deepEqual(provider.state.languages, ["ar"]);
    const server = fakeServer();
    registerTools(server, asToolSource(svc), { allowWrite: false });
    for (const name of ["send_message", "confirm_send", "edit_message", "delete_message", "react_to_message", "manage_chat", "manage_group"]) {
      assert.equal(server.tools.has(name), false, name);
    }
  } finally {
    await svc.stop();
  }
});

test("API opt-in defaults to on-request and automatic mode requires an explicit switch", async () => {
  const manual = serviceWith({ ...CONFIGURED, WAZAP_TRANSCRIBE_ALLOW_API: "1" }, { readOnly: true });
  const provider = stub(manual.svc, mockProvider());
  try {
    deliver(manual.sock, [voiceNote("OPT2", { seconds: 6 })]);
    await manual.svc.transcribeIdle();
    assert.equal(provider.state.calls, 0);
    assert.equal(manual.svc.voice.autoTranscribe, false);
    await manual.svc.transcribeAudio(sidOf("OPT2"));
    assert.equal(provider.state.calls, 1);
  } finally {
    await manual.svc.stop();
  }
  const automatic = serviceWith({ ...CONFIGURED, WAZAP_TRANSCRIBE_ALLOW_API: "1", WAZAP_TRANSCRIBE_AUTO: "1" }, { readOnly: true });
  const autoProvider = stub(automatic.svc, mockProvider());
  try {
    deliver(automatic.sock, [voiceNote("OPT3", { seconds: 6 })]);
    await automatic.svc.transcribeIdle();
    assert.equal(autoProvider.state.calls, 1);
    assert.equal(automatic.svc.voice.autoTranscribe, true);
  } finally {
    await automatic.svc.stop();
  }
});
