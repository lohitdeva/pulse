import { describe, expect, it } from "vitest";
import { buildMorningDigest } from "./morningDigest";
import { istDateTimeLocalToUtc } from "./time";

const DAY = "2026-11-26"; // Thursday
const at = (hhmm: string, day = DAY) => new Date(istDateTimeLocalToUtc(`${day}T${hhmm}`));
const NOW = at("08:40");
const base = { dayKey: DAY, classes: [], changes: [], deadlines: [], now: NOW };

describe("buildMorningDigest", () => {
  it("says there are no classes and has an empty body", () => {
    expect(buildMorningDigest(base)).toEqual({ title: "No classes today", body: "" });
  });

  it("lists classes in IST time order and omits cancelled ones", () => {
    const d = buildMorningDigest({
      ...base,
      classes: [
        { title: "OM-I-2", start: at("11:15"), cancelled: false },
        { title: "MM-II-3", start: at("09:30"), cancelled: false },
        { title: "FM-1", start: at("14:00"), cancelled: true },
      ],
    });
    expect(d.title).toBe("Today: 2 classes");
    expect(d.body).toBe("9:30 MM-II-3 · 11:15 OM-I-2");
  });

  it("uses the singular and 24-hour IST for afternoon classes", () => {
    const d = buildMorningDigest({
      ...base,
      classes: [{ title: "FM-1", start: at("14:05"), cancelled: false }],
    });
    expect(d.title).toBe("Today: 1 class");
    expect(d.body).toBe("14:05 FM-1");
  });

  it("treats a day with only cancelled classes as no classes", () => {
    const d = buildMorningDigest({
      ...base,
      classes: [{ title: "FM-1", start: at("14:05"), cancelled: true }],
    });
    expect(d).toEqual({ title: "No classes today", body: "" });
  });

  it("adds a changes line from today's alert summaries", () => {
    const d = buildMorningDigest({
      ...base,
      classes: [{ title: "OM-I-2", start: at("14:00"), cancelled: false }],
      changes: [{ summary: "OM-I-2 moved to 2:00 PM" }, { summary: "FM-1 cancelled" }],
    });
    expect(d.body.split("\n")).toEqual([
      "14:00 OM-I-2",
      "Changes: OM-I-2 moved to 2:00 PM; FM-1 cancelled",
    ]);
  });

  it("includes deadlines within 72 hours of now, soonest first, with IST weekday and time", () => {
    const d = buildMorningDigest({
      ...base,
      deadlines: [
        { title: "Case memo", due: at("18:00", "2026-11-28").toISOString() },
        { title: "Quiz prep", due: at("23:30", "2026-11-26") },
        { title: "Exactly 72h", due: new Date(NOW.getTime() + 72 * 3_600_000) },
        { title: "Too far", due: new Date(NOW.getTime() + 72 * 3_600_000 + 1) },
        { title: "Overdue", due: at("08:00") },
      ],
    });
    expect(d.body).toBe("Due soon: Quiz prep Thu 23:30; Case memo Sat 18:00; Exactly 72h Sun 8:40");
  });

  it("drops Done and Dropped tasks but keeps other statuses", () => {
    const due = at("18:00", "2026-11-27");
    const d = buildMorningDigest({
      ...base,
      deadlines: [
        { title: "A", due, status: "Done" },
        { title: "B", due, status: "Dropped" },
        { title: "C", due, status: "In progress" },
        { title: "D", due, status: "To do" },
      ],
    });
    expect(d.body).toBe("Due soon: C Fri 18:00; D Fri 18:00");
  });

  it("adds optional workout and score lines only when given", () => {
    const d = buildMorningDigest({ ...base, workoutToday: "Push day", yesterdayScore: 82 });
    expect(d.body.split("\n")).toEqual(["Workout: Push day", "Yesterday: 82"]);
  });

  it("truncates a long body to 240 characters ending with an ellipsis", () => {
    const d = buildMorningDigest({
      ...base,
      changes: [{ summary: "x".repeat(400) }],
    });
    expect(d.body).toHaveLength(240);
    expect(d.body.endsWith("…")).toBe(true);
    const short = buildMorningDigest({ ...base, changes: [{ summary: "x".repeat(200) }] });
    expect(short.body.endsWith("…")).toBe(false);
  });
});
