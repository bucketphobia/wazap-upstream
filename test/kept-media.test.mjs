/**
 * Kept media: what arrives in a chat the settings keep is downloaded at once
 * and kept beside the account database, so get_media still answers once
 * WhatsApp's servers let the file go, with the link down, and after a restart.
 * The limits hold whatever arrives: no file over the size limit, the oldest
 * going first past the quota or their age, nothing written onto a nearly full
 * disk, and a file never outliving its message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proto } from "baileys";

import { WazapError } from "../dist/errors.js";
import { accountPaths, settingWarnings } from "../dist/config.js";
import { mediaKeepSettings } from "../dist/media-keep.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, openService, schemaCheckedTools, storageRows, textError, waitFor } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const BOB = "40700000003@s.whatsapp.net";
const MB = 1024 * 1024;

/** A booted, connected server whose WhatsApp downloads are counted, and fail once `expired` says so. */
async function setup(t, { env = {}, config = {}, dataDir } = {}) {
  const overrides = {
    persistHistory: true,
    mediaKeep: mediaKeepSettings(env),
    ...(dataDir ? { dataDir } : {}),
    ...config,
  };
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-kept-", id: ME, name: "Răzvan", config: overrides });
  t.after(() => svc.stop());
  await svc.bootStorage();
  const state = { downloads: 0, expired: false, bytes: new Map() };
  svc.mediaBuffer = async (_sock, sid) => {
    state.downloads++;
    if (state.expired) throw new WazapError("MEDIA_UNAVAILABLE", `Could not download the media of ${sid}: 410`);
    const bytes = state.bytes.get(sid);
    if (bytes === undefined) throw new WazapError("MEDIA_UNAVAILABLE", "no such media");
    return bytes;
  };
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  let seq = 0;
  /** A live message with this media content; its bytes are what WhatsApp would serve. */
  const arrive = (chat, content, bytes, { fromMe = false } = {}) => {
    const id = `K${++seq}`;
    const sid = `${fromMe}_${chat}_${id}`;
    if (bytes !== undefined) state.bytes.set(sid, bytes);
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{ key: { remoteJid: chat, fromMe, id }, message: content, messageTimestamp: Math.floor(Date.now() / 1000) }],
    });
    return sid;
  };
  return { svc, sock, call, arrive, state, saveTo: mkdtempSync(join(tmpdir(), "wazap-kept-out-")) };
}

const photo = (bytes, extra = {}) => ({ imageMessage: { mimetype: "image/jpeg", fileLength: bytes.length, ...extra } });
const voice = (bytes) => ({ audioMessage: { mimetype: "audio/ogg; codecs=opus", fileLength: bytes.length, seconds: 3, ptt: true } });
const pdf = (bytes) => ({ documentMessage: { mimetype: "application/pdf", fileName: "factura.pdf", fileLength: bytes.length } });
const video = (bytes) => ({ videoMessage: { mimetype: "video/mp4", fileLength: bytes.length } });

function keptPath(svc, sid) {
  return svc.db.messages.media(sid).find((media) => media.kind === "original")?.path;
}

async function keptOf(svc, sid) {
  return waitFor(() => keptPath(svc, sid), 5000, `the kept copy of ${sid}`);
}

/** Waits for the keeper to go quiet: the queue drained and every store landed. */
async function settled(svc) {
  await waitFor(() => svc.keep.worker === null, 5000, "the kept-media queue to drain");
  await svc.keep.work;
  await svc.storage.fileWork;
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest();
}

// --- settings -----------------------------------------------------------------

test("the defaults keep photos, voice, audio and documents of unmuted chats, within 16 MB, 1 GB and 90 days", () => {
  const settings = mediaKeepSettings({});
  assert.equal(settings.policy, "unmuted");
  assert.deepEqual([...settings.types].sort(), ["audio", "document", "image", "voice"]);
  assert.equal(settings.maxFileBytes, 16 * MB);
  assert.equal(settings.quotaBytes, 1024 * MB);
  assert.equal(settings.maxAgeMs, 90 * 24 * 60 * 60 * 1000);
  assert.deepEqual(settings.problems, []);
});

