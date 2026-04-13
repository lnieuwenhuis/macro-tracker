"use client";

import type { MacroGoals } from "@macro-tracker/db";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { saveGoalsAction } from "@/lib/actions";
import {
  ACTIVITY_LEVEL_OPTIONS,
  GOAL_PRESET_OPTIONS,
  calculateMacroTargets,
  getWeeklyWeightChangeEstimateKg,
  type ActivityLevelId,
  type GoalPresetId,
  type MacroCalculatorSex,
} from "@/lib/macro-calculator";

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

function formatInputValue(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatSignedCalories(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value} kcal`;
}

function formatWeeklyChangeLabel(calorieAdjustmentKcal: number) {
  if (calorieAdjustmentKcal === 0) {
    return "roughly weight stable";
  }

  const estimateKg = getWeeklyWeightChangeEstimateKg(calorieAdjustmentKcal);
  const direction = calorieAdjustmentKcal < 0 ? "loss" : "gain";
  return `~${estimateKg} kg/week ${direction}`;
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

function CalculatorField({
  label,
  unit,
  value,
  step,
  busy,
  onChange,
}: {
  label: string;
  unit: string;
  value: string;
  step: string;
  busy: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-4">
      <span className="block text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
        {label}
      </span>
      <div className="relative mt-2">
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step={step}
          value={value}
          disabled={busy}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-3 pr-12 text-base font-semibold text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)] disabled:opacity-60"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-[var(--color-muted)]">
          {unit}
        </span>
      </div>
    </label>
  );
}

function ToggleButton({
  label,
  description,
  selected,
  busy,
  onClick,
}: {
  label: string;
  description: string;
  selected: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`rounded-2xl border px-4 py-3 text-left transition ${
        selected
          ? "border-[var(--color-accent)] bg-[var(--color-card-muted)]"
          : "border-[var(--color-border)] bg-[var(--color-card-subtle)] hover:border-[var(--color-border-strong)]"
      } disabled:opacity-60`}
    >
      <span className="block text-sm font-bold text-[var(--color-ink)]">{label}</span>
      <span className="mt-1 block text-xs text-[var(--color-muted)]">{description}</span>
    </button>
  );
}

function ResultTile({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-4">
      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
        {label}
      </span>
      <div className="mt-1.5 text-xl font-bold tabular-nums text-[var(--color-ink)]">
        {value}
      </div>
    </div>
  );
}

export function GoalsShell({ userEmail, selectedDate, goals }: GoalsShellProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const goalsAreSet =
    goals.caloriesKcal != null ||
    goals.proteinG != null ||
    goals.carbsG != null ||
    goals.fatG != null;
  const [calculatorOpen, setCalculatorOpen] = useState(!goalsAreSet);

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

  const [sex, setSex] = useState<MacroCalculatorSex>("male");
  const [age, setAge] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [activityLevel, setActivityLevel] = useState<ActivityLevelId>("moderate");
  const [goalPreset, setGoalPreset] = useState<GoalPresetId>("maintain");
  const [calculatorError, setCalculatorError] = useState<string | null>(null);

  const parsedAge = toNullableNumber(age);
  const parsedHeightCm = toNullableNumber(heightCm);
  const parsedWeightKg = toNullableNumber(weightKg);
  const selectedActivity = ACTIVITY_LEVEL_OPTIONS.find((option) => option.id === activityLevel);

  const calculatedTargets =
    parsedAge != null && parsedHeightCm != null && parsedWeightKg != null
      ? calculateMacroTargets({
          sex,
          age: parsedAge,
          heightCm: parsedHeightCm,
          weightKg: parsedWeightKg,
          activityLevel,
          goalPreset,
        })
      : null;

  function handleChange(setter: (v: string) => void) {
    return (v: string) => {
      setter(v);
      setSaved(false);
      setError(null);
    };
  }

  function handleCalculatorChange(setter: (v: string) => void) {
    return (v: string) => {
      setter(v);
      setCalculatorError(null);
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

  function handleApplyCalculatedTargets() {
    if (!calculatedTargets) {
      setCalculatorError("Enter your age, height, and weight to calculate targets.");
      return;
    }

    setCalories(String(calculatedTargets.macros.caloriesKcal));
    setProtein(formatInputValue(calculatedTargets.macros.proteinG));
    setCarbs(formatInputValue(calculatedTargets.macros.carbsG));
    setFat(formatInputValue(calculatedTargets.macros.fatG));
    setSaved(false);
    setError(null);
    setCalculatorError(null);
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
            Set your daily targets manually, or calculate them from your body
            stats and activity level first. The bar charts will scale to these
            values.
          </p>
        </div>

        <div className="rounded-[28px] border border-[var(--color-border-strong)] bg-[var(--color-surface-strong)] p-5">
          <button
            type="button"
            onClick={() => setCalculatorOpen((o) => !o)}
            className="flex w-full items-start justify-between gap-3 text-left"
          >
            <div>
              <h3 className="text-sm font-bold text-[var(--color-ink)]">
                Macro calculator
              </h3>
              <p className="mt-1.5 text-sm text-[var(--color-muted)]">
                Uses the Mifflin-St Jeor formula, activity multipliers, preset
                calorie adjustments, and weight-based protein targets before
                splitting the remaining calories into carbs and fat.
              </p>
            </div>
            <svg
              width="18"
              height="18"
              viewBox="0 0 18 18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`mt-0.5 shrink-0 text-[var(--color-muted)] transition-transform duration-200 ${calculatorOpen ? "rotate-180" : ""}`}
            >
              <path d="M4 6l5 5 5-5" />
            </svg>
          </button>

          {calculatorOpen && (
            <>
              <div className="mt-4 grid grid-cols-2 gap-3">
            <ToggleButton
              label="Male"
              description="Mifflin-St Jeor male formula"
              selected={sex === "male"}
              busy={isPending}
              onClick={() => {
                setSex("male");
                setCalculatorError(null);
              }}
            />
            <ToggleButton
              label="Female"
              description="Mifflin-St Jeor female formula"
              selected={sex === "female"}
              busy={isPending}
              onClick={() => {
                setSex("female");
                setCalculatorError(null);
              }}
            />
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <CalculatorField
              label="Age"
              unit="yrs"
              value={age}
              step="1"
              busy={isPending}
              onChange={handleCalculatorChange(setAge)}
            />
            <CalculatorField
              label="Height"
              unit="cm"
              value={heightCm}
              step="0.1"
              busy={isPending}
              onChange={handleCalculatorChange(setHeightCm)}
            />
            <CalculatorField
              label="Weight"
              unit="kg"
              value={weightKg}
              step="0.1"
              busy={isPending}
              onChange={handleCalculatorChange(setWeightKg)}
            />
          </div>

          <label className="mt-3 block rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-4">
            <span className="block text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
              Activity level
            </span>
            <select
              value={activityLevel}
              disabled={isPending}
              onChange={(e) => {
                setActivityLevel(e.target.value as ActivityLevelId);
                setCalculatorError(null);
              }}
              className="mt-2 w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-3 text-base font-semibold text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)] disabled:opacity-60"
            >
              {ACTIVITY_LEVEL_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              {selectedActivity?.description}
            </p>
          </label>

          <div className="mt-4">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--color-muted-strong)]">
                Goal preset
              </h4>
              <span className="text-[11px] text-[var(--color-muted)]">
                5 options
              </span>
            </div>
            <div className="mt-3 space-y-2.5">
              {GOAL_PRESET_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    setGoalPreset(option.id);
                    setCalculatorError(null);
                  }}
                  disabled={isPending}
                  className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                    goalPreset === option.id
                      ? "border-[var(--color-accent)] bg-[var(--color-card-muted)]"
                      : "border-[var(--color-border)] bg-[var(--color-card-subtle)] hover:border-[var(--color-border-strong)]"
                  } disabled:opacity-60`}
                >
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-bold text-[var(--color-ink)]">
                        {option.label}
                      </div>
                      <div className="mt-1 text-xs text-[var(--color-muted)]">
                        {option.description}
                      </div>
                      <div className="mt-1 text-[11px] font-semibold text-[var(--color-muted-strong)]">
                        {formatWeeklyChangeLabel(option.calorieAdjustmentKcal)}
                      </div>
                    </div>
                    <div className="shrink-0 text-xs font-bold text-[var(--color-muted-strong)]">
                      {formatSignedCalories(option.calorieAdjustmentKcal)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {calculatorError && (
            <p className="mt-4 text-sm text-[var(--color-danger)]">
              {calculatorError}
            </p>
          )}

          <div className="mt-4 rounded-[24px] border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-4">
            {calculatedTargets ? (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <ResultTile
                    label="BMR"
                    value={`${calculatedTargets.bmrKcal} kcal`}
                  />
                  <ResultTile
                    label="TDEE"
                    value={`${calculatedTargets.tdeeKcal} kcal`}
                  />
                  <ResultTile
                    label="Target"
                    value={`${calculatedTargets.targetCaloriesKcal} kcal`}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <GoalInput
                    label="Protein"
                    unit="g"
                    value={formatInputValue(calculatedTargets.macros.proteinG)}
                    color="var(--color-bar-protein)"
                    busy
                    onChange={() => undefined}
                  />
                  <GoalInput
                    label="Carbs"
                    unit="g"
                    value={formatInputValue(calculatedTargets.macros.carbsG)}
                    color="var(--color-bar-carbs)"
                    busy
                    onChange={() => undefined}
                  />
                  <GoalInput
                    label="Fat"
                    unit="g"
                    value={formatInputValue(calculatedTargets.macros.fatG)}
                    color="var(--color-bar-fat)"
                    busy
                    onChange={() => undefined}
                  />
                  <GoalInput
                    label="Calories"
                    unit="kcal"
                    value={String(calculatedTargets.macros.caloriesKcal)}
                    color="var(--color-bar-calories)"
                    busy
                    onChange={() => undefined}
                  />
                </div>

                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-[var(--color-muted)]">
                    Protein target: {formatInputValue(calculatedTargets.macros.proteinG)}g
                    {" "}({calculatedTargets.proteinTargetGPerKg} g/kg of{" "}
                    {formatInputValue(calculatedTargets.proteinReferenceWeightKg)} kg{" "}
                    {calculatedTargets.proteinReferenceType})
                  </p>
                  <button
                    type="button"
                    onClick={handleApplyCalculatedTargets}
                    disabled={isPending}
                    className="rounded-xl bg-[var(--color-accent)] px-4 py-3 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-70"
                  >
                    Apply to saved targets
                  </button>
                </div>
                <p className="text-xs text-[var(--color-muted)]">
                  Rough initial pace:{" "}
                  {formatWeeklyChangeLabel(
                    calculatedTargets.targetCaloriesKcal - calculatedTargets.tdeeKcal,
                  )}
                  . Real-world progress slows as maintenance calories adapt.
                </p>
              </div>
            ) : (
              <p className="text-sm text-[var(--color-muted)]">
                Enter your age, height, and weight to calculate daily calories
                and macros.
              </p>
            )}
          </div>
            </>
          )}
        </div>

        {/* Goal inputs */}
        <div className="space-y-3">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--color-muted-strong)]">
              Saved daily targets
            </h3>
            <p className="mt-1.5 text-sm text-[var(--color-muted)]">
              These values are used everywhere in the app. You can still tweak
              the calculated numbers before saving. Leave any field empty to
              fall back to the chart defaults.
            </p>
          </div>
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
