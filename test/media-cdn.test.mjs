/**
 * Media is downloaded from WhatsApp's CDN and nowhere else. The sender writes
 * the media node (url, directPath) inside the encrypted message, and Baileys
 * fetches `url` as it is when there is no directPath, and
 * `https://<url's host><directPath>` otherwise. Left alone, a stranger's
 * message would make the server GET any host, port and path it names (a
 * router's admin page, a service on loopback), and tell that host the
 * server's real address, on arrival when media is kept.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { downloadMediaMessage, proto } from "baileys";

import { cdnOnlyMessage, cdnPath, cdnUrl } from "../dist/messages.js";
import { mediaKeepSettings } from "../dist/media-keep.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools, textError, waitFor } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const STRANGER = "40700000009@s.whatsapp.net";
const CDN = "https://mmg.whatsapp.net/v/t62.7118-24/123_456_n.enc?ccb=11-4&oh=01_x&oe=6612ABCD&mms3=true";
const PATH = "/v/t62.7118-24/123_456_n.enc?ccb=11-4&oh=01_x&oe=6612ABCD";

test("a url is kept only on WhatsApp's CDN, over https, on its own port, without credentials", () => {
  assert.equal(cdnUrl(CDN), CDN);
  assert.equal(cdnUrl("https://media-otp1-1.cdn.whatsapp.net/v/x.enc"), "https://media-otp1-1.cdn.whatsapp.net/v/x.enc");
  for (const url of [
    "http://mmg.whatsapp.net/v/x.enc",
    "https://mmg.whatsapp.net:8443/v/x.enc",
    "https://user:pw@mmg.whatsapp.net/v/x.enc",
    "https://127.0.0.1/internal/admin?action=reboot",
    "http://192.168.1.1/cgi?action=x",
    "https://attacker.example/x",
    "https://mmg.whatsapp.net.attacker.example/x",
    "https://attacker.example\\@mmg.whatsapp.net/x",
    "https://evilwhatsapp.net/x",
    "file:///etc/passwd",
    "not a url",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(cdnUrl(url), undefined, String(url));
  }
});

test("a directPath is kept only as a path: one leading slash, nothing that starts another host", () => {
  assert.equal(cdnPath(PATH), PATH);
  for (const path of ["@attacker.example/x", ".attacker.example/x", ":8080/x", "//attacker.example/x", "/a//b", "/x@y", "/x\\y", "/x y", "/x\ny", "x/y", "", null, 7]) {
    assert.equal(cdnPath(path), undefined, JSON.stringify(path));
  }
});

test("the node Baileys downloads loses a url and paths off the CDN, wrappers and all; its other fields stay", () => {
  const mediaKey = randomBytes(32);
  const wrapped = {
    key: { remoteJid: STRANGER, fromMe: false, id: "W1" },
    message: {
      ephemeralMessage: {
        message: {
          viewOnceMessageV2: {
            message: { imageMessage: { mimetype: "image/jpeg", url: "http://127.0.0.1:9/x", directPath: "@attacker.example/y", mediaKey, fileLength: 64 } },
          },
        },
      },
    },
  };
  const safe = cdnOnlyMessage(wrapped);
  assert.deepEqual(Object.keys(safe.message), ["imageMessage"]);
  const node = safe.message.imageMessage;
  assert.equal(node.url, null);
  assert.equal(node.directPath, null);
  assert.equal(node.mediaKey, mediaKey);
  assert.equal(node.mimetype, "image/jpeg");
  assert.equal(safe.key, wrapped.key);
  assert.ok(!("thumbnailDirectPath" in node), "a key the node did not have is not added");

  const fine = cdnOnlyMessage({ key: wrapped.key, message: { documentMessage: { url: CDN, directPath: PATH, mediaKey } } });
  assert.equal(fine.message.documentMessage.url, CDN);
  assert.equal(fine.message.documentMessage.directPath, PATH);

  // A decoded message keeps its fields on a protobuf instance, whose prototype says null for the unset ones.
  const decoded = proto.Message.decode(proto.Message.encode({ stickerMessage: { url: "https://attacker.example/s", directPath: PATH, mediaKey } }).finish());
  const sticker = cdnOnlyMessage({ key: wrapped.key, message: decoded }).message.stickerMessage;
  assert.equal(sticker.url, null);
  assert.equal(sticker.directPath, PATH);

  const text = { key: wrapped.key, message: { conversation: "salut" } };
  assert.deepEqual(cdnOnlyMessage(text).message, { conversation: "salut" });
  const empty = { key: wrapped.key, message: null };
  assert.equal(cdnOnlyMessage(empty), empty);
});

test("media six wrappers deep is not handed to Baileys, which would unwrap five more and fetch its url", async (t) => {
  const fetched = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    throw new Error("no network in this test");
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const mediaKey = randomBytes(32);
  let deep = { imageMessage: { mimetype: "image/jpeg", url: "http://127.0.0.1:9/internal/admin?action=reboot", mediaKey, fileLength: 64 } };
  for (let i = 0; i < 6; i++) deep = { ephemeralMessage: { message: deep } };
  for (const wrapper of ["editedMessage", "groupStatusMessageV2"]) {
    // A decoy photo at the top, the one wazap reports; Baileys opens the wrapper first, and stops at its fifth.
    const message = proto.Message.decode(
      proto.Message.encode({ imageMessage: { mimetype: "image/jpeg", url: CDN, directPath: PATH, mediaKey }, [wrapper]: { message: deep } }).finish()
    );
    const raw = { key: { remoteJid: STRANGER, fromMe: false, id: `D-${wrapper}` }, message };
    const safe = cdnOnlyMessage(raw);
    assert.deepEqual(safe.message, { ephemeralMessage: null }, wrapper);
    await assert.rejects(downloadMediaMessage(safe, "stream", {}), /not a media message/, wrapper);
  }
  assert.deepEqual(fetched, [], "nothing was fetched");
});

test("a stranger's photo whose url names a host on this network is fetched neither on arrival nor by get_media", async (t) => {
  const connections = [];
  // A bare TCP listener: it counts an http request and a TLS handshake alike.
  const listener = createServer((socket) => {
    connections.push(Date.now());
    socket.destroy();
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => listener.close());
  const { port } = listener.address();

  // The defaults a server runs with: history kept, and photos kept as they arrive in an unmuted chat.
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-cdn-",
    id: ME,
    name: "Răzvan",
    config: { persistHistory: true, mediaKeep: mediaKeepSettings({}) },
  });
  t.after(() => svc.stop());
  await svc.bootStorage();
  const { call } = schemaCheckedTools(svc, { allowWrite: false, allowLocalFiles: false });
  const mediaKey = randomBytes(32);
  const arrive = (id, imageMessage) =>
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{ key: { remoteJid: STRANGER, fromMe: false, id }, message: { imageMessage }, messageTimestamp: Math.floor(Date.now() / 1000) }],
    });
  arrive("S1", { mimetype: "image/jpeg", url: `http://127.0.0.1:${port}/internal/admin?action=reboot`, mediaKey, fileLength: 64 });
  arrive("S2", { mimetype: "image/jpeg", url: `https://127.0.0.1:${port}/x`, mediaKey, fileLength: 64 });

  // The keeper tries each at once, and fails before any socket opens.
  await waitFor(() => svc.keep.worker === null, 5000, "the kept-media queue to drain");
  await svc.keep.work;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(connections, [], "nothing was fetched on arrival");

  for (const id of ["S1", "S2"]) {
    const answer = await call("get_media", { message_id: `false_${STRANGER}_${id}` });
    assert.equal(textError(answer).error, "MEDIA_UNAVAILABLE");
  }
  assert.deepEqual(connections, [], "nor by get_media");
});
