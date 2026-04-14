"use client";

import { useState } from "react";

import { saveCustomBarcodeProductAction } from "@/lib/actions";
import type { OpenFoodFactsProduct } from "@/lib/openfoodfacts";
import { OverlayPortal, useBodyScrollLock } from "./overlay-portal";

type BarcodeResultProps = {
  product: OpenFoodFactsProduct | null;
  notFoundBarcode: string | null;
  onAddToLog: (macros: {
    label: string;
    proteinG: number;
    carbsG: number;
    fatG: number;
    caloriesKcal: number;
  }) => void;
  onSaveAsPreset: (input: {
    label: string;
    proteinG: number;
    carbsG: number;
    fatG: number;
    caloriesKcal: number;
  }) => void;
  onScanAnother: () => void;
  onClose: () => void;
};

type ManualFormValues = {
  name: string;
  brands: string;
  caloriesKcal: string;
  proteinG: string;
  carbsG: string;
  fatG: string;
  servingSizeG: string;
};

function scaleValue(per100: number, grams: number): number {
  return Math.round((per100 * grams) / 100 * 10) / 10;
}

function scaleCalories(per100: number, grams: number): number {
  return Math.round((per100 * grams) / 100);
}

function parsePositiveNumber(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0;
}

// ---------------------------------------------------------------------------
// Sub-component: manual entry form shown when a barcode isn't found
// ---------------------------------------------------------------------------

