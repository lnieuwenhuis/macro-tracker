"use client";

type RecipeTotalsBarProps = {
  totalProteinG: number;
  totalCarbsG: number;
  totalFatG: number;
  totalCaloriesKcal: number;
  portions: number;
};

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

export function RecipeTotalsBar({
  totalProteinG,
  totalCarbsG,
  totalFatG,
  totalCaloriesKcal,
  portions,
}: RecipeTotalsBarProps) {
  const safeParts = Math.max(portions, 1);
  const perProtein = round1(totalProteinG / safeParts);
  const perCarbs = round1(totalCarbsG / safeParts);
  const perFat = round1(totalFatG / safeParts);
  const perCalories = Math.round(totalCaloriesKcal / safeParts);

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4 shadow-[0_12px_32px_rgba(0,0,0,0.06)]">
      {/* Total row */}
      <div className="mb-3">
        <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
          Total Recipe
        </h3>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[12px] font-semibold text-[var(--color-bar-protein)]">
            P {round1(totalProteinG)}g
          </span>
          <span className="text-[12px] font-semibold text-[var(--color-bar-carbs)]">
            C {round1(totalCarbsG)}g
          </span>
          <span className="text-[12px] font-semibold text-[var(--color-bar-fat)]">
            F {round1(totalFatG)}g
          </span>
          <span className="text-[12px] font-semibold text-[var(--color-muted-strong)]">
            {Math.round(totalCaloriesKcal)} kcal
          </span>
        </div>
      </div>

      {/* Per-portion row */}
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
