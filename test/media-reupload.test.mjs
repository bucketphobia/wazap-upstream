/**
 * Expired media asked of the phone again. WhatsApp's CDN answers 404 or 410
 * once it lets a file go; Baileys' own re-upload never fires on that error
 * (it reads error.status, the error carries output.statusCode), so wazap
 * asks the phone itself, within a time limit, retries once, and stores the
 * fresh url so the next call needs no request. Background work never asks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { Readable } from "node:stream";

import { assertMediaContent } from "baileys";

import { WhatsAppService } from "../dist/whatsapp.js";
import { RateLimiter } from "../dist/ratelimit.js";
import { connectedService, schemaCheckedTools, textError } from "./helpers.mjs";

const ANA = "40700000002@s.whatsapp.net";

/** The error Baileys' getHttpStream throws for a CDN status: a Boom, with the code in output.statusCode. */
function cdnError(statusCode) {
  return Object.assign(new Error("Failed to fetch stream from https://mmg.whatsapp.net/x"), { isBoom: true, output: { statusCode } });
}

function setup(t) {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-reupload-", id: "40700000001@s.whatsapp.net", name: "Me" });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: ANA, fromMe: false, id: "OLD" },
        message: { documentMessage: { mimetype: "text/plain", fileName: "nota.txt", fileLength: 9, url: "https://mmg.whatsapp.net/old", directPath: "/old", mediaKey: Buffer.alloc(32, 7) } },
        messageTimestamp: Math.floor(Date.now() / 1000) - 90 * 86400,
      },
    ],
  });
  const sid = `false_${ANA}_OLD`;
  // The CDN: the old path is gone, a refreshed one serves the file.
  const opened = [];
  svc.openMediaStream = async (message) => {
    const path = message.message.documentMessage.directPath;
    opened.push(path);
    if (path === "/old") throw cdnError(410);
    return Readable.from([Buffer.from("de citit!")]);
  };
  return { svc, sock, call, sid, opened };
}

const storedPath = (svc, sid) => svc.views.rawOf(svc.db.messages.get(sid)).message.documentMessage.directPath;

test("a 410 asks the phone to upload the file again, retries once, and stores the fresh path", async (t) => {
  const { svc, sock, call, sid, opened } = setup(t);
  const asked = [];
  sock.updateMediaMessage = async (message) => {
    asked.push(message.key.id);
    message.message.documentMessage.directPath = "/fresh";
    message.message.documentMessage.url = "https://mmg.whatsapp.net/fresh";
    return message;
  };
  const out = (await call("get_media", { message_id: sid })).structuredContent;
  assert.equal(out.document_text, "de citit!");
  assert.deepEqual(asked, ["OLD"], "the phone was asked once");
  assert.deepEqual(opened, ["/old", "/fresh"]);
  assert.equal(storedPath(svc, sid), "/fresh", "the refreshed path is stored on the message");

  opened.length = 0;
  await call("get_media", { message_id: sid });
  assert.deepEqual(opened, ["/fresh"], "the next call goes straight to it");
  assert.equal(asked.length, 1);
});

test("an expired round video (ptv) is asked of the phone as the video it is", async (t) => {
  const { svc, sock, call } = setup(t);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: ANA, fromMe: false, id: "PTV" },
        message: { ptvMessage: { mimetype: "video/mp4", seconds: 4, fileLength: 9, url: "https://mmg.whatsapp.net/old", directPath: "/old", mediaKey: Buffer.alloc(32, 8) } },
        messageTimestamp: Math.floor(Date.now() / 1000) - 90 * 86400,
      },
    ],
  });
  const sid = `false_${ANA}_PTV`;
  const opened = [];
  svc.openMediaStream = async (message) => {
    const path = message.message.ptvMessage.directPath;
    opened.push(path);
    if (path === "/old") throw cdnError(410);
    return Readable.from([Buffer.from("not-a-video")]);
  };
  // Baileys' own check: a ptvMessage is "not a media message" to it.
  assert.throws(() => assertMediaContent({ ptvMessage: {} }), /not a media message/);
  const asked = [];
  sock.updateMediaMessage = async (message) => {
    const node = assertMediaContent(message.message);
    asked.push(message.key.id);
    node.directPath = "/fresh";
    node.url = "https://mmg.whatsapp.net/fresh";
    return message;
  };
  const out = await call("get_media", { message_id: sid });
  assert.ok(!out.isError, JSON.stringify(out.content));
  assert.deepEqual(asked, ["PTV"]);
  assert.deepEqual(opened, ["/old", "/fresh"]);
  const stored = svc.views.rawOf(svc.db.messages.get(sid)).message;
  assert.equal(stored.ptvMessage.directPath, "/fresh", "stored as the round video it was");
  assert.equal(stored.videoMessage, undefined);
});

