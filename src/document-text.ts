/**
 * The words of a document someone sent, for an agent that cannot open the
 * file: a PDF's text layer page by page (pdf.js, through unpdf), the XML of
 * Office and OpenDocument files, and plain text, CSV, JSON, Markdown, XML and
 * HTML decoded. Everything stops at a character budget and says whether it
 * did. These run in the document worker (src/document-worker.ts), off the
 * event loop and under its memory and time limits; src/documents.ts is the
 * side the service calls.
 */
import { ZipError, ZipReader } from "./zip.js";

export type DocumentFormat = "pdf" | "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp" | "text" | "html";

export interface TextJob {
  format: DocumentFormat;
  bytes: Uint8Array;
  /** 1-based, inclusive; `to` null runs until the budget is spent. Pages are a PDF's, a presentation's slides, or parts of any other document. */
  pages: { from: number; to: number | null };
  budget: number;
}

/** What `pages` counts in a document: a PDF's pages, a presentation's slides, or parts of about one budget of a document with no pages of its own. */
export type PageUnit = "page" | "slide" | "part";

export interface TextResult {
  text: string;
  truncated: boolean;
  pages_total?: number;
  pages?: { from: number; to: number };
  unit?: PageUnit;
  /** A PDF whose asked pages carry no text at all: a scan. */
  scanned?: boolean;
  /** The file could not be read (`note` says why): no text is not an empty file. */
  unreadable?: boolean;
  note?: string;
}


export async function extractText(job: TextJob): Promise<TextResult> {
  switch (job.format) {
    case "pdf":
      return pdfText(job);
    case "docx":
    case "xlsx":
    case "pptx":
    case "odt":
    case "ods":
    case "odp":
      try {
        return await officeText(job);
      } catch (err) {
        if (err instanceof ZipError) return { text: "", truncated: false, unreadable: true, note: `This ${job.format} could not be read: ${err.message}.` };
        throw err;
      }
    case "html":
      // The whole page up to the window, stripped before it is cut: a long <head> of styles or scripts must not use up the budget.
      return flowed(htmlText(decodeText(job.bytes, FLOW_MAX_BYTES)), job, job.bytes.length > FLOW_MAX_BYTES);
    case "text":
      return flowed(decodeText(job.bytes, FLOW_MAX_BYTES), job, job.bytes.length > FLOW_MAX_BYTES);
  }
}

/** How much of a text or HTML file is decoded: its parts can all be read, up to this. */
const FLOW_MAX_BYTES = 8_000_000;
/** Characters of a document with no pages of its own kept for its parts: about 170 answers. */
const FLOW_MAX_CHARS = 2_000_000;
/** What a part leaves of the budget for its "--- part N ---" marker. */
const PART_MARKER_ROOM = 40;

/**
 * A document with no pages of its own (Word, a spreadsheet, text, HTML) in
 * parts of about one budget each, cut at a line where one is near: `pages`
 * picks a part as it picks a PDF's page, so a long contract or export can be
 * read to its end, one answer at a time. A text within one budget comes back
 * whole, as it is.
 */
async function flowed(text: string, job: TextJob, cutShort = false): Promise<TextResult> {
  let tidy = tidyText(text);
  const notes: string[] = [];
  if (cutShort) notes.push(`Only its first ${FLOW_MAX_BYTES / 1_000_000} MB is read here.`);
  if (tidy.length > FLOW_MAX_CHARS) {
    tidy = tidy.slice(0, FLOW_MAX_CHARS);
    notes.push(`Only its first ${FLOW_MAX_CHARS.toLocaleString("en-US")} characters are read here.`);
  }
  const said = (note?: string): { note?: string } => {
    const all = [...(note === undefined ? [] : [note]), ...notes];
    return all.length === 0 ? {} : { note: all.join(" ") };
  };
  if (tidy === "" || (tidy.length <= job.budget && job.pages.from === 1)) return { text: tidy, truncated: false, ...said() };
  const parts = partsOf(tidy, job.budget - PART_MARKER_ROOM);
  const { chars: _chars, note, ...result } = await pagedTextAsync(parts.map((part) => () => part), job, "part");
  return { ...result, ...said(note) };
}

