"use server";

import {
  createGymSlot,
  createMealEntry,
  createMealGroup,
  createRecipe,
  createTemplate,
  createTemplateFromDate,
  completeOnboardingSetup,
  deleteGymSlot,
  deleteMealGroup,
  createWeightEntry,
  deleteMealEntry,
  deleteRecipe,
  deleteTemplate,
  deleteWeightEntry,
  inviteGymBuddy,
  removeGymBuddy,
  respondGymBuddyInvite,
  setGymSlotStatus,
  updateGymSlot,
  getRecipes,
  getRecipeById,
  getTemplates,
  getTemplateById,
  markMealEntryStatus,
  applyTemplateToDate,
  saveBarcodeFoodProduct,
  saveUserGoals,
  saveWeightGoal,
  searchFoodProducts,
  searchMealEntries,
  updateMealGroup,
  updateMealEntry,
  updateRecipe,
  updateTemplate,
  updateWeightEntry,
} from "@macro-tracker/db";
import type {
  BarcodeFoodProductInput,
  FoodProduct,
  GymSlot,
  GymSlotInput,
  GymSlotStatus,
  MacroFoodInput,
  MealEntryRecord,
  MealEntryStatus,
  MealGroup,
  MealTemplate,
  RecipeRecord,
  WeightUnit,
} from "@macro-tracker/db";
import { revalidatePath } from "next/cache";

import { ActionError, toActionError } from "./action-errors";
import { requireSessionUser } from "./auth";
import { buildRecipePortionMealEntryInput } from "./recipe-portion";

type ActionResult = {
  ok: boolean;
  error?: string;
};

type SaveMealEntryInput = {
  id?: string;
  date: string;
  mealGroupId?: string | null;
  status?: MealEntryStatus;
  sortOrder?: number;
  clientMutationId?: string | null;
} & MacroFoodInput;

type SessionUser = Awaited<ReturnType<typeof requireSessionUser>>;
type RevalidateTarget = readonly [path: string, type?: "page" | "layout"];

function revalidateTargets(targets: readonly RevalidateTarget[] = []) {
  for (const [path, type] of targets) {
    if (type) {
      revalidatePath(path, type);
    } else {
      revalidatePath(path);
    }
  }
}

async function runSessionAction<T extends ActionResult>(
  operation: (sessionUser: SessionUser) => Promise<T>,
  options: { revalidate?: readonly RevalidateTarget[] } = {},
): Promise<T> {
  const sessionUser = await requireSessionUser();

  try {
    const result = await operation(sessionUser);
    if (result.ok) {
      revalidateTargets(options.revalidate);
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      error: toActionError(error),
    } as T;
  }
}

type SaveMealEntryResult = ActionResult & { entry?: MealEntryRecord };

export async function saveMealEntryAction(
  input: SaveMealEntryInput,
): Promise<SaveMealEntryResult> {
  return runSessionAction(async (sessionUser) => {
    // Both paths take the same payload; only `sortOrder` differs, because an
    // update must pin a concrete position while a create may let the backend
    // append.
    const { id, sortOrder, ...fields } = input;
    const entry = id
      ? await updateMealEntry(sessionUser.userId, id, {
          ...fields,
          sortOrder: sortOrder ?? 0,
        })
      : await createMealEntry(sessionUser.userId, { ...fields, sortOrder });

    return { ok: true, entry };
  }, { revalidate: [["/", "page"]] });
}

export async function markMealEntryStatusAction(
  input: { id: string; status: MealEntryStatus },
): Promise<SaveMealEntryResult> {
  return runSessionAction(async (sessionUser) => {
    const entry = await markMealEntryStatus(
      sessionUser.userId,
      input.id,
      input.status,
    );
    return { ok: true, entry };
  }, { revalidate: [["/", "page"]] });
}

export async function deleteMealEntryAction(
  input: { id: string },
): Promise<ActionResult> {
  return runSessionAction(async (sessionUser) => {
    const deleted = await deleteMealEntry(sessionUser.userId, input.id);
    if (!deleted) {
      return { ok: false, error: "Meal entry not found." };
    }

    return { ok: true };
  }, { revalidate: [["/", "page"]] });
}

type MealGroupResult = ActionResult & { group?: MealGroup; groups?: MealGroup[] };

export async function createMealGroupAction(
  input: { label: string },
): Promise<MealGroupResult> {
  return runSessionAction(async (sessionUser) => {
    const group = await createMealGroup(sessionUser.userId, input);
    return { ok: true, group };
  }, { revalidate: [["/", "page"]] });
}

export async function updateMealGroupAction(
  input: { id: string; label: string },
): Promise<MealGroupResult> {
  return runSessionAction(async (sessionUser) => {
    const group = await updateMealGroup(sessionUser.userId, input.id, {
      label: input.label,
    });
    return { ok: true, group };
  }, { revalidate: [["/", "page"]] });
}

