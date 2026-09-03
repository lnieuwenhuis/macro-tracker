"use client";

import type { MealTemplate, RecipeRecord } from "@macro-tracker/db";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import {
  saveRecipeAction,
} from "@/lib/actions";
import { prepareNavigationMotion } from "@/lib/navigation-motion";
import type { OpenFoodFactsProduct } from "@/lib/openfoodfacts";
import { useActionRunner } from "@/lib/use-action-runner";

import { AddFoodButton } from "./add-food-button";
import { AppShell } from "./app-shell";
import { IngredientCard, type IngredientDraft } from "./ingredient-card";
import {
  ModalChunkDismissProvider,
  ModalChunkFallback,
  OverlayBackdropFallback,
} from "./modal-chunk-fallback";
import { RecipeTotalsBar } from "./recipe-totals-bar";
import { useTemplateMutations } from "./use-template-mutations";

// The dynamic() options must stay inline literals: the bundler analyzes them statically.
const BarcodeCaptureModals = dynamic(
  () => import("./barcode-capture-modals").then((mod) => mod.BarcodeCaptureModals),
  { loading: () => <OverlayBackdropFallback /> },
);
const PresetModal = dynamic(
  () => import("./preset-modal").then((mod) => mod.PresetModal),
  { loading: () => <ModalChunkFallback title="Meal Templates" /> },
);

type PresetMutationState =
  | { type: "save" }
  | { type: "update" | "delete"; presetId: string };

type RecipeBuilderShellProps = {
  userEmail: string;
  canAccessAdmin: boolean;
  selectedDate: string;
  templates: MealTemplate[];
  mode: "create" | "edit";
  recipe?: RecipeRecord;
  todayStr?: string;
};

function toNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function RecipeBuilderShell({
  userEmail,
  canAccessAdmin,
  selectedDate,
  templates: initialTemplates,
  mode,
  recipe,
  todayStr,
}: RecipeBuilderShellProps) {
  const router = useRouter();
  const { run, isPending, error, clearError } = useActionRunner();
  const [label, setLabel] = useState(recipe?.label ?? "");
  const [portions, setPortions] = useState(String(recipe?.portions ?? 1));
  const [totalCookedWeightG, setTotalCookedWeightG] = useState(
    recipe?.totalCookedWeightG != null ? String(recipe.totalCookedWeightG) : "",
  );

  const [ingredients, setIngredients] = useState<IngredientDraft[]>(() => {
    if (!recipe) return [];
    return recipe.ingredients.map((ing) => ({
      clientId: `ing-${ing.id}`,
      productId: ing.productId ?? null,
      label: ing.label,
      quantity: String(ing.quantity ?? 1),
      unit: ing.unit ?? "serving",
      servingMultiplier: String(ing.servingMultiplier ?? 1),
      proteinG: String(ing.proteinG),
      carbsG: String(ing.carbsG),
      fatG: String(ing.fatG),
      caloriesKcal: String(ing.caloriesKcal),
    }));
  });

  const [showPresetsModal, setShowPresetsModal] = useState(false);
  const [localTemplates, setLocalTemplates] = useState<MealTemplate[]>(initialTemplates);
  const [presetMutation, setPresetMutation] = useState<PresetMutationState | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  const {
    handleSavePreset,
    handleDeletePreset,
    handleUpdatePreset,
  } = useTemplateMutations({
    localTemplates,
    setLocalTemplates,
    setPresetError,
    setPresetMutation,
  });

  const [showScanner, setShowScanner] = useState(false);
  const [scanResult, setScanResult] = useState<OpenFoodFactsProduct | null>(null);
  const [notFoundBarcode, setNotFoundBarcode] = useState<string | null>(null);

  // Also the dismissal handler for the lazy chunk fallbacks, so a slow chunk load can be cancelled.
  function dismissBarcodeCapture() {
    setShowScanner(false);
    setScanResult(null);
    setNotFoundBarcode(null);
  }

  function dismissPresetModal() {
    setPresetError(null);
    setShowPresetsModal(false);
  }

  const recipeTotals = useMemo(
    () =>
      ingredients.reduce(
        (totals, ing) => ({
          proteinG: totals.proteinG + toNumber(ing.proteinG),
          carbsG: totals.carbsG + toNumber(ing.carbsG),
          fatG: totals.fatG + toNumber(ing.fatG),
          caloriesKcal: totals.caloriesKcal + toNumber(ing.caloriesKcal),
        }),
        { proteinG: 0, carbsG: 0, fatG: 0, caloriesKcal: 0 },
      ),
    [ingredients],
  );
  const parsedPortions = Math.max(Math.round(toNumber(portions)), 1);

  function addEmptyIngredient() {
    setIngredients((prev) => [
      ...prev,
      {
        clientId: `ing-${crypto.randomUUID()}`,
        label: "",
        quantity: "1",
        unit: "serving",
        servingMultiplier: "1",
        proteinG: "",
        carbsG: "",
        fatG: "",
        caloriesKcal: "",
      },
    ]);
  }

  function addIngredientFromPreset(template: MealTemplate) {
    setIngredients((prev) => [
      ...prev,
      ...template.items.map((item) => ({
        clientId: `ing-${crypto.randomUUID()}`,
        productId: item.productId ?? null,
        label: item.label,
        quantity: String(item.quantity),
        unit: item.unit,
        servingMultiplier: String(item.servingMultiplier),
        proteinG: String(item.proteinG),
        carbsG: String(item.carbsG),
        fatG: String(item.fatG),
        caloriesKcal: String(item.caloriesKcal),
      })),
    ]);
    setShowPresetsModal(false);
  }

  function updateIngredient(clientId: string, draft: IngredientDraft) {
    setIngredients((prev) =>
      prev.map((ing) => (ing.clientId === clientId ? draft : ing)),
    );
    clearError();
  }

  function deleteIngredient(clientId: string) {
    setIngredients((prev) => prev.filter((ing) => ing.clientId !== clientId));
  }

  function duplicateIngredient(clientId: string) {
    setIngredients((prev) => {
      const source = prev.find((ing) => ing.clientId === clientId);
      if (!source) return prev;
      const index = prev.findIndex((ing) => ing.clientId === clientId);
      const copy: IngredientDraft = {
        ...source,
        clientId: `ing-${crypto.randomUUID()}`,
      };
      const next = [...prev];
      next.splice(index + 1, 0, copy);
      return next;
    });
  }

  function handleSave() {
    run(
      () =>
        saveRecipeAction({
          id: recipe?.id,
          label,
          portions: parsedPortions,
          totalCookedWeightG: totalCookedWeightG.trim()
            ? Math.max(toNumber(totalCookedWeightG), 0)
            : null,
          ingredients: ingredients.map((ing) => ({
            productId: ing.productId ?? null,
            label: ing.label,
            quantity: toNumber(ing.quantity || "1"),
            unit: ing.unit ?? "serving",
            servingMultiplier: toNumber(ing.servingMultiplier || "1"),
            proteinG: toNumber(ing.proteinG),
            carbsG: toNumber(ing.carbsG),
            fatG: toNumber(ing.fatG),
            caloriesKcal: Math.round(toNumber(ing.caloriesKcal)),
          })),
        }),
      {
        fallbackError: "Unable to save recipe.",
        refresh: true,
        onSuccess: () => {
          const href = `/recipes?date=${selectedDate}`;
          prepareNavigationMotion(href, "screen");
          router.push(href);
        },
      },
    );
  }

  const content = (
    <>
      <div className="space-y-5">
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5 shadow-[0_12px_32px_rgba(0,0,0,0.06)]">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
              Recipe Name
            </span>
            <input
              type="text"
              value={label}
              disabled={isPending}
              onChange={(e) => { setLabel(e.target.value); clearError(); }}
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
              onChange={(e) => { setPortions(e.target.value); clearError(); }}
              className="w-28 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
            />
          </label>
          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
              Cooked weight
            </span>
            <div className="relative w-36">
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                value={totalCookedWeightG}
                disabled={isPending}
                onChange={(e) => { setTotalCookedWeightG(e.target.value); clearError(); }}
                placeholder="Optional"
                className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2.5 pr-9 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[var(--color-muted)]">g</span>
            </div>
          </label>
        </section>

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
                  From template
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
                onDuplicate={duplicateIngredient}
              />
            ))}
          </div>
        </section>

        {ingredients.length > 0 && (
          <RecipeTotalsBar
            totalProteinG={recipeTotals.proteinG}
            totalCarbsG={recipeTotals.carbsG}
            totalFatG={recipeTotals.fatG}
            totalCaloriesKcal={recipeTotals.caloriesKcal}
            portions={parsedPortions}
          />
        )}

        {error ? (
          <p className="rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/8 px-3 py-2 text-sm text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}

        <button
          type="button"
          disabled={isPending}
          onClick={handleSave}
          className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 text-sm font-semibold text-white transition-transform duration-150 hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-70"
        >
          {isPending ? "Saving..." : mode === "edit" ? "Update Recipe" : "Save Recipe"}
        </button>

        <button
          type="button"
          disabled={isPending}
          onClick={() => {
            const href = `/recipes?date=${selectedDate}`;
            prepareNavigationMotion(href, "screen");
            router.push(href);
          }}
          className="w-full rounded-xl border border-[var(--color-border-strong)] px-4 py-2.5 text-sm font-semibold text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
        >
          Cancel
        </button>
      </div>

      {showPresetsModal && (
        <ModalChunkDismissProvider onDismiss={dismissPresetModal}>
          <PresetModal
            presets={localTemplates}
            mutation={presetMutation}
            errorMessage={presetError}
            onClose={dismissPresetModal}
            onSelect={addIngredientFromPreset}
            onSave={handleSavePreset}
            onUpdate={handleUpdatePreset}
            onDelete={handleDeletePreset}
          />
        </ModalChunkDismissProvider>
      )}

      {/* Mirrors the component's own render condition so its chunk stays unloaded until a capture starts. */}
      {(showScanner || scanResult || notFoundBarcode) && (
        <ModalChunkDismissProvider onDismiss={dismissBarcodeCapture}>
      <BarcodeCaptureModals
        showScanner={showScanner}
        scanResult={scanResult}
        notFoundBarcode={notFoundBarcode}
        setShowScanner={setShowScanner}
        setScanResult={setScanResult}
        setNotFoundBarcode={setNotFoundBarcode}
        onAddToLog={(macros) => {
          setIngredients((prev) => [
            ...prev,
            {
              clientId: `ing-${crypto.randomUUID()}`,
              productId: macros.productId ?? null,
              label: macros.label,
              quantity: String(macros.quantity),
              unit: macros.unit,
              servingMultiplier: String(macros.servingMultiplier),
              proteinG: String(macros.proteinG),
              carbsG: String(macros.carbsG),
              fatG: String(macros.fatG),
              caloriesKcal: String(macros.caloriesKcal),
            },
          ]);
        }}
        onSaveAsPreset={(input) => {
          handleSavePreset(input);
        }}
      />
        </ModalChunkDismissProvider>
      )}
    </>
  );

  return (
    <AppShell
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      title={mode === "create" ? "New Recipe" : "Edit Recipe"}
      activeTab="recipes"
      todayStr={todayStr}
    >
      {content}
    </AppShell>
  );
}
