/**
 * Bounded contextual retrieval over the existing conversation index. Context
 * is read fresh, not copied into an embedding or response cache: a retraction,
 * edit or new #private tag therefore takes effect on the next search.
 */
import {
  foldText,
  inflectionForms,
  nameWords,
  type AccountDb,
  type StoredMessage,
  type HybridHit,
} from "../db/index.js";
import { withoutPrivateQuote, type PrivatePeople } from "../private-contacts.js";
import { contentTokens } from "../search-query.js";
import type { SearchContext, SearchOptions } from "../wa-types.js";
import type { MessageViews } from "./views.js";
import type { AccountIdentity } from "./identity.js";
import { isFirstName } from "../db/names.js";

export const CONTEXT_CANDIDATES = 30;
export const CONTEXT_SHOWN = 5;
const CONTEXT_TEXT_CHARS = 600;
const NAME_PREPOSITIONS = new Set(["pentru", "lui", "pe", "cu", "despre", "for", "about"]);
const TEMPORAL_NAMES = new Set(
  "january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday ianuarie februarie martie aprilie mai iunie iulie august septembrie octombrie noiembrie decembrie luni marti miercuri joi vineri sambata duminica".split(
    " "
  )
);

/** Only the named author's private words are authorized by a from filter. */
export function allowedContext(
  message: StoredMessage,
  people: PrivatePeople | null,
  authorIds: readonly number[]
): boolean {
  return (
    people === null || !people.message(message) || (message.senderId !== null && authorIds.includes(message.senderId))
  );
}

export function contextRows(
  db: AccountDb,
  message: StoredMessage,
  opts: SearchOptions,
  people: PrivatePeople | null,
  author?: string
): StoredMessage[] {
  const authorIds = author === undefined ? [] : db.identity.contactIdsOf(author);
  const rows = db.messages.around(message.sid, {
    ...(opts.sinceMs === undefined ? {} : { since: opts.sinceMs }),
    ...(opts.untilMs === undefined ? {} : { until: opts.untilMs }),
  });
  // A direct reply carries a real relation even when it is hours apart. The
  // source still has to be visible, in the same chat and inside explicit dates.
  if (message.quotedSid !== null) {
    const quoted = db.messages.get(message.quotedSid);
    if (
      quoted !== null &&
      quoted.chatJid === message.chatJid &&
      !rows.some((row) => row.id === quoted.id) &&
      quoted.ts >= (opts.sinceMs ?? 0) &&
      quoted.ts <= (opts.untilMs ?? Number.MAX_SAFE_INTEGER)
    )
      rows.push(quoted);
  }
  return rows.filter((row) => allowedContext(row, people, authorIds)).sort((a, b) => a.id - b.id);
}

/**
 * A small, bounded coverage bonus refines the existing hybrid rank. It never
 * admits an unqualified hit or changes the model's meaning-only floor.
 */
