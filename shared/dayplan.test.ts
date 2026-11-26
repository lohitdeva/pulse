import { describe, expect, it } from "vitest";
import {
  buildDayPlan,
  nowNext,
  templateForDayKey,
  type ScheduleItem,
} from "./dayplan";
import { WEEKDAY_TEMPLATE, WEEKEND_TEMPLATE } from "./schedule";
import { blockInstants } from "./time";

const DAY = "2026-11-26";
const byTitle = (items: ScheduleItem[], prefix: string) =>
  items.find((i) => i.title.startsWith(prefix));
const news = (items: ScheduleItem[]) =>
  items.filter((i) => i.meta.newsReading === true);
const key = (i: ScheduleItem) => (i.startAt ?? i.endAt)!.getTime();

describe("buildDayPlan weekday", () => {
  const plan = buildDayPlan(WEEKDAY_TEMPLATE, DAY);

  it("emits template blocks minus the news block, plus news items", () => {
    expect(plan.dayKey).toBe(DAY);
    expect(plan.items).toHaveLength(WEEKDAY_TEMPLATE.blocks.length - 1 + 1);
    expect(plan.items.map((i) => i.sortOrder)).toEqual(
      plan.items.map((_, i) => i),
    );
    expect(plan.items.every((i) => i.source === "template")).toBe(true);
  });

  it("resolves instants", () => {
    const gym = byTitle(plan.items, "Gym")!;
    const g = blockInstants(DAY, "19:30", "20:45");
    expect(gym.startAt).toEqual(g.start);
    expect(gym.endAt).toEqual(g.end);
    const call = byTitle(plan.items, "Personal call")!;
    expect(call.endAt!.getTime()).toBeGreaterThan(call.startAt!.getTime());
    expect(call.endAt).toEqual(blockInstants(DAY, "22:30", "00:30").end);
    // 00:30 IST on the next calendar day = 19:00 UTC on DAY
    expect(call.endAt!.toISOString()).toBe("2026-11-26T19:00:00.000Z");
  });

  it("point blocks have no end", () => {
    for (const prefix of [
      "Wake up",
      "Morning check-in",
      "Lunch",
      "Midday check-in",
      "Snacks",
      "Revision",
      "Lights out",
    ]) {
      const item = byTitle(plan.items, prefix)!;
      expect(item.startAt).not.toBeNull();
      expect(item.endAt).toBeNull();
    }
  });

  it("is sorted ascending with cross-midnight blocks last", () => {
    const keys = plan.items.map(key);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
    expect(plan.items.at(-1)!.title).toBe("Lights out");
  });

  it("places news into one 40 min slot with nothing left over", () => {
    expect(plan.newsLeftoverMinutes).toEqual({});
    const items = news(plan.items);
    expect(items).toHaveLength(1);
    const slot = blockInstants(DAY, "09:30", "10:10");
    expect(items[0]!.startAt).toEqual(slot.start);
    expect(items[0]!.endAt).toEqual(slot.end);
    expect(items[0]!.meta.minutes).toBe(40);
    expect(items[0]!.templateBlockSortOrder).toBeNull();
    expect(items[0]!.blockType).toBe("habit");
  });
});

describe("news with classes", () => {
  it("splits across free slots", () => {
    const busy = [
      blockInstants(DAY, "09:30", "11:00"),
      blockInstants(DAY, "11:15", "12:45"),
    ];
    const plan = buildDayPlan(WEEKDAY_TEMPLATE, DAY, busy);
    const items = news(plan.items);
    expect(items.map((i) => i.meta.minutes)).toEqual([15, 25]);
    expect(items[0]!.startAt).toEqual(blockInstants(DAY, "11:00", "11:15").start);
    expect(items[1]!.startAt).toEqual(blockInstants(DAY, "12:45", "13:10").start);
    expect(items[1]!.endAt).toEqual(blockInstants(DAY, "12:45", "13:10").end);
    expect(plan.newsLeftoverMinutes).toEqual({});
  });

  it("reports unplaced minutes per source", () => {
    const plan = buildDayPlan(WEEKDAY_TEMPLATE, DAY, [
      blockInstants(DAY, "09:30", "17:00"),
    ]);
    expect(news(plan.items).map((i) => i.meta.minutes)).toEqual([15]);
    expect(plan.newsLeftoverMinutes).toEqual({ wsj: 25 });
  });
});