test("a phone that does not answer in time is MEDIA_UNAVAILABLE saying it must be online", async (t) => {
  const { svc, sock, call, sid } = setup(t);
  svc.reuploadTimeoutMs = 50;
  sock.updateMediaMessage = () => new Promise(() => {});
  const error = textError(await call("get_media", { message_id: sid }));
  assert.equal(error.error, "MEDIA_UNAVAILABLE");
  assert.match(error.message, /has expired, and the phone did not answer the request to upload it again within 0\.05 s/);
  assert.match(error.fix, /phone must be online/);
  assert.equal(storedPath(svc, sid), "/old");
});

test("a phone that no longer has the file says so: ask the sender", async (t) => {
  const { sock, call, sid } = setup(t);
  sock.updateMediaMessage = async () => {
    throw Object.assign(new Error("Media re-upload failed by device (NOT_FOUND)"), { output: { statusCode: 404 } });
  };
  const error = textError(await call("get_media", { message_id: sid }));
  assert.equal(error.error, "MEDIA_UNAVAILABLE");
  assert.match(error.message, /could not upload it again \(.*NOT_FOUND/);
  assert.match(error.fix, /resend/);
});

test("other failures, and background work such as previews, never wake the phone", async (t) => {
  const { svc, sock, call, sid } = setup(t);
  let asked = 0;
  sock.updateMediaMessage = async (message) => {
    asked++;
    return message;
  };
  svc.openMediaStream = async () => {
    throw cdnError(500);
  };
  assert.equal(textError(await call("get_media", { message_id: sid })).error, "MEDIA_UNAVAILABLE");
  assert.equal(asked, 0, "a server error is not an expiry");

  svc.openMediaStream = async () => {
    throw cdnError(410);
  };
  await svc.previews([sid], 1);
  await assert.rejects(svc.mediaBuffer(sock, sid, svc.views.messageOrThrow(sid)), { code: "MEDIA_UNAVAILABLE" });
  assert.equal(asked, 0, "previews and plain downloads do not ask");
});

test("re-upload requests are rate-limited per account", async (t) => {
  const { svc, sock, call, sid } = setup(t);
  svc.reuploads = new RateLimiter(1, Date.now, "Media re-request");
  sock.updateMediaMessage = async () => {
    throw Object.assign(new Error("NOT_FOUND"), { output: { statusCode: 404 } });
  };
  assert.equal(textError(await call("get_media", { message_id: sid })).error, "MEDIA_UNAVAILABLE");
  const second = textError(await call("get_media", { message_id: sid }));
  assert.equal(second.error, "RATE_LIMITED");
  assert.match(second.message, /Media re-request/);
});

test("a fresh path is never written onto a message deleted meanwhile", async (t) => {
  const { svc, sock, sid } = setup(t);
  const before = svc.db.messages.get(sid).raw;
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: ANA, fromMe: false, id: "R1" }, message: { protocolMessage: { type: 0, key: { remoteJid: ANA, fromMe: false, id: "OLD" } } }, messageTimestamp: Math.floor(Date.now() / 1000) }],
  });
  assert.equal(svc.db.messages.get(sid), null, "deleted");
  assert.equal(svc.db.messages.refreshRaw(sid, before), false);
});
