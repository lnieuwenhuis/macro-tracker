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
