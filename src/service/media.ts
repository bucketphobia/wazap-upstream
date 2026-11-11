/**
 * A message's media for the account's tools: get_media's download to a
 * directory, and the small JPEG previews a read shows, made once and kept as
 * files the database knows. Part of WhatsAppService (src/whatsapp.ts), which
 * keeps the download itself (mediaBuffer), where tests replace it, and lends
 * it through MediaHost.
 */

import type { WAMessage, WASocket } from "baileys";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { throwIfCancelled } from "../cancel.js";
import { WazapError } from "../errors.js";
import { logError } from "../logger.js";
import { mediaFilename } from "../outgoing-media.js";
import { tinyThumbnail, videoFrame } from "../previews.js";
import { loadSharp, previewImage } from "../images.js";
import { isLottieSticker, mediaInfo, thumbnailOf } from "../messages.js";
import { DIR_MODE, FILE_MODE } from "./util.js";
import { sidTag } from "../media-links.js";
import { renderMedia } from "../media-render.js";
import { which } from "../transcribe/local.js";
import type { ConnectionStatus, MediaOpenOptions, MediaResult, OpenedMedia, Preview } from "../wa-types.js";
import type { AccountPaths } from "../config.js";
import type { AccountStorage } from "./storage.js";
import type { MessageViews } from "./views.js";

/**
 * A photo bigger than this is not downloaded for a preview: the keep limit's
 * default, since sharp shrinks a 16 MB photo in tens of milliseconds off the
 * event loop. Without sharp, jpeg-js decodes on the event loop, and only up to
 * the old 6 MB.
 */
const PREVIEW_SOURCE_MAX_BYTES = 16_000_000;
const PREVIEW_SOURCE_MAX_BYTES_JS = 6_000_000;

/** A video bigger than this is not downloaded for a frame. */
const PREVIEW_VIDEO_MAX_BYTES = 25_000_000;

/**
 * How long one call may spend downloading and shrinking photos before it
 * returns with what it has: no download starts past it, and none waits for a
 * slot in the download budget beyond it.
 */
const PREVIEW_BUDGET_MS = 20_000;

/**
 * How long a message whose media downloaded but made no preview (a HEIC
 * without sips, a format nothing here reads) is not downloaded again for one,
 * and how many such messages are remembered.
 */
const NO_PREVIEW_MS = 60 * 60_000;
const NO_PREVIEW_MAX = 1_000;

