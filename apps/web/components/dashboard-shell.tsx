"use client";

import type { DailySummary, MealEntryRecord } from "@macro-tracker/db";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { deleteMealEntryAction, saveMealEntryAction } from "@/lib/actions";
import { formatMacroValue } from "@/lib/formatting";

import { AppShell } from "./app-shell";
import { MealCard, type MealDraft } from "./meal-card";

type DashboardShellProps = {
  userEmail: string;
  selectedDate: string;
  dailySummary: DailySummary;
};

type ErrorState = Record<string, string | null>;

function mealToDraft(meal: MealEntryRecord): MealDraft {
  return {
    clientId: meal.id,
    id: meal.id,
    label: meal.label,
    proteinG: meal.proteinG ? String(meal.proteinG) : "",
    carbsG: meal.carbsG ? String(meal.carbsG) : "",
    fatG: meal.fatG ? String(meal.fatG) : "",
    caloriesKcal: meal.caloriesKcal ? String(meal.caloriesKcal) : "",
    sortOrder: meal.sortOrder,
  };
}

function createEmptyDraft(sortOrder: number): MealDraft {
  return {
    clientId: `draft-${crypto.randomUUID()}`,
    label: "",
    proteinG: "",
    carbsG: "",
    fatG: "",
    caloriesKcal: "",
    sortOrder,
  };
}

function toNumber(value: string, fallback = 0) {
  if (!value.trim()) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function DashboardShell({
  userEmail,
  selectedDate,
  dailySummary,
}: DashboardShellProps) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<MealDraft[]>(() =>
    dailySummary.meals.map(mealToDraft),
  );
  const [errors, setErrors] = useState<ErrorState>({});
  const [activeMutation, setActiveMutation] = useState<string | null>(null);
  const [isPending, beginMutation] = useTransition();

  function updateDraft(
    clientId: string,
    field: keyof Omit<MealDraft, "clientId" | "id" | "sortOrder">,
    value: string,
  ) {
    setDrafts((currentDrafts) =>
      currentDrafts.map((draft) =>
        draft.clientId === clientId ? { ...draft, [field]: value } : draft,
      ),
    );
    setErrors((currentErrors) => ({
      ...currentErrors,
      [clientId]: null,
    }));
  }

  function addMealDraft() {
    const nextOrder =
      drafts.reduce((highest, draft) => Math.max(highest, draft.sortOrder), -1) + 1;

    setDrafts((currentDrafts) => [...currentDrafts, createEmptyDraft(nextOrder)]);
  }

  function removeLocalDraft(clientId: string) {
    setDrafts((currentDrafts) =>
      currentDrafts.filter((draft) => draft.clientId !== clientId),
    );
    setErrors((currentErrors) => {
      const nextErrors = { ...currentErrors };
      delete nextErrors[clientId];
      return nextErrors;
    });
  }

  function handleSave(clientId: string) {
    const draft = drafts.find((entry) => entry.clientId === clientId);
    if (!draft) {
      return;
    }

    setActiveMutation(clientId);
    beginMutation(async () => {
      const result = await saveMealEntryAction({
        id: draft.id,
        date: selectedDate,
        label: draft.label,
        sortOrder: draft.sortOrder,
        proteinG: toNumber(draft.proteinG),
        carbsG: toNumber(draft.carbsG),
        fatG: toNumber(draft.fatG),
        caloriesKcal: Math.round(toNumber(draft.caloriesKcal)),
      });

      if (!result.ok) {
        setErrors((currentErrors) => ({
          ...currentErrors,
          [clientId]: result.error ?? "Unable to save food item.",
        }));
        setActiveMutation(null);
        return;
      }

      router.refresh();
    });
  }

  function handleDelete(clientId: string) {
    const draft = drafts.find((entry) => entry.clientId === clientId);
    if (!draft) {
      return;
    }

    if (!draft.id) {
      removeLocalDraft(clientId);
      return;
    }

    setActiveMutation(clientId);
    beginMutation(async () => {
      const result = await deleteMealEntryAction({
        id: draft.id!,
      });

      if (!result.ok) {
        setErrors((currentErrors) => ({
          ...currentErrors,
          [clientId]: result.error ?? "Unable to delete food item.",
        }));
        setActiveMutation(null);
        return;
      }

      router.refresh();
    });
  }

  const dailyTotals = dailySummary.totals;

  return (
    <AppShell userEmail={userEmail} selectedDate={selectedDate} activeTab="log">
      <div className="space-y-6">
        <section className="rounded-[1.75rem] border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-5 py-5 shadow-[0_18px_40px_rgba(0,0,0,0.08)]">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--color-muted-strong)]">
                Daily totals
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--color-muted)]">
                Everything logged for the selected day.
              </p>
            </div>
            <p className="text-3xl font-semibold text-[var(--color-ink)]">
              {dailyTotals.caloriesKcal}
            </p>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-2xl bg-[var(--color-card-muted)] px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                Protein
              </p>
              <p className="mt-1 text-[1.85rem] font-semibold leading-none text-[var(--color-ink)]">
                {formatMacroValue(dailyTotals.proteinG)}g
              </p>
            </div>
            <div className="rounded-2xl bg-[var(--color-card-muted)] px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                Carbs
              </p>
              <p className="mt-1 text-[1.85rem] font-semibold leading-none text-[var(--color-ink)]">
                {formatMacroValue(dailyTotals.carbsG)}g
              </p>
            </div>
            <div className="rounded-2xl bg-[var(--color-card-muted)] px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                Fat
              </p>
              <p className="mt-1 text-[1.85rem] font-semibold leading-none text-[var(--color-ink)]">
                {formatMacroValue(dailyTotals.fatG)}g
              </p>
            </div>
            <div className="rounded-2xl bg-[var(--color-card-muted)] px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                Calories
              </p>
              <p className="mt-1 text-[1.85rem] font-semibold leading-none text-[var(--color-ink)]">
                {dailyTotals.caloriesKcal} kcal
              </p>
            </div>
          </div>
        </section>

        <section>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--color-muted-strong)]">
                Food log
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--color-muted)]">
                Log one food item per card. Add multiple items for a full meal.
              </p>
            </div>
            <button
              type="button"
              onClick={addMealDraft}
              className="w-full rounded-full bg-[var(--color-accent)] px-4 py-3.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 sm:w-auto"
            >
              Add food
            </button>
          </div>

          {drafts.length === 0 ? (
            <div className="rounded-[1.5rem] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] px-5 py-7 text-center text-sm leading-7 text-[var(--color-muted)]">
              No food items logged yet. Add one to start tracking this day.
            </div>
          ) : null}

          <div className="space-y-4">
            {drafts.map((draft) => {
              const busy = isPending && activeMutation === draft.clientId;

              return (
                <MealCard
                  key={draft.clientId}
                  draft={draft}
                  busy={busy}
                  error={errors[draft.clientId]}
                  onChange={updateDraft}
                  onSave={handleSave}
                  onDelete={handleDelete}
                />
              );
            })}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
