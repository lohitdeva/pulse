import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
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

let flushing: Promise<{ flushed: number; remaining: number }> | null = null;

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
        const query = client.from(row.table);
        const { error } =
          row.op === "upsert"
            ? await query.upsert(
                row.payload,
                row.onConflict ? { onConflict: row.onConflict } : undefined,
              )
            : await query.insert(row.payload);
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
    op: "insert",
    payload: {
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
