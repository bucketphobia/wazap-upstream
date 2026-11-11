/**
 * Media from a URL is fetched when it is drafted and kept until it is sent:
 * the preview names the real file (its name, type by its bytes, size), the
 * send sends exactly those bytes without fetching again, a draft for later may
 * take a URL, and the kept file goes after the send, at the draft's expiry and
 * on a cancel. The fetch still passes the public-address guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";

import { WhatsAppService } from "../dist/whatsapp.js";
import { PinnedStore } from "../dist/pinned-media.js";
import { safeFilename, sniffMime } from "../dist/outgoing-media.js";
import { dispositionFilename } from "../dist/safe-media.js";
import { connectedService, schemaCheckedTools, storageRows, textError } from "./helpers.mjs";
import { pdfOf } from "./media-fixtures.mjs";

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const OWNER = "session_a";
const MINUTE = 60_000;
const RECORD = Object.freeze({ id: "default", name: "default", enabled: true, owner: null });

/** A web server on the public internet, as the fetch sees it: answers each URL with `routes[path]`. */
function web(routes) {
  const fetched = [];
  const request = (url, _options, cb) => {
    const path = new URL(String(url)).pathname;
    fetched.push(path);
    const route = routes[path] ?? { status: 404, body: Buffer.alloc(0) };
    const res = Readable.from(route.body.length === 0 ? [] : [route.body]);
    res.statusCode = route.status ?? 200;
    res.headers = { ...(route.type ? { "content-type": route.type } : {}), ...(route.headers ?? {}), "content-length": String(route.body.length) };
    res.socket = { remoteAddress: "93.184.216.34" };
    queueMicrotask(() => cb(res));
    return {
      on() {
        return this;
      },
      end() {},
    };
  };
  return { network: { request, requestTls: request, resolve: async () => [{ address: "93.184.216.34", family: 4 }] }, fetched };
}

function setup(t, routes, { config = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-pinned-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-pinned-",
    id: ME,
    name: "Răzvan",
    config: { dataDir, persistHistory: true, readOnly: false, rateLimitPerMinute: 0, ...config },
  });
  t.after(() => svc.stop());
  sock.onWhatsApp = async (jid) => [{ jid, exists: true }];
  const uploaded = [];
  sock.waUploadToServer = async (file) => {
    uploaded.push(file);
    return { mediaUrl: "https://mmg.whatsapp.net/synthetic", directPath: "/synthetic" };
  };
  const sent = [];
  sock.relayMessage = async (jid, message, options) => {
    sent.push({ jid, message });
    return options.messageId;
  };
  const server = web(routes);
  svc.mediaNetwork = server.network;
  const outgoing = join(dataDir, "accounts", "default", "outgoing");
  const files = () => (existsSync(outgoing) ? readdirSync(outgoing).filter((name) => /^[0-9a-f]{64}$/.test(name)) : []);
  return { svc, sock, sent, uploaded, server, outgoing, files, dataDir };
}

const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

test("after a redirect the preview names the host the file came from, and the one asked", async (t) => {
  const pdf = pdfOf([["Factura 12"]]);
  const routes = {
    "/url": { status: 302, body: Buffer.alloc(0), headers: { location: "https://attacker.example/payload.pdf?sig=SECRET" } },
    "/payload.pdf": { body: pdf, type: "application/pdf" },
  };
  const { svc, server } = setup(t, routes);
  const { call } = schemaCheckedTools(svc);
  const draft = await call("send_message", { chat_id: PEER, text: "Factura", url: "https://www.google.com/url?q=x&token=abc123" });
  const view = draft.structuredContent;
  assert.equal(view.status, "draft", draft.content[0].text);
  assert.deepEqual(server.fetched, ["/url", "/payload.pdf"]);
  assert.match(view.preview, /\[document\] payload\.pdf \(application\/pdf, \d+ KB\), already fetched from attacker\.example \(via www\.google\.com\)\n/);
  assert.ok(!/SECRET|abc123/.test(view.preview), "no query string in the preview");
});

