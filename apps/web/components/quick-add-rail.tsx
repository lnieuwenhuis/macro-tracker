"use client";

import type { QuickAddCandidate } from "@macro-tracker/db";

import { formatShortDate } from "@/lib/formatting";

type QuickAddRailProps = {
  title: string;
  items: QuickAddCandidate[];
  onSelect: (candidate: QuickAddCandidate) => void;
};

function formatSourceLabel(source: QuickAddCandidate["source"]) {
  return source === "preset" ? "Preset" : "Recent";
}

export function QuickAddRail({ title, items, onSelect }: QuickAddRailProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--color-muted-strong)]">
          {title}
        </h3>
        <span className="text-[11px] font-medium text-[var(--color-muted)]">
          One tap adds a draft
        </span>
      </div>

      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:-mx-0 sm:px-0">
        <div className="flex min-w-max gap-3 pb-1">
          {items.map((item) => (
            <button
              key={`${item.source}-${item.sourceId}`}
              type="button"
              onClick={() => onSelect(item)}
              className="w-56 shrink-0 rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-4 text-left shadow-[0_6px_20px_rgba(74,45,28,0.05)] transition hover:-translate-y-0.5 hover:border-[var(--color-border-strong)]"
              aria-label={`Add ${item.label}`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-semibold text-[var(--color-ink)]">
                  {item.label}
                </span>
                <span className="rounded-full bg-[var(--color-shell-panel)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-muted-strong)]">
                  {formatSourceLabel(item.source)}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] font-semibold">
                <span className="rounded-full bg-[color-mix(in_srgb,var(--color-bar-protein)_12%,transparent)] px-2 py-1 text-[var(--color-bar-protein)]">
                  P {item.proteinG}g
                </span>
                <span className="rounded-full bg-[color-mix(in_srgb,var(--color-bar-carbs)_12%,transparent)] px-2 py-1 text-[var(--color-bar-carbs)]">
                  C {item.carbsG}g
                </span>
                <span className="rounded-full bg-[color-mix(in_srgb,var(--color-bar-fat)_12%,transparent)] px-2 py-1 text-[var(--color-bar-fat)]">
                  F {item.fatG}g
                </span>
              </div>

              <div className="mt-3 flex items-center justify-between gap-2">
                <span className="text-sm font-bold tabular-nums text-[var(--color-ink)]">
                  {item.caloriesKcal} kcal
                </span>
                {item.sourceDate ? (
                  <span className="text-[11px] font-medium text-[var(--color-muted)]">
                    {formatShortDate(item.sourceDate)}
                  </span>
                ) : null}
              </div>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
