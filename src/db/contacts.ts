/**
 * Finding who "mama", "Ana de la contabilitate" or "fotbal" is (find_contact,
 * F2-3): people and groups scored by how their names meet the words asked,
 * what the user filed about them, and how much the user talks to them, with a
 * verdict on whether one of them is clearly meant.
 *
 *   db.contacts.find({ name: "Ana", qualifier: "contabilitate", kind: "person" })
 *   // { verdict: "resolved", candidates: [{ contactId, jid, score, match, qualifier, lastExchange, … }], … }
 *
 * The score, in points (FIND_SCORES):
 * - the match — the best one over every name a candidate carries: exact name
 *   100, every word asked is a word of the name 80, through a diminutive 70,
 *   through the start of a word 60, inside a word 15; a case ending ("Mariei")
 *   takes 5 off; a nickname or relationship the user filed, or a tag, adds 10;
 *   a name the person gave themselves (their push name) takes 5 off;
 * - the qualifier, when one is asked: +30 when it is in what the user filed
 *   (note, tags, details), +20 in their business name or a group they wrote in
 *   in the last 90 days, −15 when it is nowhere;
 * - the user's relationship with them: the last exchange (either way) within
 *   7 days +25, 30 days +15, 90 days +8; the user's own messages to them in 90
 *   days, 20 or more +10, 5 or more +6, one or more +3; a saved contact +5.
 *
 * Candidates rank by their match first; the qualifier and the relationship
 * order those whose names match alike, so a name talked to daily never
 * outranks a better-matching one.
 *
 * The verdict: `resolved` when the best candidate scores 80 or more and 25 more
 * than the next (or the next cannot resolve and matches 10 points worse);
 * `ambiguous` with up to 5 candidates otherwise; `not_found`, with the closest
 * weak matches (a word inside a name, a near spelling), when no candidate
 * matches at least through the start of a word. Some matches are offered but
 * never resolve, their score held at 79: through the start of a word only
 * ("Ion" in Ionescu), through a case ending the tables do not vouch for (a
 * base that is not a known first name or relationship word), a relationship
 * word after a first name ("Andreea Sora": a sister or a surname), and the
 * words that name someone else's relative ("Andrei" in "Mama lui Andrei",
 * which also takes 20 points off). A relationship word ("mama") matches only
 * what the user filed — a saved name or a note that is the relationship alone,
 * a tag, a nickname or relationship detail — and a not_found for one carries no
 * closest: who it is is a question for the user. Groups match by their name;
 * a group the account left is not a candidate.
 */
import type { Connection } from "./connection.js";
import { StorageError } from "./errors.js";
import { foldText } from "./fold.js";
import { idLowerBound } from "./ids.js";
import { VISIBLE } from "./rows.js";
import {
  diminutivesOf,
  editDistance,
  inflectionForms,
  isKnownBase,
  isRealName,
  nameWords,
  NAME_PARTICLES,
  NICKNAME_FIELDS,
  possessorIndexes,
  relationDetailMatch,
  relationOf,
  relationWordsMatch,
  RELATIONSHIP_FIELDS,
  RELATIONSHIPS,
  ROLE_FIELDS,
  roleBase,
} from "./names.js";

export type FindKind = "person" | "group" | "any";
export type MatchClass = "exact" | "word" | "diminutive" | "prefix" | "substring" | "fuzzy";
export type MatchSource = "nickname" | "relatie" | "tag" | "field" | "note" | "name" | "business_name" | "notify" | "push_name" | "group_name" | "number" | "id";
export type QualifierSource = "note" | "tag" | "field" | "business_name" | "group_name";
export type FindVerdict = "resolved" | "ambiguous" | "not_found";

/**
 * Tells a group the account left from one it is in, from the chat's stored
 * protobuf; the service supplies it (the storage layer does not parse
 * protobuf). Without it no group counts as left.
 */
export type LeftGroup = (proto: Uint8Array) => boolean;

export const FIND_SCORES = Object.freeze({
  match: Object.freeze({ exact: 100, word: 80, diminutive: 70, prefix: 60, substring: 15, fuzzy: 10 } satisfies Record<MatchClass, number>),
  inflected: -5,
  userData: 10,
  selfNamed: -5,
  qualifier: Object.freeze({ filed: 30, businessOrGroup: 20, miss: -15 }),
  /** [within days, points], first that fits. */
  recency: Object.freeze([
    [7, 25],
    [30, 15],
    [90, 8],
  ] as ReadonlyArray<readonly [number, number]>),
  /** [at least own messages in 90 days, points], first that fits. */
  frequency: Object.freeze([
    [20, 10],
    [5, 6],
    [1, 3],
  ] as ReadonlyArray<readonly [number, number]>),
  saved: 5,
  /** A match on words that name someone else's relative ("Mama lui Andrei" for "Andrei"). */
  possessor: -20,
  resolvedScore: 80,
  resolvedGap: 25,
  /**
   * A candidate matched only through the start of a word, a case ending the
   * tables do not vouch for, a relationship word after a name, or the words
   * naming someone else's relative, never resolves: its score is held here.
   */
  unresolvableCap: 79,
  /** A next candidate that cannot resolve does not stand in the way of one whose match is this much better. */
  unresolvableMatchGap: 10,
  /** A match at least this good can be resolved or ambiguous; below it a candidate is only ever closest. */
  eligibleMatch: 60,
  ambiguousMax: 5,
  closestMax: 3,
});

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 90;
/** A sender's newest messages read for the groups they share with the user. */
const GROUP_SCAN_MESSAGES = 2_000;
const GROUP_NAMES_MAX = 5;
const QUALIFIER_STOPWORDS = new Set(["de", "la", "din", "de la", "pe", "cu", "si", "sau", "al", "a", "ale", "lui", "from", "at", "the", "of", "and", "in", "on", "with"]);

export interface FindInput {
  /** What the user calls them: a name, a nickname, a relationship ("mama"), a group's name. */
  name: string;
  /** What tells two of the same name apart: "contabilitate", "fotbal". */
  qualifier?: string | null;
  kind?: FindKind;
  /** Candidates returned; at most 5 when ambiguous, 3 as closest. */
  limit?: number;
  /**
   * The last digits (4 or more) of the number the user means: only people
   * whose phone number ends with them stay candidates, before the limit. A
   * single one resolves when their name matched as a whole word or would
   * resolve anyway; a weaker name match stays a question.
   */
  numberTail?: string | null;
}

