import type { MacroGoals } from "@macro-tracker/db";

import { formatMacroValue } from "@/lib/formatting";

type MacroBarProps = {
  label: string;
  value: number;
  unit: string;
  color: string;
  goal: number | null;
  /** Fallback visual maximum when no goal is set. */
  fallbackMax: number;
};

export function MacroBar({ label, value, unit, color, goal, fallbackMax }: MacroBarProps) {
  const max = goal ?? fallbackMax;
  const percentage = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const hasGoal = goal !== null && goal > 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-[var(--color-ink)]">{label}</span>
        <span className="text-sm tabular-nums text-[var(--color-muted-strong)]">
          {formatMacroValue(value)}
          {hasGoal ? (
            <span className="text-[var(--color-muted)]">
              {" / "}
              {formatMacroValue(goal!)}
            </span>
          ) : null}
          {unit}
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--color-card-muted)]">
        <div
          className="h-full rounded-full transition-all duration-500 ease-out"
          style={{ width: `${percentage}%`, backgroundColor: color }}
        />
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

type MacroBarGroupProps = {
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
  goals?: MacroGoals | null;
};

export function MacroBarGroup({
  proteinG,
  carbsG,
  fatG,
  caloriesKcal,
  goals,
}: MacroBarGroupProps) {
  return (
    <div className="space-y-4">
      <MacroBar
        label="Calories"
        value={caloriesKcal}
        unit=" kcal"
        color={MACRO_COLORS.calories}
        goal={goals?.caloriesKcal ?? null}
        fallbackMax={VISUAL_MAX.calories}
      />
      <MacroBar
        label="Protein"
        value={proteinG}
        unit="g"
        color={MACRO_COLORS.protein}
        goal={goals?.proteinG ?? null}
        fallbackMax={VISUAL_MAX.protein}
      />
      <MacroBar
        label="Carbs"
        value={carbsG}
        unit="g"
        color={MACRO_COLORS.carbs}
        goal={goals?.carbsG ?? null}
        fallbackMax={VISUAL_MAX.carbs}
      />
      <MacroBar
        label="Fat"
        value={fatG}
        unit="g"
        color={MACRO_COLORS.fat}
        goal={goals?.fatG ?? null}
        fallbackMax={VISUAL_MAX.fat}
      />
    </div>
  );
}
