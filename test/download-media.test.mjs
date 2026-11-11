/**
 * The get_media contract for files: the bytes on disk are the decrypted file, and
 * the structured result says what arrived with it — mime, the caption the
 * sender wrote, the name their file had — so an agent never has to decrypt or
 * guess.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


import sharp from "sharp";

import { WazapError } from "../dist/errors.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools, textError } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";

function setup({ remote = false } = {}) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-dlmedia-", id: ME, name: "Răzvan" });
  const { call } = schemaCheckedTools(svc, { allowWrite: false, ...(remote ? { allowLocalFiles: false } : {}) });
  let seq = 0;
  const arrive = (chat, content, { fromMe = false, participant, at = Date.now() } = {}) => {
    const id = `M${++seq}`;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: chat, fromMe, id, ...(participant ? { participant } : {}) },
          message: content,
          messageTimestamp: Math.floor(at / 1000),
        },
      ],
    });
    return `false_${chat}_${id}`;
  };
  return { svc, sock, call, arrive, saveTo: mkdtempSync(join(tmpdir(), "wazap-dl-")) };
}

test("a group photo lands on disk as usable bytes, with its caption and mime", async () => {
  const { svc, call, arrive, saveTo } = setup();
  const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#884422" } }).jpeg().toBuffer();
  svc.mediaBuffer = async () => jpeg;
  const sid = arrive(
    GROUP,
    { imageMessage: { mimetype: "image/jpeg", fileLength: jpeg.length, caption: "meniul de azi" } },
    { participant: ANA }
  );

  const result = await call("get_media", { message_id: sid, save_to: saveTo });
  const out = result.structuredContent;
  assert.equal(out.mime, "image/jpeg");
  assert.equal(out.size, jpeg.length);
  assert.equal(out.caption, "meniul de azi");
  assert.equal(out.original_filename, null, "a photo's envelope carries no filename");
  assert.equal(out.message_id, sid);
  assert.ok(out.path.startsWith(saveTo), "saved under the requested directory");
  assert.ok(out.filename.endsWith(".jpeg"), "the saved name keeps the extension");
  assert.deepEqual(readFileSync(out.path), jpeg, "the decrypted bytes round-trip");
  assert.equal("inline_base64" in out, false, "the inline copy is a content block, not a field");
  assert.equal(result.content[1].type, "image", "the photo also comes back as an image");
  assert.equal(result.content[1].mimeType, "image/jpeg");
  assert.deepEqual(out.view, { kind: "image", width: 640, height: 480, detail: "standard", original_width: 640, original_height: 480 });
  assert.equal(out.image_attached, true);
});

test("a document reports its caption and the sender's own filename", async () => {
  const { svc, call, arrive, saveTo } = setup();
  const pdf = Buffer.from("%PDF-1.4 fake");
  svc.mediaBuffer = async () => pdf;
  const sid = arrive(ANA, {
    documentMessage: { mimetype: "application/pdf", fileName: "factura.pdf", fileLength: pdf.length, caption: "plata" },
  });

  const result = await call("get_media", { message_id: sid, save_to: saveTo });
  const out = result.structuredContent;
  assert.equal(out.mime, "application/pdf");
  assert.equal(out.caption, "plata");
  assert.equal(out.original_filename, "factura.pdf");
  assert.ok(out.filename.endsWith(".pdf"), "the saved name keeps the sender's extension");
  assert.deepEqual(readFileSync(out.path), pdf);
  assert.equal(result.content.length, 1, "a document is never inlined");
});

test("a document with no caption reports null, and so does audio", async () => {
  const { svc, call, arrive, saveTo } = setup();
  const pdf = Buffer.from("%PDF-1.4 fake");
  const ogg = Buffer.from("OggS fake audio");
  svc.mediaBuffer = async () => pdf;
  const docSid = arrive(ANA, {
    documentMessage: { mimetype: "application/pdf", fileName: "orar.pdf", fileLength: pdf.length },
  });

  const doc = (await call("get_media", { message_id: docSid, save_to: saveTo })).structuredContent;
  assert.equal(doc.caption, null, "the filename under the tag is not a caption");
  assert.equal(doc.original_filename, "orar.pdf");

  svc.mediaBuffer = async () => ogg;
  const audioSid = arrive(ANA, {
    audioMessage: { mimetype: "audio/ogg; codecs=opus", fileLength: ogg.length, seconds: 7 },
  });
  const audio = (await call("get_media", { message_id: audioSid, save_to: saveTo })).structuredContent;
  assert.equal(audio.caption, null, "audio cannot carry a caption");
  assert.equal(audio.transcript_unavailable, undefined, "save_to asks for the file, and no transcript is attempted");
  assert.equal(audio.original_filename, null);
  assert.deepEqual(readFileSync(audio.path), ogg);
});

test("a message without media is MEDIA_UNAVAILABLE, not a file of nothing", async () => {
  const { call, arrive, saveTo } = setup();
  const sid = arrive(ANA, { conversation: "doar text" });
  const result = await call("get_media", { message_id: sid, save_to: saveTo });
  assert.equal(textError(result).error, "MEDIA_UNAVAILABLE");
});

test("a voice note in an unmapped lid chat downloads by its raw id, sender honestly unresolved", async () => {
  const { svc, call, arrive, saveTo } = setup();
  const LID = "4226298167515@lid";
  const ogg = Buffer.from("OggS fake voice");
  svc.mediaBuffer = async () => ogg;
  const sid = arrive(LID, {
    audioMessage: { mimetype: "audio/ogg; codecs=opus", fileLength: ogg.length, seconds: 4, ptt: true },
  });

  const out = (await call("get_media", { message_id: sid, save_to: saveTo })).structuredContent;
  assert.equal(out.mime, "audio/ogg; codecs=opus");
  assert.deepEqual(readFileSync(out.path), ogg, "the attachment came down even with no identity behind it");
  assert.equal(out.sender.id, LID, "the sender stays the unpaired lid");
  assert.equal(out.sender.phone, null);
  assert.equal(out.sender.is_saved, false);
  assert.equal(out.sender.name_source, "none");
  assert.match(out.sender.name, /^unknown \(lid …7515\)$/);
});

test("a message filed under the paired number answers to its raw lid id", async () => {
  const { svc, sock, call, arrive, saveTo } = setup();
  const LID = "999888777666555@lid";
  const OWNER = "40700000007@s.whatsapp.net";
  sock.fetchStatus = async () => [];
  sock.profilePictureUrl = async () => null;
  // The pairing lands first, so the arrival files under the number.
  sock.ev.emit("lid-mapping.update", { lid: LID, pn: OWNER });
  const ogg = Buffer.from("OggS mapped");
  svc.mediaBuffer = async () => ogg;
  const lidSid = arrive(LID, { audioMessage: { mimetype: "audio/ogg", fileLength: ogg.length } });
  const stanza = lidSid.split("_").at(-1);
  assert.equal(svc.db.messages.get(lidSid).sid, `false_${OWNER}_${stanza}`, "the database files it under the number");

  const out = (await call("get_media", { message_id: lidSid, save_to: saveTo })).structuredContent;
  assert.equal(out.mime, "audio/ogg");
  assert.deepEqual(readFileSync(out.path), ogg);
  assert.equal(out.sender.id, OWNER, "the sender resolves through the same pairing");
});

test("get_message answers the id a view reports after the lid pairs with a number", async () => {
  const { svc, sock, call, arrive } = setup();
  const LID = "999888777666555@lid";
  const OWNER = "40700000007@s.whatsapp.net";
  const sid = arrive(LID, { conversation: "de pe lid" });
  sock.ev.emit("lid-mapping.update", { lid: LID, pn: OWNER });
  // The message was filed under the lid; the id read_messages now reports is the number's.
  const reported = `false_${OWNER}_${sid.split("_").at(-1)}`;
  assert.equal((await svc.readMessages(OWNER, 5)).data[0].message_id, reported);

  const out = (await call("get_message", { message_id: reported })).structuredContent;
  assert.equal(out.text, "de pe lid");
  assert.equal(out.sender.id, OWNER);
});

test("the saved file lands in the media dir when save_to is omitted", async () => {
  const { svc, call, arrive } = setup();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  svc.mediaBuffer = async () => jpeg;
  const sid = arrive(ANA, { imageMessage: { mimetype: "image/jpeg", fileLength: jpeg.length } });
  const out = (await call("get_media", { message_id: sid })).structuredContent;
  assert.ok(out.path.startsWith(svc.paths.mediaDir));
  assert.ok(existsSync(out.path));
});

test("a voice note comes back as its transcript without a file; with save_to as its file, and a transcript only if one is on hand", async () => {
  const { svc, call, arrive, saveTo } = setup();
  const ogg = Buffer.from("OggS spoken");
  let downloads = 0;
  svc.mediaBuffer = async () => {
    downloads++;
    return ogg;
  };
  const sid = arrive(ANA, { audioMessage: { mimetype: "audio/ogg; codecs=opus", fileLength: ogg.length, seconds: 6, ptt: true } });
  const asked = [];
  const transcribe = svc.transcribeAudio.bind(svc);
  svc.transcribeAudio = async (id, language, opts = {}) => {
    asked.push(opts);
    if (opts.cachedOnly) return transcribe(id, language, opts);
    return { text: "ajung la 7", language: "ro", duration_seconds: 6, provider: "local", cached: false };
  };

  // Nothing is on hand yet: save_to brings the file, makes no transcript and says nothing is missing.
  const saved = await call("get_media", { message_id: sid, save_to: saveTo });
  assert.deepEqual(readFileSync(saved.structuredContent.path), ogg);
  assert.equal(saved.structuredContent.transcript, undefined);
  assert.equal(saved.structuredContent.transcript_unavailable, undefined);
  assert.deepEqual(asked, [{ cachedOnly: true }], "save_to never starts a transcription");

  const heard = await call("get_media", { message_id: sid });
  assert.equal(heard.structuredContent.transcript.text, "ajung la 7");
  assert.equal(heard.structuredContent.path, undefined, "a transcript is the answer; nothing was saved");
  assert.equal(downloads, 1);
  assert.match(heard.content[0].text, /Transcribed 0:06 \(ro, local\): "ajung la 7"/);
  assert.equal(typeof asked[1].limit?.take, "function", "a transcription asked for spends the bucket, when a provider runs");

  svc.db.messages.setTranscript(sid, "ajung la 7", { language: "ro", duration_seconds: 6, provider: "local", at: Date.now() });
  const kept = (await call("get_media", { message_id: sid, save_to: saveTo })).structuredContent;
  assert.equal(kept.transcript.text, "ajung la 7");
  assert.equal(kept.transcript.cached, true);
  assert.deepEqual(readFileSync(kept.path), ogg);
});

test("a recording whose transcription fails, times out or is over its limit still comes as its file, saying why there is no transcript", async () => {
  const { svc, call, arrive } = setup();
  const ogg = Buffer.from("OggS spoken");
  svc.mediaBuffer = async () => ogg;
  for (const [code, type] of [
    ["TRANSCRIBE_FAILED", "voice"],
    ["TIMEOUT", "audio"],
    ["RATE_LIMITED", "voice"],
  ]) {
    const sid = arrive(ANA, { audioMessage: { mimetype: "audio/ogg; codecs=opus", fileLength: ogg.length, seconds: 6, ptt: type === "voice" } });
    svc.transcribeAudio = async () => {
      throw new WazapError(code, `${code} here`);
    };
    const result = await call("get_media", { message_id: sid });
    assert.equal(result.isError, undefined, code);
    assert.equal(result.structuredContent.type, type);
    assert.deepEqual(result.structuredContent.transcript_unavailable, { code, message: `${code} here` });
    assert.deepEqual(readFileSync(result.structuredContent.path), ogg, `${code}: the file stands in for the transcript`);
  }
});

/** The structured answer and the attached view of get_media on an image of these bytes. */
async function viewOf(bytes, mimetype, args = {}, envelope = "imageMessage") {
  const { svc, call, arrive } = setup();
  svc.mediaBuffer = async () => bytes;
  const sid = arrive(ANA, { [envelope]: { mimetype, fileLength: bytes.length } });
  const result = await call("get_media", { message_id: sid, ...args });
  const block = result.content.find((item) => item.type === "image");
  const picture = block === undefined ? null : Buffer.from(block.data, "base64");
  const meta = picture === null ? null : await sharp(picture).metadata();
  return { result, out: result.structuredContent, block, picture, meta };
}

