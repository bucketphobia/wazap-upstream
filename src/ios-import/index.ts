/** iPhone archive import: read-only source, ordinary insert-only rows, atomic checkpoints. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { type AccountDb, type MessageInput, normalizeJid, sidOf } from "../db/index.js";
import { openScratch } from "./scratch.js";
import { openIosSource, IosSourceError } from "./source.js";
import type { SQLInputValue } from "../db/sqlite.js";
import {
  classifyFailure,
  PROVIDERS,
  transcribeFile,
  type Failure,
  type TranscribeSettings,
  type Transcript,
} from "../transcribe/index.js";
import { ANSWER_UNREADABLE, FILE_UNREADABLE, TIMED_OUT } from "../transcribe/openai.js";
import { WazapError } from "../errors.js";
import { log } from "../logger.js";
import { authorizeIosArchive, IOS_BARRIER, type Stamp } from "./binding.js";

export const IOS_META = "ios_import_v1";
export const IOS_ERROR = "ios_import_error";
/** Imported rows carry no expiry, so strict retention cannot be honoured. */
export const IOS_RETENTION_REFUSED = "iPhone import cannot honour WAZAP_RETENTION=1: imported messages would never expire.";
export const IOS_CHECKPOINT_UNSUPPORTED = "The saved iPhone import progress is in an unsupported format.";
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
/** A note that fails for its own sake is tried this many times (once per run), then stored as failed. */
const NOTE_ATTEMPTS = 3;
/**
 * Archive type 3 may hold audio files as well as voice notes, and the archive says which only by length.
 * An API provider gets notes of at most this long (the rule of AUTO_TRANSCRIBE_MAX_SECONDS in service/voice.ts).
 */
