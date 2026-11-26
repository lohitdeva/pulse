import type { SupabaseClient } from "@supabase/supabase-js";
import {
  pulseDayRange,
  type PlanClass,
  type PlanInterval,
} from "@pulse/shared";
import { useEffect, useState } from "react";

/** Subset of `public.classes` that Today reads. */
export type ClassRow = {
  id: string;
  kind: "class" | "exam" | "event";
  source_date: string;
  source_starts_at: string;
  source_ends_at: string;
  source_title: string;
  source_course: string | null;
  source_session: number | null;
  source_professor: string | null;
  source_room: string | null;
  source_present: boolean;
  manual_state: "none" | "cancelled" | "moved" | "edited";
  manual_starts_at: string | null;
  manual_ends_at: string | null;
  manual_title: string | null;
};

/** Subset of `public.timetable_change_alerts` that Today reads. */
export type ChangeAlert = {
  id: string;
  class_id: string;
  change_type: "added" | "removed" | "moved" | "restored" | "changed";
  summary: string;
  queued_at: string;
  delivered_at: string | null;
};

const CLASS_COLUMNS =
  "id,kind,source_date,source_starts_at,source_ends_at,source_title,source_course,source_session,source_professor,source_room,source_present,manual_state,manual_starts_at,manual_ends_at,manual_title";
const ALERT_COLUMNS = "id,class_id,change_type,summary,queued_at,delivered_at";

/**
 * Resolve a stored row to its effective class: manual times/title win over the
 * sheet's. Rows removed from the sheet with no manual state are dropped (null).
 */
export function rowToPlanClass(row: ClassRow): PlanClass | null {
  if (!row.source_present && row.manual_state === "none") return null;
  const start = row.manual_starts_at ?? row.source_starts_at;
  const end = row.manual_ends_at ?? row.source_ends_at;
  return {
    id: row.id,
    kind: row.kind,
    title: row.manual_title ?? row.source_title,
    startAt: new Date(start),
    endAt: new Date(end),
    course: row.source_course,
    room: row.source_room,
    session: row.source_session,
    professor: row.source_professor,
    cancelled: row.manual_state === "cancelled",
  };
}

/** Effective classes for a Pulse day, sorted by start, whose time falls inside it. */
export function mapClassRows(rows: ClassRow[], dayKey: string): PlanClass[] {
  const { start, end } = pulseDayRange(dayKey);
  return rows
    .map(rowToPlanClass)
    .filter(
      (c): c is PlanClass =>
        c !== null &&
        c.startAt.getTime() >= start.getTime() &&
        c.startAt.getTime() < end.getTime(),
    )
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

/** Intervals that block other plan items: every class except cancelled ones. */
export function busyFromClasses(classes: PlanClass[]): PlanInterval[] {
  return classes
    .filter((c) => !c.cancelled)
    .map((c) => ({ start: c.startAt, end: c.endAt }));
}

export async function fetchDayClasses(
  client: SupabaseClient,
  dayKey: string,
): Promise<PlanClass[]> {
  const { data, error } = await client
    .from("classes")
    .select(CLASS_COLUMNS)
    .eq("source_date", dayKey)
    .order("source_starts_at", { ascending: true });
  if (error) throw error;
  return mapClassRows((data ?? []) as ClassRow[], dayKey);
}

export async function fetchDayAlerts(
  client: SupabaseClient,
  dayKey: string,
): Promise<ChangeAlert[]> {
  const { start, end } = pulseDayRange(dayKey);
  const { data, error } = await client
    .from("timetable_change_alerts")
    .select(ALERT_COLUMNS)
    .gte("queued_at", start.toISOString())
    .lt("queued_at", end.toISOString())
    .order("queued_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ChangeAlert[];
}

/**
 * Read-only classes + change alerts for a Pulse day. Any failure (offline,
 * RLS, missing table) leaves the previous/empty value so Today falls back to
 * the template-only plan.
 */
export function useDayClasses(
  client: SupabaseClient | null,
  dayKey: string,
): { classes: PlanClass[]; alerts: ChangeAlert[] } {
  const [state, setState] = useState<{
    dayKey: string;
    classes: PlanClass[];
    alerts: ChangeAlert[];
  }>({ dayKey, classes: [], alerts: [] });

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const load = () => {
      void Promise.all([
        fetchDayClasses(client, dayKey).catch(() => null),
        fetchDayAlerts(client, dayKey).catch(() => null),
      ]).then(([classes, alerts]) => {
        if (cancelled) return;
        setState((prev) => {
          const same = prev.dayKey === dayKey;
          return {
            dayKey,
            classes: classes ?? (same ? prev.classes : []),
            alerts: alerts ?? (same ? prev.alerts : []),
          };
        });
      });
    };
    load();
    window.addEventListener("online", load);
    return () => {
      cancelled = true;
      window.removeEventListener("online", load);
    };
  }, [client, dayKey]);

  return state.dayKey === dayKey
    ? { classes: state.classes, alerts: state.alerts }
    : { classes: [], alerts: [] };
}
