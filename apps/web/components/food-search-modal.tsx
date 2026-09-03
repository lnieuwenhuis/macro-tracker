"use client";

import type { FoodProduct, MealEntryRecord } from "@macro-tracker/db";
import { useEffect, useMemo, useRef, useState } from "react";

import { saveMealEntryAction, searchFoodsAction } from "@/lib/actions";
import {
  hasCurrentFoodSearchResults,
  normalizeFoodSearchQuery,
} from "@/lib/food-search-state";
import { formatSelectedDate } from "@/lib/formatting";
import { buildMealEntryCopyInput } from "@/lib/meal-entry-copy";
import { createClientMutationIdStore } from "@/lib/client-mutation-id";
import { getLocalDateString } from "@/lib/startup-date";
import { CompactModal } from "./compact-modal";

type FoodSearchModalProps = {
  onClose: () => void;
  onViewDate: (date: string) => void;
  onEntrySaved?: (entry: MealEntryRecord) => void;
};

export function FoodSearchModal({ onClose, onViewDate, onEntrySaved }: FoodSearchModalProps) {
  const [query, setQuery] = useState("");
  const [resultQuery, setResultQuery] = useState("");
  const [results, setResults] = useState<MealEntryRecord[]>([]);
  const [products, setProducts] = useState<FoodProduct[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [copiedIds, setCopiedIds] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const mutationIds = useRef(createClientMutationIdStore());
  // Pending "copied" flash timers, keyed by entry id; cleared on unmount to avoid a setState on an unmounted tree.
  const copiedTimersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const timers = copiedTimersRef.current;
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  const todayStr = useMemo(() => getLocalDateString(), []);
  const trimmedQuery = normalizeFoodSearchQuery(query);
  const hasCurrentResults = hasCurrentFoodSearchResults(resultQuery, trimmedQuery);
  const visibleResults = hasCurrentResults ? results : [];
  const visibleProducts = hasCurrentResults ? products : [];
  const visibleError = hasCurrentResults ? error : null;
  const shouldShowNoResults =
    Boolean(trimmedQuery) &&
    hasCurrentResults &&
    !isSearching &&
    visibleResults.length === 0 &&
    visibleProducts.length === 0 &&
    !visibleError;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!trimmedQuery) {
      setResults([]);
      setProducts([]);
      setResultQuery("");
      setError(null);
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    setIsSearching(true);
    setError(null);
    setResults([]);
    setProducts([]);
    setResultQuery(trimmedQuery);

    const timer = setTimeout(async () => {
      try {
        const result = await searchFoodsAction({ query: trimmedQuery });
        // Guard against unmount or a newer query while this request was in flight.
        if (cancelled) return;
        setResultQuery(trimmedQuery);
        if (result.ok) {
          setResults(result.results ?? []);
          setProducts(result.products ?? []);
          setError(result.error ?? null);
        } else {
          setError(result.error ?? "Search failed.");
          setResults([]);
          setProducts([]);
        }
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmedQuery]);

  async function handleCopyToToday(entry: MealEntryRecord) {
    const mutationKey = `history:${entry.id}:${todayStr}`;
    setCopyingId(entry.id);
    setError(null);
    try {
      const result = await saveMealEntryAction({
        ...buildMealEntryCopyInput(entry, todayStr),
        clientMutationId: mutationIds.current.take(mutationKey),
      });

      if (result.ok) {
        mutationIds.current.settle(mutationKey);
        if (result.entry) {
          onEntrySaved?.(result.entry);
        }
        setCopiedIds((prev) => new Set([...prev, entry.id]));
        const existingTimer = copiedTimersRef.current.get(entry.id);
        if (existingTimer !== undefined) {
          window.clearTimeout(existingTimer);
        }
        copiedTimersRef.current.set(
          entry.id,
          window.setTimeout(() => {
            copiedTimersRef.current.delete(entry.id);
            setCopiedIds((prev) => {
              const next = new Set(prev);
              next.delete(entry.id);
              return next;
            });
          }, 2500),
        );
        return;
      }

      setError(result.error ?? "Unable to add this food to today.");
    } finally {
      setCopyingId(null);
    }
  }

  async function handleAddProduct(product: FoodProduct) {
    const mutationKey = `product:${product.id}:${todayStr}`;
    setCopyingId(product.id);
    setError(null);
    try {
      const quantity = product.defaultServingQuantity || 1;
      const base =
        product.defaultServingUnit === "g" || product.defaultServingUnit === "ml"
          ? quantity / 100
          : ((product.servingWeightG ?? product.servingVolumeMl ?? 100) * quantity) / 100;
      const result = await saveMealEntryAction({
        date: todayStr,
        status: "eaten",
        clientMutationId: mutationIds.current.take(mutationKey),
        productId: product.id,
        label: product.brand ? `${product.name} (${product.brand})` : product.name,
        quantity,
        unit: product.defaultServingUnit,
        proteinG: Math.round(product.proteinPer100 * base * 10) / 10,
        carbsG: Math.round(product.carbsPer100 * base * 10) / 10,
        fatG: Math.round(product.fatPer100 * base * 10) / 10,
        caloriesKcal: Math.round(product.caloriesPer100 * base),
      });

      if (result.ok) {
        mutationIds.current.settle(mutationKey);
        if (result.entry) {
          onEntrySaved?.(result.entry);
        }
        setCopiedIds((prev) => new Set([...prev, product.id]));
        return;
      }

      setError(result.error ?? "Unable to add this food to today.");
    } finally {
      setCopyingId(null);
    }
  }

  return (
    <CompactModal
      ariaLabel="Search food history"
      title="Search History"
      onClose={onClose}
    >
        {/* Search input */}
        <div className="relative mb-4">
          <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)]">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="7" cy="7" r="5" />
              <line x1="11" y1="11" x2="14.5" y2="14.5" />
            </svg>
          </div>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all logged days..."
            className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] py-2.5 pl-9 pr-9 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
          />
          {isSearching && (
            <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
            </div>
          )}
        </div>

        {/* Error */}
        {visibleError && (
          <p className="mb-3 rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/8 px-3 py-2 text-sm text-[var(--color-danger)]">
            {visibleError}
          </p>
        )}

        {/* Prompt state */}
        {!trimmedQuery && (
          <p className="py-4 text-center text-sm text-[var(--color-muted)]">
            Type to search across all your logged days.
          </p>
        )}

        {/* No results */}
        {shouldShowNoResults && (
          <p className="py-4 text-center text-sm text-[var(--color-muted)]">
            No food items found for &ldquo;{query}&rdquo;.
          </p>
        )}

        {visibleProducts.length > 0 && (
          <div className="mb-4 space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
              Products
            </p>
            {visibleProducts.map((product) => (
              <div
                key={product.id}
                className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-[var(--color-ink)]">
                    {product.name}
                  </p>
                  <p className="text-[10px] text-[var(--color-muted)]">
                    {product.brand || product.scope} · {product.caloriesPer100} kcal / 100
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleAddProduct(product)}
                  disabled={copyingId === product.id || copiedIds.has(product.id)}
                  className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-semibold text-white transition hover:-translate-y-0.5 disabled:opacity-70"
                >
                  {copiedIds.has(product.id) ? "Added" : "Add"}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Results */}
        {visibleResults.length > 0 && (
          <div className="space-y-2">
            {visibleResults.map((entry) => {
              const isCopying = copyingId === entry.id;
              const isCopied = copiedIds.has(entry.id);

              return (
                <div
                  key={entry.id}
                  className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] px-3 py-2.5"
                >
                  {/* Food info */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[var(--color-ink)]">
                      {entry.label}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                      <span className="text-[10px] font-medium text-[var(--color-muted)]">
                        {formatSelectedDate(entry.date)}
                      </span>
                      <span className="text-[10px] font-semibold text-[var(--color-bar-protein)]">P {entry.proteinG}g</span>
                      <span className="text-[10px] font-semibold text-[var(--color-bar-carbs)]">C {entry.carbsG}g</span>
                      <span className="text-[10px] font-semibold text-[var(--color-bar-fat)]">F {entry.fatG}g</span>
                      <span className="text-[10px] font-semibold text-[var(--color-muted)]">{entry.caloriesKcal} kcal</span>
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="flex shrink-0 flex-col gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleCopyToToday(entry)}
                      disabled={isCopying || isCopied}
                      className="rounded-lg border border-[var(--color-accent)] px-3 py-1 text-xs font-semibold text-[var(--color-accent)] transition hover:-translate-y-0.5 disabled:cursor-default disabled:opacity-70"
                    >
                      {isCopied ? "Added ✓" : isCopying ? "Adding…" : "Add today"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onViewDate(entry.date)}
                      className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-semibold text-white transition hover:-translate-y-0.5"
                    >
                      View day
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
    </CompactModal>
  );
}
