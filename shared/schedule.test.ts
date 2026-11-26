import { describe, expect, it } from "vitest";
import {
  DEFAULT_FACILITY_HOURS,
  DEFAULT_TEMPLATES,
  WEEKDAY_TEMPLATE,
  WEEKEND_TEMPLATE,
  type TemplateBlock,
} from "./schedule";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Revision starts at 18:00, so an open-start study block is bounded by it. */
const REVISION_START = "18:00";

/** Minutes since the 04:00 pulse-day start, so 00:30 sorts after 23:00. */
function pulseMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return ((h < 4 ? h + 24 : h) - 4) * 60 + m;
}

function studyMinutes(blocks: TemplateBlock[]): number {
  return blocks
    .filter(
      (b) => b.blockType === "habit_nudge" && b.title.startsWith("Study block"),
    )
    .reduce(
      (sum, b) =>
        b.endHHMM
          ? sum +
            pulseMinutes(b.endHHMM) -
            pulseMinutes(b.startHHMM ?? REVISION_START)
          : sum,
      0,
    );
}

describe("templates", () => {
  it("weekday has the 20 expected blocks in order", () => {
    expect(WEEKDAY_TEMPLATE.blocks.map((b) => b.sortOrder)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(WEEKDAY_TEMPLATE.blocks.map((b) => b.title)).toEqual([
      "Wake up",
      "Brush and freshen up",
      "Walk (auto-logged from Strava)",
      "Shower and get ready",
      "Morning check-in: sleep, mood, today's plan",
      "Breakfast at the mess (read Inshorts; Mint/WSJ if time)",
      "News minutes left (Inshorts 15, Mint 30, WSJ 30 total), earliest free slots, split if needed",
      "Classes from the timetable; free slots → study/reading/tasks",
      "Lunch",
      "Midday check-in: meals so far, water, mood",
      "Snacks",
      "Revision: 15 min for each subject held today",
      "Study block 1",
      "Gym: weigh-in, workout, cardio, abs",
      "Freshen up after the gym",
      "Dinner",
      "Study block 2: suggested subject or priority task",
      "Personal call",
      "Wind-down: night check-in, then book reading",
      "Lights out",
    ]);
  });

  it("every time is valid HH:MM and start precedes end in pulse-day order", () => {
    for (const template of DEFAULT_TEMPLATES) {
      for (const b of template.blocks) {
        if (b.startHHMM) expect(b.startHHMM).toMatch(HHMM);
        if (b.endHHMM) expect(b.endHHMM).toMatch(HHMM);
        if (b.startHHMM && b.endHHMM)
          expect(pulseMinutes(b.startHHMM)).toBeLessThan(
            pulseMinutes(b.endHHMM),
          );
      }
    }
  });

  it("cross-midnight blocks use post-midnight HH:MM", () => {
    const call = WEEKDAY_TEMPLATE.blocks.find(
      (b) => b.title === "Personal call",
    );
    expect(call).toMatchObject({ startHHMM: "22:30", endHHMM: "00:30" });
  });

  it("weekend keeps every non-study block identical and has less study time", () => {
    const isStudy = (b: TemplateBlock) => b.title.startsWith("Study block");
    const weekendOthers = WEEKEND_TEMPLATE.blocks.filter((b) => !isStudy(b));
    const weekdayOthers = WEEKDAY_TEMPLATE.blocks.filter((b) => !isStudy(b));
    expect(weekendOthers).toEqual(weekdayOthers);
    expect(WEEKEND_TEMPLATE.blocks).toHaveLength(20);
    expect(studyMinutes(WEEKEND_TEMPLATE.blocks)).toBeLessThan(
      studyMinutes(WEEKDAY_TEMPLATE.blocks),
    );
  });

  it("carries the news placement markers in both templates", () => {
    for (const template of DEFAULT_TEMPLATES) {
      const breakfast = template.blocks.filter((b) => b.meta?.newsOverlap === true);
      const fillable = template.blocks.filter((b) => b.meta?.fillable === true);
      expect(breakfast.map((b) => [b.startHHMM, b.endHHMM])).toEqual([
        ["08:45", "09:20"],
      ]);
      expect(fillable.map((b) => [b.startHHMM, b.endHHMM])).toEqual([
        ["09:30", "17:15"],
      ]);
      expect(template.blocks.filter((b) => b.meta?.newsMinutes)).toHaveLength(1);
    }
  });

  it("DEFAULT_TEMPLATES lists weekday then weekend", () => {
    expect(DEFAULT_TEMPLATES.map((t) => t.key)).toEqual(["weekday", "weekend"]);
  });
});

describe("facility hours", () => {
  it("are valid HH:MM ranges", () => {
    const ranges = [
      ...Object.values(DEFAULT_FACILITY_HOURS.mess),
      ...DEFAULT_FACILITY_HOURS.gym,
    ];
    expect(ranges).toHaveLength(6);
    for (const [start, end] of ranges) {
      expect(start).toMatch(HHMM);
      expect(end).toMatch(HHMM);
      expect(start < end).toBe(true);
    }
  });
});
