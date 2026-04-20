"use client";

import type { RecipeRecord } from "@macro-tracker/db";
import type { UiMode } from "@/lib/ui-mode";

import { AppShell } from "./app-shell";
import { ExperimentalAppShell, ExperimentalSettingsButton } from "./experimental-app-shell";
import { RecipeCard } from "./recipe-card";
import { TransitionLink } from "./transition-link";

type RecipesShellProps = {
  userEmail: string;
  canAccessAdmin: boolean;
  selectedDate: string;
  recipes: RecipeRecord[];
  uiMode?: UiMode;
};

export function RecipesShell({
  userEmail,
  canAccessAdmin,
  selectedDate,
  recipes,
  uiMode = "legacy",
}: RecipesShellProps) {
  const content = (
    <div className="space-y-5">
      {recipes.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] px-5 py-8 text-center">
          <p className="text-sm text-[var(--color-muted)]">
            No recipes yet — create one to get started.
          </p>
          <TransitionLink
            href={`/recipes/new?date=${selectedDate}`}
            motion="screen"
            className="mt-3 inline-flex rounded-full bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5"
          >
            Create recipe
          </TransitionLink>
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
  );

  return uiMode === "experimental" ? (
    <ExperimentalAppShell
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      title="Recipes"
      activeTab="recipes"
      topBar={({ openSettings }) => (
        <div className="mb-4 flex items-center justify-between gap-3">
          <TransitionLink
            href={`/recipes/new?date=${selectedDate}`}
            motion="screen"
            className="flex h-12 items-center gap-1.5 rounded-full bg-[var(--color-accent)] px-4 text-sm font-semibold text-white shadow-md transition hover:-translate-y-0.5"
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
          </TransitionLink>
          <ExperimentalSettingsButton onClick={openSettings} />
        </div>
      )}
    >
      {content}
    </ExperimentalAppShell>
  ) : (
    <AppShell
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      activeTab="recipes"
    >
      {content}
    </AppShell>
  );
}
