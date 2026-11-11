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
import { QUERY_STOPWORDS } from "../db/vectors.js";
import { withoutPrivateQuote, type PrivatePeople } from "../private-contacts.js";
import { contentTokens } from "../search-query.js";
import type { SearchContext, SearchOptions } from "../wa-types.js";
import type { MessageViews } from "./views.js";
import type { AccountIdentity } from "./identity.js";
import { isFirstName } from "../db/names.js";

export const CONTEXT_CANDIDATES = 30;
export const CONTEXT_SHOWN = 5;
/** How far back from the newest message a hit's chat is read for what it said later, and how much of that is shown. */
export const LATER_SCAN = 200;
export const LATER_SHOWN = 2;
/** Words every chat repeats: sharing them says nothing about sharing a subject. */
const CHAT_FILLER = new Set(
  "buna ziua seara dimineata salut hello multumesc mersi maine astazi acum bine poate foarte doar mult inca deja atunci toate totul vreau trebuie putem thanks thank okay today tomorrow just like will".split(" ")
);
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

/** A message's subject words, each cut to five letters: Romanian and English endings move, the start of a word seldom does. */
function subjectStems(message: StoredMessage): Set<string> {
  const stems = new Set<string>();
  for (const word of `${message.text ?? ""}\n${message.transcript ?? ""}`.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const folded = foldText(word);
    if ([...folded].length < 4 || QUERY_STOPWORDS.has(folded) || CHAT_FILLER.has(folded)) continue;
    stems.add([...folded].slice(0, 5).join(""));
  }
  return stems;
}

/**
 * What a hit's chat said later on the same subject, past its window: a plan
 * changed two weeks on rarely repeats the words of the question, but it
 * repeats the plan's. The newest messages sharing two of the hit's subject
 * words, at most LATER_SHOWN, chronological; inside the search's dates.
 */
export function laterRows(
  db: AccountDb,
  anchor: StoredMessage,
  window: readonly StoredMessage[],
  opts: SearchOptions,
  people: PrivatePeople | null,
  author?: string
): StoredMessage[] {
  const subject = subjectStems(anchor);
  if (subject.size < 2) return [];
  const authorIds = author === undefined ? [] : db.identity.contactIdsOf(author);
  const shown = new Set(window.map((row) => row.id));
  return db.messages
    .later(anchor.sid, {
      limit: LATER_SCAN,
      ...(opts.sinceMs === undefined ? {} : { since: opts.sinceMs }),
      ...(opts.untilMs === undefined ? {} : { until: opts.untilMs }),
    })
    .filter((row) => !shown.has(row.id) && allowedContext(row, people, authorIds))
    .filter((row) => [...subjectStems(row)].filter((stem) => subject.has(stem)).length >= 2)
    .slice(0, LATER_SHOWN)
    .reverse();
}

/** `laterRows` for the hits whose windows are shown. */
export function laterOf(
  db: AccountDb,
  hits: readonly StoredMessage[],
  rows: ReadonlyMap<number, StoredMessage[]>,
  opts: SearchOptions,
  people: PrivatePeople | null,
  author?: string
): Map<number, StoredMessage[]> {
  return new Map(hits.slice(0, CONTEXT_SHOWN).map((hit) => [hit.id, laterRows(db, hit, rows.get(hit.id) ?? [hit], opts, people, author)]));
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

/** The top five windows, each chronological, compact and carrying exact source ids, with what the chat said later on it. */
export function renderContexts(
  hits: readonly StoredMessage[],
  rows: ReadonlyMap<number, StoredMessage[]>,
  views: MessageViews,
  people: PrivatePeople | null,
  author?: string,
  query = "",
  later: ReadonlyMap<number, StoredMessage[]> = new Map()
): SearchContext[] {
  const render = (stored: readonly StoredMessage[]): SearchContext["messages"] =>
    views.viewsOfStored(stored).map((view) => {
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
  return hits.slice(0, CONTEXT_SHOWN).flatMap((anchor) => {
    const stored = rows.get(anchor.id);
    if (stored === undefined || !stored.some((m) => m.id === anchor.id)) return [];
    const after = later.get(anchor.id) ?? [];
    return [{ anchor_id: anchor.sid, messages: render(stored), ...(after.length === 0 ? {} : { later: render(after) }), bounded: true as const }];
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
