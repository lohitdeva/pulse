import "fake-indexeddb/auto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleItem } from "@pulse/shared";

const seededState = vi.hoisted(() => ({ queue: [] as unknown[] }));

vi.mock("./classOverrides", () => ({
  cancelClass: vi.fn().mockResolvedValue(undefined),
  restoreClass: vi.fn().mockResolvedValue(undefined),
  moveClass: vi.fn().mockResolvedValue(undefined),
  addExtraClass: vi.fn().mockResolvedValue("new-id"),
  logAttendance: vi.fn().mockResolvedValue(1),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    // Lets a test seed the first useState calls of one render (server rendering cannot set state).
    useState: ((initial: unknown) => {
      const seeded = seededState.queue;
      if (seeded.length > 0) return actual.useState(seeded.shift());
      return actual.useState(initial);
    }) as typeof actual.useState,
  };
});

// The real Sheet portals into document.body, which server rendering has no access to.
vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  return {
    ...actual,
    Sheet: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? <div>{children}</div> : null),
  };
});

import {
  AttendancePrompt,
  CancelledBar,
  ClassRowActions,
  SAVE_ERROR,
  attendanceByClass,
  createClassActionsApi,
  parseExtraForm,
  parseMoveForm,
  type ClassActionsApi,
} from "./ClassActions";
import * as overrides from "./classOverrides";

const DAY = "2026-11-26";
// 10:00-11:00 IST
const START = new Date("2026-11-26T04:30:00.000Z");
const END = new Date("2026-11-26T05:30:00.000Z");

type TestProps = { children?: ReactNode; onClick?: () => void; [key: string]: unknown };

function elements(node: ReactNode): ReactElement<TestProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<TestProps>;
  return [element, ...elements(element.props.children)];
}

function classItem(over: Record<string, unknown> = {}): ScheduleItem {
  return {
    sortOrder: 1,
    templateBlockSortOrder: null,
    title: "Marketing",
    blockType: "fixed",
    source: "class",
    startAt: START,
    endAt: END,
    meta: { classId: "c1", kind: "class", cancelled: false, ...over },
  };
}

function fakeApi(over: Partial<ClassActionsApi> = {}): ClassActionsApi {
  return {
    attendance: {},
    setAttendance: vi.fn().mockResolvedValue(null),
    cancel: vi.fn().mockResolvedValue(null),
    restore: vi.fn().mockResolvedValue(null),
    move: vi.fn().mockResolvedValue(null),
    addExtra: vi.fn().mockResolvedValue(null),
    ...over,
  };
}

function markup(item: ScheduleItem, now: Date, api = fakeApi()): string {
  return renderToStaticMarkup(<ClassRowActions item={item} now={now} api={api} dayKey={DAY} />);
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}

beforeEach(() => vi.clearAllMocks());

describe("attendance prompt visibility", () => {
  const before = new Date("2026-11-26T05:00:00.000Z");
  const after = new Date("2026-11-26T05:30:00.000Z");

  it("appears only once the class has ended", () => {
    expect(markup(classItem(), before)).not.toContain("data-attendance");
    expect(markup(classItem(), after)).toContain('data-attendance="attended"');
  });

  it("is hidden for cancelled classes and non-class kinds, and once answered", () => {
    expect(markup(classItem({ cancelled: true }), after)).not.toContain("data-attendance");
    expect(markup(classItem({ kind: "exam" }), after)).not.toContain("data-attendance");
    const answered = markup(classItem(), after, fakeApi({ attendance: { c1: "medical" } }));
    expect(answered).not.toContain("data-attendance");
    expect(answered).toContain("Medical");
    expect(answered).toContain("Tap to change");
  });
});

describe("attendance buttons", () => {
  it("each button reports its own value", () => {
    const onChoose = vi.fn();
    const buttons = elements(AttendancePrompt({ label: "Marketing", onChoose })).filter(
      (e) => e.type === "button",
    );
    expect(buttons.map((b) => b.props["data-attendance"])).toEqual([
      "attended",
      "missed",
      "medical",
      "cancelled",
    ]);
    for (const b of buttons) b.props.onClick?.();
    expect(onChoose.mock.calls.map((c) => c[0])).toEqual(["attended", "missed", "medical", "cancelled"]);
  });

  it("api logs attendance with the right value and the class start", async () => {
    const api = createClassActionsApi({
      client: {} as SupabaseClient,
      userId: "u1",
      attendance: {},
      reload: vi.fn(),
    });
    for (const value of ["attended", "missed", "medical", "cancelled"] as const) {
      expect(await api.setAttendance("c1", value, START)).toBeNull();
      expect(overrides.logAttendance).toHaveBeenLastCalledWith("u1", "c1", value, START, {});
    }
  });

  it("attendanceByClass reads meta.attendance of class:<id> logs only", () => {
    expect(
      attendanceByClass([
        { item_key: "class:c1", meta: { attendance: "missed" } },
        { item_key: "class:c2", meta: { attendance: "bogus" } },
        { item_key: "class:c3" },
        { item_key: "habit:2026-11-26:3", meta: { attendance: "attended" } },
      ]),
    ).toEqual({ c1: "missed" });
  });
});

