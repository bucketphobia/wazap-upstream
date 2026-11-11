/**
 * A PDF's streams are measured before anything reads it: a stream that
 * unpacks past its cap (Flate, twice Flate, LZW, Brotli, run-length, behind
 * ASCII85 or an indirect filter) refuses the file; images are left to the
 * readers, which never unpack them whole. A dictionary the check cannot read
 * fails closed. What the check misses is stopped by the memory watch around
 * the worker and the renderer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { brotliCompressSync, deflateSync } from "node:zlib";

import { lzwDecode, pdfBombReason } from "../dist/pdf-guard.js";
import { DocumentReadError, DOCUMENT_MEMORY, documentText, pdfPageImage } from "../dist/documents.js";
import { which } from "../dist/transcribe/local.js";
import { deflatedZeros, lzwGrowing, lzwZeros, pdfOf, pdfWithFont } from "./media-fixtures.mjs";

const MB = 1_000_000;
const ZEROS_100MB = await deflatedZeros(100);

test("ordinary PDFs pass the stream check, compressed or not", () => {
  const line = "Lorem ipsum dolor sit amet, consectetur adipiscing elit.";
  const pages = Array.from({ length: 20 }, (_, p) => Array.from({ length: 40 }, (_, i) => `${p}.${i} ${line}`));
  assert.equal(pdfBombReason(pdfOf(pages)), null);
  assert.equal(pdfBombReason(pdfOf(pages, { compress: true })), null);
  assert.equal(pdfBombReason(pdfWithFont(deflateSync(Buffer.alloc(2 * MB, 7)), "/Filter /FlateDecode")), null, "a 2 MB font is a font");
});

test("a font that inflates past the cap refuses the file, under any spelling of its filter", () => {
  assert.match(pdfBombReason(pdfWithFont(ZEROS_100MB, "/Filter /FlateDecode")), /a stream in it unpacks to more than 64 MB \(a compression bomb\)/);
  assert.match(pdfBombReason(pdfWithFont(ZEROS_100MB, "/Filter [/Fl]")), /compression bomb/);
  // An indirect filter, or none named at all: data that inflates is measured as Flate anyway.
  assert.match(pdfBombReason(pdfWithFont(ZEROS_100MB, "/Filter 9 0 R")), /compression bomb/);
  assert.match(pdfBombReason(pdfWithFont(ZEROS_100MB, "")), /compression bomb/);
  // A /Length that stops short of the data does not hide the rest: Flate data ends itself.
  const short = pdfWithFont(ZEROS_100MB, "/Filter /FlateDecode").toString("latin1").replace(`/Length ${ZEROS_100MB.length} `, "/Length 10 ");
  assert.match(pdfBombReason(Buffer.from(short, "latin1")), /compression bomb/);
});

test("a bomb wrapped twice, or in LZW, Brotli, run-length or ASCII85 is found too", () => {
  const twice = deflateSync(ZEROS_100MB);
  assert.ok(twice.length < 2_000, `${twice.length} bytes`);
  assert.match(pdfBombReason(pdfWithFont(twice, "/Filter [/FlateDecode /FlateDecode]")), /compression bomb/);

  assert.match(pdfBombReason(pdfWithFont(lzwZeros(80 * MB), "/Filter /LZWDecode")), /compression bomb/);
  assert.equal(pdfBombReason(pdfWithFont(lzwZeros(2 * MB), "/Filter /LZWDecode")), null);

  assert.match(pdfBombReason(pdfWithFont(brotliCompressSync(Buffer.alloc(70 * MB)), "/Filter /BrotliDecode")), /compression bomb/);

  const runs = Buffer.alloc(2 * 600_000);
  for (let i = 0; i < runs.length; i += 2) runs[i] = 129;
  assert.match(pdfBombReason(pdfWithFont(Buffer.concat([runs, Buffer.from([128])]), "/Filter /RunLengthDecode")), /compression bomb/);

  const a85 = Buffer.from(`${"z".repeat(1000)}~>`);
  const flateInA85 = Buffer.from(ascii85(ZEROS_100MB));
  assert.equal(pdfBombReason(pdfWithFont(a85, "/Filter /ASCII85Decode")), null);
  assert.match(pdfBombReason(pdfWithFont(flateInA85, "/Filter [/ASCII85Decode /FlateDecode]")), /compression bomb/);
});

test("streams that fit one by one but not together refuse the file as a whole", async () => {
  const eight = await deflatedZeros(8);
  const pdf = pdfWithFont(eight, "/Filter /FlateDecode", [{ data: eight, dict: "/Filter /FlateDecode" }]);
  assert.equal(pdfBombReason(pdf, { perStream: 10 * MB, total: 20 * MB }), null);
  assert.match(pdfBombReason(pdf, { perStream: 10 * MB, total: 15 * MB }), /unpack to more than 15 MB in all/);
});

test("an image stream is left to the readers, which never unpack it whole", () => {
  assert.equal(pdfBombReason(pdfWithFont(ZEROS_100MB, "/Subtype /Image /Width 10 /Height 10 /Filter /FlateDecode")), null);
});

test("the LZW reader gives back what PDF's reference example encodes", () => {
  // ISO 32000-1, 7.4.4.2: "-----A---B" with early change.
  const coded = Buffer.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]);
  assert.equal(Buffer.from(lzwDecode(coded, 1, 1000)).toString("latin1"), "-----A---B");
  assert.deepEqual(Buffer.from(lzwDecode(lzwZeros(100_000), 1, 200_000)).subarray(0, 100_000), Buffer.alloc(100_000));
});

test("a bomb is refused by the reader at once, as hostile, before pdf.js sees it", async () => {
  const started = Date.now();
  const error = await documentText("pdf", pdfWithFont(ZEROS_100MB, "/Filter /FlateDecode"), { from: 1, to: null }).catch((err) => err);
  assert.ok(error instanceof DocumentReadError, String(error));
  assert.equal(error.hostile, true);
  assert.match(error.message, /compression bomb/);
  assert.ok(Date.now() - started < 10_000, `${Date.now() - started} ms`);
});

test("what the check misses is stopped by the memory watch around the reader", async (t) => {
  // A font labelled as an image passes the check, and pdf.js loads it whole: the process's memory gives it away.
  const saved = DOCUMENT_MEMORY.readGrowthBytes;
  DOCUMENT_MEMORY.readGrowthBytes = 64 * MB;
  t.after(() => (DOCUMENT_MEMORY.readGrowthBytes = saved));
  const bomb = pdfWithFont(await deflatedZeros(300), "/Subtype /Image /Filter /FlateDecode");
  assert.equal(pdfBombReason(bomb), null);
  const error = await documentText("pdf", bomb, { from: 1, to: null }).catch((err) => err);
  assert.ok(error instanceof DocumentReadError, String(error));
  assert.equal(error.hostile, true);
  assert.match(error.message, /needs more memory than a document read is given/);
});

test("the page renderer is killed past its memory limit", async (t) => {
  if (which("pdftoppm") === null) return t.skip("no pdftoppm");
  const saved = DOCUMENT_MEMORY.renderBytes;
  DOCUMENT_MEMORY.renderBytes = 64 * MB;
  t.after(() => (DOCUMENT_MEMORY.renderBytes = saved));
  const bomb = pdfWithFont(await deflatedZeros(300), "/Subtype /Image /Filter /FlateDecode");
  const started = Date.now();
  assert.equal(await pdfPageImage(bomb, 1, 1024), null);
  assert.ok(Date.now() - started < 15_000, `${Date.now() - started} ms`);
  // An ordinary page still draws under the same limit.
  assert.ok((await pdfPageImage(pdfOf([["Pagina"]]), 1, 512))?.length > 0);
});

/** ASCII85 of `bytes`, with its end mark. */
function ascii85(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = Buffer.alloc(4);
    bytes.copy(chunk, 0, i, Math.min(i + 4, bytes.length));
    const n = Math.min(4, bytes.length - i);
    let value = chunk.readUInt32BE(0);
    if (value === 0 && n === 4) {
      out += "z";
      continue;
    }
    const digits = [];
    for (let d = 0; d < 5; d++) {
      digits.unshift(String.fromCharCode((value % 85) + 33));
      value = Math.floor(value / 85);
    }
    out += digits.slice(0, n + 1).join("");
  }
  return `${out}~>`;
}

