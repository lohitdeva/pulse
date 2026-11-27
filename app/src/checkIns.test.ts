import "fake-indexeddb/auto";
import { buildDayPlan, templateForDayKey } from "@pulse/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { offlineDb } from "./offline/db";

const queue = vi.hoisted(() => ({
  enqueue: vi.fn(async () => 1),
  flushQueue: vi.fn(async () => ({ flushed: 0, remaining: 0 })),
  logItem: vi.fn(async () => 1),
  subscribe: vi.fn(() => () => {}),
}));
vi.mock("./offline/queue", () => queue);

import {
  buildMiddayPayload,
  buildMorningPayload,
  defaultBedtime,
  defaultWakeTime,
  dueCheckIn,
  hygieneChanges,
  hygieneItems,
  instantToTimeInput,
  mergeCheckIns,
  pendingCheckIns,
  planSummary,
  readCheckInParam,
  saveCheckIn,
  saveMorningCheckIn,
  timeInputToInstant,
} from "./checkIns";
import { habitItemKey } from "./Today";

const DAY = "2026-11-27";
const USER = "user-1";
const ist = (hhmm: string, date = DAY) => new Date(`${date}T${hhmm}:00+05:30`);

beforeEach(async () => {
  vi.clearAllMocks();
  await offlineDb.pending.clear();
});

describe("dueCheckIn", () => {
  it("shows morning from 08:00 to 12:00 IST", () => {
    expect(dueCheckIn(ist("07:59"), [])).toBeNull();
    expect(dueCheckIn(ist("08:00"), [])).toBe("morning");
    expect(dueCheckIn(ist("11:59"), [])).toBe("morning");
    expect(dueCheckIn(ist("12:00"), [])).toBeNull();
  });

  it("shows midday from 13:30 to 17:00 IST", () => {
    expect(dueCheckIn(ist("13:29"), [])).toBeNull();
    expect(dueCheckIn(ist("13:30"), [])).toBe("midday");
    expect(dueCheckIn(ist("16:59"), [])).toBe("midday");
    expect(dueCheckIn(ist("17:00"), [])).toBeNull();
  });

  it("hides a card once that kind is done", () => {
    expect(dueCheckIn(ist("09:00"), ["morning"])).toBeNull();
    expect(dueCheckIn(ist("14:00"), ["morning"])).toBe("midday");
    expect(dueCheckIn(ist("14:00"), ["midday"])).toBeNull();
  });

  it("is quiet around the 4 AM day boundary", () => {
    expect(dueCheckIn(ist("00:30", "2026-11-28"), [])).toBeNull();
    expect(dueCheckIn(ist("03:59", "2026-11-28"), [])).toBeNull();
    // The new Pulse day starts with nothing done, but 04:00 is still before 08:00.
    expect(dueCheckIn(ist("04:00", "2026-11-28"), [])).toBeNull();
    expect(dueCheckIn(ist("08:00", "2026-11-28"), [])).toBe("morning");
  });
});

describe("payload builders", () => {
  it("skips empty and invalid morning fields", () => {
    expect(buildMorningPayload({})).toEqual({});
    expect(
      buildMorningPayload({
        bedtime: "",
        wakeTime: undefined,
        mood: 0,
        energy: 6,
      }),
    ).toEqual({});
    expect(
      buildMorningPayload({
        bedtime: "2026-11-26T19:30:00.000Z",
        wakeTime: "2026-11-27T01:30:00.000Z",
        mood: 4,
        energy: 2,
      }),
    ).toEqual({
      bedtime: "2026-11-26T19:30:00.000Z",
      wakeTime: "2026-11-27T01:30:00.000Z",
      mood: 4,
      energy: 2,
    });
  });

  it("builds a midday payload with only a valid mood", () => {
    expect(buildMiddayPayload({})).toEqual({});
    expect(buildMiddayPayload({ mood: 3.5 })).toEqual({});
    expect(buildMiddayPayload({ mood: 5 })).toEqual({ mood: 5 });
  });
});

describe("time defaults and inputs", () => {
  it("defaults bedtime to 01:00 IST at the start of the Pulse day's calendar date", () => {
    expect(defaultBedtime(DAY)).toBe("2026-11-26T19:30:00.000Z");
    expect(instantToTimeInput(defaultBedtime(DAY))).toBe("01:00");
  });

  it("defaults wake time to 07:00 IST today", () => {
    expect(defaultWakeTime(DAY)).toBe("2026-11-27T01:30:00.000Z");
    expect(instantToTimeInput(defaultWakeTime(DAY))).toBe("07:00");
  });

  it("puts a late-evening bedtime on the previous calendar date", () => {
    expect(timeInputToInstant(DAY, "23:30", "bedtime")).toBe("2026-11-26T18:00:00.000Z");
    expect(timeInputToInstant(DAY, "01:15", "bedtime")).toBe("2026-11-26T19:45:00.000Z");
    expect(timeInputToInstant(DAY, "06:45", "wake")).toBe("2026-11-27T01:15:00.000Z");
  });

  it("returns undefined for empty or malformed time input", () => {
    expect(timeInputToInstant(DAY, "", "wake")).toBeUndefined();
    expect(timeInputToInstant(DAY, "25:99", "wake")).toBeUndefined();
  });
});

