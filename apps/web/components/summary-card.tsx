import type { MacroGoals, PeriodAverage } from "@macro-tracker/db";

import { formatPeriodRange } from "@/lib/formatting";
import { MacroBarGroup } from "./macro-bar";

type SummaryCardProps = {
  summary: PeriodAverage;
  goals?: MacroGoals | null;
};

const LABELS: Record<PeriodAverage["label"], string> = {
  week: "ISO Week",
  month: "Calendar Month",
  rolling7: "Rolling 7 Days",
  rolling30: "Rolling 30 Days",
};

export function SummaryCard({ summary, goals }: SummaryCardProps) {
  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-4 shadow-[0_8px_24px_rgba(74,45,28,0.06)]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-[var(--color-ink)]">
            {LABELS[summary.label]}
          </h3>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            {formatPeriodRange(summary.startDate, summary.endDate)}
            {" \u00B7 "}
            {summary.loggedDays} {summary.loggedDays === 1 ? "day" : "days"}
          </p>
        </div>
        <span className="text-lg font-bold tabular-nums text-[var(--color-ink)]">
          {Math.round(summary.averages.caloriesKcal)}
          <span className="ml-0.5 text-[10px] font-semibold text-[var(--color-muted)]">kcal</span>
        </span>
      </div>

      <MacroBarGroup
        proteinG={summary.averages.proteinG}
        carbsG={summary.averages.carbsG}
        fatG={summary.averages.fatG}
        caloriesKcal={summary.averages.caloriesKcal}
        goals={goals}
      />
    </section>
  );
}