test("every kept-media setting is read, and off is off", () => {
  const settings = mediaKeepSettings({
    WAZAP_MEDIA_KEEP: "chats",
    WAZAP_MEDIA_KEEP_CHATS: "+40 700 000 002, 120363000000000001@g.us",
    WAZAP_MEDIA_KEEP_TYPES: "image,video",
    WAZAP_MEDIA_KEEP_MAX_MB: "5",
    WAZAP_MEDIA_KEEP_QUOTA_MB: "50",
    WAZAP_MEDIA_KEEP_DAYS: "0",
  });
  assert.equal(settings.policy, "chats");
  assert.deepEqual(settings.chats, ["40700000002", "120363000000000001@g.us"]);
  assert.deepEqual([...settings.types].sort(), ["image", "video"]);
  assert.equal(settings.maxFileBytes, 5 * MB);
  assert.equal(settings.quotaBytes, 50 * MB);
  assert.equal(settings.maxAgeMs, 0, "0 days: kept until the quota needs the room");
  for (const off of ["off", "0", "OFF", "no"]) assert.equal(mediaKeepSettings({ WAZAP_MEDIA_KEEP: off }).policy, "off");
});

test("a value that does not parse keeps nothing, and says so at startup", () => {
  const cases = [
    { WAZAP_MEDIA_KEEP: "everything" },
    { WAZAP_MEDIA_KEEP: "chats" },
    { WAZAP_MEDIA_KEEP_CHATS: "not a chat" },
    { WAZAP_MEDIA_KEEP_TYPES: "image,gif" },
    { WAZAP_MEDIA_KEEP_MAX_MB: "0" },
    { WAZAP_MEDIA_KEEP_MAX_MB: "101" },
    { WAZAP_MEDIA_KEEP_QUOTA_MB: "1.5" },
    { WAZAP_MEDIA_KEEP_QUOTA_MB: "-1" },
    { WAZAP_MEDIA_KEEP_DAYS: "forever" },
  ];
  for (const env of cases) {
    const settings = mediaKeepSettings(env);
    assert.equal(settings.policy, "off", JSON.stringify(env));
    assert.equal(settings.problems.length, 1, JSON.stringify(env));
    const warnings = settingWarnings(env);
    assert.ok(warnings.some((line) => /media is not being kept/.test(line)), JSON.stringify(env));
  }
  assert.deepEqual(settingWarnings({}).filter((line) => /media/.test(line)), []);
});

// --- keeping and serving ------------------------------------------------------

test("a photo that arrives is kept at once, and get_media serves it after WhatsApp let it go", async (t) => {
  const { svc, call, arrive, state, saveTo } = await setup(t);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 0xff, 0xd9]);
  const sid = arrive(ANA, photo(jpeg), jpeg);
  const path = await keptOf(svc, sid);
  assert.deepEqual(readFileSync(path), jpeg, "the kept file is the decrypted bytes");
  assert.ok(path.startsWith(svc.paths.keptDir), "kept under the account's kept folder");
  assert.equal(state.downloads, 1);

  state.expired = true;
  const out = (await call("get_media", { message_id: sid, save_to: saveTo })).structuredContent;
  assert.equal(out.source, "kept");
  assert.deepEqual(readFileSync(out.path), jpeg);
  assert.equal(state.downloads, 1, "WhatsApp was not asked again");
});

test("the kept copy answers with the link down", async (t) => {
  const { svc, call, arrive, saveTo } = await setup(t);
  const ogg = Buffer.from("OggS kept voice");
  const sid = arrive(ANA, voice(ogg), ogg);
  await keptOf(svc, sid);
  svc.status = "disconnected";
  svc.sockClient = null;
  const out = (await call("get_media", { message_id: sid, save_to: saveTo })).structuredContent;
  assert.equal(out.source, "kept");
  assert.deepEqual(readFileSync(out.path), ogg);
});

test("without a kept copy get_media still downloads, says so, and keeps what the settings want", async (t) => {
  const { svc, call, state, sock, saveTo } = await setup(t, { env: { WAZAP_MEDIA_KEEP: "chats", WAZAP_MEDIA_KEEP_CHATS: ANA } });
  const bytes = Buffer.from("%PDF-1.4 kept later");
  // Arrives while keeping did not want it (another chat), then from ANA via history: no live arrival.
  const sid = `false_${ANA}_H1`;
  state.bytes.set(sid, bytes);
  sock.ev.emit("messages.upsert", {
    type: "append",
    messages: [{ key: { remoteJid: ANA, fromMe: false, id: "H1" }, message: pdf(bytes), messageTimestamp: Math.floor(Date.now() / 1000) }],
  });
  await settled(svc);
  assert.equal(keptPath(svc, sid), undefined, "only a live arrival is downloaded on its own");
  const first = (await call("get_media", { message_id: sid, save_to: saveTo })).structuredContent;
  assert.equal(first.source, "whatsapp");
  assert.ok(keptPath(svc, sid), "what get_media downloaded is kept");
  state.expired = true;
  const second = (await call("get_media", { message_id: sid, save_to: saveTo })).structuredContent;
  assert.equal(second.source, "kept");
  assert.deepEqual(readFileSync(second.path), bytes);
});

