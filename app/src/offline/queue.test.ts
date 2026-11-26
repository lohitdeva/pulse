import "fake-indexeddb/auto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { offlineDb } from "./db";
import {
  enqueue,
  flushQueue,
  logItem,
  logMeal,
  logWater,
  pendingCount,
} from "./queue";

type Result = { error: { message: string } | null };

function mockClient(results: Result[] = []) {
  const insert = vi.fn();
  const upsert = vi.fn();
  const queue = [...results];
  const next = () => Promise.resolve(queue.shift() ?? { error: null });
  insert.mockImplementation(next);
  upsert.mockImplementation(next);
  const from = vi.fn(() => ({ insert, upsert }));
  return { client: { from } as unknown as SupabaseClient, from, insert, upsert };
}

beforeEach(async () => {
  await offlineDb.pending.clear();
  vi.unstubAllGlobals();
});

describe("offline queue", () => {
  it("enqueue adds a pending row", async () => {
    await enqueue({ table: "water_logs", op: "insert", payload: { a: 1 } });
    expect(await pendingCount()).toBe(1);
  });

  it("flush clears the queue on success", async () => {
    const { client, from, insert, upsert } = mockClient();
    await enqueue({ table: "water_logs", op: "insert", payload: { a: 1 } });
    await enqueue({
      table: "item_logs",
      op: "upsert",
      payload: { b: 2 },
      onConflict: "user_id,day_key,item_key",
    });
    const result = await flushQueue(client);
    expect(result).toEqual({ flushed: 2, remaining: 0 });
    expect(from).toHaveBeenNthCalledWith(1, "water_logs");
    expect(from).toHaveBeenNthCalledWith(2, "item_logs");
    expect(insert).toHaveBeenCalledWith({ a: 1 });
    expect(upsert).toHaveBeenCalledWith(
      { b: 2 },
      { onConflict: "user_id,day_key,item_key" },
    );
    expect(await pendingCount()).toBe(0);
  });

  it("flush stops on error and keeps the failed and later rows in order", async () => {
    const { client, insert } = mockClient([
      { error: null },
      { error: { message: "boom" } },
    ]);
    for (const n of [1, 2, 3]) {
      await enqueue({ table: "water_logs", op: "insert", payload: { n } });
    }
    const result = await flushQueue(client);
    expect(result).toEqual({ flushed: 1, remaining: 2 });
    expect(insert).toHaveBeenCalledTimes(2);
    const left = await offlineDb.pending.orderBy("id").toArray();
    expect(left.map((row) => row.payload.n)).toEqual([2, 3]);
  });

  it("flush is a no-op while offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { client, from } = mockClient();
    await enqueue({ table: "water_logs", op: "insert", payload: { a: 1 } });
    const result = await flushQueue(client);
    expect(result).toEqual({ flushed: 0, remaining: 1 });
    expect(from).not.toHaveBeenCalled();
  });

  it("logWater marks gym water and inserts", async () => {
    await logWater("u1", "2026-11-26", 500, true);
    const [row] = await offlineDb.pending.toArray();
    expect(row?.op).toBe("insert");
    expect(row?.table).toBe("water_logs");
    expect(row?.payload).toMatchObject({
      user_id: "u1",
      day_key: "2026-11-26",
      amount_ml: 500,
      is_gym: true,
    });
  });

  it("logItem and logMeal use the right conflict targets", async () => {
    await logItem("u1", "2026-11-26", "gym", "done");
    await logMeal("u1", "2026-11-26", "lunch", "mess");
    const [item, meal] = await offlineDb.pending.orderBy("id").toArray();
    expect(item?.onConflict).toBe("user_id,day_key,item_key");
    expect(item?.payload).toMatchObject({ item_key: "gym", status: "done" });
    expect(meal?.onConflict).toBe("user_id,day_key,meal");
    expect(meal?.payload).toMatchObject({ meal: "lunch", place: "mess" });
  });

  it("log helpers flush right away when a client is given and online", async () => {
    const { client, insert } = mockClient();
    await logWater("u1", "2026-11-26", 1000, false, client);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(await pendingCount()).toBe(0);
  });

  it("flush retains the row and resolves when the client throws", async () => {
    const insert = vi.fn(() => Promise.reject(new Error("network down")));
    const client = {
      from: vi.fn(() => ({ insert, upsert: insert })),
    } as unknown as SupabaseClient;
    await enqueue({ table: "water_logs", op: "insert", payload: { n: 1 } });
    await enqueue({ table: "water_logs", op: "insert", payload: { n: 2 } });
    await expect(flushQueue(client)).resolves.toEqual({
      flushed: 0,
      remaining: 2,
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("flush sends rows enqueued while a flush is in flight", async () => {
    let release: (value: Result) => void = () => {};
    const gate = new Promise<Result>((resolve) => {
      release = resolve;
    });
    const insert = vi
      .fn()
      .mockImplementationOnce(() => gate)
      .mockImplementation(() => Promise.resolve({ error: null }));
    const client = {
      from: vi.fn(() => ({ insert, upsert: insert })),
    } as unknown as SupabaseClient;
    await enqueue({ table: "water_logs", op: "insert", payload: { n: 1 } });
    const first = flushQueue(client);
    await vi.waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
    await enqueue({ table: "water_logs", op: "insert", payload: { n: 2 } });
    const second = flushQueue(client);
    release({ error: null });
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toEqual({ flushed: 2, remaining: 0 });
    expect(r2).toEqual(r1);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(await pendingCount()).toBe(0);
  });
});
