import "fake-indexeddb/auto";
import { buildDayPlan, currentPulseDayKey, templateForDayKey } from "@pulse/shared";
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
  buildNightPayload,
  markItemMissed,
  MISSED_REASONS,
  morningTimesToSave,
  setMissedReason,
  unloggedItems,
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

  it("shows night from 22:30 to 03:59 IST, across midnight", () => {
    expect(dueCheckIn(ist("22:29"), [])).toBeNull();
    expect(dueCheckIn(ist("22:30"), [])).toBe("night");
    expect(dueCheckIn(ist("23:59"), [])).toBe("night");
    expect(dueCheckIn(ist("00:00", "2026-11-28"), [])).toBe("night");
    expect(dueCheckIn(ist("00:30", "2026-11-28"), [])).toBe("night");
    expect(dueCheckIn(ist("03:59", "2026-11-28"), [])).toBe("night");
  });

  it("drops the night card at the 4 AM day boundary", () => {
    // 04:00 starts a new Pulse day with nothing done, but it is before morning's 08:00.
    expect(dueCheckIn(ist("04:00", "2026-11-28"), [])).toBeNull();
    expect(dueCheckIn(ist("07:59", "2026-11-28"), [])).toBeNull();
    expect(dueCheckIn(ist("08:00", "2026-11-28"), [])).toBe("morning");
  });

  it("hides night once done for the Pulse day", () => {
    expect(dueCheckIn(ist("23:00"), ["night"])).toBeNull();
    expect(dueCheckIn(ist("00:30", "2026-11-28"), ["night"])).toBeNull();
    expect(dueCheckIn(ist("23:00"), ["morning", "midday"])).toBe("night");
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
  it("accepts morning, midday or night", () => {
    expect(readCheckInParam("?checkin=morning")).toBe("morning");
    expect(readCheckInParam("?a=1&checkin=midday")).toBe("midday");
    expect(readCheckInParam("?checkin=night")).toBe("night");
    expect(readCheckInParam("?checkin=other")).toBeNull();
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

describe("morning defaults", () => {
  const base = { bedtime: "01:00", wake: "07:00" };

  it("saves neither default when the user touched nothing", () => {
    const times = morningTimesToSave(DAY, { ...base, bedtimeTouched: false, wakeTouched: false });
    expect(times).toEqual({ bedtime: undefined, wakeTime: undefined });
    expect(buildMorningPayload({ ...times, mood: 3 })).toEqual({ mood: 3 });
  });

  it("saves only the times that were edited or confirmed", () => {
    expect(
      morningTimesToSave(DAY, { ...base, bedtimeTouched: true, wakeTouched: false }),
    ).toEqual({ bedtime: "2026-11-26T19:30:00.000Z", wakeTime: undefined });
    expect(
      morningTimesToSave(DAY, { ...base, bedtimeTouched: false, wakeTouched: true }),
    ).toEqual({ bedtime: undefined, wakeTime: "2026-11-27T01:30:00.000Z" });
  });
});

describe("buildNightPayload", () => {
  it("is empty when nothing was filled in", () => {
    expect(buildNightPayload({})).toEqual({});
    expect(buildNightPayload({ wentWell: "  ", mood: 9 })).toEqual({});
  });

  it("keeps trimmed reflection answers and a valid mood", () => {
    expect(
      buildNightPayload({ wentWell: " Gym ", didntGo: "", tomorrow: "Case prep", mood: 4 }),
    ).toEqual({ reflection: { wentWell: "Gym", tomorrow: "Case prep" }, mood: 4 });
  });
});

describe("unloggedItems", () => {
  const cls = (id: string, start: string, end: string, cancelled = false) => ({
    id,
    kind: "class" as const,
    title: `Class ${id}`,
    startAt: ist(start),
    endAt: ist(end),
    course: "MKT",
    room: null,
    session: null,
    professor: null,
    cancelled,
  });
  const classes = [cls("c1", "10:00", "11:00"), cls("c2", "11:30", "12:30", true)];
  const plan = buildDayPlan(templateForDayKey(DAY), DAY, [], classes);
  const nothing = { itemLogs: [], mealLogs: [] };
  const run = (
    now: Date,
    logs: Parameters<typeof unloggedItems>[2] = nothing,
    reminders: Parameters<typeof unloggedItems>[3] = [],
    missed: Parameters<typeof unloggedItems>[4] = [],
  ) => unloggedItems(plan, classes, logs, reminders, missed, now);
  const titles = (rows: ReturnType<typeof run>) => rows.map((r) => r.title);

  it("lists only items that have already started, in time order", () => {
    expect(run(ist("06:00"))).toEqual([]);
    const midday = run(ist("14:00"));
    expect(titles(midday)).toContain("Class c1");
    expect(titles(midday).some((t) => /^Lunch/.test(t))).toBe(true);
    const times = midday.map((r) => r.startAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const early = run(ist("10:30"));
    expect(titles(early)).toContain("Class c1");
    expect(titles(early).some((t) => /^Dinner/.test(t))).toBe(false);
    expect(titles(run(ist("21:05"))).some((t) => /^Dinner/.test(t))).toBe(true);
  });

  it("keys items as Today and the dispatcher do", () => {
    const rows = run(ist("22:00"));
    const c1 = rows.find((r) => r.classId === "c1")!;
    expect(c1).toMatchObject({ itemKey: "class:c1", kind: "class" });
    const lunch = rows.find((r) => r.meal === "lunch")!;
    expect(lunch.itemKey).toMatch(new RegExp(`^must:${DAY}:`));
    const habit = rows.find((r) => r.kind === "habit")!;
    expect(habit.itemKey).toMatch(new RegExp(`^habit:${DAY}:`));
  });

  it("leaves out cancelled classes and fillable timetable regions", () => {
    const rows = run(ist("22:00"));
    expect(titles(rows)).not.toContain("Class c2");
    expect(titles(rows).some((t) => t.startsWith("Classes from the timetable"))).toBe(false);
  });

  it("leaves out items with an item log (done, skipped or missed)", () => {
    const rows = run(ist("22:00"));
    const habit = rows.find((r) => r.kind === "habit")!;
    const must = rows.find((r) => r.kind === "must" && !r.meal)!;
    const after = run(ist("22:00"), {
      itemLogs: [{ item_key: habit.itemKey }, { item_key: must.itemKey }],
      mealLogs: [],
    });
    expect(after.map((r) => r.itemKey)).not.toContain(habit.itemKey);
    expect(after.map((r) => r.itemKey)).not.toContain(must.itemKey);
    expect(after.length).toBe(rows.length - 2);
  });

  it("leaves out classes with attendance and meals with a meal log", () => {
    const rows = run(ist("22:00"));
    const after = run(ist("22:00"), {
      itemLogs: [{ item_key: "class:c1" }],
      mealLogs: [{ meal: "lunch", place: "mess" }],
    });
    expect(after.map((r) => r.itemKey)).not.toContain("class:c1");
    expect(after.some((r) => r.meal === "lunch")).toBe(false);
    expect(after.length).toBe(rows.length - 2);
  });

  it("leaves out items with a resolved reminder, but not an unresolved one", () => {
    const rows = run(ist("22:00"));
    const must = rows.find((r) => r.kind === "must" && !r.meal)!;
    const resolved = run(ist("22:00"), nothing, [
      { item_key: must.itemKey, resolution: "going_to_sleep" },
      { item_key: "class:c1:attendance", resolution: "done" },
    ]);
    expect(resolved.map((r) => r.itemKey)).not.toContain(must.itemKey);
    expect(resolved.map((r) => r.itemKey)).not.toContain("class:c1");
    const open = run(ist("22:00"), nothing, [{ item_key: must.itemKey, resolution: null }]);
    expect(open.map((r) => r.itemKey)).toContain(must.itemKey);
  });

  it("leaves out items already on the missed log for this day only", () => {
    const rows = run(ist("22:00"));
    const must = rows.find((r) => r.kind === "must" && !r.meal)!;
    const today = run(ist("22:00"), nothing, [], [
      { day_key: DAY, item_key: must.itemKey, title: must.title, reason: null },
    ]);
    expect(today.map((r) => r.itemKey)).not.toContain(must.itemKey);
    const yesterday = run(ist("22:00"), nothing, [], [
      { day_key: "2026-11-26", item_key: must.itemKey, title: must.title, reason: null },
    ]);
    expect(yesterday.map((r) => r.itemKey)).toContain(must.itemKey);
  });
});

describe("missed reasons", () => {
  it("offers the six one-tap reasons", () => {
    expect(MISSED_REASONS.map((r) => r.label)).toEqual([
      "Overslept",
      "Busy / ran late",
      "Not feeling well",
      "Forgot",
      "Chose to skip",
      "Other",
    ]);
  });

  it("queues a missed item_log with the reason in meta", async () => {
    const client = {} as never;
    await markItemMissed(USER, DAY, { itemKey: `must:${DAY}:5`, kind: "must" }, "forgot", client);
    const mutation = (queue.enqueue.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(mutation).toMatchObject({
      table: "item_logs",
      op: "upsert",
      onConflict: "user_id,day_key,item_key",
      payload: {
        user_id: USER,
        day_key: DAY,
        item_key: `must:${DAY}:5`,
        status: "missed",
        meta: { reason: "forgot" },
      },
    });
    expect(queue.flushQueue).toHaveBeenCalledWith(client);
  });

  it("marks a missed class as attendance missed too", async () => {
    await markItemMissed(USER, DAY, { itemKey: "class:c1", kind: "class" }, "busy", null);
    const mutation = (queue.enqueue.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(mutation).toMatchObject({
      payload: { item_key: "class:c1", status: "missed", meta: { attendance: "missed", reason: "busy" } },
    });
    expect(queue.flushQueue).not.toHaveBeenCalled();
  });

  it("updates only the reason columns of an existing missed_items row", async () => {
    const eq3 = vi.fn(async () => ({ error: null }));
    const eq2 = vi.fn(() => ({ eq: eq3 }));
    const eq1 = vi.fn(() => ({ eq: eq2 }));
    const update = vi.fn(() => ({ eq: eq1 }));
    const from = vi.fn(() => ({ update }));
    const ok = await setMissedReason(
      { from } as never,
      USER,
      { day_key: DAY, item_key: "class:c1" },
      "unwell",
    );
    expect(ok).toBe(true);
    expect(from).toHaveBeenCalledWith("missed_items");
    const patch = (update.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(Object.keys(patch).sort()).toEqual(["reason", "reason_at"]);
    expect(patch.reason).toBe("unwell");
    expect(eq1).toHaveBeenCalledWith("user_id", USER);
    expect(eq2).toHaveBeenCalledWith("day_key", DAY);
    expect(eq3).toHaveBeenCalledWith("item_key", "class:c1");
  });

  it("reports failure instead of throwing", async () => {
    const eq3 = vi.fn(async () => ({ error: { message: "x" } }));
    const client = { from: () => ({ update: () => ({ eq: () => ({ eq: () => ({ eq: eq3 }) }) }) }) };
    expect(await setMissedReason(client as never, USER, { day_key: DAY, item_key: "a" }, "other")).toBe(false);
  });
});

describe("night sweep day key", () => {
  it("uses the previous Pulse day between 00:00 and 03:59 IST", () => {
    expect(currentPulseDayKey(ist("00:30", "2026-11-28"))).toBe("2026-11-27");
    expect(currentPulseDayKey(ist("03:59", "2026-11-28"))).toBe("2026-11-27");
  });

  it("rolls to the new day at 04:00 IST", () => {
    expect(currentPulseDayKey(ist("04:00", "2026-11-28"))).toBe("2026-11-28");
  });
});