test("a transcript is made from the kept copy, with the link down and WhatsApp's copy gone", async (t) => {
  const keys = ["WAZAP_TRANSCRIBE", "WAZAP_TRANSCRIBE_API_KEY", "WAZAP_TRANSCRIBE_AUTO", "WAZAP_TRANSCRIBE_ALLOW_API", "OPENAI_API_KEY"];
  const saved = keys.map((key) => [key, process.env[key]]);
  Object.assign(process.env, { WAZAP_TRANSCRIBE: "openai", WAZAP_TRANSCRIBE_API_KEY: "sk-test-key", WAZAP_TRANSCRIBE_AUTO: "0" });
  let ctx;
  try {
    ctx = await setup(t, { config: { readOnly: false } });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const { svc, arrive, state } = ctx;
  const ogg = Buffer.from("OggS voice for whisper");
  const sid = arrive(ANA, voice(ogg), ogg);
  await keptOf(svc, sid);
  let heard = null;
  svc.transcriber = async (_settings, file) => {
    heard = readFileSync(file);
    return { text: "ne vedem la 5", language: "ro", duration_seconds: 3 };
  };
  state.expired = true;
  svc.status = "disconnected";
  svc.sockClient = null;
  const result = await svc.transcribeAudio(sid);
  assert.equal(result.text, "ne vedem la 5");
  assert.deepEqual(heard, ogg, "the provider was handed the kept bytes");
  assert.equal(state.downloads, 1, "only the arrival downloaded");
});

// --- which media --------------------------------------------------------------

test("unmuted keeps no muted chat, unless it is listed", async (t) => {
  const { svc, arrive } = await setup(t, { env: { WAZAP_MEDIA_KEEP_CHATS: BOB } });
  // The chats exist once a message landed; mute them the way a chat update does.
  arrive(ANA, { conversation: "salut" });
  arrive(BOB, { conversation: "salut" });
  const sock = svc.sockClient;
  sock.ev.emit("chats.update", [{ id: ANA, muteEndTime: Date.now() + 3_600_000 }, { id: BOB, muteEndTime: Date.now() + 3_600_000 }]);
  await waitFor(() => svc.db.identity.chat(ANA)?.mutedUntil > Date.now() && svc.db.identity.chat(BOB)?.mutedUntil > Date.now(), 2000, "the mutes");
  const muted = arrive(ANA, photo(Buffer.from("muted photo")), Buffer.from("muted photo"));
  const listed = arrive(BOB, photo(Buffer.from("listed photo")), Buffer.from("listed photo"));
  await keptOf(svc, listed);
  await settled(svc);
  assert.equal(keptPath(svc, muted), undefined, "a muted chat's photo is not kept");
});

test("chats keeps only the listed chats, and all keeps every chat", async (t) => {
  const listedOnly = await setup(t, { env: { WAZAP_MEDIA_KEEP: "chats", WAZAP_MEDIA_KEEP_CHATS: "+40700000002" } });
  const a = listedOnly.arrive(ANA, photo(Buffer.from("a")), Buffer.from("a"));
  const b = listedOnly.arrive(BOB, photo(Buffer.from("b")), Buffer.from("b"));
  await keptOf(listedOnly.svc, a);
  await settled(listedOnly.svc);
  assert.equal(keptPath(listedOnly.svc, b), undefined);

  const every = await setup(t, { env: { WAZAP_MEDIA_KEEP: "all" } });
  every.svc.sockClient.ev.emit("chats.update", [{ id: BOB, muteEndTime: Date.now() + 3_600_000 }]);
  const c = every.arrive(BOB, photo(Buffer.from("c")), Buffer.from("c"));
  await keptOf(every.svc, c);
});

test("only the chosen types are kept; video is not by default, and view-once never", async (t) => {
  const { svc, arrive } = await setup(t, { env: { WAZAP_MEDIA_KEEP_TYPES: "image,video" } });
  const clip = arrive(ANA, video(Buffer.from("mp4")), Buffer.from("mp4"));
  const note = arrive(ANA, voice(Buffer.from("ogg")), Buffer.from("ogg"));
  const once = arrive(ANA, { viewOnceMessageV2: { message: photo(Buffer.from("secret")) } }, Buffer.from("secret"));
  await keptOf(svc, clip);
  await settled(svc);
  assert.equal(keptPath(svc, note), undefined, "voice was not chosen");
  assert.equal(keptPath(svc, once), undefined, "a view-once photo is never kept");

  const defaults = await setup(t);
  const defaultClip = defaults.arrive(ANA, video(Buffer.from("mp4")), Buffer.from("mp4"));
  await settled(defaults.svc);
  assert.equal(keptPath(defaults.svc, defaultClip), undefined);
});

test("stories and media of other kinds are not kept", async (t) => {
  const { svc, arrive } = await setup(t, { env: { WAZAP_MEDIA_KEEP: "all" } });
  const story = arrive("status@broadcast", photo(Buffer.from("story")), Buffer.from("story"));
  await settled(svc);
  assert.equal(svc.hasMessage(story) ? keptPath(svc, story) : undefined, undefined);
});

// --- limits -------------------------------------------------------------------

test("a file over the size limit is not kept, whether it says so or not", async (t) => {
  const { svc, arrive, state } = await setup(t, { env: { WAZAP_MEDIA_KEEP_MAX_MB: "1" } });
  const big = Buffer.alloc(MB + 1, 1);
  const declared = arrive(ANA, photo(big), big);
  const understated = arrive(ANA, photo(big, { fileLength: 10 }), big);
  await settled(svc);
  assert.equal(keptPath(svc, declared), undefined);
  assert.equal(keptPath(svc, understated), undefined);
  assert.equal(state.downloads, 1, "a declared size over the limit is not even downloaded");
});

test("past the quota the oldest kept files go, from the database and from the disk", async (t) => {
  const { svc, arrive } = await setup(t, { env: { WAZAP_MEDIA_KEEP_QUOTA_MB: "1" } });
  const part = Buffer.alloc(400 * 1024, 7);
  const sids = [];
  for (let i = 0; i < 3; i++) {
    const bytes = Buffer.concat([part, Buffer.from([i])]);
    const sid = arrive(ANA, photo(bytes), bytes);
    sids.push(sid);
    await keptOf(svc, sid);
    // created_at orders eviction; keep them apart.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await settled(svc);
  const files = readdirSync(svc.paths.keptDir);
  assert.equal(keptPath(svc, sids[0]), undefined, "the oldest went");
  assert.ok(keptPath(svc, sids[1]) && keptPath(svc, sids[2]), "the newer two stay");
  assert.equal(files.length, 2, "and so did its file");
  const total = files.reduce((sum, name) => sum + readFileSync(join(svc.paths.keptDir, name)).length, 0);
  assert.ok(total <= MB, `${total} bytes kept under a 1 MB quota`);
});

test("nothing is written onto a nearly full disk", async (t) => {
  const { svc, arrive } = await setup(t);
  svc.keep.host.diskSpace = async () => ({ free: 10 * MB, total: 100 * MB });
  const sid = arrive(ANA, photo(Buffer.alloc(6 * MB, 1)), Buffer.alloc(6 * MB, 1));
  await settled(svc);
  assert.equal(keptPath(svc, sid), undefined, "10 MB free of 100 MB leaves less than the 5% reserve after 6 MB");
  svc.keep.host.diskSpace = async () => ({ free: 50 * MB, total: 100 * MB });
  const next = arrive(ANA, photo(Buffer.alloc(6 * MB, 2)), Buffer.alloc(6 * MB, 2));
  await keptOf(svc, next);
});

test("a download that does not match the sender's hash is not kept, and a kept file that stops matching is not served", async (t) => {
  const { svc, call, arrive, state, saveTo } = await setup(t);
  const good = Buffer.from("the real photo");
  const wrong = arrive(ANA, photo(good, { fileSha256: sha(Buffer.from("something else")) }), good);
  const right = arrive(ANA, photo(good, { fileSha256: sha(good) }), good);
  const path = await keptOf(svc, right);
  await settled(svc);
  assert.equal(keptPath(svc, wrong), undefined);

  writeFileSync(path, "tampered");
  const out = (await call("get_media", { message_id: right, save_to: saveTo })).structuredContent;
  assert.equal(out.source, "whatsapp", "WhatsApp is asked instead");
  assert.deepEqual(readFileSync(out.path), good);
  assert.ok(state.downloads >= 2);
});

// --- a file never outlives its message ----------------------------------------

test("a message deleted for everyone takes its kept file with it", async (t) => {
  const { svc, sock, arrive } = await setup(t);
  const bytes = Buffer.from("deleted photo");
  const sid = arrive(ANA, photo(bytes), bytes);
  const path = await keptOf(svc, sid);
  const id = sid.split("_").at(-1);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{
      key: { remoteJid: ANA, fromMe: false, id: "REVOKE1" },
      message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { remoteJid: ANA, fromMe: false, id } } },
      messageTimestamp: Math.floor(Date.now() / 1000),
    }],
  });
  await waitFor(() => !svc.hasMessage(sid), 2000, "the delete");
  await waitFor(async () => {
    await svc.storage.fileWork;
    return !existsSync(path);
  }, 3000, "the kept file to go");
});