const API_MAX_SECONDS = 600;
/** Notes the first part of a run may fail for their own sake before the run is taken to be broken, not the notes. */
const BROKEN_RUN_FAULTS = 3;
/** Runs in a row that stop that way before the notes, not the host, are taken to be the cause. */
const BROKEN_RUNS = 3;
const EPOCH = Date.UTC(2001, 0, 1);
const SELECT = `SELECT m.Z_PK pk,m.ZMESSAGETYPE nativeType,m.ZISFROMME fromMe,m.ZSTANZAID keyId,
 m.ZMESSAGEDATE date,m.ZTEXT text,m.ZPARENTMESSAGE parent,
 c.ZCONTACTJID chat,c.ZGROUPINFO groupInfo,c.ZPARTNERNAME name,g.ZMEMBERJID sender,
 NULL caption,NULL mediaPath,NULL duration
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
  duration: number | null;
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
  /** Original target bindings were captured from the first text chunk. */
  voiceBindings?: 2;
  format?: 2;
  generation?: string;
  replyCursor?: string;
  voiceTerminalFailures?: number;
  /** Source file stamp; a finished import with the same stamp is not hashed again. */
  stamp?: Stamp;
  /** The voice pass ran to its end; a later run does not repeat it (--reset does). A background pass does not stand for an explicit one. */
  voicePass?: true | "background";
  /** Consecutive runs that stopped on three held failures with no success; the third and later charge them. */
  heldRuns?: number;
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
  /** An explicit run with an API provider tells its caller what it will send, once, before the first upload. */
  announce?: (notes: number, provider: string) => void;
  /** WAZAP_RETENTION: the importer stores no expiry, so it refuses to run at all. */
  retention?: boolean;
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
  if (args.retention) fail(IOS_RETENTION_REFUSED);
  // A folder drop never sends archive voice to an API provider: only `wazap import ios --media` does.
  const api = args.settings?.provider != null && PROVIDERS[args.settings.provider].kind === "api";
  const apiBackground = args.background === true && api;
  // Whisper crashing or timing out belongs to the note; an API busy or unreachable belongs to the provider.
  // An API that times out on a note is both: the note is charged and the pass stops, so it is not re-sent at once.
  const apiTimeout = (failure: Failure) => api && failure.kind === "transient" && failure.reason === TIMED_OUT;
  const noteFault = (failure: Failure) =>
    failure.kind === "transient" && (!api || failure.reason === ANSWER_UNREADABLE || failure.reason === FILE_UNREADABLE || apiTimeout(failure));
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
    const progress = args.dryRun || args.reset ? null : (JSON.parse(db.getMeta(IOS_META) ?? "null") as Progress | null);
    const authorization = await authorizeIosArchive({
      db,
      source: args.source,
      explicit: args.explicit,
      reselect: args.reset,
      dryRun: args.dryRun,
      savedHash: progress?.hash ?? null,
      savedStamp: progress?.report.state === "done" || progress?.report.state === "voice" ? progress.stamp : null,
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
    // No release wrote another format, so an unknown checkpoint cannot prove what it owns: reset or nothing.
    if (progress !== null && progress.format !== 2)
      throw new WazapError(
        "INVALID_ID",
        IOS_CHECKPOINT_UNSUPPORTED,
        "Run wazap import ios <ChatStorage.sqlite> --reset after confirming the archive belongs to the linked account."
      );
    if (args.reset && !args.dryRun) {
      guard();
      db.transaction(() => {
        db.setMeta(IOS_META, null);
        db.setMeta(IOS_ERROR, null);
        db.setMeta(IOS_BARRIER, null);
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
    let voiceTerminalFailures = progress?.voiceTerminalFailures ?? 0;
    let voicePass = progress?.voicePass;
    let heldRuns = progress?.heldRuns ?? 0;
    const checkpoint = () => {
      guard();
      db.setMeta(
        IOS_META,
        JSON.stringify({
          format: 2,
          hash: authorization.hash,
          stamp: authorization.stamp,
          generation,
          last,
          replyCursor,
          voiceTerminalFailures,
          voicePass: voicePass || undefined,
          heldRuns: heldRuns || undefined,
          report,
          voiceBindings: bindingCapture ? 2 : undefined,
        })
      );
    };
    type VoiceEntry = { id?: number; failure?: string; collision?: boolean; attempts?: number };
    const voiceKey = (pk: number) => `${prefix}voice:${String(Math.floor(pk / 500)).padStart(20, "0")}`;
    const getVoicePage = (pk: number): Record<string, VoiceEntry> => JSON.parse(db.getMeta(voiceKey(pk)) ?? "{}");
    const putVoice = (pk: number, patch: VoiceEntry) => {
      const page = getVoicePage(pk);
      page[String(pk)] = { ...page[String(pk)], ...patch };
      db.setMeta(voiceKey(pk), JSON.stringify(page));
    };
    const bindingCapture = progress === null || progress.voiceBindings === 2;
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
    if (terminal && !bindingCapture && !args.textOnly && !apiBackground && args.media && report.sourceByType["3"]) {
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
    if (
      terminal &&
      (args.textOnly ||
        apiBackground ||
        !args.media ||
        (report.state === "done" && (voicePass === true || (args.background && voicePass))))
    )
      return report;
    // All source-scale indexes live on disk with a fixed SQLite cache.
    scratch = openScratch(dirname(db.path));
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
    // The length column is optional in the archive; without it no note has a known length.
    const lengthColumn = source
      .prepare("PRAGMA table_info(ZWAMEDIAITEM)")
      .all()
      .some((column) => String(column.name).toUpperCase() === "ZMOVIEDURATION");
    const mediaPage = source.prepare(
      `SELECT Z_PK pk,ZMESSAGE message,ZTITLE caption,ZMEDIALOCALPATH path,${lengthColumn ? "ZMOVIEDURATION" : "NULL"} duration FROM ZWAMEDIAITEM WHERE Z_PK>? ORDER BY Z_PK LIMIT 500`
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
              typeof row.path === "string" ? row.path : null,
              typeof row.duration === "number" && Number.isFinite(row.duration) ? row.duration : null
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
      Object.assign(row, scratch!.getMedia.get(row.pk) ?? { caption: null, mediaPath: null, duration: null });
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
    if (args.textOnly || apiBackground) {
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
    if (args.media && !transcriber)
      throw new WazapError(
        "INVALID_ID",
        "Voice transcription was requested but no usable provider is available, so no voice was imported.",
        "Enable a provider in the voice settings (and WAZAP_TRANSCRIBE_ALLOW_API=1 for a read-only account using an API), then rerun"
      );
    if (args.media && transcriber) {
      const skipPath = args.skipFile ?? join(dirname(args.source), "voice-skip.txt");
      if (!existsSync(skipPath)) {
        // A folder drop waits for the owner's file; a command the owner typed refuses.
        if (!args.background)
          throw new WazapError(
            "INVALID_ID",
            "voice-skip.txt is missing, so no voice was imported.",
            "Create voice-skip.txt beside the archive (empty to permit every chat), then rerun"
          );
        log("iPhone voice import paused: voice-skip.txt is missing; an empty file explicitly permits all chats.");
        return report;
      }
      // An unreadable line, or one naming no chat, must never leave its chat eligible: stop before any upload.
      const listed = new Map<string, number>();
      readFileSync(skipPath, "utf8")
        .split(/\r?\n/)
        .forEach((line, index) => {
          const jid = line.trim();
          if (jid === "") return;
          if (!validJid(jid))
            throw new WazapError(
              "INVALID_ID",
              `voice-skip.txt line ${index + 1} is not an exact chat JID, so no voice was imported.`,
              "Write one JID per line, such as 40700000002@s.whatsapp.net, or remove the line"
            );
          if (!listed.has(canonical(db, jid))) listed.set(canonical(db, jid), index + 1);
        });
      if (listed.size) {
        const known = new Set<string>();
        const chats = source.prepare(
          "SELECT Z_PK pk,ZCONTACTJID chat FROM ZWACHATSESSION WHERE Z_PK>? ORDER BY Z_PK LIMIT 500"
        );
        for (let cursor = 0; ; ) {
          const rows = chats.all(cursor);
          if (!rows.length) break;
          for (const row of rows) if (validJid(row.chat)) known.add(canonical(db, row.chat));
          cursor = rows.at(-1)!.pk as number;
        }
        for (const [jid, line] of listed)
          if (!known.has(jid))
            throw new WazapError(
              "INVALID_ID",
              `voice-skip.txt line ${line} matches no chat in the archive, so no voice was imported.`,
              "Check the number, or remove the line"
            );
      }
      const skip = new Set(listed.keys());
      report.voice.skipped = 0;
      report.voice.missing = 0;
      report.voice.failed = voiceTerminalFailures;
      // What one note needs before it is sent: undefined to ignore it silently, a word to count it, else the work.
      const candidate = (r: Row) => {
        const binding = getVoicePage(r.pk)[String(r.pk)];
        if (binding?.collision || binding?.failure) return undefined;
        const input = convertIosRow(db, r, owner, collisions);
        if (typeof input === "string") return undefined;
        const sid = identity(db, r)!;
        const message = db.messages.get(sid);
        const targetId = binding?.id;
        if (
          targetId === undefined ||
          message === null ||
          message.id !== targetId ||
          message.type !== "voice" ||
          message.transcript !== null ||
          (args.background && (message.raw !== null || db.transcripts.state(sid)?.state === "queued")) ||
          skip.has(input.chatJid) ||
          // An archive audio file looks like a voice note; only its length tells, so an API gets short notes only.
          (api && !(r.duration !== null && r.duration > 0 && r.duration <= API_MAX_SECONDS))
        )
          return "skipped";
        const file = typeof r.mediaPath === "string" ? mediaFile(args.media!, r.mediaPath) : null;
        return file === null ? "missing" : { sid, targetId, file };
      };
      // Page by the raw primary key before filtering. Sparse voices must not
      // turn one synchronous source read into an archive-wide scan.
      const voicePage = source.prepare(`${SELECT} WHERE m.Z_PK>? ORDER BY m.Z_PK LIMIT 500`);
      if (api && args.announce) {
        let notes = 0;
        for (let cursor = 0; ; ) {
          const sourceRows = voicePage.all(cursor) as unknown as Row[];
          if (!sourceRows.length) break;
          for (const row of sourceRows)
            if (row.nativeType === 3 && typeof candidate(enrich(row)) === "object") notes++;
          cursor = sourceRows.at(-1)!.pk;
          await pause();
        }
        if (notes > 0) args.announce(notes, args.settings!.provider!);
      }
      let cursor = 0;
      let paused = false;
      let retry = false; // a note failed for its own sake and has attempts left: the pass is not finished
      // Until one note succeeds in this run, a note's own failure may be the host's (a full temp disk, whisper killed
      // for memory), so it is held, not charged. Three of them with no success pause the pass and charge nothing,
      // until that has happened in three runs in a row: then the notes are the cause, and they are charged.
      let succeeded = false;
      let held: number[] = [];
      const charge = (pk: number) => {
        const attempts = (getVoicePage(pk)[String(pk)]?.attempts ?? 0) + 1;
        if (attempts < NOTE_ATTEMPTS) {
          putVoice(pk, { attempts });
          retry = true;
        } else {
          putVoice(pk, { attempts, failure: "attempts" });
          voiceTerminalFailures++;
        }
      };
      const chargeHeld = () => {
        if (!held.length) return;
        guard();
        db.transaction(() => {
          for (const pk of held) charge(pk);
          checkpoint();
        });
        held = [];
      };
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
                const work = candidate(r);
                if (work === undefined) continue;
                if (work === "skipped" || work === "missing") {
                  report.voice[work]++;
                  continue;
                }
                const { sid, targetId, file } = work;
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
                      } else if (!noteFault(failure)) paused = true; // the provider is failing: start no further uploads this run
                      else if (apiTimeout(failure)) {
                        charge(r.pk);
                        paused = true;
                      } else if (succeeded) charge(r.pk);
                      else {
                        held.push(r.pk);
                        if (held.length >= BROKEN_RUN_FAULTS) {
                          paused = true;
                          if (++heldRuns >= BROKEN_RUNS) for (const pk of held) charge(pk);
                          else log("iPhone voice import paused: the first notes of this run all failed, so no attempt is charged to them.");
                          held = []; // a note that succeeds after this must not charge them
                        }
                      }
                      report.voice.failed++;
                      checkpoint();
                    });
                  }
                  continue;
                }
                if (!succeeded) {
                  succeeded = true;
                  heldRuns = 0;
                  chargeHeld();
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
      // Fewer than three held failures with no success: a short run, so they are the notes' own.
      if (!paused && !stopped()) chargeHeld();
      if (paused || retry || stopped()) {
        checkpoint();
        return report;
      }
      // A background pass leaves live-provider notes alone, so it does not stand for an explicit one.
      voicePass = args.background ? (voicePass ?? "background") : true;
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
