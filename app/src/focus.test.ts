import type { ScheduleItem } from "@pulse/shared";
import { describe, expect, it } from "vitest";
import { focusKeysFor, readFocusKey } from "./Today";

const DAY = "2026-11-26";

function item(overrides: Partial<ScheduleItem>): ScheduleItem {
  return {
    sortOrder: 5,
    templateBlockSortOrder: 4,
    title: "Block",
    blockType: "must_do",
    source: "template",
    startAt: null,
    endAt: null,
    meta: {},
    ...overrides,
  } as ScheduleItem;
}

describe("focusKeysFor", () => {
  it("maps a template block to its must key", () => {
    expect(focusKeysFor(DAY, item({}))).toEqual([`must:${DAY}:4`]);
  });

  it("adds the habit key before the must key for habit blocks", () => {
    expect(focusKeysFor(DAY, item({ blockType: "habit", templateBlockSortOrder: 3 }))).toEqual([
      `habit:${DAY}:3`,
      `must:${DAY}:3`,
    ]);
  });

  it("falls back to the sort order for non-template items", () => {
    expect(
      focusKeysFor(DAY, item({ templateBlockSortOrder: null, sortOrder: 7 })),
    ).toEqual([`must:${DAY}:s7`]);
  });

  it("maps a class to its class key and ignores a missing class id", () => {
    expect(
      focusKeysFor(DAY, item({ source: "class", blockType: "fixed", meta: { classId: "abc" } })),
    ).toEqual(["class:abc"]);
    expect(focusKeysFor(DAY, item({ source: "class", blockType: "fixed" }))).toEqual([]);
  });
});

describe("readFocusKey", () => {
  it("reads the focus param", () => {
    expect(readFocusKey("?focus=must%3A2026-11-26%3A4")).toBe("must:2026-11-26:4");
  });

  it("strips the attendance and winddown suffixes", () => {
    expect(readFocusKey("?focus=class%3Aabc%3Aattendance")).toBe("class:abc");
    expect(readFocusKey("?focus=must%3A2026-11-26%3A4%3Awinddown")).toBe("must:2026-11-26:4");
  });

  it("returns null when missing, empty or too long", () => {
    expect(readFocusKey("")).toBeNull();
    expect(readFocusKey("?focus=")).toBeNull();
    expect(readFocusKey(`?focus=${"a".repeat(121)}`)).toBeNull();
  });
});