export function rankWithContext(
  hits: readonly HybridHit[],
  query: string,
  rows: ReadonlyMap<number, StoredMessage[]>
): HybridHit[] {
  const tokens = contentTokens(query);
  if (tokens.length < 2) return [...hits];
  const score = (hit: HybridHit): number => {
    const text = foldText(
      (rows.get(hit.message.id) ?? [hit.message]).map((m) => `${m.text ?? ""}\n${m.transcript ?? ""}`).join("\n")
    );
    const coverage = tokens.filter((token) => text.includes(token)).length / tokens.length;
    return hit.score + 0.008 * coverage;
  };
  return hits
    .map((hit, index) => ({ hit, index, rank: score(hit) }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map(({ hit, rank }) => ({ ...hit, contextScore: rank }));
}

/**
 * A meaning-only hit about Luna cannot answer a question explicitly naming
 * Rex. Mid-sentence title-case names are evidence constraints, not inferred
 * sender filters. Romanian case endings reuse the contact resolver's forms.
 * Acronyms and the sentence's first word are left to the existing rankings.
 */
export function namedEvidence(
  hits: readonly HybridHit[],
  query: string,
  rows: ReadonlyMap<number, StoredMessage[]>,
  identity: AccountIdentity
): HybridHit[] {
  const words = [...query.matchAll(/[\p{L}\p{N}]+/gu)];
  // Title Case is formatting, not evidence that every noun is a proper name.
  if (words.filter((word) => /^\p{Lu}/u.test(word[0])).length > words.length / 2) return [...hits];
  const names = words.filter(
    (word, i) =>
      i > 0 &&
      /^\p{Lu}\p{Ll}{2,}$/u.test(word[0]) &&
      !TEMPORAL_NAMES.has(foldText(word[0])) &&
      (inflectionForms(foldText(word[0])).some(isFirstName) || NAME_PREPOSITIONS.has(foldText(words[i - 1]![0])))
  );
  if (names.length === 0) return [...hits];
  return hits.filter((hit) => {
    const context = rows.get(hit.message.id) ?? [hit.message];
    const text = context.map((m) => `${m.text ?? ""}\n${m.transcript ?? ""}`).join("\n");
    const labels = new Set(context.flatMap((m) => [m.chatJid, ...(m.senderJid === null ? [] : [m.senderJid])]));
    const tokens = new Set(
      nameWords(text + "\n" + [...labels].map((jid) => identity.displayName(jid)).join("\n")).flatMap(inflectionForms)
    );
    return names.every((name) => inflectionForms(foldText(name[0])).some((form) => tokens.has(form)));
  });
}

/** The top five windows, each chronological, compact and carrying exact source ids. */
export function renderContexts(
  hits: readonly StoredMessage[],
  rows: ReadonlyMap<number, StoredMessage[]>,
  views: MessageViews,
  people: PrivatePeople | null,
  author?: string,
  query = ""
): SearchContext[] {
  return hits.slice(0, CONTEXT_SHOWN).flatMap((anchor) => {
    const stored = rows.get(anchor.id);
    if (stored === undefined || !stored.some((m) => m.id === anchor.id)) return [];
    const messages = views.viewsOfStored(stored).map((view) => {
      const safe = people === null ? view : withoutPrivateQuote(view, people, author);
      const text = safe.transcript ?? safe.text;
      const excerpt = contextExcerpt(text, query);
      return {
        message_id: safe.message_id,
        chat_id: safe.chat_id,
        from_me: safe.from_me,
        sender: safe.sender,
        timestamp: safe.timestamp,
        type: safe.type,
        ...excerpt,
        ...(safe.quoted === undefined
          ? {}
          : { quoted: { ...safe.quoted, text: safe.quoted.text.slice(0, CONTEXT_TEXT_CHARS) } }),
      };
    });
    return [{ anchor_id: anchor.sid, messages, bounded: true }];
  });
}

/** A contiguous source excerpt near the query, keeping its original offset and truncation explicit. */
export function contextExcerpt(
  text: string,
  query: string
): { text: string; text_offset?: number; text_truncated?: true } {
  if (text.length <= CONTEXT_TEXT_CHARS) return { text };
  const tokens = contentTokens(query);
  const positions: Array<{ at: number; token: string }> = [];
  for (const word of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const folded = foldText(word[0]);
    for (const token of tokens) if (folded.includes(token)) positions.push({ at: word.index, token });
    if (positions.length >= 128) break;
  }
  let best = 0;
  let score = 0;
  for (const position of positions) {
    const start = Math.max(0, Math.min(text.length - CONTEXT_TEXT_CHARS, position.at - 150));
    const coverage = new Set(
      positions.filter((p) => p.at >= start && p.at < start + CONTEXT_TEXT_CHARS).map((p) => p.token)
    ).size;
    if (coverage > score) {
      best = start;
      score = coverage;
    }
  }
  return {
    text: text.slice(best, best + CONTEXT_TEXT_CHARS),
    text_truncated: true,
    ...(best > 0 ? { text_offset: best } : {}),
  };
}