export async function deleteMealGroupAction(
  input: { id: string },
): Promise<ActionResult> {
  return runSessionAction(async (sessionUser) => {
    const deleted = await deleteMealGroup(sessionUser.userId, input.id);
    if (!deleted) {
      return { ok: false, error: "Meal group not found." };
    }
    return { ok: true };
  }, { revalidate: [["/", "page"]] });
}

type SaveGoalsInput = {
  caloriesKcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
};

export async function saveGoalsAction(input: SaveGoalsInput): Promise<ActionResult> {
  return runSessionAction(async (sessionUser) => {
    await saveUserGoals(sessionUser.userId, input);
    return { ok: true };
  }, { revalidate: [["/", "layout"]] });
}

type CompleteOnboardingActionInput = {
  preferredWeightUnit: WeightUnit;
  goals: SaveGoalsInput;
  goalWeightKg: number | null;
  currentWeightKg: number | null;
  currentWeightDate: string;
  starterTemplate:
    | {
        label: string;
        proteinG: number;
        carbsG: number;
        fatG: number;
        caloriesKcal: number;
      }
    | null;
};

export async function completeOnboardingAction(
  input: CompleteOnboardingActionInput,
): Promise<ActionResult> {
  return runSessionAction(async (sessionUser) => {
    const currentWeight =
      input.currentWeightKg != null &&
      Number.isFinite(input.currentWeightKg) &&
      input.currentWeightKg > 0
        ? {
            date: input.currentWeightDate,
            weightKg: input.currentWeightKg,
            bodyFatPct: null,
            notes: "Onboarding",
          }
        : null;
    const starterTemplate = input.starterTemplate?.label.trim()
      ? singleFoodTemplateInput(input.starterTemplate)
      : null;

    await completeOnboardingSetup(sessionUser.userId, {
      preferredWeightUnit: input.preferredWeightUnit,
      goals: input.goals,
      goalWeightKg: input.goalWeightKg,
      currentWeight,
      starterTemplate,
    });

    return { ok: true };
  }, { revalidate: [["/", "layout"]] });
}

type SaveTemplateInput = MacroFoodInput;
type SaveTemplateResult = ActionResult & { template?: MealTemplate };

function singleFoodTemplateInput(
  input: SaveTemplateInput,
  existingItem?: MealTemplate["items"][number],
) {
  return {
    type: "meal" as const,
    label: input.label,
    items: [
      {
        productId:
          input.productId !== undefined
            ? input.productId
            : existingItem?.productId ?? null,
        mealGroupLabel: existingItem?.mealGroupLabel ?? null,
        label: input.label,
        quantity: input.quantity ?? existingItem?.quantity ?? 1,
        unit: input.unit ?? existingItem?.unit ?? ("serving" as const),
        servingMultiplier:
          input.servingMultiplier ?? existingItem?.servingMultiplier ?? 1,
        proteinG: input.proteinG,
        carbsG: input.carbsG,
        fatG: input.fatG,
        caloriesKcal: input.caloriesKcal,
      },
    ],
  };
}

export async function saveTemplateAction(input: SaveTemplateInput): Promise<SaveTemplateResult> {
  return runSessionAction(async (sessionUser) => {
    const template = await createTemplate(
      sessionUser.userId,
      singleFoodTemplateInput(input),
    );
    return { ok: true, template };
  });
}

export async function deleteTemplateAction(input: { id: string }): Promise<ActionResult> {
  return runSessionAction(async (sessionUser) => {
    const deleted = await deleteTemplate(sessionUser.userId, input.id);
    if (!deleted) {
      return { ok: false, error: "Template not found." };
    }

    return { ok: true };
  });
}

type UpdateTemplateInput = { id: string } & SaveTemplateInput;
type UpdateTemplateResult = ActionResult & { template?: MealTemplate };

export async function updateTemplateAction(input: UpdateTemplateInput): Promise<UpdateTemplateResult> {
  return runSessionAction(async (sessionUser) => {
    const existingTemplate = await getTemplateById(sessionUser.userId, input.id);
    if (!existingTemplate) {
      return { ok: false, error: "Template not found." };
    }
    if (existingTemplate.type !== "meal" || existingTemplate.items.length !== 1) {
      return {
        ok: false,
        error: "This template cannot be edited from the single-food template form.",
      };
    }

    const template = await updateTemplate(
      sessionUser.userId,
      input.id,
      singleFoodTemplateInput(input, existingTemplate.items[0]),
    );
    return { ok: true, template };
  });
}

type ApplyTemplateResult = ActionResult & { entries?: MealEntryRecord[] };

