/**
 * The legacy import of one account, phase by phase, resumable at every chunk.
 *
 * Order, and why:
 * 1. lids — the lid ↔ number pairings first, so every later write lands on
 *    the person's canonical chat and contact instead of starting a lid chat
 *    that a fold would have to move afterwards;
 * 2. barriers — clears, deletions and passed deadlines before any message, so
 *    no deleted message is ever inserted, not even for one chunk;
 * 3. history — `history/*.jsonl`, file by file, each file's newest line per
 *    message, sorted by time; revokes place their tombstones before the file's
 *    messages; reactions and votes are deferred to phase 7;
 * 4. snapshot — chats, contacts, the snapshot's messages over the history's
 *    (a newer edit wins by editedAt), stories, receipts, transcripts;
 * 5. notes — notes, tags and fields, handled marks, lid-folded;
 * 6. beta — the 0.15-beta archive, owner-checked, only keys not stored yet,
 *    its deletions honoured;
 * 7. marks — every deferred reaction and vote, once every message they may
 *    point at is stored; a vote no poll opens becomes the message the service
 *    shows for it;
 * 8. recall — vectors whose words still match the stored message, and the
 *    rows only the index still has, as text-only messages;
 * 9. optimize — the full-text index merged once, after the bulk writes.
 *
 * Resumability: each chunk commits its rows together with the progress record
 * (`import_progress` in meta: phase, cursor, counters), so a crash or a close
 * resumes after the last committed chunk with the counters that chunk left.
 * Chunked operations the storage module runs on its own (a lid fold, a clear
 * purge) are idempotent and simply run again. Every decision is rebuilt from
 * the legacy files on each run, which never change them.
 */
import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { WAMessage } from "baileys";
import type { AccountPaths } from "../config.js";
import { chatKindOf, contentHash, parseSid, StorageError, type AccountDb, type MessageInput, type UpsertResult } from "../db/index.js";
import { readLinkedAccount } from "../auth-state.js";
import { isNoiseJid, STATUS_JID } from "../ids.js";
import { chatMetadata, momentsOf, type HistoryRecord } from "../store.js";
import { isEvent, messageIdFor, messageTimestampMs, pollOf, protoNumber, voteOf } from "../messages.js";
import { readVote } from "../polls.js";
import { EMBED_MODELS, RECALL_TEXT_CAP } from "../recall/index.js";
import type { EmbedModelAlias } from "../recall/types.js";
import type { TranscriptRecord } from "../transcribe/index.js";
import { proto } from "baileys";
import { buildContext, yieldLoop, type ImportContext } from "./context.js";
import {
  base64Bytes,
  CALL_DEDUPE_WINDOW_MS,
  callDetail,
  canonical,
  classify,
  decodeRaw,
  FUTURE_SLACK_MS,
  isMe,
  isTrackedCall,
  refSid,
  revokedRefs,
  STORY_TTL_MS,
  viewSidOf,
  type Classified,
  type MessageRef,
} from "./convert.js";
import {
  detail,
  emptyPhases,
  IMPORT_PHASES,
  skip,
  type ImportPhase,
  type ImportReport,
  type MalformedFile,
  type PhaseReport,
} from "./report.js";
import {
  betaIdentity,
  betaOwner,
  betaRows,
  betaTimes,
  findBetaArchive,
  isBetaExpiry,
  historyFiles,
  openBetaArchive,
  readBetaIdentity,
  readHistoryFile,
  readRecallIndex,
  recallLine,
  sameBetaImport,
  VectorFile,
  withBetaImport,
  type BetaRow,
  type HistoryFileRead,
  type RecallIndex,
} from "./sources.js";
import { verifyLegacyImport } from "./verify.js";

export const DEFAULT_IMPORT_CHUNK = 500;
/** A chunk also commits once it has run this long, so the event loop never waits much longer. */
const CHUNK_BUDGET_MS = 40;

export const IMPORT_META = {
  state: "import_state",
  progress: "import_progress",
  report: "import_report",
  deferredCount: "import_deferred_count",
  deferred: (n: number) => `import_deferred_${n}`,
  contactsResyncedAt: "contacts_resynced_at",
  /**
   * The beta archives this database imported, `[{ owner, rows, lastTs }]`
   * (BetaIdentity): one added when its rows went in for the linked owner, never
   * for an archive skipped as another's, unreadable or absent. Nothing
   * retires an archive without it.
   */
  betaImported: "beta_imported",
  /** A beta import run after the account's import (importBetaArchive): its progress, then its report. */
  betaProgress: "import_beta_progress",
  betaReport: "import_beta_report",
} as const;

/** The phases a beta archive imported after the account's import runs. */
const LATE_BETA_PHASES = ["beta", "marks", "optimize"] as const satisfies readonly ImportPhase[];

export interface ImportOptions {
  /** WAZAP_RETENTION: disappearing-message deadlines are carried over and enforced. Default false, as in the service. */
  retention?: boolean;
  /** The clock the future-timestamp rule, story ages and deadlines read. */
  now?: () => number;
  /** Rows per transaction; default 500. */
  chunkSize?: number;
  /** Compare against the legacy service's view afterwards; default true. */
  verify?: boolean;
  /** Where verification copies the legacy files to replay them; default the database's directory. */
  workDir?: string;
  /** The beta archive: undefined looks in the data dir and the account dir, null skips it. */
  betaArchive?: string | null;
  /** Called after every committed chunk; a test closes the database here to simulate a crash. */
  afterChunk?: (event: { phase: ImportPhase; chunks: number }) => void | Promise<void>;
}

export interface ImportArgs {
  dataDir: string;
  accountId: string;
  accountPaths: AccountPaths;
  db: AccountDb;
  options?: ImportOptions;
}

interface Progress {
  version: 1;
  startedAt: number;
  /** The rules the first run imported under; a resumed run keeps them, whatever it was passed. */
  retention: boolean;
  runs: number;
  phase: number;
  cursor: unknown;
  phases: ImportReport["phases"];
  malformedFiles: MalformedFile[];
}

/** A reaction or vote whose target may not be stored yet. */
type Deferred =
  /** A reaction; ts null takes the target message's own time, so any timed reaction outranks it. */
  | { t: "r"; sid: string; author: string; emoji: string; ts: number | null }
  /** A vote on a poll or event, still encrypted: its chat and base64 protobuf. */
  | { t: "v"; chat: string; raw: string }
  /** A vote the snapshot already read. */
  | { t: "vs"; sid: string; voter: string; choice: string[]; at: number };

interface HistoryItem {
  ts: number;
  classified: Extract<Classified, { kind: "message" }>;
}

/** Lid-keyed entries first, so the number's own entry is written last and wins, as foldAlias merges them. */
interface ContactEntry {
  jid: string;
  /** The place in the address book, for an entry of the snapshot's contacts. */
  listed?: number;
  name?: string;
  notify?: string;
  pushName?: string;
  verifiedName?: string;
}

function lidFirst<T>(entries: Array<[string, T]>): Array<[string, T]> {
  const lid = (jid: string): number => (jid.endsWith("@lid") ? 0 : 1);
  return entries.map((entry, i) => ({ entry, i })).sort((a, b) => lid(a.entry[0]) - lid(b.entry[0]) || a.i - b.i).map((x) => x.entry);
}

function dbBytes(path: string): number {
  let total = 0;
  for (const file of [path, `${path}-wal`]) {
    try {
      total += statSync(file).size;
    } catch {
      // absent
    }
  }
  return total;
}

