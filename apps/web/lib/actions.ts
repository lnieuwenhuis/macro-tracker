"use server";

import {
  createMealEntry,
  createPreset,
  deleteMealEntry,
  deletePreset,
  saveUserGoals,
  updateMealEntry,
} from "@macro-tracker/db";
import type { FoodPreset } from "@macro-tracker/db";
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

export async function saveMealEntryAction(
  input: SaveMealEntryInput,
): Promise<ActionResult> {
  const sessionUser = await requireSessionUser();

  try {
    if (input.id) {
      await updateMealEntry(sessionUser.userId, input.id, {
        date: input.date,
        label: input.label,
        sortOrder: input.sortOrder ?? 0,
        proteinG: input.proteinG,
        carbsG: input.carbsG,
        fatG: input.fatG,
        caloriesKcal: input.caloriesKcal,
      });
    } else {
      await createMealEntry(sessionUser.userId, {
        date: input.date,
        label: input.label,
        sortOrder: input.sortOrder,
        proteinG: input.proteinG,
        carbsG: input.carbsG,
        fatG: input.fatG,
        caloriesKcal: input.caloriesKcal,
      });
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

export async function deleteMealEntryAction(
  input: { id: string },
): Promise<ActionResult> {
  const sessionUser = await requireSessionUser();

  try {
    await deleteMealEntry(sessionUser.userId, input.id);
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
    await deletePreset(sessionUser.userId, input.id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toActionError(error) };
  }
}
