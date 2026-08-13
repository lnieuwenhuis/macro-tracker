"use client";

import type {
  MacroGoals,
  WeightEntryRecord,
  WeightPageData,
  WeightUnit,
} from "@macro-tracker/db";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import {
  deleteWeightEntryAction,
  saveGoalsAction,
  saveWeightEntryAction,
  saveWeightGoalAction,
  updateWeightEntryAction,
} from "@/lib/actions";
import { formatShortDate } from "@/lib/formatting";
import { convertWeight } from "@/lib/onboarding-weight";
import type { ProgressTab } from "@/lib/progress-tab";
import { buildWeightGoalProjection } from "@/lib/weight-trend";

import { ConfirmDeleteButton } from "./confirm-delete-button";
import { AppShell, SettingsButton } from "./app-shell";
import {
  MacroCalculatorPanel,
  formatMacroInputValue,
  type MacroTargetDraft,
} from "./macro-calculator-panel";
import { NumberInputField } from "./number-input-field";

type ProgressShellProps = {
  userEmail: string;
  canAccessAdmin: boolean;
  selectedDate: string;
  goals: MacroGoals;
  weightData: WeightPageData;
  initialTab: ProgressTab;
  weightUnit: WeightUnit;
};

/**
 * Weights are stored in kg. The user's chosen unit was collected at onboarding
 * and then never used again, so someone who picked pounds saw kg everywhere.
 * Display and input both go through these two helpers.
 */
function toDisplayWeight(weightKg: number, unit: WeightUnit) {
  return convertWeight(weightKg, "kg", unit);
}

function formatWeight(weightKg: number | null | undefined, unit: WeightUnit) {
  if (weightKg == null) return "-";
  return `${toDisplayWeight(weightKg, unit)} ${unit}`;
}

function toNullableNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function GoalsPanel({
  goals,
  initialWeightKg,
}: {
  goals: MacroGoals;
  initialWeightKg: number | null;
}) {
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

  function update(setter: (value: string) => void) {
    return (value: string) => {
      setter(value);
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
        setError(result.error ?? "Unable to save goals.");
        return;
      }

      setSaved(true);
      router.refresh();
    });
  }

  function handleApplyCalculatedTargets(targets: MacroTargetDraft) {
    setCalories(String(targets.caloriesKcal));
    setProtein(formatMacroInputValue(targets.proteinG));
    setCarbs(formatMacroInputValue(targets.carbsG));
    setFat(formatMacroInputValue(targets.fatG));
    setSaved(false);
    setError(null);
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
    <div className="space-y-5">
      <section>
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
          Daily Goals
        </h2>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">
          Calculate or set the targets used across your log, progress bars, and summary.
        </p>
      </section>

      <MacroCalculatorPanel
        disabled={isPending}
        initialWeightKg={initialWeightKg}
        onApplyTargets={handleApplyCalculatedTargets}
      />

      <section>
        <h3 className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--color-muted-strong)]">
          Saved daily targets
        </h3>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">
          Adjust the calculated values before saving.
        </p>
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <NumberInputField label="Calories" unit="kcal" step="1" value={calories} disabled={isPending} variant="card" onChange={update(setCalories)} />
        <NumberInputField label="Protein" unit="g" step="0.1" value={protein} disabled={isPending} variant="card" onChange={update(setProtein)} />
        <NumberInputField label="Carbs" unit="g" step="0.1" value={carbs} disabled={isPending} variant="card" onChange={update(setCarbs)} />
        <NumberInputField label="Fat" unit="g" step="0.1" value={fat} disabled={isPending} variant="card" onChange={update(setFat)} />
      </div>

      {error ? <p className="text-sm text-[var(--color-danger)]">{error}</p> : null}

      <div className="flex gap-3">
        <button
          type="button"
          disabled={isPending}
          onClick={handleSave}
          className="flex-1 rounded-xl bg-[var(--color-accent)] px-4 py-3 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-70"
        >
          {isPending ? "Saving..." : saved ? "Saved!" : "Save goals"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={handleClear}
          className="rounded-xl border border-[var(--color-border-strong)] px-4 py-3 text-sm font-semibold text-[var(--color-muted-strong)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:opacity-50"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

function formatWeightChange(value: number | null, unit: WeightUnit) {
  if (value == null) return "-";
  // A delta converts linearly, so the same factor applies.
  const converted = toDisplayWeight(value, unit);
  return `${converted > 0 ? "+" : ""}${converted.toFixed(1)} ${unit}`;
}

function formatTrendLabel(value: WeightPageData["stats"]["trendDirection"]) {
  if (value === "up") return "Trending up";
  if (value === "down") return "Trending down";
  if (value === "stable") return "Stable";
  return "No trend yet";
}

const CHART_WIDTH = 320;
const CHART_HEIGHT = 128;
const CHART_PADDING_X = 18;
const CHART_PADDING_Y = 14;
const CHART_PLOT_WIDTH = CHART_WIDTH - CHART_PADDING_X * 2;
const CHART_PLOT_HEIGHT = CHART_HEIGHT - CHART_PADDING_Y * 2;

/** Mirrors the backend limit so a long note fails in the field, not with an
 * opaque server error. */
const WEIGHT_NOTES_MAX_LENGTH = 500;

/**
 * Project the weight history into chart space. Returns `null` when there is
 * not enough history to draw a trend.
 */
function buildWeightTrendGeometry(weightData: WeightPageData) {
  const entries = [...weightData.entries].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  if (entries.length < 2) {
    return null;
  }

  const minTime = new Date(entries[0]!.date).getTime();
  const maxTime = new Date(entries[entries.length - 1]!.date).getTime();

  // A single pass rather than `Math.min(...weights)`: spreading pushes one
  // argument per logged weight onto the stack, which a long history can grow
  // past the engine's argument limit.
  let minWeight = Number.POSITIVE_INFINITY;
  let maxWeight = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    if (entry.weightKg < minWeight) minWeight = entry.weightKg;
    if (entry.weightKg > maxWeight) maxWeight = entry.weightKg;
  }
  if (weightData.goalWeightKg != null) {
    minWeight = Math.min(minWeight, weightData.goalWeightKg);
    maxWeight = Math.max(maxWeight, weightData.goalWeightKg);
  }
  if (minWeight === maxWeight) {
    minWeight -= 0.5;
    maxWeight += 0.5;
  }

  const timeSpan = Math.max(1, maxTime - minTime);
  const weightSpan = Math.max(0.1, maxWeight - minWeight);

  // Each point is placed once; the polyline and the markers both read it back
  // instead of re-parsing every date a second time.
  const points = entries.map((entry) => ({
    id: entry.id,
    entry,
    x:
      CHART_PADDING_X +
      ((new Date(entry.date).getTime() - minTime) / timeSpan) * CHART_PLOT_WIDTH,
    y:
      CHART_PADDING_Y +
      ((maxWeight - entry.weightKg) / weightSpan) * CHART_PLOT_HEIGHT,
  }));

  return {
    points,
    polyline: points
      .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
      .join(" "),
    goalY:
      weightData.goalWeightKg != null
        ? CHART_PADDING_Y +
          ((maxWeight - weightData.goalWeightKg) / weightSpan) *
            CHART_PLOT_HEIGHT
        : null,
  };
}

