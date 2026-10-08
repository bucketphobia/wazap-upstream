/**
 * Semantic recall for one account: search by words and meaning at once, the
 * feed that embeds what the database holds, the embedding sidecar, and what
 * get_status says about the index. Part of WhatsAppService (src/whatsapp.ts),
 * which lends the database and its guards through RecallHost.
 */

import type { Config } from "../config.js";
import type { AccountDb, StoredMessage } from "../db/index.js";
import { asWazapError, WazapError } from "../errors.js";
import { STATUS_JID } from "../ids.js";
import { log, logError } from "../logger.js";
import { searchableText } from "../messages.js";
import { withoutPrivateQuote } from "../private-contacts.js";
import { diversify } from "../recall/variety.js";
import {
  EMBED_MODELS,
  EmbedEngine,
  EmbedFeed,
  embedReady,
  RECALL_TEXT_CAP,
  readRecallSettings,
  type RecallSettings,
  type RecallStatus,
} from "../recall/index.js";
import type { TranscriptRecord } from "../transcribe/index.js";
import type { RecallAnswer, RecallHit, SearchOptions, Synced } from "../wa-types.js";
import type { AccountIdentity } from "./identity.js";
import { pageLimit } from "./util.js";
import type { MessageViews } from "./views.js";

/** Hybrid hits recall ranks for variety before it cuts the list to the limit. */
const RECALL_RERANK_WINDOW = 100;

/** A match found by meaning loses half its way down to 70% each month: recency orders close matches, never buries a clearly closer old one. */
const RECALL_RECENCY_HALF_LIFE_MS = 30 * 86_400_000;

/** How long a search waits for its query's embedding (a sidecar starting cold takes longer) before it answers by words. */
const RECALL_QUERY_WAIT_MS = 8_000;

/** How long the recall status reuses its count of stored vectors. */
const VECTOR_COUNT_TTL_MS = 10_000;

/** Same rule as transcribe: a wrong WAZAP_RECALL_* value degrades to feature-off, never a crash. */
function readRecallConfig(dataDir: string): RecallSettings | WazapError {
  try {
    return readRecallSettings(process.env, dataDir);
  } catch (err) {
    const fault = asWazapError(err);
    logError("recall settings", fault);
    return fault;
  }
}

/** What the service lends recall: the database, its guards, and a note's transcript, read at each call. */
export interface RecallHost {
  db(): AccountDb;
  readyDb(): AccountDb | null;
  stopped(): boolean;
  /** `preparing` while the legacy files are being imported. */
  storageState(): "ready" | "preparing" | "failed";
  guarded<T>(work: () => Promise<T>): Promise<T>;
  ensureConnected(): void;
  waitForSync(): Promise<void>;
  synced<T>(data: T): Synced<T>;
  transcriptRecordOf(message: StoredMessage): TranscriptRecord;
}

export class AccountRecall {
  /** The recall environment, or the complaint about it. Same rule as transcribe: a bad env is a line, not a crash. */
  private readonly recallEnv: RecallSettings | WazapError;
  /** Embeds what the database holds; null when recall is off. */
  readonly embedFeed: EmbedFeed | null;
  vectorCount: { at: number; count: number } | null = null;
  /** The sidecar starts on the first embedding call, never at boot. */
  private recallEngineP: Promise<EmbedEngine> | null = null;
  /** RECALL_QUERY_WAIT_MS; a field so a test need not wait eight seconds. */
  private recallQueryWaitMs = RECALL_QUERY_WAIT_MS;

  constructor(
    private readonly host: RecallHost,
    private readonly identity: AccountIdentity,
    private readonly views: MessageViews,
    private readonly config: Config
  ) {
    this.recallEnv = readRecallConfig(config.dataDir);
    const recall = this.recallEnv;
    this.embedFeed =
      recall instanceof WazapError || !recall.enabled || !config.persistHistory
        ? null
        : new EmbedFeed({
            db: () => this.host.readyDb(),
            model: recall.indexModel ?? recall.model,
            words: (message) => this.recallWords(message),
            embed: (texts) => this.recallEmbed(texts, "document"),
          });
  }