test("an account that keeps no history keeps no media, and a short-lived command downloads nothing", async (t) => {
  const noHistory = await setup(t, { config: { persistHistory: false } });
  const a = noHistory.arrive(ANA, photo(Buffer.from("x")), Buffer.from("x"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(noHistory.state.downloads, 0);
  assert.equal(noHistory.svc.hasMessage(a) ? keptPath(noHistory.svc, a) : undefined, undefined);

  const shortLived = await setup(t, { config: { command: "status" } });
  shortLived.arrive(ANA, photo(Buffer.from("y")), Buffer.from("y"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(shortLived.state.downloads, 0);
});

// --- restarts -----------------------------------------------------------------

test("kept media survives a restart; what a crash left is cleaned up, and a vanished file is forgotten", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-kept-restart-"));
  const first = await setup(t, { dataDir });
  const bytes = Buffer.from("kept across restarts");
  const sid = first.arrive(ANA, photo(bytes), bytes);
  const gone = first.arrive(ANA, photo(Buffer.from("gone")), Buffer.from("gone"));
  const path = await keptOf(first.svc, sid);
  const gonePath = await keptOf(first.svc, gone);
  await first.svc.stop();

  // A crash mid-write, a file nobody recorded, and a file someone deleted by hand.
  const keptDir = accountPaths(dataDir, "default").keptDir;
  writeFileSync(join(keptDir, "1-abcdef01.jpeg.part"), "half");
  writeFileSync(join(keptDir, "2-abcdef02.jpeg"), "orphan");
  const { rmSync } = await import("node:fs");
  rmSync(gonePath);

  const second = await setup(t, { dataDir });
  second.state.expired = true;
  assert.deepEqual(readdirSync(keptDir).sort(), [path.split("/").at(-1)], "only the recorded file stays");
  const out = (await second.call("get_media", { message_id: sid, save_to: second.saveTo })).structuredContent;
  assert.equal(out.source, "kept");
  assert.deepEqual(readFileSync(out.path), bytes);
  const missing = await second.call("get_media", { message_id: gone, save_to: second.saveTo });
  assert.equal(textError(missing).error, "MEDIA_UNAVAILABLE", "a vanished file falls back to WhatsApp, which has it no more");
  assert.equal(keptPath(second.svc, gone), undefined, "and its row is forgotten");
});

test("on connecting, media that arrived with nobody keeping it is fetched", async (t) => {
  const { svc, arrive, state } = await setup(t);
  svc.status = "disconnected";
  const bytes = Buffer.from("arrived while down");
  const sid = arrive(ANA, photo(bytes), bytes);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(state.downloads, 0, "no download without the link");
  // A restart loses the in-memory queue; the catch-up does not need it.
  svc.keep.queue.length = 0;
  svc.keep.queued.clear();
  svc.status = "connected";
  svc.keep.connected();
  await keptOf(svc, sid);
});

test("WAZAP_MEDIA_KEEP=off removes what was kept; a setting that does not parse removes nothing", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-kept-off-"));
  const first = await setup(t, { dataDir });
  const sid = first.arrive(ANA, photo(Buffer.from("p")), Buffer.from("p"));
  const path = await keptOf(first.svc, sid);
  await first.svc.stop();

  const typo = await setup(t, { dataDir, env: { WAZAP_MEDIA_KEEP: "of" } });
  await typo.svc.storage.fileWork;
  assert.ok(existsSync(path), "a typo deletes nothing");
  assert.ok(keptPath(typo.svc, sid));
  // Still served: a copy kept is served until something removes it.
  typo.state.expired = true;
  assert.equal((await typo.call("get_media", { message_id: sid, save_to: typo.saveTo })).structuredContent.source, "kept");
  await typo.svc.stop();

  const off = await setup(t, { dataDir, env: { WAZAP_MEDIA_KEEP: "off" } });
  await off.svc.storage.fileWork;
  assert.equal(existsSync(path), false, "off removes the kept copies");
  assert.equal(keptPath(off.svc, sid), undefined);
});

test("files past their age go at the next start", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-kept-age-"));
  const first = await setup(t, { dataDir });
  const sid = first.arrive(ANA, photo(Buffer.from("old")), Buffer.from("old"));
  const path = await keptOf(first.svc, sid);
  await first.svc.stop();

  const settings = { ...mediaKeepSettings({}), maxAgeMs: 1 };
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await setup(t, { dataDir, config: { mediaKeep: settings } });
  await second.svc.storage.fileWork;
  assert.equal(keptPath(second.svc, sid), undefined);
  assert.equal(existsSync(path), false);
});

test("a row pointing outside the kept folder is neither read nor unlinked", async (t) => {
  const { svc, call, arrive, state, saveTo } = await setup(t, { env: { WAZAP_MEDIA_KEEP: "off" } });
  const bytes = Buffer.from("whatsapp copy");
  const sid = arrive(ANA, photo(bytes), bytes);
  const outside = join(mkdtempSync(join(tmpdir(), "wazap-kept-outside-")), "secret.txt");
  writeFileSync(outside, "not yours");
  svc.db.messages.setMedia(sid, "original", outside);
  const out = (await call("get_media", { message_id: sid, save_to: saveTo })).structuredContent;
  assert.equal(out.source, "whatsapp");
  assert.deepEqual(readFileSync(out.path), bytes);
  assert.equal(state.downloads, 1);
  svc.db.messages.dropMedia("original", [outside]);
  await svc.storage.scheduleFileCleanup();
  assert.ok(existsSync(outside), "a released path outside wazap's folders is never unlinked");
});

test("openService builds a keeper even with no kept-media config", () => {
  const svc = openService(WhatsAppService, {
    dataDir: mkdtempSync(join(tmpdir(), "wazap-kept-none-")),
    readOnly: true, syncFullHistory: false, persistHistory: true, transport: "stdio", httpHost: "127.0.0.1",
    httpPort: 8766, readToken: null, writeToken: null, rateLimitPerMinute: 20, command: "serve", loginCode: false, loginQr: false,
  });
  assert.equal(svc.keep.active, false);
  return svc.stop();
});

// --- review findings ----------------------------------------------------------

test("a data dir that moved, or is reached through a symlink, keeps its kept files", async (t) => {
  const { renameSync, symlinkSync } = await import("node:fs");
  const parent = mkdtempSync(join(tmpdir(), "wazap-kept-move-"));
  const before = join(parent, "a");
  (await import("node:fs")).mkdirSync(before);
  const first = await setup(t, { dataDir: before });
  const bytes = Buffer.from("survives the move");
  const sid = first.arrive(ANA, photo(bytes), bytes);
  await keptOf(first.svc, sid);
  await first.svc.stop();

  const after = join(parent, "b");
  renameSync(before, after);
  const moved = await setup(t, { dataDir: after });
  moved.state.expired = true;
  const out = (await moved.call("get_media", { message_id: sid, save_to: moved.saveTo })).structuredContent;
  assert.equal(out.source, "kept", "found in the kept folder where the data dir is now");
  assert.deepEqual(readFileSync(out.path), bytes);
  assert.ok(keptPath(moved.svc, sid).startsWith(join(after, "accounts")), "and the record follows it");
  await moved.svc.stop();

  const link = join(parent, "link");
  symlinkSync(after, link);
  const linked = await setup(t, { dataDir: link });
  linked.state.expired = true;
  assert.equal((await linked.call("get_media", { message_id: sid, save_to: linked.saveTo })).structuredContent.source, "kept");
  assert.equal(readdirSync(join(after, "accounts", "default", "kept")).length, 1, "nothing was swept");
});

test("the start-up sweep removes only files named the way wazap names them", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-kept-sweep-"));
  const first = await setup(t, { dataDir });
  const sid = first.arrive(ANA, photo(Buffer.from("k")), Buffer.from("k"));
  await keptOf(first.svc, sid);
  await first.svc.stop();
  const keptDir = accountPaths(dataDir, "default").keptDir;
  const { mkdirSync } = await import("node:fs");
  writeFileSync(join(keptDir, "my-notes.txt"), "the user's own file");
  mkdirSync(join(keptDir, "1700000000000-abcdef01.jpeg"));
  writeFileSync(join(keptDir, "1700000000000-abcdef02.jpeg"), "orphan");
  await setup(t, { dataDir });
  const left = readdirSync(keptDir).sort();
  assert.ok(left.includes("my-notes.txt"), "a file wazap does not name is left alone");
  assert.ok(left.includes("1700000000000-abcdef01.jpeg"), "so is a directory");
  assert.ok(!left.includes("1700000000000-abcdef02.jpeg"), "an unrecorded kept file goes");
});

