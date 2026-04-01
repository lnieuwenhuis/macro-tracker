"use client";

import type { DailySummary, MealEntryRecord, PeriodAverage } from "@macro-tracker/db";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useState, useTransition } from "react";

import { deleteMealEntryAction, saveMealEntryAction } from "@/lib/actions";
import {
  formatMacroValue,
  formatSelectedDate,
  nextDateString,
  previousDateString,
} from "@/lib/formatting";

import { MealCard, type MealDraft } from "./meal-card";
import { SummaryCard } from "./summary-card";
import { ThemeToggle } from "./theme-toggle";

type DashboardShellProps = {
  userEmail: string;
  selectedDate: string;
  dailySummary: DailySummary;
  periodAverages: PeriodAverage[];
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
  periodAverages,
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

  function navigateToDate(nextDate: string) {
    startTransition(() => {
      router.push(`/?date=${nextDate}`);
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
          [clientId]: result.error ?? "Unable to save meal.",
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
          [clientId]: result.error ?? "Unable to delete meal.",
        }));
        setActiveMutation(null);
        return;
      }

      router.refresh();
    });
  }

  const dailyTotals = dailySummary.totals;

  return (
    <main className="mx-auto w-full max-w-5xl px-3 py-3 sm:px-6 sm:py-8">
      <section className="rounded-[1.75rem] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[0_30px_90px_rgba(67,41,25,0.12)] backdrop-blur sm:rounded-[2rem] sm:p-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--color-muted-strong)]">
                  Macro Tracker
                </p>
                <h1 className="mt-2 max-w-[11ch] font-serif text-3xl leading-[0.95] text-[var(--color-ink)] sm:text-5xl">
                  {formatSelectedDate(selectedDate)}
                </h1>
                <p className="mt-3 text-sm leading-6 text-[var(--color-muted)]">
                  Signed in as {userEmail}
                </p>
              </div>

              <div className="flex items-center gap-2 self-start">
                <ThemeToggle />
                <form action="/api/auth/logout" method="post">
                  <button
                    type="submit"
                    className="rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface-strong)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)] transition hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            </div>

            <div className="rounded-[1.5rem] border border-[var(--color-border)] bg-[var(--color-card-muted)] p-3">
              <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                Pick a day
              </span>
              <div className="mt-3 grid grid-cols-[auto_1fr_auto] items-center gap-2">
                <Link
                  href={`/?date=${previousDateString(selectedDate)}`}
                  className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-3 py-3 text-sm font-semibold text-[var(--color-ink)] shadow-sm transition hover:-translate-y-0.5"
                >
                  Prev
                </Link>

                <label>
                  <span className="sr-only">Pick a day</span>
                  <input
                    type="date"
                    value={selectedDate}
                    disabled={isPending}
                    onChange={(event) => navigateToDate(event.target.value)}
                    className="w-full rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-surface-strong)] px-4 py-3 text-base text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
                  />
                </label>

                <Link
                  href={`/?date=${nextDateString(selectedDate)}`}
                  className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-3 py-3 text-sm font-semibold text-[var(--color-ink)] shadow-sm transition hover:-translate-y-0.5"
                >
                  Next
                </Link>
              </div>
            </div>
          </div>

          <section className="rounded-[1.5rem] bg-[var(--color-ink)] px-4 py-5 text-[var(--color-paper)] sm:px-6 sm:py-6">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--color-paper-soft)]">
              Daily totals
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-2xl bg-white/6 px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-paper-soft)]">
                  Protein
                </p>
                <p className="mt-1 text-[1.85rem] font-semibold leading-none">
                  {formatMacroValue(dailyTotals.proteinG)}g
                </p>
              </div>
              <div className="rounded-2xl bg-white/6 px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-paper-soft)]">
                  Carbs
                </p>
                <p className="mt-1 text-[1.85rem] font-semibold leading-none">
                  {formatMacroValue(dailyTotals.carbsG)}g
                </p>
              </div>
              <div className="rounded-2xl bg-white/6 px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-paper-soft)]">
                  Fat
                </p>
                <p className="mt-1 text-[1.85rem] font-semibold leading-none">
                  {formatMacroValue(dailyTotals.fatG)}g
                </p>
              </div>
              <div className="rounded-2xl bg-white/6 px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-paper-soft)]">
                  Calories
                </p>
                <p className="mt-1 text-[1.85rem] font-semibold leading-none">
                  {dailyTotals.caloriesKcal} kcal
                </p>
              </div>
            </div>
          </section>

          <section>
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--color-muted-strong)]">
                  Meals
                </p>
                <p className="mt-2 text-sm text-[var(--color-muted)]">
                  Custom entries for the selected day.
                </p>
              </div>
              <button
                type="button"
                onClick={addMealDraft}
                className="w-full rounded-full bg-[var(--color-accent)] px-4 py-3.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 sm:w-auto"
              >
                Add meal
              </button>
            </div>

            {drafts.length === 0 ? (
              <div className="rounded-[1.5rem] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-card-subtle)] px-5 py-7 text-center text-sm leading-7 text-[var(--color-muted)]">
                No meals logged yet. Add one to start tracking this day.
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

          <section>
            <div className="mb-4">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--color-muted-strong)]">
                Averages
              </p>
              <p className="mt-2 text-sm text-[var(--color-muted)]">
                Based only on days where at least one meal was logged.
              </p>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {periodAverages.map((summary) => (
                <SummaryCard key={summary.label} summary={summary} />
              ))}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
