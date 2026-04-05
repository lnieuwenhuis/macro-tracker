import type { MacroNumbers, MealEntryInput, RecipeInput, WeightEntryInput } from "./types";

export class MealEntryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MealEntryValidationError";
  }
}

function roundToSingleDecimal(value: number) {
  return Math.round(value * 10) / 10;
}

export class WeightEntryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeightEntryValidationError";
  }
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

export class RecipeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeValidationError";
  }
}

export function validateRecipeInput(input: RecipeInput): RecipeInput {
  const label = input.label.trim();
  if (!label) {
    throw new RecipeValidationError("Recipe name is required.");
  }

  const portions = Math.round(input.portions);
  if (!Number.isFinite(portions) || portions < 1) {
    throw new RecipeValidationError("Portions must be at least 1.");
  }
  if (portions > 999) {
    throw new RecipeValidationError("Portions must be less than 1000.");
  }

  if (input.ingredients.length === 0) {
    throw new RecipeValidationError(
      "A recipe must have at least one ingredient.",
    );
  }

  const ingredients = input.ingredients.map((ing, i) => {
    const ingLabel = ing.label.trim();
    if (!ingLabel) {
      throw new RecipeValidationError(
        `Ingredient ${i + 1} name is required.`,
      );
    }
    const macros = normalizeMacroNumbers({
      proteinG: ing.proteinG,
      carbsG: ing.carbsG,
      fatG: ing.fatG,
      caloriesKcal: ing.caloriesKcal,
    });
    return { ...macros, label: ingLabel };
  });

  return { label, portions, ingredients };
}

function roundToTwoDecimals(value: number) {
  return Math.round(value * 100) / 100;
}

export function validateWeightEntryInput(
  input: WeightEntryInput,
): WeightEntryInput {
  const weightKg = Number(input.weightKg);

  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    throw new WeightEntryValidationError(
      "Weight must be a positive number.",
    );
  }

  if (weightKg > 999.99) {
    throw new WeightEntryValidationError(
      "Weight must be less than 1000 kg.",
    );
  }

  let bodyFatPct = input.bodyFatPct;
  if (bodyFatPct != null) {
    bodyFatPct = Number(bodyFatPct);
    if (!Number.isFinite(bodyFatPct) || bodyFatPct < 0 || bodyFatPct > 100) {
      throw new WeightEntryValidationError(
        "Body fat percentage must be between 0 and 100.",
      );
    }
    bodyFatPct = roundToSingleDecimal(bodyFatPct);
  }

  const notes = input.notes?.trim() || null;

  return {
    date: input.date,
    weightKg: roundToTwoDecimals(weightKg),
    bodyFatPct: bodyFatPct ?? null,
    notes,
  };
}