/** A file that is not there, as opposed to one that could not be read. */
function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** A message id as a file name: the characters no file system takes become underscores. */
function safeFilename(jid: string): string {
  return jid.replace(/[/\\:*?"<>|]/g, "_");
}

/** What the service lends media: the socket, the download, and whether a message is still there, read at each call. */
export interface MediaHost {
  status(): ConnectionStatus;
  sock(): WASocket | null;
  guarded<T>(work: () => Promise<T>): Promise<T>;
  ensureConnected(): WASocket;
  hasMessage(id: string): boolean;
  /**
   * The bytes behind a message's media, from WhatsApp; `reupload` asks the
   * phone again for expired media, `signal` stops the download, and `waitMs`
   * shortens its wait for a slot in the download budget.
   */
  mediaBuffer(sock: WASocket, messageId: string, raw: WAMessage, opts?: { reupload?: boolean; signal?: AbortSignal; waitMs?: number }): Promise<Buffer>;
  /** The kept copy of a message's media, or null (src/service/keep.ts). */
  keptMedia(messageId: string, raw: WAMessage): Promise<Buffer | null>;
  /** WhatsApp's copy, just downloaded: kept too when the kept-media settings want it. */
  offerKept(messageId: string, raw: WAMessage, buffer: Buffer): Promise<void>;
}

export class AccountMedia {
  /** Messages whose downloaded media made no preview, and when: each read would otherwise download them again. */
  private readonly noPreview = new Map<string, number>();

  constructor(
    private readonly host: MediaHost,
    private readonly views: MessageViews,
    private readonly storage: AccountStorage,
    private readonly paths: AccountPaths
  ) {}

  /**
   * Small JPEGs of these messages' photos, in the order given, at most `max`.
   * A preview made earlier comes first. A tiny shipped thumbnail is upgraded
   * from the original (the kept copy first, even with the link down), once,
   * within a time budget so the call returns with what it has. A photo that
   * has expired, is too big, or that nothing here reads (without sharp: not a
   * JPEG) simply has no preview; one that downloaded and made none is not
   * downloaded again for an hour. A read its client cancelled (`signal`)
   * stops waiting for a download slot, the download, the frame grab or the
   * shrink, and fails with the cancellation, which nobody reads: what it
   * would answer is thrown away, and its in-flight slot comes back sooner.
   */
  previews(messageIds: string[], max: number, signal?: AbortSignal): Promise<Preview[]> {
    return this.host.guarded(async () => {
      const out: Preview[] = [];
      const started = Date.now();
      const sharp = (await loadSharp()) !== null;
      for (const sid of messageIds) {
        if (out.length >= max) break;
        throwIfCancelled(signal);
        const message = this.storage.readyDb()?.messages.get(sid) ?? null;
        const raw = message === null ? null : this.views.rawOf(message);
        if (!raw) continue;
        const shipped = thumbnailOf(raw);
        const cached = await this.readPreview(sid);
        if (!this.host.hasMessage(sid)) continue;
        if (cached) {
          out.push({ message_id: sid, mime: "image/jpeg", base64: cached.toString("base64") });
          continue;
        }
        if (shipped && !tinyThumbnail(Buffer.from(shipped.base64, "base64"))) {
          out.push({ message_id: sid, ...shipped });
          continue;
        }
        let chosen = shipped;
        const info = mediaInfo(raw);
        // An SVG is drawn only when someone opens it (get_media): a read would pay for it unasked.
        const photo =
          info !== undefined &&
          (sharp ? /^image\//i.test(info.mime) && !/^image\/svg/i.test(info.mime) : /^image\/jpe?g\b/i.test(info.mime)) &&
          (info.size ?? 0) <= (sharp ? PREVIEW_SOURCE_MAX_BYTES : PREVIEW_SOURCE_MAX_BYTES_JS);
        const video = info !== undefined && /^video\//i.test(info.mime) && (info.size ?? 0) <= PREVIEW_VIDEO_MAX_BYTES && which("ffmpeg") !== null;
        if ((photo || video) && !this.knownUnpreviewable(sid) && Date.now() - started <= PREVIEW_BUDGET_MS) {
          try {
            // A kept copy answers with the link down; only without one is WhatsApp asked, and only while connected.
            const sock = this.host.sock();
            // Behind other downloads, it waits for a slot only as long as PREVIEW_BUDGET_MS has left, not the download budget's 30 s.
            const waitMs = Math.max(0, PREVIEW_BUDGET_MS - (Date.now() - started));
            const buffer =
              (await this.host.keptMedia(sid, raw)) ??
              (sock && this.host.status() === "connected"
                ? await this.host.mediaBuffer(sock, sid, raw, { waitMs, ...(signal === undefined ? {} : { signal }) })
                : null);
            const made =
              buffer === null ? null : photo ? ((await previewImage(buffer, info.mime, signal))?.data ?? null) : await videoFrame(buffer, undefined, signal);
            // A cancelled shrink or frame grab made nothing, which says nothing about the media.
            if (buffer !== null && made === null && signal?.aborted !== true) this.rememberUnpreviewable(sid);
            if (made && this.host.hasMessage(sid)) {
              await this.writePreview(sid, made);
              chosen = { mime: "image/jpeg", base64: made.toString("base64") };
            }
          } catch {
            // Expired or unreadable original: keep the shipped thumbnail when available.
          }
          throwIfCancelled(signal);
        }
        if (chosen && this.host.hasMessage(sid)) out.push({ message_id: sid, ...chosen });
      }
      return out.filter((preview) => this.host.hasMessage(preview.message_id));
    });
  }

  private knownUnpreviewable(sid: string): boolean {
    const at = this.noPreview.get(sid);
    if (at === undefined) return false;
    if (Date.now() - at < NO_PREVIEW_MS) return true;
    this.noPreview.delete(sid);
    return false;
  }

  private rememberUnpreviewable(sid: string): void {
    this.noPreview.delete(sid);
    this.noPreview.set(sid, Date.now());
    // A Map keeps insertion order: the oldest goes first.
    if (this.noPreview.size > NO_PREVIEW_MAX) this.noPreview.delete(this.noPreview.keys().next().value!);
  }

  /** Previews live as files, one JPEG per message, recorded against it in the database so a delete takes the file too. */
  private previewPath(sid: string): string {
    return join(this.paths.previewsDir, `${safeFilename(sid)}.jpg`);
  }

  private async readPreview(sid: string): Promise<Buffer | null> {
    const path = this.storage.readyDb()?.messages.media(sid).find((media) => media.kind === "preview")?.path;
    if (path === undefined) return null;
    try {
      return await readFile(path);
    } catch (err) {
      if (!isMissing(err)) logError("preview read", err);
      return null;
    }
  }

  /**
   * Writes the file, then records it against its message. A message deleted
   * meanwhile refuses the record, and the file goes at once; one deleted after
   * the record releases it through the database's unlink queue.
   */
  private async writePreview(sid: string, jpeg: Buffer): Promise<void> {
    if (!this.host.hasMessage(sid)) return;
    const path = this.previewPath(sid);
    await mkdir(this.paths.previewsDir, { recursive: true, mode: DIR_MODE });
    if (!this.host.hasMessage(sid)) return;
    await writeFile(path, jpeg, { mode: FILE_MODE });
    const db = this.storage.readyDb();
    const recorded = db?.messages.setMedia(sid, "preview", path) ?? { stored: false, replaced: null };
    if (!recorded.stored) await rm(path, { force: true });
    if (recorded.replaced !== null && recorded.replaced !== path) await rm(recorded.replaced, { force: true });
  }

  /**
   * The kept copy first: it answers with no link, and after WhatsApp let the
   * file go. Only without one is WhatsApp asked, and what it sends is kept
   * then when the settings want it.
   */
  private async original(messageId: string, raw: WAMessage, signal?: AbortSignal): Promise<{ buffer: Buffer; source: OpenedMedia["source"] }> {
    const kept = await this.host.keptMedia(messageId, raw);
    if (kept !== null) return { buffer: kept, source: "kept" };
    const sock = this.host.ensureConnected();
    // Someone asked for this media: expired media is worth a request to the phone. A cancelled call stops the
    // wait for a download slot, the download and the wait for the phone.
    const buffer = await this.host.mediaBuffer(sock, messageId, raw, { reupload: true, ...(signal === undefined ? {} : { signal }) });
    this.views.messageOrThrow(messageId);
    await this.host.offerKept(messageId, raw, buffer).catch((err: unknown) => logError("kept media", err));
    return { buffer, source: "whatsapp" };
  }

  /** The original, written as a file of its own where a local call asked (<data-dir>/media by default). */
  private async writeCopy(messageId: string, info: { mime: string; filename?: string }, buffer: Buffer, saveTo?: string): Promise<{ path: string; filename: string }> {
    const dir = saveTo ?? this.paths.mediaDir;
    if (!isAbsolute(dir)) {
      throw new WazapError("FILE_NOT_FOUND", `"${dir}" is not an absolute directory path.`);
    }
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    this.views.messageOrThrow(messageId);
    const filename = mediaFilename(info);
    const path = join(dir, filename);
    await writeFile(path, buffer, { mode: FILE_MODE });
    // An export already written belongs to the user; never delete arbitrary
    // download paths. Do not return its bytes after expiry, however.
    this.views.messageOrThrow(messageId);
    return { path, filename };
  }

  /**
   * The media once, from the kept copy or WhatsApp, and every derived thing
   * from that one buffer: the file a local call saves, and the view, sheet or
   * text the agent is shown. Nothing is downloaded a second time to make them.
   * A remote call (`noFile`) writes nothing anywhere. A call cancelled
   * (`signal`) stops where it is: the download, or the run drawing or reading
   * the file, and fails with the cancellation.
   */
  openMedia(messageId: string, opts: MediaOpenOptions): Promise<OpenedMedia> {
    return this.host.guarded(async () => {
      const raw = this.views.messageOrThrow(messageId);
      const info = mediaInfo(raw);
      if (!info) throw new WazapError("MEDIA_UNAVAILABLE", `Message ${messageId} carries no media.`);
      throwIfCancelled(opts.signal);
      if (opts.noFile === true && isLottieSticker(raw)) {
        // All there is to see of a Lottie sticker is the thumbnail it shipped, already on hand: a session that keeps no
        // file needs no download, and an expired one no request to the phone.
        const rendition = await renderMedia({ raw, mime: info.mime, buffer: Buffer.alloc(0), detail: opts.detail ?? "standard" });
        this.views.messageOrThrow(messageId);
        return { mime: info.mime, ...(info.size === undefined ? {} : { size: info.size }), rendition };
      }
      const { buffer, source } = await this.original(messageId, raw, opts.signal);
      this.views.messageOrThrow(messageId);
      throwIfCancelled(opts.signal);
      const written = opts.noFile === true ? null : await this.writeCopy(messageId, info, buffer, opts.saveTo);
      const rendition = await renderMedia({
        raw,
        mime: info.mime,
        ...(info.filename === undefined ? {} : { filename: info.filename }),
        buffer,
        detail: opts.detail ?? "standard",
        ...(opts.pages === undefined ? {} : { pages: opts.pages }),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
      // Gone while it was being made: nothing of it is returned.
      this.views.messageOrThrow(messageId);
      return { mime: info.mime, size: buffer.length, source, ...(written ?? {}), rendition };
    });
  }

  /** get_media's file, as earlier callers read it: written where asked, with the image view inline; `signal` stops it. */
  async downloadMedia(messageId: string, saveTo?: string, signal?: AbortSignal): Promise<MediaResult> {
    const opened = await this.openMedia(messageId, { ...(saveTo === undefined ? {} : { saveTo }), ...(signal === undefined ? {} : { signal }) });
    const picture = opened.rendition.kind === "image" ? opened.rendition.jpeg : null;
    return {
      path: opened.path!,
      mime: opened.mime,
      size: opened.size ?? 0,
      filename: opened.filename!,
      inline_base64: picture === null ? null : picture.toString("base64"),
      source: opened.source ?? "whatsapp",
    };
  }

  /** What a download link names a message by: its row and a tag of its id, never the id, which spells a phone number. */
  linkRef(messageId: string): { row: number; tag: string } | null {
    const message = this.storage.readyDb()?.messages.get(messageId) ?? null;
    return message === null ? null : { row: message.id, tag: sidTag(message.sid) };
  }

  /** The live message behind a link's row, when its id still has the link's tag: a row reused by another message is not it. */
  linkTarget(row: number, tag: string): string | null {
    const [message] = this.storage.readyDb()?.messages.byIds([row]) ?? [];
    if (message === undefined || sidTag(message.sid) !== tag || !this.host.hasMessage(message.sid)) return null;
    return message.sid;
  }

  /** What a link's file is and is called, from the message alone (a HEAD on the link): nothing is downloaded. Null when it carries no media. */
  originalInfo(messageId: string): { mime: string; filename: string | null } | null {
    const info = mediaInfo(this.views.messageOrThrow(messageId));
    return info === undefined ? null : { mime: info.mime, filename: info.filename ?? null };
  }

  /** The original's bytes and what to call them, for a download link; nothing is written or derived. `signal`: the fetch went away. */
  mediaOriginal(messageId: string, signal?: AbortSignal): Promise<{ buffer: Buffer; mime: string; filename: string | null }> {
    return this.host.guarded(async () => {
      const raw = this.views.messageOrThrow(messageId);
      const info = mediaInfo(raw);
      if (!info) throw new WazapError("MEDIA_UNAVAILABLE", `Message ${messageId} carries no media.`);
      const { buffer } = await this.original(messageId, raw, signal);
      this.views.messageOrThrow(messageId);
      return { buffer, mime: info.mime, filename: info.filename ?? null };
    });
  }
}