/** `text` in pieces of at most `size` characters, each cut at a line where one is near, never inside a character. */
function partsOf(text: string, size: number): string[] {
  const parts: string[] = [];
  let at = 0;
  while (at < text.length) {
    if (text.length - at <= size) {
      parts.push(text.slice(at));
      break;
    }
    const line = text.lastIndexOf("\n", at + size);
    let end = line > at + size * 0.8 ? line : at + size;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
    parts.push(text.slice(at, end));
    at = end;
    while (text[at] === "\n") at++;
  }
  return parts;
}

/** Blank runs collapsed, trailing spaces dropped. */
function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Bytes as text: UTF-16 by its byte-order mark; the charset an HTML or XML
 * file declares; UTF-8 when the bytes are valid UTF-8; otherwise a legacy
 * Windows code page, Central European (1250, which Romanian Excel saves CSV
 * in) or Western (1252), whichever the letters point to. Only the first
 * `limit` bytes are decoded: no budget needs more.
 */
export function decodeText(bytes: Uint8Array, limit: number): string {
  const head = bytes.subarray(0, Math.min(bytes.length, limit));
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder("utf-16le").decode(head.subarray(2));
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder("utf-16be").decode(head.subarray(2));
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return new TextDecoder("utf-8").decode(head.subarray(3));
  const declared = declaredCharset(head);
  if (declared !== null && declared !== "utf-8") return new TextDecoder(declared).decode(head);
  try {
    // `stream`: a character the limit cut in two is not an error.
    return new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: head.length < bytes.length });
  } catch {
    return new TextDecoder(legacyCodePage(head)).decode(head);
  }
}