  /**
   * Words and meaning in one search: the query is embedded, then matched
   * against the account's stored vectors and its trigram index under the
   * same filters a search by words takes, and the two rankings are fused. A hit
   * found only by meaning must clear the similarity floor. A row the database
   * holds only as text (imported from the old recall index) answers with that
   * text, marked `from_index`.
   */
  recall(
    query: string,
    chatId: string | undefined,
    limit: number,
    opts: SearchOptions = {}
  ): Promise<Synced<RecallAnswer>> {
    return this.host.guarded(async () => {
      this.host.ensureConnected();
      await this.host.waitForSync();
      const settings = this.readyRecall();
      limit = pageLimit(limit);
      const scope = chatId === undefined ? undefined : this.identity.resolveId(chatId);
      const from = this.identity.senderFilter(opts.from);
      const vector = await this.queryVector(query);
      const db = this.host.db();
      const people = scope === undefined ? this.identity.privateScope(opts.private) : null;
      const author = people !== null && from !== undefined && people.names(from) ? from : undefined;
      // Wide enough that the variety rules below have something to promote, and as wide again when #private hits may take slots.
      const window = Math.max(limit + 5, RECALL_RERANK_WINDOW);
      // TODO(F1-b3): the hybrid scan runs on the main thread, ~160-190 ms at 100,000 vectors; it moves to a worker.
      const result = db.vectors.hybrid({
        query,
        model: settings.indexModel ?? settings.model,
        vector: vector ?? null,
        limit: people === null || author !== undefined ? window : 2 * window,
        minSimilarity: settings.minSimilarity,
        recencyHalfLifeMs: RECALL_RECENCY_HALF_LIFE_MS,
        ...(scope === undefined ? {} : { chat: scope }),
        ...(from === undefined ? {} : { from }),
        ...(opts.sinceMs === undefined ? {} : { since: opts.sinceMs }),
        ...(opts.untilMs === undefined ? {} : { until: opts.untilMs }),
      });
      const ranked = result.hits.filter((hit) => hit.message.chatJid !== STATUS_JID);
      const hidden = new Set(people === null || author !== undefined ? [] : ranked.filter((hit) => people.message(hit.message)));
      // The window the variety rules walk stays as wide as without anyone #private, so the rest rank as they would.
      const shown = ranked.filter((hit) => !hidden.has(hit)).slice(0, window);
      const kept = diversify(shown, (hit) => ({ chat: hit.message.chatJid, text: `${hit.message.text ?? ""} ${hit.message.transcript ?? ""}` })).slice(0, limit);
      // The #private hits that would have been among these: ranked at or above the lowest one kept, or all of them when fewer came.
      const floor = kept.length < limit ? -Infinity : Math.min(...kept.map((hit) => hit.score));
      const privateOmitted = [...hidden].filter((hit) => hit.score >= floor).length;
      const views = this.views.viewsOfStored(kept.map((hit) => hit.message)).map((view) => (people === null ? view : withoutPrivateQuote(view, people, author)));
      const hits = kept.map((hit, i) => ({
        score: hit.score,
        similarity: hit.similarity,
        matched: (hit.lexicalRank !== null && hit.semanticRank !== null ? "both" : hit.lexicalRank !== null ? "words" : "meaning") as RecallHit["matched"],
        message: views[i]!,
        from_index: hit.message.raw === null,
      })) satisfies RecallAnswer["hits"];
      return this.host.synced({ hits, index: this.recallStatus(), lexicalCapped: result.lexicalCapped, ...(privateOmitted > 0 ? { privateOmitted } : {}) });
    });
  }

  /**
   * The settings a recall query may run on, or the refusal the tool reports.
   * "off" splits by cause: the feature disabled, or the history it derives
   * from not persisted; "degraded" carries the line the status already found.
   */
  private readyRecall(): RecallSettings {
    const status = this.recallStatus();
    if (status.state === "degraded") {
      throw new WazapError("RECALL_UNAVAILABLE", status.detail ?? "Semantic recall is unavailable.", status.fix);
    }
    if (status.state === "off" || this.recallEnv instanceof WazapError) {
      if (this.recallEnv instanceof WazapError || !this.recallEnv.enabled) {
        throw new WazapError("RECALL_UNAVAILABLE", "Semantic recall is off.", "Run `wazap config recall local`");
      }
      throw new WazapError(
        "RECALL_UNAVAILABLE",
        "Semantic recall needs message history kept on disk, which is off.",
        "Set WAZAP_PERSIST_HISTORY=1 and restart the server"
      );
    }
    return this.recallEnv;
  }

  /** What the index embeds for a message: the words a person chose, capped to the model's window. */
  private recallWords(message: StoredMessage): string | null {
    const maxChars = this.recallEnv instanceof WazapError || this.recallEnv.api !== undefined ? RECALL_TEXT_CAP : EMBED_MODELS[this.recallEnv.model].maxChars;
    const raw = this.views.rawOf(message);
    let words: string | null;
    if (raw === null) {
      words = message.transcript === null ? message.text : `${message.text ?? ""} "${message.transcript}"`;
    } else {
      words = searchableText(raw, message.transcript === null ? undefined : this.host.transcriptRecordOf(message));
    }
    return words === null || words.trim() === "" ? null : words.slice(0, maxChars);
  }

