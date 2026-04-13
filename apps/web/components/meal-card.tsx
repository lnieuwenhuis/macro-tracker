"use client";

import { useState } from "react";

type MealDraft = {
  clientId: string;
  id?: string;
  label: string;
  proteinG: string;
  carbsG: string;
  fatG: string;
  caloriesKcal: string;
  sortOrder: number;
};

type MealCardProps = {
  draft: MealDraft;
  busy: boolean;
  error?: string | null;
  /** True for ~2 s after a successful copy-to-today so the button can show confirmation. */
  isCopied?: boolean;
  onChange: (
    clientId: string,
    field: keyof Omit<MealDraft, "clientId" | "id" | "sortOrder">,
    value: string,
  ) => void;
  onSave: (clientId: string) => void;
  onDelete: (clientId: string) => void;
  onDuplicate: (clientId: string) => void;
  onCopyToToday?: (clientId: string) => void;
};

function NumericInput({
  label,
  value,
  busy,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: string;
  busy: boolean;
  step: string;
  unit: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
        {label}
      </span>
      <div className="relative">
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step={step}
          value={value}
          disabled={busy}
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2.5 pr-9 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
        />
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-[var(--color-muted)]">
          {unit}
        </span>
      </div>
    </label>
  );
}

export function MealCard({ draft, busy, error, isCopied = false, onChange, onSave, onDelete, onDuplicate, onCopyToToday }: MealCardProps) {
  const isSaved = Boolean(draft.id);
  const [isExpanded, setIsExpanded] = useState(!isSaved);

  const heading = draft.label.trim() || "New item";
  // A macro chip is only worth showing when the value is meaningfully positive.
  // parseFloat handles both "" (NaN → false) and "0" (0 → false) correctly.
  const isPositive = (v: string) => parseFloat(v) > 0;
  const hasValues =
    isPositive(draft.proteinG) ||
    isPositive(draft.carbsG) ||
    isPositive(draft.fatG) ||
    isPositive(draft.caloriesKcal);

  return (
    <article className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] shadow-[0_4px_16px_rgba(74,45,28,0.05)]">
      {/* Header — always visible */}
      <div
        className={`px-4 py-3 ${!isExpanded ? "cursor-pointer" : ""}`}
        onClick={!isExpanded ? () => setIsExpanded(true) : undefined}
        role={!isExpanded ? "button" : undefined}
        tabIndex={!isExpanded ? 0 : undefined}
        onKeyDown={
          !isExpanded
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") setIsExpanded(true);
              }
            : undefined
        }
      >
        {/* Row 1: name + (when expanded) action buttons */}
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--color-ink)]">
            {heading}
          </h3>

          {/* When expanded: buttons sit next to the name as before */}
          {isExpanded && (
            <>
              {onCopyToToday && isSaved && (
                <button
                  type="button"
                  disabled={busy || isCopied}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopyToToday(draft.clientId);
                  }}
                  className={`shrink-0 rounded-lg p-1 transition disabled:opacity-50 ${isCopied ? "text-[var(--color-accent)]" : "text-[var(--color-muted)] hover:text-[var(--color-accent)]"}`}
                  aria-label={isCopied ? `${heading} copied to today` : `Copy ${heading} to today`}
                  title={isCopied ? "Copied to today!" : "Copy to today"}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="12" height="10" rx="1.5" />
                    <line x1="2" y1="7" x2="14" y2="7" />
                    <line x1="5" y1="1" x2="5" y2="5" />
                    <line x1="11" y1="1" x2="11" y2="5" />
                    <line x1="8" y1="13" x2="8" y2="9" />
                    <polyline points="6,11 8,9 10,11" />
                  </svg>
                </button>
              )}

              <button
                type="button"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onDuplicate(draft.clientId);
                }}
                className="shrink-0 rounded-lg p-1 text-[var(--color-muted)] transition hover:text-[var(--color-ink)] disabled:opacity-50"
                aria-label={`Duplicate ${heading}`}
                title="Duplicate"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="5" width="8" height="8" rx="1.5" />
                  <path d="M3 11V4a1 1 0 0 1 1-1h7" />
                </svg>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsExpanded(false);
                }}
                className="shrink-0 rounded-lg p-1 text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
                aria-label="Collapse"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4,10 8,6 12,10" />
                </svg>
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(draft.clientId);
                }}
                className="shrink-0 rounded-lg p-1 text-[var(--color-muted)] transition hover:text-[var(--color-danger)] disabled:opacity-50"
                aria-label={`Delete ${heading}`}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <line x1="4" y1="4" x2="12" y2="12" />
                  <line x1="12" y1="4" x2="4" y2="12" />
                </svg>
              </button>
            </>
          )}
        </div>

        {/* Row 2 (collapsed only): macro chips + action buttons */}
        {!isExpanded && (
          <div className="mt-1.5 flex items-center gap-1">
            {/* Macro chips */}
            {hasValues && (
              <div className="flex flex-1 flex-wrap items-center gap-1">
                {isPositive(draft.proteinG) ? (
                  <span className="rounded-md bg-[color-mix(in_srgb,var(--color-bar-protein)_12%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-bar-protein)]">
                    P {draft.proteinG}g
                  </span>
                ) : null}
                {isPositive(draft.carbsG) ? (
                  <span className="rounded-md bg-[color-mix(in_srgb,var(--color-bar-carbs)_12%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-bar-carbs)]">
                    C {draft.carbsG}g
                  </span>
                ) : null}
                {isPositive(draft.fatG) ? (
                  <span className="rounded-md bg-[color-mix(in_srgb,var(--color-bar-fat)_12%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-bar-fat)]">
                    F {draft.fatG}g
                  </span>
                ) : null}
                {isPositive(draft.caloriesKcal) ? (
                  <span className="rounded-md bg-[var(--color-shell-panel)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-muted-strong)]">
                    {draft.caloriesKcal} kcal
                  </span>
                ) : null}
              </div>
            )}

            {/* Buttons pushed to the right */}
            <div className="ml-auto flex items-center gap-0.5">
              {onCopyToToday && isSaved && (
                <button
                  type="button"
                  disabled={busy || isCopied}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopyToToday(draft.clientId);
                  }}
                  className={`shrink-0 rounded-lg p-1 transition disabled:opacity-50 ${isCopied ? "text-[var(--color-accent)]" : "text-[var(--color-muted)] hover:text-[var(--color-accent)]"}`}
                  aria-label={isCopied ? `${heading} copied to today` : `Copy ${heading} to today`}
                  title={isCopied ? "Copied to today!" : "Copy to today"}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="12" height="10" rx="1.5" />
                    <line x1="2" y1="7" x2="14" y2="7" />
                    <line x1="5" y1="1" x2="5" y2="5" />
                    <line x1="11" y1="1" x2="11" y2="5" />
                    <line x1="8" y1="13" x2="8" y2="9" />
                    <polyline points="6,11 8,9 10,11" />
                  </svg>
                </button>
              )}

              <button
                type="button"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onDuplicate(draft.clientId);
                }}
                className="shrink-0 rounded-lg p-1 text-[var(--color-muted)] transition hover:text-[var(--color-ink)] disabled:opacity-50"
                aria-label={`Duplicate ${heading}`}
                title="Duplicate"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="5" width="8" height="8" rx="1.5" />
                  <path d="M3 11V4a1 1 0 0 1 1-1h7" />
                </svg>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsExpanded(true);
                }}
                className="shrink-0 rounded-lg p-1 text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
                aria-label="Expand"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4,6 8,10 12,6" />
                </svg>
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(draft.clientId);
                }}
                className="shrink-0 rounded-lg p-1 text-[var(--color-muted)] transition hover:text-[var(--color-danger)] disabled:opacity-50"
                aria-label={`Delete ${heading}`}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <line x1="4" y1="4" x2="12" y2="12" />
                  <line x1="12" y1="4" x2="4" y2="12" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Expanded body */}
      {isExpanded && (
        <div className="border-t border-[var(--color-border)] px-4 pb-4 pt-3">
          {/* Name input */}
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
              Name
            </span>
            <input
              type="text"
              value={draft.label}
              disabled={busy}
              onChange={(event) => onChange(draft.clientId, "label", event.target.value)}
              className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
              placeholder="Chicken breast, rice, banana..."
              autoFocus={!isSaved}
            />
          </label>

          {/* Macro inputs — 2×2 grid */}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <NumericInput
              label="Protein"
              value={draft.proteinG}
              busy={busy}
              step="0.1"
              unit="g"
              onChange={(value) => onChange(draft.clientId, "proteinG", value)}
            />
            <NumericInput
              label="Carbs"
              value={draft.carbsG}
              busy={busy}
              step="0.1"
              unit="g"
              onChange={(value) => onChange(draft.clientId, "carbsG", value)}
            />
            <NumericInput
              label="Fat"
              value={draft.fatG}
              busy={busy}
              step="0.1"
              unit="g"
              onChange={(value) => onChange(draft.clientId, "fatG", value)}
            />
            <NumericInput
              label="Calories"
              value={draft.caloriesKcal}
              busy={busy}
              step="1"
              unit="kcal"
              onChange={(value) => onChange(draft.clientId, "caloriesKcal", value)}
            />
          </div>

          {error ? (
            <p className="mt-3 text-sm text-[var(--color-danger)]">{error}</p>
          ) : null}

          {/* Save button */}
          <button
            type="button"
            disabled={busy}
            onClick={() => onSave(draft.clientId)}
            className="mt-3 w-full rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-sm font-semibold text-white transition-transform duration-150 hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-70"
          >
            {busy ? "Saving..." : isSaved ? "Update" : "Save"}
          </button>
        </div>
      )}
    </article>
  );
}

export type { MealDraft };
