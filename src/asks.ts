/**
 * Whether a message's words ask something of the user: the judgment
 * the service's getUnanswered and catch_up's `waiting` share, so the two lists never
 * disagree about who is waiting. Pure: it reads words, never a protobuf.
 */

/** Not inside a longer word, on either side: `\b` does not know ă, â, î, ș and ț are letters. */
const START = String.raw`(?<![\p{L}\p{N}])`;
const END = String.raw`(?![\p{L}\p{N}])`;

/**
 * Words that ask something of the user wherever they stand, when the message
 * has no question mark. "Sună bine" is a verdict, not "call me"; "don't need"
 * asks for nothing.
 */
const REQUEST = new RegExp(
  String.raw`${START}(?:te rog|v[ăa] rog|po[țt]i|pute[țt]i|ai putea|a[țt]i putea|trimite|trimi[țt]i|sun[ăa](?!\s+(?:bine|ok|okay|super|perfect|grozav|interesant|ciudat|ca)${END})|spune-mi|zi-mi|confirm[ăai]?|urgent|please|can you|could you|would you|send me|let me know|(?<!(?:${START}not|${START}no|n['’]t)\s)need)${END}`,
  "iu"
);

/**
 * Question words ask only when they open a sentence, after at most a
 * connective: "când ajungi" and "and where are you" ask, "nu știu când vin"
 * and "I'm not sure when I will get it" do not.
 */
const QUESTION = new RegExp(
  String.raw`(?:^|[.!;:\n"“„])\s*(?:(?:[șs]i|dar|iar|ok|bun|and|but|so)[\s,]+)?(?:c[âa]nd|c[âa]t|unde|when|where|how much)${END}`,
  "iu"
);

/** A question mark, a request word or a sentence opened by a question word, once links are taken out: a link's query string is not a question. */
export function wordsAsk(text: string): boolean {
  const words = text.replace(/https?:\/\/\S+/g, "");
  return words.includes("?") || REQUEST.test(words) || QUESTION.test(words);
}

/**
 * A message that asks: never a call; a voice note nobody transcribed yet is
 * an ask until proven otherwise; anything else by its words (a voice note's
 * transcript included).
 */
export function readsAsAsk(message: { type: string; text: string; transcript: string | null }): boolean {
  if (message.type === "call") return false;
  if (message.type === "voice" && message.transcript === null) return true;
  return wordsAsk(message.transcript === null ? message.text : `${message.text} "${message.transcript}"`);
}
