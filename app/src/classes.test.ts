import { buildDayPlan, WEEKDAY_TEMPLATE } from "@pulse/shared";
import { describe, expect, it } from "vitest";
import {
  busyFromClasses,
  fetchDayAlerts,
  mapClassRows,
  rowToPlanClass,
  type ClassRow,
} from "./classes";

const DAY = "2026-11-26";

function row(over: Partial<ClassRow> = {}): ClassRow {
  return {
    id: "c1",
    kind: "class",
    source_date: DAY,
    source_starts_at: "2026-11-26T04:00:00.000Z",
    source_ends_at: "2026-11-26T05:30:00.000Z",
    source_title: "Marketing",
    source_course: "MKT",
    source_session: 4,
    source_professor: null,
    source_room: "R12",
    source_present: true,
    manual_state: "none",
    manual_starts_at: null,
    manual_ends_at: null,
    manual_title: null,
    ...over,
  };
}

describe("rowToPlanClass", () => {
  it("uses source values by default", () => {
    const c = rowToPlanClass(row())!;
    expect(c.title).toBe("Marketing");
    expect(c.startAt.toISOString()).toBe("2026-11-26T04:00:00.000Z");
    expect(c.room).toBe("R12");
    expect(c.cancelled).toBe(false);
  });

  it("manual overrides win", () => {
    const c = rowToPlanClass(
      row({
        manual_state: "moved",
        manual_starts_at: "2026-11-26T06:00:00.000Z",
        manual_ends_at: "2026-11-26T07:00:00.000Z",
        manual_title: "Marketing (moved)",
      }),
    )!;
    expect(c.title).toBe("Marketing (moved)");
    expect(c.startAt.toISOString()).toBe("2026-11-26T06:00:00.000Z");
    expect(c.endAt.toISOString()).toBe("2026-11-26T07:00:00.000Z");
  });

  it("flags cancelled", () => {
    expect(rowToPlanClass(row({ manual_state: "cancelled" }))!.cancelled).toBe(true);
  });

  it("excludes rows removed from the sheet unless manually kept", () => {
    expect(rowToPlanClass(row({ source_present: false }))).toBeNull();
    expect(
      rowToPlanClass(row({ source_present: false, manual_state: "cancelled" })),
    ).not.toBeNull();
  });
});

describe("mapClassRows / busyFromClasses", () => {
  it("sorts by effective start and drops removed rows", () => {
    const rows = [
      row({ id: "late", source_starts_at: "2026-11-26T08:00:00.000Z", source_ends_at: "2026-11-26T09:00:00.000Z" }),
      row({ id: "gone", source_present: false }),
      row({ id: "early" }),
    ];
    expect(mapClassRows(rows, DAY).map((c) => c.id)).toEqual(["early", "late"]);
  });

  it("busy excludes cancelled classes", () => {
    const classes = mapClassRows(
      [row({ id: "a" }), row({ id: "b", manual_state: "cancelled" })],
      DAY,
    );
    expect(classes).toHaveLength(2);
    expect(busyFromClasses(classes)).toHaveLength(1);
  });

  it("feeds the day plan with a class item that carries course and room", () => {
    const classes = mapClassRows([row()], DAY);
    const plan = buildDayPlan(WEEKDAY_TEMPLATE, DAY, busyFromClasses(classes), classes);
    const item = plan.items.find((i) => i.source === "class")!;
    expect(item.meta.course).toBe("MKT");
    expect(item.meta.room).toBe("R12");
  });
});

describe("fetchDayAlerts", () => {
  it("queries the Pulse-day window of queued_at", async () => {
    const calls: unknown[][] = [];
    const builder = {
      select: () => builder,
      gte: (...a: unknown[]) => (calls.push(["gte", ...a]), builder),
      lt: (...a: unknown[]) => (calls.push(["lt", ...a]), builder),
      order: () => Promise.resolve({ data: [{ id: "x" }], error: null }),
    };
    const client = { from: () => builder } as never;
    const alerts = await fetchDayAlerts(client, DAY);
    expect(alerts).toHaveLength(1);
    expect(calls).toEqual([
      ["gte", "queued_at", "2026-11-25T22:30:00.000Z"],
      ["lt", "queued_at", "2026-11-26T22:30:00.000Z"],
    ]);
  });
});
