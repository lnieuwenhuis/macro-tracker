"use client";

import type { FoodProduct, MealTemplate, RecipeRecord } from "@macro-tracker/db";
import { useRouter } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useState, useTransition } from "react";

import {
  filterLibraryItemsByQuery,
  normalizeLibraryQuery,
} from "@/lib/library-search";
import {
  getTemplateMacroTotals,
  isDayTemplate,
  isFoodItemTemplate,
} from "@/lib/template-macros";
import { AppShell, SettingsButton } from "./app-shell";
import { LibraryHubNav } from "./library-hub-nav";
import { TransitionLink } from "./transition-link";

type LibraryShellProps = {
  userEmail: string;
  canAccessAdmin: boolean;
  selectedDate: string;
  query: string;
  products: FoodProduct[];
  templates: MealTemplate[];
  recipes: RecipeRecord[];
  todayStr?: string;
};

export function LibraryShell({
  userEmail,
  canAccessAdmin,
  selectedDate,
  query,
  products,
  templates,
  recipes,
  todayStr,
}: LibraryShellProps) {
  const router = useRouter();
  const [search, setSearch] = useState(query);
  const [isSearching, startSearch] = useTransition();
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    setSearch(query);
  }, [query]);

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    params.set("date", selectedDate);
    startSearch(() => {
      router.push(`/library?${params.toString()}`);
    });
  }

  const foodItemTemplates = useMemo(
    () => templates.filter(isFoodItemTemplate),
    [templates],
  );
  const dayTemplates = useMemo(
    () => templates.filter(isDayTemplate),
    [templates],
  );
  const visibleFoodItemTemplates = useMemo(
    () => filterLibraryItemsByQuery(foodItemTemplates, deferredSearch, (template) => template.label),
    [deferredSearch, foodItemTemplates],
  );
  const visibleDayTemplates = useMemo(
    () => filterLibraryItemsByQuery(dayTemplates, deferredSearch, (template) => template.label),
    [dayTemplates, deferredSearch],
  );
  const visibleRecipes = useMemo(
    () => filterLibraryItemsByQuery(recipes, deferredSearch, (recipe) => recipe.label),
    [deferredSearch, recipes],
  );
  const hasActiveTemplateSearch = normalizeLibraryQuery(deferredSearch).length > 0;

  return (
    <AppShell
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      title="Food Library"
      activeTab="recipes"
      todayStr={todayStr}
      topBar={({ openSettings }) => (
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Food Library
            </h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Search foods, food item templates, day templates, and recipes.
            </p>
          </div>
          <SettingsButton onClick={openSettings} />
        </div>
      )}
    >
      <div className="space-y-5">
        <LibraryHubNav active="library" selectedDate={selectedDate} />

        <form onSubmit={submitSearch} className="flex gap-2">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search library"
            className="min-w-0 flex-1 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-4 py-3 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
          />
          <button
            type="submit"
            disabled={isSearching}
            className="rounded-2xl bg-[var(--color-accent)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
          >
            {isSearching ? "Searching..." : "Search"}
          </button>
        </form>

        <section>
          <h3 className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
            Foods
          </h3>
          {products.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] px-5 py-6 text-center">
              <p className="text-sm text-[var(--color-muted)]">
                {query ? "No food products found." : "Search to find foods."}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {products.map((product) => (
                <article
                  key={product.id}
                  className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4"
                >
                  <p className="font-semibold text-[var(--color-ink)]">{product.name}</p>
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    {product.brand || product.source} · {product.caloriesPer100} kcal / 100
                  </p>
                </article>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Food item templates
            </h3>
            <TransitionLink
              href={`/?date=${selectedDate}&compose=template&templateKind=food`}
              motion="screen"
              className="text-xs font-semibold text-[var(--color-accent)]"
            >
              Add
            </TransitionLink>
          </div>
          <div className="space-y-2">
            {visibleFoodItemTemplates.map((template) => {
              const totals = getTemplateMacroTotals(template.items);
              return (
                <article
                  key={template.id}
                  className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4"
                >
                  <p className="font-semibold text-[var(--color-ink)]">{template.label}</p>
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    {totals.caloriesKcal} kcal - P {totals.proteinG}g
                  </p>
                </article>
              );
            })}
            {visibleFoodItemTemplates.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-[var(--color-border-strong)] px-5 py-6 text-center text-sm text-[var(--color-muted)]">
                {hasActiveTemplateSearch ? "No food item templates found." : "No food item templates saved."}
              </p>
            ) : null}
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Day templates
            </h3>
            <TransitionLink
              href={`/planner?date=${selectedDate}`}
              motion="screen"
              className="text-xs font-semibold text-[var(--color-accent)]"
            >
              Planner
            </TransitionLink>
          </div>
          <div className="space-y-2">
            {visibleDayTemplates.map((template) => {
              const totals = getTemplateMacroTotals(template.items);
              return (
                <article
                  key={template.id}
                  className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4"
                >
                  <p className="font-semibold text-[var(--color-ink)]">{template.label}</p>
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    {template.items.length} item{template.items.length === 1 ? "" : "s"} - {totals.caloriesKcal} kcal - P {totals.proteinG}g
                  </p>
                </article>
              );
            })}
            {visibleDayTemplates.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-[var(--color-border-strong)] px-5 py-6 text-center text-sm text-[var(--color-muted)]">
                {hasActiveTemplateSearch ? "No day templates found." : "No day templates saved."}
              </p>
            ) : null}
          </div>
        </section>

        <section>
          <h3 className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
            Recipes
          </h3>
          <div className="space-y-2">
            {visibleRecipes.map((recipe) => (
              <TransitionLink
                key={recipe.id}
                href={`/recipes/${recipe.id}/edit?date=${selectedDate}`}
                motion="screen"
                className="block rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4"
              >
                <p className="font-semibold text-[var(--color-ink)]">{recipe.label}</p>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  {recipe.portions} portions · {recipe.perPortionMacros.caloriesKcal} kcal per portion
                </p>
              </TransitionLink>
            ))}
            {visibleRecipes.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-[var(--color-border-strong)] px-5 py-6 text-center text-sm text-[var(--color-muted)]">
                No recipes found.
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
