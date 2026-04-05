"use client";

import type { DailySummary, FoodPreset, MacroGoals, MealEntryRecord, RecipeRecord } from "@macro-tracker/db";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { deletePresetAction, deleteMealEntryAction, savePresetAction, saveMealEntryAction, updatePresetAction } from "@/lib/actions";
import type { OpenFoodFactsProduct } from "@/lib/openfoodfacts";

import { AddFoodButton } from "./add-food-button";
import { AppShell } from "./app-shell";
import { BarcodeResult } from "./barcode-result";
import { BarcodeScanner } from "./barcode-scanner";
import { MacroBarGroup } from "./macro-bar";
import { MealCard, type MealDraft } from "./meal-card";
import { PresetModal } from "./preset-modal";
import { RecipePickerModal } from "./recipe-picker-modal";

type DashboardShellProps = {
  userEmail: string;
  selectedDate: string;
  dailySummary: DailySummary;
  goals: MacroGoals;
  presets: FoodPreset[];
  recipes: RecipeRecord[];
};

type ErrorState = Record<string, string | null>;
type PresetMutationState =
  | { type: "save" }
  | { type: "update" | "delete"; presetId: string };

function mealToDraft(meal: MealEntryRecord): MealDraft {
  return {
    clientId: meal.id,
    id: meal.id,
    label: meal.label,
    proteinG: meal.proteinG ? String(meal.proteinG) : "",
    carbsG: meal.carbsG ? String(meal.carbsG) : "",
    fatG: meal.fatG ? String(meal.fatG) : "",
    caloriesKcal: meal.caloriesKcal ? String(meal.caloriesKcal) : "",
    sortOrder: meal.sortOrder,
  };
}

function createEmptyDraft(sortOrder: number): MealDraft {
  return {
    clientId: `draft-${crypto.randomUUID()}`,
    label: "",
    proteinG: "",
    carbsG: "",
    fatG: "",
    caloriesKcal: "",
    sortOrder,
  };
}

function createDraftFromPreset(preset: FoodPreset, sortOrder: number): MealDraft {
  return {
    clientId: `draft-${crypto.randomUUID()}`,
    label: preset.label,
    proteinG: String(preset.proteinG),
    carbsG: String(preset.carbsG),
    fatG: String(preset.fatG),
    caloriesKcal: String(preset.caloriesKcal),
    sortOrder,
  };
}

