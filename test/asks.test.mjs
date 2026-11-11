/**
 * The words that make a message an ask, shared by catch_up's `waiting` and
 * get_unanswered: what asks the user, and what only sounds like it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { readsAsAsk, wordsAsk } from "../dist/asks.js";

test("a question word asks when it opens a sentence, after at most a connective, and not inside a statement", () => {
  for (const words of ["când ajungi", "Cand vii", "Ok, când vii", "am ajuns. unde esti", "Cât costă", "and where are you", "when do you land"]) {
    assert.equal(wordsAsk(words), true, words);
  }
  for (const words of ["I’m not sure when I will get it.", "nu știu când ajung", "e cât se poate de bine", "îți zic unde stăm după"]) {
    assert.equal(wordsAsk(words), false, words);
  }
});

test("request words ask wherever they stand, diacritics or not, and a verdict or a refusal does not", () => {
  for (const words of ["sună-mă", "Sună-l pe Dan", "suna-ma diseara", "te rog frumos să iei legătura", "poți să-mi trimiți contractul", "confirmă", "I need the invoice"]) {
    assert.equal(wordsAsk(words), true, words);
  }
  for (const words of ["Sună bine", "suna ok", "I don’t need it anymore", "no need", "Mulțumesc, am primit"]) {
    assert.equal(wordsAsk(words), false, words);
  }
});

test("a question mark asks, one inside a link does not, and a voice note asks by its transcript", () => {
  assert.equal(wordsAsk("ai timp mâine?"), true);
  assert.equal(wordsAsk("https://example.ro/?a=1"), false);
  assert.equal(readsAsAsk({ type: "voice", text: "[voice · 0:10]", transcript: "când vii acasă" }), true);
  assert.equal(readsAsAsk({ type: "voice", text: "[voice · 0:10]", transcript: null }), true, "unheard is an ask until proven otherwise");
  assert.equal(readsAsAsk({ type: "call", text: "[voice call]", transcript: null }), false);
});
