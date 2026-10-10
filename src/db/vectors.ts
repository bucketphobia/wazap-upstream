/**
 * Semantic search over stored embeddings, and the hybrid search that fuses
 * it with the trigram index.
 *
 * Vectors keep recall's conventions so an existing index imports without
 * re-embedding: L2-normalized, quantized to int8 as round(x * 127), so the
 * cosine similarity against a unit query is dot(query, vec) / 127. The
 * similarity floor applies to that cosine, weighed by the match's age when a
 * search asks for recency.
 *
 * The scan is exact brute force over the rows the filters leave, on the
 * calling thread. It needs only a read connection, so it can move to a
 * worker with a read-only open of the same file unchanged.
 */
import { createHash } from "node:crypto";
import type { Connection } from "./connection.js";
import { StorageError } from "./errors.js";
import { secondOf, secondOfId } from "./ids.js";
import type { Identity } from "./identity.js";
import type { Messages } from "./messages.js";
import { DEFAULT_SCAN_CAP, DEFAULT_TRIGRAM_CAP, foldText, ftsPhrase, type ResolvedFilter, type Search } from "./search.js";
import type { SQLInputValue } from "./sqlite.js";
import type { MessageFilter, Page, StoredMessage } from "./types.js";

/** Reciprocal Rank Fusion's damping constant, the value from the original paper. */
export const RRF_K = 60;
const DEFAULT_CANDIDATES = 100;
/**
 * The least a match's age leaves of its similarity when recency weighs it: a
 * fresh match counts whole, one a half-life old halfway down to this, and none
 * less. Recency only orders: whether a match counts at all is its own
 * similarity against the floor, so an old message is as findable as a new one.
 */
const RECENCY_MIN_WEIGHT = 0.7;
const DEFAULT_BACKLOG_SCAN = 20_000;
/** A hybrid query word shorter than this names too much to be worth an index lookup. */
const MIN_TOKEN_CHARS = 4;
const MAX_TOKENS = 8;
/**
 * From this many content words of a query up, a hit the words alone vouch for
 * must carry LEXICAL_MIN_MATCHES of them: one shared word of a longer question
 * is the noise a long message picks up, not an answer.
 */
const LEXICAL_PAIR_FROM = 3;
const LEXICAL_MIN_MATCHES = 2;
/**
 * A hit carrying one content word of a two-word query still answers it ("când
 * ne vedem mâine" → "ne vedem la șapte"), but only with some of its meaning: at
 * least this share of the floor. Measured with EmbeddingGemma, such answers sit
 * at 0.42-0.50 and long messages that merely contain the word at 0.11-0.21.
 */
const LOOSE_FLOOR_SHARE = 0.7;
/**
 * Function words of English and Romanian — articles, pronouns, auxiliaries,
 * prepositions, conjunctions, question words — folded the way the trigram
 * index folds. A query word in this list is still looked up and still ranks
 * its matches, but it is not what the query asks about: the rule above counts
 * a query's words, and a hit's matches, without these, and a query made only
 * of them needs its hits' meaning. A function word that folds to a word with
 * meaning of its own stays out: „cât” is "cat", „mai” is also May, and "era"
 * and "ale" are English words.
 */
export const QUERY_STOPWORDS: ReadonlySet<string> = new Set(
  [
    // English
    "a", "an", "the", "this", "that", "these", "those", "some", "any",
    "i", "me", "my", "we", "us", "our", "you", "your", "he", "him", "his", "she", "her", "it", "its", "they", "them", "their",
    "am", "is", "are", "was", "were", "be", "been", "do", "does", "did", "have", "has", "had",
    "will", "would", "can", "could", "should",
    "what", "when", "where", "which", "who", "whom", "whose", "why", "how",
    "to", "of", "in", "on", "at", "for", "with", "from", "by", "about", "as",
    "and", "or", "but", "if", "so", "than", "then", "there", "not",
    // Romanian
    "o", "un", "unui", "unei", "cel", "cea", "cei", "cele", "al", "lui", "lor",
    "eu", "tu", "el", "ea", "noi", "voi", "ei", "ele", "mă", "mi", "te", "ți", "îl", "îi", "ne", "vă", "le", "se", "își",
    "meu", "mea", "tău", "ta", "său", "asta", "ăsta", "acest", "această", "acesta", "aceasta",
    "e", "este", "ești", "sunt", "fost", "fi", "ai", "au", "ați", "aș", "ar", "va", "vor", "să",
    "la", "de", "pe", "în", "cu", "din", "pentru", "despre", "după", "prin", "spre", "către", "fără", "până",
    "și", "sau", "dar", "că", "ca", "dacă", "nu",
    "ce", "când", "unde", "cine", "cum", "care",
  ].map(foldText)
);
const NO_UPPER_BOUND = Number.MAX_SAFE_INTEGER;
/** The model the embedding queue is kept for; the queue triggers test for this key. */
const FEED_MODEL_META = "embed_model";
/** The refill's descending id cursor, present while a refill is owed. */
const REFILL_META = "embed_refill_before";
const DEFAULT_QUEUE_SCAN = 2_000;

