import "fake-indexeddb/auto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addExtraClass,
  cancelClass,
  logAttendance,
  moveClass,
  restoreClass,
} from "./classOverrides";
import { offlineDb } from "./offline/db";

function mockClient(error: { message: string } | null = null) {
  const eq = vi.fn(() => Promise.resolve({ error }));
  const update = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ update }));
  const rpc = vi.fn(() => Promise.resolve({ data: "new-id", error }));
  const upsert = vi.fn(() => Promise.resolve({ error: null }));
  return {
    client: { from, rpc } as unknown as SupabaseClient,
    from,
    update,
    eq,
    rpc,
    upsert,
  };
}

beforeEach(async () => {
  await offlineDb.pending.clear();
  vi.unstubAllGlobals();
});

describe("manual class operations", () => {
  it("cancel clears time overrides and sets the state", async () => {
    const m = mockClient();
    await cancelClass(m.client, "c1");
    expect(m.from).toHaveBeenCalledWith("classes");
    expect(m.update).toHaveBeenCalledWith({
      manual_state: "cancelled",
      manual_starts_at: null,
      manual_ends_at: null,
    });
    expect(m.eq).toHaveBeenCalledWith("id", "c1");
  });

  it("restore clears every manual column", async () => {
    const m = mockClient();
    await restoreClass(m.client, "c1");
    expect(m.update).toHaveBeenCalledWith({
      manual_state: "none",
      manual_starts_at: null,
      manual_ends_at: null,
      manual_title: null,
    });
  });

  it("move writes ISO times and only manual columns", async () => {
    const m = mockClient();
    await moveClass(
      m.client,
      "c1",
      new Date("2026-11-26T06:00:00Z"),
      new Date("2026-11-26T07:30:00Z"),
    );
    expect(m.update).toHaveBeenCalledWith({
      manual_state: "moved",
      manual_starts_at: "2026-11-26T06:00:00.000Z",
      manual_ends_at: "2026-11-26T07:30:00.000Z",
    });
  });

  it("move rejects an end that is not after the start", async () => {
    const m = mockClient();
    const t = new Date("2026-11-26T06:00:00Z");
    await expect(moveClass(m.client, "c1", t, t)).rejects.toThrow();
    expect(m.update).not.toHaveBeenCalled();
  });

  it("surfaces database errors", async () => {
    const m = mockClient({ message: "denied" });
    await expect(cancelClass(m.client, "c1")).rejects.toEqual({ message: "denied" });
  });

  it("addExtraClass calls the RPC with trimmed values and returns the id", async () => {
    const m = mockClient();
    const id = await addExtraClass(m.client, {
      date: "2026-11-26",
      start: new Date("2026-11-26T08:00:00Z"),
      end: new Date("2026-11-26T09:00:00Z"),
      title: "  Extra review ",
      course: "MKT",
    });
    expect(id).toBe("new-id");
    expect(m.rpc).toHaveBeenCalledWith("add_extra_class", {
      p_date: "2026-11-26",
      p_starts_at: "2026-11-26T08:00:00.000Z",
      p_ends_at: "2026-11-26T09:00:00.000Z",
      p_title: "Extra review",
      p_course: "MKT",
      p_room: null,
    });
  });

  it("addExtraClass rejects a blank title", async () => {
    const m = mockClient();
    await expect(
      addExtraClass(m.client, {
        date: "2026-11-26",
        start: new Date("2026-11-26T08:00:00Z"),
        end: new Date("2026-11-26T09:00:00Z"),
        title: "  ",
      }),
    ).rejects.toThrow();
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe("logAttendance", () => {
  const start = new Date("2026-11-26T04:00:00Z");

  it.each([
    ["attended", "done"],
    ["missed", "missed"],
    ["medical", "skipped"],
    ["cancelled", "skipped"],
  ] as const)("stores %s as status %s with meta.attendance", async (att, status) => {
    await logAttendance("u1", "c1", att, start);
    const [row] = await offlineDb.pending.toArray();
    expect(row?.table).toBe("item_logs");
    expect(row?.onConflict).toBe("user_id,day_key,item_key");
    expect(row?.payload).toMatchObject({
      user_id: "u1",
      day_key: "2026-11-26",
      item_key: "class:c1",
      status,
      meta: { attendance: att },
    });
  });

  it("uses the Pulse day for a class that starts after midnight", async () => {
    await logAttendance("u1", "c1", "attended", new Date("2026-11-26T19:00:00Z"));
    const [row] = await offlineDb.pending.toArray();
    expect(row?.payload.day_key).toBe("2026-11-26");
  });

  it("flushes right away when a client is given", async () => {
    const upsert = vi.fn(() => Promise.resolve({ error: null }));
    const client = { from: () => ({ upsert, insert: upsert }) } as unknown as SupabaseClient;
    await logAttendance("u1", "c1", "medical", start, client);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(await offlineDb.pending.count()).toBe(0);
  });
});
