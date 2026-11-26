/**
 * Reminder engine (PRD section 6). Pure, no I/O.
 *
 * `buildReminderItems` turns the day's schedule items, classes, deadlines and facility
 * hours into reminder items with windows. `evaluate` says, for a given `now`, which
 * notifications are due, which items have become Missed, and which classes need an
 * attendance prompt. Calling `evaluate` every minute never double-sends as long as the
 * caller records `lastSentAt`/`sentCount` for each key it was told to send.
 */
import { blockInstants, istParts } from "./time.ts";
import type { BlockType, FacilityHours } from "./schedule.ts";
import type { PlanInterval } from "./dayplan.ts";

export type ReminderLevel = "must" | "nudge" | "pace" | "none";
export type ReminderKind =
  | "meal"
  | "gym"
  | "bedtime"
  | "class"
  | "deadline"
  | "nudge"
  | "water"
  | "other";
export type ReminderResolution =
  "done" | "skipped" | "medical" | "going_to_sleep" | "missed";

export interface ReminderItem {
  key: string;
  title: string;
  level: ReminderLevel;
  kind: ReminderKind;
  fireAt: Date;
  /** Missed when `now` reaches this (must-do items only; classes never go Missed). */
  windowEnd: Date | null;
  /** Must-do items repeat every cadence until resolved; the rest send once. */
  repeats: boolean;
  /** One-shot items are dropped once `now` reaches this. */
  lapseAt: Date | null;
  /** If this key is resolved, so is this item (wind-down follows bedtime). */
  parentKey?: string;
  /** Class-end event: reported in `attendancePrompts`, not `send`. */
  attendance?: boolean;
  /** Water pace: bottles expected by this checkpoint. */
  paceExpected?: number;
}

export interface ReminderState {
  resolved?: ReminderResolution;
  snoozedUntil?: Date;
  sentCount: number;
  lastSentAt?: Date;
}

export interface ReminderSourceItem {
  key: string;
  title: string;
  blockType: BlockType;
  startAt: Date | null;
  endAt: Date | null;
  meta?: Record<string, unknown>;
}

export interface ReminderClass {
  key: string;
  title: string;
  start: Date;
  end: Date;
  cancelled: boolean;
}

export interface ReminderDeadline {
  key: string;
  title: string;
  due: Date;
}

export interface SendNotification {
  key: string;
  title: string;
  body: string;
  firm: boolean;
  kind: ReminderKind;
}

export interface EvaluateResult {
  send: SendNotification[];
  missed: string[];
  attendancePrompts: string[];
}

/** Wording gets firmer once this many reminders have already been sent. */
export const FIRM_AFTER = 3;
export const DEFAULT_CADENCE_MINUTES = 10;
export const MIN_CADENCE_MINUTES = 5;
export const MAX_CADENCE_MINUTES = 30;
export const CLASS_LEAD_MINUTES = 10;
export const DEADLINE_LEAD_MINUTES = 60;
export const BEDTIME_WIND_DOWN_MINUTES = 15;
export const BEDTIME_LAST_CALL_HHMM = "02:00";
const NUDGE_GRACE_MINUTES = 120;
const WATER_GRACE_MINUTES = 60;
const ATTENDANCE_GRACE_MINUTES = 120;
const NIGHT_QUIET_START_HOUR = 2;
const NIGHT_QUIET_END_HOUR = 7;
/** Water pace: 2 bottles spread linearly from 07:00 to 23:00. */
const WATER_BOTTLES = 2;
const WATER_DAY_START_HOUR = 7;
const WATER_DAY_END_HOUR = 23;
const WATER_CHECKPOINT_HOURS = [11, 15, 19];

const MS_MIN = 60_000;
const minute = (d: Date): number => Math.floor(d.getTime() / MS_MIN);
const addMin = (d: Date, m: number): Date => new Date(d.getTime() + m * MS_MIN);

export function clampCadence(minutes: number | undefined): number {
  if (minutes === undefined || !Number.isFinite(minutes))
    return DEFAULT_CADENCE_MINUTES;
  return Math.min(
    MAX_CADENCE_MINUTES,
    Math.max(MIN_CADENCE_MINUTES, Math.round(minutes)),
  );
}

/** Intervals of classes that are not cancelled: the only ones that count as quiet time. */
export function quietClassIntervals(classes: ReminderClass[]): PlanInterval[] {
  return classes
    .filter((c) => !c.cancelled)
    .map((c) => ({ start: c.start, end: c.end }));
}

type MealKey = keyof FacilityHours["mess"];

function mealOf(title: string): MealKey | null {
  const m = /^\s*(breakfast|lunch|snacks|dinner)\b/i.exec(title);
  return m ? (m[1]!.toLowerCase() as MealKey) : null;
}

