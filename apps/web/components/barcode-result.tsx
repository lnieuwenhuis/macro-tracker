"use client";

import { useState } from "react";

import type { OpenFoodFactsProduct } from "@/lib/openfoodfacts";

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

function scaleValue(per100: number, grams: number): number {
  return Math.round((per100 * grams) / 100 * 10) / 10;
}

function scaleCalories(per100: number, grams: number): number {
  return Math.round((per100 * grams) / 100);
}

export function BarcodeResult({
  product,
  notFoundBarcode,
  onAddToLog,
  onSaveAsPreset,
  onScanAnother,
  onClose,
}: BarcodeResultProps) {
  const defaultServing = product?.servingSizeG ?? 100;
  const [servingG, setServingG] = useState(String(defaultServing));
  const [savedPreset, setSavedPreset] = useState(false);

  const serving = Number(servingG) || 100;

  // Not found state
  if (!product && notFoundBarcode) {
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
            Barcode <span className="font-mono">{notFoundBarcode}</span> was not
            found in the database.
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
              onClick={() => {
                onAddToLog({
                  label: `Barcode ${notFoundBarcode}`,
                  proteinG: 0,
                  carbsG: 0,
                  fatG: 0,
                  caloriesKcal: 0,
                });
              }}
              className="flex-1 rounded-xl bg-[var(--color-accent)] py-2.5 text-sm font-semibold text-white transition hover:-translate-y-0.5"
            >
              Add manually
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!product) return null;

  const scaled = {
    proteinG: scaleValue(product.proteinG, serving),
    carbsG: scaleValue(product.carbsG, serving),
    fatG: scaleValue(product.fatG, serving),
    caloriesKcal: scaleCalories(product.caloriesKcal, serving),
  };

  const displayLabel = product.brands
    ? `${product.name} (${product.brands})`
    : product.name;

  return (
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
              {product.name}
            </h3>
            {product.brands && (
              <p className="text-xs text-[var(--color-muted)]">
                {product.brands}
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
          {serving !== 100 ? ` (per 100g: ${product.caloriesKcal} kcal)` : ""}
          {product.source && (
            <span className="ml-1">
              &middot;{" "}
              {product.source === "openfoodfacts"
                ? "OpenFoodFacts"
                : product.source === "albert_heijn"
                  ? "Albert Heijn"
                  : "Jumbo"}
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
  );
}
