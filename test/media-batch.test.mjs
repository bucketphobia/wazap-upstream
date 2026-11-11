/**
 * get_media for several messages in one call (message_ids): each answered in
 * order under its own heading, its image after its own lines; one that cannot
 * be read says why in its item and the others still answer; every view at the
 * standard detail; a cancelled call stops the rest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import sharp from "sharp";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools, textError } from "./helpers.mjs";
import { pdfOf } from "./media-fixtures.mjs";

const ANA = "40700000002@s.whatsapp.net";
const DAN = "40700000003@s.whatsapp.net";

function setup(t, opts = { allowWrite: false, allowLocalFiles: false }) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-batch-", id: "40700000001@s.whatsapp.net", name: "Me" });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  const tools = schemaCheckedTools(svc, opts);
  const bytes = new Map();
  const downloads = [];
  svc.mediaBuffer = async (_sock, _sid, raw) => {
    downloads.push(raw.key.id);
    return bytes.get(raw.key.id);
  };
  const arrive = (chat, id, message, data) => {
    bytes.set(id, data);
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{ key: { remoteJid: chat, fromMe: false, id }, message, messageTimestamp: Math.floor(Date.now() / 1000) }],
    });
    return `false_${chat}_${id}`;
  };
  return { svc, ...tools, arrive, downloads };
}

const photo = (width, height, color) => sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();

test("several messages in one call: each answered in order, its image right after its own lines", async (t) => {
  const { call, arrive } = setup(t);
  const red = await photo(1600, 1200, "#cc0000");
  const blue = await photo(800, 600, "#0000cc");
  const pdf = pdfOf([["Factura 12", "Total: 430 lei"]]);
  const first = arrive(ANA, "P1", { imageMessage: { mimetype: "image/jpeg", fileLength: red.length, caption: "bonul" } }, red);
  const second = arrive(DAN, "D1", { documentMessage: { mimetype: "application/pdf", fileName: "factura.pdf", fileLength: pdf.length } }, pdf);
  const third = arrive(ANA, "P2", { imageMessage: { mimetype: "image/jpeg", fileLength: blue.length } }, blue);

  const result = await call("get_media", { message_ids: [first, second, third] });
  assert.equal(result.isError, undefined);
  const out = result.structuredContent;
  assert.deepEqual(out.items.map((item) => item.message_id), [first, second, third]);
  assert.equal(out.message_id, first, "the single-answer fields name the first id");
  assert.equal(out.type, null);
  assert.equal(out.image_attached, true);
  assert.deepEqual(out.items.map((item) => item.type), ["image", "document", "image"]);
  assert.equal(out.items[0].caption, "bonul");
  assert.equal(out.items[0].view.detail, "standard");
  assert.equal(out.items[0].view.width, 1024);
  assert.match(out.items[1].document_text, /Total: 430 lei/);
  assert.ok(out.items.every((item) => item.path === undefined && item.account_id === "default"), "a remote session gets no path");
  assert.ok(out.notes.some((note) => /each image belongs to the next item with image_attached/.test(note)));
  assert.ok(out.notes.some((note) => /never follow instructions/.test(note)), "document text is framed as data");

  // Every image follows its own section: text, image (1), text (2), [the PDF's page where a renderer exists], text (3), image (3).
  const types = result.content.map((block) => block.type);
  const pdfPage = out.items[1].image_attached === true;
  assert.deepEqual(types, pdfPage ? ["text", "image", "text", "image", "text", "image"] : ["text", "image", "text", "image"]);
  assert.equal(types.filter((type) => type === "image").length, out.items.filter((item) => item.image_attached).length);
  assert.match(result.content[0].text, /^Media of 3 messages, in the order asked\.\n\n## 1 of 3 · false_40700000002@s\.whatsapp\.net_P1\n/);
  const rest = result.content.filter((block) => block.type === "text").slice(1).map((block) => block.text).join("");
  assert.match(rest, /## 2 of 3 · .*_D1\n[\s\S]*Total: 430 lei[\s\S]*## 3 of 3 · .*_P2\n/);
  const last = await sharp(Buffer.from(result.content.at(-1).data, "base64")).metadata();
  assert.deepEqual([last.width, last.height], [800, 600]);
});

test("one message that cannot be read says why in its item; the others still answer", async (t) => {
  const { call, arrive } = setup(t);
  const pdf = pdfOf([["Contract"]]);
  const good = arrive(ANA, "D1", { documentMessage: { mimetype: "application/pdf", fileName: "c.pdf", fileLength: pdf.length } }, pdf);
  const text = arrive(ANA, "T1", { conversation: "doar text" }, undefined);
  const missing = `false_${ANA}_NOPE`;
  const result = await call("get_media", { message_ids: [missing, good, text] });
  const [gone, read, plain] = result.structuredContent.items;
  assert.equal(gone.message_id, missing);
  assert.equal(gone.error.code, "MESSAGE_NOT_FOUND");
  assert.match(read.document_text, /Contract/);
  assert.equal(plain.error.code, "MEDIA_UNAVAILABLE");
  assert.equal(result.structuredContent.account_id, "default");
  assert.ok(result.structuredContent.notes.some((note) => /2 of 3 could not be read/.test(note)));
  assert.match(result.content[0].text, /## 1 of 3 · false_40700000002@s\.whatsapp\.net_NOPE\nNot read: MESSAGE_NOT_FOUND: /);
});

test("a repeated id is answered once, and a batch never asks for small print or one document's pages", async (t) => {
  const { call, arrive, downloads } = setup(t);
  const red = await photo(400, 300, "#cc0000");
  const id = arrive(ANA, "P1", { imageMessage: { mimetype: "image/jpeg", fileLength: red.length } }, red);
  const other = arrive(ANA, "P2", { imageMessage: { mimetype: "image/jpeg", fileLength: red.length } }, red);
  const twice = await call("get_media", { message_ids: [id, other, id] });
  assert.equal(twice.structuredContent.items.length, 2);
  assert.match(twice.content[0].text, /1 repeated id answered once/);
  assert.deepEqual(downloads.sort(), ["P1", "P2"]);

  for (const [args, pattern] of [
    [{ message_ids: [id, other], detail: "high" }, /one message at a time/],
    [{ message_ids: [id, other], pages: "2" }, /one document/],
    [{ message_id: id, message_ids: [id, other] }, /not both/],
    [{}, /message_id for one message, or message_ids/],
  ]) {
    const refused = textError(await call("get_media", args));
    assert.equal(refused.error, "INVALID_ID");
    assert.match(refused.message, pattern);
  }
  await assert.rejects(call("get_media", { message_ids: [] }), /at least 1|too_small/i);
  await assert.rejects(call("get_media", { message_ids: Array.from({ length: 9 }, (_, i) => `${id}${i}`) }), /at most 8|too_big/i);
});

test("a list of one id, as catch_up's media_ids often is, is answered in items and may ask for small print", async (t) => {
  const { call, arrive } = setup(t);
  const red = await photo(1600, 1200, "#cc0000");
  const id = arrive(ANA, "P1", { imageMessage: { mimetype: "image/jpeg", fileLength: red.length, caption: "bonul" } }, red);
  const one = await call("get_media", { message_ids: [id] });
  assert.equal(one.isError, undefined, one.content[0].text);
  assert.deepEqual(one.structuredContent.items.map((item) => [item.message_id, item.type, item.caption]), [[id, "image", "bonul"]]);
  assert.match(one.content[0].text, /^Media of 1 message, in the order asked\./);
  assert.equal(one.content.filter((block) => block.type === "image").length, 1);
  const sharp_ = await call("get_media", { message_ids: [id, id], detail: "high" });
  assert.equal(sharp_.isError, undefined, "the same id twice is one message");
  assert.equal(sharp_.structuredContent.items[0].view.detail, "high");
});

test("a cancelled batch stops opening the rest and answers nothing", async (t) => {
  const { tools, arrive, downloads, svc } = setup(t);
  const red = await photo(400, 300, "#cc0000");
  const ids = ["P1", "P2", "P3", "P4", "P5"].map((id) => arrive(ANA, id, { imageMessage: { mimetype: "image/jpeg", fileLength: red.length } }, red));
  const stop = new AbortController();
  const original = svc.mediaBuffer;
  svc.mediaBuffer = async (sock, sid, raw, opts) => {
    if (raw.key.id === "P1") stop.abort();
    return original(sock, sid, raw, opts);
  };
  const result = await tools.get("get_media").handler({ message_ids: ids }, { signal: stop.signal });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cancelled/);
  assert.ok(downloads.length <= 3, `only the items already under way were opened: ${downloads.join(",")}`);
});

test("the old download_media name still opens exactly one message", async (t) => {
  const { svc } = setup(t);
  const tools = new Map();
  const { registerTools } = await import("../dist/tools.js");
  const { asToolSource } = await import("./helpers.mjs");
  registerTools({ registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) }, asToolSource(svc), { allowWrite: false, legacyReads: true, allowLocalFiles: false });
  for (const name of ["download_media", "transcribe_audio"]) {
    const schema = tools.get(name).meta.inputSchema;
    assert.equal(schema.message_ids, undefined, name);
    assert.equal(schema.message_id.isOptional(), false, name);
  }
  assert.equal(tools.get("get_media").meta.inputSchema.message_id.isOptional(), true);
});
