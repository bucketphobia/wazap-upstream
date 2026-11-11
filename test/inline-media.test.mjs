/**
 * A cloud agent's own file, sent in the call: send_message takes data_base64
 * with filename (and mime when it knows it), up to 5 MB decoded, kept like a
 * URL's file when drafted and sent exactly. Over HTTP only a write credential
 * may send a body that large, with its length declared, while the large
 * bodies under way leave room; everyone else keeps the 100 KiB limit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WhatsAppService } from "../dist/whatsapp.js";
import { MCP_BODY_MAX_BYTES, MCP_WRITE_BODY_MAX_BYTES, startHttpEndpoint } from "../dist/server.js";
import { asToolSource, connectedService, schemaCheckedTools, textError } from "./helpers.mjs";
import { pdfOf } from "./media-fixtures.mjs";

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

function setup(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-inline-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-inline-",
    id: ME,
    name: "Răzvan",
    config: { dataDir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0 },
  });
  t.after(() => svc.stop());
  sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
  sock.waUploadToServer = async () => ({ mediaUrl: "https://mmg.whatsapp.net/synthetic", directPath: "/synthetic" });
  const sent = [];
  sock.relayMessage = async (jid, message, options) => {
    sent.push({ jid, message });
    return options.messageId;
  };
  const outgoing = join(dataDir, "accounts", "default", "outgoing");
  const files = () => (existsSync(outgoing) ? readdirSync(outgoing).filter((name) => /^[0-9a-f]{64}$/.test(name)) : []);
  return { svc, sent, files, dataDir };
}

test("a remote agent's own file: drafted from data_base64, named in the preview, and sent byte for byte", async (t) => {
  const { svc, sent, files } = setup(t);
  // A remote session: no file_path, but a file of its own goes.
  const { call } = schemaCheckedTools(svc, { allowWrite: true, allowLocalFiles: false });
  const pdf = pdfOf([["Oferta 2026"]]);
  const draft = await call("send_message", { chat_id: PEER, text: "Oferta", data_base64: pdf.toString("base64"), filename: "oferta.pdf" });
  assert.equal(draft.structuredContent.status, "draft", draft.content[0].text);
  assert.deepEqual(draft.structuredContent.media, { filename: "oferta.pdf", mime: "application/pdf", size: pdf.length });
  assert.match(draft.structuredContent.preview, /\[document\] oferta\.pdf \(application\/pdf, \d+ KB\)\n"Oferta"/);
  assert.deepEqual(files(), [sha(pdf)]);
  const confirmed = await call("confirm_send", { draft_id: draft.structuredContent.draft_id });
  assert.equal(confirmed.isError, undefined, confirmed.content[0].text);
  const document = sent.at(-1).message.documentMessage;
  assert.equal(Buffer.from(document.fileSha256).toString("hex"), sha(pdf));
  assert.equal(document.fileName, "oferta.pdf");
  await svc.sends.collectPinned();
  assert.deepEqual(files(), []);
});

test("a data: URL, line breaks and URL-safe base64 read the same; the type comes from the bytes, the name, then mime", async (t) => {
  const { svc } = setup(t);
  const { call } = schemaCheckedTools(svc);
  const csv = Buffer.from("nume,suma\nAna,120\n");
  const wrapped = csv.toString("base64").replace(/(.{8})/g, "$1\n");
  const fromDataUrl = (await call("send_message", { chat_id: PEER, text: "", data_base64: `data:text/csv;base64,${wrapped}`, filename: "sume" })).structuredContent;
  assert.deepEqual(fromDataUrl.media, { filename: "sume.csv", mime: "text/csv", size: csv.length });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xfb, 0xff, 0xfe, ...Buffer.alloc(40)]);
  const urlSafe = png.toString("base64url");
  const image = (await call("send_message", { chat_id: PEER, text: "uite", data_base64: urlSafe, filename: "poza.bin", mime: "application/octet-stream" })).structuredContent;
  assert.equal(image.media.mime, "image/png", "the bytes say PNG");
  assert.match(image.preview, /\[image\] poza\.bin \(image\/png, 1 KB\)/);
});

test("data_base64 is refused when it is not base64, empty, over 5 MB, unnamed, or beside another source", async (t) => {
  const { svc, files } = setup(t);
  const { call } = schemaCheckedTools(svc);
  const b64 = Buffer.from("x").toString("base64");
  for (const [args, code, pattern] of [
    [{ data_base64: "not base64 at all!", filename: "a.txt" }, "INVALID_ID", /not base64/],
    [{ data_base64: "====", filename: "a.txt" }, "INVALID_ID", /not base64/],
    [{ data_base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64"), filename: "big.bin" }, "FILE_TOO_LARGE", /at most 5 MB/],
    // Past the 5 MB by more than the slack a schema length would leave: still the answer with its fix, not a schema error.
    [{ data_base64: Buffer.alloc(Math.round(5.6 * 1024 * 1024)).toString("base64"), filename: "big.bin" }, "FILE_TOO_LARGE", /5\.6 MB; data_base64 takes at most 5 MB/],
    [{ data_base64: b64 }, "INVALID_ID", /needs filename/],
    [{ data_base64: b64, filename: "a.txt", mime: "not a type" }, "INVALID_ID", /is not a media type/],
    [{ data_base64: b64, filename: "a.txt", url: "https://example.com/a" }, "INVALID_ID", /one place/],
    [{ filename: "a.txt" }, "INVALID_ID", /filename does not apply/],
    [{ mime: "text/plain" }, "INVALID_ID", /mime does not apply/],
  ]) {
    const refused = textError(await call("send_message", { chat_id: PEER, text: args.data_base64 === undefined ? "salut" : "", ...args }));
    assert.equal(refused.error, code, JSON.stringify(args).slice(0, 80));
    assert.match(refused.message, pattern);
  }
  assert.deepEqual(files(), []);
});

test("a type WhatsApp's own viewer or player does not take goes as a document, with its caption", async (t) => {
  const { svc, sent } = setup(t);
  const { call } = schemaCheckedTools(svc);
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Buffer.alloc(200)]);
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(200)]);
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(200)]);
  const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif\0\0\0\0avifmif1miaf"), Buffer.alloc(200)]);
  for (const [bytes, filename, mime] of [[webm, "clip.webm", "video/webm"], [wav, "nota.wav", "audio/wav"], [heic, "IMG_1.heic", "image/heic"], [avif, "poza.avif", "image/avif"]]) {
    const draft = await call("send_message", { chat_id: PEER, text: "uite", data_base64: bytes.toString("base64"), filename });
    assert.equal(draft.structuredContent.status, "draft", draft.content[0].text);
    assert.match(draft.structuredContent.preview, new RegExp(`\\[document\\] ${filename.replace(".", "\\.")} \\(${mime.replace("/", "\\/")}, 1 KB\\)\n"uite"`));
    const confirmed = await call("confirm_send", { draft_id: draft.structuredContent.draft_id });
    assert.equal(confirmed.isError, undefined, confirmed.content[0].text);
    const document = sent.at(-1).message.documentMessage;
    assert.ok(document, `${filename} left as ${Object.keys(sent.at(-1).message)}`);
    assert.deepEqual([document.mimetype, document.fileName, document.caption], [mime, filename, "uite"]);
  }

  // An Office file whose name has no extension keeps the type the agent declared, and gets the extension it has.
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200)]);
  const draft = await call("send_message", { chat_id: PEER, text: "", data_base64: docx.toString("base64"), filename: "Raport trimestrial", mime: DOCX });
  assert.deepEqual(draft.structuredContent.media, { filename: "Raport trimestrial.docx", mime: DOCX, size: docx.length });
  await call("confirm_send", { draft_id: draft.structuredContent.draft_id });
  assert.deepEqual([sent.at(-1).message.documentMessage.mimetype, sent.at(-1).message.documentMessage.fileName], [DOCX, "Raport trimestrial.docx"]);
});

test("a file of the call's own may go later: it is kept with the scheduled message and sent at its time", async (t) => {
  const { svc, sent, files } = setup(t);
  const clock = { now: Date.now() };
  svc.schedule.now = () => clock.now;
  svc.enableSchedule(() => ({ id: "default", name: "default", enabled: true, owner: null }));
  const { call } = schemaCheckedTools(svc);
  const pdf = pdfOf([["Pentru mâine"]]);
  const at = new Date(Date.now() + 10 * 60_000).toISOString();
  const draft = await call("send_message", { chat_id: PEER, text: "", data_base64: pdf.toString("base64"), filename: "maine.pdf", send_at: at });
  assert.equal(draft.structuredContent.status, "draft", draft.content[0].text);
  const scheduled = await call("confirm_send", { draft_id: draft.structuredContent.draft_id });
  assert.equal(scheduled.structuredContent.status, "scheduled");
  assert.deepEqual(files(), [sha(pdf)]);
  clock.now = Date.parse(at) + 1000;
  await svc.scheduleIdle();
  assert.equal(Buffer.from(sent.at(-1).message.documentMessage.fileSha256).toString("hex"), sha(pdf));
  await svc.sends.collectPinned();
  assert.deepEqual(files(), []);
});

/** A raw POST to /mcp: the status, and the body, sent all at once or `held` (only part, then nothing). */
function post(base, token, { body, length = body.length, chunked = false, held = false }) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(chunked ? { "transfer-encoding": "chunked" } : { "content-length": String(length) }),
      },
    });
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, retryAfter: res.headers["retry-after"], text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", (err) => (held ? resolve({ status: "aborted" }) : reject(err)));
    if (held) {
      req.write(body.subarray(0, 1024));
      resolve({ req });
      return;
    }
    req.end(body);
  });
}

