"use client";

import type { FoodPreset, RecipeRecord } from "@macro-tracker/db";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { saveRecipeAction } from "@/lib/actions";
import type { OpenFoodFactsProduct } from "@/lib/openfoodfacts";

import { AddFoodButton } from "./add-food-button";
import { AppShell } from "./app-shell";
import { BarcodeResult } from "./barcode-result";
import { BarcodeScanner } from "./barcode-scanner";
import { IngredientCard, type IngredientDraft } from "./ingredient-card";
import { PresetModal } from "./preset-modal";
import { RecipeTotalsBar } from "./recipe-totals-bar";
import { savePresetAction, deletePresetAction, updatePresetAction } from "@/lib/actions";

type PresetMutationState =
  | { type: "save" }
  | { type: "update" | "delete"; presetId: string };

type RecipeBuilderShellProps = {
  userEmail: string;
  selectedDate: string;
  presets: FoodPreset[];
  mode: "create" | "edit";
  recipe?: RecipeRecord;
};

function toNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function RecipeBuilderShell({
  userEmail,
  selectedDate,
  presets: initialPresets,
  mode,
  recipe,
}: RecipeBuilderShellProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Recipe fields
  const [label, setLabel] = useState(recipe?.label ?? "");
  const [portions, setPortions] = useState(String(recipe?.portions ?? 1));

  // Ingredients
  const [ingredients, setIngredients] = useState<IngredientDraft[]>(() => {
    if (!recipe) return [];
    return recipe.ingredients.map((ing) => ({
      clientId: `ing-${ing.id}`,
      label: ing.label,
      proteinG: String(ing.proteinG),
      carbsG: String(ing.carbsG),
      fatG: String(ing.fatG),
      caloriesKcal: String(ing.caloriesKcal),
    }));
  });

  // Error / save state
  const [error, setError] = useState<string | null>(null);

  // Presets state
  const [showPresetsModal, setShowPresetsModal] = useState(false);
  const [localPresets, setLocalPresets] = useState<FoodPreset[]>(initialPresets);
  const [presetMutation, setPresetMutation] = useState<PresetMutationState | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);

  // Barcode state
  const [showScanner, setShowScanner] = useState(false);
  const [scanResult, setScanResult] = useState<OpenFoodFactsProduct | null>(null);
  const [notFoundBarcode, setNotFoundBarcode] = useState<string | null>(null);

  // Computed totals
  const totalProteinG = ingredients.reduce((sum, ing) => sum + toNumber(ing.proteinG), 0);
  const totalCarbsG = ingredients.reduce((sum, ing) => sum + toNumber(ing.carbsG), 0);
  const totalFatG = ingredients.reduce((sum, ing) => sum + toNumber(ing.fatG), 0);
  const totalCaloriesKcal = ingredients.reduce((sum, ing) => sum + toNumber(ing.caloriesKcal), 0);
  const parsedPortions = Math.max(Math.round(toNumber(portions)), 1);

  function addEmptyIngredient() {
    setIngredients((prev) => [
      ...prev,
      {
        clientId: `ing-${crypto.randomUUID()}`,
        label: "",
        proteinG: "",
        carbsG: "",
        fatG: "",
        caloriesKcal: "",
      },
    ]);
  }

  function addIngredientFromPreset(preset: FoodPreset) {
    setIngredients((prev) => [
      ...prev,
      {
        clientId: `ing-${crypto.randomUUID()}`,
        label: preset.label,
        proteinG: String(preset.proteinG),
        carbsG: String(preset.carbsG),
        fatG: String(preset.fatG),
        caloriesKcal: String(preset.caloriesKcal),
      },
    ]);
    setShowPresetsModal(false);
  }

  function updateIngredient(clientId: string, draft: IngredientDraft) {
    setIngredients((prev) =>
      prev.map((ing) => (ing.clientId === clientId ? draft : ing)),
    );
    setError(null);
  }

  function deleteIngredient(clientId: string) {
    setIngredients((prev) => prev.filter((ing) => ing.clientId !== clientId));
  }

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await saveRecipeAction({
        id: recipe?.id,
        label,
        portions: parsedPortions,
        ingredients: ingredients.map((ing) => ({
          label: ing.label,
          proteinG: toNumber(ing.proteinG),
          carbsG: toNumber(ing.carbsG),
          fatG: toNumber(ing.fatG),
          caloriesKcal: Math.round(toNumber(ing.caloriesKcal)),
        })),
      });

      if (!result.ok) {
        setError(result.error ?? "Unable to save recipe.");
        return;
      }

      router.push(`/recipes?date=${selectedDate}`);
      router.refresh();
    });
  }

  // Preset handlers
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

  return (
    <AppShell userEmail={userEmail} selectedDate={selectedDate} activeTab="recipes">
      <div className="space-y-5">
        {/* Recipe name + portions */}
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5 shadow-[0_12px_32px_rgba(0,0,0,0.06)]">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
              Recipe Name
            </span>
            <input
              type="text"
              value={label}
              disabled={isPending}
              onChange={(e) => { setLabel(e.target.value); setError(null); }}
              placeholder="Pasta bolognese, overnight oats..."
              className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
              autoFocus={mode === "create"}
            />
          </label>
          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
              Portions
            </span>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              max="999"
              step="1"
              value={portions}
              disabled={isPending}
              onChange={(e) => { setPortions(e.target.value); setError(null); }}
              className="w-28 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
            />
          </label>
        </section>

        {/* Ingredients */}
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Ingredients
            </h2>
            <AddFoodButton
              onCustom={addEmptyIngredient}
              onPreset={() => {
                setPresetError(null);
                setShowPresetsModal(true);
              }}
              onScan={() => {
                setScanResult(null);
                setNotFoundBarcode(null);
                setShowScanner(true);
              }}
            />
          </div>

          {ingredients.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] px-5 py-8 text-center">
              <p className="text-sm text-[var(--color-muted)]">
                No ingredients yet — add one to get started.
              </p>
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
                  onClick={addEmptyIngredient}
                  className="rounded-full bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5"
                >
                  Add custom
                </button>
              </div>
            </div>
          ) : null}

          <div className="space-y-3">
            {ingredients.map((ing) => (
              <IngredientCard
                key={ing.clientId}
                draft={ing}
                disabled={isPending}
                onChange={updateIngredient}
                onDelete={deleteIngredient}
              />
            ))}
          </div>
        </section>

        {/* Totals */}
        {ingredients.length > 0 && (
          <RecipeTotalsBar
            totalProteinG={totalProteinG}
            totalCarbsG={totalCarbsG}
            totalFatG={totalFatG}
            totalCaloriesKcal={totalCaloriesKcal}
            portions={parsedPortions}
          />
        )}

        {/* Error */}
        {error ? (
          <p className="rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/8 px-3 py-2 text-sm text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}

        {/* Save button */}
        <button
          type="button"
          disabled={isPending}
          onClick={handleSave}
          className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 text-sm font-semibold text-white transition-transform duration-150 hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-70"
        >
          {isPending ? "Saving..." : mode === "edit" ? "Update Recipe" : "Save Recipe"}
        </button>

        {/* Back link */}
        <button
          type="button"
          disabled={isPending}
          onClick={() => router.push(`/recipes?date=${selectedDate}`)}
          className="w-full rounded-xl border border-[var(--color-border-strong)] px-4 py-2.5 text-sm font-semibold text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
        >
          Cancel
        </button>
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
          onSelect={addIngredientFromPreset}
          onSave={handleSavePreset}
          onUpdate={handleUpdatePreset}
          onDelete={handleDeletePreset}
        />
      )}

      {/* Barcode scanner */}
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

      {/* Barcode result */}
      {(scanResult || notFoundBarcode) && (
        <BarcodeResult
          product={scanResult}
          notFoundBarcode={notFoundBarcode}
          onAddToLog={(macros) => {
            setIngredients((prev) => [
              ...prev,
              {
                clientId: `ing-${crypto.randomUUID()}`,
                label: macros.label,
                proteinG: String(macros.proteinG),
                carbsG: String(macros.carbsG),
                fatG: String(macros.fatG),
                caloriesKcal: String(macros.caloriesKcal),
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
