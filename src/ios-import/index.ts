/** iPhone archive import: read-only source, ordinary insert-only rows, atomic checkpoints. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { type AccountDb, type MessageInput, normalizeJid, sidOf } from "../db/index.js";
import { openScratch } from "./scratch.js";
import { openIosSource, IosSourceError } from "./source.js";
import type { SQLInputValue } from "../db/sqlite.js";
import { classifyFailure, transcribeFile, type TranscribeSettings, type Transcript } from "../transcribe/index.js";
import { WazapError } from "../errors.js";
import { log } from "../logger.js";
import { authorizeIosArchive } from "./binding.js";

export const IOS_META = "ios_import_v1";
export const IOS_ERROR = "ios_import_error";
export const IOS_VOICE_TARGETS = "ios_voice_targets_v1";
const TYPES: Record<number, string> = {
  0: "text",
  7: "text",
  1: "image",
  2: "video",
  11: "video",
  8: "document",
  15: "sticker",
  3: "voice",
  4: "contact",
  5: "location",
};
// Keep established supported and explicitly inventoried skipped codes. Everything
// else shares one bucket: source cells may contain arbitrary numbers or text.
const REPORT_TYPES = new Set([...Object.keys(TYPES), "6", "10", "14", "38", "39", "53"]);
function reportType(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && REPORT_TYPES.has(String(value))
    ? String(value)
    : "unknown";
}
function boundedTypeCounts(counts: Record<string, number>): Record<string, number> {
  const bounded: Record<string, number> = {};
  for (const key in counts) {
    if (!Object.hasOwn(counts, key)) continue;
    const count = counts[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) continue;
    const bucket = REPORT_TYPES.has(key) ? key : "unknown";
    bounded[bucket] = Math.min(Number.MAX_SAFE_INTEGER, (bounded[bucket] ?? 0) + count);
  }
  return bounded;
}
function boundedReport(report: IosReport): IosReport {
  return {
    ...report,
    sourceByType: boundedTypeCounts(report.sourceByType),
    skippedByType: boundedTypeCounts(report.skippedByType),
  };
}
const EPOCH = Date.UTC(2001, 0, 1);
const SELECT = `SELECT m.Z_PK pk,m.ZMESSAGETYPE nativeType,m.ZISFROMME fromMe,m.ZSTANZAID keyId,
 m.ZMESSAGEDATE date,m.ZTEXT text,m.ZPARENTMESSAGE parent,
 c.ZCONTACTJID chat,c.ZGROUPINFO groupInfo,c.ZPARTNERNAME name,g.ZMEMBERJID sender,
 NULL caption,NULL mediaPath
 FROM ZWAMESSAGE m LEFT JOIN ZWACHATSESSION c ON c.Z_PK=m.ZCHATSESSION
 LEFT JOIN ZWAGROUPMEMBER g ON g.Z_PK=m.ZGROUPMEMBER
`;
interface Row {
  pk: number;
  nativeType: number;
  fromMe: number;
  keyId: string | null;
  date: number | null;
  text: string | null;
  parent: number | null;
  chat: string | null;
  groupInfo: number | null;
  name: string | null;
  sender: string | null;
  caption: string | null;
  mediaPath: string | null;
}
export interface IosReport {
  state: "rows" | "replies" | "voice" | "done";
  sourceRows: number;
  sourceByType: Record<string, number>;
  inserted: number;
  skippedExisting: number;
  skippedByType: Record<string, number>;
  skippedByBarrier: Record<string, number>;
  quarantined: number;
  quarantineReasons: Record<string, number>;
  voice: { transcribed: number; skipped: number; missing: number; failed: number };
}
interface Progress {
  hash: string;
  last: number;
  report: IosReport;
  replies?: Array<{ child: string; parent: number; id?: number }>;
  /** Legacy canonical-SID keys cannot prove exclusions after an identity fold. */
  voiceFailures?: Record<string, string>;
  voiceFailureRows?: Record<string, string>;
  collisionRows?: number[];
  /** Original target bindings were captured from the first text chunk. */
  voiceBindings?: 1 | 2;
  format?: 2;
  generation?: string;
  replyCursor?: string;
  voiceTerminalFailures?: number;
}
export function readIosReport(db: Pick<AccountDb, "getMeta">): IosReport | null {
  const raw = db.getMeta(IOS_META);
  return raw === null ? null : boundedReport((JSON.parse(raw) as Progress).report);
}
export interface IosArgs {
  db: AccountDb;
  source: string;
  media?: string;
  dryRun?: boolean;
  /** Explicit CLI selection; reset can reauthorize a source for the linked owner. */
  explicit?: boolean;
  reset?: boolean;
  /** Boot imports text before connecting; voice starts separately after connection. */
  textOnly?: boolean;
  /** A connected server leaves live-provider-owned notes to AccountVoice. */
  background?: boolean;
  skipFile?: string;
  settings?: TranscribeSettings;
  signal?: AbortSignal;
  /** Graceful stop: finish accepted uploads, but start no further work. */
  stopping?: () => boolean;
  transcriber?: (file: string) => Promise<Transcript>;
  afterChunk?: () => void | Promise<void>;
  /** Newly searchable words wake the service embedding feed without waiting for the archive. */
  afterTranscript?: () => void;
}
function fail(message: string): never {
  throw new WazapError("INVALID_ID", message);
}
function increment(counts: Record<string, number>, key: string): void {
  Object.defineProperty(counts, key, {
    value: (Object.hasOwn(counts, key) ? counts[key]! : 0) + 1,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
function canonical(db: AccountDb, value: string): string {
  return db.identity.canonicalJid(value);
}
function supportedType(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Object.hasOwn(TYPES, value);
}
function validJid(value: unknown): value is string {
  return (
    typeof value === "string" && /^[^\s_:@]+@(s\.whatsapp\.net|lid|g\.us)$/.test(value) && normalizeJid(value) === value
  );
}
function identity(db: AccountDb, r: Row): string | null {
  return validJid(r.chat) && typeof r.keyId === "string" && r.keyId && (r.fromMe === 0 || r.fromMe === 1)
    ? sidOf(r.fromMe === 1, canonical(db, r.chat), r.keyId)
    : null;
}
export function convertIosRow(db: AccountDb, r: Row, owner: string, collisions: Set<string>): MessageInput | string {
  if (typeof r.chat === "string" && r.chat.endsWith("@newsletter")) return "newsletter_sender";
  if (!validJid(r.chat)) return "invalid_chat";
  if (r.groupInfo !== null && (typeof r.groupInfo !== "number" || !Number.isSafeInteger(r.groupInfo)))
    return "group_relationship";
  if (r.chat.endsWith("@g.us") !== (r.groupInfo !== null)) return "group_relationship";
  if (r.fromMe !== 0 && r.fromMe !== 1) return "invalid_direction";
  if (typeof r.keyId !== "string" || !r.keyId || [...r.keyId].some((char) => char.charCodeAt(0) < 32))
    return "invalid_key";
  const sid = identity(db, r)!;
  if (collisions.has(sid)) return "identity_collision";
  const group = r.groupInfo !== null;
  const sender = r.fromMe === 1 ? owner : group ? r.sender : r.chat;
  if (!validJid(sender)) return group ? "missing_group_sender" : "invalid_sender";
  if (r.date === null || !Number.isFinite(r.date)) return "invalid_timestamp";
  const ts = Math.round(EPOCH + r.date * 1000);
  if (!Number.isSafeInteger(ts) || ts <= 0 || Math.floor(ts / 1000) > 2 ** 33 - 1) return "invalid_timestamp";
  if (!supportedType(r.nativeType)) return "invalid_type";
  const type = TYPES[r.nativeType]!;
  const text = [0, 7, 8].includes(r.nativeType) ? r.text : [1, 2, 11].includes(r.nativeType) ? r.caption : null;
  return {
    insertOnly: true,
    chatJid: canonical(db, r.chat),
    fromMe: r.fromMe === 1,
    keyId: r.keyId,
    senderJid: canonical(db, sender),
    ts,
    type,
    text: typeof text === "string" ? text : null,
    raw: null,
  };
}
/** Archive labels only fill gaps; live chat and contact labels keep their display precedence. */
function fillArchiveName(db: AccountDb, chatJid: string, name: string | null): void {
  const value = typeof name === "string" ? name.trim() : "";
  if (!value) return;
  let chat = db.identity.chat(chatJid);
  const hadChatName = Boolean(chat?.name?.trim());
  if (!hadChatName) chat = db.identity.upsertChat({ jid: chatJid, name: value });
  if (chat === null || chat.kind !== "direct" || hadChatName) return;
  const contact = db.identity.contact(chatJid);
  if (
    contact === null ||
    [contact.name, contact.notify, contact.pushName, contact.verifiedName].every((label) => !label?.trim())
  ) {
    db.identity.upsertContact({ jid: chatJid, name: value });
  }
}

function mediaFile(root: string, local: string): string | null {
  // iPhone paths are relative to Message/. A supplied Message directory is also accepted.
  if (isAbsolute(local) || local.split(/[\\/]/).includes("..")) return null;
  const base = realpathSync(root);
  for (const path of [resolve(base, "Message", local), resolve(base, local)]) {
    if (!existsSync(path)) continue;
    const real = realpathSync(path);
    const rel = relative(base, real);
    if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return real;
  }
  return null;
}

export async function importIos(args: IosArgs): Promise<IosReport> {
  const { db } = args;
  const owner = db.getMeta("owner");
  if (!validJid(owner)) fail("Link the target account before importing an iPhone archive.");
  if (args.reset && !args.explicit) fail("An archive reset requires explicit selection.");
  // Validate schema and snapshot before authorization or destructive progress changes.
  const sourceHandle = openIosSource(args.source);
  let scratch: ReturnType<typeof openScratch> | undefined;
  try {
    const sourceRead = <T>(read: () => T): T => {
      try {
        return read();
      } catch (error) {
        if (error instanceof IosSourceError) throw error;
        throw new IosSourceError("source_corrupt");
      }
    };
    const source = {
      prepare(sql: string) {
        const statement = sourceRead(() => sourceHandle.db.prepare(sql));
        return {
          all: (...params: SQLInputValue[]) => sourceRead(() => statement.all(...params)),
          get: (...params: SQLInputValue[]) => sourceRead(() => statement.get(...params)),
        };
      },
    };
    let progress = args.dryRun || args.reset ? null : (JSON.parse(db.getMeta(IOS_META) ?? "null") as Progress | null);
    const authorization = await authorizeIosArchive({
      db,
      source: args.source,
      explicit: args.explicit,
      reselect: args.reset,
      dryRun: args.dryRun,
      savedHash: progress?.hash ?? null,
      signal: args.signal,
      stopping: args.stopping,
    });
    const guard = () => {
      sourceHandle.assertCurrent();
      authorization.assertCurrent();
    };
    const stopped = () => args.signal?.aborted || args.stopping?.();
    const check = () => {
      guard();
      if (stopped())
        throw new WazapError("SERVICE_ERROR", "iPhone import stopped; the last committed chunk will resume.");
    };
    const pause = async () => {
      await yieldLoop();
      check();
    };
    check();
    if (args.reset && !args.dryRun) {
      guard();
      db.transaction(() => {
        db.setMeta(IOS_META, null);
        db.setMeta(IOS_ERROR, null);
        db.setMeta(IOS_VOICE_TARGETS, null);
      });
      // Only importer-owned pages are removed, in bounded transactions.
      let cursor = "";
      for (;;) {
        const pages = db.scanMeta("ios_import_v2:", cursor, 500);
        if (!pages.length) break;
        guard();
        db.transaction(() => db.deleteMetaKeys(pages.map((p) => p.key)));
        cursor = pages.at(-1)!.key;
        await pause();
      }
    }
    const report: IosReport = boundedReport(
      progress?.report ?? {
        state: "rows",
        sourceRows: 0,
        sourceByType: {},
        inserted: 0,
        skippedExisting: 0,
        skippedByType: {},
        skippedByBarrier: {},
        quarantined: 0,
        quarantineReasons: {},
        voice: { transcribed: 0, skipped: 0, missing: 0, failed: 0 },
      }
    );
    const generation = progress?.generation ?? randomUUID();
    const prefix = `ios_import_v2:${generation}:`;
    let last = progress?.last ?? 0;
    let replyCursor = progress?.replyCursor ?? "";
    let voiceTerminalFailures = progress?.voiceTerminalFailures ?? Object.keys(progress?.voiceFailureRows ?? {}).length;
    const checkpoint = () => {
      guard();
      db.setMeta(
        IOS_META,
        JSON.stringify({
          format: 2,
          hash: authorization.hash,
          generation,
          last,
          replyCursor,
          voiceTerminalFailures,
          report,
          voiceBindings: bindingCapture ? 2 : undefined,
        })
      );
    };
    type VoiceEntry = { id?: number; failure?: string; collision?: boolean };
    const voiceKey = (pk: number) => `${prefix}voice:${String(Math.floor(pk / 500)).padStart(20, "0")}`;
    const getVoicePage = (pk: number): Record<string, VoiceEntry> => JSON.parse(db.getMeta(voiceKey(pk)) ?? "{}");
    const putVoice = (pk: number, patch: VoiceEntry) => {
      const page = getVoicePage(pk);
      page[String(pk)] = { ...page[String(pk)], ...patch };
      db.setMeta(voiceKey(pk), JSON.stringify(page));
    };
    const legacyBindings = progress?.voiceBindings === 1 ? db.getMeta(IOS_VOICE_TARGETS) : null;
    const bindingCapture =
      progress === null || progress.voiceBindings === 2 || (progress.voiceBindings === 1 && legacyBindings !== null);
    if (
      progress?.format === 2 &&
      (JSON.stringify(progress.report.sourceByType) !== JSON.stringify(report.sourceByType) ||
        JSON.stringify(progress.report.skippedByType) !== JSON.stringify(report.skippedByType))
    ) {
      // Also repair preexisting v2 counters before a completed-import early return.
      guard();
      db.transaction(checkpoint);
    }
    const terminal = report.state === "voice" || report.state === "done";
    if (progress !== null && progress.format !== 2) {
      // SID spellings can redirect after folds. Legacy tasks without an original
      // row ID cannot prove that the current child is still importer-owned.
      if ((progress.replies ?? []).some((task) => !Number.isSafeInteger(task.id) || task.id! <= 0)) {
        guard();
        db.setMeta(IOS_ERROR, "legacy_reply_bindings_missing");
        return report;
      }
      if (terminal && progress.collisionRows === undefined && report.quarantineReasons.identity_collision > 0) {
        guard();
        db.setMeta(IOS_ERROR, "voice_collision_exclusions_missing");
        return report;
      }
      if (terminal && progress.voiceFailureRows === undefined && Object.keys(progress.voiceFailures ?? {}).length > 0) {
        guard();
        db.setMeta(IOS_ERROR, "voice_failure_exclusions_missing");
        return report;
      }
      // Legacy metadata was one JSON value. Parsing it once is the explicit migration exception.
      const targets: Record<string, number> = JSON.parse(legacyBindings ?? "{}");
      const keys = new Set([
        ...Object.keys(targets),
        ...Object.keys(progress.voiceFailureRows ?? {}),
        ...(progress.collisionRows ?? []).map(String),
      ]);
      const legacyCollisions = new Set(progress.collisionRows ?? []);
      let batch: string[] = [];
      const migrate = () =>
        db.transaction(() => {
          guard();
          for (const pk of batch)
            putVoice(Number(pk), {
              id: targets[pk],
              failure: progress!.voiceFailureRows?.[pk],
              collision: legacyCollisions.has(Number(pk)) || undefined,
            });
        });
      for (const pk of keys) {
        batch.push(pk);
        if (batch.length === 500) {
          migrate();
          batch = [];
          await pause();
        }
      }
      if (batch.length) migrate();
      const legacyReplies = progress.replies ?? [];
      for (let start = 0; start < legacyReplies.length; start += 500) {
        guard();
        db.transaction(() => {
          for (let index = start; index < Math.min(start + 500, legacyReplies.length); index++) {
            const task = legacyReplies[index]!;
            db.setMeta(`${prefix}reply:${String(index).padStart(20, "0")}`, JSON.stringify(task));
          }
        });
        await pause();
      }
      guard();
      db.transaction(() => {
        checkpoint();
        db.setMeta(IOS_VOICE_TARGETS, null);
      });
      // Drop the one-time legacy JSON maps after publishing the paged generation.
      progress = null;
    }
    if (terminal && !bindingCapture && !args.textOnly && args.media && report.sourceByType["3"]) {
      guard();
      db.setMeta(IOS_ERROR, "voice_target_bindings_missing");
      return report;
    }
    if (terminal && !args.dryRun) {
      let cursor = 0;
      const names = source.prepare(
        "SELECT Z_PK pk,ZCONTACTJID chat,ZPARTNERNAME name FROM ZWACHATSESSION WHERE Z_PK>? ORDER BY Z_PK LIMIT 500"
      );
      for (;;) {
        check();
        const entries = names.all(cursor);
        if (!entries.length) break;
        guard();
        db.transaction(() => {
          for (const entry of entries)
            if (validJid(entry.chat) && db.identity.chat(canonical(db, entry.chat)) !== null)
              fillArchiveName(db, entry.chat, entry.name as string | null);
        });
        cursor = entries.at(-1)!.pk as number;
        await pause();
      }
    }
    if (terminal && (args.textOnly || !args.media)) return report;
    // All source-scale indexes live on disk with a fixed SQLite cache.
    scratch = openScratch();
    if (!terminal) {
      const identities = source.prepare(
        "SELECT m.Z_PK pk,m.ZISFROMME fromMe,m.ZSTANZAID keyId,c.ZCONTACTJID chat FROM ZWAMESSAGE m LEFT JOIN ZWACHATSESSION c ON c.Z_PK=m.ZCHATSESSION WHERE m.Z_PK>? ORDER BY m.Z_PK LIMIT 500"
      );
      let cursor = 0;
      for (;;) {
        check();
        const rows = identities.all(cursor) as unknown as Row[];
        if (!rows.length) break;
        scratch.db.exec("BEGIN");
        try {
          for (const row of rows) {
            const sid = identity(db, row);
            if (sid !== null) scratch.identity.run(row.pk, sid);
          }
          scratch.db.exec("COMMIT");
        } catch (err) {
          scratch.db.exec("ROLLBACK");
          throw err;
        }
        cursor = rows.at(-1)!.pk;
        await pause();
      }
    }
    let mediaCursor = 0;
    const mediaPage = source.prepare(
      "SELECT Z_PK pk,ZMESSAGE message,ZTITLE caption,ZMEDIALOCALPATH path FROM ZWAMEDIAITEM WHERE Z_PK>? ORDER BY Z_PK LIMIT 500"
    );
    for (;;) {
      check();
      const rows = mediaPage.all(mediaCursor);
      if (!rows.length) break;
      scratch.db.exec("BEGIN");
      try {
        for (const row of rows)
          if (typeof row.message === "number" && Number.isSafeInteger(row.message))
            scratch.media.run(
              row.message,
              typeof row.caption === "string" ? row.caption : null,
              typeof row.path === "string" ? row.path : null
            );
        scratch.db.exec("COMMIT");
      } catch (err) {
        scratch.db.exec("ROLLBACK");
        throw err;
      }
      mediaCursor = rows.at(-1)!.pk as number;
      await pause();
    }
    const enrich = (row: Row): Row =>
      Object.assign(row, scratch!.getMedia.get(row.pk) ?? { caption: null, mediaPath: null });
    const collisions = new Set<string>();
    // Resolve collision membership using the SID captured during preparation,
    // so later canonicalization cannot hide either member of a source collision.
    const collisionByPk = scratch.db.prepare(
      "SELECT 1 FROM identities i JOIN identities twin ON twin.sid=i.sid WHERE i.pk=? AND twin.pk<>i.pk LIMIT 1"
    );
    const isCollision = (row: Row) => collisionByPk.get(row.pk) !== undefined;
    const parent = source.prepare(`${SELECT} WHERE m.Z_PK=?`);
    const parentSid = (pk: unknown) => {
      if (typeof pk !== "number" || !Number.isSafeInteger(pk)) return null;
      const row = parent.get(pk) as unknown as Row | undefined;
      return row === undefined ? null : identity(db, row);
    };
    const page = source.prepare(`${SELECT} WHERE m.Z_PK>? ORDER BY m.Z_PK LIMIT 500`);
    while (report.state === "rows") {
      check();
      const rows = page.all(last) as unknown as Row[];
      if (!rows.length) break;
      const apply = () => {
        guard();
        // At most 500 source rows are held by this chunk.
        const voicePages = new Map<string, Record<string, VoiceEntry>>();
        const capture = (pk: number, entry: VoiceEntry) => {
          const key = voiceKey(pk);
          let value = voicePages.get(key);
          if (!value) {
            value = getVoicePage(pk);
            voicePages.set(key, value);
          }
          value[String(pk)] = { ...value[String(pk)], ...entry };
        };
        for (const raw of rows) {
          const r = enrich(raw);
          report.sourceRows++;
          increment(report.sourceByType, reportType(r.nativeType));
          if (!supportedType(r.nativeType)) {
            increment(report.skippedByType, reportType(r.nativeType));
            continue;
          }
          const collision = isCollision(r);
          const input = collision ? "identity_collision" : convertIosRow(db, r, owner, collisions);
          if (typeof input === "string") {
            report.quarantined++;
            increment(report.quarantineReasons, input);
            if (!args.dryRun && collision) capture(r.pk, { collision: true });
            continue;
          }
          if (args.dryRun) {
            const chat = db.identity.chat(input.chatJid);
            if (chat && db.identity.findByKey(chat, input.fromMe, input.keyId)) report.skippedExisting++;
            else if (chat?.clearedThroughTs != null && input.ts <= chat.clearedThroughTs)
              increment(report.skippedByBarrier, "cleared");
            else report.inserted++;
            continue;
          }
          const psid = parentSid(r.parent);
          if (psid !== null && db.messages.get(psid) !== null) input.quotedSid = psid;
          fillArchiveName(db, input.chatJid, r.name);
          const result = db.messages.upsert(input);
          if (
            bindingCapture &&
            r.nativeType === 3 &&
            result.id !== null &&
            result.sid !== null &&
            db.messages.get(result.sid)?.type === "voice" &&
            (result.outcome === "inserted" || result.outcome === "existing")
          )
            capture(r.pk, { id: result.id });
          if (result.outcome === "inserted") {
            report.inserted++;
            if (
              typeof r.parent === "number" &&
              input.quotedSid === undefined &&
              result.id !== null &&
              result.sid !== null
            )
              db.setMeta(
                `${prefix}reply:${String(r.pk).padStart(20, "0")}`,
                JSON.stringify({ child: result.sid, id: result.id, parent: r.parent })
              );
          } else if (result.outcome === "existing") report.skippedExisting++;
          else increment(report.skippedByBarrier, result.outcome);
        }
        last = rows.at(-1)!.pk;
        if (!args.dryRun) {
          for (const [key, value] of voicePages) db.setMeta(key, JSON.stringify(value));
          checkpoint();
        }
      };
      if (args.dryRun) apply();
      else db.transaction(apply);
      await args.afterChunk?.();
      await pause();
    }
    if (args.dryRun) return report;
    if (report.state === "rows" || report.state === "replies") {
      report.state = "replies";
      for (;;) {
        check();
        const tasks = db.scanMeta(`${prefix}reply:`, replyCursor, 500);
        if (!tasks.length) break;
        guard();
        db.transaction(() => {
          for (const task of tasks) {
            const reply = JSON.parse(task.value) as { child: string; id: number; parent: number };
            const child = db.messages.get(reply.child);
            const psid = parentSid(reply.parent);
            if (
              child !== null &&
              child.id === reply.id &&
              child.quotedSid === null &&
              psid !== null &&
              db.messages.get(psid) !== null
            )
              db.messages.upsert({
                chatJid: child.chatJid,
                fromMe: child.fromMe,
                keyId: child.keyId,
                senderJid: child.senderJid,
                ts: child.ts,
                type: child.type,
                quotedSid: psid,
              });
          }
          replyCursor = tasks.at(-1)!.key;
          db.deleteMetaKeys(tasks.map((t) => t.key));
          checkpoint();
        });
        await pause();
      }
      report.state = "voice";
      checkpoint();
    }
    if (args.textOnly) {
      report.state = report.sourceByType["3"] ? "voice" : "done";
      checkpoint();
      return report;
    }
    if (args.media && !bindingCapture && report.sourceByType["3"]) {
      guard();
      db.setMeta(IOS_ERROR, "voice_target_bindings_missing");
      return report;
    }
    report.state = "voice";
    checkpoint();
    const transcriber =
      args.transcriber ??
      (args.settings?.provider
        ? (file: string) => transcribeFile(args.settings!, file, { signal: args.signal })
        : null);
    if (args.media && transcriber) {
      const skipPath = args.skipFile ?? join(dirname(args.source), "voice-skip.txt");
      if (!existsSync(skipPath)) {
        log("iPhone voice import paused: voice-skip.txt is missing; an empty file explicitly permits all chats.");
        return report;
      }
      const skip = new Set(
        readFileSync(skipPath, "utf8")
          .split(/\r?\n/)
          .map((x) => canonical(db, x.trim()))
          .filter(Boolean)
      );
      report.voice.skipped = 0;
      report.voice.missing = 0;
      report.voice.failed = voiceTerminalFailures;
      // Page by the raw primary key before filtering. Sparse voices must not
      // turn one synchronous source read into an archive-wide scan.
      const voicePage = source.prepare(`${SELECT} WHERE m.Z_PK>? ORDER BY m.Z_PK LIMIT 500`);
      let cursor = 0;
      let retryable = false;
      let paused = false;
      let dispatchFailed = false;
      for (;;) {
        if (stopped() || paused) break;
        guard();
        const sourceRows = voicePage.all(cursor) as unknown as Row[];
        if (!sourceRows.length) break;
        const voices = sourceRows.filter((row) => row.nativeType === 3);
        let next = 0;
        const settled = await Promise.allSettled(
          Array.from({ length: 3 }, async () => {
            try {
              while (next < voices.length) {
                if (stopped() || paused || dispatchFailed) return;
                guard();
                const r = enrich(voices[next++]!);
                const binding = getVoicePage(r.pk)[String(r.pk)];
                if (binding?.collision) continue;
                const input = convertIosRow(db, r, owner, collisions);
                if (typeof input === "string") continue;
                const sid = identity(db, r)!;
                const message = db.messages.get(sid);
                const targetId = binding?.id;
                if (binding?.failure) continue;
                if (
                  targetId === undefined ||
                  message === null ||
                  message.id !== targetId ||
                  message.type !== "voice" ||
                  message.transcript !== null ||
                  (args.background && (message.raw !== null || db.transcripts.state(sid)?.state === "queued")) ||
                  skip.has(input.chatJid)
                ) {
                  report.voice.skipped++;
                  continue;
                }
                const file = typeof r.mediaPath === "string" ? mediaFile(args.media!, r.mediaPath) : null;
                if (file === null) {
                  report.voice.missing++;
                  continue;
                }
                // Once an upload is accepted, persist its result even during graceful shutdown.
                guard();
                let result: Transcript;
                try {
                  result = await transcriber(file);
                } catch (err) {
                  guard();
                  if (!stopped()) {
                    const failure = classifyFailure(err);
                    guard();
                    db.transaction(() => {
                      if (failure.kind === "permanent" || failure.kind === "gone") {
                        putVoice(r.pk, { failure: failure.kind });
                        voiceTerminalFailures++;
                      } else retryable = true;
                      if (failure.kind === "paused") paused = true;
                      report.voice.failed++;
                      checkpoint();
                    });
                  }
                  continue;
                }
                const persisted = db.transaction(() => {
                  guard();
                  const latest = db.messages.get(sid);
                  if (
                    latest === null ||
                    latest.id !== targetId ||
                    latest.type !== "voice" ||
                    latest.transcript !== null ||
                    (args.background && (latest.raw !== null || db.transcripts.state(sid)?.state === "queued"))
                  )
                    return false;
                  return db.messages.setTranscript(sid, result.text, {
                    provider: args.settings?.provider ?? "imported",
                    at: Date.now(),
                    ...result,
                  });
                });
                if (persisted) report.voice.transcribed++;
                else report.voice.skipped++;
                checkpoint();
                if (persisted) args.afterTranscript?.();
              }
            } catch (error) {
              // All accepted lanes still drain, but none may dispatch new work.
              dispatchFailed = true;
              throw error;
            }
          })
        );
        const rejected = settled.find((r) => r.status === "rejected");
        if (rejected?.status === "rejected") throw rejected.reason;
        cursor = sourceRows.at(-1)!.pk;
        await yieldLoop();
        guard();
      }
      if (retryable || paused || stopped()) {
        checkpoint();
        return report;
      }
    }
    report.state = stopped() ? "voice" : "done";
    checkpoint();
    return report;
  } finally {
    try {
      scratch?.close();
    } finally {
      sourceHandle.close();
    }
  }
}
