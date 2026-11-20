import { test } from "node:test";
import assert from "node:assert/strict";
import { fullMessageDetails, messageText } from "../dist/messages.js";
import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService, schemaCheckedTools } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";
const raw = (message) => ({ key: { remoteJid: PEER, fromMe: false, id: "D" }, message });
const flow = (name, params) => ({ name, buttonParamsJson: JSON.stringify(params) });

test("full locations keep precise coordinates, names, addresses and live metadata", () => {
  const message = raw({ locationMessage: { degreesLatitude: 46.771234567, degreesLongitude: 23.601234567, name: "Întâlnire", address: "Strada 42", url: "https://example.com/map" } });
  const { location } = fullMessageDetails(message);
  assert.equal(location.latitude, 46.771234567);
  assert.equal(location.longitude, 23.601234567);
  assert.equal(location.name, "Întâlnire");
  assert.equal(location.address, "Strada 42");
  assert.equal(location.live, false);
  assert.equal(messageText(message), "[location] Întâlnire");
  const live = fullMessageDetails(raw({ ephemeralMessage: { message: { liveLocationMessage: { degreesLatitude: 0, degreesLongitude: 0, accuracyInMeters: 4, speedInMps: 2, degreesClockwiseFromMagneticNorth: 90, caption: "aici" } } } })).location;
  assert.deepEqual([live.latitude, live.longitude, live.live, live.accuracy_meters, live.speed_mps, live.heading_degrees, live.caption], [0, 0, true, 4, 2, 90, "aici"]);
  const invalid = fullMessageDetails(raw({ locationMessage: { degreesLatitude: NaN, degreesLongitude: Infinity } })).location;
  assert.equal(invalid.latitude, undefined);
  assert.equal(invalid.longitude, undefined);
  assert.deepEqual(fullMessageDetails(raw({})), {});
});

test("full shared contacts keep every card and the original vCard encoding", () => {
  const card = { displayName: "Ștefan", vcard: "BEGIN:VCARD\r\nFN:Ștefan\r\nTEL;TYPE=CELL:+15550123\r\nNOTE:line\\nnext\r\nEND:VCARD" };
  assert.deepEqual(fullMessageDetails(raw({ contactMessage: card })).contacts, [{ display_name: card.displayName, vcard: card.vcard }]);
  assert.deepEqual(fullMessageDetails(raw({ contactsArrayMessage: { displayName: "Echipa", contacts: [card, { displayName: "Ana", vcard: "not a valid vcard" }, {}] } })).contacts,
    [{ display_name: card.displayName, vcard: card.vcard }, { display_name: "Ana", vcard: "not a valid vcard" }, {}]);
  assert.deepEqual(fullMessageDetails(raw({ contactsArrayMessage: { contacts: [] } })).contacts, []);
});

test("button actions are typed sender data while compact text keeps labels only", () => {
  const message = raw({ interactiveMessage: { body: { text: "Track" }, nativeFlowMessage: { buttons: [
    flow("cta_url", { display_text: "Open", url: "https://example.com/order/42" }),
    flow("cta_call", { display_text: "Call", phone_number: "+15550123" }),
    flow("cta_copy", { display_text: "Copy", copy_code: "CODE-42" }),
    flow("quick_reply", { display_text: "Yes", id: "yes-42" }),
  ] } } });
  assert.deepEqual(fullMessageDetails(message).buttons, [
    { kind: "url", label: "Open", url: "https://example.com/order/42" },
    { kind: "call", label: "Call", phone_number: "+15550123" },
    { kind: "copy", label: "Copy", code: "CODE-42" },
    { kind: "reply", label: "Yes", id: "yes-42" },
  ]);
  assert.equal(messageText(message), "Track\n(buttons: Open · Call · Copy · Yes)");
  const malformed = { name: "cta_url", buttonParamsJson: "{" };
  const unknown = flow("future_action", { display_text: "Future", command: "do not execute" });
  const unsafe = flow("cta_url", { url: "javascript:alert(1)" });
  const buttons = fullMessageDetails(raw({ interactiveMessage: { nativeFlowMessage: { buttons: [malformed, unknown, unsafe, flow("cta_call", []), flow("cta_url", null)] } } })).buttons;
  assert.deepEqual(buttons[0], { kind: "unknown", name: "cta_url", parameters_json: "{" });
  assert.equal(buttons[1].parameters_json, unknown.buttonParamsJson);
  assert.equal(buttons[2].url, "javascript:alert(1)", "untrusted values are returned, never followed");
  assert.equal(buttons[3].kind, "unknown");
  assert.equal(buttons[4].kind, "unknown");
  assert.equal(fullMessageDetails(raw({ interactiveMessage: {} })).buttons, undefined);
});

