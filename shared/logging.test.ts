import { describe, expect, it } from "vitest";
import { mealsSummary, reconcileDayLogs, waterTotals } from "./logging";

describe("waterTotals", () => {
  it("excludes gym water from drankMl and sums it separately", () => {
    const t = waterTotals([
      { amount_ml: 500, is_gym: false },
      { amount_ml: 1000, is_gym: false },
      { amount_ml: 500, is_gym: true },
      { amount_ml: 1000, is_gym: true },
    ]);
    expect(t.drankMl).toBe(1500);
    expect(t.gymMl).toBe(1500);
    expect(t.targetMl).toBe(2000);
    expect(t.bottles).toBe(1.5);
    expect(t.fraction).toBeCloseTo(0.75);
  });

  it("clamps fraction at 1 past the target", () => {
    const t = waterTotals([
      { amount_ml: 1000, is_gym: false },
      { amount_ml: 1000, is_gym: false },
      { amount_ml: 1000, is_gym: false },
    ]);
    expect(t.drankMl).toBe(3000);
    expect(t.fraction).toBe(1);
  });

  it("handles no logs", () => {
    const t = waterTotals([]);
    expect(t).toEqual({
      drankMl: 0,
      gymMl: 0,
      targetMl: 2000,
      bottles: 0,
      fraction: 0,
    });
  });
});

describe("mealsSummary", () => {
  it("reports partial logs with null for unlogged meals", () => {
    const s = mealsSummary([
      { meal: "breakfast", place: "mess" },
      { meal: "lunch", place: "outside" },
    ]);
    expect(s.logged).toBe(2);
    expect(s.total).toBe(4);
    expect(s.byMeal).toEqual({
      breakfast: "mess",
      lunch: "outside",
      snacks: null,
      dinner: null,
    });
    expect(s.eatingOut).toBe(1);
  });

  it("counts outside and ordered_in as eating out", () => {
    const s = mealsSummary([
      { meal: "breakfast", place: "mess" },
      { meal: "lunch", place: "outside" },
      { meal: "snacks", place: "ordered_in" },
      { meal: "dinner", place: "mess" },
    ]);
    expect(s.logged).toBe(4);
    expect(s.eatingOut).toBe(2);
  });

  it("lets the last log win for a duplicated meal", () => {
    const s = mealsSummary([
      { meal: "lunch", place: "mess" },
      { meal: "lunch", place: "ordered_in" },
    ]);
    expect(s.logged).toBe(1);
    expect(s.byMeal.lunch).toBe("ordered_in");
    expect(s.eatingOut).toBe(1);
  });

  it("handles no logs", () => {
    const s = mealsSummary([]);
    expect(s.logged).toBe(0);
    expect(s.eatingOut).toBe(0);
  });
});

describe("reconcileDayLogs", () => {
  it("adds pending water entries to the server water", () => {
    const r = reconcileDayLogs(
      { meals: [], water: [{ amount_ml: 1000, is_gym: false }] },
      { meals: [], water: [{ amount_ml: 500, is_gym: false }] },
    );
    expect(r.water).toHaveLength(2);
    expect(waterTotals(r.water).drankMl).toBe(1500);
  });

  it("counts a server row and its still-pending retry only once by id", () => {
    const water = { id: "water-event-1", amount_ml: 1000, is_gym: false };
    const r = reconcileDayLogs(
      { meals: [], water: [water] },
      { meals: [], water: [water] },
    );

    expect(r.water).toEqual([water]);
    expect(waterTotals(r.water).drankMl).toBe(1000);
  });

  it("deduplicates a legacy pending row by its exact event timestamp", () => {
    const loggedAt = "2026-11-26T09:00:00.000Z";
    const r = reconcileDayLogs(
      {
        meals: [],
        water: [
          {
            id: "server-generated-id",
            amount_ml: 500,
            is_gym: false,
            logged_at: loggedAt,
          },
        ],
      },
      {
        meals: [],
        water: [{ amount_ml: 500, is_gym: false, logged_at: loggedAt }],
      },
    );

    expect(r.water).toHaveLength(1);
    expect(waterTotals(r.water).drankMl).toBe(500);
  });

  it("lets a pending meal override the server place for that meal", () => {
    const r = reconcileDayLogs(
      { meals: [{ meal: "lunch", place: "mess" }], water: [] },
      { meals: [{ meal: "lunch", place: "outside" }], water: [] },
    );
    expect(r.meals).toEqual([{ meal: "lunch", place: "outside" }]);
  });

  it("keeps server-only meals and adds pending-only meals", () => {
    const r = reconcileDayLogs(
      { meals: [{ meal: "breakfast", place: "mess" }], water: [] },
      { meals: [{ meal: "dinner", place: "ordered_in" }], water: [] },
    );
    const s = mealsSummary(r.meals);
    expect(s.byMeal.breakfast).toBe("mess");
    expect(s.byMeal.dinner).toBe("ordered_in");
    expect(s.logged).toBe(2);
  });

  it("uses the last pending entry when a meal is queued twice", () => {
    const r = reconcileDayLogs(
      { meals: [], water: [] },
      {
        meals: [
          { meal: "snacks", place: "mess" },
          { meal: "snacks", place: "outside" },
        ],
        water: [],
      },
    );
    expect(r.meals).toEqual([{ meal: "snacks", place: "outside" }]);
  });
});