/** The charset a file names for itself (`<meta charset>`, `http-equiv` content, `<?xml encoding?>`), when this runtime decodes it. */
function declaredCharset(head: Uint8Array): string | null {
  const start = Buffer.from(head.buffer, head.byteOffset, Math.min(head.length, 4096)).toString("latin1");
  const named = /<meta[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(start)?.[1] ?? /^\s*<\?xml[^>]*?encoding\s*=\s*["']([\w.:-]+)/i.exec(start)?.[1];
  if (named === undefined) return null;
  try {
    return new TextDecoder(named).encoding;
  } catch {
    return null;
  }
}

/**
 * Bytes that read as a letter in Windows-1250 (ă ş ţ Ş Ţ Ă ą Ą ł ś Ś ź Ź ť Ť ľ)
 * where Windows-1252 has a symbol or a rare letter, and the reverse (à è ò ì
 * ñ õ æ ø å À È Ñ ù ð ï). The two pages agree on most other letters
 * (é á í ó ú ä ö ü ß â î ç), so these decide.
 */
const CP1250_SIGNS = new Set([0xe3, 0xc3, 0xba, 0xaa, 0xfe, 0xde, 0xb9, 0xa5, 0xb3, 0x9c, 0x8c, 0x9f, 0x8f, 0x9d, 0x8d, 0xbe]);
const CP1252_SIGNS = new Set([0xe0, 0xe8, 0xf2, 0xec, 0xf1, 0xf5, 0xe6, 0xf8, 0xe5, 0xc0, 0xc8, 0xd1, 0xf9, 0xf0, 0xef]);

function legacyCodePage(head: Uint8Array): "windows-1250" | "windows-1252" {
  let central = 0;
  let western = 0;
  for (const byte of head) {
    if (CP1250_SIGNS.has(byte)) central++;
    else if (CP1252_SIGNS.has(byte)) western++;
  }
  return central > western ? "windows-1250" : "windows-1252";
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** XML and HTML character references, named (the few XML and HTML text needs) and numeric. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** Elements whose content is never shown: dropped up to their closing tag (an unclosed one, to the end, as a browser does). */
const HIDDEN_ELEMENTS = new Set(["script", "style", "noscript", "template", "svg", "title", "iframe", "object"]);
/** Closing tags that end a line of text. */
const BLOCK_ELEMENTS = new Set(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "section", "article", "blockquote", "pre", "ul", "ol"]);

/**
 * An HTML page's visible words: comments, scripts, styles and the like
 * dropped, blocks on lines of their own, cells apart by tabs. One pass from
 * left to right, with no pattern that can backtrack, so a hostile page of
 * megabytes takes as long as its length. A "<" that starts no tag is text.
 */
export function htmlText(html: string): string {
  const parts: string[] = [];
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open < 0) {
      parts.push(html.slice(at));
      break;
    }
    parts.push(html.slice(at, open));
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      at = end < 0 ? html.length : end + 3;
      continue;
    }
    const next = html.charCodeAt(open + 1);
    const startsTag = next === 0x2f || next === 0x21 || next === 0x3f || (next >= 0x41 && next <= 0x5a) || (next >= 0x61 && next <= 0x7a);
    if (!startsTag) {
      parts.push("<");
      at = open + 1;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    // No ">" anywhere after: no tag can follow, and the rest is text.
    if (close < 0) {
      parts.push(html.slice(open));
      break;
    }
    const name = /^\/?([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(open + 1, Math.min(close, open + 66)));
    const tag = name?.[1]?.toLowerCase() ?? "";
    const closing = html[open + 1] === "/";
    at = close + 1;
    if (!closing && HIDDEN_ELEMENTS.has(tag) && html[close - 1] !== "/") {
      const ending = new RegExp(`</${tag}\\s*>`, "gi");
      ending.lastIndex = at;
      const found = ending.exec(html);
      at = found === null ? html.length : found.index + found[0].length;
    } else if (tag === "br") {
      parts.push("\n");
    } else if (closing && BLOCK_ELEMENTS.has(tag)) {
      parts.push("\n");
    } else if (closing && (tag === "td" || tag === "th")) {
      parts.push("\t");
    }
  }
  return decodeEntities(parts.join(""));
}

/** XML with the given closing tags ended as lines (and cells as tabs), every tag dropped, entities decoded. */
function xmlText(xml: string, rules: { line: string[]; tab?: string[]; drop?: string[] }): string {
  let out = xml;
  for (const tag of rules.drop ?? []) out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "g"), "");
  out = out
    .replace(/<w:tab\/>|<text:tab\/>/g, "\t")
    .replace(/<w:(br|cr)\b[^>]*\/>|<a:br\b[^>]*\/>|<text:line-break\/>/g, "\n")
    .replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (_whole, count: string | undefined) => " ".repeat(Math.min(Number(count ?? 1), 100)));
  for (const tag of rules.line) out = out.replace(new RegExp(`</${tag}>`, "g"), "\n");
  for (const tag of rules.tab ?? []) out = out.replace(new RegExp(`</${tag}>`, "g"), "\t");
  return decodeEntities(out.replace(/<[^>]*>/g, ""));
}

/** Entries named `prefix<n>.xml`, in the order of n. */
function numbered(zip: ZipReader, pattern: RegExp): string[] {
  return zip.entries
    .map((entry) => ({ name: entry.name, n: Number(pattern.exec(entry.name)?.[1]) }))
    .filter((entry) => Number.isFinite(entry.n))
    .sort((a, b) => a.n - b.n)
    .map((entry) => entry.name);
}

