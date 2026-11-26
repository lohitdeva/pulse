import type { SupabaseClient } from "@supabase/supabase-js";
import { istDateTimeLocalToUtc, istParts, type ScheduleItem } from "@pulse/shared";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  addExtraClass,
  cancelClass,
  logAttendance,
  moveClass,
  restoreClass,
  type Attendance,
} from "./classOverrides";
import { Sheet } from "./ui";

/** Class UI on Today (PRD section 4): attendance, cancel/restore, move, extra class. */

export const ATTENDANCE_OPTIONS: ReadonlyArray<{ value: Attendance; label: string }> = [
  { value: "attended", label: "Attended" },
  { value: "missed", label: "Missed" },
  { value: "medical", label: "Medical" },
  { value: "cancelled", label: "Cancelled" },
];

const ATTENDANCE_VALUES = new Set<string>(ATTENDANCE_OPTIONS.map((o) => o.value));

/** Generic on purpose: never echo server text, it could carry personal data. */
export const SAVE_ERROR = "Couldn't save that change. Check your connection and try again.";

export interface ClassActionsApi {
  /** Attendance already logged today, keyed by class id. */
  attendance: Record<string, Attendance>;
  /** Each action resolves to an inline error message, or null on success. */
  setAttendance: (classId: string, value: Attendance, classStart: Date) => Promise<string | null>;
  cancel: (classId: string) => Promise<string | null>;
  restore: (classId: string) => Promise<string | null>;
  move: (classId: string, start: Date, end: Date) => Promise<string | null>;
  addExtra: (input: {
    date: string;
    start: Date;
    end: Date;
    title: string;
    course: string | null;
    room: string | null;
  }) => Promise<string | null>;
}

type ItemLogLike = { item_key: string; meta?: Record<string, unknown> | null };

/** `class:<id>` item logs with a valid `meta.attendance` -> id -> attendance. */
export function attendanceByClass(rows: readonly ItemLogLike[]): Record<string, Attendance> {
  const out: Record<string, Attendance> = {};
  for (const row of rows) {
    if (!row.item_key.startsWith("class:")) continue;
    const value = row.meta?.attendance;
    if (typeof value === "string" && ATTENDANCE_VALUES.has(value)) {
      out[row.item_key.slice("class:".length)] = value as Attendance;
    }
  }
  return out;
}

export interface ClassActionDeps {
  client: SupabaseClient;
  userId: string;
  attendance: Record<string, Attendance>;
  /** Re-reads the day's classes after a manual change. */
  reload: () => void;
}

/** Plain factory (no hooks) so it can be tested directly. */
export function createClassActionsApi({
  client,
  userId,
  attendance,
  reload,
}: ClassActionDeps): ClassActionsApi {
  const run = async (fn: () => Promise<unknown>, reloadAfter: boolean): Promise<string | null> => {
    try {
      await fn();
      if (reloadAfter) reload();
      return null;
    } catch {
      return SAVE_ERROR;
    }
  };
  return {
    attendance,
    setAttendance: (classId, value, classStart) =>
      run(() => logAttendance(userId, classId, value, classStart, client), false),
    cancel: (classId) => run(() => cancelClass(client, classId), true),
    restore: (classId) => run(() => restoreClass(client, classId), true),
    move: (classId, start, end) => run(() => moveClass(client, classId, start, end), true),
    addExtra: (input) => run(() => addExtraClass(client, input), true),
  };
}

export function useClassActions(deps: ClassActionDeps): ClassActionsApi {
  const { client, userId, attendance, reload } = deps;
  return useMemo(
    () => createClassActionsApi({ client, userId, attendance, reload }),
    [client, userId, attendance, reload],
  );
}

// ---------------------------------------------------------------- forms ---

const HHMM = /^(\d{2}):(\d{2})$/;

/**
 * IST wall time "HH:MM" on a Pulse day. The Pulse day starts at 04:00, so
 * 00:00 to 03:59 belong to the following calendar date.
 */
