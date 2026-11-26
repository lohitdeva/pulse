import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDayPlan,
  nowNext,
  templateForDayKey,
  type PlanClass,
  type ScheduleItem,
} from "./dayplan";
import { WEEKDAY_TEMPLATE, WEEKEND_TEMPLATE } from "./schedule";
import { blockInstants, currentPulseDayKey } from "./time";

const DAY = "2026-11-26";
const byTitle = (items: ScheduleItem[], prefix: string) =>
  items.find((i) => i.title.startsWith(prefix));
const news = (items: ScheduleItem[]) =>
  items.filter((i) => i.meta.newsReading === true);
const key = (i: ScheduleItem) => (i.startAt ?? i.endAt)!.getTime();

afterEach(() => {
  vi.useRealTimers();
});

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
    expect(items[0]!.startAt).toEqual(
      blockInstants(DAY, "11:00", "11:15").start,
    );
    expect(items[1]!.startAt).toEqual(
      blockInstants(DAY, "12:45", "13:10").start,
    );
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
            (
              i.startAt ?? blockInstants(DAY, "18:00", "18:00").start
            ).getTime()) /
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

describe("clock-driven Now / Next acceptance", () => {
  it("follows the weekday timeline from morning through the next Pulse day", () => {
    vi.useFakeTimers();

    const at = (instant: string) => {
      vi.setSystemTime(new Date(instant));
      const now = new Date();
      const dayKey = currentPulseDayKey();
      const template = templateForDayKey(dayKey);
      const plan = buildDayPlan(template, dayKey);
      return { dayKey, template, ...nowNext(plan, now) };
    };

    const pulseStart = at("2026-11-26T04:00:00+05:30");
    expect(pulseStart.dayKey).toBe("2026-11-26");
    expect(pulseStart.current).toBeNull();
    expect(pulseStart.next?.title).toBe("Wake up");

    const morning = at("2026-11-26T07:15:00+05:30");
    expect(morning.dayKey).toBe("2026-11-26");
    expect(morning.template).toBe(WEEKDAY_TEMPLATE);
    expect(morning.current?.title).toBe("Brush and freshen up");
    expect(morning.next?.title).toBe("Walk (auto-logged from Strava)");

    const noon = at("2026-11-26T12:00:00+05:30");
    expect(noon.current?.title).toBe(
      "Classes from the timetable; free slots → study/reading/tasks",
    );
    expect(noon.next?.title).toBe("Lunch");

    const evening = at("2026-11-26T19:45:00+05:30");
    expect(evening.current?.title).toBe("Gym: weigh-in, workout, cardio, abs");
    expect(evening.next?.title).toBe("Freshen up after the gym");

    const call = at("2026-11-26T23:00:00+05:30");
    expect(call.current?.title).toBe("Personal call");
    expect(call.next?.title).toBe(
      "Wind-down: night check-in, then book reading",
    );

    const windDown = at("2026-11-27T00:45:00+05:30");
    expect(windDown.dayKey).toBe("2026-11-26");
    expect(windDown.current?.title).toBe(
      "Wind-down: night check-in, then book reading",
    );
    expect(windDown.next?.title).toBe("Lights out");

    const sleep = at("2026-11-27T01:15:00+05:30");
    expect(sleep.dayKey).toBe("2026-11-26");
    expect(sleep.current).toBeNull();
    expect(sleep.next).toBeNull();

    const nextPulseDay = at("2026-11-27T04:00:00+05:30");
    expect(nextPulseDay.dayKey).toBe("2026-11-27");
    expect(nextPulseDay.template).toBe(WEEKDAY_TEMPLATE);
    expect(nextPulseDay.current).toBeNull();
    expect(nextPulseDay.next?.title).toBe("Wake up");
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

describe("buildDayPlan with timetable classes", () => {
  const cls = (
    id: string,
    from: string,
    to: string,
    over: Partial<PlanClass> = {},
  ): PlanClass => {
    const { start, end } = blockInstants(DAY, from, to);
    return {
      id,
      kind: "class",
      title: "Marketing",
      startAt: start,
      endAt: end,
      course: "MKT",
      room: "R12",
      session: 3,
      professor: null,
      cancelled: false,
      ...over,
    };
  };

  it("places class items in start order and news avoids them", () => {
    const plan = buildDayPlan(WEEKDAY_TEMPLATE, DAY, [], [
      cls("b", "11:15", "12:45"),
      cls("a", "09:30", "11:00"),
    ]);
    const classItems = plan.items.filter((i) => i.source === "class");
    expect(classItems.map((i) => i.meta.classId)).toEqual(["a", "b"]);
    expect(plan.items.map(key)).toEqual([...plan.items.map(key)].sort((x, y) => x - y));
    const placed = news(plan.items);
    expect(placed.map((i) => i.meta.minutes)).toEqual([15, 25]);
    for (const n of placed) {
      for (const c of classItems) {
        expect(n.startAt!.getTime() >= c.endAt!.getTime() || n.endAt!.getTime() <= c.startAt!.getTime()).toBe(true);
      }
    }
  });

  it("cancelled classes stay listed but are not busy and never current/next", () => {
    const plan = buildDayPlan(WEEKDAY_TEMPLATE, DAY, [], [
      cls("x", "09:30", "17:00", { cancelled: true }),
    ]);
    expect(plan.items.some((i) => i.meta.classId === "x" && i.meta.cancelled === true)).toBe(true);
    expect(plan.newsLeftoverMinutes).toEqual({});
    const mid = nowNext(plan, blockInstants(DAY, "10:00", "10:00").start);
    expect(mid.current?.meta.classId).not.toBe("x");
    expect(mid.next?.meta.classId).not.toBe("x");
  });

  it("Now picks the class when the clock is inside it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00+05:30"));
    const plan = buildDayPlan(WEEKDAY_TEMPLATE, DAY, [], [cls("a", "09:30", "11:00")]);
    const { current } = nowNext(plan, new Date());
    expect(current?.source).toBe("class");
    expect(current?.meta.classId).toBe("a");
  });
});
