"use client";

import type { RecipeRecord } from "@macro-tracker/db";
import { useEffect, useRef } from "react";

type RecipePickerModalProps = {
  recipes: RecipeRecord[];
  onClose: () => void;
  onSelect: (recipe: RecipeRecord) => void;
};

export function RecipePickerModal({
  recipes,
  onClose,
  onSelect,
}: RecipePickerModalProps) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- onClose stored in ref; effect runs once
  }, []);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Pick a Recipe"
        className="fixed inset-x-4 top-[8%] z-50 mx-auto max-h-[82vh] max-w-sm overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5 shadow-2xl"
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-[var(--color-ink)]">
            Pick a Recipe
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="4" y1="4" x2="14" y2="14" />
              <line x1="14" y1="4" x2="4" y2="14" />
            </svg>
          </button>
        </div>

        {/* Empty state */}
        {recipes.length === 0 && (
          <p className="py-3 text-center text-sm text-[var(--color-muted)]">
            No recipes yet — create one from the Recipes page.
          </p>
        )}

        {/* Recipe list */}
        {recipes.length > 0 && (
          <div className="space-y-2">
            {recipes.map((recipe) => (
              <div
                key={recipe.id}
                className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-[var(--color-ink)]">
                    {recipe.label}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5">
                    <span className="text-[10px] font-semibold text-[var(--color-bar-protein)]">
                      P {recipe.perPortionMacros.proteinG}g
                    </span>
                    <span className="text-[10px] font-semibold text-[var(--color-bar-carbs)]">
                      C {recipe.perPortionMacros.carbsG}g
                    </span>
                    <span className="text-[10px] font-semibold text-[var(--color-bar-fat)]">
                      F {recipe.perPortionMacros.fatG}g
                    </span>
                    <span className="text-[10px] font-semibold text-[var(--color-muted)]">
                      {recipe.perPortionMacros.caloriesKcal} kcal
                    </span>
                    <span className="text-[10px] text-[var(--color-muted)]">
                      / portion
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onSelect(recipe)}
                  className="shrink-0 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-white transition hover:-translate-y-0.5"
                >
                  Add
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
