import type { DailyOverview } from "@macro-tracker/db";

import { formatMacroValue, formatShortDate } from "@/lib/formatting";

type DailyOverviewCardProps = {
  overview: DailyOverview;
};

export function DailyOverviewCard({ overview }: DailyOverviewCardProps) {
  return (
    <article className="rounded-[1.35rem] border border-[var(--color-border)] bg-[var(--color-shell-panel)] p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-strong)]">
            {formatShortDate(overview.date)}
          </p>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            {overview.itemCount} {overview.itemCount === 1 ? "food item" : "food items"}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
            Calories
          </p>
          <p className="mt-1 text-2xl font-semibold text-[var(--color-ink)]">
            {overview.totals.caloriesKcal}
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <div className="rounded-2xl bg-[var(--color-app-bg)] px-3 py-3">
          <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
            Protein
          </p>
          <p className="mt-1 text-lg font-semibold text-[var(--color-ink)]">
            {formatMacroValue(overview.totals.proteinG)}g
          </p>
        </div>
        <div className="rounded-2xl bg-[var(--color-app-bg)] px-3 py-3">
          <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
            Carbs
          </p>
          <p className="mt-1 text-lg font-semibold text-[var(--color-ink)]">
            {formatMacroValue(overview.totals.carbsG)}g
          </p>
        </div>
        <div className="rounded-2xl bg-[var(--color-app-bg)] px-3 py-3">
          <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
            Fat
          </p>
          <p className="mt-1 text-lg font-semibold text-[var(--color-ink)]">
            {formatMacroValue(overview.totals.fatG)}g
          </p>
        </div>
      </div>
    </article>
  );
}
