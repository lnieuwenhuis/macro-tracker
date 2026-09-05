import { afterEach, describe, expect, it } from "vitest";

import {
  createMealEntry,
  createMealGroup,
  createPersonalFoodProduct,
  searchMealEntries,
  upsertUserFromShooProfile,
  type DatabaseRuntime,
  type MealEntryRecord,
} from "@macro-tracker/db";
import { createTestDatabase } from "@macro-tracker/db/testing";

import { buildMealEntryCopyInput } from "@/lib/meal-entry-copy";

function buildEntry(overrides: Partial<MealEntryRecord> = {}): MealEntryRecord {
  return {
    id: "entry-1",
    userId: "user-1",
    date: "2026-06-18",
    mealGroupId: "group-1",
    status: "planned",
    productId: "product-1",
    label: "Greek yogurt",
    sortOrder: 3,
    quantity: 150,
    unit: "g",
    servingMultiplier: 1.5,
    proteinG: 18,
    carbsG: 9,
    fatG: 3,
    caloriesKcal: 135,
    clientMutationId: null,
    sourceLabel: null,
    ...overrides,
  };
}

describe("buildMealEntryCopyInput", () => {
  let runtime: DatabaseRuntime | undefined;

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  it("preserves product-backed metadata while copying the entry as eaten on the target date", () => {
    const entry = buildEntry();

    expect(buildMealEntryCopyInput(entry, "2026-06-19")).toEqual({
      date: "2026-06-19",
      mealGroupId: "group-1",
      status: "eaten",
      productId: "product-1",
      label: "Greek yogurt",
      quantity: 150,
      unit: "g",
      servingMultiplier: 1.5,
      proteinG: 18,
      carbsG: 9,
      fatG: 3,
      caloriesKcal: 135,
    });
  });

  it(
    "preserves product-backed search history metadata when copying an entry",
    async () => {
      runtime = await createTestDatabase();
      const user = await upsertUserFromShooProfile(
        {
          pairwiseSub: "ps_copy_search_user",
          email: "copy-search@example.com",
          displayName: "Copy Search",
        },
      );
      const mealGroup = await createMealGroup(
        user.id,
        { label: "Post-workout" },
      );
      const product = await createPersonalFoodProduct(
        user.id,
        {
          name: "Skyr yogurt",
          source: "manual",
          defaultServingQuantity: 100,
          defaultServingUnit: "g",
          proteinPer100: 11,
          carbsPer100: 4,
          fatPer100: 0,
          caloriesPer100: 60,
        },
      );

      await createMealEntry(
        user.id,
        {
          date: "2026-06-18",
          mealGroupId: mealGroup.id,
          productId: product.id,
          label: "Skyr yogurt bowl",
          quantity: 150,
          unit: "g",
          servingMultiplier: 1.5,
          proteinG: 0,
          carbsG: 0,
          fatG: 0,
          caloriesKcal: 1,
        },
      );

      const [result] = await searchMealEntries(user.id, "skyr");

      expect(buildMealEntryCopyInput(result!, "2026-06-19")).toMatchObject({
        productId: product.id,
        mealGroupId: mealGroup.id,
        quantity: 150,
        unit: "g",
        servingMultiplier: 1.5,
      });
    },
    10_000,
  );
});
