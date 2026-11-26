import { afterEach, describe, expect, it, vi } from "vitest";
import {
  blockInstants,
  currentPulseDayKey,
  istParts,
  pulseDayKey,
  pulseDayRange,
  startOfPulseDay,
} from "./time";

describe("istParts", () => {
  it("converts UTC to IST wall-clock parts", () => {
    expect(istParts(new Date("2026-11-25T22:30:00Z"))).toEqual({
      year: 2026,
      month: 11,
      day: 26,
      hour: 4,
      minute: 0,
      second: 0,
    });
  });
});

describe("pulseDayKey", () => {
  it("03:59 IST belongs to the previous date", () => {
    expect(pulseDayKey(new Date("2026-11-26T03:59:00+05:30"))).toBe("2026-11-25");
  });
  it("04:00 IST starts the new day", () => {
    expect(pulseDayKey(new Date("2026-11-26T04:00:00+05:30"))).toBe("2026-11-26");
  });
  it("00:30 IST belongs to the previous date", () => {
    expect(pulseDayKey(new Date("2026-11-26T00:30:00+05:30"))).toBe("2026-11-25");
  });
  it("23:00 IST belongs to the same date", () => {
    expect(pulseDayKey(new Date("2026-11-26T23:00:00+05:30"))).toBe("2026-11-26");
  });
  it("UTC instant exactly at 04:00 IST", () => {
    expect(pulseDayKey(new Date("2026-11-25T22:30:00Z"))).toBe("2026-11-26");
    expect(pulseDayKey(new Date("2026-11-25T22:29:59.999Z"))).toBe("2026-11-25");
  });
  it("crosses month and year boundaries", () => {
    expect(pulseDayKey(new Date("2027-01-01T01:00:00+05:30"))).toBe("2026-12-31");
    expect(pulseDayKey(new Date("2026-03-01T02:00:00+05:30"))).toBe("2026-02-28");
  });
});

describe("pulseDayRange", () => {
  it("is half-open [04:00 IST, next 04:00 IST)", () => {
    const { start, end } = pulseDayRange("2026-11-26");
    expect(start.toISOString()).toBe("2026-11-25T22:30:00.000Z");
    expect(end.toISOString()).toBe("2026-11-26T22:30:00.000Z");
    expect(pulseDayKey(start)).toBe("2026-11-26");
    expect(pulseDayKey(new Date(end.getTime() - 1))).toBe("2026-11-26");
    expect(pulseDayKey(end)).toBe("2026-11-27");
  });
  it("throws on malformed keys", () => {
    expect(() => pulseDayRange("2026-13-01")).toThrow();
    expect(() => pulseDayRange("2026-02-30")).toThrow();
    expect(() => pulseDayRange("26-11-26")).toThrow();
  });
});

describe("startOfPulseDay", () => {
  it("01:00 IST returns the previous date's 04:00 IST boundary", () => {
    expect(startOfPulseDay(new Date("2026-11-26T01:00:00+05:30")).toISOString()).toBe(
      "2026-11-24T22:30:00.000Z",
    );
  });
  it("05:00 IST returns the same date's 04:00 IST boundary", () => {
    expect(startOfPulseDay(new Date("2026-11-26T05:00:00+05:30")).toISOString()).toBe(
      "2026-11-25T22:30:00.000Z",
    );
  });
});

describe("blockInstants", () => {
  it("daytime block lands on dayKey", () => {
    const { start, end } = blockInstants("2026-11-26", "07:00", "07:30");
    expect(start.toISOString()).toBe("2026-11-26T01:30:00.000Z");
    expect(end.toISOString()).toBe("2026-11-26T02:00:00.000Z");
  });
  it("post-midnight block lands on dayKey + 1", () => {
    const { start, end } = blockInstants("2026-11-26", "00:30", "01:00");
    expect(start.toISOString()).toBe("2026-11-26T19:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-26T19:30:00.000Z");
    expect(pulseDayKey(start)).toBe("2026-11-26");
  });
  it("block crossing midnight rolls end to the next day", () => {
    const { start, end } = blockInstants("2026-11-26", "22:30", "00:30");
    expect(start.toISOString()).toBe("2026-11-26T17:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-26T19:00:00.000Z");
  });
  it("handles month ends", () => {
    const { end } = blockInstants("2026-11-30", "22:30", "00:30");
    expect(end.toISOString()).toBe("2026-11-30T19:00:00.000Z");
  });
  it("throws on malformed HH:MM", () => {
    expect(() => blockInstants("2026-11-26", "7:00", "08:00")).toThrow();
    expect(() => blockInstants("2026-11-26", "24:00", "08:00")).toThrow();
    expect(() => blockInstants("2026-11-26", "07:00", "08:60")).toThrow();
    expect(() => blockInstants("2026-11-26", "07:00", "noon")).toThrow();
  });
});

describe("currentPulseDayKey (fake clock)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the previous date at ~02:00 IST", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T02:00:00+05:30"));
    expect(currentPulseDayKey()).toBe("2026-11-25");
  });
  it("uses today at ~05:00 IST", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T05:00:00+05:30"));
    expect(currentPulseDayKey()).toBe("2026-11-26");
  });
  it("accepts an injected clock", () => {
    expect(currentPulseDayKey(new Date("2026-11-26T03:59:00+05:30"))).toBe("2026-11-25");
  });
});