test("a URL is fetched when drafted: the preview names the real file, and the yes sends exactly those bytes", async (t) => {
  const pdf = pdfOf([["Factura 12"]]);
  const routes = { "/download": { body: pdf, type: "application/octet-stream", headers: { "content-disposition": `attachment; filename*=UTF-8''factur%C4%83%2012.pdf` } } };
  const { svc, server, files, outgoing, uploaded, sent: sent_ } = setup(t, routes);
  const { call } = schemaCheckedTools(svc);

  const draft = await call("send_message", { chat_id: PEER, text: "Factura", url: "https://example.com/download" });
  const view = draft.structuredContent;
  assert.equal(view.status, "draft", draft.content[0].text);
  assert.deepEqual(view.media, { filename: "factură 12.pdf", mime: "application/pdf", size: pdf.length });
  // The user's yes comes after the fetch: the preview says the URL was already reached, and where.
  assert.match(view.preview, /\[document\] factură 12\.pdf \(application\/pdf, \d+ KB\), already fetched from example\.com\n"Factura"/);
  assert.deepEqual(server.fetched, ["/download"]);
  assert.deepEqual(files(), [sha(pdf)]);
  assert.equal(statSync(join(outgoing, sha(pdf))).mode & 0o777, 0o600);
  assert.equal(statSync(outgoing).mode & 0o777, 0o700);

  // What the URL serves by the yes is not what goes: the pinned bytes are.
  routes["/download"] = { body: Buffer.from("something else entirely"), type: "application/pdf" };
  const sent = await call("confirm_send", { draft_id: view.draft_id });
  assert.equal(sent.isError, undefined, sent.content[0].text);
  assert.deepEqual(server.fetched, ["/download"], "not fetched again at the send");
  assert.equal(uploaded.length, 1);
  const document = sent_.at(-1).message.documentMessage;
  assert.equal(Buffer.from(document.fileSha256).toString("hex"), sha(pdf), "the bytes that left are the ones drafted");
  assert.equal(document.fileName, "factură 12.pdf");
  assert.equal(document.mimetype, "application/pdf");
  await svc.sends.collectPinned();
  assert.deepEqual(files(), [], "sent: its file goes");
});

test("the type comes from the bytes, a name without an extension gets one, and a caption on audio is refused before anything is kept", async (t) => {
  const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(200)]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(100)]);
  const { svc, files } = setup(t, {
    "/voice": { body: ogg, type: "text/plain" },
    "/photo": { body: jpeg, type: "application/octet-stream" },
  });
  const { call } = schemaCheckedTools(svc);
  const refused = textError(await call("send_message", { chat_id: PEER, text: "ascultă", url: "https://example.com/voice" }));
  assert.equal(refused.error, "INVALID_ID");
  assert.match(refused.message, /audio\/ogg, which WhatsApp shows with no caption/);
  assert.deepEqual(files(), []);
  const photo = (await call("send_message", { chat_id: PEER, text: "", url: "https://example.com/photo" })).structuredContent;
  assert.deepEqual(photo.media, { filename: "photo.jpg", mime: "image/jpeg", size: jpeg.length });
  assert.match(photo.preview, /\[image\] photo\.jpg \(image\/jpeg, 1 KB\)/);

  assert.equal(sniffMime(pdfOf([["x"]]), "text/html", "x"), "application/pdf");
  assert.equal(sniffMime(Buffer.from("PK\x03\x04rest"), null, "raport.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(sniffMime(Buffer.from("a,b\n1,2\n"), "text/csv; charset=utf-8", "x"), "text/csv");
  assert.equal(safeFilename("../../etc/passwd", "text/plain"), "passwd.txt");
  assert.equal(safeFilename("a\u0000b\nc.pdf", "application/pdf"), "abc.pdf");
  assert.equal(dispositionFilename(`attachment; filename="raport final.pdf"`), "raport final.pdf");
  assert.equal(dispositionFilename(undefined), null);
});

test("a fetch that fails, or one the address guard refuses, drafts nothing and keeps nothing", async (t) => {
  const { svc, files, dataDir } = setup(t, {});
  const { call } = schemaCheckedTools(svc);
  assert.equal(textError(await call("send_message", { chat_id: PEER, text: "", url: "https://example.com/missing" })).error, "URL_FETCH_FAILED");
  svc.mediaNetwork = {};
  assert.equal(textError(await call("send_message", { chat_id: PEER, text: "", url: "http://169.254.169.254/latest/meta-data/" })).error, "MEDIA_ACCESS_DENIED");
  assert.deepEqual(files(), []);
  assert.equal(storageRows(svc, "SELECT count(*) AS n FROM sends")[0].n, 0);
  assert.ok(dataDir);
});

