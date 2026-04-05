"use client";

import type { RecipeRecord } from "@macro-tracker/db";
import Link from "next/link";

import { AppShell } from "./app-shell";
import { RecipeCard } from "./recipe-card";

type RecipesShellProps = {
  userEmail: string;
  selectedDate: string;
  recipes: RecipeRecord[];
};

export function RecipesShell({
  userEmail,
  selectedDate,
  recipes,
}: RecipesShellProps) {
  return (
    <AppShell userEmail={userEmail} selectedDate={selectedDate} activeTab="recipes">
      <div className="space-y-5">
        {/* Header with create button */}
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
            My Recipes
          </h2>
          <Link
            href={`/recipes/new?date=${selectedDate}`}
            className="flex h-9 items-center gap-1.5 rounded-full bg-[var(--color-accent)] px-4 text-sm font-semibold text-white shadow-md transition hover:-translate-y-0.5"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <line x1="7" y1="2" x2="7" y2="12" />
              <line x1="2" y1="7" x2="12" y2="7" />
            </svg>
            New Recipe
          </Link>
        </div>

        {/* Recipe list */}
        {recipes.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] px-5 py-8 text-center">
            <p className="text-sm text-[var(--color-muted)]">
              No recipes yet — create one to get started.
            </p>
            <Link
              href={`/recipes/new?date=${selectedDate}`}
              className="mt-3 inline-flex rounded-full bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5"
            >
              Create recipe
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {recipes.map((recipe) => (
              <RecipeCard
                key={recipe.id}
                recipe={recipe}
                selectedDate={selectedDate}
              />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