function toNumber(value: string, fallback = 0) {
  if (!value.trim()) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function DashboardShell({
  userEmail,
  selectedDate,
  dailySummary,
  goals,
  presets: initialPresets,
  recipes,
}: DashboardShellProps) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<MealDraft[]>(() =>
    dailySummary.meals.map(mealToDraft),
  );
  const [errors, setErrors] = useState<ErrorState>({});
  const [activeMutation, setActiveMutation] = useState<string | null>(null);
  const [isPending, beginMutation] = useTransition();

  const [showPresetsModal, setShowPresetsModal] = useState(false);
  const [localPresets, setLocalPresets] = useState<FoodPreset[]>(initialPresets);
  const [presetMutation, setPresetMutation] = useState<PresetMutationState | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);

  // Recipe picker state
  const [showRecipePickerModal, setShowRecipePickerModal] = useState(false);

  // Barcode scanner state
  const [showScanner, setShowScanner] = useState(false);
  const [scanResult, setScanResult] = useState<OpenFoodFactsProduct | null>(null);
  const [notFoundBarcode, setNotFoundBarcode] = useState<string | null>(null);

  function nextSortOrder() {
    return drafts.reduce((highest, draft) => Math.max(highest, draft.sortOrder), -1) + 1;
  }

  function updateDraft(
    clientId: string,
    field: keyof Omit<MealDraft, "clientId" | "id" | "sortOrder">,
    value: string,
  ) {
    setDrafts((currentDrafts) =>
      currentDrafts.map((draft) =>
        draft.clientId === clientId ? { ...draft, [field]: value } : draft,
      ),
    );
    setErrors((currentErrors) => ({
      ...currentErrors,
      [clientId]: null,
    }));
  }

  function addCustomDraft() {
    setDrafts((currentDrafts) => [...currentDrafts, createEmptyDraft(nextSortOrder())]);
  }

  function addDraftFromPreset(preset: FoodPreset) {
    setDrafts((currentDrafts) => [
      ...currentDrafts,
      createDraftFromPreset(preset, nextSortOrder()),
    ]);
    setPresetError(null);
    setShowPresetsModal(false);
  }

  function addDraftFromRecipe(recipe: RecipeRecord) {
    const macros = recipe.perPortionMacros;
    setDrafts((currentDrafts) => [
      ...currentDrafts,
      {
        clientId: `draft-${crypto.randomUUID()}`,
        label: `${recipe.label} (1 portion)`,
        proteinG: String(macros.proteinG),
        carbsG: String(macros.carbsG),
        fatG: String(macros.fatG),
        caloriesKcal: String(macros.caloriesKcal),
        sortOrder: nextSortOrder(),
      },
    ]);
    setShowRecipePickerModal(false);
  }

  function removeLocalDraft(clientId: string) {
    setDrafts((currentDrafts) =>
      currentDrafts.filter((draft) => draft.clientId !== clientId),
    );
    setErrors((currentErrors) => {
      const nextErrors = { ...currentErrors };
      delete nextErrors[clientId];
      return nextErrors;
    });
  }

  function handleSave(clientId: string) {
    const draft = drafts.find((entry) => entry.clientId === clientId);
    if (!draft) {
      return;
    }

    setActiveMutation(clientId);
    beginMutation(async () => {
      const result = await saveMealEntryAction({
        id: draft.id,
        date: selectedDate,
        label: draft.label,
        sortOrder: draft.sortOrder,
        proteinG: toNumber(draft.proteinG),
        carbsG: toNumber(draft.carbsG),
        fatG: toNumber(draft.fatG),
        caloriesKcal: Math.round(toNumber(draft.caloriesKcal)),
      });

      if (!result.ok) {
        setErrors((currentErrors) => ({
          ...currentErrors,
          [clientId]: result.error ?? "Unable to save food item.",
        }));
        setActiveMutation(null);
        return;
      }

      router.refresh();
    });
  }

  function handleDelete(clientId: string) {
    const draft = drafts.find((entry) => entry.clientId === clientId);
    if (!draft) {
      return;
    }

    if (!draft.id) {
      removeLocalDraft(clientId);
      return;
    }

    setActiveMutation(clientId);
    beginMutation(async () => {
      const result = await deleteMealEntryAction({
        id: draft.id!,
      });

      if (!result.ok) {
        setErrors((currentErrors) => ({
          ...currentErrors,
          [clientId]: result.error ?? "Unable to delete food item.",
        }));
        setActiveMutation(null);
        return;
      }

      router.refresh();
    });
  }

  async function handleSavePreset(input: Omit<FoodPreset, "id" | "userId">) {
    setPresetError(null);
    setPresetMutation({ type: "save" });

    try {
      const result = await savePresetAction(input);
      const savedPreset = result.preset;
      if (!result.ok || !savedPreset) {
        setPresetError(result.error ?? "Unable to save preset.");
        return false;
      }

      setLocalPresets((prev) =>
        [...prev, savedPreset].sort((a, b) => a.label.localeCompare(b.label)),
      );
      return true;
    } finally {
      setPresetMutation(null);
    }
  }

  async function handleDeletePreset(presetId: string) {
    const previousPresets = localPresets;

    setPresetError(null);
    setPresetMutation({ type: "delete", presetId });
    setLocalPresets((prev) => prev.filter((p) => p.id !== presetId));

    try {
      const result = await deletePresetAction({ id: presetId });
      if (!result.ok) {
        setLocalPresets(previousPresets);
        setPresetError(result.error ?? "Unable to delete preset.");
        return false;
      }

      return true;
    } finally {
      setPresetMutation(null);
    }
  }

  async function handleUpdatePreset(id: string, input: Omit<FoodPreset, "id" | "userId">) {
    setPresetError(null);
    setPresetMutation({ type: "update", presetId: id });

    try {
      const result = await updatePresetAction({ id, ...input });
      const updatedPreset = result.preset;
      if (!result.ok || !updatedPreset) {
        setPresetError(result.error ?? "Unable to update preset.");
        return false;
      }

      setLocalPresets((prev) =>
        prev
          .map((preset) => (preset.id === id ? updatedPreset : preset))
          .sort((a, b) => a.label.localeCompare(b.label)),
      );
      return true;
    } finally {
      setPresetMutation(null);
    }
  }

  const dailyTotals = dailySummary.totals;

  return (
    <AppShell userEmail={userEmail} selectedDate={selectedDate} activeTab="log">
      <div className="space-y-5">
        {/* Daily Report — macro bar charts */}
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5 shadow-[0_12px_32px_rgba(0,0,0,0.06)]">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Daily Report
            </h2>
            <span className="text-2xl font-bold tabular-nums text-[var(--color-ink)]">
              {dailyTotals.caloriesKcal}
              <span className="ml-1 text-xs font-semibold text-[var(--color-muted)]">kcal</span>
            </span>
          </div>

          <MacroBarGroup
            proteinG={dailyTotals.proteinG}
            carbsG={dailyTotals.carbsG}
            fatG={dailyTotals.fatG}
            caloriesKcal={dailyTotals.caloriesKcal}
            goals={goals}
          />
        </section>

        {/* Food log */}
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Food Items
            </h2>
            <AddFoodButton
              onCustom={addCustomDraft}
              onPreset={() => {
                setPresetError(null);
                setShowPresetsModal(true);
              }}
              onScan={() => {
                setScanResult(null);
                setNotFoundBarcode(null);
                setShowScanner(true);
              }}
              onRecipe={() => setShowRecipePickerModal(true)}
            />
          </div>

          {drafts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] px-5 py-8 text-center">
              <p className="text-sm text-[var(--color-muted)]">No food items logged yet.</p>
              <div className="mt-3 flex justify-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPresetError(null);
                    setShowPresetsModal(true);
                  }}
                  className="rounded-full border border-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent)] transition hover:-translate-y-0.5"
                >
                  From preset
                </button>
                <button
                  type="button"
                  onClick={addCustomDraft}
                  className="rounded-full bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5"
                >
                  Add custom
                </button>
              </div>
            </div>
          ) : null}

          <div className="space-y-3">
            {drafts.map((draft) => {
              const busy = isPending && activeMutation === draft.clientId;

              return (
                <MealCard
                  key={draft.clientId}
                  draft={draft}
                  busy={busy}
                  error={errors[draft.clientId]}
                  onChange={updateDraft}
                  onSave={handleSave}
                  onDelete={handleDelete}
                />
              );
            })}
          </div>
        </section>
      </div>

      {/* Presets modal */}
      {showPresetsModal && (
        <PresetModal
          presets={localPresets}
          mutation={presetMutation}
          errorMessage={presetError}
          onClose={() => {
            setPresetError(null);
            setShowPresetsModal(false);
          }}
          onSelect={addDraftFromPreset}
          onSave={handleSavePreset}
          onUpdate={handleUpdatePreset}
          onDelete={handleDeletePreset}
        />
      )}

      {/* Recipe picker modal */}
      {showRecipePickerModal && (
        <RecipePickerModal
          recipes={recipes}
          onClose={() => setShowRecipePickerModal(false)}
          onSelect={addDraftFromRecipe}
        />
      )}

      {/* Barcode scanner modal */}
      {showScanner && (
        <BarcodeScanner
          onScan={(product) => {
            setShowScanner(false);
            setScanResult(product);
            setNotFoundBarcode(null);
          }}
          onNotFound={(barcode) => {
            setShowScanner(false);
            setScanResult(null);
            setNotFoundBarcode(barcode);
          }}
          onClose={() => setShowScanner(false)}
        />
      )}

      {/* Barcode result modal */}
      {(scanResult || notFoundBarcode) && (
        <BarcodeResult
          product={scanResult}
          notFoundBarcode={notFoundBarcode}
          onAddToLog={(macros) => {
            setDrafts((currentDrafts) => [
              ...currentDrafts,
              {
                clientId: `draft-${crypto.randomUUID()}`,
                label: macros.label,
                proteinG: String(macros.proteinG),
                carbsG: String(macros.carbsG),
                fatG: String(macros.fatG),
                caloriesKcal: String(macros.caloriesKcal),
                sortOrder: nextSortOrder(),
              },
            ]);
            setScanResult(null);
            setNotFoundBarcode(null);
          }}
          onSaveAsPreset={(input) => {
            handleSavePreset(input);
          }}
          onScanAnother={() => {
            setScanResult(null);
            setNotFoundBarcode(null);
            setShowScanner(true);
          }}
          onClose={() => {
            setScanResult(null);
            setNotFoundBarcode(null);
          }}
        />
      )}
    </AppShell>
  );
}
