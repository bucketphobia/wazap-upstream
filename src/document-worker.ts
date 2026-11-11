/**
 * The document worker: one thread per document read, so a PDF's parse or an
 * Office file's XML never holds the event loop, and a hostile file that
 * exhausts memory or loops ends this thread (by its resource limits, the
 * memory watch or the timeout in src/documents.ts), not the server. A PDF's
 * streams are measured first (src/pdf-guard.ts): a plain compression bomb
 * is refused before pdf.js sees it, and a file refused here is not drawn by
 * poppler either. Its console is not the server's stderr guard: anything pdf.js
 * prints is silenced here, and the thread's own stdout is drained by the
 * parent, so nothing reaches the MCP channel.
 */
import { parentPort, workerData } from "node:worker_threads";
import { extractText, type TextJob } from "./document-text.js";
import { pdfBombReason } from "./pdf-guard.js";

const quiet = (): void => {};
console.log = quiet;
console.info = quiet;
console.debug = quiet;
console.warn = quiet;
console.error = quiet;

const job = workerData as TextJob;
const refused = job.format === "pdf" ? pdfBombReason(job.bytes) : null;
if (refused !== null) {
  parentPort?.postMessage({ ok: false, message: refused, hostile: true });
} else {
  extractText(job).then(
    (result) => parentPort?.postMessage({ ok: true, result }),
    (err: unknown) => parentPort?.postMessage({ ok: false, message: err instanceof Error ? err.message.split("\n")[0] : "unreadable" })
  );
}
