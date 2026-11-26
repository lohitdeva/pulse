import type { SupabaseClient } from "@supabase/supabase-js";
import {
  reconcileDayLogs,
  type DayLogRows,
  type ItemLogRow,
  type ItemLogStatus,
  type MealLogRow,
  type MealName,
  type MealPlace,
  type WaterLogRow,
} from "@pulse/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { offlineDb } from "./offline/db";
import {
  logItem,
  logMeal,
  logWater,
  pendingDayLogs,
  subscribe,
} from "./offline/queue";

export interface DayLogs {
  mealLogs: MealLogRow[];
  waterLogs: WaterLogRow[];
  itemLogs: ItemLogRow[];
}

const EMPTY_ROWS: DayLogRows = { meals: [], water: [], items: [] };

async function pendingItemLogs(
  userId: string,
  dayKey: string,
): Promise<ItemLogRow[]> {
  const rows = await offlineDb.pending.orderBy("id").toArray();
  return rows.flatMap((row) => {
    const payload = row.payload;
    if (
      row.table !== "item_logs" ||
      payload.user_id !== userId ||
      payload.day_key !== dayKey ||
      typeof payload.item_key !== "string" ||
      (payload.status !== "done" &&
        payload.status !== "skipped" &&
        payload.status !== "missed")
    ) {
      return [];
    }
    return [
      { item_key: payload.item_key, status: payload.status as ItemLogStatus },
    ];
  });
}

/**
 * Displayed logs = last server snapshot reconciled with writes still queued
 * offline. Writes only enqueue; the queue subscription re-reads pending and
 * re-fetches the server snapshot, so entries never vanish while unsynced.
 */
export function useDayLogs(
  client: SupabaseClient | null,
  userId: string,
  dayKey: string,
): {
  logs: DayLogs;
  addWater: (amountMl: number, isGym: boolean) => void;
  setMeal: (meal: MealName, place: MealPlace) => void;
  setItemStatus: (itemKey: string, status: "done" | "skipped") => void;
  refetch: () => void;
} {
  const [server, setServer] = useState<DayLogRows>(EMPTY_ROWS);
  const [pending, setPending] = useState<DayLogRows>(EMPTY_ROWS);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // New day or user: drop the previous snapshot.
    setServer(EMPTY_ROWS);
    setPending(EMPTY_ROWS);
  }, [userId, dayKey]);

  useEffect(() => {
    let active = true;
    let seq = 0;

    const load = async () => {
      const mine = ++seq;
      // Read pending first: if a flush lands in between, the entry may show
      // twice for a moment (corrected by the post-flush reload), never vanish.
      let nextPending: DayLogRows | null = null;
      try {
        const [rows, items] = await Promise.all([
          pendingDayLogs(userId, dayKey),
          pendingItemLogs(userId, dayKey),
        ]);
        nextPending = { ...rows, items };
      } catch {
        // IndexedDB unavailable: keep the current pending view.
      }
      let nextServer: DayLogRows | null = null;
      if (client) {
        try {
          const [meals, water, items] = await Promise.all([
            client
              .from("meal_logs")
              .select("meal, place")
              .eq("user_id", userId)
              .eq("day_key", dayKey),
            client
              .from("water_logs")
              .select("id, amount_ml, is_gym, logged_at")
              .eq("user_id", userId)
              .eq("day_key", dayKey),
            client
              .from("item_logs")
              .select("item_key, status")
              .eq("user_id", userId)
              .eq("day_key", dayKey),
          ]);
          if (!meals.error && !water.error && !items.error) {
            nextServer = {
              meals: (meals.data ?? []) as MealLogRow[],
              water: (water.data ?? []) as WaterLogRow[],
              items: (items.data ?? []) as ItemLogRow[],
            };
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
  }, [client, userId, dayKey, tick]);

  const logs = useMemo<DayLogs>(() => {
    const merged = reconcileDayLogs(server, pending);
    return {
      mealLogs: merged.meals,
      waterLogs: merged.water,
      itemLogs: merged.items ?? [],
    };
  }, [server, pending]);

  const addWater = useCallback(
    (amountMl: number, isGym: boolean) => {
      void logWater(userId, dayKey, amountMl, isGym, client).catch(() => {
        // Stays queued; the next flush retries.
      });
    },
    [client, userId, dayKey],
  );

  const setMeal = useCallback(
    (meal: MealName, place: MealPlace) => {
      void logMeal(userId, dayKey, meal, place, client).catch(() => {
        // Stays queued; the next flush retries.
      });
    },
    [client, userId, dayKey],
  );

  const setItemStatus = useCallback(
    (itemKey: string, status: "done" | "skipped") => {
      void logItem(userId, dayKey, itemKey, status, client).catch(() => {
        // Stays queued; the next flush retries.
      });
    },
    [client, userId, dayKey],
  );

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  return { logs, addWater, setMeal, setItemStatus, refetch };
}