test("a short-lived command with keeping off neither removes nor sweeps", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-kept-cli-"));
  const first = await setup(t, { dataDir });
  const sid = first.arrive(ANA, photo(Buffer.from("cli")), Buffer.from("cli"));
  const path = await keptOf(first.svc, sid);
  await first.svc.stop();
  const keptDir = accountPaths(dataDir, "default").keptDir;
  writeFileSync(join(keptDir, "1700000000000-abcdef03.jpeg"), "orphan");
  const cli = await setup(t, { dataDir, env: { WAZAP_MEDIA_KEEP: "off" }, config: { command: "status" } });
  await cli.svc.storage.fileWork;
  assert.ok(existsSync(path));
  assert.ok(existsSync(join(keptDir, "1700000000000-abcdef03.jpeg")));
  assert.ok(keptPath(cli.svc, sid));
});

test("the catch-up pages past media it does not want", async (t) => {
  const { svc, arrive, state } = await setup(t, { env: { WAZAP_MEDIA_KEEP: "chats", WAZAP_MEDIA_KEEP_CHATS: ANA } });
  svc.status = "disconnected";
  const wanted = arrive(ANA, photo(Buffer.from("wanted")), Buffer.from("wanted"));
  for (let i = 0; i < 210; i++) arrive(BOB, photo(Buffer.from(`n${i}`)), Buffer.from(`n${i}`));
  svc.keep.queue.length = 0;
  svc.keep.queued.clear();
  svc.status = "connected";
  svc.keep.connected();
  await keptOf(svc, wanted);
  await settled(svc);
  assert.equal(state.downloads, 1, "only the wanted photo was downloaded");
});

