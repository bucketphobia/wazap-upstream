/**
 * Signed links to originals (src/media-links.ts): minted by get_media for a
 * remote session on a server with a public URL, never for a local one or
 * without that URL; served by GET /media/:token as an attachment, and a 404
 * alike for a forged, expired or tampered link, another account's, or a
 * message gone since.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { join } from "node:path";

import { WhatsAppService } from "../dist/whatsapp.js";
import { MediaLinks, MEDIA_LINK_KEY_FILE, attachmentDisposition, linkSecret, mediaLinksFor, sidTag } from "../dist/media-links.js";
import { drainHttpEndpoints, startHttpEndpoint } from "../dist/server.js";
import { asToolSource, connectedService, schemaCheckedTools } from "./helpers.mjs";
import { pdfOf } from "./media-fixtures.mjs";

const ANA = "40700000002@s.whatsapp.net";
const PUBLIC = "https://wazap.example";

async function setup(t) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-links-", id: "40700000001@s.whatsapp.net", name: "Me" });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  const config = { ...svc.config, publicUrl: PUBLIC };
  const links = mediaLinksFor(config);
  const remote = schemaCheckedTools(svc, { allowWrite: false, allowLocalFiles: false, mediaLinks: links });
  const pdf = pdfOf([["Factura 12"]]);
  svc.mediaBuffer = async () => pdf;
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: ANA, fromMe: false, id: "F1" }, message: { documentMessage: { mimetype: "application/pdf", fileName: "factură \"mai\".pdf", fileLength: pdf.length } }, messageTimestamp: Math.floor(Date.now() / 1000) }],
  });
  const sid = `false_${ANA}_F1`;
  const stop = new AbortController();
  t.after(() => stop.abort());
  const port = await startHttpEndpoint(asToolSource(svc), config, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    signal: stop.signal,
    credentials: [{ token: "synthetic-reader", write: false }],
  });
  const local = (url) => url.replace(PUBLIC, `http://127.0.0.1:${port}`);
  return { svc, sock, sid, pdf, links, config, remote, local };
}

test("a link is a signed claim: it verifies until it expires, and any change to it fails", () => {
  let now = 1_800_000_000_000;
  const links = new MediaLinks(Buffer.alloc(32, 1), PUBLIC, () => now);
  const { url, expires_at } = links.mint({ account: "personal", row: 42, tag: sidTag("false_x_1") });
  assert.equal(expires_at, new Date(now + 30 * 60 * 1000).toISOString());
  const token = url.slice(`${PUBLIC}/media/`.length);
  assert.deepEqual(links.verify(token), { account: "personal", row: 42, tag: sidTag("false_x_1"), expires: now + 30 * 60 * 1000 });
  assert.ok(!url.includes("false_x_1") && !url.includes("whatsapp.net"), "no message id or number in the URL");

  const [payload, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ a: "personal", r: 43, t: sidTag("false_x_1"), e: 9_999_999_999 })).toString("base64url");
  assert.equal(links.verify(`${forged}.${signature}`), null, "another payload under the same signature");
  assert.equal(links.verify(`${payload}.${signature.slice(0, -2)}AA`), null, "a changed signature");
  assert.equal(new MediaLinks(Buffer.alloc(32, 2), PUBLIC, () => now).verify(token), null, "another install's secret");
  for (const junk of ["", ".", "a.b.c", "x".repeat(600), `${payload}.`]) assert.equal(links.verify(junk), null, JSON.stringify(junk.slice(0, 20)));
  now += 30 * 60 * 1000;
  assert.equal(links.verify(token), null, "expired");
});

test("the install's secret is made once, kept owner-only, and reused", (t) => {
  const { svc } = connectedService(WhatsAppService, { prefix: "wazap-secret-", id: "40700000001@s.whatsapp.net", name: "Me" });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  const first = linkSecret(svc.config.dataDir);
  const file = join(svc.config.dataDir, MEDIA_LINK_KEY_FILE);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(first.length, 32);
  assert.deepEqual(linkSecret(svc.config.dataDir), first);
  assert.deepEqual(readFileSync(file), first);
});

test("a short or empty key left by a crash is replaced, and the HTTP endpoint starts either way", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, MEDIA_LINK_KEY_FILE);
  writeFileSync(file, Buffer.alloc(0), { mode: 0o600 });
  const secret = linkSecret(dir);
  assert.equal(secret.length, 32);
  assert.deepEqual(readFileSync(file), secret);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), [MEDIA_LINK_KEY_FILE], "no temporary file is left");
  writeFileSync(file, Buffer.alloc(7, 1));
  assert.ok(mediaLinksFor({ dataDir: dir, publicUrl: PUBLIC }) instanceof MediaLinks);
  assert.equal(readFileSync(file).length, 32);

  // A data dir the secret cannot be written to: no links, and no throw that would stop the listener.
  if (process.getuid?.() === 0) return;
  const locked = mkdtempSync(join(tmpdir(), "wazap-locked-"));
  chmodSync(locked, 0o500);
  t.after(() => {
    chmodSync(locked, 0o700);
    rmSync(locked, { recursive: true, force: true });
  });
  assert.throws(() => linkSecret(locked), /could not be written/);
  assert.equal(mediaLinksFor({ dataDir: locked, publicUrl: PUBLIC }), null);
  const stop = new AbortController();
  t.after(() => stop.abort());
  const { svc } = connectedService(WhatsAppService, { prefix: "wazap-nokey-", id: "40700000001@s.whatsapp.net", name: "Me" });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  const port = await startHttpEndpoint(asToolSource(svc), { ...svc.config, dataDir: locked, publicUrl: PUBLIC }, {
    host: "127.0.0.1",
    port: 0,
    openRead: false,
    signal: stop.signal,
    credentials: [{ token: "synthetic-reader", write: false }],
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
});

test("the download is named for any client, and nothing in the name escapes its header", () => {
  assert.equal(attachmentDisposition('factură "mai"/../x.pdf', "application/pdf"), `attachment; filename="factur_ _mai_..x.pdf"; filename*=UTF-8''factur%C4%83%20%22mai%22..x.pdf`);
  assert.equal(attachmentDisposition(null, "image/jpeg"), `attachment; filename="whatsapp-media.jpeg"; filename*=UTF-8''whatsapp-media.jpeg`);
  // A long name with an emoji where the cut falls, and a lone surrogate: still a header, never a URIError.
  const long = attachmentDisposition(`${"a".repeat(199)}\u{1F600}.pdf`, "application/pdf");
  assert.match(long, /filename\*=UTF-8''a{199}%F0%9F%98%80$/);
  assert.match(attachmentDisposition("x\ud800y.pdf", "application/pdf"), /filename\*=UTF-8''xy\.pdf$/);
  assert.doesNotMatch(attachmentDisposition("a\r\nSet-Cookie: x", "text/plain"), /[\r\n]/);
});

test("get_media gives a remote session a link that serves the original as a safe attachment", async (t) => {
  const { sid, pdf, remote, local } = await setup(t);
  const result = await remote.call("get_media", { message_id: sid });
  const { link } = result.structuredContent;
  assert.ok(link.url.startsWith(`${PUBLIC}/media/`));
  assert.ok(Date.parse(link.expires_at) - Date.now() > 29 * 60 * 1000);
  assert.match(result.content[0].text, /The original file, to open \(valid 30 minutes\): https:\/\/wazap\.example\/media\//);

  const response = await fetch(local(link.url));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.match(response.headers.get("content-disposition"), /^attachment; filename="factur_ _mai_.pdf"; filename\*=UTF-8''/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /sandbox/);
});

test("a tampered, expired, other-account or stale link is a 404, like a deleted message's", async (t) => {
  const { svc, sock, sid, links, config, local } = await setup(t);
  const ref = svc.mediaLinkRef(sid);
  const good = links.mint({ account: "default", ...ref }).url;
  const status = async (url) => (await fetch(local(url))).status;
  assert.equal(await status(good), 200);
  assert.equal(await status(`${good.slice(0, -3)}xyz`), 404, "tampered");
  assert.equal(await status(links.mint({ account: "other", ...ref }).url), 404, "an account this server does not have");
  assert.equal(await status(links.mint({ account: "default", row: ref.row, tag: sidTag("false_x_other") }).url), 404, "a row that is not that message");
  const past = new MediaLinks(linkSecret(config.dataDir), PUBLIC, () => Date.now() - 31 * 60 * 1000).mint({ account: "default", ...ref }).url;
  assert.equal(await status(past), 404, "expired");
  const notFound = await fetch(local(`${PUBLIC}/media/nonsense`));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.headers.get("cache-control"), "private, no-store");

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: ANA, fromMe: false, id: "R1" }, message: { protocolMessage: { type: 0, key: { remoteJid: ANA, fromMe: false, id: "F1" } } }, messageTimestamp: Math.floor(Date.now() / 1000) }],
  });
  assert.equal(await status(good), 404, "deleted since the link was made");
});

test("no link for a local session, nor for a remote one on a server without a public URL", async (t) => {
  const { svc, sid } = await setup(t);
  const local = schemaCheckedTools(svc, { allowWrite: false, mediaLinks: mediaLinksFor({ ...svc.config, publicUrl: PUBLIC }) });
  assert.equal((await local.call("get_media", { message_id: sid })).structuredContent.link, undefined);
  const remote = schemaCheckedTools(svc, { allowWrite: false, allowLocalFiles: false });
  const answer = await remote.call("get_media", { message_id: sid });
  assert.equal(answer.structuredContent.link, undefined);
  assert.doesNotMatch(answer.content[0].text, /https?:\/\//);
});

test("the token never reaches the HTTP log", async (t) => {
  const { sid, remote, local } = await setup(t);
  const { link } = (await remote.call("get_media", { message_id: sid })).structuredContent;
  const token = link.url.split("/media/")[1];
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk, encoding, callback) {
    chunks.push(String(chunk));
    const done = typeof encoding === "function" ? encoding : callback;
    done?.();
    return true;
  };
  try {
    await (await fetch(local(link.url))).arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.stderr.write = original;
  }
  const logged = chunks.join("");
  assert.match(logged, /HTTP GET \/media\/<redacted> rpc=- noauth/);
  assert.ok(!logged.includes(token.slice(0, 20)), "no part of the token is logged");
});

/** GET (or HEAD) a link with node:http, so what goes over the wire (its encoding, its bytes) is read as sent. */
function rawGet(url, { headers = {}, sent, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), at: Date.now() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    sent?.(req);
    req.end();
  });
}

