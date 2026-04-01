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
    <div className="flex items-baseline justify-between gap-4 text-sm text-[var(--color-ink)]">
      <span>{label}</span>
      <span className="font-semibold">
        {formatMacroValue(value)}
        {suffix}
      </span>
    </div>
  );
}

export function SummaryCard({ summary }: SummaryCardProps) {
  return (
    <section className="rounded-[1.75rem] border border-[var(--color-border)] bg-white/85 p-5 shadow-[0_18px_50px_rgba(74,45,28,0.08)]">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--color-muted)]">
        {LABELS[summary.label]}
      </p>
      <h3 className="mt-2 font-serif text-2xl text-[var(--color-ink)]">
        {summary.loggedDays} logged {summary.loggedDays === 1 ? "day" : "days"}
      </h3>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        {formatPeriodRange(summary.startDate, summary.endDate)}
      </p>
      <div className="mt-4 space-y-2">
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