function NotFoundForm({
  barcode,
  onProductSaved,
  onScanAnother,
  onClose,
}: {
  barcode: string;
  onProductSaved: (product: OpenFoodFactsProduct) => void;
  onScanAnother: () => void;
  onClose: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [form, setForm] = useState<ManualFormValues>({
    name: "",
    brands: "",
    caloriesKcal: "",
    proteinG: "",
    carbsG: "",
    fatG: "",
    servingSizeG: "",
  });

  function update(field: keyof ManualFormValues, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setSaveError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const name = form.name.trim();
    if (!name) {
      setSaveError("Product name is required.");
      return;
    }

    const caloriesKcal = Math.round(parsePositiveNumber(form.caloriesKcal));
    const proteinG = parsePositiveNumber(form.proteinG);
    const carbsG = parsePositiveNumber(form.carbsG);
    const fatG = parsePositiveNumber(form.fatG);
    const servingSizeRaw = parsePositiveNumber(form.servingSizeG);
    const servingSizeG = servingSizeRaw > 0 ? servingSizeRaw : null;

    setIsSaving(true);
    setSaveError(null);

    const result = await saveCustomBarcodeProductAction({
      barcode,
      name,
      brands: form.brands.trim(),
      caloriesKcal,
      proteinG,
      carbsG,
      fatG,
      servingSizeG,
    });

    setIsSaving(false);

    if (!result.ok || !result.product) {
      setSaveError(result.error ?? "Failed to save product.");
      return;
    }

    // Hand the saved product back up so the normal product view can render
    onProductSaved({
      name: result.product.name,
      brands: result.product.brands,
      barcode: result.product.barcode,
      proteinG: result.product.proteinG,
      carbsG: result.product.carbsG,
      fatG: result.product.fatG,
      caloriesKcal: result.product.caloriesKcal,
      servingSizeG: result.product.servingSizeG,
      imageUrl: null,
      source: "custom",
    });
  }

  // ── "not found" landing screen ──────────────────────────────────────────
  if (!showForm) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div
          className="absolute inset-0 bg-black/40 backdrop-blur-sm"
          onClick={onClose}
        />
        <div className="relative z-10 mx-4 w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-6 shadow-2xl">
          <h3 className="text-lg font-bold text-[var(--color-ink)]">
            Product not found
          </h3>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Barcode <span className="font-mono">{barcode}</span> wasn&apos;t
            found in any of our databases. Add it yourself so everyone can
            benefit!
          </p>
          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={onScanAnother}
              className="flex-1 rounded-xl border border-[var(--color-accent)] py-2.5 text-sm font-semibold text-[var(--color-accent)] transition hover:-translate-y-0.5"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="flex-1 rounded-xl bg-[var(--color-accent)] py-2.5 text-sm font-semibold text-white transition hover:-translate-y-0.5"
            >
              Add product
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── manual entry form ────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative z-10 mx-4 mb-4 w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] shadow-2xl sm:mb-0">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
          <div>
            <h3 className="text-base font-bold text-[var(--color-ink)]">
              Add product
            </h3>
            <p className="text-xs text-[var(--color-muted)]">
              Barcode{" "}
              <span className="font-mono">{barcode}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
            aria-label="Close"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <line x1="3" y1="3" x2="13" y2="13" />
              <line x1="13" y1="3" x2="3" y2="13" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 p-5">
          {/* Name */}
          <div>
            <label className="text-xs font-medium text-[var(--color-muted)]">
              Product name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Pindakaas"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
            />
          </div>

          {/* Brand */}
          <div>
            <label className="text-xs font-medium text-[var(--color-muted)]">
              Brand
            </label>
            <input
              type="text"
              placeholder="e.g. Calvé"
              value={form.brands}
              onChange={(e) => update("brands", e.target.value)}
              className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
            />
          </div>

          {/* Macros per 100 g label */}
          <p className="pt-1 text-[11px] font-semibold uppercase tracking-widest text-[var(--color-muted)]">
            Nutrition per 100 g
          </p>

          {/* Macro grid */}
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                {
                  field: "caloriesKcal" as const,
                  label: "Calories (kcal)",
                  color: "var(--color-bar-calories)",
                },
                {
                  field: "proteinG" as const,
                  label: "Protein (g)",
                  color: "var(--color-bar-protein)",
                },
                {
                  field: "carbsG" as const,
                  label: "Carbs (g)",
                  color: "var(--color-bar-carbs)",
                },
                {
                  field: "fatG" as const,
                  label: "Fat (g)",
                  color: "var(--color-bar-fat)",
                },
              ] as const
            ).map(({ field, label, color }) => (
              <div key={field}>
                <label
                  className="text-xs font-medium"
                  style={{ color }}
                >
                  {label}
                </label>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.1"
                  placeholder="0"
                  value={form[field]}
                  onChange={(e) => update(field, e.target.value)}
                  className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
                />
              </div>
            ))}
          </div>

          {/* Serving size */}
          <div>
            <label className="text-xs font-medium text-[var(--color-muted)]">
              Default serving size (g) — optional
            </label>
            <input
              type="number"
              inputMode="decimal"
              min="1"
              step="1"
              placeholder="e.g. 30"
              value={form.servingSizeG}
              onChange={(e) => update("servingSizeG", e.target.value)}
              className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
            />
          </div>

          {saveError && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/30 dark:text-red-400">
              {saveError}
            </p>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="flex-1 rounded-xl border border-[var(--color-border)] py-2.5 text-sm font-semibold text-[var(--color-ink)] transition hover:-translate-y-0.5"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="flex-1 rounded-xl bg-[var(--color-accent)] py-2.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:opacity-60"
            >
              {isSaving ? "Saving…" : "Save product"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function BarcodeResult({
  product,
  notFoundBarcode,
  onAddToLog,
  onSaveAsPreset,
  onScanAnother,
  onClose,
}: BarcodeResultProps) {
  // A product manually entered this session — treated the same as a found one
  const [communityProduct, setCommunityProduct] =
    useState<OpenFoodFactsProduct | null>(null);
  useBodyScrollLock();

  const displayProduct = communityProduct ?? product;

  const defaultServing = displayProduct?.servingSizeG ?? 100;
  const [servingG, setServingG] = useState(String(defaultServing));
  const [savedPreset, setSavedPreset] = useState(false);

  const serving = Number(servingG) || 100;

  // ── Not-found state: delegate to the form sub-component ─────────────────
  if (!displayProduct && notFoundBarcode) {
    return (
      <OverlayPortal>
        <NotFoundForm
          barcode={notFoundBarcode}
          onProductSaved={(saved) => {
            setCommunityProduct(saved);
            // Reset serving size to the new product's default
            setServingG(String(saved.servingSizeG ?? 100));
          }}
          onScanAnother={onScanAnother}
          onClose={onClose}
        />
      </OverlayPortal>
    );
  }

  if (!displayProduct) return null;

  const scaled = {
    proteinG: scaleValue(displayProduct.proteinG, serving),
    carbsG: scaleValue(displayProduct.carbsG, serving),
    fatG: scaleValue(displayProduct.fatG, serving),
    caloriesKcal: scaleCalories(displayProduct.caloriesKcal, serving),
  };

  const displayLabel = displayProduct.brands
    ? `${displayProduct.name} (${displayProduct.brands})`
    : displayProduct.name;

  function sourceLabel(
    source: OpenFoodFactsProduct["source"],
  ): string {
    switch (source) {
      case "openfoodfacts":
        return "OpenFoodFacts";
      case "albert_heijn":
        return "Albert Heijn";
      case "jumbo":
        return "Jumbo";
      case "custom":
        return "Community";
      default:
        return "";
    }
  }

  return (
    <OverlayPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div
          className="absolute inset-0 bg-black/40 backdrop-blur-sm"
          onClick={onClose}
        />
        <div className="relative z-10 mx-4 w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-6 shadow-2xl">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-lg font-bold text-[var(--color-ink)]">
                {displayProduct.name}
              </h3>
              {displayProduct.brands && (
                <p className="text-xs text-[var(--color-muted)]">
                  {displayProduct.brands}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
              aria-label="Close"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              >
                <line x1="3" y1="3" x2="13" y2="13" />
                <line x1="13" y1="3" x2="3" y2="13" />
              </svg>
            </button>
          </div>

          {/* Serving size */}
          <div className="mt-4">
            <label className="text-xs text-[var(--color-muted)]">
              Serving size (g)
            </label>
            <input
              type="number"
              inputMode="decimal"
              step="1"
              min="1"
              value={servingG}
              onChange={(e) => setServingG(e.target.value)}
              className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
            />
          </div>

          {/* Macro display */}
          <div className="mt-4 grid grid-cols-2 gap-2">
            {[
              {
                label: "Calories",
                value: `${scaled.caloriesKcal} kcal`,
                color: "var(--color-bar-calories)",
              },
              {
                label: "Protein",
                value: `${scaled.proteinG}g`,
                color: "var(--color-bar-protein)",
              },
              {
                label: "Carbs",
                value: `${scaled.carbsG}g`,
                color: "var(--color-bar-carbs)",
              },
              {
                label: "Fat",
                value: `${scaled.fatG}g`,
                color: "var(--color-bar-fat)",
              },
            ].map(({ label, value, color }) => (
              <div
                key={label}
                className="rounded-xl border border-[var(--color-border)] px-3 py-2"
              >
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
                  {label}
                </span>
                <p
                  className="mt-0.5 text-lg font-bold tabular-nums"
                  style={{ color }}
                >
                  {value}
                </p>
              </div>
            ))}
          </div>

          <p className="mt-2 text-[10px] text-[var(--color-muted)]">
            Values per {serving}g
            {serving !== 100
              ? ` (per 100g: ${displayProduct.caloriesKcal} kcal)`
              : ""}
            {displayProduct.source && (
              <span className="ml-1">
                &middot; {sourceLabel(displayProduct.source)}
              </span>
            )}
          </p>

          {/* Actions */}
          <div className="mt-5 space-y-2">
            <button
              type="button"
              onClick={() =>
                onAddToLog({
                  label: displayLabel,
                  ...scaled,
                })
              }
              className="w-full rounded-xl bg-[var(--color-accent)] py-2.5 text-sm font-semibold text-white transition hover:-translate-y-0.5"
            >
              Add to log
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={savedPreset}
                onClick={() => {
                  onSaveAsPreset({
                    label: displayLabel,
                    ...scaled,
                  });
                  setSavedPreset(true);
                }}
                className="flex-1 rounded-xl border border-[var(--color-accent)] py-2.5 text-sm font-semibold text-[var(--color-accent)] transition hover:-translate-y-0.5 disabled:opacity-50"
              >
                {savedPreset ? "Saved!" : "Save as preset"}
              </button>
              <button
                type="button"
                onClick={onScanAnother}
                className="flex-1 rounded-xl border border-[var(--color-border)] py-2.5 text-sm font-semibold text-[var(--color-ink)] transition hover:-translate-y-0.5"
              >
                Scan another
              </button>
            </div>
          </div>
        </div>
      </div>
    </OverlayPortal>
  );
}