export async function applyTemplateAction(input: {
  templateId: string;
  date: string;
  status?: MealEntryStatus;
}): Promise<ApplyTemplateResult> {
  return runSessionAction(async (sessionUser) => {
    const entries = await applyTemplateToDate(sessionUser.userId, input);
    return { ok: true, entries };
  }, { revalidate: [["/", "layout"]] });
}

export async function createTemplateFromDateAction(input: {
  date: string;
  type: "meal" | "day";
  label: string;
}): Promise<SaveTemplateResult> {
  return runSessionAction(async (sessionUser) => {
    const template = await createTemplateFromDate(sessionUser.userId, input);
    return { ok: true, template };
  }, { revalidate: [["/planner", "page"]] });
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
  return runSessionAction(async (sessionUser) => {
    await createWeightEntry(sessionUser.userId, input);
    return { ok: true };
  }, { revalidate: [["/weight", "page"]] });
}

export async function deleteWeightEntryAction(
  input: { id: string },
): Promise<ActionResult> {
  return runSessionAction(async (sessionUser) => {
    const deleted = await deleteWeightEntry(sessionUser.userId, input.id);
    if (!deleted) {
      return { ok: false, error: "Weight entry not found." };
    }

    return { ok: true };
  }, { revalidate: [["/weight", "page"]] });
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
  return runSessionAction(async (sessionUser) => {
    const updated = await updateWeightEntry(sessionUser.userId, input.id, {
      date: input.date,
      weightKg: input.weightKg,
      bodyFatPct: input.bodyFatPct,
      notes: input.notes,
    });

    if (!updated) {
      return { ok: false, error: "Weight entry not found." };
    }

    return { ok: true };
  }, { revalidate: [["/weight", "page"]] });
}