async function officeText(job: TextJob): Promise<TextResult> {
  const zip = new ZipReader(Buffer.from(job.bytes.buffer, job.bytes.byteOffset, job.bytes.byteLength));
  switch (job.format) {
    case "docx": {
      const xml = zip.text("word/document.xml");
      if (xml === null) return { text: "", truncated: false, note: "This docx has no document part." };
      return flowed(xmlText(xml, { line: ["w:p"], drop: ["w:instrText", "w:delText"] }), job);
    }
    case "xlsx":
      return flowed(workbookText(zip), job);
    case "pptx": {
      const slides = numbered(zip, /^ppt\/slides\/slide(\d+)\.xml$/);
      return pagedText(slides.map((name) => () => xmlText(zip.text(name) ?? "", { line: ["a:p"] })), job, "slide");
    }
    case "odp": {
      const xml = zip.text("content.xml") ?? "";
      const slides = xml.split(/<draw:page\b/).slice(1);
      return pagedText(slides.map((slide) => () => xmlText(`<x${slide}`, { line: ["text:p", "text:h"] })), job, "slide");
    }
    case "ods": {
      const xml = zip.text("content.xml");
      if (xml === null) return { text: "", truncated: false, note: "This ods has no content part." };
      return flowed(spreadsheetText(xml), job);
    }
    default: {
      const xml = zip.text("content.xml");
      if (xml === null) return { text: "", truncated: false, note: `This ${job.format} has no content part.` };
      return flowed(xmlText(xml, { line: ["text:p", "text:h", "table:table-row"], tab: ["table:table-cell"] }), job);
    }
  }
}

/**
 * Empty cells written out before a value, so each value stays under its
 * column's header. Past this column a sheet's gaps are not spelled out: the
 * value is written with its reference instead ("AZ7=..."), so a stray cell
 * far to the right cannot become a line of thousands of tabs.
 */
const PADDED_COLUMNS = 64;

/** A row's cells as tab-separated text, each value at its column. */
class RowCells {
  private readonly cells: string[] = [];

  constructor(private readonly row: number) {}

  put(column: number | null, text: string): void {
    if (text === "") return;
    const value = text.replace(/[\t\n]/g, " ");
    if (column === null || column === this.cells.length) this.cells.push(value);
    else if (column < PADDED_COLUMNS && column > this.cells.length) {
      while (this.cells.length < column) this.cells.push("");
      this.cells.push(value);
    } else this.cells.push(`${columnLetters(column)}${this.row}=${value}`);
  }

  line(): string | null {
    return this.cells.length === 0 ? null : this.cells.join("\t");
  }
}