/**
 * Imports one account's legacy files into its database. Idempotent: a
 * finished import returns its stored report and changes nothing; an
 * interrupted one resumes where its last chunk committed. Never writes to a
 * legacy file. An unlinked account imports without an owner and skips the
 * beta archive, whose owner it cannot check.
 */
export async function importLegacyAccount(args: ImportArgs): Promise<ImportReport> {
  const { db } = args;
  if (db.readOnly) throw new StorageError("READ_ONLY", "The legacy import needs a writable account database.");
  if (db.getMeta(IMPORT_META.state) === "done") {
    const stored = db.getMeta(IMPORT_META.report);
    if (stored !== null) return { ...(JSON.parse(stored) as ImportReport), alreadyDone: true };
  }
  await db.resume();
  return new ImportRun(args).execute();
}

export interface LateBetaResult {
  /** "imported": its rows are in and the marker is written; otherwise why nothing ran. */
  outcome: "imported" | "not-imported-yet" | "unlinked" | "other-owner" | "unreadable" | "already";
  phases?: Pick<ImportReport["phases"], "beta" | "marks">;
}

/**
 * Imports a beta archive into an account whose import already finished
 * without it: the account was not linked then, the archive could not be read,
 * or it was copied in afterwards. Only the beta phase runs, then the marks it
 * deferred and an optimize, resumable like the import; the legacy files are
 * not needed. Refuses unless the linked number owns the archive, and does
 * nothing once `beta_imported` names this very archive.
 */
export async function importBetaArchive(args: ImportArgs & { betaArchive: string }): Promise<LateBetaResult> {
  const { db } = args;
  if (db.readOnly) throw new StorageError("READ_ONLY", "The beta import needs a writable account database.");
  const state = db.getMeta(IMPORT_META.state);
  if (state !== "done" && state !== "imported") return { outcome: "not-imported-yet" };
  const identity = readBetaIdentity(args.betaArchive);
  if (identity === null) return { outcome: "unreadable" };
  if (sameBetaImport(db.getMeta(IMPORT_META.betaImported), identity)) return { outcome: "already" };
  let owner: string | null;
  try {
    owner = readLinkedAccount(args.accountPaths.authDir)?.id ?? null;
  } catch {
    owner = null;
  }
  if (owner === null) return { outcome: "unlinked" };
  if (identity.owner !== owner) return { outcome: "other-owner" };
  await db.resume();
  const full = db.getMeta(IMPORT_META.progress);
  const retention = full === null ? args.options?.retention === true : (JSON.parse(full) as Progress).retention;
  const run = new ImportRun({ ...args, options: { ...args.options, retention, betaArchive: args.betaArchive } }, "late-beta");
  const phases = await run.executeLateBeta();
  return { outcome: sameBetaImport(db.getMeta(IMPORT_META.betaImported), identity) ? "imported" : "unreadable", phases };
}

class ImportRun {
  private readonly db: AccountDb;
  private readonly options: ImportOptions;
  /** The phases this run walks: all of them, or the late beta import's. */
  private readonly plan: readonly ImportPhase[];
  private readonly progressKey: string;
  private readonly now: () => number;
  private readonly chunkSize: number;
  private progress: Progress;
  private context!: ImportContext;
  private tick = performance.now();
  private chunks = 0;

  constructor(
    private readonly args: ImportArgs,
    private readonly mode: "full" | "late-beta" = "full"
  ) {
    this.db = args.db;
    this.options = args.options ?? {};
    this.now = this.options.now ?? Date.now;
    this.chunkSize = Math.max(1, Math.floor(this.options.chunkSize ?? DEFAULT_IMPORT_CHUNK));
    this.plan = mode === "full" ? IMPORT_PHASES : LATE_BETA_PHASES;
    this.progressKey = mode === "full" ? IMPORT_META.progress : IMPORT_META.betaProgress;
    const stored = this.db.getMeta(this.progressKey);
    this.progress =
      stored === null
        ? {
            version: 1,
            startedAt: this.now(),
            retention: this.options.retention === true,
            runs: 0,
            phase: 0,
            cursor: null,
            phases: emptyPhases(),
            malformedFiles: [],
          }
        : (JSON.parse(stored) as Progress);
    this.progress.runs++;
  }

  async execute(): Promise<ImportReport> {
    this.context = await buildContext({
      accountPaths: this.args.accountPaths,
      now: this.now(),
      enforceExpiry: this.progress.retention,
    });
    if (this.context.owner !== null) this.db.bindOwner(this.context.owner.id);
    this.db.transaction(() => {
      this.db.setMeta(IMPORT_META.state, "running");
      this.db.setMeta(IMPORT_META.progress, JSON.stringify(this.progress));
    });
    await this.runPhases();
    return this.finish();
  }

  /** The late beta import: the context the files still give, the pairings the database learned since, and three phases. */
  async executeLateBeta(): Promise<Pick<ImportReport["phases"], "beta" | "marks">> {
    this.context = await buildContext({
      accountPaths: this.args.accountPaths,
      now: this.now(),
      enforceExpiry: this.progress.retention,
    });
    for (const [lid, phone] of this.db.identity.lidPairs()) this.context.lids.learn(lid, phone);
    if (this.context.owner !== null) this.db.bindOwner(this.context.owner.id);
    this.db.setMeta(this.progressKey, JSON.stringify(this.progress));
    await this.runPhases();
    const phases = { beta: this.progress.phases.beta, marks: this.progress.phases.marks };
    this.db.transaction(() => {
      const count = Number(this.db.getMeta(IMPORT_META.deferredCount) ?? "0");
      for (let n = 0; n < count; n++) this.db.setMeta(IMPORT_META.deferred(n), null);
      this.db.setMeta(IMPORT_META.deferredCount, null);
      this.db.setMeta(IMPORT_META.betaReport, JSON.stringify({ finishedAt: this.now(), runs: this.progress.runs, phases }));
      this.db.setMeta(this.progressKey, null);
    });
    return phases;
  }

  private async runPhases(): Promise<void> {
    const runners: Record<ImportPhase, () => Promise<void>> = {
      lids: () => this.lids(),
      barriers: () => this.barriers(),
      history: () => this.history(),
      snapshot: () => this.snapshot(),
      notes: () => this.notes(),
      beta: () => this.beta(),
      marks: () => this.marks(),
      recall: () => this.recall(),
      optimize: () => this.optimize(),
    };
    while (this.progress.phase < this.plan.length) {
      this.tick = performance.now();
      await runners[this.plan[this.progress.phase]!]();
      await this.commit(null, undefined, true);
    }
  }

  private get phaseName(): ImportPhase {
    return this.plan[Math.min(this.progress.phase, this.plan.length - 1)]!;
  }

  private phase(name: ImportPhase): PhaseReport {
    return this.progress.phases[name];
  }

  private get startedAt(): number {
    return this.progress.startedAt;
  }

  /**
   * Writes a chunk and the progress after it in one transaction, then lets the
   * event loop run. `advance` closes the phase: the next run starts the next one.
   */
  private async commit(cursor: unknown, body?: () => void, advance = false): Promise<void> {
    const name = this.phaseName;
    this.db.transaction(() => {
      body?.();
      const at = performance.now();
      this.phase(name).durationMs += Math.round(at - this.tick);
      this.tick = at;
      this.progress.cursor = typeof cursor === "function" ? (cursor as () => unknown)() : cursor;
      if (advance) this.progress.phase++;
      this.db.setMeta(this.progressKey, JSON.stringify(this.progress));
    });
    this.chunks++;
    await this.options.afterChunk?.({ phase: name, chunks: this.chunks });
    await yieldLoop();
  }