describe("cancel and restore", () => {
  it("cancelled class shows a Restore button instead of the prompt", () => {
    const html = markup(classItem({ cancelled: true }), new Date("2026-11-26T06:00:00.000Z"));
    expect(html).toContain("Cancelled");
    expect(html).toContain('data-class-action="restore"');
    expect(html).not.toContain('data-class-action="options"');
  });

  it("Restore and cancel call the overrides and reload; failures show a generic error", async () => {
    const onRestore = vi.fn();
    const restore = elements(CancelledBar({ label: "Marketing", onRestore })).find(
      (e) => e.props["data-class-action"] === "restore",
    );
    restore?.props.onClick?.();
    expect(onRestore).toHaveBeenCalledTimes(1);

    const reload = vi.fn();
    const api = createClassActionsApi({
      client: {} as SupabaseClient,
      userId: "u1",
      attendance: {},
      reload,
    });
    expect(await api.cancel("c1")).toBeNull();
    expect(await api.restore("c1")).toBeNull();
    expect(overrides.cancelClass).toHaveBeenCalledWith({}, "c1");
    expect(overrides.restoreClass).toHaveBeenCalledWith({}, "c1");
    expect(reload).toHaveBeenCalledTimes(2);

    vi.mocked(overrides.cancelClass).mockRejectedValueOnce(new Error("secret detail"));
    expect(await api.cancel("c1")).toBe(SAVE_ERROR);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe("save error placement", () => {
  const after = new Date("2026-11-26T06:00:00.000Z");
  const escaped = renderToStaticMarkup(<>{SAVE_ERROR}</>);
  const count = (html: string) => html.split(escaped).length - 1;
  // ClassRowActions state order: sheet, editing, busy, error.
  const withState = (sheet: "menu" | "move" | null) => {
    seededState.queue = [sheet, false, false, SAVE_ERROR];
    try {
      return markup(classItem(), after);
    } finally {
      seededState.queue = [];
    }
  };

  it("renders the error exactly once while the move sheet is open", () => {
    expect(count(withState("move"))).toBe(1);
  });

  it("renders the error exactly once while the menu sheet is open", () => {
    expect(count(withState("menu"))).toBe(1);
  });

  it("renders the error exactly once when the sheet is closed", () => {
    expect(count(withState(null))).toBe(1);
  });
});

describe("move validation", () => {
  it("accepts a valid IST range on the Pulse day", () => {
    const r = parseMoveForm(DAY, form({ start: "10:00", end: "11:00" }));
    expect(r).toEqual({ ok: true, start: START, end: END });
  });

  it("rejects end not after start, and missing times", () => {
    expect(parseMoveForm(DAY, form({ start: "11:00", end: "11:00" })).ok).toBe(false);
    expect(parseMoveForm(DAY, form({ start: "12:00", end: "11:00" })).ok).toBe(false);
    expect(parseMoveForm(DAY, form({ start: "", end: "11:00" })).ok).toBe(false);
  });

  it("treats times before 04:00 as after midnight of the same Pulse day", () => {
    const r = parseMoveForm(DAY, form({ start: "23:00", end: "01:00" }));
    expect(r).toEqual({
      ok: true,
      start: new Date("2026-11-26T17:30:00.000Z"),
      end: new Date("2026-11-26T19:30:00.000Z"),
    });
  });
});

describe("add extra class", () => {
  it("requires a title", () => {
    const r = parseExtraForm(DAY, form({ title: "   ", start: "10:00", end: "11:00" }));
    expect(r).toEqual({ ok: false, error: "Give the class a title." });
  });

  it("returns trimmed values with optional fields null when empty", () => {
    const r = parseExtraForm(
      DAY,
      form({ title: " Guest talk ", start: "10:00", end: "11:00", course: "", room: " R12 " }),
    );
    expect(r).toEqual({
      ok: true,
      value: { date: DAY, start: START, end: END, title: "Guest talk", course: null, room: "R12" },
    });
  });

  it("api passes the input to addExtraClass and reloads", async () => {
    const reload = vi.fn();
    const api = createClassActionsApi({
      client: {} as SupabaseClient,
      userId: "u1",
      attendance: {},
      reload,
    });
    const input = { date: DAY, start: START, end: END, title: "Talk", course: null, room: null };
    expect(await api.addExtra(input)).toBeNull();
    expect(overrides.addExtraClass).toHaveBeenCalledWith({}, input);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
