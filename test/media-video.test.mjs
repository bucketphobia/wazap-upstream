/**
 * Video, GIF and round video through get_media: a contact sheet of frames
 * spread across the clip, made by ffmpeg and tiled by sharp, with the
 * second of each frame; without ffmpeg, the thumbnail WhatsApp shipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";

import { WhatsAppService } from "../dist/whatsapp.js";
import { frameTimes, jpegSize, parseDuration, videoFrame } from "../dist/previews.js";
import { which } from "../dist/transcribe/local.js";
import { connectedService, schemaCheckedTools } from "./helpers.mjs";

const ffmpeg = which("ffmpeg");
const ANA = "40700000002@s.whatsapp.net";

function setup(t) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-video-", id: "40700000001@s.whatsapp.net", name: "Me" });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  let seq = 0;
  const arrive = (content) => {
    const id = `V${++seq}`;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{ key: { remoteJid: ANA, fromMe: false, id }, message: content, messageTimestamp: Math.floor(Date.now() / 1000) }],
    });
    return `false_${ANA}_${id}`;
  };
  return { svc, call, arrive };
}

/** A test clip of `seconds` at `size`, made by ffmpeg. */
async function clip(seconds, size = "640x360") {
  const dir = mkdtempSync(join(tmpdir(), "wazap-clip-"));
  try {
    const out = join(dir, "clip.mp4");
    await promisify(execFile)(ffmpeg, ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=10`, "-t", String(seconds), "-pix_fmt", "yuv420p", out]);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("frames are taken in the middle of equal slices; a clip under a second gets one", () => {
  assert.deepEqual(frameTimes(30), [2.5, 7.5, 12.5, 17.5, 22.5, 27.5]);
  assert.deepEqual(frameTimes(0.5), [0.3]);
  assert.equal(parseDuration("  Duration: 00:01:02.50, start: 0.000000, bitrate: 2 kb/s"), 62.5);
  assert.equal(parseDuration("Duration: N/A"), undefined);
});

test("a video comes back as one contact sheet of six frames, with when each was taken", async (t) => {
  if (ffmpeg === null) return t.skip("ffmpeg not installed");
  const { svc, call, arrive } = setup(t);
  const mp4 = await clip(6);
  let downloads = 0;
  svc.mediaBuffer = async () => {
    downloads++;
    return mp4;
  };
  const sid = arrive({ videoMessage: { mimetype: "video/mp4", fileLength: mp4.length, seconds: 6, caption: "uite" } });
  const result = await call("get_media", { message_id: sid });
  const out = result.structuredContent;
  assert.equal(downloads, 1, "the file and the sheet come from one download");
  assert.equal(out.view.kind, "contact_sheet");
  assert.deepEqual(out.frames_at, [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]);
  assert.equal(out.duration_seconds, 6);
  const blocks = result.content.filter((block) => block.type === "image");
  assert.equal(blocks.length, 1, "one image for the whole clip");
  const sheet = Buffer.from(blocks[0].data, "base64");
  const meta = await sharp(sheet).metadata();
  assert.equal(meta.format, "jpeg");
  assert.ok(Math.max(meta.width, meta.height) <= 1024, `${meta.width}x${meta.height}`);
  assert.ok(sheet.length <= 110_000);
  assert.match(result.content[0].text, /contact sheet attached: 6 frames of 0:06, at 0:01, 0:02, 0:03, 0:04, 0:05, 0:06/);
});

test("a round video and a GIF get a sheet too, the length read from the file when the envelope has none", async (t) => {
  if (ffmpeg === null) return t.skip("ffmpeg not installed");
  const { svc, call, arrive } = setup(t);
  const mp4 = await clip(3, "320x320");
  svc.mediaBuffer = async () => mp4;
  const round = arrive({ ptvMessage: { mimetype: "video/mp4", fileLength: mp4.length } });
  const gif = arrive({ videoMessage: { mimetype: "video/mp4", fileLength: mp4.length, gifPlayback: true } });
  for (const sid of [round, gif]) {
    const out = (await call("get_media", { message_id: sid })).structuredContent;
    assert.equal(out.view.kind, "contact_sheet", sid);
    assert.equal(out.duration_seconds, 3, "probed by ffmpeg");
    assert.equal(out.frames_at.length, 6);
  }
});

test("without ffmpeg a video falls back to the thumbnail WhatsApp shipped", async (t) => {
  const { svc, call, arrive } = setup(t);
  const path = process.env.PATH;
  process.env.PATH = "";
  t.after(() => (process.env.PATH = path));
  const thumb = await sharp({ create: { width: 200, height: 112, channels: 3, background: "#123456" } }).jpeg().toBuffer();
  svc.mediaBuffer = async () => Buffer.from("not decoded here");
  const sid = arrive({ videoMessage: { mimetype: "video/mp4", fileLength: 16, seconds: 9, jpegThumbnail: thumb } });
  const out = (await call("get_media", { message_id: sid })).structuredContent;
  assert.deepEqual(out.view, { kind: "frame", width: 200, height: 112 });
  assert.equal(out.duration_seconds, 9);
});

test("a clip shorter than its envelope says still gets a whole sheet, timed by the file", async (t) => {
  if (ffmpeg === null) return t.skip("ffmpeg not installed");
  const { svc, call, arrive } = setup(t);
  const mp4 = await clip(3, "360x640");
  svc.mediaBuffer = async () => mp4;
  // The sender's envelope says a minute: every seek would pass the end of a 3 s clip.
  const sid = arrive({ videoMessage: { mimetype: "video/mp4", fileLength: mp4.length, seconds: 60 } });
  const out = (await call("get_media", { message_id: sid })).structuredContent;
  assert.equal(out.view.kind, "contact_sheet");
  assert.equal(out.duration_seconds, 3, "probed by ffmpeg");
  assert.deepEqual(out.frames_at, [0.3, 0.8, 1.3, 1.8, 2.3, 2.8]);
});

test("one frame of a vertical clip fits inside the edge by its height, not only its width", async (t) => {
  if (ffmpeg === null) return t.skip("ffmpeg not installed");
  const frame = await videoFrame(await clip(2, "360x640"), 320);
  assert.deepEqual(jpegSize(frame), { width: 180, height: 320 });
});