test("a URL may go later: scheduled, its pinned bytes go at their time, and a cancel or a lapse takes the file away", async (t) => {
  const pdf = pdfOf([["Contract"]]);
  const { svc, sent, files, server } = setup(t, { "/c.pdf": { body: pdf, type: "application/pdf" }, "/d.pdf": { body: pdfOf([["Altul"]]), type: "application/pdf" } });
  const clock = { now: Date.now() };
  svc.schedule.now = () => clock.now;
  svc.enableSchedule(() => ({ ...RECORD }));
  const at = Date.now() + 5 * MINUTE;
  const media = (url) => ({ kind: "media", chatId: PEER, source: { url }, asDocument: true, asVoice: false, asGif: false });

  const later = await svc.draft(media("https://example.com/c.pdf"), OWNER, { at, zone: "UTC" });
  assert.match(later.preview, /Scheduled: .*\n\[document\] c\.pdf \(application\/pdf/);
  const scheduled = await svc.confirmSchedule(later.draft_id, OWNER);
  const cancelled = await svc.confirmSchedule((await svc.draft(media("https://example.com/d.pdf"), OWNER, { at, zone: "UTC" })).draft_id, OWNER);
  assert.equal(files().length, 2);
  await svc.cancelScheduled(cancelled.schedule_id);
  await svc.sends.collectPinned();
  assert.deepEqual(files(), [sha(pdf)], "the cancelled one's file went");

  server.fetched.length = 0;
  clock.now = at + 1_000;
  await svc.scheduleIdle();
  assert.equal(sent.length, 1);
  assert.deepEqual(server.fetched, [], "the URL is not fetched at the send");
  assert.equal(storageRows(svc, "SELECT state FROM scheduled WHERE id = ?", scheduled.schedule_id)[0].state, "sent");
  await svc.sends.collectPinned();
  assert.deepEqual(files(), []);

  // A draft nobody confirms: once it lapses, its file goes too.
  await svc.draft(media("https://example.com/c.pdf"), OWNER);
  assert.equal(files().length, 1);
  const writer = new DatabaseSync(svc.databasePath);
  writer.prepare("UPDATE sends SET expires_at = ? WHERE state = 'draft'").run(Date.now() - 1);
  writer.close();
  await svc.sends.collectPinned();
  assert.deepEqual(files(), []);
});

test("a pinned file that changed or went is never sent in its place", async (t) => {
  const pdf = pdfOf([["Original"]]);
  const { svc, sent, outgoing } = setup(t, { "/a.pdf": { body: pdf, type: "application/pdf" } });
  const { call } = schemaCheckedTools(svc);
  const draft = (await call("send_message", { chat_id: PEER, text: "", url: "https://example.com/a.pdf" })).structuredContent;
  writeFileSync(join(outgoing, sha(pdf)), "tampered");
  const refused = textError(await call("confirm_send", { draft_id: draft.draft_id }));
  assert.equal(refused.error, "FILE_NOT_FOUND");
  assert.match(refused.message, /no longer on the machine running wazap; nothing was sent/);
  assert.equal(sent.length, 0);
});

test("the pinned files of an account are bounded: past the cap a new draft is refused, and a crash's half-written file is swept", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-pinned-cap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new PinnedStore(dir, { maxTotalBytes: 1000, now: () => Date.now() });
  const first = await store.pin(Buffer.alloc(600, 1), "application/pdf", "a.pdf");
  store.release(first.sha256);
  await assert.rejects(store.pin(Buffer.alloc(600, 2), "application/pdf", "b.pdf"), { code: "FILE_TOO_LARGE", message: /already hold/ });
  const again = await store.pin(Buffer.alloc(600, 1), "application/pdf", "a again.pdf");
  assert.equal(again.sha256, first.sha256, "the same bytes share one file and count once");
  store.release(again.sha256);
  writeFileSync(join(dir, `${"0".repeat(64)}.1.${Date.now() - 3_600_000}.part`), "half");
  await store.sweep(() => new Set([first.sha256]));
  assert.deepEqual(readdirSync(dir), [first.sha256]);
  await store.sweep(() => null);
  assert.deepEqual(readdirSync(dir), [first.sha256], "nothing to judge by: nothing removed");
  await store.sweep(() => new Set());
  assert.deepEqual(readdirSync(dir), []);
  const full = new PinnedStore(dir, { diskSpace: async () => ({ free: 10, total: 1_000_000 }) });
  await assert.rejects(full.pin(Buffer.alloc(100), "text/plain", "x.txt"), { code: "FILE_TOO_LARGE", message: /nearly full/ });
});

