"use client";

import type { QuantityUnit } from "@macro-tracker/db";
import { memo } from "react";

import { NumberInputField } from "./number-input-field";

type IngredientDraft = {
  clientId: string;
  productId?: string | null;
  label: string;
  quantity?: string;
  unit?: QuantityUnit;
  servingMultiplier?: string;
  proteinG: string;
  carbsG: string;
  fatG: string;
  caloriesKcal: string;
};

type IngredientCardProps = {
  draft: IngredientDraft;
  disabled?: boolean;
  onChange: (clientId: string, draft: IngredientDraft) => void;
  onDelete: (clientId: string) => void;
  onDuplicate: (clientId: string) => void;
};

// Memoized to match MealCard: editing one ingredient otherwise re-renders the whole list.
export const IngredientCard = memo(function IngredientCard({
  draft,
  disabled,
  onChange,
  onDelete,
  onDuplicate,
}: IngredientCardProps) {
  function update(field: keyof IngredientDraft, value: string) {
    onChange(draft.clientId, { ...draft, [field]: value });
  }

  const isPositive = (value: string) => parseFloat(value) > 0;
  const hasValues =
    isPositive(draft.proteinG) ||
    isPositive(draft.carbsG) ||
    isPositive(draft.fatG) ||
    isPositive(draft.caloriesKcal);

  return (
    <article className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] shadow-[0_4px_16px_rgba(74,45,28,0.05)]">
      <div className="px-4 pb-4 pt-3">
        <div className="flex items-start gap-2">
          <label className="block min-w-0 flex-1">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
              Name
            </span>
            <input
              type="text"
              value={draft.label}
              disabled={disabled}
              onChange={(e) => update("label", e.target.value)}
              placeholder="Chicken breast, rice..."
              className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onDuplicate(draft.clientId)}
            className="mt-5 shrink-0 rounded-lg p-1.5 text-[var(--color-muted)] transition hover:text-[var(--color-ink)] disabled:opacity-50"
            aria-label={`Duplicate ${draft.label || "ingredient"}`}
            title="Duplicate"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="5" y="5" width="8" height="8" rx="1.5" />
              <path d="M3 11V4a1 1 0 0 1 1-1h7" />
            </svg>
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onDelete(draft.clientId)}
            className="mt-5 shrink-0 rounded-lg p-1.5 text-[var(--color-muted)] transition hover:text-[var(--color-danger)] disabled:opacity-50"
            aria-label={`Remove ${draft.label || "ingredient"}`}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            >
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>

        <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
          <NumberInputField
            label="Quantity"
            value={draft.quantity ?? "1"}
            unit={draft.unit ?? "serving"}
            step="0.01"
            disabled={disabled}
            onChange={(value) => update("quantity", value)}
          />
          <label className="block min-w-28">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
              Unit
            </span>
            <select
              value={draft.unit ?? "serving"}
              disabled={disabled}
              onChange={(event) => update("unit", event.target.value)}
              className="h-[38px] w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="g">g</option>
              <option value="ml">ml</option>
              <option value="serving">serving</option>
              <option value="count">count</option>
            </select>
          </label>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <NumberInputField
            label="Protein"
            value={draft.proteinG}
            unit="g"
            step="0.1"
            disabled={disabled}
            onChange={(v) => update("proteinG", v)}
          />
          <NumberInputField
            label="Carbs"
            value={draft.carbsG}
            unit="g"
            step="0.1"
            disabled={disabled}
            onChange={(v) => update("carbsG", v)}
          />
          <NumberInputField
            label="Fat"
            value={draft.fatG}
            unit="g"
            step="0.1"
            disabled={disabled}
            onChange={(v) => update("fatG", v)}
          />
          <NumberInputField
            label="Calories"
            value={draft.caloriesKcal}
            unit="kcal"
            step="1"
            disabled={disabled}
            onChange={(v) => update("caloriesKcal", v)}
          />
        </div>

        {hasValues && (
          <div className="mt-2 flex flex-wrap gap-x-2.5 gap-y-0.5">
            {isPositive(draft.proteinG) ? (
              <span className="text-[10px] font-semibold text-[var(--color-bar-protein)]">
                P {draft.proteinG}g
              </span>
            ) : null}
            {isPositive(draft.carbsG) ? (
              <span className="text-[10px] font-semibold text-[var(--color-bar-carbs)]">
                C {draft.carbsG}g
              </span>
            ) : null}
            {isPositive(draft.fatG) ? (
              <span className="text-[10px] font-semibold text-[var(--color-bar-fat)]">
                F {draft.fatG}g
              </span>
            ) : null}
            {isPositive(draft.caloriesKcal) ? (
              <span className="text-[10px] font-semibold text-[var(--color-muted)]">
                {draft.caloriesKcal} kcal
              </span>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
});

export type { IngredientDraft };
