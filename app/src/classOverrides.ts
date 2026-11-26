import type { SupabaseClient } from "@supabase/supabase-js";
import { pulseDayKey } from "@pulse/shared";
import { enqueue, flushQueue } from "./offline/queue";

/**
 * Manual class changes (PRD section 4). RLS lets the owner update only the
 * manual_* columns of `public.classes`; new extra classes go through the
 * `add_extra_class` RPC. Reconcile never undoes these unless the sheet's own
 * cell changes.
 */

export type Attendance = "attended" | "missed" | "medical" | "cancelled";

export type ExtraClassInput = {
  /** Pulse day key (YYYY-MM-DD) the class belongs to. */
  date: string;
  start: Date;
  end: Date;
  title: string;
  course?: string | null;
  room?: string | null;
};

function assertRange(start: Date, end: Date) {
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end.getTime() <= start.getTime()
  ) {
    throw new Error("A class must end after it starts");
  }
}

async function updateManual(
  client: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.from("classes").update(patch).eq("id", id);
  if (error) throw error;
}

/** Cancelled classes carry no time override (DB constraint), so clear it. */
export function cancelClass(client: SupabaseClient, id: string): Promise<void> {
  return updateManual(client, id, {
    manual_state: "cancelled",
    manual_starts_at: null,
    manual_ends_at: null,
  });
}

/** Back to the sheet's version: clears every manual override. */
export function restoreClass(client: SupabaseClient, id: string): Promise<void> {
  return updateManual(client, id, {
    manual_state: "none",
    manual_starts_at: null,
    manual_ends_at: null,
    manual_title: null,
  });
}

export async function moveClass(
  client: SupabaseClient,
  id: string,
  start: Date,
  end: Date,
): Promise<void> {
  assertRange(start, end);
  await updateManual(client, id, {
    manual_state: "moved",
    manual_starts_at: start.toISOString(),
    manual_ends_at: end.toISOString(),
  });
}

/** Adds a manual-origin class the sheet doesn't show; returns its id. */
export async function addExtraClass(
  client: SupabaseClient,
  input: ExtraClassInput,
): Promise<string> {
  assertRange(input.start, input.end);
  const title = input.title.trim();
  if (!title) throw new Error("A class needs a title");
  const { data, error } = await client.rpc("add_extra_class", {
    p_date: input.date,
    p_starts_at: input.start.toISOString(),
    p_ends_at: input.end.toISOString(),
    p_title: title,
    p_course: input.course ?? null,
    p_room: input.room ?? null,
  });
  if (error) throw error;
  return data as string;
}

/**
 * `item_logs.status` only allows done/skipped/missed, so the four attendance
 * outcomes are stored as a coarse status plus the exact value in
 * `meta.attendance` (medical stays distinguishable from a plain skip).
 */
export const ATTENDANCE_STATUS: Record<Attendance, "done" | "skipped" | "missed"> = {
  attended: "done",
  missed: "missed",
  medical: "skipped",
  cancelled: "skipped",
};

/** Queues an attendance log offline-first; the day is the class's Pulse day. */
export async function logAttendance(
  userId: string,
  classId: string,
  attendance: Attendance,
  classStart: Date,
  client: SupabaseClient | null = null,
): Promise<number> {
  const id = await enqueue({
    table: "item_logs",
    op: "upsert",
    onConflict: "user_id,day_key,item_key",
    payload: {
      user_id: userId,
      day_key: pulseDayKey(classStart),
      item_key: `class:${classId}`,
      status: ATTENDANCE_STATUS[attendance],
      logged_at: new Date().toISOString(),
      meta: { attendance },
    },
  });
  if (client && (typeof navigator === "undefined" || navigator.onLine !== false)) {
    await flushQueue(client);
  }
  return id;
}
