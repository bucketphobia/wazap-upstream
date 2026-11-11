/**
 * Documents for an agent that cannot open a file: what kind a file is, its
 * text (read in a worker thread, src/document-worker.ts), and a picture of a
 * PDF page when this machine has a renderer: poppler's pdftoppm, or on macOS
 * Quick Look (qlmanage) for the first page. A PDF that is a scan has no text
 * layer, and the page picture is then what there is to read.
 *
 * Memory is bounded three ways, since the worker's heap limit does not count
 * the ArrayBuffers pdf.js unpacks streams into: the worker measures a PDF's
 * streams before reading it (src/pdf-guard.ts, a first line that a crafted
 * file can get past), the process's resident memory is watched while a
 * worker runs, and the renderer is one child at a time under a memory limit
 * of its own (src/native-run.ts). The two watches are the real bound.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Worker } from "node:worker_threads";
import type { DocumentFormat, TextResult } from "./document-text.js";
import { callCancelled } from "./cancel.js";
import { runNative, Slots } from "./native-run.js";
import { which } from "./transcribe/local.js";

/** Characters of a document's text one answer carries by default: about 3,000 tokens. */
export const TEXT_BUDGET = 12_000;
/** A document bigger than this is not parsed: the worker would need more memory than it is given. */
export const DOCUMENT_TEXT_MAX_BYTES = 50_000_000;
/** How long a document read may take before its thread is stopped. */
const TEXT_TIMEOUT_MS = 20_000;
/** What one document read may use on its heap. A file that needs more is reported unreadable. */
const WORKER_LIMITS = { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 48, stackSizeMb: 4 };
/** Document reads running at once, process-wide; the rest wait their turn. */
const readSlots = new Slots(2);
/** Page pictures drawn at once, process-wide: one renderer child at a time. */
const renderSlots = new Slots(1);
const RENDER_TIMEOUT_MS = 20_000;

/**
 * What a document read and a page render may grow memory by: the process's
 * resident memory while a worker reads (heap, and the ArrayBuffers the heap
 * limit misses), and the renderer child's own. Tests lower them.
 */
export const DOCUMENT_MEMORY = { readGrowthBytes: 512_000_000, renderBytes: 512_000_000 };
/** How often the process's memory is read while a worker runs. */
const WATCH_MS = 100;

/** A document read that failed. `hostile`: the file was refused, or outgrew its memory: nothing else should parse it. */
export class DocumentReadError extends Error {
  constructor(
    message: string,
    readonly hostile = false
  ) {
    super(message);
  }
}

const MIME_FORMATS: Record<string, DocumentFormat> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "application/json": "text",
  "application/xml": "text",
  "application/x-ndjson": "text",
  "application/csv": "text",
  "application/x-yaml": "text",
  "application/yaml": "text",
};

const EXTENSION_FORMATS: Record<string, DocumentFormat> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".pptx": "pptx",
  ".odt": "odt",
  ".ods": "ods",
  ".odp": "odp",
  ".html": "html",
  ".htm": "html",
  ".txt": "text",
  ".csv": "text",
  ".tsv": "text",
  ".md": "text",
  ".json": "text",
  ".xml": "text",
  ".log": "text",
  ".yaml": "text",
  ".yml": "text",
  ".ics": "text",
  ".vcf": "text",
};

/** Which reader a file needs, by its mime, then its name, then its first bytes; null for a kind with none. */
export function documentFormat(mime: string, filename: string | undefined, bytes: Buffer): DocumentFormat | null {
  const base = mime.toLowerCase().split(";")[0]!.trim();
  const byMime = MIME_FORMATS[base];
  if (byMime !== undefined) return byMime;
  if (base.startsWith("text/")) return "text";
  const byName = filename === undefined ? undefined : EXTENSION_FORMATS[extname(filename).toLowerCase()];
  if (byName !== undefined) return byName;
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  return null;
}

/**
 * The document's text from page `from` (1-based) to `to`, or until the budget
 * is spent, read in a worker thread with a heap cap, a watch on the process's
 * memory and a timeout. Rejects with a DocumentReadError and a short reason
 * when the file cannot be read.
 */
