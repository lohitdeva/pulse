import { describe, expect, it } from "vitest";
import {
  buildReminderItems,
  clampCadence,
  evaluate,
  quietClassIntervals,
  type ReminderClass,
  type ReminderItem,
  type ReminderSourceItem,
  type ReminderState,
} from "./reminders";
import { DEFAULT_FACILITY_HOURS } from "./schedule";
import { istDateTimeLocalToUtc } from "./time";

const DAY = "2026-11-26";
const NEXT = "2026-11-27";
const at = (hhmm: string, day = DAY) =>
  new Date(istDateTimeLocalToUtc(`${day}T${hhmm}`));
const MIN = 60_000;

const src = (
  key: string,
  title: string,
  blockType: ReminderSourceItem["blockType"],
  start: string | null,
  end: string | null = null,
  day = DAY,
): ReminderSourceItem => ({
  key,
  title,
  blockType,
  startAt: start ? at(start, day) : null,
  endAt: end ? at(end, day) : null,
});

const klass = (
  key: string,
  start: string,
  end: string,
  cancelled = false,
): ReminderClass => ({
  key,
  title: `Class ${key}`,
  start: at(start),
  end: at(end),
  cancelled,
});

const build = (
  items: ReminderSourceItem[],
  classes: ReminderClass[] = [],
  extra = {},
) =>
  buildReminderItems({
    dayKey: DAY,
    items,
    classes,
    facility: DEFAULT_FACILITY_HOURS,
    ...extra,
  });
const find = (items: ReminderItem[], key: string) =>
  items.find((i) => i.key === key)!;

/** Minute-by-minute driver: records sends and applies them to state like a caller would. */
function simulate(opts: {
  items: ReminderItem[];
  from: string;
  to: string;
  fromDay?: string;
  toDay?: string;
  quiet?: {
    classes: { start: Date; end: Date }[];
    call: { start: Date; end: Date } | null;
  };
  cadenceMinutes?: number;
  waterBottles?: number;
  state?: Record<string, ReminderState>;
  onMinute?: (now: Date, state: Record<string, ReminderState>) => void;
}) {
  const state: Record<string, ReminderState> = opts.state ?? {};
  const sends: { key: string; at: string; firm: boolean }[] = [];
  const missed: { key: string; at: string }[] = [];
  const attendance: { key: string; at: string }[] = [];
  const hhmm = (d: Date) =>
    new Date(d.getTime() + 330 * MIN).toISOString().slice(11, 16);
  for (
    let t = at(opts.from, opts.fromDay).getTime();
    t <= at(opts.to, opts.toDay ?? opts.fromDay).getTime();
    t += MIN
  ) {
    const now = new Date(t);
    opts.onMinute?.(now, state);
    const r = evaluate({
      items: opts.items,
      state,
      quiet: opts.quiet ?? { classes: [], call: null },
      cadenceMinutes: opts.cadenceMinutes,
      waterBottles: opts.waterBottles,
      now,
    });
    for (const s of r.send) {
      sends.push({ key: s.key, at: hhmm(now), firm: s.firm });
      const st = state[s.key] ?? { sentCount: 0 };
      state[s.key] = { ...st, sentCount: st.sentCount + 1, lastSentAt: now };
    }
    for (const k of r.attendancePrompts) {
      attendance.push({ key: k, at: hhmm(now) });
      state[k] = {
        ...(state[k] ?? { sentCount: 0 }),
        sentCount: 1,
        lastSentAt: now,
      };
    }
    for (const k of r.missed) {
      missed.push({ key: k, at: hhmm(now) });
      state[k] = { ...(state[k] ?? { sentCount: 0 }), resolved: "missed" };
    }
  }
  return { sends, missed, attendance, state };
}

const times = (sends: { at: string }[]) => sends.map((s) => s.at);

