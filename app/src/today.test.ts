import { blockInstants } from "@pulse/shared";
import { describe, expect, it } from "vitest";
import { dateLabelFor, formatTime, greetingFor } from "./Today";

describe("greetingFor", () => {
  it("switches phrase at the 12:00 and 17:00 boundaries", () => {
    expect(greetingFor(0)).toBe("Good morning");
    expect(greetingFor(11)).toBe("Good morning");
    expect(greetingFor(12)).toBe("Good afternoon");
    expect(greetingFor(16)).toBe("Good afternoon");
    expect(greetingFor(17)).toBe("Good evening");
    expect(greetingFor(23)).toBe("Good evening");
  });

  it("appends a provided name", () => {
    expect(greetingFor(9, "Sam")).toBe("Good morning, Sam");
    expect(greetingFor(20, " Sam ")).toBe("Good evening, Sam");
  });

  it("includes no name when none (or a blank one) is given", () => {
    expect(greetingFor(9)).toBe("Good morning");
    expect(greetingFor(9, "")).toBe("Good morning");
    expect(greetingFor(9, "   ")).toBe("Good morning");
  });
});

describe("formatTime", () => {
  it("renders IST, not the host timezone", () => {
    expect(formatTime(new Date("2026-11-26T14:15:00.000Z"))).toBe("19:45");
    expect(formatTime(new Date("2026-11-26T00:00:00.000Z"))).toBe("05:30");
  });

  it("wraps past midnight IST", () => {
    expect(formatTime(new Date("2026-11-26T19:00:00.000Z"))).toBe("00:30");
  });

  it("agrees with blockInstants", () => {
    expect(formatTime(blockInstants("2026-11-26", "07:05", "07:05").start)).toBe(
      "07:05",
    );
  });
});

describe("dateLabelFor", () => {
  it("labels the IST calendar date", () => {
    expect(dateLabelFor(new Date("2026-11-26T14:15:00.000Z"))).toBe(
      "Thu, 26 Nov",
    );
  });

  it("uses the IST date even when UTC is still the previous day", () => {
    // 20:00 UTC on Fri 27 Nov is 01:30 IST on Sat 28 Nov.
    expect(dateLabelFor(new Date("2026-11-27T20:00:00.000Z"))).toBe(
      "Sat, 28 Nov",
    );
  });
});