test("a link's file goes out as it is, never gzipped, with its own headers, to a client that takes gzip", async (t) => {
  const { sid, pdf, remote, local } = await setup(t);
  const { link } = (await remote.call("get_media", { message_id: sid })).structuredContent;
  const response = await rawGet(local(link.url), { headers: { "accept-encoding": "gzip, deflate, br" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-encoding"], undefined, "compression is /mcp's alone");
  assert.deepEqual(response.body, pdf);
  assert.equal(response.headers["content-length"], String(pdf.length));
  assert.match(response.headers["content-disposition"], /^attachment; /);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.ok(response.headers["ratelimit-limit"] ?? response.headers["ratelimit-policy"] ?? response.headers.ratelimit, "the route's own limiter answered");
});

test("a shutdown lets a link download under way finish before it closes", async (t) => {
  const { svc, sid, pdf, remote, local } = await setup(t);
  const { link } = (await remote.call("get_media", { message_id: sid })).structuredContent;
  let finished = null;
  let reached;
  const started = new Promise((resolve) => (reached = resolve));
  svc.keep.read = async () => null;
  svc.mediaBuffer = async () => {
    reached();
    await new Promise((resolve) => setTimeout(resolve, 400));
    finished = Date.now();
    return pdf;
  };
  const download = rawGet(local(link.url));
  await started;
  const drainStarted = Date.now();
  await drainHttpEndpoints();
  const response = await download;
  assert.equal(response.status, 200, "answered, not cut off");
  assert.deepEqual(response.body, pdf);
  assert.ok(finished !== null && response.at >= finished);
  assert.ok(Date.now() - drainStarted < 5_000);
});

test("a fetch that goes away stops the download behind its link", async (t) => {
  const { svc, sid, remote, local } = await setup(t);
  const { link } = (await remote.call("get_media", { message_id: sid })).structuredContent;
  let signal;
  let reached;
  const started = new Promise((resolve) => (reached = resolve));
  svc.keep.read = async () => null;
  svc.mediaBuffer = (_sock, _sid, _raw, _maxBytes, opts = {}) => {
    signal = opts.signal;
    reached();
    return new Promise((_resolve, reject) => opts.signal?.addEventListener("abort", () => reject(opts.signal.reason), { once: true }));
  };
  let req;
  const gone = rawGet(local(link.url), { sent: (sent) => (req = sent) }).catch((err) => err);
  await started;
  assert.equal(signal?.aborted, false);
  req.destroy();
  await gone;
  for (let i = 0; i < 50 && signal.aborted !== true; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(signal.aborted, true, "the download's signal aborted when the fetch left");
});

test("a HEAD on a link answers from the message alone: nothing is downloaded and the phone is not asked", async (t) => {
  const { svc, sock, sid, pdf, remote, local } = await setup(t);
  const { link } = (await remote.call("get_media", { message_id: sid })).structuredContent;
  let originals = 0;
  const original = svc.mediaOriginal.bind(svc);
  svc.mediaOriginal = (...args) => {
    originals++;
    return original(...args);
  };
  let downloads = 0;
  svc.keep.read = async () => null;
  svc.mediaBuffer = async () => {
    downloads++;
    return pdf;
  };
  let asked = 0;
  sock.updateMediaMessage = async () => {
    asked++;
    throw new Error("not for a HEAD");
  };

  const head = await rawGet(local(link.url), { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(originals, 0, "the file is not fetched for an answer without a body");
  assert.equal(downloads, 0);
  assert.equal(asked, 0);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers["content-type"], "application/pdf");
  assert.match(head.headers["content-disposition"], /^attachment; filename="factur_ _mai_.pdf"; filename\*=UTF-8''/);
  assert.equal(head.headers["content-length"], undefined, "no length is promised before the file is fetched");
  assert.equal(head.headers["cache-control"], "private, no-store");
  assert.equal(head.headers["x-content-type-options"], "nosniff");
  assert.match(head.headers["content-security-policy"], /sandbox/);
  assert.equal(head.headers["content-encoding"], undefined);

  assert.equal((await rawGet(local(`${link.url.slice(0, -3)}xyz`), { method: "HEAD" })).status, 404, "a tampered link");
  const get = await rawGet(local(link.url));
  assert.equal(get.status, 200, "the GET after it fetches the file");
  assert.deepEqual(get.body, pdf);
  assert.equal(originals, 1);

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: ANA, fromMe: false, id: "R2" }, message: { protocolMessage: { type: 0, key: { remoteJid: ANA, fromMe: false, id: "F1" } } }, messageTimestamp: Math.floor(Date.now() / 1000) }],
  });
  const gone = await rawGet(local(link.url), { method: "HEAD" });
  assert.equal(gone.status, 404, "a message deleted since");
  assert.equal(gone.headers["cache-control"], "private, no-store");
  assert.equal(originals, 1);
});