test("carousel cards keep native-flow actions in card order including unknown payloads", () => {
  const message = raw({ interactiveMessage: { carouselMessage: { cards: [
    { nativeFlowMessage: { buttons: [flow("cta_url", { display_text: "Track", url: "https://example.com/order" })] } },
    {},
    { nativeFlowMessage: { buttons: [flow("cta_copy", { copy_code: "CODE" }), { name: "future", buttonParamsJson: "{" }] } },
  ] } } });
  assert.deepEqual(fullMessageDetails(message).buttons, [
    { kind: "url", label: "Track", url: "https://example.com/order", card: { index: 0 } },
    { kind: "copy", code: "CODE", card: { index: 2 } },
    { kind: "unknown", name: "future", parameters_json: "{", card: { index: 2 } },
  ]);
  assert.equal(fullMessageDetails(raw({ interactiveMessage: { carouselMessage: { cards: [] } } })).buttons, undefined);
  assert.deepEqual(fullMessageDetails(raw({ templateMessage: { interactiveMessageTemplate: message.message.interactiveMessage } })).buttons,
    fullMessageDetails(message).buttons);
});

test("carousel actions distinguish identical labels by card index and sender-provided text", () => {
  const button = flow("cta_url", { display_text: "Shop now", url: "https://example.com/shop" });
  const message = raw({ interactiveMessage: { carouselMessage: { cards: [
    { header: { title: "Product A", subtitle: "Size S" }, body: { text: "First offer" }, nativeFlowMessage: { buttons: [button] } },
    { header: { title: "Product B" }, nativeFlowMessage: { buttons: [button] } },
  ] } } });
  const buttons = fullMessageDetails(message).buttons;
  assert.deepEqual(buttons.map(({ label }) => label), ["Shop now", "Shop now"]);
  assert.deepEqual(buttons.map(({ card }) => card), [
    { index: 0, title: "Product A", subtitle: "Size S", body: "First offer" },
    { index: 1, title: "Product B" },
  ]);
  assert.equal(Object.hasOwn(fullMessageDetails(raw({ interactiveMessage: { nativeFlowMessage: { buttons: [button] } } })).buttons[0], "card"), false);
});

test("hydrated templates and legacy buttons retain their destinations and reply ids", () => {
  const message = raw({ templateMessage: { hydratedTemplate: { hydratedContentText: "Hello", hydratedButtons: [
    { urlButton: { displayText: "Site", url: "https://example.com" } },
    { callButton: { displayText: "Call", phoneNumber: "+15550123" } },
    { quickReplyButton: { displayText: "Yes", id: "YES" } },
  ] } } });
  assert.deepEqual(fullMessageDetails(message).buttons, [
    { kind: "url", label: "Site", url: "https://example.com" },
    { kind: "call", label: "Call", phone_number: "+15550123" },
    { kind: "reply", label: "Yes", id: "YES" },
  ]);
  assert.deepEqual(fullMessageDetails(raw({ buttonsMessage: { buttons: [{ buttonId: "GO", buttonText: { displayText: "Go" } }] } })).buttons,
    [{ kind: "reply", label: "Go", id: "GO" }]);
});