  /**
   * Applies items[from..] in transactions of at most chunkSize items that also
   * stop after CHUNK_BUDGET_MS, each committing the cursor where it stopped.
   */
  private async batches<T>(
    items: readonly T[],
    from: number,
    cursorAt: (end: number) => unknown,
    apply: (item: T, deferred: Deferred[]) => void
  ): Promise<void> {
    let start = from;
    while (start < items.length) {
      let end = start;
      await this.commit(
        () => cursorAt(end),
        () => {
          const began = performance.now();
          const stop = Math.min(items.length, start + this.chunkSize);
          const deferred: Deferred[] = [];
          while (end < stop) {
            apply(items[end]!, deferred);
            end++;
            if (performance.now() - began > CHUNK_BUDGET_MS) break;
          }
          this.pushDeferred(deferred);
        }
      );
      start = end;
    }
  }

  private pushDeferred(items: Deferred[]): void {
    if (items.length === 0) return;
    const n = Number(this.db.getMeta(IMPORT_META.deferredCount) ?? "0");
    this.db.setMeta(IMPORT_META.deferred(n), JSON.stringify(items));
    this.db.setMeta(IMPORT_META.deferredCount, String(n + 1));
  }

  private count(phase: PhaseReport, result: UpsertResult): void {
    switch (result.outcome) {
      case "inserted":
        phase.imported++;
        break;
      case "updated":
        phase.updated++;
        break;
      case "stale":
        detail(phase, "stale");
        break;
      default:
        skip(phase, "barrier");
        detail(phase, `barrier_${result.outcome}`);
    }
  }

  // 1. lids ------------------------------------------------------------------

  private async lids(): Promise<void> {
    const phase = this.phase("lids");
    const pairs = [...this.context.lids];
    let index = (this.progress.cursor as { index: number } | null)?.index ?? 0;
    while (index < pairs.length) {
      const end = Math.min(pairs.length, index + this.chunkSize);
      let learned = 0;
      let malformed = 0;
      for (; index < end; index++) {
        const [lid, phone] = pairs[index]!;
        try {
          await this.db.learnLidPhone(lid, phone);
          learned++;
        } catch (err) {
          if (!(err instanceof StorageError) || err.code !== "INVALID_INPUT") throw err;
          malformed++;
        }
      }
      await this.db.idle();
      await this.commit({ index }, () => {
        phase.read += learned + malformed;
        phase.imported += learned;
        if (malformed > 0) skip(phase, "malformed", malformed);
        if (index === pairs.length && this.context.inferredLids > 0) detail(phase, "inferredFromRings", this.context.inferredLids);
      });
    }
  }

  // 2. barriers ----------------------------------------------------------------

  private async barriers(): Promise<void> {
    const phase = this.phase("barriers");
    const ctx = this.context;
    const cursor = (this.progress.cursor as { cleared: number; deleted: number } | null) ?? { cleared: 0, deleted: 0 };

    const cleared = ctx.retention.cleared;
    for (let i = cursor.cleared; i < cleared.length; i++) {
      const [jid, at] = cleared[i]!;
      const chat = canonical(ctx, jid);
      const valid = at > 0 && !isNoiseJid(chat);
      if (valid) await this.db.messages.clearChat(chat, Math.floor(at));
      await this.commit({ cleared: i + 1, deleted: 0 }, () => {
        phase.read++;
        if (valid) detail(phase, "cleared");
        else skip(phase, "malformed");
      });
    }

    const deleted = await this.deletedKeys();
    const times = await this.knownTimes(new Set(deleted.map((entry) => `${entry.ref.chatJid}|${entry.ref.keyId}`)));
    const fallback = Math.floor(ctx.retention.mtimeMs ?? this.startedAt);
    await this.batches(
      deleted,
      cursor.deleted,
      (end) => ({ cleared: cleared.length, deleted: end }),
      (entry) => {
        phase.read++;
        let ts = times.get(`${entry.ref.chatJid}|${entry.ref.keyId}`) ?? entry.ts;
        if (ts === undefined) {
          // No source knows the message's time any more. In a cleared chat it
          // predates the clear, so the barrier itself covers it; elsewhere the
          // retention file's own time is the latest it can have been deleted.
          ts = this.db.identity.chat(entry.ref.chatJid)?.clearedThroughTs ?? fallback;
          detail(phase, "tsFallback");
        }
        this.tombstone(phase, entry.ref, ts);
      }
    );
  }

  /** A tombstone ahead of (or over) a message; counted by what it did. */
  private tombstone(phase: PhaseReport, ref: MessageRef, ts: number): void {
    const clamped = Math.min(Math.max(1, Math.floor(ts)), this.context.now + FUTURE_SLACK_MS);
    const result = this.db.messages.delete(refSid(ref), {
      ts: clamped,
      chatJid: ref.chatJid,
      keyId: ref.keyId,
      fromMe: ref.fromMe,
      at: this.startedAt,
    });
    detail(phase, `tombstone_${result.outcome}`);
    if (result.outcome === "placeholder" || result.outcome === "deleted") phase.imported++;
  }

  /**
   * Every message the legacy files say is gone: retention's deletions, the
   * history's tombstone lines, and deadlines already past when retention is
   * enforced. `ts` is the tombstone line's own time, the fallback when no
   * source still knows the message's.
   */
  private async deletedKeys(): Promise<Array<{ ref: MessageRef; ts?: number }>> {
    const ctx = this.context;
    const out = new Map<string, { ref: MessageRef; ts?: number }>();
    const add = (sid: string, ts?: number): void => {
      const view = viewSidOf(ctx, sid);
      const parsed = view === null ? null : parseSid(view);
      if (parsed === null || parsed.fromMe === null || isNoiseJid(parsed.chatJid)) return;
      const existing = out.get(view!);
      if (existing === undefined) out.set(view!, { ref: { chatJid: parsed.chatJid, fromMe: parsed.fromMe, keyId: parsed.keyId }, ts });
      else if (existing.ts === undefined && ts !== undefined) existing.ts = ts;
    };
    for (const [sid] of ctx.retention.deleted) add(sid);
    for (const name of historyFiles(ctx.paths.historyDir)) {
      for (const record of readHistoryFile(ctx.paths.historyDir, name)?.records ?? []) {
        if (record.deleted) add(record.sid, typeof record.ts === "number" && record.ts > 0 ? record.ts * 1000 : undefined);
      }
      await yieldLoop();
    }
    if (ctx.enforceExpiry) {
      for (const [view, at] of ctx.deadlines) if (at <= ctx.now) add(view);
    }
    return [...out.values()];
  }