function WeightTrendChart({
  weightData,
  unit,
}: {
  weightData: WeightPageData;
  unit: WeightUnit;
}) {
  const geometry = useMemo(
    () => buildWeightTrendGeometry(weightData),
    [weightData],
  );

  if (!geometry) {
    return (
      <div className="flex aspect-[2.7/1] items-center justify-center rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] text-sm text-[var(--color-muted)]">
        Log two entries to draw a trend.
      </div>
    );
  }

  const { points, polyline, goalY } = geometry;
  // A bare "Weight trend chart" label carries no data at all for a screen
  // reader; summarise the series instead.
  const first = points[0]?.entry;
  const last = points[points.length - 1]?.entry;
  const chartLabel = [
    `Weight trend over ${points.length} entries`,
    first && last
      ? `from ${formatWeight(first.weightKg, unit)} on ${formatShortDate(first.date)} to ${formatWeight(last.weightKg, unit)} on ${formatShortDate(last.date)}`
      : null,
    weightData.goalWeightKg != null
      ? `goal ${formatWeight(weightData.goalWeightKg, unit)}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <svg
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      role="img"
      aria-label={chartLabel}
      className="aspect-[2.7/1] w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)]"
    >
      {[0, 1, 2].map((line) => {
        const y = CHART_PADDING_Y + (CHART_PLOT_HEIGHT / 2) * line;
        return (
          <line
            key={line}
            x1={CHART_PADDING_X}
            y1={y}
            x2={CHART_WIDTH - CHART_PADDING_X}
            y2={y}
            stroke="var(--color-border)"
            strokeWidth="1"
          />
        );
      })}
      {goalY != null ? (
        <line
          x1={CHART_PADDING_X}
          y1={goalY}
          x2={CHART_WIDTH - CHART_PADDING_X}
          y2={goalY}
          stroke="var(--color-success)"
          strokeDasharray="4 4"
          strokeWidth="1.5"
        />
      ) : null}
      <polyline
        points={polyline}
        fill="none"
        stroke="var(--color-accent)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="3"
      />
      {points.map((point) => (
        <circle
          key={point.id}
          cx={point.x}
          cy={point.y}
          r="3"
          fill="var(--color-accent)"
        />
      ))}
    </svg>
  );
}

function WeightPanel({
  selectedDate,
  weightData,
  unit,
}: {
  selectedDate: string;
  weightData: WeightPageData;
  unit: WeightUnit;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [formDate, setFormDate] = useState(selectedDate);
  const [weightKg, setWeightKg] = useState("");
  const [bodyFatPct, setBodyFatPct] = useState("");
  const [notes, setNotes] = useState("");
  const [editingEntry, setEditingEntry] = useState<WeightEntryRecord | null>(null);
  // Held in the *display* unit; converted back to kg on save.
  const [goalWeightKg, setGoalWeightKg] = useState(
    weightData.goalWeightKg != null
      ? String(toDisplayWeight(weightData.goalWeightKg, unit))
      : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [goalSaved, setGoalSaved] = useState(false);

  useEffect(() => {
    setFormDate(selectedDate);
  }, [selectedDate]);

  function resetEntryForm() {
    setFormDate(selectedDate);
    setWeightKg("");
    setBodyFatPct("");
    setNotes("");
    setEditingEntry(null);
    setError(null);
  }

  function handleStartEdit(entry: WeightEntryRecord) {
    setFormDate(entry.date);
    setWeightKg(String(toDisplayWeight(entry.weightKg, unit)));
    setBodyFatPct(entry.bodyFatPct != null ? String(entry.bodyFatPct) : "");
    setNotes(entry.notes ?? "");
    setEditingEntry(entry);
    setError(null);

    if (typeof window !== "undefined") {
      requestAnimationFrame(() => {
        document
          .getElementById("weight-entry-form")
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  }

  function handleSaveEntry() {
    const parsedWeight = Number(weightKg);
    const parsedBodyFat = bodyFatPct.trim() ? Number(bodyFatPct) : null;

    if (!Number.isFinite(parsedWeight) || parsedWeight <= 0) {
      setError("Enter a valid weight.");
      return;
    }
    if (
      parsedBodyFat != null &&
      (!Number.isFinite(parsedBodyFat) || parsedBodyFat < 0 || parsedBodyFat > 100)
    ) {
      setError("Body fat must be between 0 and 100.");
      return;
    }

    setError(null);
    startTransition(async () => {
      const submittedDate = formDate;
      const weightInKg = convertWeight(parsedWeight, unit, "kg");
      const result = editingEntry
        ? await updateWeightEntryAction({
            id: editingEntry.id,
            date: submittedDate,
            weightKg: weightInKg,
            bodyFatPct: parsedBodyFat,
            notes: notes.trim() || null,
          })
        : await saveWeightEntryAction({
            date: submittedDate,
            weightKg: weightInKg,
            bodyFatPct: parsedBodyFat,
            notes: notes.trim() || null,
          });

      if (!result.ok) {
        setError(result.error ?? "Unable to save weight.");
        return;
      }

      resetEntryForm();
      router.refresh();
    });
  }

  function handleSaveGoal() {
    const parsedGoal = goalWeightKg.trim() ? Number(goalWeightKg) : null;
    if (parsedGoal != null && (!Number.isFinite(parsedGoal) || parsedGoal <= 0)) {
      setError("Enter a valid goal weight.");
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await saveWeightGoalAction({
        goalWeightKg: parsedGoal == null ? null : convertWeight(parsedGoal, unit, "kg"),
      });
      if (!result.ok) {
        setError(result.error ?? "Unable to save goal weight.");
        return;
      }
      setGoalSaved(true);
      router.refresh();
    });
  }

  function handleDeleteEntry(entryId: string) {
    startTransition(async () => {
      const result = await deleteWeightEntryAction({ id: entryId });
      if (!result.ok) {
        setError(result.error ?? "Unable to delete entry.");
        return;
      }
      if (editingEntry?.id === entryId) {
        resetEntryForm();
      }
      router.refresh();
    });
  }

  const { stats, entries } = weightData;
  const projection = buildWeightGoalProjection(weightData, selectedDate);
  const estimatedGoalLabel = projection.estimatedGoalDate
    ? formatShortDate(projection.estimatedGoalDate)
    : "-";

  return (
    <div className="space-y-5">
      <section>
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
          Log Weight
        </h2>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">
          Track body-weight changes against your goal.
        </p>
      </section>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-strong)]">Current</p>
          <p className="mt-1.5 text-2xl font-bold text-[var(--color-ink)]">
            {formatWeight(stats.currentWeight, unit)}
          </p>
        </div>
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-strong)]">7-day</p>
          <p className="mt-1.5 text-2xl font-bold text-[var(--color-ink)]">
            {formatWeightChange(stats.weekChange, unit)}
          </p>
        </div>
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-strong)]">30-day</p>
          <p className="mt-1.5 text-2xl font-bold text-[var(--color-ink)]">
            {formatWeightChange(stats.monthChange, unit)}
          </p>
        </div>
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-strong)]">Goal delta</p>
          <p className="mt-1.5 text-2xl font-bold text-[var(--color-ink)]">
            {formatWeightChange(projection.goalDeltaKg, unit)}
          </p>
        </div>
      </div>

      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
                  Trend
                </h3>
                <p className="mt-1 text-sm text-[var(--color-muted)]">
                  {formatTrendLabel(stats.trendDirection)}
                </p>
              </div>
              {weightData.goalWeightKg != null ? (
                <span className="rounded-full bg-[var(--color-success)]/10 px-3 py-1 text-xs font-semibold text-[var(--color-success)]">
                  Goal {formatWeight(weightData.goalWeightKg, unit)}
                </span>
              ) : null}
            </div>
            <WeightTrendChart weightData={weightData} unit={unit} />
          </div>
          <div className="grid gap-3 lg:w-64">
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] p-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-strong)]">
                Projection
              </p>
              <p className="mt-2 text-sm font-semibold text-[var(--color-ink)]">
                {projection.message}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-strong)]">
                  Rate
                </p>
                <p className="mt-2 text-sm font-bold text-[var(--color-ink)]">
                  {projection.weeklyRateKg != null
                    ? `${formatWeightChange(projection.weeklyRateKg, unit)}/wk`
                    : "-"}
                </p>
              </div>
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-strong)]">
                  ETA
                </p>
                <p className="mt-2 text-sm font-bold text-[var(--color-ink)]">
                  {estimatedGoalLabel}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        id="weight-entry-form"
        className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
            {editingEntry ? "Edit Entry" : "Entry"}
          </h3>
          {editingEntry ? (
            <button
              type="button"
              disabled={isPending}
              onClick={resetEntryForm}
              className="text-xs font-semibold text-[var(--color-muted)] transition hover:text-[var(--color-ink)] disabled:opacity-50"
            >
              Cancel edit
            </button>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            <span className="mb-1 block text-xs text-[var(--color-muted)]">Date</span>
            <input
              type="date"
              value={formDate}
              onChange={(event) => setFormDate(event.target.value)}
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs text-[var(--color-muted)]">Weight ({unit})</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={weightKg}
              onChange={(event) => setWeightKg(event.target.value)}
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs text-[var(--color-muted)]">Body fat %</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              value={bodyFatPct}
              onChange={(event) => setBodyFatPct(event.target.value)}
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs text-[var(--color-muted)]">Notes</span>
            <input
              type="text"
              value={notes}
              maxLength={WEIGHT_NOTES_MAX_LENGTH}
              onChange={(event) => setNotes(event.target.value)}
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
            />
          </label>
        </div>
        <button
          type="button"
          disabled={isPending}
          onClick={handleSaveEntry}
          className="mt-4 w-full rounded-xl bg-[var(--color-accent)] py-2.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:opacity-50"
        >
          {isPending ? "Saving..." : editingEntry ? "Update entry" : "Save entry"}
        </button>
      </section>

      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5">
        <h3 className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
          Goal Weight
        </h3>
        <div className="flex items-end gap-3">
          <label className="flex-1">
            <span className="mb-1 block text-xs text-[var(--color-muted)]">Target ({unit})</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              value={goalWeightKg}
              onChange={(event) => {
                setGoalWeightKg(event.target.value);
                setGoalSaved(false);
              }}
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
            />
          </label>
          <button
            type="button"
            disabled={isPending}
            onClick={handleSaveGoal}
            className="rounded-xl bg-[var(--color-accent)] px-5 py-2.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:opacity-50"
          >
            {goalSaved ? "Saved!" : "Save"}
          </button>
        </div>
      </section>

      {error ? <p className="text-sm text-[var(--color-danger)]">{error}</p> : null}

      <section>
        <h3 className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
          History
        </h3>
        {entries.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] px-5 py-8 text-center">
            <p className="text-sm text-[var(--color-muted)]">No weight entries yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {[...entries].reverse().map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-[var(--color-ink)]">
                    {formatWeight(entry.weightKg, unit)}
                    {entry.bodyFatPct != null ? (
                      <span className="ml-3 text-xs font-normal text-[var(--color-muted)]">
                        {entry.bodyFatPct}% bf
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                    {formatShortDate(entry.date)}
                    {entry.notes ? ` - ${entry.notes}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => handleStartEdit(entry)}
                    className={`flex h-11 w-11 items-center justify-center rounded-lg transition ${
                      editingEntry?.id === entry.id
                        ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                        : "text-[var(--color-muted)] hover:text-[var(--color-accent)]"
                    } disabled:opacity-50`}
                    aria-label={`Edit entry from ${formatShortDate(entry.date)}`}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9.5 2.5l2 2L4 12H2v-2L9.5 2.5z" />
                    </svg>
                  </button>
                  <ConfirmDeleteButton
                    disabled={isPending}
                    onConfirm={() => handleDeleteEntry(entry.id)}
                    ariaLabel="Delete entry"
                    className="flex h-11 w-11 items-center justify-center rounded-lg text-[var(--color-muted)] transition hover:text-[var(--color-danger)]"
                  >
                    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                      <line x1="3" y1="3" x2="12" y2="12" />
                      <line x1="12" y1="3" x2="3" y2="12" />
                    </svg>
                  </ConfirmDeleteButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function ProgressShell({
  userEmail,
  canAccessAdmin,
  selectedDate,
  goals,
  weightData,
  initialTab,
  weightUnit,
}: ProgressShellProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<ProgressTab>(initialTab);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  function handleTabChange(nextTab: ProgressTab) {
    setActiveTab(nextTab);
    router.replace(`/progress?date=${selectedDate}&tab=${nextTab}`, {
      scroll: false,
    });
  }

  return (
    <AppShell
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      title="Goals & Weight"
      activeTab="progress"
      topBar={({ openSettings }) => (
        <div className="mb-4 flex items-center gap-3">
          <section className="flex-1 rounded-[1.45rem] border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface-strong)_92%,transparent)] p-1 shadow-[0_16px_30px_rgba(0,0,0,0.12)] backdrop-blur-xl">
            <div
              role="tablist"
              aria-label="Progress views"
              className="grid h-12 grid-cols-2 gap-2"
            >
              {([
                { id: "goals", label: "Goals" },
                { id: "weight", label: "Weight" },
              ] as const).map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => handleTabChange(tab.id)}
                    className={[
                      "h-full rounded-[1.05rem] px-4 text-sm font-semibold transition",
                      isActive
                        ? "bg-[var(--color-accent)] text-white shadow-[0_10px_24px_rgba(0,0,0,0.14)]"
                        : "text-[var(--color-muted-strong)] hover:bg-[var(--color-card-muted)]",
                    ].join(" ")}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </section>
          <SettingsButton onClick={openSettings} />
        </div>
      )}
    >
      {activeTab === "goals" ? (
        <GoalsPanel
          goals={goals}
          initialWeightKg={weightData.stats.currentWeight}
        />
      ) : (
        <WeightPanel selectedDate={selectedDate} weightData={weightData} unit={weightUnit} />
      )}
    </AppShell>
  );
}
