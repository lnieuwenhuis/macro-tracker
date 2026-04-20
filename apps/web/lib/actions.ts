"use server";

import {
  createMealEntry,
  createPreset,
  createRecipe,
  createWeightEntry,
  deleteMealEntry,
  deletePreset,
  deleteRecipe,
  deleteWeightEntry,
  getLeaderboardStats,
  getRecipeById,
  saveCustomBarcodeProduct,
  saveUserGoals,
  saveWeightGoal,
  searchMealEntries,
  touchPresetLastUsed,
  updateMealEntry,
  updatePreset,
  updateRecipe,
  updateWeightEntry,
  isValidDateString,
} from "@macro-tracker/db";
import type { CustomBarcodeProduct, FoodPreset, LeaderboardStats, MealEntryRecord, RecipeRecord } from "@macro-tracker/db";
import { revalidatePath } from "next/cache";

import { requireSessionUser } from "./auth";

type ActionResult = {
  ok: boolean;
  error?: string;
};

type SaveMealEntryInput = {
  id?: string;
  date: string;
  label: string;
  sortOrder?: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
};

function toActionError(error: unknown) {
  if (!(error instanceof Error)) {
    return "Something went wrong.";
  }

  if (error.message.includes("Failed query:")) {
    return "Unable to save this change right now. Sign in again if the issue persists.";
  }

  return error.message;
}

type SaveMealEntryResult = ActionResult & { entry?: MealEntryRecord };

export async function saveMealEntryAction(
  input: SaveMealEntryInput,
): Promise<SaveMealEntryResult> {
  const sessionUser = await requireSessionUser();

  try {
    const entry = input.id
      ? await updateMealEntry(sessionUser.userId, input.id, {
          date: input.date,
          label: input.label,
          sortOrder: input.sortOrder ?? 0,
          proteinG: input.proteinG,
          carbsG: input.carbsG,
          fatG: input.fatG,
          caloriesKcal: input.caloriesKcal,
        })
      : await createMealEntry(sessionUser.userId, {
          date: input.date,
          label: input.label,
          sortOrder: input.sortOrder,
          proteinG: input.proteinG,
          carbsG: input.carbsG,
          fatG: input.fatG,
          caloriesKcal: input.caloriesKcal,
        });

    revalidatePath("/", "page");
    return { ok: true, entry };
  } catch (error) {
    return {
      ok: false,
      error: toActionError(error),
    };
  }
}

export async function deleteMealEntryAction(
  input: { id: string },
): Promise<ActionResult> {
  const sessionUser = await requireSessionUser();

  try {
    const deleted = await deleteMealEntry(sessionUser.userId, input.id);
    if (!deleted) {
      return { ok: false, error: "Meal entry not found." };
    }

    revalidatePath("/", "page");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: toActionError(error),
    };
  }
}

type SaveGoalsInput = {
  caloriesKcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
};

export async function saveGoalsAction(input: SaveGoalsInput): Promise<ActionResult> {
  const sessionUser = await requireSessionUser();

  try {
    await saveUserGoals(sessionUser.userId, input);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: toActionError(error),
    };
  }
}

type SavePresetInput = Omit<FoodPreset, "id" | "userId">;
type SavePresetResult = ActionResult & { preset?: FoodPreset };

export async function savePresetAction(input: SavePresetInput): Promise<SavePresetResult> {
  const sessionUser = await requireSessionUser();

  try {
    const preset = await createPreset(sessionUser.userId, input);
    return { ok: true, preset };
  } catch (error) {
    return { ok: false, error: toActionError(error) };
  }
}

export async function deletePresetAction(input: { id: string }): Promise<ActionResult> {
  const sessionUser = await requireSessionUser();

  try {
    const deleted = await deletePreset(sessionUser.userId, input.id);
    if (!deleted) {
      return { ok: false, error: "Preset not found." };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: toActionError(error) };
  }
}

type UpdatePresetInput = { id: string } & Omit<FoodPreset, "id" | "userId">;
type UpdatePresetResult = ActionResult & { preset?: FoodPreset };

export async function updatePresetAction(input: UpdatePresetInput): Promise<UpdatePresetResult> {
  const sessionUser = await requireSessionUser();

  try {
    const preset = await updatePreset(sessionUser.userId, input.id, {
      label: input.label,
      proteinG: input.proteinG,
      carbsG: input.carbsG,
      fatG: input.fatG,
      caloriesKcal: input.caloriesKcal,
    });
    return { ok: true, preset };
  } catch (error) {
    return { ok: false, error: toActionError(error) };
  }
}

export async function touchPresetAction(
  input: { id: string },
): Promise<ActionResult> {
  const sessionUser = await requireSessionUser();

  try {
    await touchPresetLastUsed(sessionUser.userId, input.id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toActionError(error) };
  }
}

// ---------------------------------------------------------------------------
// Weight tracking
// ---------------------------------------------------------------------------

type SaveWeightEntryInput = {
  date: string;
  weightKg: number;
  bodyFatPct: number | null;
  notes: string | null;
};

export async function saveWeightEntryAction(
  input: SaveWeightEntryInput,
): Promise<ActionResult> {
  const sessionUser = await requireSessionUser();

  try {
    await createWeightEntry(sessionUser.userId, input);
    revalidatePath("/weight", "page");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toActionError(error) };
  }
}