test("drafts at once never pass the account's cap or the disk's reserve together", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-pinned-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const MB = 1024 * 1024;
  const onDisk = () => (existsSync(dir) ? readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0) : 0);
  const files = (count, seed) => Array.from({ length: count }, (_, i) => Buffer.alloc(4 * MB, seed + i));

  // Eight 4 MB drafts at once against a 10 MB cap: two fit, the rest are refused, as one after another would be.
  const capped = new PinnedStore(dir, { maxTotalBytes: 10 * MB });
  const pins = await Promise.allSettled(files(8, 1).map((bytes, i) => capped.pin(bytes, "application/pdf", `f${i}.pdf`)));
  assert.equal(pins.filter((pin) => pin.status === "fulfilled").length, 2);
  assert.ok(pins.filter((pin) => pin.status === "rejected").every((pin) => pin.reason.code === "FILE_TOO_LARGE" && /already hold/.test(pin.reason.message)));
  assert.equal(onDisk(), 8 * MB);
  for (const pin of pins) if (pin.status === "fulfilled") capped.release(pin.value.sha256);
  await capped.sweep(() => new Set());

  // A disk with 30 MB free and a 10 MB reserve (5% of 200 MB): five fit, and the reserve stays free.
  const disk = new PinnedStore(dir, { diskSpace: async () => ({ free: 30 * MB - onDisk(), total: 200 * MB }) });
  const writes = await Promise.allSettled(files(8, 20).map((bytes, i) => disk.pin(bytes, "application/pdf", `g${i}.pdf`)));
  assert.equal(writes.filter((pin) => pin.status === "fulfilled").length, 5);
  assert.ok(writes.filter((pin) => pin.status === "rejected").every((pin) => /nearly full/.test(pin.reason.message)));
  assert.ok(30 * MB - onDisk() >= 10 * MB);
});

test("two drafts of the same bytes at once each keep the file, and the disk's own words never reach the caller", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-pinned-same-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // One millisecond for both, as two parallel calls in lockstep read the clock.
  const store = new PinnedStore(dir, { now: () => 1_700_000_000_000 });
  const bytes = Buffer.alloc(256 * 1024, 7);
  for (let run = 0; run < 5; run++) {
    const both = await Promise.all([store.pin(bytes, "application/pdf", "a.pdf"), store.pin(bytes, "application/pdf", "a.pdf")]);
    assert.deepEqual(both.map((pinned) => pinned.sha256), [sha(bytes), sha(bytes)]);
    assert.deepEqual(readdirSync(dir), [sha(bytes)], "one file, and no half-written copy left");
    for (const pinned of both) store.release(pinned.sha256);
    await store.sweep(() => new Set());
  }

  // A folder that cannot be made: the caller is told what happened, never the server's path.
  const blocked = join(dir, "not-a-folder");
  writeFileSync(blocked, "x");
  const refused = await new PinnedStore(join(blocked, "outgoing")).pin(bytes, "application/pdf", "a.pdf").catch((err) => err);
  assert.equal(refused.code, "SERVICE_ERROR");
  assert.match(refused.message, /could not be kept for the draft/);
  assert.equal(refused.message.includes(dir), false, refused.message);
});

test("a sweep keeps a file whose draft was stored while it ran, and a pin of bytes being removed writes them again", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-pinned-sweep-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new PinnedStore(dir);
  for (let i = 0; i < 20; i++) store.release((await store.pin(Buffer.from(`lapsed ${i}`), "text/plain", "x.txt")).sha256);
  const drafted = await store.pin(Buffer.from("a new draft"), "text/plain", "c.txt");
  const db = new Set();
  // The database is read before the draft is in it; the draft is stored, and let go, while the sweep removes the others.
  await store.sweep(() => {
    queueMicrotask(() => {
      db.add(drafted.sha256);
      store.release(drafted.sha256);
    });
    return new Set(db);
  });
  assert.deepEqual(readdirSync(dir), [drafted.sha256]);
  await store.sweep(() => new Set(db));
  assert.deepEqual(readdirSync(dir), [drafted.sha256], "the next sweep judges it by the database, which names it");

  db.clear();
  let again;
  await store.sweep(() => {
    // The same bytes drafted again just as the sweep starts removing their file.
    queueMicrotask(() => {
      again = store.pin(Buffer.from("a new draft"), "text/plain", "c.txt");
    });
    return new Set(db);
  });
  const pinned = await again;
  assert.deepEqual(readdirSync(dir), [drafted.sha256], "written again after the removal, not lost to it");
  assert.equal((await store.read(pinned)).toString(), "a new draft");
  store.release(pinned.sha256);
});