test("what a full queue turned away is caught up once the queue drains", async (t) => {
  const { svc, arrive } = await setup(t);
  svc.status = "disconnected";
  const sids = [];
  for (let i = 0; i < 205; i++) sids.push(arrive(ANA, photo(Buffer.from(`q${i}`)), Buffer.from(`q${i}`)));
  assert.equal(svc.keep.queue.length, 200);
  svc.status = "connected";
  svc.keep.kick();
  await waitFor(() => sids.every((sid) => keptPath(svc, sid)), 20000, "all 205 kept");
});

test("a download that failed on the way is tried again; one WhatsApp no longer has is not", async (t) => {
  const { svc, arrive, state } = await setup(t);
  const bytes = Buffer.from("flaky");
  let failNext = true;
  const real = svc.mediaBuffer;
  svc.mediaBuffer = async (...args) => {
    if (failNext) {
      failNext = false;
      state.downloads++;
      throw new WazapError("MEDIA_UNAVAILABLE", "Could not download: socket hang up");
    }
    return real(...args);
  };
  const flaky = arrive(ANA, photo(bytes), bytes);
  await settled(svc);
  assert.equal(keptPath(svc, flaky), undefined);
  svc.keep.connected();
  await keptOf(svc, flaky);

  const goneBytes = Buffer.from("gone");
  svc.mediaBuffer = async () => {
    state.downloads++;
    const err = new WazapError("MEDIA_UNAVAILABLE", "Could not download: 410");
    Object.defineProperty(err, "cause", { value: { output: { statusCode: 410 } } });
    throw err;
  };
  const gone = arrive(ANA, photo(goneBytes), goneBytes);
  await settled(svc);
  const tries = state.downloads;
  svc.keep.connected();
  await settled(svc);
  assert.equal(state.downloads, tries, "expired media is not asked for again");
  assert.equal(keptPath(svc, gone), undefined);
});

