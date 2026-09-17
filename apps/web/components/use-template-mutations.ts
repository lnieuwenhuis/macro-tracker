"use client";

import type { MacroFoodInput, MealTemplate } from "@macro-tracker/db";
import type { Dispatch, SetStateAction } from "react";

import {
  deleteTemplateAction,
  saveTemplateAction,
  updateTemplateAction,
} from "@/lib/actions";

type TemplateMutationState =
  | { type: "save" }
  | { type: "update" | "delete"; presetId: string };

export type TemplateMacroInput = MacroFoodInput;

type TemplateMutationOptions = {
  localTemplates: MealTemplate[];
  setLocalTemplates: Dispatch<SetStateAction<MealTemplate[]>>;
  setPresetError: (error: string | null) => void;
  setPresetMutation: (mutation: TemplateMutationState | null) => void;
};

function sortTemplatesByLabel(templates: MealTemplate[]) {
  return [...templates].sort((a, b) => a.label.localeCompare(b.label));
}

// Same contract as use-action-runner: NEXT_* control flow keeps throwing so
// navigation still works; a rejected transport promise becomes a local error.
function isFrameworkControlFlowError(error: unknown) {
  return (
    error instanceof Error &&
    typeof (error as Error & { digest?: unknown }).digest === "string" &&
    (((error as Error & { digest: string }).digest.startsWith("NEXT_REDIRECT") ||
      (error as Error & { digest: string }).digest.startsWith("NEXT_NOT_FOUND")))
  );
}

export function useTemplateMutations({
  localTemplates,
  setLocalTemplates,
  setPresetError,
  setPresetMutation,
}: TemplateMutationOptions) {
  async function handleSavePreset(input: TemplateMacroInput) {
    setPresetError(null);
    setPresetMutation({ type: "save" });

    try {
      const result = await saveTemplateAction(input);
      const savedTemplate = result.template;
      if (!result.ok || !savedTemplate) {
        setPresetError(result.error ?? "Unable to save template.");
        return false;
      }

      setLocalTemplates((prev) => sortTemplatesByLabel([...prev, savedTemplate]));
      return true;
    } catch (error) {
      if (isFrameworkControlFlowError(error)) {
        throw error;
      }
      setPresetError("Unable to save template.");
      return false;
    } finally {
      setPresetMutation(null);
    }
  }

  async function handleDeletePreset(presetId: string) {
    const previousTemplates = localTemplates;

    setPresetError(null);
    setPresetMutation({ type: "delete", presetId });
    setLocalTemplates((prev) => prev.filter((preset) => preset.id !== presetId));

    try {
      const result = await deleteTemplateAction({ id: presetId });
      if (!result.ok) {
        setLocalTemplates(previousTemplates);
        setPresetError(result.error ?? "Unable to delete template.");
        return false;
      }

      return true;
    } catch (error) {
      if (isFrameworkControlFlowError(error)) {
        throw error;
      }
      setLocalTemplates(previousTemplates);
      setPresetError("Unable to delete template.");
      return false;
    } finally {
      setPresetMutation(null);
    }
  }

  async function handleUpdatePreset(
    id: string,
    input: Omit<TemplateMacroInput, "productId" | "quantity" | "unit" | "servingMultiplier">,
  ) {
    setPresetError(null);
    setPresetMutation({ type: "update", presetId: id });

    try {
      const result = await updateTemplateAction({ id, ...input });
      const updatedTemplate = result.template;
      if (!result.ok || !updatedTemplate) {
        setPresetError(result.error ?? "Unable to update template.");
        return false;
      }

      setLocalTemplates((prev) =>
        sortTemplatesByLabel(
          prev.map((preset) => (preset.id === id ? updatedTemplate : preset)),
        ),
      );
      return true;
    } catch (error) {
      if (isFrameworkControlFlowError(error)) {
        throw error;
      }
      setPresetError("Unable to update template.");
      return false;
    } finally {
      setPresetMutation(null);
    }
  }

  return {
    handleSavePreset,
    handleDeletePreset,
    handleUpdatePreset,
  };
}