/**
 * Someone asked for by a number or an id instead of a name. `digits`: the
 * number as typed, digits only, an international 00 dropped; it matches a
 * person's number in full, or else its end once leading zeros are gone ("0722
 * 001 111" is 40722001111). `jids`: every spelling of one id (a lid and the
 * number it pairs with); it matches a person by number or lid, or a group.
 */
export type LookupInput = { kind?: FindKind; limit?: number } & ({ source: "number"; digits: string } | { source: "id"; jids: readonly string[] });

/** A number typed the way it is dialled at home matches on its last digits, never fewer than these. */
export const LOOKUP_MIN_DIGITS = 7;

export interface QualifierHit {
  source: QualifierSource;
  /** The note, tag, detail ("key: value"), business name or group name it was found in. */
  value: string;
}

export interface ContactCandidate {
  kind: "person" | "group";
  /** The person's contact row; null for a group. */
  contactId: number | null;
  /** The person's direct chat, or the group's chat; null for someone never written with. */
  chatId: number | null;
  /** The phone jid (or the lid while the number is unknown), or the group jid. */
  jid: string;
  displayName: string;
  names: {
    saved: string | null;
    notify: string | null;
    pushName: string | null;
    business: string | null;
    nickname: string | null;
    group: string | null;
  };
  score: number;
  match: {
    class: MatchClass;
    source: MatchSource;
    value: string;
    /** The match's points, before the qualifier and the relationship; candidates rank on this first. */
    score: number;
    inflected: boolean;
    relationship: string | null;
    /** False for a match that never resolves on its own (FIND_SCORES.unresolvableCap). */
    resolvable: boolean;
  };
  /** Null when no qualifier was asked. */
  qualifier: { hits: QualifierHit[]; score: number } | null;
  /** The points the relationship with the user added, by part. */
  relationship: { recency: number; frequency: number; saved: number };
  /** The newest visible message between them, either way. */
  lastExchange: { at: number; fromMe: boolean } | null;
  /** The user's own messages to them (or in the group) in the last 90 days. */
  ownMessages90d: number;
  /** Groups (not left) the person wrote in, newest first; null for a group, and for candidates not returned. */
  groupsInCommon: { count: number; names: string[] } | null;
  saved: boolean;
  business: boolean;
  tags: string[];
  phoneLast4: string | null;
}

export interface FindResult {
  verdict: FindVerdict;
  /** resolved: the one; ambiguous: the best few, best first; not_found: none. */
  candidates: ContactCandidate[];
  /** not_found only: the weak matches nearest to what was asked. */
  closest: ContactCandidate[];
  /** How the words were read: folded, particles dropped, and the relationship they name. */
  query: { words: string[]; relationship: string | null; qualifier: string[] };
}

interface QueryWord {
  word: string;
  forms: string[];
  related: Set<string>;
}

const NO_WORDS: Set<string> = new Set();

interface Match {
  class: MatchClass;
  inflected: boolean;
  /** Whether this match alone may resolve: see FIND_SCORES.unresolvable. */
  resolvable: boolean;
  /** Matched only words that name someone else ("Mama lui Andrei" for "Andrei"). */
  possessor?: boolean;
}

interface PersonRow {
  id: number;
  phone_jid: string | null;
  lid: string | null;
  name: string | null;
  notify: string | null;
  push_name: string | null;
  verified_name: string | null;
  is_business: number | null;
  note: string | null;
  tags: string | null;
  fields: string | null;
}

interface GroupRow {
  id: number;
  jid: string;
  name: string;
  proto: Uint8Array | null;
  last_ts: number | null;
  last_from_me: number | null;
  /** Whether the account left it, worked out the first time a match needs it. */
  left?: boolean;
}


interface Scored {
  candidate: ContactCandidate;
  person: Person | null;
  group: GroupRow | null;
  familyChats: number[];
  familyContacts: number[];
}

/** A name as matching reads it: where it came from, as written, split into folded words. */
interface NameSource {
  source: MatchSource;
  value: string;
  words: string[];
}

/** A person folded once, and kept until anything matching reads of them changes. */
interface Person {
  row: PersonRow;
  /** The saved name's words, what a relationship is matched against. */
  savedWords: string[];
  /** Nickname details, the saved name, the business name, the sync name and the push name that are real names. */
  names: NameSource[];
  /** Relationship and role details, their words reduced by roleBase: what a word that is not a relationship ("dentista") meets. */
  roles: NameSource[];
  fields: Array<{ folded: string; key: string; value: string; words: string[] }>;
  tags: Array<{ tag: string; words: string[] }>;
  noteWords: string[];
  saved: boolean;
  nickname: string | null;
}

