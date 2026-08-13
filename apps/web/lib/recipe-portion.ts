import type { MealEntryInput, MealEntryStatus, RecipeRecord } from "@macro-tracker/db";

import { roundToSingleDecimal } from "./numbers";

export type RecipePortionMealEntryInput = Omit<MealEntryInput, "sortOrder"> & {
  sortOrder?: number;
};

/**
 * `status` is resolved by the caller against *its* calendar day. Deriving it
 * here from a server-side `today` produced wrong-day classifications for users
 * whose zone differs from the server's.
 */
export function buildRecipePortionMealEntryInput({
  date,
  gramsConsumed,
  portionCount,
  recipe,
  status,
}: {
  date: string;
  gramsConsumed: number | null;
  portionCount: number;
  recipe: RecipeRecord;
  status: MealEntryStatus;
}): RecipePortionMealEntryInput {
  if (
    gramsConsumed != null &&
    (recipe.totalCookedWeightG == null || recipe.totalCookedWeightG <= 0)
  ) {
    throw new Error("Recipe cooked weight is required to log grams.");
  }

  const hasGramsConsumed = gramsConsumed != null;
  const factor = hasGramsConsumed
    ? (gramsConsumed / recipe.totalCookedWeightG!) * recipe.portions
    : portionCount;

  return {
    date,
    status,
    label: hasGramsConsumed
      ? `${recipe.label} (${gramsConsumed}g)`
      : `${recipe.label} (${portionCount} portion${portionCount === 1 ? "" : "s"})`,
    quantity: gramsConsumed ?? portionCount,
    unit: hasGramsConsumed ? "g" : "serving",
    proteinG: roundToSingleDecimal(recipe.perPortionMacros.proteinG * factor),
    carbsG: roundToSingleDecimal(recipe.perPortionMacros.carbsG * factor),
    fatG: roundToSingleDecimal(recipe.perPortionMacros.fatG * factor),
    caloriesKcal: Math.round(recipe.perPortionMacros.caloriesKcal * factor),
  };
}