describe("buildDayPlan weekend and determinism", () => {
  it("builds with fewer study-block items and the same news rule", () => {
    const weekday = buildDayPlan(WEEKDAY_TEMPLATE, DAY);
    const weekend = buildDayPlan(WEEKEND_TEMPLATE, DAY);
    const study = (p: typeof weekday) =>
      p.items.filter((i) => i.title.startsWith("Study block"));
    const minutes = (p: typeof weekday) =>
      study(p).reduce(
        (sum, i) =>
          sum +
          (i.endAt!.getTime() -
            (i.startAt ?? blockInstants(DAY, "18:00", "18:00").start).getTime()) /
            60_000,
        0,
      );
    expect(minutes(weekend)).toBeLessThan(minutes(weekday));
    expect(news(weekend.items)).toHaveLength(1);
    expect(weekend.newsLeftoverMinutes).toEqual({});
  });

  it("is deterministic", () => {
    const busy = [blockInstants(DAY, "09:30", "11:00")];
    expect(buildDayPlan(WEEKDAY_TEMPLATE, DAY, busy)).toEqual(
      buildDayPlan(WEEKDAY_TEMPLATE, DAY, busy),
    );
  });
});

describe("nowNext", () => {
  const plan = buildDayPlan(WEEKDAY_TEMPLATE, DAY);
  const at = (hhmm: string) => blockInstants(DAY, hhmm, hhmm).start;

  it("returns the current block, fraction and next block", () => {
    const r = nowNext(plan, at("19:45"));
    expect(r.current?.title.startsWith("Gym")).toBe(true);
    expect(r.fraction).toBeGreaterThan(0);
    expect(r.fraction).toBeLessThan(1);
    expect(r.fraction).toBeCloseTo(15 / 75, 5);
    expect(r.next?.title).toBe("Freshen up after the gym");
  });

  it("before the first block: no current, next is Wake up", () => {
    const r = nowNext(plan, at("05:00"));
    expect(r.current).toBeNull();
    expect(r.fraction).toBe(0);
    expect(r.next?.title).toBe("Wake up");
    expect(r.next?.startAt).toEqual(at("07:00"));
  });

  it("in a gap between blocks: no current, next is upcoming", () => {
    const r = nowNext(plan, at("17:20"));
    expect(r.current).toBeNull();
    expect(r.next?.title).toBe("Snacks");
  });

  it("after Lights out there is no next", () => {
    const r = nowNext(plan, new Date(at("01:00").getTime() + 60_000));
    expect(r.next).toBeNull();
    expect(r.current).toBeNull();
  });

  it("picks the latest-starting item when blocks overlap", () => {
    const r = nowNext(plan, at("08:42"));
    expect(r.current?.title).toBe("Shower and get ready");
    const overlap = nowNext(plan, at("09:00"));
    expect(overlap.current?.title.startsWith("Breakfast")).toBe(true);
  });

  it("start is inclusive and end is exclusive", () => {
    expect(nowNext(plan, at("19:30")).current?.title.startsWith("Gym")).toBe(
      true,
    );
    expect(nowNext(plan, at("20:45")).current?.title).toBe(
      "Freshen up after the gym",
    );
  });
});

describe("templateForDayKey", () => {
  it("uses the weekday template Monday to Friday", () => {
    expect(templateForDayKey("2026-11-26")).toBe(WEEKDAY_TEMPLATE); // Thursday
    expect(templateForDayKey("2026-11-23")).toBe(WEEKDAY_TEMPLATE); // Monday
    expect(templateForDayKey("2026-11-27")).toBe(WEEKDAY_TEMPLATE); // Friday
  });

  it("uses the weekend template on Saturday and Sunday", () => {
    expect(templateForDayKey("2026-11-28")).toBe(WEEKEND_TEMPLATE); // Saturday
    expect(templateForDayKey("2026-11-29")).toBe(WEEKEND_TEMPLATE); // Sunday
  });
});
