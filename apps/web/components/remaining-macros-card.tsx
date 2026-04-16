"use client";

import type { MacroGoals } from "@macro-tracker/db";

import { formatMacroValue } from "@/lib/formatting";
import { hasAnyMacroGoals, type RemainingMacros } from "@/lib/quick-add";

import { TransitionLink } from "./transition-link";

type RemainingMacrosCardProps = {
  goals: MacroGoals;
  remaining: RemainingMacros;
  selectedDate: string;
};

function RemainingTile({
  label,
  unit,
  goal,
  value,
  status,
}: {
  label: string;
  unit: string;
  goal: number | null;
  value: number | null;
  status: "left" | "hit" | "over" | "unset";
}) {
  const toneClass =
    status === "over" ? "text-[var(--color-danger)]"
    : status === "hit" ? "text-[var(--color-accent)]"
    : "text-[var(--color-ink)]";
  const copy =
    status === "unset" || value == null ? "No goal"
    : status === "hit" ? "Hit"
    : `${formatMacroValue(Math.abs(value))}${unit} ${status}`;

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
          {label}
        </span>
        {goal != null ? (
          <span className="text-[11px] font-medium tabular-nums text-[var(--color-muted)]">
            Goal {formatMacroValue(goal)}
            {unit}
          </span>
        ) : null}
      </div>
      <div className={`mt-2 text-lg font-bold tabular-nums ${toneClass}`}>{copy}</div>
    </div>
  );
}

export function RemainingMacrosCard({
  goals,
  remaining,
  selectedDate,
}: RemainingMacrosCardProps) {
  if (!hasAnyMacroGoals(goals)) {
    return (
      <section className="rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Remaining Today
            </h2>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              Set calorie or macro targets to see what is left for the day.
            </p>
          </div>
          <TransitionLink
            href={`/goals?date=${selectedDate}`}
            className="shrink-0 rounded-full bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5"
          >
            Set goals
          </TransitionLink>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5 shadow-[0_12px_32px_rgba(0,0,0,0.05)]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
          Remaining Today
        </h2>
        <TransitionLink
          href={`/goals?date=${selectedDate}`}
          className="text-xs font-semibold text-[var(--color-accent)] transition hover:opacity-80"
        >
          Edit goals
        </TransitionLink>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <RemainingTile
          label="Calories"
          unit=" kcal"
          goal={remaining.caloriesKcal.goal}
          value={remaining.caloriesKcal.remaining}
          status={remaining.caloriesKcal.status}
        />
        <RemainingTile
          label="Protein"
          unit="g"
          goal={remaining.proteinG.goal}
          value={remaining.proteinG.remaining}
          status={remaining.proteinG.status}
        />
        <RemainingTile
          label="Carbs"
          unit="g"
          goal={remaining.carbsG.goal}
          value={remaining.carbsG.remaining}
          status={remaining.carbsG.status}
        />
        <RemainingTile
          label="Fat"
          unit="g"
          goal={remaining.fatG.goal}
          value={remaining.fatG.remaining}
          status={remaining.fatG.status}
        />
      </div>
    </section>
  );
}
