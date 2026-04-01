"use client";

import type { MacroGoals } from "@macro-tracker/db";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { saveGoalsAction } from "@/lib/actions";

import { AppShell } from "./app-shell";

type GoalsShellProps = {
  userEmail: string;
  selectedDate: string;
  goals: MacroGoals;
};

function toNullableNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function GoalInput({
  label,
  unit,
  value,
  color,
  busy,
  onChange,
}: {
  label: string;
  unit: string;
  value: string;
  color: string;
  busy: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-4">
      <div className="flex items-center gap-2.5 mb-3">
        <div className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: color }} />
        <span className="text-sm font-bold text-[var(--color-ink)]">{label}</span>
      </div>
      <div className="relative">
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step={unit === "kcal" ? "1" : "0.1"}
          value={value}
          disabled={busy}
          placeholder="Not set"
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-3 pr-12 text-base font-semibold text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)] placeholder:font-normal disabled:opacity-60"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-[var(--color-muted)]">
          {unit}
        </span>
      </div>
    </div>
  );
}

export function GoalsShell({ userEmail, selectedDate, goals }: GoalsShellProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [calories, setCalories] = useState(
    goals.caloriesKcal != null ? String(goals.caloriesKcal) : "",
  );
  const [protein, setProtein] = useState(
    goals.proteinG != null ? String(goals.proteinG) : "",
  );
  const [carbs, setCarbs] = useState(
    goals.carbsG != null ? String(goals.carbsG) : "",
  );
  const [fat, setFat] = useState(
    goals.fatG != null ? String(goals.fatG) : "",
  );

  function handleChange(setter: (v: string) => void) {
    return (v: string) => {
      setter(v);
      setSaved(false);
      setError(null);
    };
  }

  function handleSave() {
    startTransition(async () => {
      const result = await saveGoalsAction({
        caloriesKcal: toNullableNumber(calories),
        proteinG: toNullableNumber(protein),
        carbsG: toNullableNumber(carbs),
        fatG: toNullableNumber(fat),
      });

      if (!result.ok) {
        setError(result.error ?? "Failed to save goals.");
        return;
      }

      setSaved(true);
      router.refresh();
    });
  }

  function handleClear() {
    setCalories("");
    setProtein("");
    setCarbs("");
    setFat("");
    setSaved(false);
    setError(null);
  }

  return (
    <AppShell userEmail={userEmail} selectedDate={selectedDate} activeTab="goals">
      <div className="space-y-5">
        {/* Header */}
        <div>
          <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
            Daily Goals
          </h2>
          <p className="mt-1.5 text-sm text-[var(--color-muted)]">
            Set your daily targets. The bar charts will scale to these values.
            Leave a field empty to use a visual default instead.
          </p>
        </div>

        {/* Goal inputs */}
        <div className="space-y-3">
          <GoalInput
            label="Calories"
            unit="kcal"
            value={calories}
            color="var(--color-bar-calories)"
            busy={isPending}
            onChange={handleChange(setCalories)}
          />
          <GoalInput
            label="Protein"
            unit="g"
            value={protein}
            color="var(--color-bar-protein)"
            busy={isPending}
            onChange={handleChange(setProtein)}
          />
          <GoalInput
            label="Carbs"
            unit="g"
            value={carbs}
            color="var(--color-bar-carbs)"
            busy={isPending}
            onChange={handleChange(setCarbs)}
          />
          <GoalInput
            label="Fat"
            unit="g"
            value={fat}
            color="var(--color-bar-fat)"
            busy={isPending}
            onChange={handleChange(setFat)}
          />
        </div>

        {error && (
          <p className="text-sm text-[var(--color-danger)]">{error}</p>
        )}

        {/* Action buttons */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={isPending}
            className="flex-1 rounded-xl bg-[var(--color-accent)] px-4 py-3 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-70"
          >
            {isPending ? "Saving…" : saved ? "Saved!" : "Save goals"}
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={isPending}
            className="rounded-xl border border-[var(--color-border-strong)] px-4 py-3 text-sm font-semibold text-[var(--color-muted-strong)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:opacity-50"
          >
            Clear all
          </button>
        </div>
      </div>
    </AppShell>
  );
}
