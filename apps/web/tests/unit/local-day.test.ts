import { getLocalDateString, getStartupDateRedirect } from "@/lib/startup-date";
import { buildRecipePortionMealEntryInput } from "@/lib/recipe-portion";
import type { RecipeRecord } from "@macro-tracker/db";
import { afterEach, describe, expect, it } from "vitest";

/**
 * CI runs in UTC, so every timezone bug in this app used to pass by
 * construction. These tests pin `process.env.TZ` to zones on either side of
 * UTC and assert the day boundary each one produces.
 */
const originalTz = process.env.TZ;

function withTimeZone<T>(timeZone: string, run: () => T): T {
  process.env.TZ = timeZone;
  try {
    return run();
  } finally {
    process.env.TZ = originalTz;
  }
}

afterEach(() => {
  process.env.TZ = originalTz;
});

describe("getLocalDateString across timezones", () => {
  it("reports the previous day for a zone behind UTC", () => {
    const instant = new Date("2026-01-16T02:30:00Z");

    expect(withTimeZone("UTC", () => getLocalDateString(instant))).toBe("2026-01-16");
    expect(withTimeZone("America/New_York", () => getLocalDateString(instant))).toBe(
      "2026-01-15",
    );
  });

  it("reports the next day for a zone ahead of UTC", () => {
    const instant = new Date("2026-01-14T20:00:00Z");

    expect(withTimeZone("UTC", () => getLocalDateString(instant))).toBe("2026-01-14");
    expect(withTimeZone("Pacific/Auckland", () => getLocalDateString(instant))).toBe(
      "2026-01-15",
    );
  });
});

describe("getStartupDateRedirect", () => {
  it("corrects a server-rendered day that is not the browser's day", () => {
    expect(
      getStartupDateRedirect({
        requestedDate: null,
        selectedDate: "2026-01-14",
        localDate: "2026-01-15",
      }),
    ).toBe("2026-01-15");
  });

  it("leaves an explicitly requested day alone", () => {
    expect(
      getStartupDateRedirect({
        requestedDate: "2026-01-10",
        selectedDate: "2026-01-10",
        localDate: "2026-01-15",
      }),
    ).toBeNull();
  });

  it("does nothing when the server already rendered the browser's day", () => {
    expect(
      getStartupDateRedirect({
        requestedDate: null,
        selectedDate: "2026-01-15",
        localDate: "2026-01-15",
      }),
    ).toBeNull();
  });
});

describe("buildRecipePortionMealEntryInput", () => {
  const recipe: RecipeRecord = {
    id: "recipe-1",
    userId: "user-1",
    label: "Chili",
    portions: 4,
    totalCookedWeightG: 1000,
    perPortionMacros: { proteinG: 20, carbsG: 60, fatG: 10, caloriesKcal: 420 },
    totalMacros: { proteinG: 80, carbsG: 240, fatG: 40, caloriesKcal: 1680 },
    ingredients: [],
  } as unknown as RecipeRecord;

  it("uses the caller's status verbatim rather than re-deriving it", () => {
    // The whole point of the fix: a user in UTC+13 logging at 09:00 local sends
    // tomorrow's date by the server's reckoning, and it must still be "eaten".
    const input = buildRecipePortionMealEntryInput({
      date: "2026-01-15",
      gramsConsumed: null,
      portionCount: 1,
      recipe,
      status: "eaten",
    });

    expect(input.status).toBe("eaten");
    expect(input.date).toBe("2026-01-15");
  });

  it("carries a planned status through unchanged", () => {
    const input = buildRecipePortionMealEntryInput({
      date: "2026-02-01",
      gramsConsumed: null,
      portionCount: 2,
      recipe,
      status: "planned",
    });

    expect(input.status).toBe("planned");
    expect(input.label).toBe("Chili (2 portions)");
    expect(input.quantity).toBe(2);
    expect(input.unit).toBe("serving");
    expect(input.proteinG).toBe(40);
    expect(input.caloriesKcal).toBe(840);
  });

  it("scales by cooked weight when grams are given", () => {
    const input = buildRecipePortionMealEntryInput({
      date: "2026-02-01",
      gramsConsumed: 250,
      portionCount: 1,
      recipe,
      status: "eaten",
    });

    // 250 g of a 1000 g / 4-portion recipe is exactly one portion.
    expect(input.label).toBe("Chili (250g)");
    expect(input.unit).toBe("g");
    expect(input.quantity).toBe(250);
    expect(input.proteinG).toBe(20);
    expect(input.caloriesKcal).toBe(420);
  });

  it("refuses grams when the recipe has no cooked weight", () => {
    expect(() =>
      buildRecipePortionMealEntryInput({
        date: "2026-02-01",
        gramsConsumed: 100,
        portionCount: 1,
        recipe: { ...recipe, totalCookedWeightG: null } as RecipeRecord,
        status: "eaten",
      }),
    ).toThrow("Recipe cooked weight is required to log grams.");
  });
});
