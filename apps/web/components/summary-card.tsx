import type { PeriodAverage } from "@macro-tracker/db";

import { formatMacroValue, formatPeriodRange } from "@/lib/formatting";

type SummaryCardProps = {
  summary: PeriodAverage;
};

const LABELS: Record<PeriodAverage["label"], string> = {
  week: "ISO week",
  month: "Calendar month",
  rolling7: "Rolling 7 days",
  rolling30: "Rolling 30 days",
};

function MacroLine({
  label,
  value,
  suffix,
}: {
  label: string;
  value: number;
  suffix: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-muted)] px-4 py-3">
      <span className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
        {label}
      </span>
      <span className="mt-1 block text-lg font-semibold text-[var(--color-ink)]">
        {formatMacroValue(value)}
        {suffix}
      </span>
    </div>
  );
}

export function SummaryCard({ summary }: SummaryCardProps) {
  return (
    <section className="rounded-[1.5rem] border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-4 shadow-[0_18px_50px_rgba(74,45,28,0.08)] sm:p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--color-muted-strong)]">
        {LABELS[summary.label]}
      </p>
      <h3 className="mt-2 font-serif text-[1.7rem] leading-tight text-[var(--color-ink)]">
        {summary.loggedDays} logged {summary.loggedDays === 1 ? "day" : "days"}
      </h3>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        {formatPeriodRange(summary.startDate, summary.endDate)}
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <MacroLine label="Protein" value={summary.averages.proteinG} suffix="g" />
        <MacroLine label="Carbs" value={summary.averages.carbsG} suffix="g" />
        <MacroLine label="Fat" value={summary.averages.fatG} suffix="g" />
        <MacroLine
          label="Calories"
          value={summary.averages.caloriesKcal}
          suffix=" kcal"
        />
      </div>
    </section>
  );
}