/** `pdf` with the font object's dictionary end rewritten: the bytes are latin1, so the binary data round-trips. */
function rewritten(pdf, from, to) {
  const text = pdf.toString("latin1");
  assert.ok(text.includes(from), from);
  return Buffer.from(text.replace(from, to), "latin1");
}

test("a dictionary written to hide a bomb fails closed: comments, long dictionaries, strings, escaped names", () => {
  const plain = pdfWithFont(ZEROS_100MB, "/Filter /FlateDecode");
  const end = "/Length3 0 >>\nstream\n";
  const variants = {
    "a comment after the dictionary": rewritten(plain, end, "/Length3 0 >> % c\nstream\n"),
    "a comment on a line of its own": rewritten(plain, end, "/Length3 0 >>\n% c >> <<\nstream\n"),
    "a dictionary over 64 KB": rewritten(plain, end, `/Length3 0 /Pad (${"a".repeat(70_000)}) >>\nstream\n`),
    "a string holding >>": rewritten(plain, end, "/Length3 0 /X (>> <<) >>\nstream\n"),
    "a string holding an image's dictionary": rewritten(plain, end, "/Length3 0 /X (<< /Subtype /Image >>) >>\nstream\n"),
    "an escaped filter name": rewritten(plain, "/Filter /FlateDecode", "/Filter /Fl#61teDecode"),
    "spaces before the end of the keyword's line": rewritten(plain, end, `/Length3 0 >>\nstream${" ".repeat(300)}\n`),
    "an unreadable dictionary": rewritten(plain, end, "/Length3 0 ) >>\nstream\n"),
  };
  for (const [name, pdf] of Object.entries(variants)) assert.match(pdfBombReason(pdf), /compression bomb/, name);
  // An image's own dictionary, read cleanly, still leaves the image to the readers, comments and all.
  const image = pdfWithFont(ZEROS_100MB, "/Subtype /Image /Width 10 /Height 10 /Filter /FlateDecode");
  assert.equal(pdfBombReason(rewritten(image, end, "/Length3 0 % note\n>> % c\nstream\n")), null);
});