  /** The protocol time of each wanted message (chat|key), from whichever source still has it. */
  private async knownTimes(wanted: Set<string>): Promise<Map<string, number>> {
    const ctx = this.context;
    const times = new Map<string, number>();
    if (wanted.size === 0) return times;
    const note = (sid: string, ts: number | undefined): void => {
      const view = viewSidOf(ctx, sid);
      const parsed = view === null ? null : parseSid(view);
      if (parsed === null || ts === undefined || !Number.isSafeInteger(ts) || ts <= 0) return;
      const key = `${parsed.chatJid}|${parsed.keyId}`;
      if (wanted.has(key) && !times.has(key)) times.set(key, ts);
    };
    for (const name of historyFiles(ctx.paths.historyDir)) {
      for (const record of readHistoryFile(ctx.paths.historyDir, name)?.records ?? []) {
        if (!record.deleted && record.raw) note(record.sid, record.ts * 1000);
      }
      await yieldLoop();
    }
    for (const [sid, raw] of ctx.store.messages) note(sid, protoNumber(raw.messageTimestamp) === undefined ? undefined : messageTimestampMs(raw));
    const recall = readRecallIndex(ctx.paths.recallDir).index;
    for (const live of recall?.live ?? []) {
      try {
        const line = recallLine(recall!, live);
        note(line.sid, line.ts);
      } catch {
        // counted by the recall phase
      }
    }
    const beta = this.betaPath();
    if (beta !== null && this.betaOwnerMatches(beta)) {
      const archive = openBetaArchive(beta);
      try {
        for (let after = 0; ; ) {
          const rows = betaTimes(archive, after, 5000);
          if (rows.length === 0) break;
          for (const row of rows) note(row.sid, row.ts);
          after = rows[rows.length - 1]!.rowid;
          await yieldLoop();
        }
      } finally {
        archive.close();
      }
    }
    return times;
  }

  // 3. history -----------------------------------------------------------------

  private async history(): Promise<void> {
    const phase = this.phase("history");
    const ctx = this.context;
    const files = historyFiles(ctx.paths.historyDir);
    type Cursor = { file: number; name: string | null; size: number | null; planned: boolean; done: number };
    const start = (this.progress.cursor as Cursor | null) ?? { file: 0, name: null, size: null, planned: false, done: 0 };
    for (let f = start.file; f < files.length; f++) {
      const read = readHistoryFile(ctx.paths.historyDir, files[f]!);
      const same = start.file === f && read !== null && start.name === read.name && start.size === read.size;
      if (read === null) {
        await this.commit({ file: f + 1, name: null, size: null, planned: false, done: 0 });
        continue;
      }
      const plan = this.planHistoryFile(read);
      let done = same ? start.done : 0;
      if (!(same && start.planned)) {
        done = 0;
        await this.commit({ file: f, name: read.name, size: read.size, planned: true, done: 0 }, () => {
          phase.read += plan.lines;
          if (plan.malformed > 0) skip(phase, "malformed", plan.malformed);
          for (const [reason, n] of plan.skipped) skip(phase, reason, n);
          detail(phase, "files");
          if (plan.tombstones > 0) detail(phase, "tombstoneLines", plan.tombstones);
          if (read.malformed > 0 || read.partialTail) {
            this.progress.malformedFiles = this.progress.malformedFiles.filter((entry) => entry.file !== read.name);
            this.progress.malformedFiles.push({ file: read.name, lines: read.malformed, partialTail: read.partialTail });
            if (read.partialTail) detail(phase, "partialTails");
          }
          for (const revoke of plan.revokes) {
            this.tombstone(phase, revoke.ref, revoke.ts);
            detail(phase, "revokes");
          }
          this.pushDeferred(plan.deferred);
          if (plan.deferred.length > 0) detail(phase, "deferredMarks", plan.deferred.length);
        });
      }
      await this.batches(
        plan.items,
        done,
        (end) => ({ file: f, name: read.name, size: read.size, planned: true, done: end }),
        (item) => void this.importMessage(phase, item.classified)
      );
    }
  }

  /**
   * One file as loadHistoryFile reads it: the last line of each message wins,
   * tombstone lines stay out, every revoke's target is taken back, and what is
   * left goes in by time.
   */
  private planHistoryFile(read: HistoryFileRead): {
    lines: number;
    malformed: number;
    tombstones: number;
    skipped: Map<Parameters<typeof skip>[1], number>;
    revokes: Array<{ ref: MessageRef; ts: number }>;
    deferred: Deferred[];
    items: HistoryItem[];
  } {
    const ctx = this.context;
    const newest = new Map<string, HistoryRecord>();
    let tombstones = 0;
    let malformed = read.malformed;
    for (const record of read.records) {
      if (record.deleted) tombstones++;
      else if (record.raw) newest.set(record.sid, record);
      else malformed++;
    }
    const skipped = new Map<Parameters<typeof skip>[1], number>();
    const bump = (reason: Parameters<typeof skip>[1]): void => {
      skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
    };
    const decoded: Array<{ record: HistoryRecord; raw: WAMessage; bytes: Uint8Array }> = [];
    const times = new Map<string, number>();
    for (const record of newest.values()) {
      const bytes = base64Bytes(record.raw);
      const raw = decodeRaw(bytes);
      if (raw === null || !raw.key?.remoteJid) {
        malformed++;
        continue;
      }
      decoded.push({ record, raw, bytes });
      if (raw.key.id) times.set(`${canonical(ctx, raw.key.remoteJid)}|${raw.key.id}`, record.ts * 1000);
    }
    const revokes: Array<{ ref: MessageRef; ts: number }> = [];
    const deferred: Deferred[] = [];
    const items: HistoryItem[] = [];
    for (const { record, raw, bytes } of decoded) {
      const chatJid = canonical(ctx, raw.key.remoteJid!);
      const revokeTs = protoNumber(raw.messageTimestamp) === undefined ? record.ts * 1000 : messageTimestampMs(raw);
      for (const ref of revokedRefs(ctx, raw, chatJid)) {
        revokes.push({ ref, ts: times.get(`${ref.chatJid}|${ref.keyId}`) ?? revokeTs });
      }
      const classified = classify(ctx, raw, {
        bytes,
        chatJid,
        transcript: record.tr ?? null,
        fallbackTs: typeof record.ts === "number" ? record.ts * 1000 : undefined,
      });
      switch (classified.kind) {
        case "skip":
          bump(classified.reason);
          break;
        case "reaction":
          deferred.push({ t: "r", sid: classified.targetSid, author: classified.author, emoji: classified.emoji, ts: classified.ts });
          break;
        case "vote":
          deferred.push({ t: "v", chat: chatJid, raw: record.raw });
          break;
        case "message":
          items.push({ ts: typeof record.ts === "number" ? record.ts : classified.input.ts / 1000, classified });
      }
    }
    items.sort((a, b) => a.ts - b.ts);
    const lines = read.records.length + read.malformed;
    return { lines, malformed, tombstones, skipped, revokes, deferred, items };
  }

  /** A message through the call dedupe and the upsert. Runs inside a chunk's transaction. */
  private importMessage(phase: PhaseReport, classified: Extract<Classified, { kind: "message" }>): UpsertResult | null {
    if (callDetail(classified.raw) !== null && !this.keepCall(phase, classified)) {
      skip(phase, "callDuplicate");
      return null;
    }
    const result = this.db.messages.upsert(classified.input);
    this.count(phase, result);
    // The receipts a synced message carries in its protobuf, as receiptFor reads them.
    const synced = classified.raw.key.fromMe ? (classified.raw.userReceipt ?? []) : [];
    if (synced.length > 0 && result.sid !== null && (result.outcome === "inserted" || result.outcome === "updated")) {
      for (const receipt of synced) {
        if (!receipt.userJid || isMe(this.context, receipt.userJid)) continue;
        const moments = momentsOf(receipt);
        this.db.messages.receipt(result.sid, canonical(this.context, receipt.userJid), {
          deliveredAt: moments.delivered ?? null,
          readAt: moments.read ?? null,
          playedAt: moments.played ?? null,
        });
      }
    }
    return result;
  }