export function unitVector(vector: ArrayLike<number>): Float64Array {
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    const x = vector[i]!;
    if (!Number.isFinite(x)) throw new StorageError("INVALID_INPUT", "An embedding holds a non-finite value.");
    norm += x * x;
  }
  if (norm === 0) throw new StorageError("INVALID_INPUT", "An embedding cannot be the zero vector.");
  const inv = 1 / Math.sqrt(norm);
  const unit = new Float64Array(vector.length);
  for (let i = 0; i < vector.length; i++) unit[i] = vector[i]! * inv;
  return unit;
}

/** The old recall index's quantization, byte for byte, so its vectors import as they are: normalize, clamp, round(x * 127). */
export function quantizeVector(vector: ArrayLike<number>): Int8Array {
  const unit = unitVector(vector);
  const out = new Int8Array(unit.length);
  for (let i = 0; i < unit.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, unit[i]!)) * 127);
  return out;
}

/**
 * The words an embedding is made from, as a short digest: text and transcript,
 * with null kept distinct from empty. The backlog hands it out with each item
 * and put() stores a vector only while the message still says exactly that.
 */
export function contentHash(text: string | null, transcript: string | null): string {
  const part = (value: string | null): string => (value === null ? "\u0000" : `\u0001${value}`);
  return createHash("sha256").update(`${part(text)}\u0002${part(transcript)}`).digest("hex").slice(0, 32);
}

/** What recency leaves of message `id`'s similarity: 1 without a half-life or when fresh, halving the way down to RECENCY_MIN_WEIGHT each half-life. */
function recencyWeight(id: number, now: number, halfLifeMs: number | undefined): number {
  if (halfLifeMs === undefined) return 1;
  return RECENCY_MIN_WEIGHT + (1 - RECENCY_MIN_WEIGHT) * Math.pow(0.5, Math.max(0, now - secondOfId(id) * 1000) / halfLifeMs);
}

/** Cosine similarity of a unit query against a stored int8 vector. */
export function int8Similarity(unit: Float64Array, vec: Int8Array): number {
  let dot = 0;
  const n = unit.length;
  let i = 0;
  for (; i + 3 < n; i += 4) {
    dot += unit[i]! * vec[i]! + unit[i + 1]! * vec[i + 1]! + unit[i + 2]! * vec[i + 2]! + unit[i + 3]! * vec[i + 3]!;
  }
  for (; i < n; i++) dot += unit[i]! * vec[i]!;
  return dot / 127;
}

/**
 * The words of a hybrid query worth looking up, folded and unique. Words of
 * four or more letters go to the trigram index; three-letter words join them
 * when there is nothing longer, or when they carry a digit or are an acronym
 * ("PIN"). Words under three characters cannot use the index: only digits and
 * acronyms ("42", "BT") are kept, and they go through the bounded short-query
 * scan — "e", "la" or "de" would only ever match everything.
 */
export function hybridWords(query: string): { trigram: string[]; short: string[] } {
  const seen = new Set<string>();
  const words: Array<{ folded: string; length: number; significant: boolean }> = [];
  for (const original of query.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const folded = foldText(original);
    if (seen.has(folded)) continue;
    seen.add(folded);
    words.push({ folded, length: [...folded].length, significant: /\p{N}/u.test(original) || /^\p{Lu}{2,}$/u.test(original) });
  }
  const hasLong = words.some((word) => word.length >= MIN_TOKEN_CHARS);
  const trigram = words
    .filter((word) => word.length >= MIN_TOKEN_CHARS || (word.length === 3 && (!hasLong || word.significant)))
    .map((word) => word.folded);
  const short = words.filter((word) => word.length < 3 && word.significant).map((word) => word.folded);
  return { trigram: trigram.slice(0, MAX_TOKENS), short: short.slice(0, Math.max(0, MAX_TOKENS - trigram.length)) };
}

/** Every word a hybrid query looks up, index words first. */
export function hybridTokens(query: string): string[] {
  const { trigram, short } = hybridWords(query);
  return [...trigram, ...short];
}