export function timeOnPulseDay(dayKey: string, hhmm: string): Date | null {
  const match = HHMM.exec(hhmm);
  if (!match) return null;
  try {
    const base = new Date(istDateTimeLocalToUtc(`${dayKey}T${hhmm}`));
    return Number(match[1]) < 4 ? new Date(base.getTime() + 24 * 3_600_000) : base;
  } catch {
    return null;
  }
}

/** "HH:MM" in IST, for pre-filling time inputs. */
export function hhmm(instant: Date): string {
  const p = istParts(instant);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export type TimeRangeResult =
  | { ok: true; start: Date; end: Date }
  | { ok: false; error: string };

export function parseTimeRange(dayKey: string, startValue: string, endValue: string): TimeRangeResult {
  const start = timeOnPulseDay(dayKey, startValue);
  const end = timeOnPulseDay(dayKey, endValue);
  if (!start || !end) return { ok: false, error: "Enter a start and an end time." };
  if (end.getTime() <= start.getTime()) return { ok: false, error: "End time must be after the start time." };
  return { ok: true, start, end };
}

export function parseMoveForm(dayKey: string, data: FormData): TimeRangeResult {
  return parseTimeRange(dayKey, String(data.get("start") ?? ""), String(data.get("end") ?? ""));
}

export type ExtraClassResult =
  | {
      ok: true;
      value: {
        date: string;
        start: Date;
        end: Date;
        title: string;
        course: string | null;
        room: string | null;
      };
    }
  | { ok: false; error: string };

export function parseExtraForm(dayKey: string, data: FormData): ExtraClassResult {
  const title = String(data.get("title") ?? "").trim();
  if (!title) return { ok: false, error: "Give the class a title." };
  const range = parseTimeRange(dayKey, String(data.get("start") ?? ""), String(data.get("end") ?? ""));
  if (!range.ok) return range;
  const course = String(data.get("course") ?? "").trim();
  const room = String(data.get("room") ?? "").trim();
  return {
    ok: true,
    value: {
      date: dayKey,
      start: range.start,
      end: range.end,
      title,
      course: course || null,
      room: room || null,
    },
  };
}

// ------------------------------------------------------- presentational ---

export function AttendancePrompt({
  value,
  label,
  onChoose,
}: {
  value?: Attendance | undefined;
  label: string;
  onChoose: (value: Attendance) => void;
}): ReactNode {
  return (
    <div className="class-attendance" role="group" aria-label={`Attendance for ${label}`}>
      <span className="class-attendance-label">How did it go?</span>
      {ATTENDANCE_OPTIONS.map((option) => (
        <button
          key={option.value}
          className="button button-secondary class-action"
          type="button"
          data-attendance={option.value}
          aria-pressed={value === option.value}
          onClick={() => onChoose(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function CancelledBar({ label, onRestore }: { label: string; onRestore: () => void }): ReactNode {
  return (
    <div className="class-actions">
      <span className="class-chip class-chip-cancelled">Cancelled</span>
      <button
        className="button button-secondary class-action"
        type="button"
        data-class-action="restore"
        aria-label={`Restore ${label}`}
        onClick={onRestore}
      >
        Restore
      </button>
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  defaultValue,
  required,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
  required?: boolean;
}): ReactNode {
  return (
    <label className="class-field">
      <span>{label}</span>
      <input name={name} type={type} defaultValue={defaultValue} required={required} />
    </label>
  );
}

// -------------------------------------------------------- stateful bits ---

/** Per-class controls inside a timeline row. */
export function ClassRowActions({
  item,
  now,
  api,
  dayKey,
}: {
  item: ScheduleItem;
  now: Date;
  api: ClassActionsApi;
  dayKey: string;
}): ReactNode {
  const [sheet, setSheet] = useState<"menu" | "move" | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const classId = typeof item.meta.classId === "string" ? item.meta.classId : null;
  if (!classId || !item.startAt || !item.endAt) return null;
  const start = item.startAt;
  const end = item.endAt;
  const label = item.title;
  const cancelled = item.meta.cancelled === true;
  const isClass = item.meta.kind === "class";
  const ended = end.getTime() <= now.getTime();
  const attendance = api.attendance[classId];

  const act = async (fn: () => Promise<string | null>, closeSheet = false) => {
    setBusy(true);
    setError("");
    const message = await fn();
    setBusy(false);
    if (message) setError(message);
    else if (closeSheet) setSheet(null);
    return message;
  };

  const onMove = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = parseMoveForm(dayKey, new FormData(event.currentTarget));
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    void act(() => api.move(classId, parsed.start, parsed.end), true);
  };

  const errorLine = error ? (
    <p className="class-error" role="alert">
      {error}
    </p>
  ) : null;

  if (cancelled) {
    return (
      <>
        <CancelledBar label={label} onRestore={() => void act(() => api.restore(classId))} />
        {errorLine}
      </>
    );
  }

  const showPrompt = isClass && ended && (!attendance || editing);

  return (
    <div className="class-controls">
      {showPrompt ? (
        <AttendancePrompt
          value={attendance}
          label={label}
          onChoose={(value) => {
            setEditing(false);
            void act(() => api.setAttendance(classId, value, start));
          }}
        />
      ) : null}
      <div className="class-actions">
        {isClass && ended && attendance && !editing ? (
          <button
            className="class-chip class-chip-attendance"
            type="button"
            data-class-action="change-attendance"
            aria-label={`Attendance for ${label}: ${attendance}. Tap to change`}
            onClick={() => setEditing(true)}
          >
            {ATTENDANCE_OPTIONS.find((o) => o.value === attendance)?.label}
          </button>
        ) : null}
        <button
          className="button button-secondary class-action"
          type="button"
          data-class-action="options"
          aria-label={`Options for ${label}`}
          disabled={busy}
          onClick={() => {
            setError("");
            setSheet("menu");
          }}
        >
          Options
        </button>
      </div>
      {sheet === null ? errorLine : null}
      <Sheet open={sheet !== null} onClose={() => setSheet(null)} title={sheet === "move" ? "Move class" : label}>
        {sheet === "move" ? (
          <form className="class-form" onSubmit={onMove}>
            <Field label="Start (IST)" name="start" type="time" defaultValue={hhmm(start)} required />
            <Field label="End (IST)" name="end" type="time" defaultValue={hhmm(end)} required />
            {errorLine}
            <button className="button button-primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save new time"}
            </button>
          </form>
        ) : (
          <div className="class-form">
            <button
              className="button button-secondary"
              type="button"
              onClick={() => {
                setError("");
                setSheet("move");
              }}
            >
              Move class
            </button>
            <button
              className="button button-secondary"
              type="button"
              data-class-action="cancel"
              disabled={busy}
              onClick={() => void act(() => api.cancel(classId), true)}
            >
              Cancel class
            </button>
            {errorLine}
          </div>
        )}
      </Sheet>
    </div>
  );
}

/** "Add extra class" button plus its sheet, shown near the timeline. */
export function AddExtraClass({ api, dayKey }: { api: ClassActionsApi; dayKey: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = parseExtraForm(dayKey, new FormData(event.currentTarget));
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError("");
    const message = await api.addExtra(parsed.value);
    setBusy(false);
    if (message) setError(message);
    else setOpen(false);
  };

  return (
    <>
      <button
        className="button button-secondary add-class-button"
        type="button"
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        Add extra class
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Add extra class">
        <form className="class-form" onSubmit={(event) => void onSubmit(event)}>
          <Field label="Title" name="title" required />
          <Field label="Start (IST)" name="start" type="time" required />
          <Field label="End (IST)" name="end" type="time" required />
          <Field label="Course (optional)" name="course" />
          <Field label="Room (optional)" name="room" />
          {error ? (
            <p className="class-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="button button-primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Add class"}
          </button>
        </form>
      </Sheet>
    </>
  );
}
