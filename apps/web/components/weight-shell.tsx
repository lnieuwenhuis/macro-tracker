"use client";

import type { WeightPageData, WeightEntryRecord } from "@macro-tracker/db";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import {
  deleteWeightEntryAction,
  saveWeightEntryAction,
  saveWeightGoalAction,
  updateWeightEntryAction,
} from "@/lib/actions";
import { formatShortDate } from "@/lib/formatting";

import { AppShell } from "./app-shell";
import { ConfirmDeleteButton } from "./confirm-delete-button";

type WeightShellProps = {
  userEmail: string;
  today: string;
  weightData: WeightPageData;
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4">
      <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-strong)]">
        {label}
      </span>
      <span className="mt-1.5 text-2xl font-bold tabular-nums text-[var(--color-ink)]">
        {value}
      </span>
      {sub && (
        <span className="mt-0.5 text-[11px] text-[var(--color-muted)]">
          {sub}
        </span>
      )}
    </div>
  );
}

function WeightTrendChart({
  entries,
  goalWeightKg,
}: {
  entries: WeightEntryRecord[];
  goalWeightKg: number | null;
}) {
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const last30 = entries.slice(-30);

  // Dismiss tooltip when clicking outside the chart container
  useEffect(() => {
    if (!selectedPointId) return;
    function handleOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setSelectedPointId(null);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [selectedPointId]);

  if (last30.length < 2) {
    return (
      <p className="py-6 text-center text-sm text-[var(--color-muted)]">
        {last30.length === 0
          ? "No data yet."
          : "Log at least 2 entries to see a trend."}
      </p>
    );
  }

  const weights = last30.map((e) => e.weightKg);
  const allValues = [...weights];
  if (goalWeightKg != null) allValues.push(goalWeightKg);

  const minW = Math.min(...allValues) - 0.5;
  const maxW = Math.max(...allValues) + 0.5;
  const range = maxW - minW || 1;

  const chartH = 100;
  const padX = 4;
  const padTop = 4;
  const totalW = 300;
  const usableW = totalW - padX * 2;
  const svgH = chartH + padTop + 4;

  const xStep = last30.length > 1 ? usableW / (last30.length - 1) : 0;

  const points = last30.map((entry, i) => {
    const x = padX + i * xStep;
    const y = padTop + chartH - ((entry.weightKg - minW) / range) * chartH;
    return { x, y, entry };
  });

  const polylinePoints = points.map((p) => `${p.x},${p.y}`).join(" ");

  // Filled area below the line
  const areaPoints = [
    `${points[0]!.x},${padTop + chartH}`,
    ...points.map((p) => `${p.x},${p.y}`),
    `${points[points.length - 1]!.x},${padTop + chartH}`,
  ].join(" ");

  const goalY =
    goalWeightKg != null
      ? padTop + chartH - ((goalWeightKg - minW) / range) * chartH
      : null;

  const selectedPoint = selectedPointId
    ? points.find((p) => p.entry.id === selectedPointId) ?? null
    : null;

  return (
    <div>
      {/* Chart — relative so the HTML tooltip overlay can be positioned inside */}
      <div ref={containerRef} className="relative overflow-x-auto">
        <svg
          width="100%"
          height={svgH}
          viewBox={`0 0 ${totalW} ${svgH}`}
          preserveAspectRatio="none"
          className="block w-full"
          style={{ minWidth: totalW }}
        >
          {/* Filled area */}
          <polygon
            points={areaPoints}
            fill="var(--color-accent)"
            opacity="0.12"
          />

          {/* Goal line */}
          {goalY != null && (
            <line
              x1={0}
              y1={goalY}
              x2={totalW}
              y2={goalY}
              stroke="var(--color-accent)"
              strokeWidth="1.5"
              strokeDasharray="4 3"
              opacity="0.7"
            />
          )}

          {/* Line */}
          <polyline
            points={polylinePoints}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Visual dots */}
          {points.map((p) => (
            <circle
              key={p.entry.id}
              cx={p.x}
              cy={p.y}
              r="3"
              fill="var(--color-accent)"
            />
          ))}

          {/* Highlight ring around selected dot */}
          {selectedPoint && (
            <circle
              cx={selectedPoint.x}
              cy={selectedPoint.y}
              r="6"
              fill="var(--color-accent)"
              opacity="0.3"
            />
          )}

          {/* Invisible larger hit-targets for tap/click */}
          {points.map((p) => (
            <circle
              key={`hit-${p.entry.id}`}
              cx={p.x}
              cy={p.y}
              r="10"
              fill="transparent"
              style={{ cursor: "pointer" }}
              onClick={() =>
                setSelectedPointId((prev) =>
                  prev === p.entry.id ? null : p.entry.id,
                )
              }
            />
          ))}
        </svg>

        {/* HTML tooltip — positioned via percentage x (maps correctly through
            preserveAspectRatio="none" x-stretch) and pixel y (no y-stretch
            because SVG height attribute matches viewBox height). */}
        {selectedPoint && (
          <div
            className="pointer-events-none absolute z-10"
            style={{
              left: `${(selectedPoint.x / totalW) * 100}%`,
              top: `${selectedPoint.y}px`,
              transform: "translate(-50%, calc(-100% - 10px))",
            }}
          >
            <div className="whitespace-nowrap rounded-lg bg-[var(--color-ink)] px-2.5 py-1.5 text-center shadow-lg">
              <p className="text-xs font-bold text-white">
                {selectedPoint.entry.weightKg} kg
              </p>
              <p className="text-[10px] text-white/70">
                {formatShortDate(selectedPoint.entry.date)}
              </p>
            </div>
            {/* Caret arrow */}
            <div
              className="mx-auto h-0 w-0"
              style={{
                borderLeft: "5px solid transparent",
                borderRight: "5px solid transparent",
                borderTop: "5px solid var(--color-ink)",
              }}
            />
          </div>
        )}
      </div>

      <div className="mt-1 flex justify-between text-[10px] text-[var(--color-muted)]">
        <span>{last30[0] ? formatShortDate(last30[0].date) : ""}</span>
        <span>
          {last30[last30.length - 1]
            ? formatShortDate(last30[last30.length - 1].date)
            : ""}
        </span>
      </div>
    </div>
  );
}

