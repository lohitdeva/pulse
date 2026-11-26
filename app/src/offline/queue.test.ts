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
  return {
    client: { from } as unknown as SupabaseClient,
    from,
    insert,
    upsert,
  };
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
    expect(row?.op).toBe("upsert");
    expect(row?.table).toBe("water_logs");
    expect(row?.onConflict).toBe("id");
    expect(row?.payload).toMatchObject({
      id: expect.any(String),
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
    const { client, upsert } = mockClient();
    await logWater("u1", "2026-11-26", 1000, false, client);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(await pendingCount()).toBe(0);
  });

  it("retries a water write with the same id after the server accepted it but the ack was lost", async () => {
    const serverRows = new Map<string, Record<string, unknown>>();
    const attemptedIds: string[] = [];
    const makeClient = (result: Result) => {
      const upsert = vi.fn(async (payload: Record<string, unknown>) => {
        const id = payload.id as string;
        attemptedIds.push(id);
        serverRows.set(id, payload);
        return result;
      });
      return {
        client: {
          from: vi.fn(() => ({ insert: vi.fn(), upsert })),
        } as unknown as SupabaseClient,
        upsert,
      };
    };

    const first = makeClient({ error: { message: "ack lost" } });
    await logWater("u1", "2026-11-26", 1000, false, first.client);
    const [queued] = await offlineDb.pending.toArray();
    const stableId = queued?.payload.id;

    expect(stableId).toEqual(expect.any(String));
    expect(serverRows.size).toBe(1);
    expect(await pendingCount()).toBe(1);

    const retry = makeClient({ error: null });
    await flushQueue(retry.client);

    expect(retry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: stableId }),
      { onConflict: "id" },
    );
    expect(attemptedIds).toEqual([stableId, stableId]);
    expect(serverRows.size).toBe(1);
    expect(await pendingCount()).toBe(0);
  });

  it("migrates an already-enqueued legacy water event to the matching remote UUID before retrying", async () => {
    const remoteId = "remote-water-id";
    const loggedAt = "2026-11-26T09:00:00.000Z";
    await enqueue({
      table: "water_logs",
      op: "insert",
      payload: {
        user_id: "u1",
        day_key: "2026-11-26",
        amount_ml: 500,
        is_gym: true,
        logged_at: loggedAt,
      },
    });

    const filters = {
      eq: vi.fn(),
      limit: vi.fn(),
      maybeSingle: vi.fn(async () => ({ data: { id: remoteId }, error: null })),
    };
    filters.eq.mockReturnValue(filters);
    filters.limit.mockReturnValue(filters);
    const select = vi.fn(() => filters);
    const upsert = vi.fn(async () => ({ error: null }));
    const from = vi.fn(() => ({ select, upsert, insert: vi.fn() }));
    const client = { from } as unknown as SupabaseClient;

    await flushQueue(client);

    expect(select).toHaveBeenCalledWith("id");
    expect(filters.eq).toHaveBeenCalledWith("logged_at", loggedAt);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: remoteId, amount_ml: 500 }),
      { onConflict: "id" },
    );
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