/** A photo that does not compress well: noise, the worst case for a byte budget. */
async function noisyPhoto(width, height) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 2654435761) >>> 24;
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

test("an HD photo comes back as a 1024 px view within the byte budget, not its original", async () => {
  const photo = await noisyPhoto(4000, 3000);
  assert.ok(photo.length > 1_000_000, "the original is over a megabyte");
  const { out, block, meta, picture } = await viewOf(photo, "image/jpeg");
  assert.deepEqual([meta.format, meta.width, meta.height], ["jpeg", 1024, 768]);
  assert.ok(picture.length <= 110_000, `${picture.length} bytes`);
  assert.ok(block.data.length < 150_000, `base64 fits a hosted client's tool result: ${block.data.length} chars`);
  assert.deepEqual(out.view, { kind: "image", width: 1024, height: 768, detail: "standard", original_width: 4000, original_height: 3000 });
  assert.equal(out.size, photo.length, "size is the original's");
});

test("detail high is 2048 px for small print, within its larger budget", async () => {
  const photo = await noisyPhoto(4000, 3000);
  const { out, meta, picture } = await viewOf(photo, "image/jpeg", { detail: "high" });
  assert.deepEqual([meta.width, meta.height], [2048, 1536]);
  assert.ok(picture.length <= 1_500_000, `${picture.length} bytes`);
  assert.equal(out.view.detail, "high");
});