test("a UTF-16 text file stays text, a bare MP3 frame names audio only when nothing says otherwise", () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("nume,suma\r\nAna,120\r\n", "utf16le")]);
  assert.equal(sniffMime(utf16, "text/csv", "raport.csv"), "text/csv");
  assert.equal(sniffMime(utf16, null, "raport.txt"), "text/plain");
  assert.equal(sniffMime(Buffer.from([0xff, 0xff, 0x41, 0x00]), null, "x"), "application/octet-stream");
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, ...Buffer.alloc(100)]);
  assert.equal(sniffMime(mp3, null, "voce"), "audio/mpeg");
  assert.equal(sniffMime(mp3, "application/octet-stream", "voce.bin"), "audio/mpeg");
  assert.equal(sniffMime(mp3, "audio/mp3", "voce.mp3"), "audio/mpeg");
  assert.equal(sniffMime(mp3, "text/csv", "date.csv"), "text/csv", "a frame header's few bits do not outvote a stated type");
  assert.equal(sniffMime(Buffer.concat([Buffer.from("ID3"), mp3]), "text/plain", "x.txt"), "audio/mpeg", "an ID3 tag does");
  // Not a frame: a free or invalid bitrate, a sample rate that does not exist, Layer I.
  for (const header of [[0xff, 0xfb, 0x00, 0x64], [0xff, 0xfb, 0xf0, 0x64], [0xff, 0xfb, 0x9c, 0x64], [0xff, 0xff, 0x90, 0x64]]) {
    assert.equal(sniffMime(Buffer.from(header), null, "x"), "application/octet-stream", header.join(","));
  }
});

test("an ISO media file is what its brands say, and a ZIP without a typed name is what its declared type says", () => {
  /** An ftyp box: its major brand, then the brands it is compatible with. */
  const ftyp = (major, ...compatible) => {
    const box = Buffer.concat([Buffer.alloc(4), Buffer.from(`ftyp${major}`, "latin1"), Buffer.alloc(4), ...compatible.map((brand) => Buffer.from(brand, "latin1"))]);
    box.writeUInt32BE(box.length, 0);
    return Buffer.concat([box, Buffer.alloc(64)]);
  };
  for (const [bytes, mime] of [
    [ftyp("avif", "mif1", "miaf"), "image/avif"],
    [ftyp("avis", "msf1"), "image/avif"],
    [ftyp("mif1", "mif1", "avif", "miaf"), "image/avif"],
    [ftyp("heic", "mif1", "heic"), "image/heic"],
    [ftyp("heim", "mif1"), "image/heic"],
    [ftyp("heis", "msf1"), "image/heic"],
    [ftyp("hevx", "mif1"), "image/heic"],
    [ftyp("crx ", "isom"), "image/x-canon-cr3"],
    [ftyp("qt  ", "qt  "), "video/quicktime"],
    [ftyp("M4A ", "M4A ", "mp42", "isom"), "audio/mp4"],
    [ftyp("isom", "iso2", "avc1", "mp41"), "video/mp4"],
    [ftyp("mp42", "mp41"), "video/mp4"],
    [ftyp("3gp4", "isom"), "video/3gpp"],
    [ftyp("XYZW", "mp42"), "video/mp4"],
  ]) {
    assert.equal(sniffMime(bytes, null, "x"), mime, bytes.subarray(8, 12).toString("latin1"));
  }
  // A brand that says nothing of the file: its declared type, else its name, else a document's octet-stream; never a video.
  assert.equal(sniffMime(ftyp("XYZW"), "image/jxl", "x"), "image/jxl");
  assert.equal(sniffMime(ftyp("XYZW"), null, "poza.heic"), "image/heic");
  assert.equal(sniffMime(ftyp("XYZW"), null, "x"), "application/octet-stream");
  assert.equal(sniffMime(ftyp("avif"), "video/mp4", "x.mp4"), "image/avif", "the bytes outvote what it was declared");

  const zip = Buffer.from("PK\x03\x04rest");
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  assert.equal(sniffMime(zip, DOCX, "Raport trimestrial"), DOCX);
  assert.equal(sniffMime(zip, `${DOCX}; charset=binary`, "Raport"), DOCX);
  assert.equal(sniffMime(zip, "application/vnd.oasis.opendocument.text", "x"), "application/vnd.oasis.opendocument.text");
  assert.equal(sniffMime(zip, "application/epub+zip", "carte"), "application/epub+zip");
  assert.equal(sniffMime(zip, "application/vnd.ms-excel.sheet.macroEnabled.12", "x"), "application/vnd.ms-excel.sheet.macroenabled.12");
  assert.equal(sniffMime(zip, "text/plain", "x"), "application/zip", "a type that is no ZIP does not outvote the bytes");
  assert.equal(sniffMime(zip, null, "arhiva"), "application/zip");
  assert.equal(sniffMime(zip, "application/pdf", "raport.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a typed name still wins");
  assert.equal(safeFilename("Raport trimestrial", DOCX), "Raport trimestrial.docx");
});