  /**
   * keepOverEarlierCall: one call can reach the store as wazap's own record,
   * Baileys' placeholder and WhatsApp's call log, a minute apart at most. The
   * record that says more is kept; the other is dropped for good.
   */
  private keepCall(phase: PhaseReport, classified: Extract<Classified, { kind: "message" }>): boolean {
    const { input, raw } = classified;
    const detailOf = callDetail(raw)!;
    const chat = this.db.identity.chat(input.chatJid);
    if (chat === null) return true;
    const sid = `${input.fromMe}_${chat.jid}_${input.keyId}`;
    const nearby = this.db.messages.recent({
      since: Math.max(1, input.ts - CALL_DEDUPE_WINDOW_MS),
      until: input.ts + CALL_DEDUPE_WINDOW_MS,
      limit: 1000,
    });
    for (const known of nearby.items) {
      if (known.type !== "call" || known.chatJid !== chat.jid || known.sid === sid || known.raw === null) continue;
      const other = decodeRaw(known.raw);
      if (other === null) continue;
      if (isTrackedCall(raw) && isTrackedCall(other)) continue;
      const otherDetail = callDetail(other);
      if (otherDetail === null) continue;
      if (detailOf <= otherDetail) return false;
      this.db.messages.delete(known.sid, { at: this.startedAt });
      detail(phase, "callsReplaced");
      return true;
    }
    return true;
  }

  // 4. snapshot ----------------------------------------------------------------

  private async snapshot(): Promise<void> {
    const phase = this.phase("snapshot");
    const ctx = this.context;
    type Cursor = { step: number; index: number };
    const cursor = (this.progress.cursor as Cursor | null) ?? { step: 0, index: 0 };
    if (ctx.snapshot === null) {
      if (ctx.snapshotUnreadable && cursor.step === 0) await this.commit({ step: 9, index: 0 }, () => detail(phase, "unreadable"));
      return;
    }
    const store = ctx.store;

    const chats = this.mergedChats();
    if (cursor.step <= 0) {
      await this.batches(chats, cursor.step === 0 ? cursor.index : 0, (end) => ({ step: 0, index: end }), ([jid, chat]) =>
        this.importChat(phase, jid, chat)
      );
    }

    const contacts = this.contactEntries();
    if (cursor.step <= 1) {
      await this.batches(contacts, cursor.step === 1 ? cursor.index : 0, (end) => ({ step: 1, index: end }), (entry) =>
        this.importContact(phase, entry)
      );
    }

    const messages: Array<{ sid: string; chatJid: string; story: boolean }> = [];
    for (const [jid, ring] of store.byChat) {
      if (isNoiseJid(jid)) continue;
      for (const sid of ring) messages.push({ sid, chatJid: canonical(ctx, jid), story: false });
    }
    for (const sid of store.stories) messages.push({ sid, chatJid: STATUS_JID, story: true });
    if (cursor.step <= 2) {
      await this.batches(messages, cursor.step === 2 ? cursor.index : 0, (end) => ({ step: 2, index: end }), (entry, deferred) =>
        this.importSnapshotMessage(phase, entry, deferred)
      );
    }

    if (cursor.step <= 3) {
      await this.commit({ step: 4, index: 0 }, () => {
        const at = ctx.snapshot?.contactsResyncedAt;
        if (typeof at === "number" && Number.isFinite(at)) this.db.setMeta(IMPORT_META.contactsResyncedAt, String(at));
      });
    }
  }

  /** Chats under their canonical jid, a lid entry folded under its number's the way foldAlias merges them. */
  private mergedChats(): Array<[string, proto.IConversation]> {
    const ctx = this.context;
    const merged = new Map<string, proto.IConversation>();
    for (const [jid, chat] of lidFirst([...ctx.store.chats])) {
      const key = canonical(ctx, jid);
      if (isNoiseJid(key)) continue;
      const previous = merged.get(key) as (proto.IConversation & Record<string, unknown>) | undefined;
      if (previous === undefined) merged.set(key, { ...(chat as proto.IConversation), id: key });
      else {
        const unreadCount = Math.max(previous.unreadCount ?? 0, (chat as proto.IConversation).unreadCount ?? 0);
        merged.set(key, { ...previous, ...(chat as proto.IConversation), id: key, unreadCount });
      }
    }
    return [...merged];
  }

  private importChat(phase: PhaseReport, jid: string, chat: proto.IConversation): void {
    phase.read++;
    let bytes: Uint8Array | undefined;
    try {
      bytes = proto.Conversation.encode(chatMetadata(chat as Parameters<typeof chatMetadata>[0]) as proto.IConversation).finish();
    } catch {
      bytes = undefined;
    }
    const pinned = protoNumber(chat.pinned as Parameters<typeof protoNumber>[0]);
    const muted = protoNumber(chat.muteEndTime as Parameters<typeof protoNumber>[0]);
    this.db.identity.upsertChat({
      jid,
      ...(chat.name ? { name: chat.name } : {}),
      ...(typeof chat.archived === "boolean" ? { archived: chat.archived } : {}),
      ...(pinned ? { pinned } : {}),
      ...(muted ? { mutedUntil: muted } : {}),
      unread: Math.max(0, chat.unreadCount ?? 0),
      ...(bytes === undefined ? {} : { proto: bytes }),
    });
    detail(phase, "chats");
  }

  /**
   * The snapshot's contacts, each with its place in the address book the
   * service kept (a lid entry and its number's share the earlier place), and
   * the push names people published on their messages, kept apart from a
   * contact's notify as the service kept them.
   */
  private contactEntries(): ContactEntry[] {
    const ctx = this.context;
    const out: ContactEntry[] = [];
    const places = new Map([...ctx.store.contacts.keys()].map((jid, i) => [jid, i + 1]));
    const seen = new Set<string>();
    for (const [jid, contact] of lidFirst([...ctx.store.contacts])) {
      seen.add(jid);
      const pushName = ctx.store.pushNames.get(jid);
      out.push({
        jid,
        listed: places.get(jid)!,
        ...(contact.name ? { name: contact.name } : {}),
        ...(contact.notify ? { notify: contact.notify } : {}),
        ...(pushName ? { pushName } : {}),
        ...(contact.verifiedName ? { verifiedName: contact.verifiedName } : {}),
      });
    }
    for (const [jid, name] of lidFirst([...ctx.store.pushNames])) {
      if (!seen.has(jid) && name) out.push({ jid, pushName: name });
    }
    return out;
  }

  private importContact(phase: PhaseReport, entry: ContactEntry): void {
    phase.read++;
    const jid = canonical(this.context, entry.jid);
    if (chatKindOf(jid) !== "direct" || isNoiseJid(jid)) {
      skip(phase, "noise");
      return;
    }
    this.db.identity.upsertContact({
      jid,
      ...(entry.listed === undefined ? {} : { listed: entry.listed }),
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(entry.notify === undefined ? {} : { notify: entry.notify }),
      ...(entry.pushName === undefined ? {} : { pushName: entry.pushName }),
      ...(entry.verifiedName === undefined ? {} : { verifiedName: entry.verifiedName, isBusiness: true }),
    });
    detail(phase, "contacts");
  }