test("a transparent PNG screenshot is viewed on white; a small image is never enlarged", async () => {
  const png = await sharp({ create: { width: 600, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const { out, meta, picture } = await viewOf(png, "image/png", {}, "documentMessage");
  assert.deepEqual([meta.format, meta.width, meta.height], ["jpeg", 600, 300]);
  const { data } = await sharp(picture).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 240, "white, not black");
  assert.equal(out.view.original_width, 600);
});

test("an animated GIF and a WebP sticker are shown by their first frame", async () => {
  const frames = [];
  for (let i = 0; i < 4; i++) frames.push(await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: i * 60, g: 90, b: 90 } } }).png().toBuffer());
  const gif = await sharp(frames, { join: { animated: true } }).gif().toBuffer();
  const animated = await viewOf(gif, "image/gif", {}, "documentMessage");
  assert.deepEqual([animated.meta.width, animated.meta.height], [64, 48], "one frame, not the strip");
  assert.equal(animated.out.view.frames, 4);
  const { data } = await sharp(animated.picture).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] < 20, `the first frame's colour: ${data[0]}`);

  const webp = await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 10, g: 200, b: 10, alpha: 0.5 } } }).webp().toBuffer();
  const sticker = await viewOf(webp, "image/webp", {}, "stickerMessage");
  assert.equal(sticker.out.type, "sticker");
  assert.deepEqual([sticker.meta.format, sticker.meta.width], ["jpeg", 512]);
});

