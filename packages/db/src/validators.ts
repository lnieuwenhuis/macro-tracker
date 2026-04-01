import type { MacroNumbers, MealEntryInput } from "./types";

export class MealEntryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MealEntryValidationError";
  }
}

function roundToSingleDecimal(value: number) {
  return Math.round(value * 10) / 10;
}

function assertFiniteNonNegative(value: number, fieldName: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new MealEntryValidationError(`${fieldName} must be a non-negative number.`);
  }
}

function assertInteger(value: number, fieldName: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new MealEntryValidationError(`${fieldName} must be a non-negative integer.`);
  }
}

export function normalizeMacroNumbers(input: MacroNumbers): MacroNumbers {
  assertFiniteNonNegative(input.proteinG, "Protein");
  assertFiniteNonNegative(input.carbsG, "Carbs");
  assertFiniteNonNegative(input.fatG, "Fat");
  assertFiniteNonNegative(input.caloriesKcal, "Calories");
  assertInteger(input.caloriesKcal, "Calories");

  return {
    proteinG: roundToSingleDecimal(input.proteinG),
    carbsG: roundToSingleDecimal(input.carbsG),
    fatG: roundToSingleDecimal(input.fatG),
    caloriesKcal: input.caloriesKcal,
  };
}

export function validateMealEntryInput(input: MealEntryInput): MealEntryInput {
  const label = input.label.trim();
  const sortOrder = Number(input.sortOrder);

  if (!label) {
    throw new MealEntryValidationError("Meal name is required.");
  }

  assertInteger(sortOrder, "Sort order");

  const macros = normalizeMacroNumbers({
    proteinG: input.proteinG,
    carbsG: input.carbsG,
    fatG: input.fatG,
    caloriesKcal: input.caloriesKcal,
  });

  const hasAnyNutrition =
    macros.proteinG > 0 ||
    macros.carbsG > 0 ||
    macros.fatG > 0 ||
    macros.caloriesKcal > 0;

  if (!hasAnyNutrition) {
    throw new MealEntryValidationError(
      "At least one macro or calorie value must be greater than zero.",
    );
  }

  return {
    ...input,
    ...macros,
    label,
    sortOrder,
  };
}
