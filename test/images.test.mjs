/**
 * The images wazap makes from media (src/images.ts): sharp's previews of
 * every image format libvips reads, the jpeg-js fallback when sharp does not
 * load, and the refusals an untrusted image meets before it is decoded.
 * Fixtures are generated here, with sharp itself.
 */
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";

import sharp from "sharp";

import { imageView, previewImage, setImageEngine, SVG_LIMITS, withinHeaderCap } from "../dist/images.js";

/** A solid image of `format`, `width` x `height`, optionally transparent. */
async function solid(format, width, height, { alpha = false, color = { r: 200, g: 40, b: 40 } } = {}) {
  const background = alpha ? { ...color, alpha: 0 } : color;
  const image = sharp({ create: { width, height, channels: alpha ? 4 : 3, background } });
  return image.toFormat(format).toBuffer();
}

/** A PNG whose header claims `width` x `height`, with almost no pixel data: what a decompression bomb looks like to a decoder. */
function claimedPng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(16))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("a preview is a 320 px JPEG of any image libvips reads, not only of a JPEG", async () => {
  for (const format of ["jpeg", "png", "webp", "gif"]) {
    const preview = await previewImage(await solid(format, 1600, 1200), `image/${format}`);
    assert.ok(preview, format);
    assert.deepEqual([preview.width, preview.height], [320, 240], format);
    const meta = await sharp(preview.data).metadata();
    assert.equal(meta.format, "jpeg", `${format} comes back as a JPEG`);
  }
});

test("a transparent image is previewed on white, and a small one is never enlarged", async () => {
  const preview = await previewImage(await solid("png", 200, 100, { alpha: true }), "image/png");
  assert.deepEqual([preview.width, preview.height], [200, 100]);
  const { data } = await sharp(preview.data).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 240 && data[1] > 240 && data[2] > 240, `white, not black: ${[...data.subarray(0, 3)]}`);
});

test("a photo is turned the way its EXIF says before it is shrunk", async () => {
  const sideways = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#336699" } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const preview = await previewImage(sideways, "image/jpeg");
  assert.deepEqual([preview.width, preview.height], [240, 320]);
});

test("an image claiming more pixels than the cap is refused before it is decoded", async () => {
  const bomb = claimedPng(20_000, 20_000);
  assert.ok(bomb.length < 200, "a few bytes on the wire");
  assert.equal(await previewImage(bomb, "image/png"), null);
  assert.equal(await previewImage(Buffer.from("not an image"), "image/jpeg"), null);
});

test("without sharp, a JPEG is still previewed by jpeg-js, and other formats go without", async (t) => {
  setImageEngine(null);
  t.after(() => setImageEngine(undefined));
  const jpeg = await previewImage(await solid("jpeg", 1600, 1200), "image/jpeg");
  assert.deepEqual([jpeg.width, jpeg.height], [320, 240]);
  assert.equal(await previewImage(await solid("png", 1600, 1200), "image/png"), null);
});

test("read_messages previews a PNG photo too, and a kept copy answers with the link down", async (t) => {
  const { WhatsAppService } = await import("../dist/whatsapp.js");
  const { connectedService, schemaCheckedTools } = await import("./helpers.mjs");
  const { rmSync } = await import("node:fs");
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-png-preview-", id: "40700000001@s.whatsapp.net", name: "Me" });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  const ANA = "40700000002@s.whatsapp.net";
  const png = await solid("png", 900, 600);
  let downloads = 0;
  svc.mediaBuffer = async () => {
    downloads++;
    return png;
  };
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: ANA, fromMe: false, id: "P1" }, message: { imageMessage: { mimetype: "image/png", fileLength: png.length } }, messageTimestamp: Math.floor(Date.now() / 1000) }],
  });
  const read = await call("read_messages", { chat_id: ANA, include_previews: true });
  assert.equal(read.structuredContent.preview_count, 1);
  const meta = await sharp(Buffer.from(read.content[1].data, "base64")).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ["jpeg", 320, 213]);
  assert.equal(downloads, 1);

  // A second photo, kept on arrival, while the link is down: the kept copy makes its preview.
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: ANA, fromMe: false, id: "P2" }, message: { imageMessage: { mimetype: "image/png", fileLength: png.length } }, messageTimestamp: Math.floor(Date.now() / 1000) + 1 }],
  });
  svc.status = "connecting";
  svc.keep.read = async (sid) => (sid.endsWith("_P2") ? png : null);
  const offline = await svc.previews([`false_${ANA}_P2`, `false_${ANA}_P1`], 12);
  assert.deepEqual(offline.map((p) => p.message_id), [`false_${ANA}_P2`, `false_${ANA}_P1`], "the kept copy is previewed without WhatsApp");
  assert.equal(downloads, 1, "nothing was downloaded with the link down");
});

test("an SVG is drawn into a view; a HEIC photo goes through sips on macOS", async (t) => {
  const { imageView } = await import("../dist/images.js");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#c00"/></svg>');
  const drawn = await imageView(svg, "standard", "image/svg+xml");
  assert.deepEqual([drawn.width, drawn.height, drawn.format], [400, 200, "svg"]);
  assert.equal((await sharp(drawn.data).metadata()).format, "jpeg");

  const { readdirSync } = await import("node:fs");
  const dir = "/System/Library/Desktop Pictures";
  let heic = null;
  try {
    heic = readdirSync(dir).find((name) => name.toLowerCase().endsWith(".heic")) ?? null;
  } catch {
    // Not macOS, or no wallpapers.
  }
  if (process.platform !== "darwin" || heic === null) return t.skip("no HEIC to read here");
  const { readFileSync } = await import("node:fs");
  const view = await imageView(readFileSync(`${dir}/${heic}`), "standard", "image/heic");
  assert.ok(view !== null, "sips turned it into something libvips reads");
  assert.ok(Math.max(view.width, view.height) <= 1024);
  assert.ok(view.data.length <= 110_000);
});