describe("buildReminderItems", () => {
  const meals = [
    src(
      "b",
      "Breakfast at the mess (read Inshorts; Mint/WSJ if time)",
      "must_do",
      "08:45",
    ),
    src("l", "Lunch", "must_do", "13:00"),
    src("s", "Snacks", "must_do", "17:30"),
    src("d", "Dinner", "must_do", "21:00"),
  ];

  it("closes the breakfast window at 09:20 with a 09:30 class", () => {
    const items = build(meals, [klass("c1", "09:30", "10:30")]);
    expect(find(items, "b").windowEnd).toEqual(at("09:20"));
    expect(find(items, "b").fireAt).toEqual(at("08:45"));
  });

  it("uses mess close when no class is earlier, and ignores cancelled classes", () => {
    const items = build(meals, [klass("c1", "09:30", "10:30", true)]);
    expect(find(items, "b").windowEnd).toEqual(at("10:30"));
    expect(find(items, "l").windowEnd).toEqual(at("15:00"));
    expect(find(items, "s").windowEnd).toEqual(at("18:30"));
    expect(find(items, "d").windowEnd).toEqual(at("22:30"));
  });

  it("closes lunch 10 min before a 14:00 class", () => {
    const items = build(meals, [klass("c1", "14:00", "15:30")]);
    expect(find(items, "l").windowEnd).toEqual(at("13:50"));
  });

  it("gym window ends at gym close", () => {
    const items = build([
      src(
        "g",
        "Gym: weigh-in, workout, cardio, abs",
        "must_do",
        "19:30",
        "20:45",
      ),
    ]);
    const gym = find(items, "g");
    expect(gym.kind).toBe("gym");
    expect(gym.windowEnd).toEqual(at("22:00"));
  });

  it("class: reminder 10 min before, window to class end, plus attendance event; cancelled emits nothing", () => {
    const items = build(
      [],
      [klass("c1", "11:00", "12:00"), klass("c2", "13:00", "14:00", true)],
    );
    const c = find(items, "c1");
    expect(c.fireAt).toEqual(at("10:50"));
    expect(c.windowEnd).toEqual(at("12:00"));
    expect(find(items, "c1:attendance").fireAt).toEqual(at("12:00"));
    expect(items.some((i) => i.key.startsWith("c2"))).toBe(false);
  });

  it("bedtime has a wind-down at 00:45 and a must item to 02:00", () => {
    const items = build([
      src("lo", "Lights out", "must_do", "01:00", null, NEXT),
    ]);
    expect(find(items, "lo:winddown").fireAt).toEqual(at("00:45", NEXT));
    expect(find(items, "lo").fireAt).toEqual(at("01:00", NEXT));
    expect(find(items, "lo").windowEnd).toEqual(at("02:00", NEXT));
  });

  it("nudges, water checkpoints and deadlines; none-level blocks emit nothing", () => {
    const items = build(
      [
        src("rev", "Revision: 15 min", "habit_nudge", "18:00"),
        src("wake", "Wake up", "anchor", "07:00"),
        src("walk", "Walk", "habit", "07:30", "08:00"),
        src("hyg", "Brush", "habit_checklist", "07:00", "07:30"),
        {
          ...src(
            "tt",
            "Classes from the timetable",
            "must_do",
            "09:30",
            "17:15",
          ),
          meta: { fillable: true },
        },
      ],
      [],
      { deadlines: [{ key: "dl", title: "Assignment", due: at("17:00") }] },
    );
    expect(find(items, "rev").level).toBe("nudge");
    expect(find(items, "dl").windowEnd).toEqual(at("17:00"));
    expect(find(items, "dl").fireAt).toEqual(at("16:00"));
    expect(
      items.filter((i) => i.kind === "water").map((i) => i.fireAt),
    ).toEqual([at("11:00"), at("15:00"), at("19:00")]);
    expect(
      items.some((i) => ["wake", "walk", "hyg", "tt"].includes(i.key)),
    ).toBe(false);
  });
});

