import Dexie, { type EntityTable } from "dexie";

export type LogTable = "item_logs" | "meal_logs" | "water_logs";

export type PendingMutation = {
  id?: number;
  table: LogTable;
  op: "insert" | "upsert";
  payload: Record<string, unknown>;
  onConflict?: string;
  createdAt: number;
};

export type PulseOfflineDb = Dexie & {
  pending: EntityTable<PendingMutation, "id">;
};

export const offlineDb = new Dexie("PulseOffline") as PulseOfflineDb;
offlineDb.version(1).stores({ pending: "++id" });
