import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createMealEntry: vi.fn(),
  createMealGroup: vi.fn(),
  createRecipe: vi.fn(),
  createTemplate: vi.fn(),
  createTemplateFromDate: vi.fn(),
  createWeightEntry: vi.fn(),
  completeOnboardingSetup: vi.fn(),
  completeUserOnboarding: vi.fn(),
  deleteMealGroup: vi.fn(),
  deleteMealEntry: vi.fn(),
  deleteRecipe: vi.fn(),
  deleteTemplate: vi.fn(),
  deleteWeightEntry: vi.fn(),
  getRecipeById: vi.fn(),
  getTemplateById: vi.fn(),
  markMealEntryStatus: vi.fn(),
  applyTemplateToDate: vi.fn(),
  saveBarcodeFoodProduct: vi.fn(),
  saveUserGoals: vi.fn(),
  saveWeightGoal: vi.fn(),
  searchFoodProducts: vi.fn(),
  searchMealEntries: vi.fn(),
  updateMealGroup: vi.fn(),
  updateMealEntry: vi.fn(),
  updateRecipe: vi.fn(),
  updateTemplate: vi.fn(),
  updateWeightEntry: vi.fn(),
  requireSessionUser: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@macro-tracker/db", () => ({
  createMealEntry: mocked.createMealEntry,
  createMealGroup: mocked.createMealGroup,
  createRecipe: mocked.createRecipe,
  createTemplate: mocked.createTemplate,
  createTemplateFromDate: mocked.createTemplateFromDate,
  createWeightEntry: mocked.createWeightEntry,
  completeOnboardingSetup: mocked.completeOnboardingSetup,
  completeUserOnboarding: mocked.completeUserOnboarding,
  deleteMealGroup: mocked.deleteMealGroup,
  deleteMealEntry: mocked.deleteMealEntry,
  deleteRecipe: mocked.deleteRecipe,
  deleteTemplate: mocked.deleteTemplate,
  deleteWeightEntry: mocked.deleteWeightEntry,
  getRecipeById: mocked.getRecipeById,
  getTemplateById: mocked.getTemplateById,
  markMealEntryStatus: mocked.markMealEntryStatus,
  applyTemplateToDate: mocked.applyTemplateToDate,
  saveBarcodeFoodProduct: mocked.saveBarcodeFoodProduct,
  saveUserGoals: mocked.saveUserGoals,
  saveWeightGoal: mocked.saveWeightGoal,
  searchFoodProducts: mocked.searchFoodProducts,
  searchMealEntries: mocked.searchMealEntries,
  updateMealGroup: mocked.updateMealGroup,
  updateMealEntry: mocked.updateMealEntry,
  updateRecipe: mocked.updateRecipe,
  updateTemplate: mocked.updateTemplate,
  updateWeightEntry: mocked.updateWeightEntry,
}));

vi.mock("@/lib/auth", () => ({
  requireSessionUser: mocked.requireSessionUser,
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocked.revalidatePath,
}));

import {
  deleteMealEntryAction,
  deleteRecipeAction,
  deleteTemplateAction,
  deleteWeightEntryAction,
  completeOnboardingAction,
  logRecipePortionAction,
  saveTemplateAction,
  searchFoodsAction,
  updateTemplateAction,
} from "@/lib/actions";

