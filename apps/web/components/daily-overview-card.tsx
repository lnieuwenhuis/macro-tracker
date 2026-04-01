import type { DailyOverview, MacroGoals } from "@macro-tracker/db";

import { formatShortDate } from "@/lib/formatting";
import { MacroBarGroup } from "./macro-bar";

type DailyOverviewCardProps = {
  overview: DailyOverview;
  goals?: MacroGoals | null;
};

export function DailyOverviewCard({ overview, goals }: DailyOverviewCardProps) {
  return (
    <article className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-shell-panel)] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-[var(--color-ink)]">
            {formatShortDate(overview.date)}
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            {overview.itemCount} {overview.itemCount === 1 ? "item" : "items"}
          </p>
        </div>
        <span className="text-lg font-bold tabular-nums text-[var(--color-ink)]">
          {overview.totals.caloriesKcal}
          <span className="ml-0.5 text-[10px] font-semibold text-[var(--color-muted)]">kcal</span>
        </span>
      </div>

      <MacroBarGroup
        proteinG={overview.totals.proteinG}
        carbsG={overview.totals.carbsG}
        fatG={overview.totals.fatG}
        caloriesKcal={overview.totals.caloriesKcal}
        goals={goals}
      />
    </article>
  );
}