  /**
   * A snapshot message over whatever the history stored: the service trusts
   * the snapshot's copy, which carries edits the history line predates. When
   * the words differ, the version is an edit, dated by the time the edit gave
   * the message, so a replay of the original can never win it back.
   */
  private importSnapshotMessage(phase: PhaseReport, entry: { sid: string; chatJid: string; story: boolean }, deferred: Deferred[]): void {
    const ctx = this.context;
    const store = ctx.store;
    phase.read++;
    const raw = store.messages.get(entry.sid);
    const b64 = ctx.snapshot?.messages?.[entry.sid];
    if (raw === undefined || b64 === undefined) {
      skip(phase, "malformed");
      return;
    }
    const classified = classify(ctx, raw, {
      bytes: base64Bytes(b64),
      chatJid: entry.chatJid,
      transcript: store.transcripts.get(entry.sid) ?? null,
      story: entry.story,
      asMessage: false,
    });
    if (classified.kind === "reaction") {
      deferred.push({ t: "r", sid: classified.targetSid, author: classified.author, emoji: classified.emoji, ts: classified.ts });
      return;
    }
    if (classified.kind === "vote") {
      deferred.push({ t: "v", chat: entry.chatJid, raw: b64 });
      return;
    }
    if (classified.kind === "skip") {
      skip(phase, classified.reason);
      return;
    }
    const input = classified.input;
    if (entry.story) {
      const end = input.ts + STORY_TTL_MS;
      if (end <= ctx.now) {
        skip(phase, "expired");
        return;
      }
      input.expiresAt = input.expiresAt === null || input.expiresAt === undefined ? end : Math.min(input.expiresAt, end);
      detail(phase, "stories");
    }
    for (const ref of classified.revokes) this.tombstone(phase, ref, input.ts);
    const stored = this.db.messages.get(`${input.fromMe}_${input.chatJid}_${input.keyId}`, { includeHidden: true });
    if (stored !== null && stored.deletedAt === null && stored.text !== input.text) {
      input.editedAt = input.ts;
      detail(phase, "edits");
    }
    const receipt = input.fromMe
      ? store.receiptFor(entry.sid, (jid) => canonical(ctx, jid), (jid) => ctx.lids.isSelf(jid, ctx.ownJid))
      : undefined;
    if (receipt?.status !== undefined) input.status = receipt.status;
    const result = this.importMessage(phase, classified);
    if (result === null || result.sid === null || result.outcome === "deleted" || result.outcome === "cleared" || result.outcome === "expired") {
      return;
    }
    const target = result.sid;
    for (const [user, moments] of Object.entries(receipt?.users ?? {})) {
      const wrote = this.db.messages.receipt(target, user, {
        deliveredAt: moments.delivered ?? null,
        readAt: moments.read ?? null,
        playedAt: moments.played ?? null,
      });
      if (wrote) detail(phase, "receipts");
    }
    if (store.transcripts.has(entry.sid) && input.transcript) detail(phase, "transcripts");
    for (const { emoji, sender } of store.reactionsFor(entry.sid)) {
      deferred.push({ t: "r", sid: target, author: sender, emoji, ts: null });
    }
    for (const [voter, vote] of store.votes.get(entry.sid) ?? []) {
      deferred.push({ t: "vs", sid: target, voter, choice: vote.choice, at: vote.at });
    }
  }

  // 5. notes -------------------------------------------------------------------