test("a long screenshot is cut into strips side by side, drawn larger than fitting it whole", async () => {
  // A scrolling chat screenshot: lines of text down a 1170x6000 page.
  const lines = Array.from({ length: 124 }, (_, i) => `<text x="20" y="${40 + i * 48}" font-size="34" font-family="Helvetica">Rândul ${i}: ajung la 7 cu actele</text>`);
  const tall = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1170" height="6000"><rect width="100%" height="100%" fill="white"/>${lines.join("")}</svg>`)).png().toBuffer();
  const { out, block, meta, result } = await viewOf(tall, "image/png", {}, "imageMessage");
  assert.equal(out.view.strips, 2);
  assert.equal(out.view.strip_layout, "columns");
  assert.deepEqual([out.view.original_width, out.view.original_height], [1170, 6000]);
  assert.ok(meta.width > meta.height * 0.6, `${meta.width}x${meta.height}: two strips side by side, not a sliver`);
  assert.ok(Math.max(meta.width, meta.height) <= 1024);
  // Each strip's width against the original's: larger than the 1024/6000 a whole fit would give.
  const stripScale = (meta.width / 2) / 1170;
  assert.ok(stripScale > (1024 / 6000) * 1.3, `scale ${stripScale.toFixed(3)}`);
  assert.ok(Buffer.from(block.data, "base64").length <= 110_000);
  assert.match(result.content[0].text, /cut into 2 strips placed side by side: read the left one top to bottom, then the next/);

  const wide = await sharp({ create: { width: 6000, height: 1000, channels: 3, background: "#e0e0e0" } }).png().toBuffer();
  const panorama = await viewOf(wide, "image/png", {}, "imageMessage");
  assert.equal(panorama.out.view.strip_layout, "rows");
  assert.ok(panorama.out.view.strips >= 2);

  const sliver = await sharp({ create: { width: 200, height: 60_000, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const thin = await viewOf(sliver, "image/png", {}, "documentMessage");
  assert.ok(thin.out.view.strips <= 6, "a few strips at most");
  assert.ok(Math.max(thin.meta.width, thin.meta.height) <= 1024);

  const phone = await viewOf(await sharp({ create: { width: 1170, height: 2532, channels: 3, background: "#ffffff" } }).png().toBuffer(), "image/png", {}, "imageMessage");
  assert.equal(phone.out.view.strips, undefined, "a single phone screen is not cut");
});

test("an image libvips cannot read says so instead of attaching it", async () => {
  const { out, block, result } = await viewOf(Buffer.from("not an image at all"), "image/heic", {}, "documentMessage");
  assert.equal(block, undefined);
  assert.equal(out.image_attached, undefined);
  assert.match(out.notes.join(" "), /could not be read here/);
  assert.match(result.content[0].text, /could not be read here/);
});

test("a Lottie sticker is no longer 'no media': its shipped thumbnail is shown", async () => {
  const { svc, call, arrive } = setup();
  const thumb = await sharp({ create: { width: 96, height: 96, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  const was = Buffer.from("PK lottie archive");
  let downloaded = null;
  svc.mediaBuffer = async (_sock, _sid, raw) => {
    downloaded = raw;
    return was;
  };
  const sid = arrive(ANA, {
    lottieStickerMessage: {
      message: { stickerMessage: { mimetype: "application/was", fileLength: was.length, isLottie: true, isAnimated: true, pngThumbnail: thumb } },
    },
  });
  const result = await call("get_media", { message_id: sid });
  const out = result.structuredContent;
  assert.equal(out.type, "sticker");
  assert.equal(out.mime, "application/was");
  assert.deepEqual(out.view, { kind: "frame", width: 96, height: 96 });
  assert.equal(result.content[1].type, "image");
  assert.ok(downloaded !== null, "the download was asked for");

  const { downloadableMessage } = await import("../dist/messages.js");
  assert.ok(downloadableMessage(downloaded).message.stickerMessage, "Baileys is handed the inner sticker, which it can download");
});

test("a remote session is shown a Lottie sticker's thumbnail with no download, even once WhatsApp let the file go", async () => {
  const { svc, call, arrive } = setup({ remote: true });
  const thumb = await sharp({ create: { width: 96, height: 96, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  let downloads = 0;
  svc.mediaBuffer = async () => {
    downloads++;
    throw Object.assign(new Error("expired"), { code: "MEDIA_UNAVAILABLE" });
  };
  const sid = arrive(ANA, {
    lottieStickerMessage: { message: { stickerMessage: { mimetype: "application/was", fileLength: 4321, isLottie: true, pngThumbnail: thumb } } },
  });
  const result = await call("get_media", { message_id: sid });
  assert.ok(!result.isError, JSON.stringify(result.content));
  const out = result.structuredContent;
  assert.equal(downloads, 0, "nothing downloaded, and the phone never asked");
  assert.deepEqual(out.view, { kind: "frame", width: 96, height: 96 });
  assert.equal(out.size, 4321, "the size its message states");
  assert.equal(out.source, undefined);
  assert.match(result.content[0].text, /^sticker false_\S+ · from \+40 700 000 002\napplication\/was, 4 KB, not downloaded: its thumbnail is all there is to see\./);
});

test("a remote session sees the media but gets no file: nothing written, no path, no data dir named", async () => {
  const { svc, call, arrive } = setup({ remote: true });
  const photo = await noisyPhoto(1600, 1200);
  let downloads = 0;
  svc.mediaBuffer = async () => {
    downloads++;
    return photo;
  };
  const sid = arrive(ANA, { imageMessage: { mimetype: "image/jpeg", fileLength: photo.length, caption: "bonul" } });
  const result = await call("get_media", { message_id: sid });
  const out = result.structuredContent;
  assert.equal(out.path, undefined);
  assert.equal(out.filename, undefined);
  assert.equal(out.view.kind, "image");
  assert.equal(out.size, photo.length);
  assert.equal(downloads, 1, "downloaded once, for the view");
  assert.ok(!JSON.stringify(result).includes(svc.config.dataDir), "no host path anywhere in the answer");
  // What the message is and who sent it, its caption, then what is shown of it.
  assert.match(result.content[0].text, /^image false_\S+ · from \+40 700 000 002\nCaption \(the sender's words\): bonul\nimage\/jpeg, \d+ KB\.\n\(image attached: 1024x768 view of the 1600x1200 original/);
  assert.equal(existsSync(svc.paths.mediaDir), false, "no copy written into the media directory");
});

test("a remote session asking for a recording with no transcript downloads nothing", async () => {
  const { svc, call, arrive } = setup({ remote: true });
  let downloads = 0;
  svc.mediaBuffer = async () => {
    downloads++;
    return Buffer.from("OggS");
  };
  svc.transcribeAudio = async () => {
    throw new WazapError("TRANSCRIBE_UNAVAILABLE", "Transcription is off.");
  };
  const sid = arrive(ANA, { audioMessage: { mimetype: "audio/ogg; codecs=opus", fileLength: 4, seconds: 3, ptt: true } });
  const out = (await call("get_media", { message_id: sid })).structuredContent;
  assert.equal(out.transcript_unavailable.code, "TRANSCRIBE_UNAVAILABLE");
  assert.equal(out.mime, "audio/ogg; codecs=opus");
  assert.equal(out.path, undefined);
  assert.match(out.notes.join(" "), /only its transcript can reach you/);
  assert.equal(downloads, 0);
});