test("over HTTP only a write credential's declared body may pass 100 KiB, up to 8 MiB, while four of the largest at most are in flight", async (t) => {
  const { svc } = setup(t);
  const stop = new AbortController();
  t.after(() => stop.abort());
  const port = await startHttpEndpoint(asToolSource(svc), { ...svc.config, readOnly: false }, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    signal: stop.signal,
    credentials: [
      { token: "synthetic-writer", write: true },
      { token: "synthetic-reader", write: false },
    ],
  });
  const base = `http://127.0.0.1:${port}`;
  const big = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x".repeat(MCP_BODY_MAX_BYTES * 2), version: "1" } } }));
  assert.ok(big.length > MCP_BODY_MAX_BYTES && big.length < MCP_WRITE_BODY_MAX_BYTES);

  assert.equal((await post(base, "synthetic-writer", { body: big })).status, 200, "a write credential's declared body passes");
  // Past a limit, the answer is JSON-RPC: the MCP client shows its words to the agent, the limit and what to do instead.
  const tooLarge = (answer) => (answer.status === 413 ? JSON.parse(answer.text).error.message : `status ${answer.status}`);
  assert.match(tooLarge(await post(base, "synthetic-reader", { body: big })), /read-only connection carries at most 100 KB/, "a read credential keeps 100 KiB");
  assert.match(tooLarge(await post(base, "synthetic-writer", { body: big, chunked: true })), /its length declared/, "no declared length: 100 KiB");
  const huge = Buffer.alloc(MCP_WRITE_BODY_MAX_BYTES + 1, 0x20);
  assert.match(tooLarge(await post(base, "synthetic-writer", { body: huge })), /at most 8 MB.*data_base64 at its 5 MB\. Put a larger file at a public URL and pass url/);

  // send_message's data_base64 at its 5 MB, wrapped as MIME wraps it (CRLF every 76 characters), fits a write credential's body.
  const wrapped = Buffer.alloc(5 * 1024 * 1024, 0xab).toString("base64").replace(/(.{76})/g, "$1\r\n");
  const call = { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "send_message", arguments: { chat_id: PEER, text: "x".repeat(4096), data_base64: wrapped, filename: "raport.pdf" } } };
  assert.ok(Buffer.byteLength(JSON.stringify(call)) < MCP_WRITE_BODY_MAX_BYTES);

  // Four of the largest bodies on their way hold the pool; a fifth waits for room.
  const held = await Promise.all(Array.from({ length: 4 }, () => post(base, "synthetic-writer", { body: big, length: MCP_WRITE_BODY_MAX_BYTES, held: true })));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const refused = await post(base, "synthetic-writer", { body: big });
  assert.equal(refused.status, 503);
  assert.equal(refused.retryAfter, "2");
  assert.equal((await post(base, "synthetic-writer", { body: Buffer.from('{"jsonrpc":"2.0"}') })).status !== 503, true, "a small body is never held up");
  for (const { req } of held) req.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await post(base, "synthetic-writer", { body: big })).status, 200, "room again once they are gone");
});
