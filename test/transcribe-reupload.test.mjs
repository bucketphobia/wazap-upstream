/**
 * The background transcription queue asks the phone for a recent voice note
 * whose WhatsApp copy expired, never for an old one, and tells a phone that
 * did not answer (try later) from one that no longer has the file (final).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { mediaKeepSettings } from "../dist/media-keep.js";
import { classifyFailure } from "../dist/transcribe/failure.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, waitFor } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const ANA = "40700000002@s.whatsapp.net";
const DAY = 24 * 60 * 60 * 1000;

async function setup(t) {
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-queue-reupload-",
    id: ME,
    name: "Răzvan",
    config: { persistHistory: true, mediaKeep: mediaKeepSettings({ WAZAP_MEDIA_KEEP: "off" }) },
  });
  t.after(() => svc.stop());
  await svc.bootStorage();
  let seq = 0;
  const voiceAt = (ts) => {
    const id = `V${++seq}`;
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: ANA, fromMe: false, id },
          message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", fileLength: 10, seconds: 3, ptt: true } },
          messageTimestamp: Math.floor(ts / 1000),
        },
      ],
    });
    const sid = `false_${ANA}_${id}`;
    return waitFor(() => (svc.db.messages.get(sid) ? sid : null), 5000, `the voice note ${id}`);
  };
  return { svc, sock, voiceAt };
}

test("a recent queued voice note may ask the phone again; one older than a month may not", async (t) => {
  const { svc, voiceAt } = await setup(t);
  const asked = [];
  svc.transcribeAudio = async (sid, _language, opts) => {
    asked.push({ sid, reupload: opts?.reupload === true });
    return { text: "salut" };
  };
  const recent = await voiceAt(Date.now() - 2 * DAY);
  const old = await voiceAt(Date.now() - 45 * DAY);
  await svc.voice.transcribeQueued(recent);
  await svc.voice.transcribeQueued(old);
  assert.deepEqual(asked, [
    { sid: recent, reupload: true },
    { sid: old, reupload: false },
  ]);
});

test("a phone that does not answer the re-upload is tried later; one that cannot upload the file is final", async (t) => {
  const { svc, voiceAt } = await setup(t);
  const sid = await voiceAt(Date.now() - DAY);
  const raw = svc.views.messageOrThrow(sid);

  svc.reuploadTimeoutMs = 20;
  const silent = { updateMediaMessage: () => new Promise(() => {}) };
  const late = await svc.reuploadMedia(silent, sid, raw).catch((err) => err);
  assert.equal(late.code, "MEDIA_UNAVAILABLE");
  assert.equal(classifyFailure(late).kind, "transient");

  const refusing = {
    updateMediaMessage: async () => {
      throw Object.assign(new Error("Failed to re-upload media (NOT_FOUND)"), { output: { statusCode: 404 } });
    },
  };
  const gone = await svc.reuploadMedia(refusing, sid, raw).catch((err) => err);
  assert.equal(gone.code, "MEDIA_UNAVAILABLE");
  assert.deepEqual(classifyFailure(gone), { kind: "permanent", reason: "media gone from WhatsApp and the phone" });

  const dropped = {
    updateMediaMessage: async () => {
      throw Object.assign(new Error("Connection Closed"), { output: { statusCode: 428 } });
    },
  };
  const closed = await svc.reuploadMedia(dropped, sid, raw).catch((err) => err);
  assert.equal(classifyFailure(closed).kind, "transient", "a connection that closed under the request is tried again");
});
