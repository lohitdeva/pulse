/**
 * Pulse time helpers. Pure, no I/O, no dependencies (shared with Deno Edge Functions).
 *
 * Timestamps are stored in UTC. Wall-clock time is computed in IST using a fixed
 * +05:30 offset (India has no DST, so this is exact and deterministic).
 * A "Pulse day" runs 04:00 -> 03:59 IST. Its key is the YYYY-MM-DD of the
 * calendar date on which its 04:00 boundary falls.
 */

export const IST_TZ = "Asia/Kolkata";
export const IST_OFFSET_MINUTES = 330;
export const DAY_BOUNDARY_HOUR = 4;

const MS_MINUTE = 60_000;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * MS_MINUTE;

export interface IstParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** IST wall-clock parts of a UTC instant. */
export function istParts(instant: Date): IstParts {
  const t = instant.getTime();
  if (Number.isNaN(t)) throw new Error("Invalid date");
  const d = new Date(t + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function formatKey(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function parseDayKey(dayKey: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) throw new Error(`Invalid day key: ${dayKey}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`Invalid day key: ${dayKey}`);
  }
  return { year, month, day };
}

/** UTC instant of the given IST wall-clock time on calendar date `dayKey` + `addDays`. */
function istInstant(dayKey: string, addDays: number, hour: number, minute: number): Date {
  const { year, month, day } = parseDayKey(dayKey);
  return new Date(
    Date.UTC(year, month - 1, day + addDays, hour, minute) - IST_OFFSET_MS,
  );
}

/** The Pulse-day key (YYYY-MM-DD) containing `instant`. IST hours before 04:00 belong to the previous date. */
export function pulseDayKey(instant: Date): string {
  const t = instant.getTime();
  if (Number.isNaN(t)) throw new Error("Invalid date");
  const shifted = new Date(t + IST_OFFSET_MS - DAY_BOUNDARY_HOUR * MS_HOUR);
  return formatKey(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** UTC instant of the 04:00 IST boundary that begins the Pulse day containing `instant`. */
export function startOfPulseDay(instant: Date): Date {
  return istInstant(pulseDayKey(instant), 0, DAY_BOUNDARY_HOUR, 0);
}

/**
 * Half-open range [start, end) of a Pulse day: `start` is 04:00 IST on `dayKey`
 * (inclusive), `end` is 04:00 IST on the next calendar date (exclusive).
 */
export function pulseDayRange(dayKey: string): { start: Date; end: Date } {
  return {
    start: istInstant(dayKey, 0, DAY_BOUNDARY_HOUR, 0),
    end: istInstant(dayKey, 1, DAY_BOUNDARY_HOUR, 0),
  };
}

/** Pulse-day key for "now"; pass a fake `now` in tests. */
export function currentPulseDayKey(now: Date = new Date()): string {
  return pulseDayKey(now);
}

function parseHHMM(value: string): { hour: number; minute: number } {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid HH:MM: ${value}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid HH:MM: ${value}`);
  return { hour, minute };
}

/**
 * Resolve a block's local 24h "HH:MM" times to UTC instants within Pulse day `dayKey`.
 * Hours >= 4 fall on calendar date `dayKey`; hours < 4 fall on `dayKey` + 1.
 * If the end resolves before the start (e.g. "22:30" -> "00:30"), it rolls forward one day.
 */
export function blockInstants(
  dayKey: string,
  startHHMM: string,
  endHHMM: string,
): { start: Date; end: Date } {
  const s = parseHHMM(startHHMM);
  const e = parseHHMM(endHHMM);
  const start = istInstant(dayKey, s.hour < DAY_BOUNDARY_HOUR ? 1 : 0, s.hour, s.minute);
  let end = istInstant(dayKey, e.hour < DAY_BOUNDARY_HOUR ? 1 : 0, e.hour, e.minute);
  if (end.getTime() < start.getTime()) {
    end = new Date(end.getTime() + MS_DAY);
  }
  return { start, end };
}
