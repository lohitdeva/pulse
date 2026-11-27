import type { SupabaseClient } from "@supabase/supabase-js";
import {
  istDateTimeLocalToUtc,
  istParts,
  pulseDayRange,
  templateForDayKey,
  blockInstants,
  type DayPlan,
  type ItemLogStatus,
  type MealLogRow,
  type MealName,
  type PlanClass,
} from "@pulse/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { offlineDb } from "./offline/db";
import { enqueue, flushQueue, logItem, subscribe } from "./offline/queue";
import { habitItemKey } from "./Today";

export type CheckInKind = "morning" | "midday" | "night";

/** A check-in as shown in the app: a server row or an unsynced queued write. */
export interface CheckInRow {
  kind: CheckInKind;
  payload: Record<string, unknown>;
  completed_at: string | null;
}

export interface MorningInput {
  /** UTC ISO instants. */
  bedtime?: string | undefined;
  wakeTime?: string | undefined;
  mood?: number | undefined;
  energy?: number | undefined;
}

export interface MiddayInput {
  mood?: number | undefined;
}

const MS_HOUR = 3_600_000;
const MORNING_WINDOW: [number, number] = [8 * 60, 12 * 60];
const MIDDAY_WINDOW: [number, number] = [13 * 60 + 30, 17 * 60];
/** Night: 22:30-23:59 and 00:00-03:59 IST. After midnight it still belongs to the Pulse day that just ended. */
const NIGHT_EVENING_START = 22 * 60 + 30;
const NIGHT_EARLY_END = 4 * 60;

function isKind(value: unknown): value is CheckInKind {
  return value === "morning" || value === "midday" || value === "night";
}

/**
 * Which check-in card Today should show: morning 08:00-12:00, midday 13:30-17:00,
 * night 22:30-04:00 IST, hidden once that kind is done. `done` is the kinds completed in
 * the current Pulse day (the 4:00 AM boundary means 00:00-03:59 is still the day that ended).
 */
export function dueCheckIn(now: Date, done: Iterable<CheckInKind>): CheckInKind | null {
  const finished = new Set(done);
  const p = istParts(now);
  const minutes = p.hour * 60 + p.minute;
  if (
    !finished.has("morning") &&
    minutes >= MORNING_WINDOW[0] &&
    minutes < MORNING_WINDOW[1]
  ) {
    return "morning";
  }
  if (
    !finished.has("midday") &&
    minutes >= MIDDAY_WINDOW[0] &&
    minutes < MIDDAY_WINDOW[1]
  ) {
    return "midday";
  }
  if (
    !finished.has("night") &&
    (minutes >= NIGHT_EVENING_START || minutes < NIGHT_EARLY_END)
  ) {
    return "night";
  }
  return null;
}

function validScale(value: number | undefined): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5
  );
}

function validInstant(value: string | undefined): value is string {
  return typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value));
}

/** Only fields the user filled in; skipped fields are left out entirely. */
export function buildMorningPayload(input: MorningInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (validInstant(input.bedtime)) payload.bedtime = input.bedtime;
  if (validInstant(input.wakeTime)) payload.wakeTime = input.wakeTime;
  if (validScale(input.mood)) payload.mood = input.mood;
  if (validScale(input.energy)) payload.energy = input.energy;
  return payload;
}

export function buildMiddayPayload(input: MiddayInput): Record<string, unknown> {
  return validScale(input.mood) ? { mood: input.mood } : {};
}

export interface NightInput {
  wentWell?: string | undefined;
  didntGo?: string | undefined;
  tomorrow?: string | undefined;
  mood?: number | undefined;
}

const REFLECTION_MAX = 1000;

/** `{reflection?: {wentWell?, didntGo?, tomorrow?}, mood?}`; blank answers are left out. */
export function buildNightPayload(input: NightInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const reflection: Record<string, string> = {};
  for (const key of ["wentWell", "didntGo", "tomorrow"] as const) {
    const text = input[key]?.trim().slice(0, REFLECTION_MAX);
    if (text) reflection[key] = text;
  }
  if (Object.keys(reflection).length > 0) payload.reflection = reflection;
  if (validScale(input.mood)) payload.mood = input.mood;
  return payload;
}