export async function deleteWeightEntryAction(
  input: { id: string },
): Promise<ActionResult> {
  const sessionUser = await requireSessionUser();

  try {
    const deleted = await deleteWeightEntry(sessionUser.userId, input.id);
    if (!deleted) {
      return { ok: false, error: "Weight entry not found." };
    }

    revalidatePath("/weight", "page");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toActionError(error) };
  }
}

type UpdateWeightEntryInput = {
  id: string;
  date: string;
  weightKg: number;
  bodyFatPct: number | null;
  notes: string | null;
};

export async function updateWeightEntryAction(
  input: UpdateWeightEntryInput,
): Promise<ActionResult> {
  const sessionUser = await requireSessionUser();

  try {
    const updated = await updateWeightEntry(sessionUser.userId, input.id, {
      date: input.date,
      weightKg: input.weightKg,
      bodyFatPct: input.bodyFatPct,
      notes: input.notes,
    });

    if (!updated) {
      return { ok: false, error: "Weight entry not found." };
    }

    revalidatePath("/weight", "page");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toActionError(error) };
  }
}

export async function saveWeightGoalAction(
  input: { goalWeightKg: number | null },
): Promise<ActionResult> {
  const sessionUser = await requireSessionUser();

  try {
    await saveWeightGoal(sessionUser.userId, input.goalWeightKg);
    revalidatePath("/weight", "page");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toActionError(error) };
  }
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

type SaveRecipeInput = {
  id?: string;
  label: string;
  portions: number;
  ingredients: Array<{
    label: string;
    proteinG: number;
    carbsG: number;
    fatG: number;
    caloriesKcal: number;
  }>;
};

type SaveRecipeResult = ActionResult & { recipe?: RecipeRecord };

export async function saveRecipeAction(
  input: SaveRecipeInput,
): Promise<SaveRecipeResult> {
  const sessionUser = await requireSessionUser();

  try {
    const recipe = input.id
      ? await updateRecipe(sessionUser.userId, input.id, input)
      : await createRecipe(sessionUser.userId, input);
    revalidatePath("/recipes", "page");
    return { ok: true, recipe };
  } catch (error) {
    return { ok: false, error: toActionError(error) };
  }
}

export async function deleteRecipeAction(
  input: { id: string },
): Promise<ActionResult> {
  const sessionUser = await requireSessionUser();

  try {
    const deleted = await deleteRecipe(sessionUser.userId, input.id);
    if (!deleted) {
      return { ok: false, error: "Recipe not found." };
    }

    revalidatePath("/recipes", "page");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toActionError(error) };
  }
}

type SearchMealEntriesResult = ActionResult & { results?: MealEntryRecord[] };

export async function searchMealEntriesAction(
  input: { query: string },
): Promise<SearchMealEntriesResult> {
  const sessionUser = await requireSessionUser();

  try {
    const results = await searchMealEntries(sessionUser.userId, input.query);
    return { ok: true, results };
  } catch (error) {
    return { ok: false, error: toActionError(error) };
  }
}

type LogRecipePortionInput = {
  recipeId: string;
  date: string;
};

export async function logRecipePortionAction(
  input: LogRecipePortionInput,
): Promise<ActionResult> {
  const sessionUser = await requireSessionUser();

  try {
    const recipe = await getRecipeById(sessionUser.userId, input.recipeId);
    if (!recipe) {
      throw new Error("Recipe not found.");
    }

    await createMealEntry(sessionUser.userId, {
      date: input.date,
      label: `${recipe.label} (1 portion)`,
      proteinG: recipe.perPortionMacros.proteinG,
      carbsG: recipe.perPortionMacros.carbsG,
      fatG: recipe.perPortionMacros.fatG,
      caloriesKcal: recipe.perPortionMacros.caloriesKcal,
    });

    revalidatePath("/", "page");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toActionError(error) };
  }
}

// ---------------------------------------------------------------------------
// Community barcode catalogue
// ---------------------------------------------------------------------------

type SaveCustomBarcodeProductInput = {
  barcode: string;
  name: string;
  brands: string;
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
  servingSizeG: number | null;
};

type SaveCustomBarcodeProductResult = ActionResult & {
  product?: CustomBarcodeProduct;
};

export async function saveCustomBarcodeProductAction(
  input: SaveCustomBarcodeProductInput,
): Promise<SaveCustomBarcodeProductResult> {
  const sessionUser = await requireSessionUser();

  try {
    const product = await saveCustomBarcodeProduct(sessionUser.userId, input);
    return { ok: true, product };
  } catch (error) {
    return { ok: false, error: toActionError(error) };
  }
}

// ---------------------------------------------------------------------------
// Leaderboard / personal records
// ---------------------------------------------------------------------------

type FetchLeaderboardResult =
  | { ok: true; stats: LeaderboardStats }
  | { ok: false; error: string };

export async function fetchLeaderboardStatsAction(
  input: { referenceDate: string },
): Promise<FetchLeaderboardResult> {
  if (!isValidDateString(input.referenceDate)) {
    return { ok: false, error: "Invalid reference date." };
  }

  const sessionUser = await requireSessionUser();
  try {
    const stats = await getLeaderboardStats(sessionUser.userId, input.referenceDate);
    return { ok: true, stats };
  } catch (error) {
    return { ok: false, error: toActionError(error) };
  }
}