describe("server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.requireSessionUser.mockResolvedValue({
      userId: "user-1",
      email: "coach@example.com",
    });
  });

  it("searches history and products through one authenticated action", async () => {
    mocked.searchMealEntries.mockResolvedValue([
      {
        id: "entry-1",
        userId: "user-1",
        date: "2026-06-20",
        mealGroupId: null,
        status: "eaten",
        productId: null,
        label: "Greek yogurt",
        sortOrder: 0,
        quantity: 1,
        unit: "serving",
        servingMultiplier: 1,
        proteinG: 20,
        carbsG: 8,
        fatG: 0,
        caloriesKcal: 112,
      },
    ]);
    mocked.searchFoodProducts.mockResolvedValue([
      {
        id: "product-1",
        ownerUserId: "user-1",
        scope: "personal",
        source: "custom",
        name: "Greek yogurt",
        brand: null,
        barcode: null,
        defaultServingQuantity: 1,
        defaultServingUnit: "serving",
        servingWeightG: 170,
        servingVolumeMl: null,
        proteinPer100: 11.8,
        carbsPer100: 4.7,
        fatPer100: 0,
        caloriesPer100: 66,
        isActive: true,
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
      },
    ]);

    const result = await searchFoodsAction({ query: "  greek  " });

    expect(result).toMatchObject({
      ok: true,
      results: [{ id: "entry-1" }],
      products: [{ id: "product-1" }],
    });
    expect(mocked.requireSessionUser).toHaveBeenCalledTimes(1);
    expect(mocked.searchMealEntries).toHaveBeenCalledWith("user-1", "greek");
    expect(mocked.searchFoodProducts).toHaveBeenCalledWith("user-1", "greek");
  });

  it("keeps history results available when product search fails", async () => {
    mocked.searchMealEntries.mockResolvedValue([
      {
        id: "entry-1",
        userId: "user-1",
        date: "2026-06-20",
        mealGroupId: null,
        status: "eaten",
        productId: null,
        label: "Greek yogurt",
        sortOrder: 0,
        quantity: 1,
        unit: "serving",
        servingMultiplier: 1,
        proteinG: 20,
        carbsG: 8,
        fatG: 0,
        caloriesKcal: 112,
      },
    ]);
    mocked.searchFoodProducts.mockRejectedValue(new Error("catalog down"));

    const result = await searchFoodsAction({ query: "greek" });

    expect(result).toEqual({
      ok: true,
      results: [
        {
          id: "entry-1",
          userId: "user-1",
          date: "2026-06-20",
          mealGroupId: null,
          status: "eaten",
          productId: null,
          label: "Greek yogurt",
          sortOrder: 0,
          quantity: 1,
          unit: "serving",
          servingMultiplier: 1,
          proteinG: 20,
          carbsG: 8,
          fatG: 0,
          caloriesKcal: 112,
        },
      ],
      products: [],
      error: "Product search failed, but history results are still available.",
    });
  });

  it.each([
    {
      name: "meal entries",
      action: deleteMealEntryAction,
      deleter: mocked.deleteMealEntry,
      input: { id: "meal-1" },
      error: "Meal entry not found.",
    },
    {
      name: "templates",
      action: deleteTemplateAction,
      deleter: mocked.deleteTemplate,
      input: { id: "template-1" },
      error: "Template not found.",
    },
    {
      name: "weight entries",
      action: deleteWeightEntryAction,
      deleter: mocked.deleteWeightEntry,
      input: { id: "weight-1" },
      error: "Weight entry not found.",
    },
    {
      name: "recipes",
      action: deleteRecipeAction,
      deleter: mocked.deleteRecipe,
      input: { id: "recipe-1" },
      error: "Recipe not found.",
    },
  ])("returns a failure when deleting missing $name", async ({
    action,
    deleter,
    input,
    error,
  }) => {
    deleter.mockResolvedValue(false);

    const result = await action(input);

    expect(result).toEqual({ ok: false, error });
    expect(mocked.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([0, -10, Number.NaN])(
    "rejects invalid recipe grams before creating a meal",
    async (gramsConsumed) => {
      mocked.getRecipeById.mockResolvedValue({
        id: "recipe-1",
        userId: "user-1",
        label: "Rice bowl",
        portions: 4,
        totalCookedWeightG: 800,
        perPortionMacros: {
          proteinG: 20,
          carbsG: 60,
          fatG: 10,
          caloriesKcal: 420,
        },
        totalMacros: {
          proteinG: 80,
          carbsG: 240,
          fatG: 40,
          caloriesKcal: 1680,
        },
        ingredients: [],
      });

      const result = await logRecipePortionAction({
        recipeId: "recipe-1",
        date: "2026-05-10",
        status: "eaten",
        gramsConsumed,
      });

      expect(result).toEqual({
        ok: false,
        error: "Grams consumed must be greater than 0.",
      });
      expect(mocked.createMealEntry).not.toHaveBeenCalled();
      expect(mocked.revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("refuses to rewrite day templates through the single-food template update action", async () => {
    mocked.getTemplateById.mockResolvedValue({
      id: "template-1",
      userId: "user-1",
      type: "day",
      label: "Full day",
      notes: null,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
      items: [
        {
          id: "item-1",
          templateId: "template-1",
          productId: null,
          mealGroupLabel: "Breakfast",
          sortOrder: 0,
          label: "Oats",
          quantity: 1,
          unit: "serving",
          servingMultiplier: 1,
          proteinG: 20,
          carbsG: 40,
          fatG: 8,
          caloriesKcal: 312,
        },
      ],
    });

    const result = await updateTemplateAction({
      id: "template-1",
      label: "Changed",
      proteinG: 1,
      carbsG: 1,
      fatG: 1,
      caloriesKcal: 20,
    });

    expect(result).toEqual({
      ok: false,
      error: "This template cannot be edited from the single-food template form.",
    });
    expect(mocked.updateTemplate).not.toHaveBeenCalled();
  });

  it("preserves scanned gram quantity when saving a single-food template", async () => {
    mocked.createTemplate.mockResolvedValue({
      id: "template-1",
      userId: "user-1",
      type: "meal",
      label: "Jonge Kaas",
      notes: null,
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z",
      items: [
        {
          id: "item-1",
          templateId: "template-1",
          productId: "product-1",
          mealGroupLabel: null,
          sortOrder: 0,
          label: "Jonge Kaas",
          quantity: 76,
          unit: "g",
          servingMultiplier: 1,
          proteinG: 17.5,
          carbsG: 0,
          fatG: 23.6,
          caloriesKcal: 287,
        },
      ],
    });

    const result = await saveTemplateAction({
      productId: "product-1",
      label: "Jonge Kaas",
      quantity: 76,
      unit: "g",
      servingMultiplier: 1,
      proteinG: 17.5,
      carbsG: 0,
      fatG: 23.6,
      caloriesKcal: 287,
    });

    expect(result).toMatchObject({ ok: true, template: { id: "template-1" } });
    expect(mocked.createTemplate).toHaveBeenCalledWith("user-1", {
      type: "meal",
      label: "Jonge Kaas",
      items: [
        {
          productId: "product-1",
          mealGroupLabel: null,
          label: "Jonge Kaas",
          quantity: 76,
          unit: "g",
          servingMultiplier: 1,
          proteinG: 17.5,
          carbsG: 0,
          fatG: 23.6,
          caloriesKcal: 287,
        },
      ],
    });
  });

  it("completes onboarding through the atomic setup helper", async () => {
    mocked.completeOnboardingSetup.mockResolvedValue({
      id: "user-1",
      email: "coach@example.com",
      shooPairwiseSub: "shoo-1",
      displayName: null,
      pictureUrl: null,
      role: "user",
      createdAt: "2026-06-20T00:00:00.000Z",
      lastLoginAt: "2026-06-20T00:00:00.000Z",
      goalCaloriesKcal: 2200,
      goalProteinG: 170,
      goalCarbsG: 240,
      goalFatG: 70,
      goalWeightKg: 78,
      onboardingCompletedAt: "2026-06-20T00:00:00.000Z",
      preferredWeightUnit: "kg",
    });

    const result = await completeOnboardingAction({
      preferredWeightUnit: "kg",
      goals: {
        caloriesKcal: 2200,
        proteinG: 170,
        carbsG: 240,
        fatG: 70,
      },
      goalWeightKg: 78,
      currentWeightKg: 82.5,
      currentWeightDate: "2026-06-20",
      starterTemplate: {
        label: "Greek yogurt",
        proteinG: 30,
        carbsG: 12,
        fatG: 2,
        caloriesKcal: 186,
      },
    });

    expect(result).toEqual({ ok: true });
    expect(mocked.completeOnboardingSetup).toHaveBeenCalledWith("user-1", {
      preferredWeightUnit: "kg",
      goals: {
        caloriesKcal: 2200,
        proteinG: 170,
        carbsG: 240,
        fatG: 70,
      },
      goalWeightKg: 78,
      currentWeight: {
        date: "2026-06-20",
        weightKg: 82.5,
        bodyFatPct: null,
        notes: "Onboarding",
      },
      starterTemplate: {
        type: "meal",
        label: "Greek yogurt",
        items: [
          {
            productId: null,
            mealGroupLabel: null,
            label: "Greek yogurt",
            quantity: 1,
            unit: "serving",
            servingMultiplier: 1,
            proteinG: 30,
            carbsG: 12,
            fatG: 2,
            caloriesKcal: 186,
          },
        ],
      },
    });
    expect(mocked.saveUserGoals).not.toHaveBeenCalled();
    expect(mocked.saveWeightGoal).not.toHaveBeenCalled();
    expect(mocked.createWeightEntry).not.toHaveBeenCalled();
    expect(mocked.createTemplate).not.toHaveBeenCalled();
    expect(mocked.completeUserOnboarding).not.toHaveBeenCalled();
    expect(mocked.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});