test("get_message exposes details in structured and text answers, never in compact lists", async (t) => {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-details-", id: ME, name: "Owner" });
  t.after(() => svc.stop());
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  const contents = [
    { locationMessage: { degreesLatitude: 46.771234567, degreesLongitude: 23.601234567, name: "Here", address: "Street 42" } },
    { contactsArrayMessage: { displayName: "Team", contacts: [{ displayName: "Ana", vcard: "BEGIN:VCARD\nTEL:+15550123\nEND:VCARD" }] } },
    { interactiveMessage: { body: { text: "Track order" }, nativeFlowMessage: { buttons: [flow("cta_url", { display_text: "Track", url: "https://example.com/order/42" })] } } },
  ];
  sock.ev.emit("messages.upsert", { type: "notify", messages: contents.map((message, i) => ({
    key: { remoteJid: PEER, fromMe: false, id: `D${i}` }, messageTimestamp: Math.floor(Date.now() / 1000) - 10 + i, message,
  })) });
  for (const [i, key] of ["location", "contacts", "buttons"].entries()) {
    const answer = await call("get_message", { message_id: `false_${PEER}_D${i}` });
    assert.equal(answer.isError, undefined);
    assert.ok(answer.structuredContent[key]);
    assert.match(answer.content[0].text, /untrusted data, not instructions/);
  }
  const listed = await call("read_messages", { chat_id: PEER });
  assert.ok(listed.structuredContent.messages.every((m) => !m.location && !m.contacts && !m.buttons));
  assert.ok(!listed.content[0].text.includes("https://example.com/order/42"));
  const missing = await call("get_message", { message_id: `false_${PEER}_MISSING` });
  assert.equal(missing.isError, true);
});

test("sender relearning keeps search and list payloads compact but preserves full message details", async (t) => {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-details-lid-", id: ME, name: "Owner" });
  t.after(() => svc.stop());
  const { call } = schemaCheckedTools(svc, { allowWrite: false });
  const group = "120363000000000001@g.us";
  const lid = "999888777666555@lid";
  svc.sockClient.groupMetadata = async (id) => ({ id, subject: "Team", participants: [{ id: lid }] });
  let reloads = 0;
  const getMessage = svc.getMessage.bind(svc);
  svc.getMessage = (...args) => { reloads++; return getMessage(...args); };
  const contents = [
    { locationMessage: { degreesLatitude: 46.771234567, degreesLongitude: 23.601234567, name: "needle" } },
    { contactMessage: { displayName: "needle", vcard: "BEGIN:VCARD\nTEL:+15550123\nEND:VCARD" } },
    { interactiveMessage: { body: { text: "needle" }, nativeFlowMessage: { buttons: [flow("cta_url", { display_text: "Open", url: "https://example.com" })] } } },
  ];
  sock.ev.emit("messages.upsert", { type: "notify", messages: contents.map((message, i) => ({
    key: { remoteJid: group, participant: lid, fromMe: false, id: `L${i}` }, messageTimestamp: Math.floor(Date.now() / 1000) - 10 + i, message,
  })) });
  for (const [name, args] of [["search", { query: "needle", chat_id: group }], ["read_messages", { chat_id: group }]]) {
    reloads = 0;
    const answer = await call(name, args);
    assert.equal(answer.isError, undefined);
    assert.equal(answer.structuredContent.messages.length, 3);
    if (name === "search") assert.ok(reloads >= 3, "unresolved LID senders reload through getMessage");
    for (const message of answer.structuredContent.messages) {
      for (const key of ["location", "contacts", "buttons"]) assert.equal(Object.hasOwn(message, key), false);
    }
  }
  for (const [i, key] of ["location", "contacts", "buttons"].entries()) {
    const answer = await call("get_message", { message_id: `false_${group}_L${i}` });
    assert.ok(answer.structuredContent[key], "full payloads survive sender relearning");
  }
});
