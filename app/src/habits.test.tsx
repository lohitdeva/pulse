import "fake-indexeddb/auto";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileDayLogs,
  type DayPlan,
  type ItemLogRow,
  type ScheduleItem,
} from "@pulse/shared";
import { offlineDb } from "./offline/db";
import { logItem } from "./offline/queue";
import { habitItemKey, Today } from "./Today";

const DAY_KEY = "2026-11-26";

function scheduleItem(
  blockType: ScheduleItem["blockType"],
  title: string,
  templateBlockSortOrder: number | null,
): ScheduleItem {
  return {
    sortOrder: templateBlockSortOrder ?? 99,
    templateBlockSortOrder,
    title,
    blockType,
    source: "template",
    startAt: null,
    endAt: null,
    meta: {},
  };
}

const eligibleItems = [
  scheduleItem("habit", "Walk", 3),
  scheduleItem("habit_checklist", "Brush teeth", 2),
  scheduleItem("habit_nudge", "Revision", 12),
];

function planWith(items: ScheduleItem[]): DayPlan {
  return { dayKey: DAY_KEY, items, newsLeftoverMinutes: {} };
}

type TestProps = {
  children?: ReactNode;
  type?: string;
  onClick?: () => void;
  [key: string]: unknown;
};

function elements(node: ReactNode): ReactElement<TestProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== "object" || !("props" in node))
    return [];
  const element = node as ReactElement<TestProps>;
  return [element, ...elements(element.props.children)];
}

function renderToday(
  items: ScheduleItem[],
  onHabitStatusChange = vi.fn(),
  habitStatuses: Record<string, ItemLogRow["status"]> = {},
) {
  const tree = Today({
    plan: planWith(items),
    now: new Date("2026-11-26T06:00:00.000Z"),
    greeting: "Good morning",
    dateLabel: "Thu, 26 Nov",
    onOpenSettings: () => undefined,
    onHabitStatusChange,
    habitStatuses,
  });
  return { tree, onHabitStatusChange };
}

beforeEach(async () => {
  await offlineDb.pending.clear();
});

describe("habit timeline logging", () => {
  it("shows controls only for habit, checklist, and nudge timeline items", () => {
    const { tree } = renderToday([
      ...eligibleItems,
      scheduleItem("anchor", "Wake up", 1),
      scheduleItem("must_do", "Breakfast", 8),
    ]);
    const controls = elements(tree).filter(
      (element) =>
        element.type === "button" &&
        typeof element.props["data-habit-action"] === "string",
    );

    expect(controls).toHaveLength(eligibleItems.length * 2);
    expect(controls.map((button) => button.props["aria-label"])).toEqual(
      expect.arrayContaining([
        "Mark Walk done",
        "Mark Walk skipped",
        "Mark Brush teeth done",
        "Mark Brush teeth skipped",
        "Mark Revision done",
        "Mark Revision skipped",
      ]),
    );
  });

  it("uses stable per-day keys and lets done and skipped replace each other", () => {
    const item = eligibleItems[1]!;
    const itemKey = habitItemKey(DAY_KEY, item)!;
    expect(itemKey).toBe("habit:2026-11-26:2");
    expect(
      habitItemKey("2026-11-27", {
        ...item,
        startAt: new Date("2026-11-27T03:00:00Z"),
      }),
    ).toBe("habit:2026-11-27:2");

    const onChange = vi.fn();
    const { tree } = renderToday([item], onChange);
    const controls = elements(tree).filter(
      (element) => element.props["data-habit-key"] === itemKey,
    );
    const done = controls.find(
      (button) => button.props["data-habit-action"] === "done",
    );
    const skipped = controls.find(
      (button) => button.props["data-habit-action"] === "skipped",
    );

    (done?.props.onClick as (() => void) | undefined)?.();
    (skipped?.props.onClick as (() => void) | undefined)?.();

    expect(onChange).toHaveBeenNthCalledWith(1, itemKey, "done");
    expect(onChange).toHaveBeenNthCalledWith(2, itemKey, "skipped");
  });

  it("persists the latest choice and restores it as the current status", async () => {
    const itemKey = habitItemKey(DAY_KEY, eligibleItems[1]!)!;
    await logItem("user-1", DAY_KEY, itemKey, "done");
    await logItem("user-1", DAY_KEY, itemKey, "skipped");

    const stored = await offlineDb.pending.orderBy("id").toArray();
    const pendingItems: ItemLogRow[] = stored
      .filter(
        (row) =>
          row.table === "item_logs" &&
          row.payload.user_id === "user-1" &&
          row.payload.day_key === DAY_KEY,
      )
      .map((row) => ({
        item_key: String(row.payload.item_key),
        status: row.payload.status as ItemLogRow["status"],
      }));
    const merged = reconcileDayLogs(
      { meals: [], water: [], items: [] },
      { meals: [], water: [], items: pendingItems },
    );
    const statuses = Object.fromEntries(
      (merged.items ?? []).map((row) => [row.item_key, row.status]),
    );
    const { tree } = renderToday([eligibleItems[1]!], vi.fn(), statuses);
    const controls = elements(tree).filter(
      (element) => element.props["data-habit-key"] === itemKey,
    );

    expect(
      (merged.items ?? []).find((row) => row.item_key === itemKey)?.status,
    ).toBe("skipped");
    expect(
      controls.find((button) => button.props["data-habit-action"] === "done")
        ?.props["aria-pressed"],
    ).toBe(false);
    expect(
      controls.find((button) => button.props["data-habit-action"] === "skipped")
        ?.props["aria-pressed"],
    ).toBe(true);
  });
});
