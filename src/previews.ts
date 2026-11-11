/**
 * A small JPEG of a photo, made here. WhatsApp used to ship a preview inside
 * every image message; in 2026 almost none carries one (1 in 500 in a real
 * account), so the preview an agent needs to tell a receipt from a baby has
 * to be computed from the photo itself, and the photo never leaves the
 * machine. sharp makes it (src/images.ts); makePreview here is the fallback
 * for an install where sharp does not load: jpeg-js is pure JavaScript and
 * needs no native build, but it decodes on the event loop.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { which } from "./transcribe/local.js";
import { LOCAL_MEDIA_INPUT_ARGS } from "./media-process.js";
import { HELPER_RSS_BYTES, helperSlots, runNative, type NativeLimits } from "./native-run.js";

/** Each ffmpeg run on a sender's video: a time limit, a memory limit, and at most two at once (src/native-run.ts). */
const FRAME_LIMITS = { timeoutMs: 30_000, maxRssBytes: HELPER_RSS_BYTES };

/** Longest edge of a preview. 320 px reads a receipt's total and a face. */
export const PREVIEW_MAX_EDGE = 320;

/**
 * Previews one read attaches at most (read_messages, its stories, the cached
 * get_recent_messages): six of about 76 image tokens each. Twelve let two
 * reads pass the twenty images a hosted client takes in one message, and a
 * long session carries every one it was shown; a read with more photos says
 * how many went without, and the next call brings them.
 */
export const MAX_PREVIEWS = 6;

/** The line that says what was attached: each preview by its message_id, in the order of the image blocks. */
export function previewsLine(messageIds: readonly string[]): string | null {
  if (messageIds.length === 0) return null;
  const n = messageIds.length;
  return `${n} preview${n === 1 ? "" : "s"} attached, in the order of the image blocks: ${messageIds.map((id, i) => `preview ${i + 1} is ${id}`).join("; ")}.`;
}
const PREVIEW_QUALITY = 60;

export interface PreviewImage {
  mime: string;
  base64: string;
  width: number;
  height: number;
}

/** Tiny WhatsApp thumbnails identify a photo but cannot show a document's words. */
export function tinyThumbnail(input: Buffer): boolean {
  try {
    const image = jpeg.decode(input, { useTArray: true, maxResolutionInMP: 1, maxMemoryUsageInMB: 16 });
    return Math.max(image.width, image.height) < 160;
  } catch {
    // Leave unrecognized previews alone; do not trigger a download on malformed metadata.
    return false;
  }
}

/** Decode a JPEG, shrink it with a box filter, encode it small. Throws on a file that is not a JPEG. */
export function makePreview(
  input: Buffer,
  maxEdge = PREVIEW_MAX_EDGE,
  limits = { maxResolutionInMP: 50, maxMemoryUsageInMB: 512 }
): PreviewImage {
  const source = jpeg.decode(input, {
    useTArray: true,
    formatAsRGBA: true,
    ...limits,
  });
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const out = Buffer.alloc(width * height * 4);
  const src = source.data;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * source.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * source.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * source.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * source.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let at = (sy * source.width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, at += 4) {
          r += src[at]!;
          g += src[at + 1]!;
          b += src[at + 2]!;
          n++;
        }
      }
      const to = (y * width + x) * 4;
      out[to] = Math.round(r / n);
      out[to + 1] = Math.round(g / n);
      out[to + 2] = Math.round(b / n);
      out[to + 3] = 255;
    }
  }
  const encoded = jpeg.encode({ data: out, width, height }, PREVIEW_QUALITY);
  return { mime: "image/jpeg", base64: Buffer.from(encoded.data).toString("base64"), width, height };
}

/**
 * One frame of a video as a small JPEG, its longer side at most `maxEdge`,
 * made by ffmpeg when it is installed; null when it is not, or when the clip
 * yields no frame. The frame is taken a second in, where a clip has usually
 * settled, and at the start for one shorter than that.
 */
export async function videoFrame(video: Buffer, maxEdge = PREVIEW_MAX_EDGE, signal?: AbortSignal): Promise<Buffer | null> {
  const ffmpeg = which("ffmpeg");
  if (ffmpeg === null) return null;
  return helperSlots.run(() => grabFrame(ffmpeg, video, maxEdge, frameLimits(signal)), signal);
}

/** FRAME_LIMITS, and a cancelled call's signal, which kills the run. */
function frameLimits(signal: AbortSignal | undefined): NativeLimits {
  return signal === undefined ? FRAME_LIMITS : { ...FRAME_LIMITS, signal };
}

/** Whether the call these runs are for was cancelled: no further run starts. */
function cancelled(limits: NativeLimits): boolean {
  return limits.signal?.aborted === true;
}