describe("quietClassIntervals", () => {
  it("drops cancelled classes", () => {
    const q = quietClassIntervals([
      klass("a", "14:00", "15:30"),
      klass("b", "16:00", "17:00", true),
    ]);
    expect(q).toEqual([{ start: at("14:00"), end: at("15:30") }]);
  });
});

describe("clampCadence", () => {
  it("defaults to 10 and clamps to 5-30", () => {
    expect(clampCadence(undefined)).toBe(10);
    expect(clampCadence(NaN)).toBe(10);
    expect(clampCadence(1)).toBe(5);
    expect(clampCadence(99)).toBe(30);
    expect(clampCadence(15)).toBe(15);
  });
});

describe("simulated day: lunch", () => {
  const items = build([src("l", "Lunch", "must_do", "13:00")]);

  it("repeats every 10 min, firm after 3, Missed at 15:00 when the mess closes", () => {
    const r = simulate({ items, from: "12:00", to: "16:00" });
    const lunch = r.sends.filter((s) => s.key === "l");
    expect(times(lunch)).toEqual([
      "13:00",
      "13:10",
      "13:20",
      "13:30",
      "13:40",
      "13:50",
      "14:00",
      "14:10",
      "14:20",
      "14:30",
      "14:40",
      "14:50",
    ]);
    expect(lunch.map((s) => s.firm)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(r.missed).toEqual([{ key: "l", at: "15:00" }]);
  });

  it("is not reported missed before the window closes, and stops once resolved", () => {
    const r = simulate({
      items,
      from: "12:00",
      to: "16:00",
      onMinute: (now, state) => {
        if (now.getTime() === at("13:25").getTime())
          state.l = { ...state.l!, resolved: "done" };
      },
    });
    expect(times(r.sends.filter((s) => s.key === "l"))).toEqual([
      "13:00",
      "13:10",
      "13:20",
    ]);
    expect(r.missed).toEqual([]);
  });

  it("medical and skipped also stop the repeats", () => {
    for (const resolved of ["medical", "skipped"] as const) {
      const r = evaluate({
        items,
        state: { l: { resolved, sentCount: 1, lastSentAt: at("13:00") } },
        quiet: { classes: [], call: null },
        now: at("13:30"),
      });
      expect(r.send).toEqual([]);
      expect(r.missed).toEqual([]);
    }
  });
});

describe("quiet rules", () => {
  const deadline: ReminderItem = {
    key: "dl",
    title: "Assignment",
    level: "must",
    kind: "deadline",
    fireAt: at("14:10"),
    windowEnd: at("17:00"),
    repeats: true,
    lapseAt: null,
  };
  const classIv = { start: at("14:00"), end: at("15:30") };

  it("nothing fires inside a class and held items fire at class end", () => {
    const r = simulate({
      items: [deadline],
      from: "14:00",
      to: "16:00",
      quiet: { classes: [classIv], call: null },
    });
    expect(times(r.sends)).toEqual(["15:30", "15:40", "15:50", "16:00"]);
  });

  it("a held nudge fires once at class end", () => {
    const nudge: ReminderItem = {
      key: "rev",
      title: "Revision",
      level: "nudge",
      kind: "nudge",
      fireAt: at("14:30"),
      windowEnd: null,
      repeats: false,
      lapseAt: at("16:30"),
    };
    const r = simulate({
      items: [nudge],
      from: "14:00",
      to: "17:00",
      quiet: { classes: [classIv], call: null },
    });
    expect(times(r.sends)).toEqual(["15:30"]);
  });

  it("a cancelled class is not quiet time", () => {
    const quiet = {
      classes: quietClassIntervals([
        { key: "c", title: "C", ...classIv, cancelled: true },
      ]),
      call: null,
    };
    const r = simulate({
      items: [deadline],
      from: "14:00",
      to: "14:30",
      quiet,
    });
    expect(times(r.sends)).toEqual(["14:10", "14:20", "14:30"]);
  });

  it("nothing between 02:00 and 07:00; held items resume at 07:00", () => {
    const late: ReminderItem = {
      key: "x",
      title: "Task",
      level: "must",
      kind: "other",
      fireAt: at("01:50", NEXT),
      windowEnd: at("12:00", NEXT),
      repeats: true,
      lapseAt: null,
    };
    const r = simulate({
      items: [late],
      from: "01:50",
      to: "07:10",
      fromDay: NEXT,
    });
    expect(times(r.sends)).toEqual(["01:50", "07:00", "07:10"]);
    expect(r.sends.every((s) => s.at < "02:00" || s.at >= "07:00")).toBe(true);
  });

  it("nudge is blocked during the personal call but a must-do deadline is not", () => {
    const call = { start: at("22:30"), end: at("00:30", NEXT) };
    const nudge: ReminderItem = {
      key: "n",
      title: "Study",
      level: "nudge",
      kind: "nudge",
      fireAt: at("22:40"),
      windowEnd: null,
      repeats: false,
      lapseAt: at("23:30"),
    };
    const dl: ReminderItem = {
      ...deadline,
      key: "d2",
      fireAt: at("22:40"),
      windowEnd: at("23:59"),
    };
    const r = evaluate({
      items: [nudge, dl],
      state: {},
      quiet: { classes: [], call },
      now: at("22:45"),
    });
    expect(r.send.map((s) => s.key)).toEqual(["d2"]);
  });
});

describe("nudges", () => {
  it("fire once at block start and never repeat", () => {
    const items = build([
      src("rev", "Revision: 15 min", "habit_nudge", "18:00"),
    ]);
    const r = simulate({ items, from: "17:50", to: "21:00" });
    expect(r.sends.filter((s) => s.key === "rev")).toEqual([
      { key: "rev", at: "18:00", firm: false },
    ]);
  });
});

describe("snooze and cadence", () => {
  const items = build([src("l", "Lunch", "must_do", "13:00")]);

  it("snooze pauses sends and resumes right after it ends", () => {
    const r = simulate({
      items,
      from: "13:00",
      to: "14:00",
      onMinute: (now, state) => {
        if (now.getTime() === at("13:05").getTime())
          state.l = { ...state.l!, snoozedUntil: at("13:35") };
      },
    });
    expect(times(r.sends)).toEqual(["13:00", "13:35", "13:45", "13:55"]);
  });

  it("cadence 5 and 30, and out-of-range values clamp", () => {
    const run = (c: number) =>
      times(
        simulate({
          items,
          from: "13:00",
          to: "14:00",
          cadenceMinutes: c,
        }).sends.filter((s) => s.key === "l"),
      );
    expect(run(5)).toHaveLength(13);
    expect(run(30)).toEqual(["13:00", "13:30", "14:00"]);
    expect(run(1)).toEqual(run(5));
    expect(run(100)).toEqual(run(30));
  });
});

describe("bedtime", () => {
  const items = build([
    src("lo", "Lights out", "must_do", "01:00", null, NEXT),
  ]);

  it("wind-down at 00:45, then every 10 min from 01:00, last call before 02:00, Missed at 02:00", () => {
    const r = simulate({ items, from: "00:30", to: "03:00", fromDay: NEXT });
    expect(r.sends[0]).toEqual({
      key: "lo:winddown",
      at: "00:45",
      firm: false,
    });
    expect(times(r.sends.filter((s) => s.key === "lo"))).toEqual([
      "01:00",
      "01:10",
      "01:20",
      "01:30",
      "01:40",
      "01:50",
    ]);
    expect(r.missed).toEqual([{ key: "lo", at: "02:00" }]);
  });

  it("going to sleep stops reminders and suppresses a pending wind-down", () => {
    const r = simulate({
      items,
      from: "00:30",
      to: "02:00",
      fromDay: NEXT,
      onMinute: (now, state) => {
        if (now.getTime() === at("00:40", NEXT).getTime())
          state.lo = { sentCount: 0, resolved: "going_to_sleep" };
        if (now.getTime() === at("01:25", NEXT).getTime()) delete state.lo;
      },
    });
    // resolved at 00:40 -> no wind-down; state cleared at 01:25 -> reminders would resume,
    // proving the earlier silence came from the resolution
    expect(r.sends.some((s) => s.key === "lo:winddown")).toBe(false);
    expect(times(r.sends.filter((s) => s.key === "lo"))[0]).toBe("01:25");
  });
});

describe("water pace", () => {
  const items = build([]);
  const run = (hhmm: string, bottles: number) =>
    evaluate({
      items,
      state: {},
      quiet: { classes: [], call: null },
      waterBottles: bottles,
      now: at(hhmm),
    }).send.map((s) => s.key);

  it("fires at 11, 15 and 19 only when behind the pro-rated share of 2 bottles", () => {
    expect(run("11:00", 0)).toEqual(["water:11"]);
    expect(run("11:00", 0.5)).toEqual([]);
    expect(run("15:00", 0.5)).toEqual(["water:15"]);
    expect(run("15:00", 1)).toEqual([]);
    expect(run("19:00", 1)).toEqual(["water:19"]);
    expect(run("19:00", 1.5)).toEqual([]);
    expect(run("11:59", 0)).toEqual(["water:11"]);
  });

  it("fires once only", () => {
    const r = simulate({ items, from: "10:00", to: "23:00", waterBottles: 0 });
    expect(r.sends.map((s) => [s.key, s.at])).toEqual([
      ["water:11", "11:00"],
      ["water:15", "15:00"],
      ["water:19", "19:00"],
    ]);
  });
});

describe("class reminders and attendance", () => {
  const items = build([], [klass("c1", "11:00", "12:00")]);

  it("reminds once 10 min before and prompts attendance at the end", () => {
    const r = simulate({ items, from: "10:00", to: "13:00" });
    expect(r.sends.filter((s) => s.key === "c1")).toEqual([
      { key: "c1", at: "10:50", firm: false },
    ]);
    expect(r.attendance).toEqual([{ key: "c1:attendance", at: "12:00" }]);
    expect(r.missed).toEqual([]);
  });

  it("attendance prompt is held while another class runs", () => {
    const both = build(
      [],
      [klass("c1", "11:00", "12:00"), klass("c2", "12:00", "13:00")],
    );
    const r = simulate({
      items: both,
      from: "11:00",
      to: "14:00",
      quiet: {
        classes: quietClassIntervals([
          klass("c1", "11:00", "12:00"),
          klass("c2", "12:00", "13:00"),
        ]),
        call: null,
      },
    });
    expect(r.attendance.map((a) => [a.key, a.at])).toEqual([
      ["c1:attendance", "13:00"],
      ["c2:attendance", "13:00"],
    ]);
  });
});

describe("idempotency", () => {
  it("evaluating twice in the same minute sends once", () => {
    const items = build([src("l", "Lunch", "must_do", "13:00")]);
    const state: Record<string, ReminderState> = {};
    const now = at("13:00");
    const first = evaluate({
      items,
      state,
      quiet: { classes: [], call: null },
      now,
    });
    expect(first.send.map((s) => s.key)).toEqual(["l"]);
    state.l = { sentCount: 1, lastSentAt: now };
    const again = evaluate({
      items,
      state,
      quiet: { classes: [], call: null },
      now,
    });
    expect(again.send).toEqual([]);
    const sameMinute = evaluate({
      items,
      state,
      quiet: { classes: [], call: null },
      now: new Date(now.getTime() + 30_000),
    });
    expect(sameMinute.send).toEqual([]);
  });
});