export interface BuildReminderInput {
  dayKey: string;
  items: ReminderSourceItem[];
  classes: ReminderClass[];
  facility: FacilityHours;
  deadlines?: ReminderDeadline[];
}

/**
 * Reminder items for one Pulse day.
 * - meal: window ends at mess close or 10 min before the next class, whichever is earlier
 *   (classes starting within 10 min of the meal's own reminder are ignored).
 * - gym: window ends when the gym window containing (or next after) the item closes.
 * - bedtime: a wind-down nudge 15 min earlier, then repeating reminders until 02:00.
 * - class: reminder 10 min before; an attendance event at class end. Cancelled classes emit nothing.
 * - deadline: reminders start 60 min before due; Missed at due.
 * - water: pace nudges at 11:00, 15:00, 19:00.
 */
export function buildReminderItems(input: BuildReminderInput): ReminderItem[] {
  const { dayKey, facility } = input;
  const out: ReminderItem[] = [];
  const classes = input.classes
    .filter((c) => !c.cancelled)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  for (const src of input.items) {
    if (src.meta?.fillable === true) continue; // the timetable block; classes come separately
    if (!src.startAt) continue;
    const fireAt = src.startAt;

    if (src.blockType === "must_do") {
      const meal = mealOf(src.title);
      if (meal) {
        const [open, close] = facility.mess[meal];
        let end = blockInstants(dayKey, open, close).end;
        const next = classes.find(
          (c) =>
            addMin(c.start, -CLASS_LEAD_MINUTES).getTime() > fireAt.getTime(),
        );
        if (next) {
          const cutoff = addMin(next.start, -CLASS_LEAD_MINUTES);
          if (cutoff.getTime() < end.getTime()) end = cutoff;
        }
        out.push(mustItem(src, "meal", fireAt, end));
      } else if (/^\s*gym\b/i.test(src.title)) {
        const windows = facility.gym.map(([s, e]) =>
          blockInstants(dayKey, s, e),
        );
        const w =
          windows.find(
            (x) =>
              x.start.getTime() <= fireAt.getTime() &&
              fireAt.getTime() < x.end.getTime(),
          ) ?? windows.find((x) => x.start.getTime() > fireAt.getTime());
        out.push(mustItem(src, "gym", fireAt, w ? w.end : src.endAt));
      } else if (/^\s*(lights out|bedtime)\b/i.test(src.title)) {
        const lastCall = blockInstants(
          dayKey,
          BEDTIME_LAST_CALL_HHMM,
          BEDTIME_LAST_CALL_HHMM,
        ).end;
        const end =
          lastCall.getTime() > fireAt.getTime() ? lastCall : addMin(fireAt, 60);
        out.push({
          key: `${src.key}:winddown`,
          title: "Wind down",
          level: "nudge",
          kind: "bedtime",
          fireAt: addMin(fireAt, -BEDTIME_WIND_DOWN_MINUTES),
          windowEnd: null,
          repeats: false,
          lapseAt: fireAt,
          parentKey: src.key,
        });
        out.push(mustItem(src, "bedtime", fireAt, end));
      } else {
        out.push(mustItem(src, "other", fireAt, src.endAt));
      }
    } else if (src.blockType === "habit_nudge") {
      out.push({
        key: src.key,
        title: src.title,
        level: "nudge",
        kind: "nudge",
        fireAt,
        windowEnd: null,
        repeats: false,
        lapseAt: src.endAt ?? addMin(fireAt, NUDGE_GRACE_MINUTES),
      });
    }
    // anchor, habit, habit_checklist, check_in, buffer, fixed: no notification
  }

  for (const c of classes) {
    out.push({
      key: c.key,
      title: c.title,
      level: "must",
      kind: "class",
      fireAt: addMin(c.start, -CLASS_LEAD_MINUTES),
      windowEnd: c.end,
      repeats: false,
      lapseAt: c.start,
    });
    out.push({
      key: `${c.key}:attendance`,
      title: c.title,
      level: "must",
      kind: "class",
      fireAt: c.end,
      windowEnd: null,
      repeats: false,
      lapseAt: addMin(c.end, ATTENDANCE_GRACE_MINUTES),
      attendance: true,
    });
  }

  for (const d of input.deadlines ?? []) {
    out.push({
      key: d.key,
      title: d.title,
      level: "must",
      kind: "deadline",
      fireAt: addMin(d.due, -DEADLINE_LEAD_MINUTES),
      windowEnd: d.due,
      repeats: true,
      lapseAt: null,
    });
  }

  for (const h of WATER_CHECKPOINT_HOURS) {
    const hh = String(h).padStart(2, "0");
    const fireAt = blockInstants(dayKey, `${hh}:00`, `${hh}:00`).start;
    out.push({
      key: `water:${hh}`,
      title: "Water",
      level: "pace",
      kind: "water",
      fireAt,
      windowEnd: null,
      repeats: false,
      lapseAt: addMin(fireAt, WATER_GRACE_MINUTES),
      paceExpected:
        (WATER_BOTTLES * (h - WATER_DAY_START_HOUR)) /
        (WATER_DAY_END_HOUR - WATER_DAY_START_HOUR),
    });
  }

  return out.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
}

