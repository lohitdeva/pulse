// @ts-expect-error -- Node types are not part of shared's TypeScript environment.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { utcToIstDateTimeLocal } from "../time";
import { parseSectionCTimetable, type TimetableBridgePayload } from "./parser";

interface FixtureRecord {
  date: string;
  start: string;
  end: string;
  kind: "class" | "exam" | "event";
  title: string;
  course: string | null;
  session: number | null;
  professor: string | null;
  room: string | null;
}

interface TimetableFixture extends TimetableBridgePayload {
  expected_section_C: FixtureRecord[];
}

const fixture = JSON.parse(
  readFileSync(new URL("../../docs/reference/timetable-fixture.json", import.meta.url), "utf8"),
) as TimetableFixture;

const header = [
  "Date",
  "Day",
  "Sections",
  "09:30 AM\n11:00 AM",
  "11:15 AM\n12:45 PM",
  "LUNCH\n12:45 PM - 02:00 PM",
  "02:00 PM 03:30 PM",
  "03:45 PM 05:15 PM",
];

function payload(rows: string[][], merges: string[] = []): TimetableBridgePayload {
  return { values: [header, ...rows], merges };
}

function localTime(utc: string): string {
  return utcToIstDateTimeLocal(utc).slice(11);
}

describe("parseSectionCTimetable", () => {
  it("selects Section C and matches every expected fixture record", () => {
    const records = parseSectionCTimetable(fixture);

    expect(records).toHaveLength(fixture.expected_section_C.length);
    expect(
      records.map((record) => ({
        date: record.date,
        start: localTime(record.startsAt),
        end: localTime(record.endsAt),
        kind: record.kind,
        title: record.title,
        course: record.course,
        session: record.session,
        professor: record.professor,
        room: record.room,
      })),
    ).toEqual(
      fixture.expected_section_C.map(({ date, start, end, kind, title, course, session, professor, room }) => ({
        date,
        start,
        end,
        kind,
        title,
        course,
        session,
        professor,
        room,
      })),
    );
    expect(records.every((record) => record.startsAt.endsWith("Z") && record.endsAt.endsWith("Z"))).toBe(
      true,
    );
  });

  it("uses the term year rule across the December to January rollover", () => {
    const records = parseSectionCTimetable(
      payload([
        ["31-Dec", "Thursday", "C", "MM-II-4", "", "", "", ""],
        ["1-Jan", "Friday", "C", "OM-I-3", "", "", "", ""],
      ]),
    );

    expect(records.map((record) => record.date)).toEqual(["2026-12-31", "2027-01-01"]);
  });

  it("normalizes course spacing and extracts a bracketed professor and room", () => {
    const [record] = parseSectionCTimetable(
      payload([["15-Feb", "Monday", "C", "OM-I - 2 ( Prof.  Rohit Gupta ) ( B04)", "", "", "", ""]]),
    );

    expect(record).toMatchObject({
      kind: "class",
      title: "OM-I-2",
      course: "OM-I",
      session: 2,
      professor: "Prof. Rohit Gupta",
      room: "B04",
    });
  });

  it("uses explicit times for a morning single-slot class", () => {
    const [record] = parseSectionCTimetable(
      payload([["15-Feb", "Monday", "C", "OM-I-2 10:30 - 01:00", "", "", "", ""]]),
    );

    expect(localTime(record!.startsAt)).toBe("10:30");
    expect(localTime(record!.endsAt)).toBe("13:00");
  });

  it("keeps an unmatched cell as an event title", () => {
    const [record] = parseSectionCTimetable(
      payload([["1-Oct", "Thursday", "C", "", "", "", "", "Industry Talk"]]),
    );

    expect(record).toMatchObject({ kind: "event", title: "Industry Talk", course: null });
  });

  it("inherits a multi-section, multi-slot merge once and uses the merged slot span", () => {
    const records = parseSectionCTimetable(
      payload(
        [
          ["15-Feb", "Monday", "A", "Workshop", "", "", "", ""],
          ["", "", "B", "", "", "", "", ""],
          ["", "", "C", "", "", "", "", ""],
          ["", "", "D", "", "", "", "", ""],
        ],
        ["D2:E5"],
      ),
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      title: "Workshop",
      kind: "event",
      date: "2027-02-15",
    });
    expect(localTime(records[0]!.startsAt)).toBe("09:30");
    expect(localTime(records[0]!.endsAt)).toBe("12:45");
  });

  it("recognizes synthetic mid-term exam items and associates their course", () => {
    const [record] = parseSectionCTimetable(
      payload([["15-Feb", "Monday", "C", "MM-II Mid-term Exam", "", "", "", ""]]),
    );

    expect(record).toMatchObject({
      kind: "exam",
      title: "MM-II Mid-term Exam",
      course: "MM-II",
      session: null,
    });
  });
});

describe("parseSectionCTimetable on the live-grid fixture", () => {
  interface LiveFixture extends TimetableBridgePayload {
    expected_section_C_summary: { item_count: number; distinct_dates: number };
  }
  const live = JSON.parse(
    readFileSync(new URL("../../docs/reference/timetable-live-fixture.json", import.meta.url), "utf8"),
  ) as LiveFixture;

  it("parses without throwing into 160 Section C items across 83 dates", () => {
    let records: ReturnType<typeof parseSectionCTimetable> = [];
    expect(() => {
      records = parseSectionCTimetable(live);
    }).not.toThrow();
    expect(records).toHaveLength(160);
    expect(records).toHaveLength(live.expected_section_C_summary.item_count);
    expect(new Set(records.map((r) => r.date)).size).toBe(83);
    expect(new Set(records.map((r) => r.date)).size).toBe(live.expected_section_C_summary.distinct_dates);
  });

  it("applies an all-section merged cell once, spanning its merged slots", () => {
    const records = parseSectionCTimetable(live).filter((r) => r.date === "2026-11-08");
    const [item] = records;
    expect(records).toHaveLength(1);
    expect(item).toMatchObject({ kind: "event", title: "Schedule Event 42" });
    expect([localTime(item?.startsAt ?? ""), localTime(item?.endsAt ?? "")]).toEqual(["09:30", "17:15"]);
  });

  it("ignores the non-class S.No. rows below the grid", () => {
    const records = parseSectionCTimetable(live);
    expect(live.values.some((row) => row[0] === "S.No.")).toBe(true);
    for (const n of [100, 101, 102, 103, 104, 105, 106]) {
      expect(records.some((r) => r.title.includes(`Schedule Event ${n}`))).toBe(false);
    }
  });
});