test("nothing kept is evicted for a file that is then not written", async (t) => {
  const { svc, arrive } = await setup(t, { env: { WAZAP_MEDIA_KEEP_QUOTA_MB: "1" } });
  const old = Buffer.alloc(700 * 1024, 1);
  const first = arrive(ANA, photo(old), old);
  await keptOf(svc, first);
  svc.keep.host.diskSpace = async () => ({ free: 1 * MB, total: 100 * MB });
  const next = Buffer.alloc(700 * 1024, 2);
  const second = arrive(ANA, photo(next), next);
  await settled(svc);
  assert.equal(keptPath(svc, second), undefined);
  assert.ok(keptPath(svc, first), "the older file was not given up for nothing");
});

test("channels are kept only when listed, and media flagged view-once never", async (t) => {
  const CHANNEL = "120363000000000099@newsletter";
  const plain = await setup(t, { env: { WAZAP_MEDIA_KEEP: "all" } });
  const fromChannel = plain.arrive(CHANNEL, photo(Buffer.from("ch")), Buffer.from("ch"));
  const flagged = plain.arrive(ANA, photo(Buffer.from("vo"), { viewOnce: true }), Buffer.from("vo"));
  const normal = plain.arrive(ANA, photo(Buffer.from("ok")), Buffer.from("ok"));
  await keptOf(plain.svc, normal);
  await settled(plain.svc);
  assert.ok(plain.svc.hasMessage(fromChannel));
  assert.equal(keptPath(plain.svc, fromChannel), undefined, "all keeps conversations, not channels");
  assert.equal(keptPath(plain.svc, flagged), undefined);

  const listed = await setup(t, { env: { WAZAP_MEDIA_KEEP_CHATS: CHANNEL } });
  const kept = listed.arrive(CHANNEL, photo(Buffer.from("ch2")), Buffer.from("ch2"));
  assert.ok(listed.svc.hasMessage(kept), "a channel post is stored");
  await keptOf(listed.svc, kept);
});