async function grabFrame(ffmpeg: string, video: Buffer, maxEdge: number, limits: NativeLimits): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), "wazap-frame-"));
  try {
    const input = join(dir, "in.bin");
    const output = join(dir, "out.jpg");
    await writeFile(input, video);
    for (const at of ["1", "0"]) {
      const args = [
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        at,
        ...LOCAL_MEDIA_INPUT_ARGS,
        "-i",
        input,
        "-frames:v",
        "1",
        "-vf",
        // Inside a square of maxEdge, whichever side is longer: a vertical clip is as tall as a wide one is wide.
        `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease`,
        "-q:v",
        "6",
        output,
      ];
      if (cancelled(limits)) return null;
      try {
        await runNative(ffmpeg, args, limits);
        const frame = await readFile(output);
        if (frame.length > 0) return frame;
      } catch {
        // No frame at that offset; try the start.
      }
    }
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** How many frames a contact sheet shows: enough to follow a clip, few enough to read at 1,024 px. */
export const SHEET_FRAMES = 6;
/** Each frame's longest edge as ffmpeg extracts it, before it is tiled. */
const SHEET_FRAME_EDGE = 512;

export interface VideoFrames {
  /** JPEGs, in the order of `at`. */
  frames: Buffer[];
  /** The second each frame was taken at. */
  at: number[];
  /** How long the clip runs: as WhatsApp stated it, or as ffmpeg read it. */
  duration_seconds?: number;
}

/** "Duration: 00:01:02.50" in ffmpeg's report on its input, as seconds. */
export function parseDuration(report: string): number | undefined {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(report);
  if (!match) return undefined;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** When `count` frames are taken across `duration` seconds: the middle of each equal slice, to a tenth of a second. */
export function frameTimes(duration: number, count = SHEET_FRAMES): number[] {
  const n = duration < 1 ? 1 : count;
  return Array.from({ length: n }, (_, i) => Math.round(((duration * (i + 0.5)) / n) * 10) / 10);
}

/**
 * Frames spread evenly across a clip, for a contact sheet: one ffmpeg run that
 * seeks to each time (a fast seek, so only the frames around each point are
 * decoded), every input under the same protocol and format whitelists as any
 * other ffmpeg call here. The length comes from the envelope, or from
 * ffmpeg's own report on the file. Null without ffmpeg, or when the clip
 * yields no frame.
 */
export async function videoFrames(video: Buffer, seconds?: number, signal?: AbortSignal): Promise<VideoFrames | null> {
  const ffmpeg = which("ffmpeg");
  if (ffmpeg === null) return null;
  return helperSlots.run(() => sheetFrames(ffmpeg, video, seconds, frameLimits(signal)), signal);
}

async function sheetFrames(ffmpeg: string, video: Buffer, seconds: number | undefined, limits: NativeLimits): Promise<VideoFrames | null> {
  const dir = await mkdtemp(join(tmpdir(), "wazap-sheet-"));
  try {
    const input = join(dir, "in.bin");
    await writeFile(input, video, { mode: 0o600 });
    const duration = seconds ?? (await probeDuration(ffmpeg, input, limits));
    if (duration === undefined || cancelled(limits)) return null;
    const taken = await framesAt(ffmpeg, input, dir, duration, limits);
    if (seconds !== undefined && taken.frames.length < frameTimes(duration).length && !cancelled(limits)) {
      // The envelope's length is the sender's word: a clip shorter than it says leaves the later seeks past its end.
      const probed = await probeDuration(ffmpeg, input, limits);
      if (probed !== undefined && probed < duration * 0.9 && !cancelled(limits)) {
        const again = await framesAt(ffmpeg, input, dir, probed, limits);
        if (again.frames.length > taken.frames.length) return { ...again, duration_seconds: Math.round(probed * 10) / 10 };
      }
    }
    if (taken.frames.length === 0) return null;
    return { ...taken, ...(duration > 0 ? { duration_seconds: Math.round(duration * 10) / 10 } : {}) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The frames at `frameTimes(duration)` in one ffmpeg run, and the seconds of those it could take. */
async function framesAt(ffmpeg: string, input: string, dir: string, duration: number, limits: NativeLimits): Promise<{ frames: Buffer[]; at: number[] }> {
  const at = frameTimes(duration);
  const outputs = at.map((_, i) => join(dir, `f${i}.jpg`));
  await Promise.all(outputs.map((output) => rm(output, { force: true })));
  const scale = `scale='min(${SHEET_FRAME_EDGE},iw)':'min(${SHEET_FRAME_EDGE},ih)':force_original_aspect_ratio=decrease`;
  const args = ["-nostdin", "-loglevel", "error", "-y"];
  for (const time of at) args.push("-ss", String(time), ...LOCAL_MEDIA_INPUT_ARGS, "-i", input);
  at.forEach((_, i) => args.push("-map", `${i}:v:0`, "-frames:v", "1", "-an", "-sn", "-dn", "-vf", scale, "-q:v", "3", outputs[i]!));
  try {
    await runNative(ffmpeg, args, limits);
  } catch {
    // A seek past a short clip's last frame fails the run: what it did write is used below.
  }
  const frames: Buffer[] = [];
  const taken: number[] = [];
  for (const [i, output] of outputs.entries()) {
    const frame = await readFile(output).catch(() => null);
    if (frame !== null && frame.length > 0) {
      frames.push(frame);
      taken.push(at[i]!);
    }
  }
  return { frames, at: taken };
}

/** The clip's length from ffmpeg's report on its input; it exits with an error for want of an output, which is expected. */
async function probeDuration(ffmpeg: string, input: string, limits: NativeLimits): Promise<number | undefined> {
  try {
    const { stderr } = await runNative(ffmpeg, ["-nostdin", "-hide_banner", ...LOCAL_MEDIA_INPUT_ARGS, "-i", input], limits);
    return parseDuration(stderr);
  } catch (err) {
    return parseDuration(String((err as { stderr?: unknown }).stderr ?? ""));
  }
}

/** A JPEG's width and height from its frame header, without decoding it; null when there is none. */
export function jpegSize(jpeg: Buffer): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 < jpeg.length) {
    if (jpeg[at] !== 0xff) return null;
    const marker = jpeg[at + 1]!;
    const length = jpeg.readUInt16BE(at + 2);
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: jpeg.readUInt16BE(at + 5), width: jpeg.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return null;
}