/** A WebP or GIF header claiming `width` x `height`, and nothing after it worth decoding. */
function claimedHeader(format, width, height) {
  if (format === "gif") {
    const gif = Buffer.alloc(13);
    gif.write("GIF89a", 0, "latin1");
    gif.writeUInt16LE(width, 6);
    gif.writeUInt16LE(height, 8);
    return gif;
  }
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "latin1");
  webp.writeUInt32LE(22, 4);
  webp.write("WEBPVP8X", 8, "latin1");
  webp.writeUInt32LE(10, 16);
  webp.writeUIntLE(width - 1, 24, 3);
  webp.writeUIntLE(height - 1, 27, 3);
  return webp;
}

test("a WebP or GIF too big to decode whole is refused from its own header, before libvips reads it", async () => {
  assert.equal(withinHeaderCap(claimedHeader("webp", 10_000, 9_990)), false);
  assert.equal(withinHeaderCap(claimedHeader("gif", 10_000, 9_990)), false);
  assert.equal(withinHeaderCap(claimedHeader("webp", 6_000, 4_000)), true, "a 24 MP photo is drawn");
  assert.equal(withinHeaderCap(claimedPng(10_000, 9_990)), true, "a PNG streams, and keeps the 100 MP cap");
  assert.equal(withinHeaderCap(claimedPng(20_000, 20_000)), false);
  assert.equal(withinHeaderCap(Buffer.from("not an image")), true, "anything else is left to sharp's header read");

  // A 10000x9990 WebP of one colour is a few dozen bytes; drawing it cost 480 MB, and libvips decodes a WebP even to measure it.
  const bomb = await sharp({ create: { width: 10_000, height: 9_990, channels: 3, background: "#c00" } }).webp({ quality: 10, effort: 0 }).toBuffer();
  assert.ok(bomb.length < 400_000, `${bomb.length} bytes`);
  const before = process.memoryUsage.rss();
  const views = await Promise.all([1, 2, 3, 4].map(() => imageView(bomb, "standard", "image/webp")));
  assert.deepEqual(views, [null, null, null, null]);
  assert.equal(await previewImage(bomb, "image/webp"), null);
  assert.ok(process.memoryUsage.rss() - before < 150_000_000, `${Math.round((process.memoryUsage.rss() - before) / 1e6)} MB`);
});

test("an SVG is drawn in a process of its own: one that draws too long is stopped, and never holds the thread pool", async (t) => {
  const saved = { ...SVG_LIMITS };
  SVG_LIMITS.timeoutMs = 1_500;
  t.after(() => Object.assign(SVG_LIMITS, saved));
  // Ten full-canvas rects under an order-20 convolution: librsvg draws each filter in one go, 34 s for a view in-process.
  const filter = `<filter id="f"><feConvolveMatrix order="20" kernelMatrix="${Array(400).fill(1).join(" ")}"/></filter>`;
  const rects = Array.from({ length: 10 }, (_, i) => `<rect width="2000" height="2000" fill="#${String(i).repeat(6)}" filter="url(#f)"/>`).join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="2000"><defs>${filter}</defs>${rects}</svg>`);
  assert.ok(svg.length < 2_000);
  let slowest = 0;
  let stop = false;
  const probe = (async () => {
    while (!stop) {
      const started = performance.now();
      await readFile(import.meta.filename);
      slowest = Math.max(slowest, performance.now() - started);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  const started = Date.now();
  const views = await Promise.all([1, 2, 3, 4].map(() => imageView(svg, "standard", "image/svg+xml")));
  stop = true;
  await probe;
  assert.deepEqual(views, [null, null, null, null]);
  assert.ok(Date.now() - started < 15_000, `${Date.now() - started} ms`);
  assert.ok(slowest < 1_000, `a file read waited ${Math.round(slowest)} ms`);
  // A read never draws one: previews leave SVG to get_media.
  assert.equal(await previewImage(svg, "image/svg+xml"), null);
  assert.equal(await previewImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>'), "image/png"), null, "by its bytes, whatever its mime");
});

test("a read does not download an SVG for a preview, nor again a photo that made none", async (t) => {
  const { WhatsAppService } = await import("../dist/whatsapp.js");
  const { connectedService, schemaCheckedTools } = await import("./helpers.mjs");
  const { rmSync } = await import("node:fs");
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-no-preview-", id: "40700000001@s.whatsapp.net", name: "Me" });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  const ANA = "40700000002@s.whatsapp.net";
  const downloads = [];
  svc.mediaBuffer = async (_sock, sid) => {
    downloads.push(sid);
    return Buffer.from("no format anything here reads");
  };
  const now = Math.floor(Date.now() / 1000);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      { key: { remoteJid: ANA, fromMe: false, id: "S1" }, message: { documentMessage: { mimetype: "image/svg+xml", fileName: "logo.svg", fileLength: 900 } }, messageTimestamp: now },
      { key: { remoteJid: ANA, fromMe: false, id: "H1" }, message: { documentMessage: { mimetype: "image/heic", fileName: "IMG_1.HEIC", fileLength: 900 } }, messageTimestamp: now + 1 },
    ],
  });
  for (let i = 0; i < 3; i++) {
    const read = await call("read_messages", { chat_id: ANA, include_previews: true });
    assert.equal(read.structuredContent.preview_count ?? 0, 0);
  }
  assert.deepEqual(downloads, [`false_${ANA}_H1`], "the SVG never, the unreadable HEIC once in three reads");
});
