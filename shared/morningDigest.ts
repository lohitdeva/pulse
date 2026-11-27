/**
 * Morning digest (PRD section 6). Pure, no I/O.
 *
 * Builds the title and body of the single 08:40 IST push: today's classes, today's
 * timetable changes and deadlines in the next 72 hours. Today's workout (Phase 5) and
 * yesterday's score (Phase 8) are optional inputs that are omitted until those exist.
 */
import { istParts } from "./time.ts";

export const DIGEST_DEADLINE_WINDOW_HOURS = 72;
export const DIGEST_BODY_MAX_CHARS = 240;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const FINISHED_STATUSES = new Set(["Done", "Dropped"]);

export interface DigestClass {
  title: string;
  start: Date;
  cancelled: boolean;
}

export interface DigestChange {
  summary: string;
}

export interface DigestDeadline {
  title: string;
  due: Date | string;
  /** Tasks marked Done or Dropped are left out. */
  status?: string;
}

export interface MorningDigestInput {
  dayKey: string;
  classes: DigestClass[];
  changes: DigestChange[];
  deadlines: DigestDeadline[];
  now: Date;
  /** Phase 5 (fitness): today's workout, e.g. "Push day". Omitted when absent. */
  workoutToday?: string | null;
  /** Phase 8 (scoring): yesterday's score, e.g. "82". Omitted when absent. */
  yesterdayScore?: string | number | null;
}

export interface MorningDigest {
  title: string;
  body: string;
}

/** "9:30" or "14:15": IST, 24-hour, no leading zero on the hour. */
function istClock(instant: Date): string {
  const p = istParts(instant);
  return `${p.hour}:${String(p.minute).padStart(2, "0")}`;
}

function istWeekday(instant: Date): string {
  const p = istParts(instant);
  return WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()]!;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function buildMorningDigest(input: MorningDigestInput): MorningDigest {
  const classes = input.classes
    .filter((c) => !c.cancelled)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const title =
    classes.length === 0
      ? "No classes today"
      : `Today: ${classes.length} ${classes.length === 1 ? "class" : "classes"}`;

  const lines: string[] = [];
  if (classes.length > 0) {
    lines.push(classes.map((c) => `${istClock(c.start)} ${c.title}`).join(" · "));
  }

  const changes = input.changes.map((c) => c.summary.trim()).filter(Boolean);
  if (changes.length > 0) lines.push(`Changes: ${changes.join("; ")}`);

  const nowMs = input.now.getTime();
  const horizon = nowMs + DIGEST_DEADLINE_WINDOW_HOURS * 3_600_000;
  const due = input.deadlines
    .map((d) => ({ title: d.title, at: new Date(d.due), status: d.status }))
    .filter(
      (d) =>
        !Number.isNaN(d.at.getTime()) &&
        d.at.getTime() >= nowMs &&
        d.at.getTime() <= horizon &&
        !(d.status !== undefined && FINISHED_STATUSES.has(d.status)),
    )
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (due.length > 0) {
    lines.push(
      `Due soon: ${due
        .map((d) => `${d.title} ${istWeekday(d.at)} ${istClock(d.at)}`)
        .join("; ")}`,
    );
  }

  if (input.workoutToday) lines.push(`Workout: ${input.workoutToday}`);
  if (input.yesterdayScore !== undefined && input.yesterdayScore !== null) {
    lines.push(`Yesterday: ${input.yesterdayScore}`);
  }

  return { title, body: truncate(lines.join("\n"), DIGEST_BODY_MAX_CHARS) };
}
