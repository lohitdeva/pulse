import type { SupabaseClient } from "@supabase/supabase-js";
import {
  istDateTimeLocalToUtc,
  istParts,
  pulseDayRange,
  templateForDayKey,
  blockInstants,
  type DayPlan,
  type ItemLogStatus,
} from "@pulse/shared";
import { useEffect, useMemo, useState } from "react";
import { offlineDb } from "./offline/db";
import { enqueue, flushQueue, logItem, subscribe } from "./offline/queue";

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

function isKind(value: unknown): value is CheckInKind {
  return value === "morning" || value === "midday" || value === "night";
}

/**
 * Which check-in card Today should show: morning 08:00-12:00, midday 13:30-17:00 IST,
 * hidden once that kind is done. `done` is the kinds completed in the current Pulse day.
 */
export function dueCheckIn(
  now: Date,
  done: Iterable<CheckInKind>,
): "morning" | "midday" | null {
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

/** `?checkin=morning|midday` from a notification or link. */
export function readCheckInParam(search: string): "morning" | "midday" | null {
  const value = new URLSearchParams(search).get("checkin");
  return value === "morning" || value === "midday" ? value : null;
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
