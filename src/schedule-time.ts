/**
 * When a scheduled message or a reminder is due, from what an agent passes:
 * an ISO date-time with its offset (`2026-10-12T09:00:00+03:00`, `…Z`), or a
 * wall-clock time (`2026-10-12T09:00`) read in an IANA time zone — the one
 * given, or the server's own. A wall-clock time the zone skips (the hour a
 * clock springs forward) is refused rather than guessed; one it repeats (the
 * hour it falls back) is the first of the two, and the answer says so.
 *
 * Every answer names the instant three ways — epoch ms, ISO in the zone with
 * its offset, and the zone — so the preview the user says yes to shows the
 * time exactly as it will be kept.
 */
import { WazapError } from "./errors.js";

/** A scheduled message or reminder is at least this far ahead when it is set, and at most SCHEDULE_MAX_AHEAD_MS. */
export const SCHEDULE_MIN_AHEAD_MS = 60_000;
export const SCHEDULE_MAX_AHEAD_MS = 365 * 86_400_000;

export interface ResolvedTime {
  /** Epoch ms. */
  at: number;
  /** The IANA zone the time is shown in. */
  zone: string;
  /** ISO 8601 in that zone, with its offset: 2026-10-12T09:00:00+03:00. */
  iso: string;
  /** "Mon 12 Oct 2026, 09:00 (Europe/Bucharest, UTC+03:00)". */
  label: string;
  /** The wall-clock time named an hour the zone repeats; the first was taken. */
  ambiguous?: true;
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;
/** A date-time with its offset, field by field, so a day or an hour that does not exist is refused, not rolled over. */
const WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):?(\d{2}))$/i;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The zone the server runs in: what a wall-clock time means when the caller names none. */
export function serverTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The zone's canonical name, or INVALID_TIME for a name Intl does not know. */
export function requireTimeZone(zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone.trim() }).resolvedOptions().timeZone;
  } catch {
    throw new WazapError(
      "INVALID_TIME",
      `"${zone}" is not a time zone.`,
      'Pass an IANA time zone such as "Europe/Bucharest" or "America/New_York", or put the offset in the time itself'
    );
  }
}

/** The wall clock in `zone` at `at`, field by field. */
function wallOf(at: number, zone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(at));
  const field = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "0";
  return {
    y: Number(field("year")),
    mo: Number(field("month")),
    d: Number(field("day")),
    h: Number(field("hour")) % 24,
    mi: Number(field("minute")),
    s: Number(field("second")),
    wd: WEEKDAYS.indexOf(field("weekday")),
  };
}

/** The zone's offset from UTC at `at`, in ms (east positive). */
function offsetAt(at: number, zone: string): number {
  const w = wallOf(at, zone);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(at / 1000) * 1000;
}

const pad = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, "0");

function offsetLabel(offsetMs: number): string {
  const minutes = Math.round(offsetMs / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

/** An instant as ISO 8601 and as a line a person reads, both in `zone`. */
export function describeInstant(at: number, zone: string): Omit<ResolvedTime, "ambiguous"> {
  const w = wallOf(at, zone);
  const offset = offsetLabel(offsetAt(at, zone));
  const iso = `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${offset}`;
  const label = `${WEEKDAYS[w.wd] ?? ""} ${w.d} ${MONTHS[w.mo - 1] ?? ""} ${w.y}, ${pad(w.h)}:${pad(w.mi)} (${zone}, UTC${offset})`;
  return { at, zone, iso, label };
}

/** The fields name a real day and a time of it (no 24:00, no 31 February). */
function realDate(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  const check = new Date(Date.UTC(y, mo - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d && h <= 23 && mi <= 59 && s <= 59;
}

function badTime(value: string, zone: string, now: number): WazapError {
  return new WazapError(
    "INVALID_TIME",
    `"${value}" is not a time wazap can read.`,
    `Pass a date and time like "2026-10-12T09:00" with time_zone, or one with its offset like "2026-10-12T09:00:00+03:00". It is now ${describeInstant(now, zone).iso} in ${zone}`
  );
}

/**
 * The instant `value` names. With an offset it is that instant, shown in
 * `zone` (or the server's); without one it is that wall-clock time in the zone.
 */
export function resolveTime(value: string, zone: string | undefined, now: number = Date.now()): ResolvedTime {
  const tz = zone === undefined || zone.trim() === "" ? serverTimeZone() : requireTimeZone(zone);
  const text = value.trim();
  if (OFFSET.test(text)) {
    const o = WITH_OFFSET.exec(text);
    if (o === null) throw badTime(value, tz, now);
    const [y, mo, d, h, mi, s] = [o[1], o[2], o[3], o[4], o[5], o[6] ?? "0"].map(Number) as [number, number, number, number, number, number];
    const offH = Number(o[9] ?? 0);
    const offM = Number(o[10] ?? 0);
    if (!realDate(y, mo, d, h, mi, s) || offH > 14 || offM > 59) throw badTime(value, tz, now);
    const sign = o[8] === "-" ? -1 : 1;
    // Whole seconds, like a wall-clock time: what the preview shows is the instant kept.
    const at = Date.UTC(y, mo - 1, d, h, mi, s) - sign * (offH * 60 + offM) * 60_000;
    return describeInstant(at, tz);
  }
  const m = WALL.exec(text);
  if (m === null) throw badTime(value, tz, now);
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number) as [number, number, number, number, number, number];
  if (!realDate(y, mo, d, h, mi, s)) throw badTime(value, tz, now);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  // The wall time minus each offset the zone has around then: a candidate that
  // reads back as the same wall time is a real instant.
  const offsets = new Set([offsetAt(guess - 86_400_000, tz), offsetAt(guess, tz), offsetAt(guess + 86_400_000, tz)]);
  const matches = [...offsets]
    .map((offset) => guess - offset)
    .filter((at) => {
      const w = wallOf(at, tz);
      return w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi && w.s === s;
    })
    .sort((a, b) => a - b);
  const first = matches[0];
  if (first === undefined) {
    throw new WazapError(
      "INVALID_TIME",
      `${text} does not exist in ${tz}: the clocks skip that hour.`,
      "Pick a time outside the hour the clocks change, and confirm it with the user"
    );
  }
  const resolved: ResolvedTime = describeInstant(first, tz);
  if (new Set(matches).size > 1) resolved.ambiguous = true;
  return resolved;
}

/**
 * `resolveTime`, held to a window: at least `minAheadMs` after now and at most
 * `maxAheadMs`. `field` names the argument in the refusal.
 */
export function resolveFutureTime(
  value: string,
  zone: string | undefined,
  { now = Date.now(), minAheadMs, maxAheadMs, field }: { now?: number; minAheadMs: number; maxAheadMs: number; field: string }
): ResolvedTime {
  const resolved = resolveTime(value, zone, now);
  const current = describeInstant(now, resolved.zone).iso;
  if (resolved.at < now + minAheadMs) {
    throw new WazapError(
      "INVALID_TIME",
      `${field} ${resolved.iso} is ${resolved.at <= now ? "in the past" : "too soon"}: it is now ${current}.`,
      resolved.at <= now
        ? "Check the date with the user; to send now, draft without send_at"
        : `Pick a time at least ${Math.ceil(minAheadMs / 60_000)} minute(s) ahead, or send now without send_at`
    );
  }
  if (resolved.at > now + maxAheadMs) {
    throw new WazapError(
      "INVALID_TIME",
      `${field} ${resolved.iso} is too far ahead: at most ${Math.round(maxAheadMs / 86_400_000)} days.`,
      "Pick an earlier time"
    );
  }
  return resolved;
}
