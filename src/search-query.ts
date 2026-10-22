/** Planning uses only the caller's words: it never invents a person or a date. */
import { WazapError } from "./errors.js";
import { foldText, hybridTokens } from "./db/index.js";
import { QUERY_STOPWORDS } from "./db/vectors.js";
import type { MessageView, SearchAssessment } from "./wa-types.js";

export type SearchMatch = "auto" | "hybrid" | "words";

/** A bare until date includes the whole local day, shared by canonical and cached reads. */
export function parseMoment(value: string | undefined, field: string, endOfDay = false): number | undefined {
  if (value === undefined) return undefined;
  const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  const ms = Date.parse(bareDate ? `${value.trim()}T${endOfDay ? "23:59:59.999" : "00:00:00"}` : value);
  if (Number.isNaN(ms))
    throw new WazapError(
      "INVALID_ID",
      `${field} is not a date: "${value}".`,
      'Pass "2026-09-01" or an ISO timestamp like "2026-09-01T14:00:00+03:00"'
    );
  return ms;
}

/** Codes and quoted literals have an exact fast path; ordinary questions use both rankings. */
export function planSearch(
  query: string,
  match: SearchMatch,
  before?: string
): { query: string; match: "hybrid" | "words"; literal?: string } {
  if (before !== undefined && match === "hybrid")
    throw new WazapError("INVALID_ID", "A message cursor requires match words.");
  if (match !== "auto") return { query, match };
  const text = query.trim();
  const quoted = /^(?:"([^"]+)"|«([^»]+)»|“([^”]+)”)$/u.exec(text);
  if (quoted !== null) {
    const literal = quoted[1] ?? quoted[2] ?? quoted[3]!;
    return { query: literal, match: "words", literal };
  }
  const code =
    /^(?:https?:\/\/\S+|[^\s@]+@[^\s@]+\.[^\s@]+|(?=[\p{L}\p{N}:/._+-]*\d)[\p{L}\p{N}][\p{L}\p{N}:/._+-]{2,})$/u.test(
      text
    );
  return {
    query: code ? text : query,
    match: before !== undefined || code ? "words" : "hybrid",
    ...(code ? { literal: text } : {}),
  };
}

/** Automatic literals are whole values: INV-104 must not match INV-1040. Explicit words keeps substring search. */
export function literalMatches(text: string, literal: string): boolean {
  const value = foldText(literal);
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const left = /^[\p{L}\p{N}]/u.test(value) ? "(?<![\\p{L}\\p{N}])" : "";
  const right = /[\p{L}\p{N}]$/u.test(value) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(left + escaped + right, "u").test(foldText(text));
}

/** Broad question nouns name a kind of answer, not which event/person it belongs to. */
const VAGUE = new Set(
  "adresa adresă address loc locul location ora hour time chestia thing aia ala acolo there trimis trimisa sent trebuia supposed ajung arrive era fost was cand unde care what where when"
    .split(" ")
    .map(foldText)
);

export function contentTokens(query: string): string[] {
  return hybridTokens(query).filter((token) => !QUERY_STOPWORDS.has(token));
}

/** A conservative ambiguity signal, never a probability or a claim that a candidate answers the question. */
export function assessSearch(
  query: string,
  messages: readonly Pick<MessageView, "chat_id" | "message_id">[],
  exact = false
): SearchAssessment {
  const chats = new Set(messages.map((m) => m.chat_id));
  const unanchored = contentTokens(query).every((token) => VAGUE.has(token));
  const question = /^(?:unde|cand|când|care|ce|cum|where|when|what|which|how)\b/iu.test(query.trim());
  if (!exact && question && unanchored && chats.size !== 1)
    return {
      state: "ambiguous",
      note: "This question does not identify an event or person. Use the user's conversation context; otherwise ask one short clarification before choosing an answer.",
    };
  if (messages.length === 0)
    return {
      state: "no_matches",
      note: "No candidates in the searched history; this does not establish absence from WhatsApp.",
    };
  return {
    state: "candidates",
    note: "Candidates, not verified answers. Read the context chronologically, check corrections and cite the actual supporting message. Clarify if several interpretations remain plausible.",
  };
}