  /**
   * Resolves when the embedding feed has nothing left to embed. Same rule as
   * transcribeIdle: off the public API, here so tests can wait on it.
   */
  async recallIdle(): Promise<void> {
    await this.embedFeed?.idle();
    this.vectorCount = null;
  }

  /**
   * The sidecar, started on the first embedding request and shared with every
   * other account in the process on the same binary and model. A failed start
   * is not cached — the next queued batch tries again.
   */
  private recallEngine(): Promise<EmbedEngine> {
    if (this.host.stopped()) return Promise.reject(new WazapError("RECALL_UNAVAILABLE", "the service is stopping"));
    if (this.recallEnv instanceof WazapError || !this.recallEnv.enabled) {
      return Promise.reject(
        new WazapError("RECALL_UNAVAILABLE", "Semantic recall is off.", "Run `wazap config recall local`")
      );
    }
    if (this.recallEngineP === null) {
      const settings = this.recallEnv;
      this.recallEngineP = (async () => {
        const spec = EMBED_MODELS[settings.model];
        const readiness = await embedReady(settings, spec);
        if (!readiness.ok) throw new WazapError("RECALL_UNAVAILABLE", readiness.detail, readiness.fix);
        return EmbedEngine.start(settings, spec, log);
      })();
      this.recallEngineP.catch(() => (this.recallEngineP = null));
    }
    return this.recallEngineP;
  }

  /**
   * The query's embedding, waited for at most recallQueryWaitMs: past it the
   * search answers by words (TIMEOUT), while the sidecar keeps starting and
   * the request under way finishes for nobody, so the next search finds it up.
   */
  private async queryVector(query: string): Promise<number[] | undefined> {
    const embedding = this.recallEmbed([query], "query");
    embedding.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const seconds = Math.round(this.recallQueryWaitMs / 100) / 10;
        reject(new WazapError("TIMEOUT", `Meaning search did not answer within ${seconds} s; the embedding model may still be starting.`, "Search again in a minute for meaning too"));
      }, this.recallQueryWaitMs);
      timer.unref();
    });
    try {
      const [vector] = await Promise.race([embedding, late]);
      return vector;
    } finally {
      clearTimeout(timer);
    }
  }

  private async recallEmbed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    const engine = await this.recallEngine();
    return engine.embed(texts, kind);
  }

  recallStatus(): RecallStatus {
    if (this.recallEnv instanceof WazapError) {
      return { state: "degraded", indexed: 0, pending: 0, detail: this.recallEnv.message, fix: this.recallEnv.fix };
    }
    if (!this.recallEnv.enabled || !this.config.persistHistory || this.embedFeed === null) {
      return { state: "off", indexed: 0, pending: 0 };
    }
    const db = this.host.readyDb();
    const indexed = this.indexedCount(db, this.recallEnv.indexModel ?? this.recallEnv.model);
    const pending = this.embedFeed.pending;
    if (this.embedFeed.failing !== null) {
      return {
        state: "degraded",
        indexed,
        pending,
        detail: this.embedFeed.failing,
        fix: "Check that the embedding server answers; indexing resumes on its own, with nothing lost",
      };
    }
    if (db === null) {
      if (this.host.storageState() === "preparing") return { state: "indexing", indexed, pending };
      return { state: "degraded", indexed, pending, detail: "the account database is not open" };
    }
    return { state: this.embedFeed.busy ? "indexing" : "ready", indexed, pending };
  }

  /** Stored vectors of the model, counted at most every few seconds: the count walks the table. */
  private indexedCount(db: AccountDb | null, model: string): number {
    if (db === null) return this.vectorCount?.count ?? 0;
    const now = Date.now();
    if (this.vectorCount === null || now - this.vectorCount.at > VECTOR_COUNT_TTL_MS) {
      this.vectorCount = { at: now, count: db.vectors.count(model) };
    }
    return this.vectorCount.count;
  }

  /**
   * The feed first, then the engine — releasing its claim on the shared
   * sidecar unblocks an embedding call in flight. An engine still coming up is
   * released whenever its start resolves.
   */
  async stopRecall(): Promise<void> {
    const feedStop = this.embedFeed?.stop() ?? Promise.resolve();
    if (this.recallEngineP !== null) {
      void this.recallEngineP.then((engine) => engine.stop()).catch(() => {});
    }
    await feedStop;
  }
}
