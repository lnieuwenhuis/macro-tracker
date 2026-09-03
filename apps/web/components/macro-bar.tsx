import type { MacroGoals, MacroNumbers } from "@macro-tracker/db";

import { formatMacroValue } from "@/lib/formatting";

type MacroBarProps = {
  label: string;
  value: number;
  plannedValue?: number;
  unit: string;
  color: string;
  goal: number | null;
  /** Fallback visual maximum when no goal is set. */
  fallbackMax: number;
};

function MacroBar({
  label,
  value,
  plannedValue = 0,
  unit,
  color,
  goal,
  fallbackMax,
}: MacroBarProps) {
  const max = goal ?? fallbackMax;
  const percentage = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const projectedValue = value + plannedValue;
  const projectedPercentage =
    max > 0 ? Math.min((projectedValue / max) * 100, 100) : 0;
  const hasGoal = goal !== null && goal > 0;
  const hasPlannedValue = plannedValue > 0;
  const testIdPrefix = label.toLowerCase().replace(/\s+/g, "-");

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-[var(--color-ink)]">{label}</span>
        <span className="flex flex-col items-end tabular-nums">
          <span className="text-sm text-[var(--color-muted-strong)]">
            {formatMacroValue(value)}
            {hasGoal ? (
              <span className="text-[var(--color-muted)]">
                {" / "}
                {formatMacroValue(goal!)}
              </span>
            ) : null}
            {unit}
          </span>
          {hasPlannedValue ? (
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted)]">
              Projected {formatMacroValue(projectedValue)}
              {unit}
            </span>
          ) : null}
        </span>
      </div>
      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-[var(--color-card-muted)]">
        {hasPlannedValue ? (
          <div
            data-testid={`macro-bar-${testIdPrefix}-planned-fill`}
            className="absolute inset-y-0 left-0 rounded-full transition-all duration-500 ease-out"
            style={{
              width: `${projectedPercentage}%`,
              backgroundColor: color,
              opacity: 0.28,
            }}
          />
        ) : null}
        {value > 0 ? (
          <div
            data-testid={`macro-bar-${testIdPrefix}-eaten-fill`}
            className="absolute inset-y-0 left-0 rounded-full transition-all duration-500 ease-out"
            style={{ width: `${percentage}%`, backgroundColor: color }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Fallback visual ceilings when no goal is configured. */
const VISUAL_MAX = {
  calories: 2500,
  protein: 200,
  carbs: 350,
  fat: 120,
};

const MACRO_COLORS = {
  calories: "var(--color-bar-calories)",
  protein: "var(--color-bar-protein)",
  carbs: "var(--color-bar-carbs)",
  fat: "var(--color-bar-fat)",
};

const MACRO_BAR_CONFIG = [
  { field: "caloriesKcal" as const, label: "Calories", unit: " kcal", color: MACRO_COLORS.calories, fallbackMax: VISUAL_MAX.calories },
  { field: "proteinG" as const, label: "Protein", unit: "g", color: MACRO_COLORS.protein, fallbackMax: VISUAL_MAX.protein },
  { field: "carbsG" as const, label: "Carbs", unit: "g", color: MACRO_COLORS.carbs, fallbackMax: VISUAL_MAX.carbs },
  { field: "fatG" as const, label: "Fat", unit: "g", color: MACRO_COLORS.fat, fallbackMax: VISUAL_MAX.fat },
];

type MacroBarGroupProps = {
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
  plannedTotals?: MacroNumbers | null;
  goals?: MacroGoals | null;
};

export function MacroBarGroup({
  proteinG,
  carbsG,
  fatG,
  caloriesKcal,
  plannedTotals,
  goals,
}: MacroBarGroupProps) {
  const values = { caloriesKcal, proteinG, carbsG, fatG };
  return (
    <div className="space-y-4">
      {MACRO_BAR_CONFIG.map(({ field, label, unit, color, fallbackMax }) => (
        <MacroBar
          key={field}
          label={label}
          value={values[field]}
          plannedValue={plannedTotals?.[field] ?? 0}
          unit={unit}
          color={color}
          goal={goals?.[field] ?? null}
          fallbackMax={fallbackMax}
        />
      ))}
    </div>
  );
}