/** A 0-based column index as its letters: 0 is A, 27 is AB. */
function columnLetters(index: number): string {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

type DateKind = "date" | "time" | "datetime";

/** What a number format shows: a date, a time, both, or (null) a plain number. */
function formatKind(id: number, code: string | undefined): DateKind | null {
  if ((id >= 14 && id <= 17) || (id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return "date";
  if (id === 22) return "datetime";
  if ((id >= 18 && id <= 21) || (id >= 45 && id <= 47)) return "time";
  if (code === undefined) return null;
  // Quoted text, escaped characters and [colour]/[locale] sections say nothing of dates.
  const bare = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "").toLowerCase();
  const date = /[yd]/.test(bare);
  const time = /[hs]/.test(bare);
  return date && time ? "datetime" : date ? "date" : time ? "time" : null;
}

/** Which cell styles (by index in cellXfs) show a number as a date or a time. */
function dateStyles(styles: string | null): Map<number, DateKind> {
  const kinds = new Map<number, DateKind>();
  if (styles === null) return kinds;
  const codes = new Map(
    [...styles.matchAll(/<numFmt\b[^>]*\bnumFmtId="(\d+)"[^>]*\bformatCode="([^"]*)"/g)].map((m) => [Number(m[1]), decodeEntities(m[2]!)])
  );
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  [...xfs.matchAll(/<xf\b([^>]*)/g)].forEach((xf, index) => {
    const id = Number(/\bnumFmtId="(\d+)"/.exec(xf[1]!)?.[1] ?? 0);
    const kind = formatKind(id, codes.get(id));
    if (kind !== null) kinds.set(index, kind);
  });
  return kinds;
}

/** The last day Excel shows as a date: 31 December 9999. Past it, and below 0, a date cell shows its number (Excel shows ####). */
const SERIAL_MAX = 2_958_465;

/**
 * A spreadsheet serial number as the date, time or both it stands for (the
 * 1900 system, or 1904); null for a number no date stands for, such as a
 * phone number typed into a date column.
 */
function serialDate(serial: number, kind: DateKind, from1904: boolean): string | null {
  // Excel counts 1900 as a leap year: from March 1900 on, day 0 is 30 December 1899.
  const days = from1904 ? serial + 1462 : serial < 61 ? serial + 1 : serial;
  if (!(serial >= 0 && days < SERIAL_MAX + 1)) return null;
  const at = new Date(Date.UTC(1899, 11, 30) + Math.round(days * 86_400) * 1000).toISOString();
  const time = at.slice(11, at.endsWith(":00.000Z") ? 16 : 19);
  return kind === "date" ? at.slice(0, 10) : kind === "time" ? time : `${at.slice(0, 10)} ${time}`;
}

/** An xlsx as tab-separated rows under each sheet's name: shared strings resolved, values under their columns, dates as dates. */
function workbookText(zip: ZipReader): string {
  const shared: string[] = [];
  const strings = zip.text("xl/sharedStrings.xml");
  if (strings !== null) {
    for (const item of strings.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(decodeEntities([...item[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
    }
  }
  const workbook = zip.text("xl/workbook.xml") ?? "";
  const from1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook);
  const dates = dateStyles(zip.text("xl/styles.xml"));
  const rels = zip.text("xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]+)"/g)].map((m) => ({
    name: decodeEntities(m[1]!),
    path: `xl/${(targets.get(m[2]!) ?? "").replace(/^\/?xl\//, "").replace(/^\//, "")}`,
  }));
  const listed = sheets.length > 0 ? sheets : numbered(zip, /^xl\/worksheets\/sheet(\d+)\.xml$/).map((path, i) => ({ name: `Sheet${i + 1}`, path }));
  const parts: string[] = [];
  for (const sheet of listed) {
    const xml = zip.text(sheet.path);
    if (xml === null) continue;
    const rows: string[] = [];
    let rowNumber = 0;
    for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      rowNumber = Number(/\br="(\d+)"/.exec(row[1]!)?.[1] ?? rowNumber + 1);
      const cells = new RowCells(rowNumber);
      for (const cell of row[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1] ?? "";
        const body = cell[2] ?? "";
        const column = columnIndex(/\br="([A-Z]+)\d+"/.exec(attrs)?.[1]);
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        const kind = dates.get(Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? -1));
        let text = "";
        if (type === "s" && value !== undefined) text = shared[Number(value)] ?? "";
        else if (type === "inlineStr") text = decodeEntities([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
        else if (type === "b") text = value === "1" ? "TRUE" : "FALSE";
        else if (value !== undefined && kind !== undefined && (type === undefined || type === "n") && Number.isFinite(Number(value))) {
          text = serialDate(Number(value), kind, from1904) ?? value;
        } else if (value !== undefined) text = decodeEntities(value);
        cells.put(column, text);
      }
      const line = cells.line();
      if (line !== null) rows.push(line);
    }
    parts.push(`--- sheet ${sheet.name} ---\n${rows.join("\n")}`);
  }
  return parts.join("\n\n");
}

/** "AB" as a 0-based column index; null without one. */
function columnIndex(letters: string | undefined): number | null {
  if (letters === undefined) return null;
  let n = 0;
  for (const letter of letters) n = n * 26 + (letter.charCodeAt(0) - 64);
  return n - 1;
}

/** How many times a repeated OpenDocument row or cell that holds a value is written out. */
const REPEATS_SHOWN = 64;

/**
 * An OpenDocument spreadsheet as tab-separated rows under each sheet's name:
 * cells repeated by `number-columns-repeated` (how ODS stores runs of empty
 * cells) counted out, so values stay under their columns, as in an xlsx.
 */
function spreadsheetText(xml: string): string {
  const parts: string[] = [];
  for (const table of xml.matchAll(/<table:table(?=[\s>])([^>]*)>([\s\S]*?)<\/table:table>/g)) {
    const name = decodeEntities(/\btable:name="([^"]*)"/.exec(table[1]!)?.[1] ?? "");
    const rows: string[] = [];
    let rowNumber = 0;
    for (const row of table[2]!.matchAll(/<table:table-row(?=[\s>/])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)) {
      const rowRepeat = Math.max(1, Number(/\btable:number-rows-repeated="(\d+)"/.exec(row[1]!)?.[1] ?? 1));
      const cells = new RowCells(rowNumber + 1);
      let column = 0;
      for (const cell of (row[2] ?? "").matchAll(/<table:(covered-table-cell|table-cell)(?=[\s>/])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:\1>)/g)) {
        const repeat = Math.max(1, Number(/\btable:number-columns-repeated="(\d+)"/.exec(cell[2]!)?.[1] ?? 1));
        const text = xmlText(cell[3] ?? "", { line: ["text:p", "text:h"], drop: ["office:annotation"] }).trim().replace(/\s*\n\s*/g, " ");
        if (text !== "") for (let i = 0; i < Math.min(repeat, REPEATS_SHOWN); i++) cells.put(column + i, text);
        column += repeat;
      }
      const line = cells.line();
      if (line !== null) for (let i = 0; i < Math.min(rowRepeat, REPEATS_SHOWN); i++) rows.push(line);
      rowNumber += rowRepeat;
    }
    parts.push(`--- sheet ${name} ---\n${rows.join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * Pages (or slides) read one at a time from `from`, each under a marker,
 * until `to` or the budget: a page that does not fit is cut only when it is
 * the first, so an answer never ends mid-page otherwise.
 */
async function pagedTextAsync(pages: Array<() => Promise<string> | string>, job: TextJob, unit: PageUnit): Promise<TextResult & { chars: number[] }> {
  const total = pages.length;
  if (job.pages.from > total) {
    return { text: "", truncated: false, pages_total: total, unit, chars: [], note: `It has ${total} ${unit}${total === 1 ? "" : "s"}; ${unit} ${job.pages.from} is past its end.` };
  }
  const last = Math.min(total, job.pages.to ?? total);
  const parts: string[] = [];
  const chars: number[] = [];
  let used = 0;
  let reached = job.pages.from - 1;
  let truncated = false;
  for (let page = job.pages.from; page <= last; page++) {
    const body = tidyText(await pages[page - 1]!());
    chars.push(body.length);
    const block = total > 1 ? `--- ${unit} ${page} ---\n${body}` : body;
    if (used + block.length + 2 > job.budget) {
      if (parts.length === 0) {
        parts.push(block.slice(0, job.budget));
        reached = page;
      }
      truncated = true;
      break;
    }
    parts.push(block);
    used += block.length + 2;
    reached = page;
  }
  if (job.pages.to === null && reached < total) truncated = true;
  return { text: parts.join("\n\n"), truncated, pages_total: total, pages: { from: job.pages.from, to: reached }, unit, chars };
}

async function pagedText(pages: Array<() => string>, job: TextJob, unit: PageUnit): Promise<TextResult> {
  const { chars: _chars, ...result } = await pagedTextAsync(pages, job, unit);
  return result;
}

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

/** A PDF's text layer, page by page from the first asked, with the page count; a scan says so. */
async function pdfText(job: TextJob): Promise<TextResult> {
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(job.bytes, {
    // No fonts loaded or installed, and no warnings printed (the worker's console would reach stdout).
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  const readers = Array.from({ length: doc.numPages }, (_, i) => async () => {
    const page = await doc.getPage(i + 1);
    const content = await page.getTextContent();
    page.cleanup();
    return (content.items as PdfTextItem[]).map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : "")).join("");
  });
  const { chars, ...result } = await pagedTextAsync(readers, job, "page");
  // No visible character on any page asked: a scan, whose words are only in its picture. A page with a
  // few words is text, however short, and is returned as such.
  const scanned = chars.length > 0 && chars.every((count) => count === 0);
  return scanned ? { ...result, text: "", truncated: false, scanned: true } : result;
}