function formatChange(value: number | null): string {
  if (value == null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)} kg`;
}

function trendLabel(
  direction: WeightPageData["stats"]["trendDirection"],
): string {
  switch (direction) {
    case "up":
      return "Trending up";
    case "down":
      return "Trending down";
    case "stable":
      return "Stable";
    default:
      return "Not enough data";
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function WeightShell({
  userEmail,
  today,
  weightData,
}: WeightShellProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Form state
  const [formDate, setFormDate] = useState(today);
  const [formWeight, setFormWeight] = useState("");
  const [formBodyFat, setFormBodyFat] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // Goal state
  const [goalInput, setGoalInput] = useState(
    weightData.goalWeightKg != null ? String(weightData.goalWeightKg) : "",
  );
  const [goalSaved, setGoalSaved] = useState(false);

  // Delete state
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Edit state — when set, the entry form is in update mode and targets
  // the given entry id instead of inserting a new row.
  const [editingId, setEditingId] = useState<string | null>(null);

  const { entries, stats } = weightData;

  function resetForm() {
    setFormDate(today);
    setFormWeight("");
    setFormBodyFat("");
    setFormNotes("");
    setEditingId(null);
    setFormError(null);
  }

  function handleStartEdit(entry: WeightEntryRecord) {
    setFormDate(entry.date);
    setFormWeight(String(entry.weightKg));
    setFormBodyFat(entry.bodyFatPct != null ? String(entry.bodyFatPct) : "");
    setFormNotes(entry.notes ?? "");
    setEditingId(entry.id);
    setFormError(null);

    // Scroll the form into view so the user can see the fields populate.
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => {
        const el = document.getElementById("weight-entry-form");
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  }

  function handleCancelEdit() {
    resetForm();
  }

  function handleSaveEntry() {
    setFormError(null);

    const weightKg = Number(formWeight);
    if (!formWeight.trim() || !Number.isFinite(weightKg) || weightKg <= 0) {
      setFormError("Please enter a valid weight.");
      return;
    }

    const bodyFatPct = formBodyFat.trim()
      ? Number(formBodyFat)
      : null;

    if (bodyFatPct != null && (!Number.isFinite(bodyFatPct) || bodyFatPct < 0 || bodyFatPct > 100)) {
      setFormError("Body fat must be between 0 and 100.");
      return;
    }

    startTransition(async () => {
      const result = editingId
        ? await updateWeightEntryAction({
            id: editingId,
            date: formDate,
            weightKg,
            bodyFatPct,
            notes: formNotes.trim() || null,
          })
        : await saveWeightEntryAction({
            date: formDate,
            weightKg,
            bodyFatPct,
            notes: formNotes.trim() || null,
          });

      if (!result.ok) {
        setFormError(result.error ?? "Unable to save entry.");
        return;
      }

      resetForm();
      router.refresh();
    });
  }

  function handleDeleteEntry(entryId: string) {
    setDeletingId(entryId);
    startTransition(async () => {
      const result = await deleteWeightEntryAction({ id: entryId });
      if (!result.ok) {
        setFormError(result.error ?? "Unable to delete entry.");
      }
      setDeletingId(null);
      // If we were editing this entry, clear edit state.
      if (editingId === entryId) {
        resetForm();
      }
      router.refresh();
    });
  }

  function handleSaveGoal() {
    const value = goalInput.trim() ? Number(goalInput) : null;

    if (value != null && (!Number.isFinite(value) || value <= 0)) {
      return;
    }

    startTransition(async () => {
      const result = await saveWeightGoalAction({
        goalWeightKg: value,
      });
      if (result.ok) {
        setGoalSaved(true);
        setTimeout(() => setGoalSaved(false), 2000);
      }
      router.refresh();
    });
  }

  // Empty state
  if (entries.length === 0) {
    return (
      <AppShell userEmail={userEmail} selectedDate={today} activeTab="weight">
        <div className="space-y-5">
          {/* Entry form always visible */}
          <EntryForm
            formDate={formDate}
            formWeight={formWeight}
            formBodyFat={formBodyFat}
            formNotes={formNotes}
            formError={formError}
            isPending={isPending}
            isEditing={editingId !== null}
            onDateChange={setFormDate}
            onWeightChange={setFormWeight}
            onBodyFatChange={setFormBodyFat}
            onNotesChange={setFormNotes}
            onSave={handleSaveEntry}
            onCancelEdit={handleCancelEdit}
          />

          <section className="flex min-h-[40vh] items-center justify-center">
            <div className="w-full rounded-[2rem] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-strong)] px-6 py-10 text-center shadow-[0_18px_44px_rgba(0,0,0,0.06)]">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-card-muted)] text-[var(--color-accent)]">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 28 28"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 4v20" />
                  <path d="M8 6h12" />
                  <path d="M6 12h6v6H6z" />
                  <path d="M16 12h6v6h-6z" />
                  <path d="M8 22h12" />
                </svg>
              </div>
              <h2 className="mt-5 text-xl font-bold text-[var(--color-ink)]">
                No weight entries yet
              </h2>
              <p className="mt-2 text-sm text-[var(--color-muted)]">
                Log your first weight entry above to start tracking!
              </p>
            </div>
          </section>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell userEmail={userEmail} selectedDate={today} activeTab="weight">
      <div className="space-y-5">
        {/* Stat cards */}
        <section>
          <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
            Overview
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              label="Current"
              value={
                stats.currentWeight != null
                  ? `${stats.currentWeight} kg`
                  : "—"
              }
              sub={trendLabel(stats.trendDirection)}
            />
            <StatCard
              label="Goal"
              value={
                weightData.goalWeightKg != null
                  ? `${weightData.goalWeightKg} kg`
                  : "—"
              }
              sub={
                weightData.goalWeightKg != null && stats.currentWeight != null
                  ? `${formatChange(stats.currentWeight - weightData.goalWeightKg)} to go`
                  : "Not set"
              }
            />
            <StatCard
              label="7-Day Change"
              value={formatChange(stats.weekChange)}
              sub="vs 7 days ago"
            />
            <StatCard
              label="30-Day Change"
              value={formatChange(stats.monthChange)}
              sub="vs 30 days ago"
            />
          </div>
        </section>

        {/* Weight trend chart */}
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5">
          <div className="mb-4">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Weight Trend
            </h2>
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">
              Last 30 entries
            </p>
          </div>
          <WeightTrendChart
            entries={entries}
            goalWeightKg={weightData.goalWeightKg}
          />
        </section>

        {/* Log entry form */}
        <EntryForm
          formDate={formDate}
          formWeight={formWeight}
          formBodyFat={formBodyFat}
          formNotes={formNotes}
          formError={formError}
          isPending={isPending}
          isEditing={editingId !== null}
          onDateChange={setFormDate}
          onWeightChange={setFormWeight}
          onBodyFatChange={setFormBodyFat}
          onNotesChange={setFormNotes}
          onSave={handleSaveEntry}
          onCancelEdit={handleCancelEdit}
        />

        {/* Goal weight */}
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5">
          <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
            Goal Weight
          </h2>
          <div className="flex items-end gap-3">
            <label className="flex-1">
              <span className="mb-1 block text-xs text-[var(--color-muted)]">
                Target (kg)
              </span>
              <input
                type="number"
                inputMode="decimal"
                step="0.1"
                value={goalInput}
                onChange={(e) => {
                  setGoalInput(e.target.value);
                  setGoalSaved(false);
                }}
                placeholder="e.g. 75"
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

        {/* History */}
        <section>
          <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
            History
          </h2>
          <div className="space-y-2">
            {[...entries].reverse().map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-3">
                    <span className="text-sm font-semibold text-[var(--color-ink)]">
                      {entry.weightKg} kg
                    </span>
                    {entry.bodyFatPct != null && (
                      <span className="text-xs text-[var(--color-muted)]">
                        {entry.bodyFatPct}% bf
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-[var(--color-muted)]">
                    {formatShortDate(entry.date)}
                    {entry.notes ? ` — ${entry.notes}` : ""}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => handleStartEdit(entry)}
                  className={`ml-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition ${
                    editingId === entry.id
                      ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                      : "text-[var(--color-muted)] hover:text-[var(--color-accent)]"
                  }`}
                  aria-label={`Edit entry from ${formatShortDate(entry.date)}`}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9.5 2.5l2 2L4 12H2v-2L9.5 2.5z" />
                  </svg>
                </button>
                <ConfirmDeleteButton
                  disabled={isPending && deletingId === entry.id}
                  onConfirm={() => handleDeleteEntry(entry.id)}
                  ariaLabel="Delete entry"
                  className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-muted)] transition hover:text-[var(--color-danger)]"
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 15 15"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  >
                    <line x1="3" y1="3" x2="12" y2="12" />
                    <line x1="12" y1="3" x2="3" y2="12" />
                  </svg>
                </ConfirmDeleteButton>
              </div>
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Entry form (extracted to avoid duplication)
// ---------------------------------------------------------------------------

function EntryForm({
  formDate,
  formWeight,
  formBodyFat,
  formNotes,
  formError,
  isPending,
  isEditing,
  onDateChange,
  onWeightChange,
  onBodyFatChange,
  onNotesChange,
  onSave,
  onCancelEdit,
}: {
  formDate: string;
  formWeight: string;
  formBodyFat: string;
  formNotes: string;
  formError: string | null;
  isPending: boolean;
  isEditing: boolean;
  onDateChange: (v: string) => void;
  onWeightChange: (v: string) => void;
  onBodyFatChange: (v: string) => void;
  onNotesChange: (v: string) => void;
  onSave: () => void;
  onCancelEdit: () => void;
}) {
  return (
    <section
      id="weight-entry-form"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
          {isEditing ? "Edit Entry" : "Log Weight"}
        </h2>
        {isEditing ? (
          <button
            type="button"
            onClick={onCancelEdit}
            className="text-xs font-semibold text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
          >
            Cancel edit
          </button>
        ) : null}
      </div>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className="mb-1 block text-xs text-[var(--color-muted)]">
              Date
            </span>
            <input
              type="date"
              value={formDate}
              onChange={(e) => onDateChange(e.target.value)}
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs text-[var(--color-muted)]">
              Weight (kg)
            </span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={formWeight}
              onChange={(e) => onWeightChange(e.target.value)}
              placeholder="82.5"
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className="mb-1 block text-xs text-[var(--color-muted)]">
              Body fat % (optional)
            </span>
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              value={formBodyFat}
              onChange={(e) => onBodyFatChange(e.target.value)}
              placeholder="18.5"
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs text-[var(--color-muted)]">
              Notes (optional)
            </span>
            <input
              type="text"
              value={formNotes}
              onChange={(e) => onNotesChange(e.target.value)}
              placeholder="After workout"
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
            />
          </label>
        </div>

        {formError && (
          <p className="text-xs font-medium text-[var(--color-danger)]">
            {formError}
          </p>
        )}

        <button
          type="button"
          disabled={isPending}
          onClick={onSave}
          className="w-full rounded-xl bg-[var(--color-accent)] py-2.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:opacity-50"
        >
          {isPending ? "Saving..." : isEditing ? "Update Entry" : "Save Entry"}
        </button>
      </div>
    </section>
  );
}
