"use client";

import type { RecipeRecord } from "@macro-tracker/db";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { deleteRecipeAction, logRecipePortionAction } from "@/lib/actions";

type RecipeCardProps = {
  recipe: RecipeRecord;
  selectedDate: string;
};

export function RecipeCard({ recipe, selectedDate }: RecipeCardProps) {
  const router = useRouter();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleLogPortion() {
    setError(null);
    startTransition(async () => {
      const result = await logRecipePortionAction({
        recipeId: recipe.id,
        date: selectedDate,
      });
      if (!result.ok) {
        setError(result.error ?? "Unable to log portion.");
        return;
      }
      router.refresh();
    });
  }

  function handleDelete() {
    if (!confirm(`Delete "${recipe.label}"? This cannot be undone.`)) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteRecipeAction({ id: recipe.id });
      if (!result.ok) {
        setError(result.error ?? "Unable to delete recipe.");
        return;
      }
      router.refresh();
    });
  }

  const { perPortionMacros, totalMacros } = recipe;

  return (
    <article className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] shadow-[0_4px_16px_rgba(74,45,28,0.05)]">
      {/* Header row */}
      <div
        className="flex items-center gap-2 px-4 py-3 cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setIsExpanded(!isExpanded);
        }}
      >
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-[var(--color-ink)]">
            {recipe.label}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
            <span className="text-[10px] font-semibold text-[var(--color-bar-protein)]">
              P {perPortionMacros.proteinG}g
            </span>
            <span className="text-[10px] font-semibold text-[var(--color-bar-carbs)]">
              C {perPortionMacros.carbsG}g
            </span>
            <span className="text-[10px] font-semibold text-[var(--color-bar-fat)]">
              F {perPortionMacros.fatG}g
            </span>
            <span className="text-[10px] font-semibold text-[var(--color-muted)]">
              {perPortionMacros.caloriesKcal} kcal
            </span>
            <span className="text-[10px] text-[var(--color-muted)]">
              / portion
            </span>
          </div>
        </div>

        <span className="shrink-0 rounded-md bg-[var(--color-shell-panel)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-muted-strong)]">
          {recipe.portions} portion{recipe.portions !== 1 ? "s" : ""}
        </span>

        {/* Chevron */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded(!isExpanded);
          }}
          className="shrink-0 rounded-lg p-1 text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
          aria-label={isExpanded ? "Collapse" : "Expand"}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {isExpanded ? (
              <polyline points="4,10 8,6 12,10" />
            ) : (
              <polyline points="4,6 8,10 12,6" />
            )}
          </svg>
        </button>
      </div>

      {/* Expanded body */}
      {isExpanded && (
        <div className="border-t border-[var(--color-border)] px-4 pb-4 pt-3">
          {/* Total macros */}
          <div className="mb-3">
            <h4 className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
              Total Recipe
            </h4>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
              <span className="text-[11px] font-semibold text-[var(--color-bar-protein)]">
                P {totalMacros.proteinG}g
              </span>
              <span className="text-[11px] font-semibold text-[var(--color-bar-carbs)]">
                C {totalMacros.carbsG}g
              </span>
              <span className="text-[11px] font-semibold text-[var(--color-bar-fat)]">
                F {totalMacros.fatG}g
              </span>
              <span className="text-[11px] font-semibold text-[var(--color-muted)]">
                {totalMacros.caloriesKcal} kcal
              </span>
            </div>
          </div>

          {/* Ingredients list */}
          <div className="mb-3">
            <h4 className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
              Ingredients ({recipe.ingredients.length})
            </h4>
            <div className="space-y-1">
              {recipe.ingredients.map((ing) => (
                <div
                  key={ing.id}
                  className="flex items-center gap-2 rounded-lg bg-[var(--color-shell-panel)] px-3 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--color-ink)]">
                    {ing.label}
                  </span>
                  <div className="flex shrink-0 gap-x-2">
                    <span className="text-[10px] font-semibold text-[var(--color-bar-protein)]">
                      P {ing.proteinG}g
                    </span>
                    <span className="text-[10px] font-semibold text-[var(--color-bar-carbs)]">
                      C {ing.carbsG}g
                    </span>
                    <span className="text-[10px] font-semibold text-[var(--color-bar-fat)]">
                      F {ing.fatG}g
                    </span>
                    <span className="text-[10px] font-semibold text-[var(--color-muted)]">
                      {ing.caloriesKcal}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Error */}
          {error ? (
            <p className="mb-3 text-sm text-[var(--color-danger)]">{error}</p>
          ) : null}

          {/* Action buttons */}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={isPending}
              onClick={handleLogPortion}
              className="flex-1 rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-70"
            >
              {isPending ? "Logging..." : "Log 1 portion"}
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() =>
                router.push(`/recipes/${recipe.id}/edit?date=${selectedDate}`)
              }
              className="rounded-xl border border-[var(--color-border-strong)] px-3 py-2.5 text-sm font-semibold text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
              aria-label={`Edit ${recipe.label}`}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 2.5l2.5 2.5L5 13.5H2.5V11L11 2.5z" />
              </svg>
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={handleDelete}
              className="rounded-xl border border-[var(--color-border-strong)] px-3 py-2.5 text-sm font-semibold text-[var(--color-muted)] transition hover:text-[var(--color-danger)]"
              aria-label={`Delete ${recipe.label}`}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <line x1="4" y1="4" x2="12" y2="12" />
                <line x1="12" y1="4" x2="4" y2="12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