/** A fixed-size min-heap on score: the K best of a stream without sorting the stream. */
class TopK {
  private readonly scores: number[] = [];
  private readonly ids: number[] = [];
  constructor(private readonly k: number) {}

  get floor(): number {
    return this.scores.length < this.k ? -Infinity : this.scores[0]!;
  }

  push(score: number, id: number): void {
    if (this.scores.length < this.k) {
      this.scores.push(score);
      this.ids.push(id);
      this.up(this.scores.length - 1);
    } else if (score > this.scores[0]!) {
      this.scores[0] = score;
      this.ids[0] = id;
      this.down(0);
    }
  }

  sorted(): Array<{ id: number; score: number }> {
    return this.ids.map((id, i) => ({ id, score: this.scores[i]! })).sort((a, b) => b.score - a.score || b.id - a.id);
  }

  private swap(a: number, b: number): void {
    [this.scores[a], this.scores[b]] = [this.scores[b]!, this.scores[a]!];
    [this.ids[a], this.ids[b]] = [this.ids[b]!, this.ids[a]!];
  }

  private up(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.scores[parent]! <= this.scores[i]!) return;
      this.swap(parent, i);
      i = parent;
    }
  }

  private down(i: number): void {
    const n = this.scores.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let least = i;
      if (left < n && this.scores[left]! < this.scores[least]!) least = left;
      if (right < n && this.scores[right]! < this.scores[least]!) least = right;
      if (least === i) return;
      this.swap(least, i);
      i = least;
    }
  }
}

export interface BacklogItem {
  id: number;
  sid: string;
  type: string;
  ts: number;
  text: string | null;
  transcript: string | null;
  /** Pass to put() with the vector made from this text and transcript. */
  contentHash: string;
}

export interface VectorSearchInput extends MessageFilter {
  model: string;
  vector: ArrayLike<number>;
  limit: number;
  /** Cosine, weighed by age when a half-life is given, a hit must reach; 0 keeps every positive match. */
  minSimilarity?: number;
  /** Weigh similarity by age for the floor and the order: similarity × recencyWeight. The `limit` kept are still the most similar. */
  recencyHalfLifeMs?: number;
}

export interface VectorHit {
  message: StoredMessage;
  similarity: number;
  score: number;
}

export interface HybridSearchInput extends MessageFilter {
  query: string;
  model: string;
  /** The embedded query; without it the search is lexical only and says so. */
  vector?: ArrayLike<number> | null;
  limit: number;
  /** Cosine, weighed by age when a half-life is given, a hit must reach to count by its meaning; lexical hits need none unless they are weak. */
  minSimilarity: number;
  lexicalCandidates?: number;
  /** How many of the most similar messages whose weighed similarity reaches the floor the semantic side ranks. */
  semanticCandidates?: number;
  /** FTS rows examined on the lexical side before it stops. */
  scanCap?: number;
  /** Weigh the semantic side's similarity by age, for the floor and the order: similarity × recencyWeight. Its candidates are still the most similar. */
  recencyHalfLifeMs?: number;
}

export interface HybridHit {
  message: StoredMessage;
  score: number;
  /** 1-based rank among lexical candidates, when it was one. */
  lexicalRank: number | null;
  /** 1-based rank among semantic candidates, when it was one. */
  semanticRank: number | null;
  similarity: number | null;
}

export interface HybridResult {
  hits: HybridHit[];
  semantic: boolean;
  lexicalCapped: boolean;
}

export class Vectors {
  constructor(
    private readonly c: Connection,
    private readonly identity: Identity,
    private readonly messages: Messages,
    private readonly search: Search
  ) {}

  /**
   * Stores a message's embedding. A float vector is normalized and quantized;
   * an Int8Array is taken as already quantized (the recall import path).
   * `hash` is the contentHash of the words the vector was made from — the
   * backlog item's — and the vector is stored only while the message still
   * says exactly those words. Returns false for an unknown, deleted, expired
   * or textless message, and for one edited or transcribed since.
   */
  put(sid: string, model: string, vector: ArrayLike<number> | Int8Array, hash: string): boolean {
    const vec = vector instanceof Int8Array ? vector : quantizeVector(vector);
    if (vec.length === 0) throw new StorageError("INVALID_INPUT", "An embedding cannot be empty.");
    return this.c.write(() => {
      const key = this.messages.visibleKey(sid);
      if (key === null) return false;
      const words = this.c.get<{ text: string | null; transcript: string | null }>(
        "SELECT text, transcript FROM messages WHERE id = ?",
        key.id
      )!;
      if (words.text === null && words.transcript === null) return false;
      if (contentHash(words.text, words.transcript) !== hash) return false;
      this.c.run(
        `INSERT INTO embeddings(message_id, model, content_hash, vec) VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET model = excluded.model, content_hash = excluded.content_hash, vec = excluded.vec`,
        key.id,
        model,
        hash,
        new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
      );
      // Done for the fed model; a vector from another model leaves the message still owed one.
      const fed = this.meta(FEED_MODEL_META);
      if (fed === model) this.c.run("DELETE FROM embed_queue WHERE message_id = ?", key.id);
      else if (fed !== null) this.c.run("INSERT OR IGNORE INTO embed_queue(message_id) VALUES (?)", key.id);
      return true;
    });
  }

