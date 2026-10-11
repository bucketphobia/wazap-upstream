import { test } from "node:test";
import assert from "node:assert/strict";

import { unreadOf } from "../dist/service/views.js";

const chat = (fields) => ({ unread: 1, lastFromMe: false, lastOwnId: null, readThroughId: null, lastMessageId: 10, ...fields });

test("WhatsApp's unread count stands while nothing says the chat was read", () => {
  assert.equal(unreadOf(chat({ unread: 3 })), 3);
  assert.equal(unreadOf(chat({ unread: 2, readThroughId: 7 })), 2, "read on the phone, but not as far as the last message");
});

test("a chat the user had the last word in has nothing unread", () => {
  assert.equal(unreadOf(chat({ lastFromMe: true, lastOwnId: 10 })), 0);
  assert.equal(unreadOf(chat({ lastOwnId: 10 })), 0);
});

test("a chat read on the phone through its last message has nothing unread", () => {
  assert.equal(unreadOf(chat({ readThroughId: 10 })), 0);
  assert.equal(unreadOf(chat({ readThroughId: 12 })), 0);
});

test("a message after the read counts again, and a negative count is none", () => {
  assert.equal(unreadOf(chat({ readThroughId: 9, lastMessageId: 10 })), 1);
  assert.equal(unreadOf(chat({ unread: -1 })), 0);
});
