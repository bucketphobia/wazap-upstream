/**
 * Media files written in code for the media tests, so no binary sits in the
 * repository: a PDF with chosen text per page, and a ZIP (the container of
 * Office and OpenDocument files) that can lie about its sizes.
 */
import { crc32, createDeflate, deflateRawSync, deflateSync } from "node:zlib";

/**
 * A valid PDF with one page per entry of `pages`, each page's lines drawn as text (none: a page with no text layer).
 * `compress`: the page contents as Flate streams, the way most PDFs store them.
 */
export function pdfOf(pages, { compress = false } = {}) {
  const escape = (text) => text.replace(/[\\()]/g, (ch) => `\\${ch}`);
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", null, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids = [];
  for (const lines of pages) {
    const stream = lines.length === 0
      ? "0 0 1 rg 72 600 200 100 re f"
      : ["BT", "/F1 12 Tf", "72 760 Td", ...lines.flatMap((line, i) => (i === 0 ? [`(${escape(line)}) Tj`] : ["0 -16 Td", `(${escape(line)}) Tj`])), "ET"].join("\n");
    if (compress) {
      const packed = deflateSync(Buffer.from(stream, "latin1")).toString("latin1");
      objects.push(`<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n${packed}\nendstream`);
    } else {
      objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    }
    const contents = objects.length;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/**
 * A one-page PDF whose font program is `font`, stored under `dict` (its
 * /Filter and anything else), and any `extra` streams as further objects:
 * the shape of a compression bomb, where a few KB of font unpack to
 * gigabytes when pdf.js or poppler loads it.
 */
export function pdfWithFont(font, dict, extra = []) {
  const content = "BT /F1 12 Tf 72 720 Td (Hello) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Bomb /FirstChar 32 /LastChar 126 /FontDescriptor 6 0 R /Encoding /WinAnsiEncoding >>",
    "<< /Type /FontDescriptor /FontName /Bomb /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile 7 0 R >>",
    Buffer.concat([Buffer.from(`<< /Length ${font.length} ${dict} /Length1 100 /Length2 1000 /Length3 0 >>\nstream\n`, "latin1"), font, Buffer.from("\nendstream", "latin1")]),
    ...extra.map(({ data, dict: extraDict }) => Buffer.concat([Buffer.from(`<< /Length ${data.length} ${extraDict} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")])),
  ];
  const chunks = [Buffer.from("%PDF-1.4\n", "latin1")];
  let at = chunks[0].length;
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(at);
    const bytes = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "latin1"), Buffer.isBuffer(object) ? object : Buffer.from(object, "latin1"), Buffer.from("\nendobj\n", "latin1")]);
    chunks.push(bytes);
    at += bytes.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}

/** `mb` megabytes of zeros, deflated (zlib) without ever holding them: about 1 KB per MB. */
export async function deflatedZeros(mb) {
  const deflate = createDeflate();
  const parts = [];
  deflate.on("data", (chunk) => parts.push(chunk));
  const done = new Promise((resolve, reject) => deflate.on("end", resolve).on("error", reject));
  const chunk = Buffer.alloc(1_000_000);
  for (let i = 0; i < mb; i++) {
    if (!deflate.write(chunk)) await new Promise((resolve) => deflate.once("drain", resolve));
  }
  deflate.end();
  await done;
  return Buffer.concat(parts);
}

/**
 * LZW codes (PDF's, early change 1) that unpack to at least `bytes` zeros:
 * 0, then each new table entry in turn (each one zero longer), then the
 * longest entry again and again, then the end code.
 */
export function lzwZeros(bytes) {
  const codes = [0];
  let total = 1;
  for (let code = 258; code < 4096 && total < bytes; code++) {
    codes.push(code);
    total += code - 256;
  }
  while (total < bytes) {
    codes.push(4095);
    total += 4095 - 256;
  }
  codes.push(257);
  // Each code's width follows the decoder's table: it grows once the next entry would need another bit.
  const bits = [];
  let next = 258;
  let previous = -1;
  let width = 9;
  for (const code of codes) {
    for (let bit = width - 1; bit >= 0; bit--) bits.push((code >> bit) & 1);
    if (code === 257) break;
    if (previous >= 0 && next < 4096) next++;
    previous = code;
    const reach = next + 1;
    width = reach >= 2048 ? 12 : reach >= 1024 ? 11 : reach >= 512 ? 10 : 9;
  }
  const out = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => {
    if (bit) out[i >> 3] |= 0x80 >> (i & 7);
  });
  return out;
}

/** A ZIP of `files` ({ name: string | Buffer }), deflated; `lie` overrides an entry's stated size. */
export function zipOf(files, { lie = {}, store = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const packed = store ? data : deflateRawSync(data);
    const nameBytes = Buffer.from(name, "utf8");
    const size = lie[name] ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * LZW codes (PDF's, early change 1) that pdf.js unpacks to about 7 MB per
 * cycle: after one byte, every code is past the table, and pdf.js repeats
 * its last sequence one byte longer for each, until the table is full; a
 * clear code starts the next cycle. About 5.5 KB per cycle.
 */
export function lzwGrowing(cycles) {
  const codes = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    // The first code of a cycle opens the sequence; it adds no table entry.
    codes.push([cycle === 0 ? 65 : 511, 9]);
    let width = 9;
    for (let next = 258; next <= 4095; ) {
      codes.push([(1 << width) - 1, width]);
      next++;
      if (((next + 1) & next) === 0) width = Math.min(Math.log2(next + 1) + 1, 12);
    }
    codes.push([256, 12]);
  }
  codes.push([257, 9]);
  const bits = [];
  for (const [code, size] of codes) for (let bit = size - 1; bit >= 0; bit--) bits.push((code >> bit) & 1);
  const out = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => {
    if (bit) out[i >> 3] |= 0x80 >> (i & 7);
  });
  return out;
}