  get(sid: string): { model: string; vector: Int8Array } | null {
    const key = this.messages.visibleKey(sid);
    if (key === null) return null;
    const row = this.c.get<{ model: string; vec: Uint8Array }>("SELECT model, vec FROM embeddings WHERE message_id = ?", key.id);
    return row === undefined ? null : { model: row.model, vector: new Int8Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength) };
  }

  count(model?: string): number {
    const row =
      model === undefined
        ? this.c.get<{ n: number }>("SELECT count(*) AS n FROM embeddings")
        : this.c.get<{ n: number }>("SELECT count(*) AS n FROM embeddings WHERE model = ?", model);
    return row?.n ?? 0;
  }

  /**
   * Visible messages with text and no embedding from `model`, newest first.
   * At most `scanCap` messages are examined per call; `nextBefore` resumes.
   */
  backlog(options: { model: string; limit: number; before?: number; scanCap?: number }): Page<BacklogItem> {
    const limit = Math.max(1, Math.floor(options.limit));
    const cap = Math.max(1, Math.floor(options.scanCap ?? DEFAULT_BACKLOG_SCAN));
    const rows = this.c
      .stmt(
        `SELECT m.id, (CASE WHEN m.from_me = 1 THEN 'true' ELSE 'false' END) || '_' || coalesce(ck.jid, c.jid) || '_' || m.key_id AS sid,
           m.type, m.ts, m.text, m.transcript,
           EXISTS (SELECT 1 FROM embeddings e WHERE e.message_id = m.id AND e.model = ?) AS embedded
         FROM messages m CROSS JOIN chats c ON c.id = m.chat_id LEFT JOIN chats ck ON ck.id = c.merged_into
         WHERE m.id < ? AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?)
           AND m.ts > coalesce(c.cleared_through_ts, 0) AND (m.text IS NOT NULL OR m.transcript IS NOT NULL)
         ORDER BY m.id DESC`
      )
      .iterate(options.model, options.before ?? NO_UPPER_BOUND, this.c.now()) as Iterable<Omit<BacklogItem, "contentHash"> & { embedded: number }>;
    const items: BacklogItem[] = [];
    let examined = 0;
    for (const row of rows) {
      examined++;
      if (row.embedded === 0) {
        if (items.length === limit) return { items, hasMore: true, nextBefore: items[items.length - 1]!.id };
        const { embedded: _embedded, ...item } = row;
        items.push({ ...item, contentHash: contentHash(item.text, item.transcript) });
      }
      if (examined >= cap) return { items, hasMore: true, nextBefore: row.id };
    }
    return { items, hasMore: false, nextBefore: null };
  }

  /**
   * Starts, or keeps, feeding `model`: from here on a message stored with
   * words, or whose words change, is queued for it. A model fed for the first
   * time — or instead of another — owes a refill of the messages already
   * stored; `refilling` says one is still owed, and refill() pays it in steps.
   */
  feed(model: string): { refilling: boolean } {
    return this.c.write(() => {
      const current = this.meta(FEED_MODEL_META);
      if (current !== model) {
        this.setMeta(FEED_MODEL_META, model);
        this.setMeta(REFILL_META, String(NO_UPPER_BOUND));
      }
      return { refilling: this.meta(REFILL_META) !== null };
    });
  }

  /** Stops keeping the queue: no model is fed, and nothing stays queued. */
  unfeed(): void {
    this.c.write(() => {
      if (this.meta(FEED_MODEL_META) === null && this.meta(REFILL_META) === null) return;
      this.setMeta(FEED_MODEL_META, null);
      this.setMeta(REFILL_META, null);
      this.c.run("DELETE FROM embed_queue");
    });
  }

  /**
   * One step of the refill: the next `scan` stored messages down from the
   * cursor, of which those with words and no vector from the fed model are
   * queued. The cursor is stored with the step, so a restart resumes below
   * it. True while more is owed.
   */
  refill(scan = DEFAULT_QUEUE_SCAN): boolean {
    const span = Math.max(1, Math.floor(scan));
    return this.c.write(() => {
      const cursor = this.meta(REFILL_META);
      const model = this.meta(FEED_MODEL_META);
      if (cursor === null) return false;
      if (model === null) {
        this.setMeta(REFILL_META, null);
        return false;
      }
      const before = Number(cursor);
      const boundary = this.c.get<{ id: number }>("SELECT id FROM messages WHERE id < ? ORDER BY id DESC LIMIT 1 OFFSET ?", before, span - 1);
      const lower = boundary?.id ?? 0;
      this.c.run(
        `INSERT OR IGNORE INTO embed_queue(message_id)
           SELECT m.id FROM messages m
           WHERE m.id < ? AND m.id >= ? AND m.deleted_at IS NULL AND (m.text IS NOT NULL OR m.transcript IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.message_id = m.id AND e.model = ?)`,
        before,
        lower,
        model
      );
      if (boundary === undefined) {
        this.setMeta(REFILL_META, null);
        return false;
      }
      this.setMeta(REFILL_META, String(boundary.id));
      return true;
    });
  }

  /**
   * Queued messages to embed for `model`, newest first, each with the hash of
   * the words to embed. A queued row that needs nothing — its message gone,
   * hidden, expired, without words, or already holding a vector of these
   * words — leaves the queue on the way. At most `scanCap` rows are looked at
   * per call; `nextBefore` resumes below them.
   */
  queued(options: { model: string; limit: number; before?: number; scanCap?: number }): Page<BacklogItem> {
    const limit = Math.max(1, Math.floor(options.limit));
    const cap = Math.max(limit, Math.floor(options.scanCap ?? DEFAULT_QUEUE_SCAN));
    return this.c.write(() => {
      const rows = this.c.all<
        Omit<BacklogItem, "contentHash" | "sid"> & { sid: string | null; live: number | null; embeddedHash: string | null }
      >(
        `SELECT q.message_id AS id,
           (CASE WHEN m.from_me = 1 THEN 'true' ELSE 'false' END) || '_' || coalesce(ck.jid, c.jid) || '_' || m.key_id AS sid,
           m.type, m.ts, m.text, m.transcript,
           (m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?) AND m.ts > coalesce(c.cleared_through_ts, 0)) AS live,
           (SELECT e.content_hash FROM embeddings e WHERE e.message_id = m.id AND e.model = ?) AS embeddedHash
         FROM embed_queue q LEFT JOIN messages m ON m.id = q.message_id
           LEFT JOIN chats c ON c.id = m.chat_id LEFT JOIN chats ck ON ck.id = c.merged_into
         WHERE q.message_id < ? ORDER BY q.message_id DESC LIMIT ?`,
        this.c.now(),
        options.model,
        options.before ?? NO_UPPER_BOUND,
        cap
      );
      const items: BacklogItem[] = [];
      const done: number[] = [];
      for (const row of rows) {
        const hash = row.sid === null ? null : contentHash(row.text, row.transcript);
        if (row.sid === null || row.live !== 1 || (row.text === null && row.transcript === null) || row.embeddedHash === hash) {
          done.push(row.id);
          continue;
        }
        if (items.length === limit) {
          this.dequeueIds(done);
          return { items, hasMore: true, nextBefore: items[items.length - 1]!.id };
        }
        items.push({ id: row.id, sid: row.sid, type: row.type, ts: row.ts, text: row.text, transcript: row.transcript, contentHash: hash! });
      }
      this.dequeueIds(done);
      const hasMore = rows.length === cap;
      return { items, hasMore, nextBefore: hasMore ? rows[rows.length - 1]!.id : null };
    });
  }

  /** Takes messages off the queue for good, until their words change: nothing to embed, or words the server refuses. */
  dequeue(ids: readonly number[]): void {
    if (ids.length === 0) return;
    this.c.write(() => this.dequeueIds(ids));
  }

  /** Messages queued and not yet looked at; the refill still owed is not counted. */
  queueSize(): number {
    return this.c.get<{ n: number }>("SELECT count(*) AS n FROM embed_queue")?.n ?? 0;
  }

  private dequeueIds(ids: readonly number[]): void {
    if (ids.length === 0) return;
    this.c.run("DELETE FROM embed_queue WHERE message_id IN (SELECT value FROM json_each(?))", JSON.stringify(ids));
  }

  private meta(key: string): string | null {
    return this.c.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? null;
  }

  private setMeta(key: string, value: string | null): void {
    if (value === null) this.c.run("DELETE FROM meta WHERE key = ?", key);
    else this.c.run("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", key, value);
  }

  /** Brute-force cosine over the filtered rows; the most similar `limit` whose weighed similarity reaches the floor, hydrated. */
  vectorSearch(input: VectorSearchInput): VectorHit[] {
    const limit = Math.max(1, Math.floor(input.limit));
    const filter = this.search.resolveFilter(input);
    if (filter === null) return [];
    const ranked = this.rank(filter, input.model, unitVector(input.vector), limit, input.minSimilarity ?? 0, input.recencyHalfLifeMs);
    const messages = new Map(this.messages.byIds(ranked.map((hit) => hit.id)).map((message) => [message.id, message]));
    return ranked
      .flatMap((hit) => {
        const message = messages.get(hit.id);
        return message === undefined ? [] : [{ message, similarity: hit.similarity, score: hit.score }];
      })
      .slice(0, limit);
  }

  private rank(
    filter: ResolvedFilter,
    model: string,
    unit: Float64Array,
    limit: number,
    floor: number,
    halfLifeMs: number | undefined
  ): Array<{ id: number; similarity: number; score: number }> {
    const now = this.c.now();
    // Kept and admitted by raw similarity, so fresh weak matches never crowd out an old close one; age only reorders.
    const top = new TopK(limit);
    // A scan of embeddings alone cannot see a clear barrier whose purge has not
    // run yet; while one is pending, the scan goes through messages and chats.
    const joined = filter.narrowsRows || this.messages.purgePending();
    const rows = this.scanRows(filter, model, joined);
    // Rows in the boundary seconds of since/until need their exact millisecond checked.
    const edgeLow = filter.since === undefined ? null : secondOf(filter.since);
    const edgeHigh = filter.until === undefined ? null : secondOf(filter.until);
    for (const row of rows) {
      const id = row[0] as number;
      const bytes = row[1] as Uint8Array;
      if (bytes.byteLength !== unit.length) continue;
      const similarity = int8Similarity(unit, new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      if (similarity <= 0 || similarity < floor || similarity <= top.floor) continue;
      if (!joined && (secondOfId(id) === edgeLow || secondOfId(id) === edgeHigh) && !this.inTimeRange(id, filter)) continue;
      top.push(similarity, id);
    }
    const expired = joined ? null : this.expiredIds(now);
    const ranked = top
      .sorted()
      .filter((hit) => expired === null || !expired.has(hit.id))
      .map((hit) => ({ id: hit.id, similarity: hit.score, score: hit.score * recencyWeight(hit.id, now, halfLifeMs) }));
    return halfLifeMs === undefined ? ranked : ranked.sort((a, b) => b.score - a.score || b.id - a.id);
  }

  /**
   * The rows to score, as [id, vec] arrays. With only a time range the scan
   * reads embeddings alone — tombstones carry no embedding, and ids are
   * chronological — and expired rows are dropped afterwards; chat or sender
   * filters drive the scan from the messages index instead.
   */
  private scanRows(filter: ResolvedFilter, model: string, joined: boolean): Iterable<unknown[]> {
    if (!joined) {
      return this.c
        .arrayStmt("SELECT message_id, vec FROM embeddings WHERE model = ? AND message_id >= ? AND message_id < ?")
        .iterate(model, filter.lower, filter.upper) as Iterable<unknown[]>;
    }
    const params: SQLInputValue[] = [model, filter.lower, filter.upper, ...filter.params];
    return this.c
      .arrayStmt(
        `SELECT e.message_id, e.vec FROM messages m CROSS JOIN chats c ON c.id = m.chat_id CROSS JOIN embeddings e ON e.message_id = m.id
         WHERE e.model = ? AND m.id >= ? AND m.id < ? AND ${filter.where}`
      )
      .iterate(...params) as Iterable<unknown[]>;
  }

  private inTimeRange(id: number, filter: ResolvedFilter): boolean {
    const row = this.c.get<{ ts: number }>("SELECT ts FROM messages WHERE id = ?", id);
    if (row === undefined) return false;
    return (filter.since === undefined || row.ts >= filter.since) && (filter.until === undefined || row.ts <= filter.until);
  }

  /** Messages past their deadline the sweep has not reached yet; normally none. */
  private expiredIds(now: number): Set<number> {
    return new Set(
      this.c
        .all<{ id: number }>(
          `SELECT id FROM messages INDEXED BY messages_expiry
           WHERE expires_at IS NOT NULL AND deleted_at IS NULL AND expires_at <= ?`,
          now
        )
        .map((row) => row.id)
    );
  }

  /**
   * Substring words and meaning in one call. The lexical side looks each
   * query word up in the trigram index and ranks the newest candidates by how
   * many words they carry; the semantic side takes the most similar messages
   * whose similarity, weighed by age, reaches `minSimilarity`, and orders them
   * by that weighed similarity. Reciprocal Rank Fusion merges the two, so a
   * meaning under the floor adds nothing: a question with no answer comes back
   * empty, and a word hit with a weak meaning ranks as a word hit. A word hit
   * the words alone do not vouch for stays only when its meaning clears the
   * floor: one carrying a single content word of a query of three content words
   * or more, or any of a query made only of function words, unless it holds the
   * whole query.
   */
  hybrid(input: HybridSearchInput): HybridResult {
    const limit = Math.max(1, Math.floor(input.limit));
    const filter = this.search.resolveFilter(input);
    const semantic = input.vector !== undefined && input.vector !== null;
    if (filter === null) return { hits: [], semantic, lexicalCapped: false };

    const unit = semantic ? unitVector(input.vector!) : null;
    const lexical = this.lexicalCandidates(input.query, filter, input.lexicalCandidates ?? DEFAULT_CANDIDATES, input.scanCap);
    // Only a meaning at the floor ranks: a word hit whose meaning falls under it fuses as a word hit alone.
    const semanticRanked =
      unit === null
        ? []
        : this.rank(filter, input.model, unit, input.semanticCandidates ?? DEFAULT_CANDIDATES, input.minSimilarity, input.recencyHalfLifeMs);

    const fused = new Map<number, { score: number; lexicalRank: number | null; semanticRank: number | null; similarity: number | null }>();
    lexical.ids.forEach((id, index) => {
      fused.set(id, { score: 1 / (RRF_K + index + 1), lexicalRank: index + 1, semanticRank: null, similarity: null });
    });
    semanticRanked.forEach((hit, index) => {
      const entry = fused.get(hit.id);
      const contribution = 1 / (RRF_K + index + 1);
      if (entry !== undefined) {
        entry.score += contribution;
        entry.semanticRank = index + 1;
        entry.similarity = hit.similarity;
      } else {
        fused.set(hit.id, { score: contribution, lexicalRank: null, semanticRank: index + 1, similarity: hit.similarity });
      }
    });
    if (lexical.weak.length > 0) {
      // A weak lexical hit stays only on its meaning, held to a meaning-only hit's bar: a positive cosine at the
      // floor, which a ranked one has already cleared and an unranked one may clear outside the candidate count.
      const unranked = lexical.weak.filter((id) => fused.get(id)!.semanticRank === null);
      const cosines = unit === null ? new Map<number, number>() : this.similarities(unranked, input.model, unit);
      for (const id of unranked) {
        const similarity = cosines.get(id) ?? 0;
        if (similarity <= 0 || similarity < input.minSimilarity) fused.delete(id);
      }
    }
    if (lexical.loose.length > 0 && unit !== null) {
      // A loose hit needs part of a meaning; without a query vector its word is all there is to go on, and it stays.
      const unranked = lexical.loose.filter((id) => fused.get(id)!.semanticRank === null);
      const cosines = this.similarities(unranked, input.model, unit);
      for (const id of unranked) {
        const similarity = cosines.get(id);
        if (similarity !== undefined && similarity < input.minSimilarity * LOOSE_FLOOR_SHARE) fused.delete(id);
      }
    }
    const best = [...fused.entries()].sort((a, b) => b[1].score - a[1].score || b[0] - a[0]).slice(0, limit);
    const messages = new Map(this.messages.byIds(best.map(([id]) => id)).map((message) => [message.id, message]));
    const hits = best.flatMap(([id, entry]) => {
      const message = messages.get(id);
      return message === undefined ? [] : [{ message, ...entry }];
    });
    return { hits, semantic, lexicalCapped: lexical.capped };
  }

  /**
   * The lexical side of hybrid search. Each query word brings its own newest
   * `want` matches, so a rare word's old match is not crowded out by newer
   * messages sharing only a common word; the messages carrying every index word
   * are one more source, so an old message made only of common words is found
   * too; digits and acronyms under three characters go through the bounded
   * short-query scan. Candidates are scored by the words they carry, each
   * weighted by its rarity among the matches seen, plus a bonus when the whole
   * query appears verbatim; ties go to the newest. `capped` says some source had
   * more matches than were examined. `weak` lists the returned candidates the
   * words alone do not vouch for, unless they hold the query verbatim: those
   * carrying fewer than LEXICAL_MIN_MATCHES distinct content words of a query
   * of LEXICAL_PAIR_FROM content words or more, and every one of a query whose
   * words are all QUERY_STOPWORDS. `loose` lists those carrying only some of
   * a shorter query's content words, which keep their place only with part of
   * a meaning (LOOSE_FLOOR_SHARE). A function word still counts toward the
   * score, never toward those matches.
   */
  private lexicalCandidates(
    query: string,
    filter: ResolvedFilter,
    want: number,
    scanCap: number | undefined
  ): { ids: number[]; weak: number[]; loose: number[]; capped: boolean } {
    const { trigram, short } = hybridWords(query);
    const tokens = [...trigram, ...short];
    if (tokens.length === 0) return { ids: [], weak: [], loose: [], capped: false };
    const perWordCap = Math.max(1, Math.floor((scanCap ?? DEFAULT_TRIGRAM_CAP) / (trigram.length + 1)));
    const perShortCap = Math.max(1, Math.floor(Math.min(scanCap ?? DEFAULT_SCAN_CAP, DEFAULT_SCAN_CAP) / Math.max(1, short.length)));
    const candidates = new Set<number>();
    const weights = new Map<string, number>();
    let capped = false;
    const take = (found: { ids: number[]; cappedAt: number | null }): number => {
      if (found.ids.length > want || found.cappedAt !== null) capped = true;
      for (const id of found.ids.slice(0, want)) candidates.add(id);
      return found.ids.length;
    };
    for (const token of trigram) {
      weights.set(token, 1 / Math.log2(2 + take(this.search.trigramIds(token, filter, filter.upper, want + 1, perWordCap))));
    }
    for (const token of short) {
      weights.set(token, 1 / Math.log2(2 + take(this.search.scanIds(token, filter, filter.upper, want + 1, perShortCap))));
    }
    if (trigram.length > 1) {
      const everyWord = trigram.map(ftsPhrase).join(" AND ");
      take(this.search.trigramIds(query, filter, filter.upper, want + 1, perWordCap, everyWord));
    }
    if (candidates.size === 0) return { ids: [], weak: [], loose: [], capped };
    const phrase = foldText(query).replace(/\s+/g, " ").trim();
    const scores = new Map<number, number>();
    const content = tokens.filter((token) => !QUERY_STOPWORDS.has(token)).length;
    // Content words a hit must carry: two of a long question, one of a query of function words alone, else none.
    const required = content === 0 ? 1 : content >= LEXICAL_PAIR_FROM ? LEXICAL_MIN_MATCHES : 0;
    const weak = new Set<number>();
    const loose = new Set<number>();
    for (const row of this.c.all<{ id: number; text: string | null; transcript: string | null }>(
      "SELECT id, text, transcript FROM messages WHERE id IN (SELECT value FROM json_each(?))",
      JSON.stringify([...candidates])
    )) {
      const haystack = foldText(`${row.text ?? ""}\n${row.transcript ?? ""}`);
      let score = 0;
      let matched = 0;
      for (const token of tokens) {
        if (!haystack.includes(token)) continue;
        score += weights.get(token)!;
        if (!QUERY_STOPWORDS.has(token)) matched++;
      }
      const verbatim = tokens.length > 1 && haystack.replace(/\s+/g, " ").includes(phrase);
      if (verbatim) score += 1;
      scores.set(row.id, score);
      if (matched < required && !verbatim) weak.add(row.id);
      else if (content > 1 && content < LEXICAL_PAIR_FROM && matched < content && !verbatim) loose.add(row.id);
    }
    const ids = [...candidates].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || b - a).slice(0, want);
    return { ids, weak: ids.filter((id) => weak.has(id)), loose: ids.filter((id) => loose.has(id)), capped };
  }

  /** Raw cosine of each message's stored vector from `model` against the unit query; a message without one is left out. */
  private similarities(ids: readonly number[], model: string, unit: Float64Array): Map<number, number> {
    const cosines = new Map<number, number>();
    if (ids.length === 0) return cosines;
    const rows = this.c
      .arrayStmt("SELECT message_id, vec FROM embeddings WHERE model = ? AND message_id IN (SELECT value FROM json_each(?))")
      .iterate(model, JSON.stringify(ids)) as Iterable<unknown[]>;
    for (const row of rows) {
      const bytes = row[1] as Uint8Array;
      if (bytes.byteLength !== unit.length) continue;
      cosines.set(row[0] as number, int8Similarity(unit, new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
    }
    return cosines;
  }
}