function parseJson<T>(json: string | null, fallback: T): T {
  if (json === null) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

const PERSON_COLUMNS = ["id", "phone_jid", "lid", "name", "notify", "push_name", "verified_name", "is_business", "note", "tags", "fields"] as const;

type PersonValues = Array<PersonRow[keyof PersonRow]>;

/** Whether a row, as read (PERSON_COLUMNS order), still reads as the person folded from it. */
function samePerson(row: PersonRow, values: PersonValues): boolean {
  for (let index = 0; index < PERSON_COLUMNS.length; index++) if (row[PERSON_COLUMNS[index]!] !== values[index]) return false;
  return true;
}

function personRow(values: PersonValues): PersonRow {
  const row: Record<string, unknown> = {};
  for (let index = 0; index < PERSON_COLUMNS.length; index++) row[PERSON_COLUMNS[index]!] = values[index];
  return row as unknown as PersonRow;
}

function personOf(row: PersonRow): Person {
  const fields = Object.entries(parseJson<Record<string, unknown>>(row.fields, {})).map(([key, value]) => ({
    folded: foldText(key).trim(),
    key,
    value: String(value),
    words: nameWords(String(value)),
  }));
  const tags = parseJson<unknown[]>(row.tags, []).map((tag) => ({ tag: String(tag), words: nameWords(String(tag)) }));
  const names: NameSource[] = [];
  for (const field of fields) {
    if (NICKNAME_FIELDS.has(field.folded)) names.push({ source: "nickname", value: `${field.key}: ${field.value}`, words: field.words });
  }
  for (const [source, value] of [
    ["name", row.name],
    ["business_name", row.verified_name],
    ["notify", row.notify],
    ["push_name", row.push_name],
  ] as const) {
    if (isRealName(value)) names.push({ source, value: value!, words: nameWords(value) });
  }
  const roles: NameSource[] = [];
  for (const field of fields) {
    const source: MatchSource | null = RELATIONSHIP_FIELDS.has(field.folded) ? "relatie" : ROLE_FIELDS.has(field.folded) ? "field" : null;
    if (source !== null && field.words.length > 0) roles.push({ source, value: `${field.key}: ${field.value}`, words: field.words.map(roleBase) });
  }
  return {
    row,
    savedWords: isRealName(row.name) ? nameWords(row.name) : [],
    names,
    roles,
    fields,
    tags,
    noteWords: nameWords(row.note),
    saved: isRealName(row.name),
    nickname: fields.find((field) => NICKNAME_FIELDS.has(field.folded))?.value ?? null,
  };
}

/**
 * Every word asked must meet its own word of the name; the weakest way any of
 * them did is the class. A case ending the tables do not vouch for, a prefix,
 * or a match on the words that name someone else's relative, cannot resolve.
 */
function matchWords(query: readonly QueryWord[], words: readonly string[]): Match | null {
  const indexes: number[] = [];
  words.forEach((word, index) => {
    if (word !== "lui") indexes.push(index);
  });
  if (indexes.length === 0 || query.length === 0) return null;
  const used = new Set<number>();
  let inflected = false;
  let unverified = false;
  let diminutive = false;
  let prefix = false;
  const take = (test: (token: string) => boolean): string | null => {
    for (const index of indexes) {
      if (!used.has(index) && test(words[index]!)) {
        used.add(index);
        return words[index]!;
      }
    }
    return null;
  };
  let whole = true;
  for (const q of query) {
    if (take((token) => token === q.word) !== null) continue;
    const base = q.forms.length > 0 ? take((token) => q.forms.includes(token)) : null;
    if (base !== null) {
      inflected = true;
      if (!isKnownBase(base)) unverified = true;
      continue;
    }
    if (q.related.size > 0 && take((token) => q.related.has(token)) !== null) {
      diminutive = true;
      continue;
    }
    if (q.word.length >= 3 && take((token) => token.length > q.word.length && token.startsWith(q.word)) !== null) {
      prefix = true;
      continue;
    }
    whole = false;
    break;
  }
  if (whole) {
    const cls: MatchClass = prefix ? "prefix" : diminutive ? "diminutive" : query.length === indexes.length ? "exact" : "word";
    const possessors = possessorIndexes(words);
    const possessor = !used.has(0) && [...used].some((index) => possessors.has(index));
    return { class: cls, inflected, resolvable: !prefix && !unverified && !possessor, possessor };
  }
  const needle = query.map((q) => q.word).join(" ");
  const tokens = indexes.map((index) => words[index]!);
  return needle.length >= 3 && tokens.join(" ").includes(needle) ? { class: "substring", inflected: false, resolvable: false } : null;
}

/** Every word asked is a near spelling of a word of the name: one edit up to six letters, two above. */
function nearWords(query: readonly QueryWord[], words: readonly string[]): boolean {
  if (words.length === 0) return false;
  return query.every((q) => {
    if (q.word.length < 4) return false;
    const max = q.word.length > 6 ? 2 : 1;
    return words.some((word) => Math.abs(word.length - q.word.length) <= max && editDistance(q.word, word, max) <= max);
  });
}

/** Whether a word of the qualifier is a word of the text, or shares most of a long word's start with one ("contabil" / "contabilitate"). */
function qualifierIn(qualifier: readonly string[][], words: readonly string[]): boolean {
  if (words.length === 0) return false;
  return qualifier.some((forms) =>
    forms.some((form) =>
      words.some((token) => {
        if (token === form) return true;
        const shorter = Math.min(token.length, form.length);
        if (shorter < 5) return false;
        let common = 0;
        while (common < shorter && token[common] === form[common]) common++;
        return common >= Math.max(5, Math.ceil(shorter * 0.75));
      })
    )
  );
}

function pointsFor(table: ReadonlyArray<readonly [number, number]>, test: (threshold: number) => boolean): number {
  for (const [threshold, points] of table) if (test(threshold)) return points;
  return 0;
}

const USER_DATA_SOURCES: ReadonlySet<MatchSource> = new Set(["nickname", "relatie", "tag", "field", "note"]);
const SELF_NAMED_SOURCES: ReadonlySet<MatchSource> = new Set(["notify", "push_name"]);

function matchScore(match: Match, source: MatchSource): number {
  return (
    FIND_SCORES.match[match.class] +
    (match.inflected ? FIND_SCORES.inflected : 0) +
    (match.possessor === true ? FIND_SCORES.possessor : 0) +
    (USER_DATA_SOURCES.has(source) ? FIND_SCORES.userData : 0) +
    (SELF_NAMED_SOURCES.has(source) ? FIND_SCORES.selfNamed : 0)
  );
}

/** How list_contacts orders the address book: by the last conversation first, or in the address book's own order. */
export type AddressBookOrder = "recent" | "address_book";

/** Where an address book entry sits in either order; a page resumes after the one it names. */
export interface AddressBookKey {
  /** The address book's place (contacts.listed). */
  listed: number;
  /** The contact row. */
  id: number;
  /** The last direct message's time, as the listing reads it; null when they never talked. */
  at: number | null;
}

export interface AddressBookInput {
  order: AddressBookOrder;
  /** Entries on the page, 1 to 500. */
  limit: number;
  /**
   * A message stored after this stored_seq does not count as the last one:
   * a listing's first page fixes it at digest.storedTop(), so a later page
   * sees the conversations the first one saw and nobody moves past the cursor.
   */
  asOfSeq: number;
  /** Resume after this entry, the previous page's last; absent for a first page. */
  after?: AddressBookKey | null;
  /** People left out (the #private ones): contact rows, and numbers or lids. */
  exclude?: { contactIds: ReadonlySet<number>; jids: ReadonlySet<string> } | null;
}

export interface AddressBookEntry {
  contactId: number;
  /** The phone jid, `<digits>@s.whatsapp.net`: the direct chat's id. */
  jid: string;
  /** The name saved in the phone's address book (contacts.name). */
  name: string;
  listed: number;
  /** The newest message of the direct chat, as of asOfSeq; null when they never talked. */
  last: { at: number; fromMe: boolean } | null;
}

export interface AddressBookPage {
  entries: AddressBookEntry[];
  /** Entries the whole listing holds, in either order. */
  total: number;
  /** The key to resume after; null on the last page. */
  next: AddressBookKey | null;
  /**
   * Whether the address book itself has arrived: someone saved with a name
   * has no chat with the account. The history sync names only the people of
   * its chats, so names that all have a chat may be the history's alone.
   */
  arrived: boolean;
}

/** The most an address book page holds. */
export const ADDRESS_BOOK_MAX_PAGE = 500;

/**
 * The address book as list_contacts reads it: a person a contact event placed
 * in it (listed), who carries a saved name and a phone number; never a lid
 * alone, a group or the account itself. A row still merging into another is
 * that other one. `name` is filled by the address book WhatsApp sends after
 * linking and by the name the history gives a direct chat (the saved name, or
 * a username); a push name goes to notify and push_name instead.
 */
const ADDRESS_BOOK_SQL = `SELECT id, phone_jid, name, listed FROM contacts INDEXED BY contacts_listed
  WHERE listed IS NOT NULL AND merged_into IS NULL AND phone_jid IS NOT NULL AND name IS NOT NULL`;

/**
 * Every direct chat, filed under the person it is with (a contact still
 * merging answers for the one it merges into), with its newest message a
 * reader may see — its time, direction, kind and when it was stored — when it
 * has one.
 */
const DIRECT_CHATS_SQL = `SELECT c.id, coalesce(k.merged_into, k.id) AS owner, c.last_message_id, c.last_ts, c.last_from_me, c.cleared_through_ts, m.stored_seq, m.type
  FROM chats c CROSS JOIN contacts k ON k.id = c.contact_id LEFT JOIN messages m ON m.id = c.last_message_id
  WHERE c.kind = 'direct' AND c.merged_into IS NULL`;

/** Negative when a comes before b in the order asked. Recent: talked first, newest first, then the address book's order. */
export function compareAddressBook(order: AddressBookOrder, a: AddressBookKey, b: AddressBookKey): number {
  if (order === "recent") {
    if ((a.at === null) !== (b.at === null)) return a.at === null ? 1 : -1;
    if (a.at !== null && b.at !== null && a.at !== b.at) return a.at > b.at ? -1 : 1;
  }
  return a.listed - b.listed || a.id - b.id;
}

const PEOPLE_SQL = `SELECT k.id, k.phone_jid, k.lid, k.name, k.notify, k.push_name, k.verified_name, k.is_business, n.note, n.tags, n.fields
  FROM contacts k LEFT JOIN contact_notes n ON n.contact_id = k.id
  WHERE k.merged_into IS NULL AND (k.phone_jid IS NOT NULL OR k.lid IS NOT NULL)
    AND (k.name IS NOT NULL OR k.notify IS NOT NULL OR k.push_name IS NOT NULL OR k.verified_name IS NOT NULL OR n.contact_id IS NOT NULL)`;

export class Contacts {
  /** People as last folded, by contact id; an entry is folded again when anything it was read from changes. */
  private folded = new Map<number, Person>();

  constructor(
    private readonly c: Connection,
    private readonly leftGroup: LeftGroup | null = null
  ) {}

  find(input: FindInput): FindResult {
    if (typeof input?.name !== "string") throw new StorageError("INVALID_INPUT", "find needs a name.");
    const kind: FindKind = input.kind ?? "any";
    if (!["person", "group", "any"].includes(kind)) throw new StorageError("INVALID_INPUT", `kind is person, group or any, not ${String(kind)}.`);
    const limit = Math.max(1, Math.min(20, Math.floor(Number.isFinite(input.limit) ? input.limit! : FIND_SCORES.ambiguousMax)));

    const asked = nameWords(input.name);
    const kept = asked.filter((word) => !NAME_PARTICLES.has(word));
    const words = kept.length > 0 ? kept : asked;
    if (words.length === 0) throw new StorageError("INVALID_INPUT", "find needs a name with at least one letter or digit.");
    const relation = words.length === 1 ? relationOf(words[0]!) : null;
    const query: QueryWord[] = words.map((word) => {
      const forms = inflectionForms(word);
      const related = new Set<string>();
      for (const form of forms) for (const name of diminutivesOf(form)) related.add(name);
      return { word, forms: forms.slice(1), related };
    });
    const numberTail = (input.numberTail ?? "").replace(/\D/g, "");
    if (input.numberTail != null && numberTail.length < 4) throw new StorageError("INVALID_INPUT", "numberTail needs at least 4 digits.");
    const qualifierWords = nameWords(input.qualifier ?? "").filter((word) => !QUALIFIER_STOPWORDS.has(word));
    const qualifier = qualifierWords.map((word) => inflectionForms(word));

    const now = this.c.now();
    const since90 = idLowerBound(Math.max(1, now - WINDOW_DAYS * DAY_MS));
    const groupRows = this.groupRows();
    const people = kind === "group" ? [] : this.people();
    const qualifierGroups = qualifier.length === 0 ? [] : groupRows.filter((group) => qualifierIn(qualifier, nameWords(group.name)) && this.stillIn(group));

    const scored: Scored[] = [];
    if (kind !== "group") scored.push(...this.matchPeople(people, query, relation, false));
    if (kind !== "person" && relation === null) scored.push(...this.matchGroups(groupRows, query, false));
    this.relate(scored, query, now, since90, qualifier, qualifierGroups);
    // The match ranks first; the qualifier and the relationship order candidates whose names match alike.
    const order = (a: Scored, b: Scored): number =>
      b.candidate.match.score - a.candidate.match.score ||
      b.candidate.score - a.candidate.score ||
      (b.candidate.lastExchange?.at ?? -1) - (a.candidate.lastExchange?.at ?? -1) ||
      Number(b.candidate.saved) - Number(a.candidate.saved) ||
      (a.candidate.contactId ?? a.candidate.chatId ?? 0) - (b.candidate.contactId ?? b.candidate.chatId ?? 0);
    scored.sort(order);

    const result: FindResult = {
      verdict: "not_found",
      candidates: [],
      closest: [],
      query: { words, relationship: relation, qualifier: qualifierWords },
    };
    const eligible = scored.filter((entry) => FIND_SCORES.match[entry.candidate.match.class] >= FIND_SCORES.eligibleMatch);
    if (numberTail !== "" && eligible.length > 0) {
      const onNumber = eligible.filter(({ candidate }) => {
        const [user, server] = candidate.jid.split("@");
        return candidate.kind === "person" && server === "s.whatsapp.net" && user!.endsWith(numberTail);
      });
      if (onNumber.length === 0) {
        // Named so, on other numbers: who the user may have misremembered.
        result.closest = eligible.slice(0, Math.min(limit, FIND_SCORES.closestMax)).map((entry) => this.withGroups(entry, groupRows));
        return result;
      }
      const only = onNumber[0]!.candidate;
      const resolved = onNumber.length === 1 && (only.match.resolvable || only.match.class === "exact" || only.match.class === "word");
      result.verdict = resolved ? "resolved" : "ambiguous";
      const shown = resolved ? [onNumber[0]!] : onNumber.slice(0, Math.min(limit, FIND_SCORES.ambiguousMax));
      result.candidates = shown.map((entry) => this.withGroups(entry, groupRows));
      return result;
    }
    if (eligible.length > 0) {
      const [top, next] = eligible.map((entry) => entry.candidate);
      const resolved =
        top!.match.resolvable &&
        top!.score >= FIND_SCORES.resolvedScore &&
        (next === undefined ||
          top!.score - next.score >= FIND_SCORES.resolvedGap ||
          (!next.match.resolvable && top!.match.score - next.match.score >= FIND_SCORES.unresolvableMatchGap));
      result.verdict = resolved ? "resolved" : "ambiguous";
      const shown = resolved ? [eligible[0]!] : eligible.slice(0, Math.min(limit, FIND_SCORES.ambiguousMax));
      result.candidates = shown.map((entry) => this.withGroups(entry, groupRows));
      return result;
    }
    // Who a relationship is, the user says; nothing near it is offered instead.
    if (relation !== null) return result;
    let weak = scored;
    if (weak.length === 0) {
      weak = [
        ...(kind !== "group" ? this.matchPeople(people, query, null, true) : []),
        ...(kind !== "person" ? this.matchGroups(groupRows, query, true) : []),
      ];
      this.relate(weak, query, now, since90, qualifier, qualifierGroups);
      weak.sort(order);
    }
    result.closest = weak.slice(0, Math.min(limit, FIND_SCORES.closestMax)).map((entry) => this.withGroups(entry, groupRows));
    return result;
  }

  /**
   * Who a number or an id is (LookupInput): each one found is an exact match
   * from `source`, resolved when there is one, ambiguous when a number's end
   * fits several people, not_found with no closest otherwise. The account
   * itself and a group it left are nobody.
   */
  lookup(input: LookupInput): FindResult {
    const kind: FindKind = input.kind ?? "any";
    const limit = Math.max(1, Math.min(20, Math.floor(Number.isFinite(input.limit) ? input.limit! : FIND_SCORES.ambiguousMax)));
    const people = kind === "group" ? [] : this.people();
    const groupRows = this.groupRows();
    const exact = (value: string): ContactCandidate["match"] => ({
      class: "exact",
      source: input.source,
      value,
      score: FIND_SCORES.match.exact,
      inflected: false,
      relationship: null,
      resolvable: true,
    });
    const scored: Scored[] = [];
    const addPerson = (person: Person): void => {
      const value = input.source === "number" ? person.row.phone_jid!.split("@")[0]! : (person.row.phone_jid ?? person.row.lid)!;
      scored.push({ person, group: null, familyChats: [], familyContacts: [], candidate: this.personCandidate(person, exact(value)) });
    };
    if (input.source === "number") {
      const numberOf = (person: Person): string | null => person.row.phone_jid?.split("@")[0] ?? null;
      const whole = people.filter((person) => numberOf(person) === input.digits);
      const tail = input.digits.replace(/^0+/, "");
      const fits = whole.length > 0 ? whole : tail.length >= LOOKUP_MIN_DIGITS ? people.filter((person) => numberOf(person)?.endsWith(tail) === true) : [];
      fits.forEach(addPerson);
    } else {
      const wanted = new Set(input.jids);
      for (const person of people) {
        if ((person.row.phone_jid !== null && wanted.has(person.row.phone_jid)) || (person.row.lid !== null && wanted.has(person.row.lid))) addPerson(person);
      }
      if (kind !== "person") {
        for (const row of groupRows) {
          if (wanted.has(row.jid) && this.stillIn(row)) scored.push(this.groupEntry(row, exact(row.jid)));
        }
      }
    }
    const now = this.c.now();
    this.relate(scored, [], now, idLowerBound(Math.max(1, now - WINDOW_DAYS * DAY_MS)), [], []);
    scored.sort((a, b) => b.candidate.score - a.candidate.score || (b.candidate.lastExchange?.at ?? -1) - (a.candidate.lastExchange?.at ?? -1));
    return {
      verdict: scored.length === 0 ? "not_found" : scored.length === 1 ? "resolved" : "ambiguous",
      candidates: scored.slice(0, Math.min(limit, FIND_SCORES.ambiguousMax)).map((entry) => this.withGroups(entry, groupRows)),
      closest: [],
      query: { words: [], relationship: null, qualifier: [] },
    };
  }

  /**
   * One page of the address book (ADDRESS_BOOK_SQL), in the order asked, with
   * each person's last direct message as of `asOfSeq`. Bounded by the address
   * book and the direct chats, not by messages: two reads off contacts_listed
   * and the chats, and an index walk back (messages_chat) only for a chat whose
   * newest message was stored after the listing began.
   */
  addressBook(input: AddressBookInput): AddressBookPage {
    const order = input.order;
    if (order !== "recent" && order !== "address_book") throw new StorageError("INVALID_INPUT", `order is recent or address_book, not ${String(order)}.`);
    const limit = Math.floor(input.limit);
    if (!(limit >= 1 && limit <= ADDRESS_BOOK_MAX_PAGE)) throw new StorageError("INVALID_INPUT", `limit is 1 to ${ADDRESS_BOOK_MAX_PAGE}.`);
    const owner = this.c.get<{ value: string }>("SELECT value FROM meta WHERE key = 'owner'")?.value ?? null;
    const exclude = input.exclude ?? null;

    const withChat = new Set<number>();
    const lastOf = new Map<number, { at: number; fromMe: boolean }>();
    for (const chat of this.c.all<{
      id: number;
      owner: number;
      last_message_id: number | null;
      last_ts: number | null;
      last_from_me: number | null;
      cleared_through_ts: number | null;
      stored_seq: number | null;
      type: string | null;
    }>(DIRECT_CHATS_SQL)) {
      withChat.add(chat.owner);
      if (chat.last_message_id === null || chat.last_ts === null) continue;
      // A notice (a security code that changed, the encryption banner) is not talking; nor is what came after the listing began.
      const last =
        (chat.stored_seq === null || chat.stored_seq <= input.asOfSeq) && chat.type !== "system"
          ? { at: chat.last_ts, fromMe: chat.last_from_me === 1 }
          : this.lastAsOf(chat.id, chat.cleared_through_ts, input.asOfSeq);
      const known = lastOf.get(chat.owner);
      if (last !== null && (known === undefined || last.at > known.at)) lastOf.set(chat.owner, last);
    }

    const all: AddressBookEntry[] = [];
    let arrived = false;
    for (const row of this.c.all<{ id: number; phone_jid: string; name: string; listed: number }>(ADDRESS_BOOK_SQL)) {
      if (!isRealName(row.name) || row.phone_jid === owner || !/^\d+@s\.whatsapp\.net$/.test(row.phone_jid) || /^0+@/.test(row.phone_jid)) continue;
      // The history names only people the account has a chat with; a saved name without one came from the address book.
      if (!withChat.has(row.id)) arrived = true;
      if (exclude !== null && (exclude.contactIds.has(row.id) || exclude.jids.has(row.phone_jid))) continue;
      all.push({ contactId: row.id, jid: row.phone_jid, name: row.name.trim(), listed: row.listed, last: lastOf.get(row.id) ?? null });
    }
    const keyOf = (entry: AddressBookEntry): AddressBookKey => ({ listed: entry.listed, id: entry.contactId, at: entry.last?.at ?? null });
    all.sort((a, b) => compareAddressBook(order, keyOf(a), keyOf(b)));
    const after = input.after ?? null;
    const start = after === null ? 0 : all.findIndex((entry) => compareAddressBook(order, keyOf(entry), after) > 0);
    const entries = start === -1 ? [] : all.slice(start, start + limit);
    const more = start !== -1 && start + limit < all.length;
    return { entries, total: all.length, next: more ? keyOf(entries[entries.length - 1]!) : null, arrived };
  }

  /**
   * A chat's newest visible message that is not a notice and was stored at or
   * before `asOfSeq`, its folding chats included: what its last was when a
   * listing began. A folding chat shares the barrier of the chat it folds into
   * (merge.ts shareBarrier), so the one barrier holds for the whole family.
   */
  private lastAsOf(chatId: number, clearedThrough: number | null, asOfSeq: number): { at: number; fromMe: boolean } | null {
    let best: { id: number; ts: number; from_me: number } | undefined;
    const family = [chatId, ...this.c.all<{ id: number }>("SELECT id FROM chats WHERE merged_into = ?", chatId).map((row) => row.id)];
    for (const id of family) {
      const row = this.c.get<{ id: number; ts: number; from_me: number }>(
        `SELECT id, ts, from_me FROM messages INDEXED BY messages_chat
         WHERE chat_id = ? AND id >= ? AND deleted_at IS NULL AND ts > ? AND type <> 'system' AND coalesce(stored_seq, 0) <= ?
         ORDER BY id DESC LIMIT 1`,
        id,
        clearedThrough === null ? 0 : idLowerBound(clearedThrough),
        clearedThrough ?? 0,
        asOfSeq
      );
      if (row !== undefined && (best === undefined || row.id > best.id)) best = row;
    }
    return best === undefined ? null : { at: best.ts, fromMe: best.from_me === 1 };
  }

  /** Everyone matching may read, the account itself left out, folded names reused while nothing about them changed. */
  private people(): Person[] {
    const owner = this.c.get<{ value: string }>("SELECT value FROM meta WHERE key = 'owner'")?.value ?? null;
    const ownLids = new Set(owner === null ? [] : this.c.all<{ lid: string }>("SELECT lid FROM lid_phones WHERE phone_jid = ?", owner).map((row) => row.lid));
    const next = new Map<number, Person>();
    const out: Person[] = [];
    // Rows as arrays: ten thousand people read without building an object each.
    for (const values of this.c.arrayStmt(PEOPLE_SQL).all() as unknown as PersonValues[]) {
      const cached = this.folded.get(values[0] as number);
      const person = cached !== undefined && samePerson(cached.row, values) ? cached : personOf(personRow(values));
      const row = person.row;
      next.set(row.id, person);
      if (owner !== null && (row.phone_jid === owner || (row.lid !== null && ownLids.has(row.lid)))) continue;
      out.push(person);
    }
    this.folded = next;
    return out;
  }

  /** People whose names (or, for a relationship, whose filed names, tags and details) meet the words asked. */
  private matchPeople(people: readonly Person[], query: readonly QueryWord[], relation: string | null, near: boolean): Scored[] {
    const out: Scored[] = [];
    const inflected = relation !== null && !RELATIONSHIPS[relation]!.includes(query[0]!.word);
    const roleQuery: QueryWord[] = query.map((q) => ({ word: roleBase(q.word), forms: [], related: NO_WORDS }));
    const roleInflected = roleQuery.some((q, index) => q.word !== query[index]!.word);
    for (const person of people) {
      let best: ContactCandidate["match"] | null = null;
      const consider = (match: Match | null, source: MatchSource, value: string): void => {
        if (match === null) return;
        const score = matchScore(match, source);
        const current = best as ContactCandidate["match"] | null;
        if (current === null || score > current.score || (score === current.score && match.resolvable && !current.resolvable)) {
          best = { class: match.class, source, value, score, inflected: match.inflected, relationship: relation, resolvable: match.resolvable };
        }
      };
      if (relation !== null) {
        // Only a name that is the relationship alone resolves; one after a first name ("Maria mama", or a surname) is a guess.
        const asRelation = (cls: "exact" | "word" | null): Match | null => (cls === null ? null : { class: cls, inflected, resolvable: cls === "exact" });
        for (const field of person.fields) {
          if (RELATIONSHIP_FIELDS.has(field.folded)) consider(asRelation(relationDetailMatch(relation, field.words)), "relatie", `${field.key}: ${field.value}`);
          else if (NICKNAME_FIELDS.has(field.folded)) consider(asRelation(relationWordsMatch(relation, field.words)), "nickname", `${field.key}: ${field.value}`);
        }
        for (const tag of person.tags) consider(asRelation(relationWordsMatch(relation, tag.words) === "exact" ? "exact" : null), "tag", tag.tag);
        // Free text: only a note that says nothing else ("mama", "Mama mea"), how a note was filed before details existed; "prietena mamei" is someone else.
        if (relationWordsMatch(relation, person.noteWords) === "exact") consider(asRelation("exact"), "note", person.row.note!);
        if (person.saved) consider(asRelation(relationWordsMatch(relation, person.savedWords)), "name", person.row.name!);
      } else {
        for (const name of person.names) {
          consider(near ? (nearWords(query, name.words) ? { class: "fuzzy", inflected: false, resolvable: false } : null) : matchWords(query, name.words), name.source, name.value);
        }
        // A role or relationship the user filed ("relatie: dentist") names the person too, whole words only, as a role is said.
        if (!near && person.roles.length > 0) {
          for (const role of person.roles) {
            const match = matchWords(roleQuery, role.words);
            if (match === null || (match.class !== "exact" && match.class !== "word")) continue;
            consider({ ...match, inflected: roleInflected }, role.source, role.value);
          }
        }
      }
      const match = best as ContactCandidate["match"] | null;
      if (match === null) continue;
      out.push({ person, group: null, familyChats: [], familyContacts: [], candidate: this.personCandidate(person, match) });
    }
    return out;
  }

  private personCandidate(person: Person, match: ContactCandidate["match"]): ContactCandidate {
    const row = person.row;
    const jid = (row.phone_jid ?? row.lid)!;
    const phone = row.phone_jid?.split("@")[0] ?? "";
    return {
      kind: "person",
      contactId: row.id,
      chatId: null,
      jid,
      displayName: [row.name, person.nickname, row.verified_name, row.notify, row.push_name].find((name) => isRealName(name)) ?? jid.split("@")[0]!,
      names: { saved: person.saved ? row.name : null, notify: row.notify, pushName: row.push_name, business: row.verified_name, nickname: person.nickname, group: null },
      score: match.score,
      match,
      qualifier: null,
      relationship: { recency: 0, frequency: 0, saved: 0 },
      lastExchange: null,
      ownMessages90d: 0,
      groupsInCommon: null,
      saved: person.saved,
      business: row.is_business === 1 || isRealName(row.verified_name),
      tags: person.tags.map((tag) => tag.tag),
      phoneLast4: /^\d{4,}$/.test(phone) ? phone.slice(-4) : null,
    };
  }

  /** Every group chat with a name that is not folding into another; stillIn tells the ones the account left. */
  private groupRows(): GroupRow[] {
    return this.c.all<GroupRow>(
      `SELECT id, jid, name, proto, last_ts, last_from_me FROM chats
       WHERE kind = 'group' AND merged_into IS NULL AND name IS NOT NULL`
    );
  }

  /** Whether the account is still in a group: its protobuf is read only for a group a match needs. */
  private stillIn(group: GroupRow): boolean {
    if (group.left === undefined) {
      let left = false;
      if (group.proto !== null && this.leftGroup !== null) {
        try {
          left = this.leftGroup(group.proto);
        } catch {
          left = false;
        }
      }
      group.left = left;
    }
    return !group.left;
  }

  private matchGroups(groups: readonly GroupRow[], query: readonly QueryWord[], near: boolean): Scored[] {
    const out: Scored[] = [];
    for (const row of groups) {
      const words = nameWords(row.name);
      const match: Match | null = near ? (nearWords(query, words) ? { class: "fuzzy", inflected: false, resolvable: false } : null) : matchWords(query, words);
      if (match === null || !this.stillIn(row)) continue;
      const score = matchScore(match, "group_name");
      out.push(this.groupEntry(row, { class: match.class, source: "group_name", value: row.name, score, inflected: match.inflected, relationship: null, resolvable: match.resolvable }));
    }
    return out;
  }

  private groupEntry(row: GroupRow, match: ContactCandidate["match"]): Scored {
    return {
      person: null,
      group: row,
      familyChats: [row.id],
      familyContacts: [],
      candidate: {
        kind: "group",
        contactId: null,
        chatId: row.id,
        jid: row.jid,
        displayName: row.name,
        names: { saved: null, notify: null, pushName: null, business: null, nickname: null, group: row.name },
        score: match.score,
        match,
        qualifier: null,
        relationship: { recency: 0, frequency: 0, saved: 0 },
        lastExchange: null,
        ownMessages90d: 0,
        groupsInCommon: null,
        saved: false,
        business: false,
        tags: [],
        phoneLast4: null,
      },
    };
  }

  /**
   * The relationship points and the qualifier's for every candidate at once:
   * a few statements over the chat rows and the own-message index, however
   * many people share a common first name.
   */
  private relate(
    entries: Scored[],
    query: readonly QueryWord[],
    now: number,
    since90: number,
    qualifier: readonly string[][],
    qualifierGroups: readonly GroupRow[]
  ): void {
    if (entries.length === 0) return;
    const people = entries.filter((entry) => entry.person !== null);
    if (people.length > 0) {
      const merging = new Map<number, number[]>();
      for (const row of this.c.all<{ id: number; merged_into: number }>(
        "SELECT id, merged_into FROM contacts WHERE merged_into IN (SELECT value FROM json_each(?))",
        JSON.stringify(people.map((entry) => entry.person!.row.id))
      )) {
        merging.set(row.merged_into, [...(merging.get(row.merged_into) ?? []), row.id]);
      }
      const owners = new Map<number, Scored>();
      for (const entry of people) {
        entry.familyContacts = [entry.person!.row.id, ...(merging.get(entry.person!.row.id) ?? [])];
        for (const id of entry.familyContacts) owners.set(id, entry);
      }
      const chats = this.c.all<{ id: number; contact_id: number; merged_into: number | null; last_ts: number | null; last_from_me: number | null }>(
        `SELECT id, contact_id, merged_into, last_ts, last_from_me FROM chats
         WHERE kind = 'direct' AND contact_id IN (SELECT value FROM json_each(?))`,
        JSON.stringify([...owners.keys()])
      );
      for (const chat of chats) {
        const entry = owners.get(chat.contact_id)!;
        entry.familyChats.push(chat.id);
        if (chat.merged_into === null || entry.candidate.chatId === null) entry.candidate.chatId = chat.merged_into ?? chat.id;
        const last = entry.candidate.lastExchange;
        if (chat.last_ts !== null && (last === null || chat.last_ts > last.at)) entry.candidate.lastExchange = { at: chat.last_ts, fromMe: chat.last_from_me === 1 };
      }
    }
    for (const entry of entries) {
      if (entry.group !== null && entry.group.last_ts !== null) entry.candidate.lastExchange = { at: entry.group.last_ts, fromMe: entry.group.last_from_me === 1 };
    }

    const byChat = new Map<number, Scored>();
    for (const entry of entries) for (const chatId of entry.familyChats) byChat.set(chatId, entry);
    if (byChat.size > 0) {
      for (const row of this.c.all<{ chat_id: number; n: number }>(
        `SELECT chat_id, count(*) AS n FROM messages INDEXED BY messages_own
         WHERE chat_id IN (SELECT value FROM json_each(?)) AND from_me = 1 AND deleted_at IS NULL AND id >= ?
         GROUP BY chat_id`,
        JSON.stringify([...byChat.keys()]),
        since90
      )) {
        byChat.get(row.chat_id)!.candidate.ownMessages90d += row.n;
      }
    }

    const wroteIn = new Map<number, Set<number>>();
    if (qualifierGroups.length > 0 && people.length > 0) {
      for (const row of this.c.all<{ sender_id: number; chat_id: number }>(
        `SELECT DISTINCT m.sender_id, c.id AS chat_id FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
         WHERE m.chat_id IN (SELECT value FROM json_each(?)) AND m.id >= ? AND m.sender_id IN (SELECT value FROM json_each(?))
           AND ${VISIBLE}`,
        JSON.stringify(qualifierGroups.map((group) => group.id)),
        since90,
        JSON.stringify(people.flatMap((entry) => entry.familyContacts)),
        now
      )) {
        const set = wroteIn.get(row.sender_id) ?? new Set<number>();
        set.add(row.chat_id);
        wroteIn.set(row.sender_id, set);
      }
    }
    const asked = new Set(query.flatMap((q) => [q.word, ...q.forms]));

    for (const entry of entries) {
      const candidate = entry.candidate;
      const ageDays = candidate.lastExchange === null ? Infinity : (now - candidate.lastExchange.at) / DAY_MS;
      candidate.relationship = {
        recency: pointsFor(FIND_SCORES.recency, (days) => ageDays <= days),
        frequency: pointsFor(FIND_SCORES.frequency, (count) => candidate.ownMessages90d >= count),
        saved: candidate.saved ? FIND_SCORES.saved : 0,
      };
      if (qualifier.length > 0) {
        const hits: QualifierHit[] = [];
        const person = entry.person;
        if (person !== null) {
          if (qualifierIn(qualifier, person.noteWords)) hits.push({ source: "note", value: person.row.note! });
          for (const tag of person.tags) if (qualifierIn(qualifier, tag.words)) hits.push({ source: "tag", value: tag.tag });
          for (const field of person.fields) {
            if (qualifierIn(qualifier, [...nameWords(field.key), ...field.words])) hits.push({ source: "field", value: `${field.key}: ${field.value}` });
          }
          if (isRealName(person.row.verified_name) && qualifierIn(qualifier, nameWords(person.row.verified_name))) {
            hits.push({ source: "business_name", value: person.row.verified_name! });
          }
          for (const group of qualifierGroups) {
            if (entry.familyContacts.some((id) => wroteIn.get(id)?.has(group.id))) hits.push({ source: "group_name", value: group.name });
          }
        } else if (entry.group !== null) {
          // A group's own name meets the qualifier past the words the name asked for already matched.
          const rest = nameWords(entry.group.name).filter((word) => !asked.has(word));
          if (qualifierIn(qualifier, rest)) hits.push({ source: "group_name", value: entry.group.name });
        }
        const filed = hits.some((hit) => hit.source === "note" || hit.source === "tag" || hit.source === "field");
        const score = filed ? FIND_SCORES.qualifier.filed : hits.length > 0 ? FIND_SCORES.qualifier.businessOrGroup : FIND_SCORES.qualifier.miss;
        candidate.qualifier = { hits, score };
      }
      const total =
        candidate.match.score + (candidate.qualifier?.score ?? 0) + candidate.relationship.recency + candidate.relationship.frequency + candidate.relationship.saved;
      candidate.score = candidate.match.resolvable ? total : Math.min(total, FIND_SCORES.unresolvableCap);
    }
  }

  /** The groups a person shares with the user, for a candidate that is returned: off their newest messages a reader may see. */
  private withGroups(entry: Scored, groupRows: readonly GroupRow[]): ContactCandidate {
    const candidate = entry.candidate;
    if (entry.person === null || entry.familyContacts.length === 0) return candidate;
    const rows = this.c.all<{ chat_id: number; merged_into: number | null; last_id: number }>(
      `SELECT m.chat_id, c.merged_into, max(m.id) AS last_id FROM (
         SELECT chat_id, id, ts FROM messages INDEXED BY messages_sender
         WHERE sender_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY id DESC LIMIT ?) m
       JOIN chats c ON c.id = m.chat_id
       WHERE m.ts > coalesce(c.cleared_through_ts, 0)
       GROUP BY m.chat_id ORDER BY last_id DESC`,
      JSON.stringify(entry.familyContacts),
      this.c.now(),
      GROUP_SCAN_MESSAGES
    );
    const groups = new Map(groupRows.map((group) => [group.id, group]));
    const names: string[] = [];
    const seen = new Set<number>();
    for (const row of rows) {
      const id = row.merged_into ?? row.chat_id;
      const group = groups.get(id);
      if (group === undefined || seen.has(id) || !this.stillIn(group)) continue;
      seen.add(id);
      names.push(group.name);
    }
    candidate.groupsInCommon = { count: names.length, names: names.slice(0, GROUP_NAMES_MAX) };
    return candidate;
  }
}