function mustItem(
  src: ReminderSourceItem,
  kind: ReminderKind,
  fireAt: Date,
  windowEnd: Date | null,
): ReminderItem {
  return {
    key: src.key,
    title: src.title,
    level: "must",
    kind,
    fireAt,
    windowEnd,
    repeats: true,
    lapseAt: null,
  };
}

export interface EvaluateInput {
  items: ReminderItem[];
  state: Record<string, ReminderState | undefined>;
  quiet: { classes: PlanInterval[]; call: PlanInterval | null };
  cadenceMinutes?: number | undefined;
  waterBottles?: number | undefined;
  now: Date;
}

function within(now: Date, iv: PlanInterval): boolean {
  return (
    now.getTime() >= iv.start.getTime() && now.getTime() < iv.end.getTime()
  );
}

function inNightQuiet(now: Date): boolean {
  const h = istParts(now).hour;
  return h >= NIGHT_QUIET_START_HOUR && h < NIGHT_QUIET_END_HOUR;
}

function bodyFor(item: ReminderItem, firm: boolean): string {
  if (item.kind === "class") return "Starts in 10 minutes.";
  if (item.kind === "water") return "Water is behind pace. Have a bottle soon.";
  if (item.kind === "bedtime" && item.level === "nudge")
    return "Wind down. Lights out soon.";
  if (item.level === "nudge") return "Starting now.";
  if (item.kind === "bedtime")
    return firm
      ? "Still awake. Go to sleep now."
      : "Time to sleep. Tap Going to sleep.";
  return firm
    ? "Still not done. Do it now, or skip it with a reason."
    : "Due now. Mark it Done, Snooze or Skip.";
}

export function evaluate(input: EvaluateInput): EvaluateResult {
  const { now } = input;
  const nowM = minute(now);
  const cadence = clampCadence(input.cadenceMinutes);
  const bottles = input.waterBottles ?? 0;
  const night = inNightQuiet(now);
  const inClass = input.quiet.classes.some((iv) => within(now, iv));
  const inCall = input.quiet.call ? within(now, input.quiet.call) : false;

  const result: EvaluateResult = {
    send: [],
    missed: [],
    attendancePrompts: [],
  };

  for (const item of input.items) {
    if (item.level === "none") continue;
    const st = input.state[item.key] ?? { sentCount: 0 };
    const parent = item.parentKey ? input.state[item.parentKey] : undefined;
    if (st.resolved || parent?.resolved) continue;

    const missable =
      item.level === "must" &&
      item.kind !== "class" &&
      !item.attendance &&
      item.windowEnd !== null;
    if (missable && nowM >= minute(item.windowEnd!)) {
      result.missed.push(item.key);
      continue;
    }

    if (nowM < minute(item.fireAt)) continue;
    if (item.windowEnd && nowM >= minute(item.windowEnd)) continue;
    if (item.lapseAt && nowM >= minute(item.lapseAt)) continue;

    // Quiet rules: night and class slots hold everything; the call holds nudges only.
    if (night || inClass) continue;
    if (inCall && item.level !== "must") continue;

    if (st.snoozedUntil && nowM < minute(st.snoozedUntil)) continue;

    let due: boolean;
    if (!item.repeats) {
      due = st.sentCount === 0;
    } else if (!st.lastSentAt) {
      due = true;
    } else if (
      st.snoozedUntil &&
      minute(st.lastSentAt) < minute(st.snoozedUntil)
    ) {
      due = true; // snooze just ended
    } else {
      due = nowM - minute(st.lastSentAt) >= cadence;
    }
    if (!due) continue;

    if (item.kind === "water" && bottles >= (item.paceExpected ?? 0)) continue;

    if (item.attendance) {
      result.attendancePrompts.push(item.key); // `<classKey>:attendance`
      continue;
    }

    const firm = st.sentCount >= FIRM_AFTER;
    result.send.push({
      key: item.key,
      title: item.title,
      body: bodyFor(item, firm),
      firm,
      kind: item.kind,
    });
  }

  return result;
}