export async function saveWeightGoalAction(
  input: { goalWeightKg: number | null },
): Promise<ActionResult> {
  return runSessionAction(async (sessionUser) => {
    await saveWeightGoal(sessionUser.userId, input.goalWeightKg);
    return { ok: true };
  }, { revalidate: [["/weight", "page"]] });
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

type SaveRecipeInput = {
  id?: string;
  label: string;
  portions: number;
  totalCookedWeightG?: number | null;
  ingredients: MacroFoodInput[];
};

type SaveRecipeResult = ActionResult & { recipe?: RecipeRecord };

type LoadRecipesResult = ActionResult & { recipes?: RecipeRecord[] };

export async function loadRecipesAction(): Promise<LoadRecipesResult> {
  return runSessionAction(async (sessionUser) => ({
    ok: true,
    recipes: await getRecipes(sessionUser.userId),
  }));
}

type LoadTemplatesResult = ActionResult & { templates?: MealTemplate[] };

export async function loadTemplatesAction(): Promise<LoadTemplatesResult> {
  return runSessionAction(async (sessionUser) => ({
    ok: true,
    templates: await getTemplates(sessionUser.userId),
  }));
}

export async function saveRecipeAction(
  input: SaveRecipeInput,
): Promise<SaveRecipeResult> {
  return runSessionAction(async (sessionUser) => {
    const recipe = input.id
      ? await updateRecipe(sessionUser.userId, input.id, input)
      : await createRecipe(sessionUser.userId, input);
    return { ok: true, recipe };
  }, { revalidate: [["/recipes", "page"]] });
}

export async function deleteRecipeAction(
  input: { id: string },
): Promise<ActionResult> {
  return runSessionAction(async (sessionUser) => {
    const deleted = await deleteRecipe(sessionUser.userId, input.id);
    if (!deleted) {
      return { ok: false, error: "Recipe not found." };
    }

    return { ok: true };
  }, { revalidate: [["/recipes", "page"]] });
}

type SearchFoodsResult = ActionResult & {
  results?: MealEntryRecord[];
  products?: FoodProduct[];
};

export async function searchFoodsAction(
  input: { query: string },
): Promise<SearchFoodsResult> {
  return runSessionAction(async (sessionUser) => {
    const query = input.query.trim();

    if (!query) {
      return { ok: true, results: [], products: [] };
    }

    const [historyResult, productsResult] = await Promise.allSettled([
      searchMealEntries(sessionUser.userId, query),
      searchFoodProducts(sessionUser.userId, query),
    ]);

    const results =
      historyResult.status === "fulfilled" ? historyResult.value : [];
    const products =
      productsResult.status === "fulfilled" ? productsResult.value : [];

    if (historyResult.status === "rejected" && productsResult.status === "rejected") {
      return { ok: false, error: toActionError(historyResult.reason) };
    }

    if (historyResult.status === "rejected") {
      return {
        ok: true,
        results,
        products,
        error: "Food history search failed, but product results are still available.",
      };
    }

    if (productsResult.status === "rejected") {
      return {
        ok: true,
        results,
        products,
        error: "Product search failed, but history results are still available.",
      };
    }

    return { ok: true, results, products };
  });
}

type LogRecipePortionInput = {
  recipeId: string;
  date: string;
  /**
   * Required: only the browser knows the user's calendar day, so planned-vs-
   * eaten has to be decided there rather than from the server clock.
   */
  status: MealEntryStatus;
  portionCount?: number;
  gramsConsumed?: number | null;
  /**
   * Idempotency key minted by the caller and reused across retries of the same
   * intent, so a double-tap collapses into one row instead of two.
   */
  clientMutationId?: string;
};

export async function logRecipePortionAction(
  input: LogRecipePortionInput,
): Promise<ActionResult> {
  return runSessionAction(async (sessionUser) => {
    const recipe = await getRecipeById(sessionUser.userId, input.recipeId);
    if (!recipe) {
      throw new ActionError("Recipe not found.");
    }

    const portionCount =
      Number.isFinite(input.portionCount) && (input.portionCount ?? 0) > 0
        ? input.portionCount!
        : 1;
    const gramsConsumed = input.gramsConsumed ?? null;
    if (
      gramsConsumed != null &&
      (!Number.isFinite(gramsConsumed) || gramsConsumed <= 0)
    ) {
      throw new ActionError("Grams consumed must be greater than 0.");
    }

    await createMealEntry(
      sessionUser.userId,
      buildRecipePortionMealEntryInput({
        clientMutationId: input.clientMutationId,
        date: input.date,
        gramsConsumed,
        portionCount,
        recipe,
        status: input.status,
      }),
    );

    return { ok: true };
  }, { revalidate: [["/", "page"]] });
}

// ---------------------------------------------------------------------------
// Community barcode catalogue
// ---------------------------------------------------------------------------

type SaveBarcodeFoodProductResult = ActionResult & {
  product?: FoodProduct;
};

export async function saveBarcodeFoodProductAction(
  input: BarcodeFoodProductInput,
): Promise<SaveBarcodeFoodProductResult> {
  return runSessionAction(async (sessionUser) => {
    const product = await saveBarcodeFoodProduct(sessionUser.userId, input);
    return { ok: true, product };
  });
}

// ---------------------------------------------------------------------------
// Gym schedule sharing
//
// User-facing copy for validation/conflict errors is authored in the Rust
// error strings; `toActionError` passes conflict/bad_request/not_found
// messages through verbatim, so nothing needs mapping here.
// ---------------------------------------------------------------------------

const GYM_REVALIDATE = [["/gym", "page"], ["/", "page"]] as const;

type GymSlotResult = ActionResult & { slot?: GymSlot };

export async function saveGymSlotAction(
  input: GymSlotInput & { id?: string },
): Promise<GymSlotResult> {
  return runSessionAction(async (sessionUser) => {
    const { id, ...fields } = input;
    const slot = id
      ? await updateGymSlot(sessionUser.userId, id, fields)
      : await createGymSlot(sessionUser.userId, fields);
    return { ok: true, slot };
  }, { revalidate: GYM_REVALIDATE });
}

export async function deleteGymSlotAction(
  input: { id: string },
): Promise<ActionResult> {
  return runSessionAction(async (sessionUser) => {
    await deleteGymSlot(sessionUser.userId, input.id);
    return { ok: true };
  }, { revalidate: GYM_REVALIDATE });
}

export async function setGymSlotStatusAction(
  input: { slotId: string; date: string; status: GymSlotStatus },
): Promise<ActionResult> {
  return runSessionAction(async (sessionUser) => {
    await setGymSlotStatus(
      sessionUser.userId,
      input.slotId,
      input.date,
      input.status,
    );
    return { ok: true };
  }, { revalidate: GYM_REVALIDATE });
}

type InviteGymBuddyResult = ActionResult & {
  result?: "invited" | "accepted";
};

export async function inviteGymBuddyAction(
  input: { identifier: string },
): Promise<InviteGymBuddyResult> {
  return runSessionAction(async (sessionUser) => {
    const invite = await inviteGymBuddy(sessionUser.userId, input.identifier);
    return { ok: true, result: invite.result };
  }, { revalidate: GYM_REVALIDATE });
}

export async function respondGymBuddyInviteAction(
  input: { buddyId: string; accept: boolean },
): Promise<ActionResult> {
  return runSessionAction(async (sessionUser) => {
    await respondGymBuddyInvite(sessionUser.userId, input.buddyId, input.accept);
    return { ok: true };
  }, { revalidate: GYM_REVALIDATE });
}

export async function removeGymBuddyAction(
  input: { buddyId: string },
): Promise<ActionResult> {
  return runSessionAction(async (sessionUser) => {
    await removeGymBuddy(sessionUser.userId, input.buddyId);
    return { ok: true };
  }, { revalidate: GYM_REVALIDATE });
}