test("LZW codes past the table grow each sequence by a byte in pdf.js, and are measured the same", () => {
  const cycle = lzwDecode(lzwGrowing(1), 1, 100 * MB);
  // 1 + 2 + ... + 3,839 bytes: the sequence grows with each of the 3,838 codes past the table.
  assert.equal(cycle.length, (3839 * 3840) / 2);
  const bomb = lzwGrowing(10);
  assert.ok(bomb.length < 60_000, `${bomb.length} bytes`);
  assert.match(pdfBombReason(pdfWithFont(bomb, "/Filter /LZWDecode")), /compression bomb/);
  // Behind an unreadable dictionary it is guessed at, and the ratio gives it away.
  assert.match(pdfBombReason(rewritten(pdfWithFont(bomb, "/Filter /LZWDecode"), "/Length3 0 >>\nstream\n", "/Length3 0 >> % c\nstream\n")), /compression bomb/);
});

test("streams built to overlap are refused in one pass, not measured again and again", () => {
  for (const mb of [0.5, 2]) {
    const unit = "<<>>stream\n";
    const pdf = Buffer.from(`%PDF-1.4\n${unit.repeat(Math.floor((mb * MB) / unit.length))}`, "latin1");
    const started = performance.now();
    assert.match(pdfBombReason(pdf), /overlap one another/, `${mb} MB`);
    assert.ok(performance.now() - started < 5_000, `${mb} MB took ${Math.round(performance.now() - started)} ms`);
  }
  // A large honest file: 20,000 pages, each its own Flate stream, measured once each.
  const pages = Array.from({ length: 20_000 }, (_, p) => [`Page ${p + 1}`]);
  const started = performance.now();
  assert.equal(pdfBombReason(pdfOf(pages, { compress: true })), null);
  assert.ok(performance.now() - started < 3_000, `${Math.round(performance.now() - started)} ms`);
});
