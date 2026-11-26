export interface WaterLogRow {
  id?: string;
  amount_ml: number;
  is_gym: boolean;
  logged_at?: string;
}

export type MealName = "breakfast" | "lunch" | "snacks" | "dinner";
export type MealPlace = "mess" | "outside" | "ordered_in";

export interface MealLogRow {
  meal: MealName;
  place: MealPlace;
}

/** 2 bottles = 2 L per day (gym water excluded). */
export const WATER_TARGET_ML = 2000;
export const BOTTLE_ML = 1000;
export const MEALS: readonly MealName[] = [
  "breakfast",
  "lunch",
  "snacks",
  "dinner",
];

export function waterTotals(logs: WaterLogRow[]): {
  drankMl: number;
  gymMl: number;
  targetMl: number;
  bottles: number;
  fraction: number;
} {
  let drankMl = 0;
  let gymMl = 0;
  for (const log of logs) {
    if (log.is_gym) gymMl += log.amount_ml;
    else drankMl += log.amount_ml;
  }
  return {
    drankMl,
    gymMl,
    targetMl: WATER_TARGET_ML,
    bottles: drankMl / BOTTLE_ML,
    fraction: Math.min(1, Math.max(0, drankMl / WATER_TARGET_ML)),
  };
}

export function mealsSummary(logs: MealLogRow[]): {
  logged: number;
  total: number;
  byMeal: Record<MealName, MealPlace | null>;
  eatingOut: number;
} {
  const byMeal: Record<MealName, MealPlace | null> = {
    breakfast: null,
    lunch: null,
    snacks: null,
    dinner: null,
  };
  for (const log of logs) {
    if (MEALS.includes(log.meal)) byMeal[log.meal] = log.place;
  }
  let logged = 0;
  let eatingOut = 0;
  for (const meal of MEALS) {
    const place = byMeal[meal];
    if (place === null) continue;
    logged += 1;
    if (place === "outside" || place === "ordered_in") eatingOut += 1;
  }
  return { logged, total: MEALS.length, byMeal, eatingOut };
}

export interface DayLogRows {
  meals: MealLogRow[];
  water: WaterLogRow[];
}

/**
 * Server snapshot merged with writes still waiting in the offline queue.
 * Water is append-only (server + pending). Meals are upserts: a pending meal
 * replaces the server row for that meal; the last pending entry wins.
 */
export function reconcileDayLogs(
  server: DayLogRows,
  pending: DayLogRows,
): DayLogRows {
  const pendingByMeal = new Map<MealName, MealLogRow>();
  for (const row of pending.meals) pendingByMeal.set(row.meal, row);
  const meals = [
    ...server.meals.filter((row) => !pendingByMeal.has(row.meal)),
    ...pendingByMeal.values(),
  ];
  const water = [...server.water];
  const seenIds = new Set(
    server.water.flatMap((row) => (row.id ? [row.id] : [])),
  );
  const serverLegacyKeys = new Set(
    server.water.flatMap((row) => (row.id ? [] : [legacyWaterKey(row)])),
  );
  const serverEventKeys = new Set(server.water.map(legacyWaterKey));
  for (const row of pending.water) {
    const key = legacyWaterKey(row);
    if (row.id && seenIds.has(row.id)) continue;
    if (row.id && key && serverLegacyKeys.has(key)) continue;
    if (!row.id && key && serverEventKeys.has(key)) continue;
    water.push(row);
    if (row.id) seenIds.add(row.id);
  }
  return { meals, water };
}

function legacyWaterKey(row: WaterLogRow): string | null {
  if (!row.logged_at) return null;
  const timestamp = Date.parse(row.logged_at);
  if (!Number.isFinite(timestamp)) return null;
  return `${timestamp}:${row.amount_ml}:${row.is_gym}`;
}
