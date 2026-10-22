/**
 * Substring search, newest first. A query of three or more characters goes
 * through the trigram index (case- and diacritic-insensitive, so "SEDINT"
 * finds "ședință"); a shorter one cannot, and walks recent messages instead.
 * Both stop after a bounded number of candidates and say so, because "no
 * hit within the cap" is not "no such message".
 */
import type { Connection } from "./connection.js";
import { idLowerBound, idUpperBound } from "./ids.js";
import type { Identity } from "./identity.js";
import { foldedMatcher, foldText } from "./fold.js";
import { chatCondition, type Messages } from "./messages.js";
import type { SQLInputValue } from "./sqlite.js";
import type { ChatKind, MessageFilter, SearchCoverage, TextSearchInput, TextSearchResult } from "./types.js";

/**
 * Messages the short-query scan matches in JavaScript before it stops and
 * reports scanCapped: about 40 ms at 100k messages, where 50k took 93 ms.
 */
export const DEFAULT_SCAN_CAP = 20_000;
/** FTS candidates the trigram path examines before it stops; each costs a fraction of a scanned row. */
export const DEFAULT_TRIGRAM_CAP = 50_000;
const FTS_BATCH = 256;
const MIN_TRIGRAM_CHARS = 3;
const NO_UPPER_BOUND = Number.MAX_SAFE_INTEGER;

export { foldText } from "./fold.js";

/** A filter turned into ids and one SQL condition over `m` and its chat `c`; null when it can match nothing. */
export interface ResolvedFilter {
  lower: number;
  upper: number;
  where: string;
  params: SQLInputValue[];
  /** Whether the filter needs more than an id range; a pure range lets the vector scan skip the join. */
  narrowsRows: boolean;
  since?: number;
  until?: number;
}

