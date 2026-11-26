import "fake-indexeddb/auto";
import { reconcileDayLogs, type DayLogRows } from "@pulse/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { offlineDb } from "./offline/db";
import { pendingItemLogs, type ItemLogRowWithMeta } from "./useDayLogs";

const USER = "user-1";
const DAY = "2026-11-26";

beforeEach(async () => {
  await offlineDb.pending.clear();
});

describe("pending item logs and meta", () => {
  it("carries meta.attendance and overrides the server row in reconcile", async () => {
    await offlineDb.pending.add({
      table: "item_logs",
      op: "upsert",
      onConflict: "user_id,day_key,item_key",
      payload: {
        user_id: USER,
        day_key: DAY,
        item_key: "class:c1",
        status: "skipped",
        meta: { attendance: "medical" },
      },
      createdAt: Date.now(),
    });
    const pendingItems = await pendingItemLogs(USER, DAY);
    expect(pendingItems).toEqual([
      { item_key: "class:c1", status: "skipped", meta: { attendance: "medical" } },
    ]);

    const server: DayLogRows = {
      meals: [],
      water: [],
      items: [{ item_key: "class:c1", status: "done", meta: { attendance: "attended" } } as ItemLogRowWithMeta],
    };
    const merged = reconcileDayLogs(server, { meals: [], water: [], items: pendingItems });
    const items = (merged.items ?? []) as ItemLogRowWithMeta[];
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("skipped");
    expect(items[0]?.meta).toEqual({ attendance: "medical" });
  });
});