  private async notes(): Promise<void> {
    const phase = this.phase("notes");
    const ctx = this.context;
    const cursor = this.progress.cursor as { done: boolean } | null;
    if (cursor?.done) return;
    const notes = ctx.notes;
    await this.commit({ done: true }, () => {
      if (notes === null) {
        if (ctx.notesUnreadable) detail(phase, "unreadable");
        return;
      }
      for (const [jid, entry] of lidFirst(Object.entries(notes.contacts))) {
        phase.read++;
        if (typeof entry?.note !== "string" || entry.note.trim() === "") {
          skip(phase, "malformed");
          continue;
        }
        this.db.identity.setNote(canonical(ctx, jid), entry.note);
        phase.imported++;
        detail(phase, "notes");
      }
      for (const [jid, entry] of lidFirst(Object.entries(notes.fields))) {
        phase.read++;
        const tags = Array.isArray(entry?.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [];
        const fields = Object.fromEntries(
          Object.entries((entry?.fields as Record<string, unknown> | undefined) ?? {}).filter(
            (pair): pair is [string, string] => typeof pair[1] === "string"
          )
        );
        if (tags.length === 0 && Object.keys(fields).length === 0) {
          skip(phase, "malformed");
          continue;
        }
        this.db.identity.updateFields(canonical(ctx, jid), { addTags: tags, set: fields });
        phase.imported++;
        detail(phase, "fields");
      }
      for (const [jid, mark] of lidFirst(Object.entries(notes.handled))) {
        phase.read++;
        const ask = typeof mark?.ask_id === "string" ? viewSidOf(ctx, mark.ask_id) : null;
        if (ask === null || this.db.messages.get(ask) === null) {
          skip(phase, "missingTarget");
          continue;
        }
        const at = typeof mark.at === "string" ? Date.parse(mark.at) : Number.NaN;
        this.db.identity.markHandled(canonical(ctx, jid), ask, Number.isSafeInteger(at) && at > 0 ? at : this.startedAt);
        phase.imported++;
        detail(phase, "handled");
      }
    });
  }

  // 6. beta --------------------------------------------------------------------

  private betaPath(): string | null {
    if (this.options.betaArchive === null) return null;
    if (this.options.betaArchive !== undefined) return this.options.betaArchive;
    return findBetaArchive(this.args.dataDir, this.args.accountPaths);
  }

  private betaOwnerMatches(path: string): boolean {
    const owner = this.context.owner?.id;
    if (owner === undefined) return false;
    try {
      const archive = openBetaArchive(path);
      try {
        return betaOwner(archive) === owner;
      } finally {
        archive.close();
      }
    } catch {
      return false;
    }
  }

  private async beta(): Promise<void> {
    const phase = this.phase("beta");
    const path = this.betaPath();
    const cursor = (this.progress.cursor as { rowid: number } | null) ?? { rowid: 0 };
    if (path === null) return;
    let archive;
    try {
      archive = openBetaArchive(path);
    } catch {
      if (cursor.rowid === 0) await this.commit({ rowid: -1 }, () => detail(phase, "unreadable"));
      return;
    }
    try {
      if (cursor.rowid < 0) return;
      const owner = betaOwner(archive);
      if (this.context.owner === null || owner !== this.context.owner.id) {
        if (cursor.rowid === 0) {
          const rows = (archive.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n;
          await this.commit({ rowid: -1 }, () => {
            phase.read += rows;
            skip(phase, "ownerMismatch", rows);
          });
        }
        return;
      }
      let after = cursor.rowid;
      for (;;) {
        const rows = betaRows(archive, after, this.chunkSize);
        if (rows.length === 0) break;
        after = rows[rows.length - 1]!.rowid;
        await this.batches(rows, 0, (end) => ({ rowid: rows[end - 1]!.rowid }), (row, deferred) =>
          this.importBetaRow(phase, row, deferred)
        );
      }
      // Every row went through for its owner: this archive is imported, and may be retired.
      const identity = betaIdentity(archive);
      await this.commit({ rowid: after }, () =>
        this.db.setMeta(IMPORT_META.betaImported, withBetaImport(this.db.getMeta(IMPORT_META.betaImported), identity))
      );
    } finally {
      archive.close();
    }
  }

  private importBetaRow(phase: PhaseReport, row: BetaRow, deferred: Deferred[]): void {
    const ctx = this.context;
    phase.read++;
    const parsed = parseSid(row.sid);
    const fromMe = row.origin === "true_" ? true : row.origin === "false_" ? false : (parsed?.fromMe ?? null);
    const keyId = row.keyid || parsed?.keyId;
    if (fromMe === null || !keyId || !row.jid) {
      skip(phase, "malformed");
      return;
    }
    const bytes = row.raw ? base64Bytes(row.raw) : null;
    const raw = bytes === null ? null : decodeRaw(bytes);
    if (bytes !== null && raw === null) {
      skip(phase, "malformed");
      return;
    }
    const chatJid = canonical(ctx, raw?.key?.remoteJid || row.jid);
    if (isNoiseJid(chatJid)) {
      skip(phase, "noise");
      return;
    }
    const sid = `${fromMe}_${chatJid}_${keyId}`;
    const stored = this.db.messages.get(sid, { includeHidden: true });
    if (row.deleted) {
      if (isBetaExpiry(row, ctx.now) && !ctx.enforceExpiry) {
        skip(phase, "retentionOff");
        return;
      }
      if (stored !== null && stored.deletedAt !== null) {
        skip(phase, "duplicate");
        return;
      }
      const ts = row.ts > 0 ? row.ts : (stored?.ts ?? Math.floor(ctx.retention.mtimeMs ?? this.startedAt));
      if (row.ts <= 0 && stored === null) detail(phase, "tsFallback");
      if (stored !== null) detail(phase, "deletedLive");
      this.tombstone(phase, { chatJid, fromMe, keyId }, ts);
      return;
    }
    if (stored !== null) {
      skip(phase, "duplicate");
      return;
    }
    if (row.ts > ctx.now + FUTURE_SLACK_MS) {
      skip(phase, "futureTs");
      return;
    }
    let transcript: TranscriptRecord | null = null;
    let reactions: Array<{ sender?: unknown; emoji?: unknown }> = [];
    try {
      const extra = JSON.parse(row.extra || "{}") as { transcript?: TranscriptRecord; reactions?: typeof reactions };
      transcript = extra.transcript ?? null;
      reactions = Array.isArray(extra.reactions) ? extra.reactions : [];
    } catch {
      detail(phase, "malformedExtra");
    }
    let input: MessageInput;
    let classified: Extract<Classified, { kind: "message" }> | null = null;
    if (raw !== null) {
      const c = classify(ctx, raw, { bytes, chatJid, transcript, fallbackTs: row.ts > 0 ? row.ts : undefined });
      if (c.kind === "skip") {
        skip(phase, c.reason);
        return;
      }
      if (c.kind === "reaction") {
        deferred.push({ t: "r", sid: c.targetSid, author: c.author, emoji: c.emoji, ts: c.ts });
        return;
      }
      if (c.kind === "vote") {
        deferred.push({ t: "v", chat: chatJid, raw: row.raw });
        return;
      }
      classified = c;
      input = c.input;
      for (const ref of c.revokes) this.tombstone(phase, ref, input.ts);
    } else {
      if (!(row.ts > 0)) {
        skip(phase, "malformed");
        return;
      }
      const senderJid = !fromMe && chatKindOf(chatJid) !== "direct" && row.sender ? canonical(ctx, row.sender) : undefined;
      input = {
        chatJid,
        keyId,
        fromMe,
        ...(senderJid && chatKindOf(senderJid) === "direct" ? { senderJid } : {}),
        ts: row.ts,
        type: row.type || "unknown",
        text: row.text || null,
        raw: null,
      };
      detail(phase, "textOnly");
    }
    if (typeof row.expires === "number" && row.expires >= 0) {
      input.observedExpiresAt = Math.min(input.observedExpiresAt ?? Infinity, row.expires);
      if (ctx.enforceExpiry) input.expiresAt = Math.min(input.expiresAt ?? Infinity, row.expires);
    }
    const result = classified !== null ? this.importMessage(phase, classified) : this.db.messages.upsert(input);
    if (classified === null) this.count(phase, result!);
    if (result === null || result.sid === null || (result.outcome !== "inserted" && result.outcome !== "updated")) return;
    for (const reaction of reactions) {
      if (typeof reaction.sender !== "string" || typeof reaction.emoji !== "string" || reaction.emoji === "") continue;
      deferred.push({ t: "r", sid: result.sid, author: canonical(ctx, reaction.sender), emoji: reaction.emoji, ts: null });
    }
  }

  // 7. marks -------------------------------------------------------------------

  private async marks(): Promise<void> {
    const phase = this.phase("marks");
    const cursor = (this.progress.cursor as { chunk: number; item: number } | null) ?? { chunk: 0, item: 0 };
    const count = Number(this.db.getMeta(IMPORT_META.deferredCount) ?? "0");
    for (let c = cursor.chunk; c < count; c++) {
      const items = JSON.parse(this.db.getMeta(IMPORT_META.deferred(c)) ?? "[]") as Deferred[];
      const from = c === cursor.chunk ? cursor.item : 0;
      if (items.length === 0 || from >= items.length) {
        await this.commit({ chunk: c + 1, item: 0 });
        continue;
      }
      await this.batches(
        items,
        from,
        (end) => (end >= items.length ? { chunk: c + 1, item: 0 } : { chunk: c, item: end }),
        (item) => this.applyMark(phase, item)
      );
    }
  }

  private applyMark(phase: PhaseReport, item: Deferred): void {
    phase.read++;
    const ctx = this.context;
    if (item.t === "r") {
      const target = this.db.messages.get(item.sid);
      if (target === null || !item.author) {
        skip(phase, "missingTarget");
        detail(phase, "reactionsMissing");
        return;
      }
      this.db.messages.react(target.sid, item.author, item.emoji || null, item.ts ?? target.ts);
      phase.imported++;
      detail(phase, item.emoji ? "reactions" : "reactionRemovals");
      return;
    }
    if (item.t === "vs") {
      const target = this.db.messages.get(item.sid);
      if (target === null || !item.voter || !(item.at > 0)) {
        skip(phase, "missingTarget");
        detail(phase, "votesMissing");
        return;
      }
      this.db.messages.vote(target.sid, item.voter, item.choice.length > 0 ? JSON.stringify(item.choice) : null, item.at);
      phase.imported++;
      detail(phase, "votes");
      return;
    }
    const bytes = base64Bytes(item.raw);
    const raw = decodeRaw(bytes);
    const vote = raw === null ? undefined : voteOf(raw);
    if (raw === null || vote === undefined) {
      skip(phase, "malformed");
      return;
    }
    const target = this.voteTarget(vote, item.chat);
    const spellings = (message: WAMessage): string[] => {
      const key = message.key;
      return ctx.lids.spellings(
        key.fromMe ? [ctx.ownJid] : [key.participant, key.participantAlt, message.participant, key.remoteJid, key.remoteJidAlt]
      );
    };
    const reading = target === null ? undefined : readVote(vote, target.raw, spellings(target.raw), spellings(raw));
    if (target !== null && reading !== undefined) {
      const voter = raw.key.fromMe
        ? ctx.ownJid
        : canonical(ctx, raw.key.participant || raw.participant || raw.key.remoteJid || item.chat);
      if (voter && vote.at > 0) {
        this.db.messages.vote(target.sid, voter, reading.choice.length > 0 ? JSON.stringify(reading.choice) : null, vote.at);
        phase.imported++;
        detail(phase, "votes");
        return;
      }
    }
    // The service keeps a vote it cannot open as a line of its own.
    const classified = classify(ctx, raw, { bytes, chatJid: item.chat, asMessage: true });
    if (classified.kind !== "message") {
      skip(phase, classified.kind === "skip" ? classified.reason : "malformed");
      return;
    }
    const result = this.db.messages.upsert(classified.input);
    this.count(phase, result);
    detail(phase, "votesAsMessages");
  }

  /** voteTarget: the poll or event by id, in the vote's chat under every name that chat goes by, either direction. */
  private voteTarget(vote: NonNullable<ReturnType<typeof voteOf>>, chatJid: string): { sid: string; raw: WAMessage } | null {
    const ctx = this.context;
    const remote = vote.targetKey.remoteJid;
    const chats = [chatJid, remote ? canonical(ctx, remote) : "", ctx.lids.phoneOf(chatJid), ctx.lids.lidOf(chatJid)];
    const mine = Boolean(vote.targetKey.fromMe);
    for (const chat of new Set(chats)) {
      if (!chat) continue;
      for (const fromMe of [mine, !mine]) {
        const stored = this.db.messages.get(messageIdFor({ ...vote.targetKey, fromMe }, chat));
        if (stored?.raw == null) continue;
        const raw = decodeRaw(stored.raw);
        if (raw !== null && (vote.kind === "poll" ? pollOf(raw) !== undefined : isEvent(raw))) return { sid: stored.sid, raw };
      }
    }
    return null;
  }

  // 8. recall ------------------------------------------------------------------

  private async recall(): Promise<void> {
    const phase = this.phase("recall");
    const cursor = (this.progress.cursor as { index: number } | null) ?? { index: 0 };
    if (cursor.index < 0) return;
    const { index, reason } = readRecallIndex(this.context.paths.recallDir);
    if (index === null) {
      if (reason !== "absent" && cursor.index === 0) await this.commit({ index: -1 }, () => detail(phase, `index_${reason}`));
      return;
    }
    const spec = (EMBED_MODELS as Record<string, (typeof EMBED_MODELS)[EmbedModelAlias] | undefined>)[index.state.model];
    if (spec === undefined || spec.dims !== index.state.dims) {
      if (cursor.index === 0) {
        await this.commit({ index: -1 }, () => {
          phase.read += index.live.length;
          skip(phase, "unusable", index.live.length);
        });
      }
      return;
    }
    const cap = Math.min(spec.maxChars, RECALL_TEXT_CAP);
    // A torn index imports its words and no vector: the feed embeds them again.
    const vectors = index.vectorsAligned ? new VectorFile(index.vectorsPath, index.state.dims) : null;
    try {
      if (cursor.index === 0 && (index.malformed > 0 || !index.vectorsAligned)) {
        await this.commit({ index: 0 }, () => {
          if (index.malformed > 0) skip(phase, "malformed", index.malformed);
          if (!index.vectorsAligned) detail(phase, "vectorsDiscarded");
        });
      }
      await this.batches(index.live, cursor.index, (end) => ({ index: end }), (live) =>
        this.importRecallRow(phase, index, vectors, live, cap)
      );
    } finally {
      vectors?.close();
    }
  }

  private importRecallRow(
    phase: PhaseReport,
    index: RecallIndex,
    vectors: VectorFile | null,
    live: RecallIndex["live"][number],
    cap: number
  ): void {
    const ctx = this.context;
    phase.read++;
    let line;
    try {
      line = recallLine(index, live);
    } catch {
      skip(phase, "malformed");
      return;
    }
    if (vectors !== null && (line.model !== index.state.model || !Number.isSafeInteger(line.row) || line.row < 0 || line.row >= vectors.rows)) {
      skip(phase, "unusable");
      return;
    }
    const view = viewSidOf(ctx, line.sid);
    const parsed = view === null ? null : parseSid(view);
    if (parsed === null || parsed.fromMe === null || typeof line.text !== "string") {
      skip(phase, "malformed");
      return;
    }
    if (this.db.messages.get(view!, { includeHidden: true }) === null) {
      const chatJid = typeof line.jid === "string" && line.jid ? canonical(ctx, line.jid) : parsed.chatJid;
      if (isNoiseJid(chatJid)) {
        skip(phase, "noise");
        return;
      }
      if (!Number.isSafeInteger(line.ts) || line.ts <= 0) {
        skip(phase, "malformed");
        return;
      }
      if (line.ts > ctx.now + FUTURE_SLACK_MS) {
        skip(phase, "futureTs");
        return;
      }
      const sender = typeof line.sender === "string" && line.sender ? canonical(ctx, line.sender) : "";
      const deadline = ctx.enforceExpiry
        ? Math.min(line.expiresAt ?? Infinity, ctx.deadlines.get(`${parsed.fromMe}_${chatJid}_${parsed.keyId}`) ?? Infinity)
        : Infinity;
      const result = this.db.messages.upsert({
        chatJid,
        keyId: parsed.keyId,
        fromMe: parsed.fromMe,
        ...(!parsed.fromMe && chatKindOf(chatJid) !== "direct" && chatKindOf(sender) === "direct" && sender ? { senderJid: sender } : {}),
        ts: line.ts,
        type: typeof line.type === "string" && line.type ? line.type : "text",
        text: line.text,
        raw: null,
        ...(deadline === Infinity ? {} : { expiresAt: deadline }),
        ...(Number.isSafeInteger(line.expiresAt) && line.expiresAt! >= 0 ? { observedExpiresAt: line.expiresAt } : {}),
      });
      if (result.outcome !== "inserted") {
        skip(phase, "barrier");
        return;
      }
      detail(phase, "indexOnlyRows");
    }
    if (vectors === null) return;
    const message = this.db.messages.get(view!);
    if (message === null) {
      skip(phase, "hidden");
      return;
    }
    const words = message.transcript === null ? message.text : `${message.text ?? ""} "${message.transcript}"`;
    if (words === null || words.slice(0, cap) !== line.text) {
      skip(phase, "vectorMismatch");
      return;
    }
    if (this.db.vectors.put(message.sid, index.state.model, vectors.row(line.row), contentHash(message.text, message.transcript))) {
      phase.imported++;
    } else {
      skip(phase, "hidden");
    }
  }

  // 9. optimize ----------------------------------------------------------------

  private async optimize(): Promise<void> {
    const { steps } = await this.db.optimize();
    detail(this.phase("optimize"), "steps", steps);
  }

  // finish ---------------------------------------------------------------------

  private async finish(): Promise<ImportReport> {
    // The deferred marks were applied in their phase; what they held (vote payloads) has no reason to stay.
    this.db.transaction(() => {
      const count = Number(this.db.getMeta(IMPORT_META.deferredCount) ?? "0");
      for (let n = 0; n < count; n++) this.db.setMeta(IMPORT_META.deferred(n), null);
      this.db.setMeta(IMPORT_META.deferredCount, null);
    });
    const report: ImportReport = {
      state: "imported",
      alreadyDone: false,
      owner: this.context.owner?.id ?? null,
      startedAt: this.startedAt,
      finishedAt: this.now(),
      runs: this.progress.runs,
      phases: this.progress.phases,
      malformedFiles: this.progress.malformedFiles,
      totals: { ...this.db.counts(), dbBytes: dbBytes(this.db.path) },
      verification: null,
    };
    if (this.options.verify !== false) {
      report.verification = await verifyLegacyImport({
        dataDir: this.args.dataDir,
        accountId: this.args.accountId,
        accountPaths: this.args.accountPaths,
        db: this.db,
        options: {
          retention: this.progress.retention,
          workDir: this.options.workDir,
          now: this.options.now,
          betaArchive: this.betaPath(),
        },
      });
      if (report.verification.ok) report.state = "done";
    }
    this.db.transaction(() => {
      this.db.setMeta(IMPORT_META.report, JSON.stringify(report));
      this.db.setMeta(IMPORT_META.state, report.state);
    });
    return report;
  }
}
