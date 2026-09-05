"use client";

import { roundToSingleDecimal } from "@/lib/numbers";

type RecipeTotalsBarProps = {
  totalProteinG: number;
  totalCarbsG: number;
  totalFatG: number;
  totalCaloriesKcal: number;
  portions: number;
};

export function RecipeTotalsBar({
  totalProteinG,
  totalCarbsG,
  totalFatG,
  totalCaloriesKcal,
  portions,
}: RecipeTotalsBarProps) {
  const safeParts = Math.max(portions, 1);
  const perProtein = roundToSingleDecimal(totalProteinG / safeParts);
  const perCarbs = roundToSingleDecimal(totalCarbsG / safeParts);
  const perFat = roundToSingleDecimal(totalFatG / safeParts);
  const perCalories = Math.round(totalCaloriesKcal / safeParts);

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4 shadow-[0_12px_32px_rgba(0,0,0,0.06)]">
      <div className="mb-3">
        <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
          Total Recipe
        </h3>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[12px] font-semibold text-[var(--color-bar-protein)]">
            P {roundToSingleDecimal(totalProteinG)}g
          </span>
          <span className="text-[12px] font-semibold text-[var(--color-bar-carbs)]">
            C {roundToSingleDecimal(totalCarbsG)}g
          </span>
          <span className="text-[12px] font-semibold text-[var(--color-bar-fat)]">
            F {roundToSingleDecimal(totalFatG)}g
          </span>
          <span className="text-[12px] font-semibold text-[var(--color-muted-strong)]">
            {Math.round(totalCaloriesKcal)} kcal
          </span>
        </div>
      </div>

      <div className="border-t border-[var(--color-border)] pt-3">
        <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-accent)]">
          Per Portion ({safeParts} portion{safeParts !== 1 ? "s" : ""})
        </h3>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[12px] font-semibold text-[var(--color-bar-protein)]">
            P {perProtein}g
          </span>
          <span className="text-[12px] font-semibold text-[var(--color-bar-carbs)]">
            C {perCarbs}g
          </span>
          <span className="text-[12px] font-semibold text-[var(--color-bar-fat)]">
            F {perFat}g
          </span>
          <span className="text-sm font-bold tabular-nums text-[var(--color-ink)]">
            {perCalories}
            <span className="ml-0.5 text-xs font-semibold text-[var(--color-muted)]">kcal</span>
          </span>
        </div>
      </div>
    </div>
  );
}