export function documentText(
  format: DocumentFormat,
  bytes: Buffer,
  pages: { from: number; to: number | null },
  budget = TEXT_BUDGET,
  signal?: AbortSignal
): Promise<TextResult> {
  if (bytes.length > DOCUMENT_TEXT_MAX_BYTES) {
    return Promise.reject(new DocumentReadError(`it is over ${DOCUMENT_TEXT_MAX_BYTES / 1_000_000} MB, more than is read here`));
  }
  return readSlots.run(
    () =>
      new Promise<TextResult>((resolve, reject) => {
        // A copy of its own, handed over: the download's buffer may share memory with others.
        const copy = new Uint8Array(bytes);
        const base = process.memoryUsage.rss();
        const worker = new Worker(new URL("./document-worker.js", import.meta.url), {
          workerData: { format, bytes: copy, pages, budget },
          transferList: [copy.buffer],
          resourceLimits: WORKER_LIMITS,
          stdout: true,
          stderr: true,
        });
        worker.stdout.resume();
        worker.stderr.resume();
        let settled = false;
        const finish = (outcome: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(watch);
          signal?.removeEventListener("abort", cancel);
          outcome();
          void worker.terminate();
        };
        const fail = (message: string, hostile = false): void => finish(() => reject(new DocumentReadError(message, hostile)));
        const timer = setTimeout(() => fail(`reading it took over ${TEXT_TIMEOUT_MS / 1000} s`), TEXT_TIMEOUT_MS);
        // The heap limit misses the ArrayBuffers a PDF's streams unpack into: the process's resident memory does not.
        const watch = setInterval(() => {
          if (process.memoryUsage.rss() - base > DOCUMENT_MEMORY.readGrowthBytes) fail("it needs more memory than a document read is given", true);
        }, WATCH_MS);
        watch.unref();
        // A cancelled call ends its read: the worker is terminated, its memory given back.
        const cancel = (): void => finish(() => reject(callCancelled()));
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
        worker.on("message", (message: { ok?: boolean; result?: TextResult; message?: string; hostile?: boolean }) => {
          if (message.ok === true) finish(() => resolve(message.result!));
          else fail(message.message ?? "unreadable", message.hostile === true);
        });
        worker.once("error", (err: Error & { code?: string }) =>
          err.code === "ERR_WORKER_OUT_OF_MEMORY" ? fail("it needs more memory than a document read is given", true) : fail("the reader failed")
        );
        worker.once("exit", () => fail("the reader stopped"));
      }),
    signal
  );
}

/**
 * Page `page` of a PDF as an image whose long edge is about `edge` px:
 * pdftoppm when poppler is installed (any page), else on macOS Quick Look,
 * which draws the first page only. One renderer runs at a time, under a time
 * and a memory limit; `signal` stops it. Null when neither can draw it, or
 * the render fails or is stopped.
 */
export async function pdfPageImage(pdf: Buffer, page: number, edge: number, signal?: AbortSignal): Promise<Buffer | null> {
  const pdftoppm = which("pdftoppm");
  const qlmanage = process.platform === "darwin" && page === 1 ? which("qlmanage") : null;
  if (pdftoppm === null && qlmanage === null) return null;
  return renderSlots.run(async () => {
    if (signal?.aborted) return null;
    const limits = { timeoutMs: RENDER_TIMEOUT_MS, maxRssBytes: DOCUMENT_MEMORY.renderBytes, ...(signal ? { signal } : {}) };
    const dir = await mkdtemp(join(tmpdir(), "wazap-page-"));
    try {
      const input = join(dir, "in.pdf");
      await writeFile(input, pdf, { mode: 0o600 });
      if (pdftoppm !== null) {
        const prefix = join(dir, "page");
        // JPEG, not PNG: poppler's PNG encoder takes about a second for a 1,024 px page, its JPEG 50 ms.
        await runNative(pdftoppm, ["-q", "-f", String(page), "-l", String(page), "-singlefile", "-jpeg", "-jpegopt", "quality=90", "-scale-to", String(edge), input, prefix], limits);
        return await readFile(`${prefix}.jpg`);
      }
      // Quick Look writes <name>.png into the output directory, and prints what it did on stdout (captured here).
      await runNative(qlmanage!, ["-t", "-s", String(edge), "-o", dir, input], limits);
      const made = (await readdir(dir)).find((name) => name.endsWith(".png"));
      return made === undefined ? null : await readFile(join(dir, made));
    } catch {
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, signal).catch((err: unknown) => (signal?.aborted === true ? null : Promise.reject(err)));
}
