import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import type { MealLogRow, WaterLogRow } from "@pulse/shared";
import { offlineDb, type PendingMutation } from "./db";

export type NewMutation = Omit<PendingMutation, "id" | "createdAt">;

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export async function enqueue(mutation: NewMutation): Promise<number> {
  const id = (await offlineDb.pending.add({
    ...mutation,
    createdAt: Date.now(),
  })) as number;
  notify();
  return id;
}

export function pendingCount(): Promise<number> {
  return offlineDb.pending.count();
}

/** Unsynced meal/water writes for one user and day, in enqueue order. */
export async function pendingDayLogs(
  userId: string,
  dayKey: string,
): Promise<{ meals: MealLogRow[]; water: WaterLogRow[] }> {
  const rows = await offlineDb.pending.orderBy("id").toArray();
  const meals: MealLogRow[] = [];
  const water: WaterLogRow[] = [];
  for (const row of rows) {
    const p = row.payload;
    if (p.user_id !== userId || p.day_key !== dayKey) continue;
    if (row.table === "meal_logs") {
      meals.push({
        meal: p.meal as MealLogRow["meal"],
        place: p.place as MealLogRow["place"],
      });
    } else if (row.table === "water_logs") {
      water.push({
        ...(typeof p.id === "string" ? { id: p.id } : {}),
        amount_ml: Number(p.amount_ml),
        is_gym: p.is_gym === true,
        ...(typeof p.logged_at === "string" ? { logged_at: p.logged_at } : {}),
      });
    }
  }
  return { meals, water };
}

let flushing: Promise<{ flushed: number; remaining: number }> | null = null;

function isLegacyWaterPayload(
  payload: Record<string, unknown>,
): payload is Record<string, unknown> & {
  user_id: string;
  day_key: string;
  amount_ml: number;
  is_gym: boolean;
  logged_at: string;
} {
  return (
    typeof payload.id !== "string" &&
    typeof payload.user_id === "string" &&
    typeof payload.day_key === "string" &&
    typeof payload.amount_ml === "number" &&
    typeof payload.is_gym === "boolean" &&
    typeof payload.logged_at === "string"
  );
}

async function prepareWaterMutation(
  client: SupabaseClient,
  row: PendingMutation,
): Promise<PendingMutation> {
  if (row.table !== "water_logs") return row;

  let id = typeof row.payload.id === "string" ? row.payload.id : undefined;
  if (!id && isLegacyWaterPayload(row.payload)) {
    const { data, error } = await client
      .from("water_logs")
      .select("id")
      .eq("user_id", row.payload.user_id)
      .eq("day_key", row.payload.day_key)
      .eq("amount_ml", row.payload.amount_ml)
      .eq("is_gym", row.payload.is_gym)
      .eq("logged_at", row.payload.logged_at)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    id = typeof data?.id === "string" ? data.id : undefined;
    if (!id) id = crypto.randomUUID();
  }

  if (!id) return row;
  if (row.op === "upsert" && row.onConflict === "id") return row;
  if (row.id === undefined)
    throw new Error("Water queue row is missing its local id");

  const payload = { ...row.payload, id };
  await offlineDb.pending.update(row.id, {
    op: "upsert",
    onConflict: "id",
    payload,
  });
  return { ...row, op: "upsert", onConflict: "id", payload };
}

async function runFlush(
  client: SupabaseClient,
): Promise<{ flushed: number; remaining: number }> {
  let flushed = 0;
  let stopped = false;
  // Re-read the queue after each pass so rows enqueued mid-flush are sent too.
  // A failed row stops the loop, so a persistent error cannot spin.
  while (!stopped && isOnline()) {
    const rows = await offlineDb.pending.orderBy("id").toArray();
    if (rows.length === 0) break;
    for (const row of rows) {
      try {
        const mutation = await prepareWaterMutation(client, row);
        const query = client.from(mutation.table);
        const { error } =
          mutation.op === "upsert"
            ? await query.upsert(
                mutation.payload,
                mutation.onConflict
                  ? { onConflict: mutation.onConflict }
                  : undefined,
              )
            : await query.insert(mutation.payload);
        if (error) {
          stopped = true;
          break;
        }
      } catch {
        stopped = true;
        break;
      }
      if (row.id !== undefined) await offlineDb.pending.delete(row.id);
      flushed += 1;
    }
  }
  const remaining = await pendingCount();
  notify();
  return { flushed, remaining };
}

/** Sends queued writes in id order; stops at the first failure so order is kept. */
export function flushQueue(
  client: SupabaseClient,
): Promise<{ flushed: number; remaining: number }> {
  if (flushing) return flushing;
  flushing = runFlush(client).finally(() => {
    flushing = null;
  });
  return flushing;
}

async function enqueueAndFlush(
  client: SupabaseClient | null,
  mutation: NewMutation,
): Promise<number> {
  const id = await enqueue(mutation);
  if (client && isOnline()) await flushQueue(client);
  return id;
}

export function logItem(
  userId: string,
  dayKey: string,
  itemKey: string,
  status: "done" | "skipped" | "missed",
  client: SupabaseClient | null = null,
): Promise<number> {
  return enqueueAndFlush(client, {
    table: "item_logs",
    op: "upsert",
    onConflict: "user_id,day_key,item_key",
    payload: {
      user_id: userId,
      day_key: dayKey,
      item_key: itemKey,
      status,
      logged_at: new Date().toISOString(),
    },
  });
}

export function logMeal(
  userId: string,
  dayKey: string,
  meal: "breakfast" | "lunch" | "snacks" | "dinner",
  place: "mess" | "outside" | "ordered_in",
  client: SupabaseClient | null = null,
): Promise<number> {
  return enqueueAndFlush(client, {
    table: "meal_logs",
    op: "upsert",
    onConflict: "user_id,day_key,meal",
    payload: {
      user_id: userId,
      day_key: dayKey,
      meal,
      place,
      logged_at: new Date().toISOString(),
    },
  });
}

export function logWater(
  userId: string,
  dayKey: string,
  amountMl: number,
  isGym: boolean,
  client: SupabaseClient | null = null,
): Promise<number> {
  return enqueueAndFlush(client, {
    table: "water_logs",
    op: "upsert",
    onConflict: "id",
    payload: {
      id: crypto.randomUUID(),
      user_id: userId,
      day_key: dayKey,
      amount_ml: amountMl,
      is_gym: isGym,
      logged_at: new Date().toISOString(),
    },
  });
}

export function usePendingCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      pendingCount()
        .then((next) => {
          if (active) setCount(next);
        })
        .catch(() => {
          // IndexedDB unavailable: leave the dot as is.
        });
    };
    refresh();
    const unsubscribe = subscribe(refresh);
    window.addEventListener("online", refresh);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("online", refresh);
    };
  }, []);

  return count;
}