export function ftsPhrase(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

export class Search {
  constructor(
    private readonly c: Connection,
    private readonly identity: Identity,
    private readonly messages: Messages
  ) {}

  resolveFilter(filter: MessageFilter): ResolvedFilter | null {
    const conditions = ["m.deleted_at IS NULL", "(m.expires_at IS NULL OR m.expires_at > ?)", "m.ts > coalesce(c.cleared_through_ts, 0)"];
    const params: SQLInputValue[] = [this.c.now()];
    let narrowsRows = false;
    if (filter.chat !== undefined) {
      const chat = this.identity.chat(filter.chat);
      if (chat === null) return null;
      const inChat = chatCondition(this.identity.chatIdsOf(chat));
      conditions.push(inChat.sql);
      params.push(...inChat.params);
      narrowsRows = true;
    }
    if (filter.from !== undefined) {
      if (filter.from === "me") {
        conditions.push("m.from_me = 1");
      } else {
        const contactIds = this.identity.contactIdsOf(filter.from);
        if (contactIds.length === 0) return null;
        if (contactIds.length === 1) {
          conditions.push("m.sender_id = ?");
          params.push(contactIds[0]!);
        } else {
          conditions.push("m.sender_id IN (SELECT value FROM json_each(?))");
          params.push(JSON.stringify(contactIds));
        }
      }
      narrowsRows = true;
    }
    if (filter.tag !== undefined) {
      const ids = this.identity.chatIdsTagged(filter.tag);
      if (ids.length === 0) return null;
      const tagged = chatCondition(ids);
      conditions.push(tagged.sql);
      params.push(...tagged.params);
      narrowsRows = true;
    }
    if (filter.since !== undefined) {
      conditions.push("m.ts >= ?");
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      conditions.push("m.ts <= ?");
      params.push(filter.until);
    }
    const lower = filter.since === undefined ? 0 : idLowerBound(filter.since);
    const upper = filter.until === undefined ? NO_UPPER_BOUND : idUpperBound(filter.until);
    if (upper <= lower) return null;
    return {
      lower,
      upper,
      where: conditions.join(" AND "),
      params,
      narrowsRows,
      ...(filter.since === undefined ? {} : { since: filter.since }),
      ...(filter.until === undefined ? {} : { until: filter.until }),
    };
  }

  /**
   * What a search over `filter` runs across: how many visible messages, in how
   * many chats, from when to when, leaving out the kinds of chat named. Without
   * a time, sender or tag filter the counts are the ones the triggers keep on each
   * chat (less the few expired messages the sweep has not reached), and the
   * bounds are read off the primary key: no pass over the rows. With one, it
   * is one pass over the filtered rows. `exact` forces that pass, for checks.
   */
  coverage(filter: MessageFilter & { excludeKinds?: readonly ChatKind[]; exact?: boolean }): SearchCoverage {
    if (filter.exact !== true && filter.since === undefined && filter.until === undefined && filter.from === undefined && filter.tag === undefined) {
      return this.keptCoverage(filter.chat, filter.excludeKinds ?? []);
    }
    const resolved = this.resolveFilter(filter);
    const empty = { messages: 0, chats: 0, oldestTs: null, newestTs: null };
    if (resolved === null) return empty;
    const excluded = filter.excludeKinds ?? [];
    const kinds = excluded.length === 0 ? "" : "AND c.kind NOT IN (SELECT value FROM json_each(?))";
    const row = this.c.get<{ n: number; chats: number; oldest: number | null; newest: number | null }>(
      `SELECT count(*) AS n, count(DISTINCT coalesce(c.merged_into, c.id)) AS chats, min(m.ts) AS oldest, max(m.ts) AS newest
       FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
       WHERE m.id >= ? AND m.id < ? AND ${resolved.where} ${kinds}`,
      resolved.lower,
      resolved.upper,
      ...resolved.params,
      ...(excluded.length === 0 ? [] : [JSON.stringify(excluded)])
    );
    if (row === undefined || row.n === 0) return empty;
    return { messages: row.n, chats: row.chats, oldestTs: row.oldest, newestTs: row.newest };
  }

  private keptCoverage(chatJid: string | undefined, excluded: readonly ChatKind[]): SearchCoverage {
    const empty = { messages: 0, chats: 0, oldestTs: null, newestTs: null };
    let ids: number[] | null = null;
    if (chatJid !== undefined) {
      const chat = this.identity.chat(chatJid);
      if (chat === null || excluded.includes(chat.kind)) return empty;
      ids = this.identity.chatIdsOf(chat);
    }
    const scope =
      ids === null
        ? { sql: excluded.length === 0 ? "1" : "c.kind NOT IN (SELECT value FROM json_each(?))", params: excluded.length === 0 ? [] : [JSON.stringify(excluded)] }
        : { sql: "c.id IN (SELECT value FROM json_each(?))", params: [JSON.stringify(ids)] };
    const now = this.c.now();
    // Expired messages the sweep has not tombstoned yet still count on their chat; reads already hide them.
    const expired = new Map(
      this.c
        .all<{ chat: number; n: number }>(
          `SELECT m.chat_id AS chat, count(*) AS n FROM messages m INDEXED BY messages_expiry CROSS JOIN chats c ON c.id = m.chat_id
           WHERE m.expires_at IS NOT NULL AND m.deleted_at IS NULL AND m.expires_at <= ? AND m.ts > coalesce(c.cleared_through_ts, 0)
           GROUP BY m.chat_id`,
          now
        )
        .map((row) => [row.chat, row.n])
    );
    let messages = 0;
    const canonical = new Set<number>();
    for (const row of this.c.all<{ id: number; family: number; visible: number }>(
      `SELECT c.id, coalesce(c.merged_into, c.id) AS family, c.visible FROM chats c WHERE c.visible > 0 AND ${scope.sql}`,
      ...scope.params
    )) {
      const visible = row.visible - (expired.get(row.id) ?? 0);
      if (visible <= 0) continue;
      messages += visible;
      canonical.add(row.family);
    }
    if (messages === 0) return empty;
    // One chat walks its own index from either end; the account walks the primary key.
    const edgeOf = (where: string, params: SQLInputValue[], order: "ASC" | "DESC"): number | null =>
      this.c.get<{ ts: number }>(
        `SELECT m.ts FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
         WHERE ${where} AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?) AND m.ts > coalesce(c.cleared_through_ts, 0)
         ORDER BY m.id ${order} LIMIT 1`,
        ...params,
        now
      )?.ts ?? null;
    const edge = (order: "ASC" | "DESC"): number | null => {
      if (ids === null) return edgeOf(scope.sql, scope.params, order);
      const found = ids.map((id) => edgeOf("m.chat_id = ?", [id], order)).filter((ts): ts is number => ts !== null);
      if (found.length === 0) return null;
      return order === "ASC" ? Math.min(...found) : Math.max(...found);
    };
    return { messages, chats: canonical.size, oldestTs: edge("ASC"), newestTs: edge("DESC") };
  }

  text(input: TextSearchInput): TextSearchResult {
    const limit = Math.min(1_000, Math.max(1, Math.floor(input.limit)));
    const query = input.query.trim();
    const mode = [...query].length >= MIN_TRIGRAM_CHARS ? "trigram" : "scan";
    // A query of nothing but whitespace names nothing: it must not list every message.
    if (query === "") return { items: [], hasMore: false, nextBefore: null, mode, scanCapped: false };
    const cap = Math.max(1, Math.floor(input.scanCap ?? (mode === "trigram" ? DEFAULT_TRIGRAM_CAP : DEFAULT_SCAN_CAP)));
    const filter = this.resolveFilter(input);
    if (filter === null) return { items: [], hasMore: false, nextBefore: null, mode, scanCapped: false };
    const upper = Math.min(input.before ?? NO_UPPER_BOUND, filter.upper);
    const found = mode === "trigram" ? this.trigramIds(query, filter, upper, limit + 1, cap) : this.scanIds(query, filter, upper, limit + 1, cap);
    const hasMore = found.ids.length > limit;
    const ids = hasMore ? found.ids.slice(0, limit) : found.ids;
    const items = this.messages.byIds(ids);
    if (hasMore) return { items, hasMore, nextBefore: ids[ids.length - 1]!, mode, scanCapped: false };
    if (found.cappedAt !== null) return { items, hasMore: true, nextBefore: found.cappedAt, mode, scanCapped: true };
    return { items, hasMore: false, nextBefore: null, mode, scanCapped: false };
  }

  /**
   * Newest FTS matches in batches, each batch filtered against `messages`,
   * until `want` ids pass or `cap` candidates were examined. `cappedAt` is the
   * cursor to resume from when the cap stopped it.
   */
  trigramIds(
    match: string,
    filter: ResolvedFilter,
    upper: number,
    want: number,
    cap: number,
    matchExpression = ftsPhrase(match)
  ): { ids: number[]; cappedAt: number | null } {
    const ids: number[] = [];
    let cursor = upper;
    let examined = 0;
    for (;;) {
      const batch = this.c
        .all<{ id: number }>(
          `SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ? AND rowid < ? AND rowid >= ?
           ORDER BY rowid DESC LIMIT ?`,
          matchExpression,
          cursor,
          filter.lower,
          FTS_BATCH
        )
        .map((row) => row.id);
      if (batch.length === 0) return { ids, cappedAt: null };
      examined += batch.length;
      const passing = this.c.all<{ id: number }>(
        `SELECT m.id FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
         WHERE m.id IN (SELECT value FROM json_each(?)) AND ${filter.where}
         ORDER BY m.id DESC LIMIT ?`,
        JSON.stringify(batch),
        ...filter.params,
        want - ids.length
      );
      for (const row of passing) ids.push(row.id);
      if (ids.length >= want) return { ids, cappedAt: null };
      cursor = batch[batch.length - 1]!;
      if (batch.length < FTS_BATCH) return { ids, cappedAt: null };
      if (examined >= cap) return { ids, cappedAt: cursor };
    }
  }

  /** The short-query path: recent messages newest first, matched in JavaScript, at most `cap` of them. */
  scanIds(query: string, filter: ResolvedFilter, upper: number, want: number, cap: number): { ids: number[]; cappedAt: number | null } {
    const matches = foldedMatcher(foldText(query));
    const ids: number[] = [];
    let examined = 0;
    const rows = this.c
      .stmt(
        `SELECT m.id, m.text, m.transcript FROM messages m CROSS JOIN chats c ON c.id = m.chat_id
         WHERE m.id < ? AND m.id >= ? AND ${filter.where} ORDER BY m.id DESC`
      )
      .iterate(upper, filter.lower, ...filter.params) as Iterable<{ id: number; text: string | null; transcript: string | null }>;
    for (const row of rows) {
      examined++;
      if (
        (row.text !== null && matches(row.text)) ||
        (row.transcript !== null && matches(row.transcript))
      ) {
        ids.push(row.id);
        if (ids.length >= want) return { ids, cappedAt: null };
      }
      if (examined >= cap) return { ids, cappedAt: row.id };
    }
    return { ids, cappedAt: null };
  }
}
