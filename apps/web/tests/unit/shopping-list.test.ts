import { describe, expect, it } from "vitest";

import type { DailySummary, MealEntryRecord } from "@macro-tracker/db";

import { buildShoppingList, formatShoppingListText } from "@/lib/shopping-list";

function meal(overrides: Partial<MealEntryRecord>): MealEntryRecord {
  return {
    id: "meal",
    userId: "user",
    date: "2026-06-01",
    mealGroupId: null,
    status: "planned",
    productId: null,
    label: "Food",
    sortOrder: 0,
    quantity: 1,
    unit: "serving",
    servingMultiplier: 1,
    proteinG: 0,
    carbsG: 0,
    fatG: 0,
    caloriesKcal: 0,
    clientMutationId: null,
    sourceLabel: null,
    ...overrides,
  };
}

function summary(date: string, meals: MealEntryRecord[]): DailySummary {
  return {
    date,
    totals: {
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      caloriesKcal: 0,
    },
    plannedTotals: {
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      caloriesKcal: 0,
    },
    skippedTotals: {
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      caloriesKcal: 0,
    },
    mealGroups: [],
    meals,
  };
}

describe("buildShoppingList", () => {
  it("combines planned items with matching normalized label and unit", () => {
    const items = buildShoppingList([
      summary("2026-06-01", [
        meal({ id: "a", label: "Greek yogurt", quantity: 150, unit: "g" }),
      ]),
      summary("2026-06-02", [
        meal({ id: "b", label: " greek   yogurt ", quantity: 200, unit: "g" }),
      ]),
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        label: "Greek yogurt",
        unit: "g",
        quantity: 350,
        dates: ["2026-06-01", "2026-06-02"],
        sourceCount: 2,
        notes: ["2 planned entries"],
      }),
    ]);
  });

  it("keeps matching labels with different units separate", () => {
    const items = buildShoppingList([
      summary("2026-06-01", [
        meal({ id: "a", label: "Milk", quantity: 200, unit: "ml" }),
        meal({ id: "b", label: "Milk", quantity: 1, unit: "serving" }),
      ]),
    ]);

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.unit).sort()).toEqual(["ml", "serving"]);
  });

  it("ignores eaten and skipped entries", () => {
    const items = buildShoppingList([
      summary("2026-06-01", [
        meal({ id: "a", label: "Planned oats", quantity: 100, unit: "g" }),
        meal({ id: "b", label: "Eaten oats", status: "eaten", quantity: 100, unit: "g" }),
        meal({ id: "c", label: "Skipped oats", status: "skipped", quantity: 100, unit: "g" }),
      ]),
    ]);

    expect(items.map((item) => item.label)).toEqual(["Planned oats"]);
  });

  it("formats copy text for clipboard output", () => {
    expect(
      formatShoppingListText([
        {
          label: "Greek yogurt",
          unit: "g",
          quantity: 350,
          dates: ["2026-06-01"],
          sourceCount: 2,
          notes: ["2 planned entries"],
        },
      ]),
    ).toBe("- Greek yogurt: 350 g (2 planned entries)");
  });
});