/**
 * Bedtime / wake instants to save from the morning form. A default the user never touched
 * or confirmed is not data, so it is dropped.
 */
export function morningTimesToSave(
  dayKey: string,
  times: { bedtime: string; wake: string; bedtimeTouched: boolean; wakeTouched: boolean },
): { bedtime: string | undefined; wakeTime: string | undefined } {
  return {
    bedtime: times.bedtimeTouched
      ? timeInputToInstant(dayKey, times.bedtime, "bedtime")
      : undefined,
    wakeTime: times.wakeTouched ? timeInputToInstant(dayKey, times.wake, "wake") : undefined,
  };
}

/** Default bedtime: 01:00 IST on the Pulse day's calendar date (the previous night's lights-out). */
export function defaultBedtime(dayKey: string): string {
  return new Date(pulseDayRange(dayKey).start.getTime() - 3 * MS_HOUR).toISOString();
}

/** Default wake time: 07:00 IST today. */
export function defaultWakeTime(dayKey: string): string {
  return blockInstants(dayKey, "07:00", "07:00").start.toISOString();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "HH:MM" in IST for an `<input type="time">`. */
export function instantToTimeInput(instant: string): string {
  const p = istParts(new Date(instant));
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

function previousDate(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * IST "HH:MM" from a time input to a UTC instant. A bedtime from noon onwards belongs to
 * the previous calendar date; everything else is on the Pulse day's calendar date.
 */
export function timeInputToInstant(
  dayKey: string,
  hhmm: string,
  which: "bedtime" | "wake",
): string | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  const date = which === "bedtime" && hour >= 12 ? previousDate(dayKey) : dayKey;
  return istDateTimeLocalToUtc(`${date}T${hhmm}`);
}

export interface HygieneItem {
  itemKey: string;
  label: string;
}

/** The morning habit-checklist rows (before the morning check-in block), keyed as Today logs them. */
export function hygieneItems(dayKey: string): HygieneItem[] {
  const blocks = templateForDayKey(dayKey).blocks;
  const checkIn = blocks.find(
    (b) => b.blockType === "check_in" && b.startHHMM !== null,
  );
  const cutoff = checkIn?.startHHMM ?? "08:40";
  return blocks
    .filter(
      (b) =>
        (b.blockType === "habit" || b.blockType === "habit_checklist") &&
        b.startHHMM !== null &&
        b.startHHMM < cutoff,
    )
    .map((b) => ({
      itemKey: `habit:${dayKey}:${b.sortOrder}`,
      label: b.title.replace(/\s*\(.*\)\s*$/, ""),
    }));
}

/** Draft statuses that differ from what is already logged. */
export function hygieneChanges(
  draft: Record<string, "done" | "skipped" | undefined>,
  existing: Record<string, ItemLogStatus | undefined>,
): Array<{ itemKey: string; status: "done" | "skipped" }> {
  const changes: Array<{ itemKey: string; status: "done" | "skipped" }> = [];
  for (const [itemKey, status] of Object.entries(draft)) {
    if (status && existing[itemKey] !== status) changes.push({ itemKey, status });
  }
  return changes;
}

export interface PlanSummaryRow {
  key: string;
  startAt: Date | null;
  title: string;
}

/** Compact "today's plan": real classes and fixed must-dos (no fillable regions, no cancelled classes). */
export function planSummary(plan: DayPlan): PlanSummaryRow[] {
  return plan.items
    .filter((item) => {
      if (item.source === "class") return item.meta.cancelled !== true;
      return (
        item.blockType === "must_do" &&
        item.meta.fillable !== true &&
        item.meta.newsReading !== true
      );
    })
    .map((item) => ({
      key: `${item.sortOrder}`,
      startAt: item.startAt,
      title: item.title,
    }));
}

/** `?checkin=morning|midday|night` from a notification or link. */
export function readCheckInParam(search: string): CheckInKind | null {
  const value = new URLSearchParams(search).get("checkin");
  return isKind(value) ? value : null;
}

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** Queue an upsert of one check-in row, then flush when online. */
export async function saveCheckIn(
  userId: string,
  dayKey: string,
  kind: CheckInKind,
  payload: Record<string, unknown>,
  client: SupabaseClient | null = null,
): Promise<void> {
  await enqueue({
    table: "check_ins",
    op: "upsert",
    onConflict: "user_id,day_key,kind",
    payload: {
      user_id: userId,
      day_key: dayKey,
      kind,
      payload,
      completed_at: new Date().toISOString(),
    },
  });
  if (client && isOnline()) await flushQueue(client);
}

/** Hygiene ticks go through the habit `item_logs` path; then the check-in itself. */
export async function saveMorningCheckIn(
  userId: string,
  dayKey: string,
  input: MorningInput,
  hygiene: Array<{ itemKey: string; status: "done" | "skipped" }>,
  client: SupabaseClient | null = null,
): Promise<void> {
  for (const { itemKey, status } of hygiene) {
    await logItem(userId, dayKey, itemKey, status, null);
  }
  await saveCheckIn(userId, dayKey, "morning", buildMorningPayload(input), client);
}

export async function saveMiddayCheckIn(
  userId: string,
  dayKey: string,
  input: MiddayInput,
  client: SupabaseClient | null = null,
): Promise<void> {
  await saveCheckIn(userId, dayKey, "midday", buildMiddayPayload(input), client);
}

export async function saveNightCheckIn(
  userId: string,
  dayKey: string,
  input: NightInput,
  client: SupabaseClient | null = null,
): Promise<void> {
  await saveCheckIn(userId, dayKey, "night", buildNightPayload(input), client);
}

// ------------------------------------------------------- night: unlogged sweep ---

export const MISSED_REASONS = [
  { value: "overslept", label: "Overslept" },
  { value: "busy", label: "Busy / ran late" },
  { value: "unwell", label: "Not feeling well" },
  { value: "forgot", label: "Forgot" },
  { value: "chose_to_skip", label: "Chose to skip" },
  { value: "other", label: "Other" },
] as const;

export type MissedReason = (typeof MISSED_REASONS)[number]["value"];

export interface UnloggedItem {
  itemKey: string;
  title: string;
  kind: "must" | "habit" | "class";
  startAt: Date;
  /** Set for mess meals: Done goes through the meal logger, which needs a place. */
  meal: MealName | null;
  /** Set for classes. */
  classId: string | null;
}

export interface SweepDayLogs {
  itemLogs: ReadonlyArray<{ item_key: string }>;
  mealLogs: ReadonlyArray<MealLogRow>;
}

/** A `reminders` row's resolution for one item. */
export interface ReminderResolution {
  item_key: string;
  resolution: string | null;
}

/** A dispatcher-written `missed_items` row. */
export interface MissedRow {
  day_key: string;
  item_key: string;
  title: string;
  reason: string | null;
}

function mealOfTitle(title: string): MealName | null {
  const m = /^\s*(breakfast|lunch|snacks|dinner)\b/i.exec(title);
  return m ? (m[1]!.toLowerCase() as MealName) : null;
}

/**
 * Items of the plan's day that are must-do / habit / class, have already started, and
 * have no log, attendance, reminder resolution or missed-log row: what the night
 * check-in asks "done or missed?" about. Sorted by start time.
 */
export function unloggedItems(
  plan: DayPlan,
  classes: readonly PlanClass[],
  dayLogs: SweepDayLogs,
  reminders: readonly ReminderResolution[],
  missed: readonly MissedRow[],
  now: Date,
): UnloggedItem[] {
  const logged = new Set(dayLogs.itemLogs.map((l) => l.item_key));
  const loggedMeals = new Set(dayLogs.mealLogs.map((m) => m.meal));
  const resolved = new Set(
    reminders.filter((r) => r.resolution).map((r) => r.item_key),
  );
  const missedKeys = new Set(
    missed.filter((m) => m.day_key === plan.dayKey).map((m) => m.item_key),
  );
  const cancelled = new Set(classes.filter((c) => c.cancelled).map((c) => c.id));
  const out: UnloggedItem[] = [];

  for (const item of plan.items) {
    if (!item.startAt || item.startAt.getTime() > now.getTime()) continue;
    let itemKey: string | null;
    let kind: UnloggedItem["kind"] = "must";
    let meal: MealName | null = null;
    let classId: string | null = null;
    let title = item.title;

    if (item.source === "class") {
      classId = typeof item.meta.classId === "string" ? item.meta.classId : null;
      if (!classId || item.meta.cancelled === true || cancelled.has(classId)) continue;
      itemKey = `class:${classId}`;
      kind = "class";
      if (resolved.has(`${itemKey}:attendance`)) continue;
    } else if (item.blockType === "must_do") {
      if (item.meta.fillable === true || item.meta.newsReading === true) continue;
      itemKey = `must:${plan.dayKey}:${item.templateBlockSortOrder ?? `s${item.sortOrder}`}`;
      meal = mealOfTitle(item.title);
      if (meal && loggedMeals.has(meal)) continue;
    } else {
      itemKey = habitItemKey(plan.dayKey, item);
      kind = "habit";
      if (item.meta.newsReading === true) title = "News reading";
    }
    if (!itemKey) continue;
    if (logged.has(itemKey) || resolved.has(itemKey) || missedKeys.has(itemKey)) continue;
    out.push({ itemKey, title, kind, startAt: item.startAt, meal, classId });
  }
  return out.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

/** Queue a Missed log (with the reason) for an unlogged item. Classes also get `meta.attendance`. */
export async function markItemMissed(
  userId: string,
  dayKey: string,
  item: Pick<UnloggedItem, "itemKey" | "kind">,
  reason: MissedReason,
  client: SupabaseClient | null = null,
): Promise<void> {
  await enqueue({
    table: "item_logs",
    op: "upsert",
    onConflict: "user_id,day_key,item_key",
    payload: {
      user_id: userId,
      day_key: dayKey,
      item_key: item.itemKey,
      status: "missed",
      logged_at: new Date().toISOString(),
      meta: item.kind === "class" ? { attendance: "missed", reason } : { reason },
    },
  });
  if (client && isOnline()) await flushQueue(client);
}

/**
 * Reason for a dispatcher-marked Missed item. The signed-in role may only UPDATE
 * `missed_items.reason / reason_at` (no insert, so it cannot go through the upsert-only
 * offline queue); this is a direct write that reports failure to the caller.
 */
export async function setMissedReason(
  client: SupabaseClient,
  userId: string,
  row: Pick<MissedRow, "day_key" | "item_key">,
  reason: MissedReason,
): Promise<boolean> {
  try {
    const { error } = await client
      .from("missed_items")
      .update({ reason, reason_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("day_key", row.day_key)
      .eq("item_key", row.item_key);
    return !error;
  } catch {
    return false;
  }
}

/** Resolutions of today's reminders and reason-less missed items for today and yesterday. */
export function useNightData(
  client: SupabaseClient | null,
  userId: string,
  dayKey: string,
  enabled: boolean,
): { reminders: ReminderResolution[]; missed: MissedRow[]; refetch: () => void } {
  const [data, setData] = useState<{ reminders: ReminderResolution[]; missed: MissedRow[] }>({
    reminders: [],
    missed: [],
  });
  const [tick, setTick] = useState(0);
  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!enabled || !client) return;
    let active = true;
    void (async () => {
      try {
        const [reminders, missed] = await Promise.all([
          client
            .from("reminders")
            .select("item_key, resolution")
            .eq("user_id", userId)
            .eq("day_key", dayKey)
            .not("resolution", "is", null),
          client
            .from("missed_items")
            .select("day_key, item_key, title, reason")
            .eq("user_id", userId)
            .in("day_key", [previousDate(dayKey), dayKey])
            .is("reason", null)
            .order("missed_at", { ascending: true }),
        ]);
        if (!active || reminders.error || missed.error) return;
        setData({
          reminders: (reminders.data ?? []) as ReminderResolution[],
          missed: (missed.data ?? []) as MissedRow[],
        });
      } catch {
        // Offline: keep the last snapshot.
      }
    })();
    return () => {
      active = false;
    };
  }, [client, userId, dayKey, enabled, tick]);

  return { ...data, refetch };
}

/** Unsynced check-in writes for one user and day; later writes win per kind. */
export async function pendingCheckIns(
  userId: string,
  dayKey: string,
): Promise<CheckInRow[]> {
  const rows = await offlineDb.pending.orderBy("id").toArray();
  const byKind = new Map<CheckInKind, CheckInRow>();
  for (const row of rows) {
    const p = row.payload;
    if (
      row.table !== "check_ins" ||
      p.user_id !== userId ||
      p.day_key !== dayKey ||
      !isKind(p.kind)
    ) {
      continue;
    }
    byKind.set(p.kind, {
      kind: p.kind,
      payload:
        p.payload && typeof p.payload === "object"
          ? (p.payload as Record<string, unknown>)
          : {},
      completed_at: typeof p.completed_at === "string" ? p.completed_at : null,
    });
  }
  return [...byKind.values()];
}

/** Pending (unsynced) rows override the server row of the same kind. */
export function mergeCheckIns(
  server: CheckInRow[],
  pending: CheckInRow[],
): CheckInRow[] {
  const byKind = new Map<CheckInKind, CheckInRow>();
  for (const row of server) byKind.set(row.kind, row);
  for (const row of pending) byKind.set(row.kind, row);
  return [...byKind.values()];
}

/** Today's check-ins = last server snapshot reconciled with queued writes (same pattern as `useDayLogs`). */
export function useCheckIns(
  client: SupabaseClient | null,
  userId: string,
  dayKey: string,
): { checkIns: CheckInRow[]; done: CheckInKind[] } {
  const [server, setServer] = useState<CheckInRow[]>([]);
  const [pending, setPending] = useState<CheckInRow[]>([]);

  useEffect(() => {
    setServer([]);
    setPending([]);
  }, [userId, dayKey]);

  useEffect(() => {
    let active = true;
    let seq = 0;

    const load = async () => {
      const mine = ++seq;
      let nextPending: CheckInRow[] | null = null;
      try {
        nextPending = await pendingCheckIns(userId, dayKey);
      } catch {
        // IndexedDB unavailable: keep the current pending view.
      }
      let nextServer: CheckInRow[] | null = null;
      if (client) {
        try {
          const { data, error } = await client
            .from("check_ins")
            .select("kind, payload, completed_at")
            .eq("user_id", userId)
            .eq("day_key", dayKey);
          if (!error) {
            nextServer = ((data ?? []) as unknown as CheckInRow[]).filter((r) =>
              isKind(r.kind),
            );
          }
        } catch {
          // Offline: keep the last server snapshot.
        }
      }
      if (!active || mine !== seq) return;
      if (nextPending) setPending(nextPending);
      if (nextServer) setServer(nextServer);
    };

    void load();
    const reload = () => void load();
    const unsubscribe = subscribe(reload);
    window.addEventListener("online", reload);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("online", reload);
    };
  }, [client, userId, dayKey]);

  const checkIns = useMemo(() => mergeCheckIns(server, pending), [server, pending]);
  const done = useMemo(
    () => checkIns.filter((r) => r.completed_at).map((r) => r.kind),
    [checkIns],
  );
  return { checkIns, done };
}