describe("hygiene items", () => {
  it("are the morning habit rows and use the Today habit keys", () => {
    const items = hygieneItems(DAY);
    expect(items.map((i) => i.label)).toEqual([
      "Brush and freshen up",
      "Walk",
      "Shower and get ready",
    ]);
    const plan = buildDayPlan(templateForDayKey(DAY), DAY);
    const keys = plan.items
      .map((item) => habitItemKey(DAY, item))
      .filter((k): k is string => k !== null);
    for (const item of items) expect(keys).toContain(item.itemKey);
  });

  it("only reports statuses that changed", () => {
    const [a, b, c] = hygieneItems(DAY);
    expect(
      hygieneChanges(
        { [a!.itemKey]: "done", [b!.itemKey]: "skipped", [c!.itemKey]: undefined },
        { [a!.itemKey]: "done", [b!.itemKey]: "done" },
      ),
    ).toEqual([{ itemKey: b!.itemKey, status: "skipped" }]);
  });
});

describe("planSummary", () => {
  it("lists classes and must-dos, not cancelled classes or fillable regions", () => {
    const plan = buildDayPlan(templateForDayKey(DAY), DAY, [], [
      {
        id: "c1",
        kind: "class",
        title: "Marketing",
        startAt: ist("10:00"),
        endAt: ist("11:00"),
        course: "MKT",
        room: "R1",
        session: 1,
        professor: null,
        cancelled: false,
      },
      {
        id: "c2",
        kind: "class",
        title: "Finance",
        startAt: ist("11:30"),
        endAt: ist("12:30"),
        course: "FIN",
        room: null,
        session: null,
        professor: null,
        cancelled: true,
      },
    ]);
    const titles = planSummary(plan).map((r) => r.title);
    expect(titles).toContain("Marketing");
    expect(titles).not.toContain("Finance");
    expect(titles).toContain("Lunch");
    expect(titles.some((t) => t.startsWith("Classes from the timetable"))).toBe(false);
  });
});

describe("readCheckInParam", () => {
  it("accepts only morning or midday", () => {
    expect(readCheckInParam("?checkin=morning")).toBe("morning");
    expect(readCheckInParam("?a=1&checkin=midday")).toBe("midday");
    expect(readCheckInParam("?checkin=night")).toBeNull();
    expect(readCheckInParam("")).toBeNull();
  });
});

describe("saving", () => {
  it("enqueues a check_ins upsert on (user_id, day_key, kind) and flushes", async () => {
    const client = {} as never;
    await saveCheckIn(USER, DAY, "midday", { mood: 4 }, client);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    const mutation = (queue.enqueue.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(mutation).toMatchObject({
      table: "check_ins",
      op: "upsert",
      onConflict: "user_id,day_key,kind",
      payload: { user_id: USER, day_key: DAY, kind: "midday", payload: { mood: 4 } },
    });
    expect(typeof (mutation.payload as Record<string, unknown>).completed_at).toBe("string");
    expect(queue.flushQueue).toHaveBeenCalledWith(client);
  });

  it("does not flush without a client", async () => {
    await saveCheckIn(USER, DAY, "morning", {}, null);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.flushQueue).not.toHaveBeenCalled();
  });

  it("morning save logs changed hygiene items then the check-in", async () => {
    const [a, b] = hygieneItems(DAY);
    await saveMorningCheckIn(
      USER,
      DAY,
      { mood: 3, wakeTime: "2026-11-27T01:30:00.000Z" },
      [
        { itemKey: a!.itemKey, status: "done" },
        { itemKey: b!.itemKey, status: "skipped" },
      ],
      null,
    );
    expect(queue.logItem).toHaveBeenCalledTimes(2);
    expect(queue.logItem).toHaveBeenNthCalledWith(1, USER, DAY, a!.itemKey, "done", null);
    expect(queue.logItem).toHaveBeenNthCalledWith(2, USER, DAY, b!.itemKey, "skipped", null);
    const mutation = (queue.enqueue.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(mutation).toMatchObject({
      table: "check_ins",
      payload: {
        kind: "morning",
        payload: { mood: 3, wakeTime: "2026-11-27T01:30:00.000Z" },
      },
    });
  });
});

describe("offline read model", () => {
  it("reads pending check-ins for one user and day", async () => {
    const add = (payload: Record<string, unknown>) =>
      offlineDb.pending.add({
        table: "check_ins",
        op: "upsert",
        onConflict: "user_id,day_key,kind",
        payload,
        createdAt: Date.now(),
      });
    await add({ user_id: USER, day_key: DAY, kind: "morning", payload: { mood: 2 }, completed_at: "2026-11-27T03:00:00.000Z" });
    await add({ user_id: USER, day_key: "2026-11-26", kind: "morning", payload: {}, completed_at: "x" });
    await add({ user_id: "other", day_key: DAY, kind: "midday", payload: {}, completed_at: "x" });
    await offlineDb.pending.add({ table: "item_logs", op: "upsert", payload: { user_id: USER, day_key: DAY }, createdAt: 1 });
    expect(await pendingCheckIns(USER, DAY)).toEqual([
      { kind: "morning", payload: { mood: 2 }, completed_at: "2026-11-27T03:00:00.000Z" },
    ]);
  });

  it("lets pending rows override server rows per kind", () => {
    const merged = mergeCheckIns(
      [
        { kind: "morning", payload: { mood: 1 }, completed_at: "a" },
        { kind: "midday", payload: {}, completed_at: "b" },
      ],
      [{ kind: "morning", payload: { mood: 5 }, completed_at: "c" }],
    );
    expect(merged).toEqual([
      { kind: "morning", payload: { mood: 5 }, completed_at: "c" },
      { kind: "midday", payload: {}, completed_at: "b" },
    ]);
  });
});