test("the hourly sweep applies the age limit while the server runs", async (t) => {
  const { svc, arrive } = await setup(t, { config: { mediaKeep: { ...mediaKeepSettings({}), maxAgeMs: 200 } } });
  const sid = arrive(ANA, photo(Buffer.from("aging")), Buffer.from("aging"));
  const path = await keptOf(svc, sid);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await svc.keep.sweep();
  await svc.storage.fileWork;
  assert.equal(keptPath(svc, sid), undefined);
  assert.equal(existsSync(path), false);
});

test("the worker never asks WhatsApp for more than a kept file may hold", async (t) => {
  const { svc, arrive, state } = await setup(t, { env: { WAZAP_MEDIA_KEEP_MAX_MB: "2" } });
  const caps = [];
  const real = svc.mediaBuffer;
  svc.mediaBuffer = async (sock, sid, raw, maxBytes) => {
    caps.push(maxBytes);
    return real(sock, sid, raw, maxBytes);
  };
  const sid = arrive(ANA, photo(Buffer.from("c")), Buffer.from("c"));
  await keptOf(svc, sid);
  assert.deepEqual(caps, [2 * MB]);
  assert.equal(state.downloads, 1);
});

test("pointing a row at the moved data dir releases nothing", async (t) => {
  const { svc, arrive } = await setup(t, { env: { WAZAP_MEDIA_KEEP: "off" } });
  const sid = arrive(ANA, photo(Buffer.from("r")), Buffer.from("r"));
  // The same file under another spelling, as a case-insensitive disk would see it.
  const old = join(svc.paths.keptDir.toUpperCase(), "1700000000000-abcdef04.jpeg");
  svc.db.messages.setMedia(sid, "original", old);
  assert.equal(svc.db.messages.rehomeMedia("original", old, join(svc.paths.keptDir, "1700000000000-abcdef04.jpeg")), 1);
  assert.deepEqual(storageRows(svc, "SELECT path FROM pending_unlinks"), [], "a rehome is the same file, never a release");
});

test("a file bigger than the whole quota is not downloaded again and again", async (t) => {
  const { svc, arrive, state } = await setup(t, { env: { WAZAP_MEDIA_KEEP_QUOTA_MB: "1", WAZAP_MEDIA_KEEP_MAX_MB: "16" } });
  const big = Buffer.alloc(2 * MB, 3);
  const declared = arrive(ANA, photo(big), big);
  const understated = arrive(ANA, photo(big, { fileLength: 10 }), big);
  svc.mediaBuffer = async (_sock, sid, _raw, maxBytes) => {
    state.downloads++;
    const bytes = state.bytes.get(sid);
    if (maxBytes !== undefined && bytes.length > maxBytes) throw new WazapError("FILE_TOO_LARGE", "over the cap");
    return bytes;
  };
  await settled(svc);
  for (let i = 0; i < 3; i++) {
    svc.keep.connected();
    await settled(svc);
  }
  assert.equal(keptPath(svc, declared), undefined);
  assert.equal(keptPath(svc, understated), undefined);
  assert.ok(state.downloads <= 1, `${state.downloads} downloads for media that can never be kept`);
});
