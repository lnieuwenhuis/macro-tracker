"use client";

import type { DailyOverview, DailySummary, PeriodAverage } from "@macro-tracker/db";

import { AppShell } from "./app-shell";
import { DailyOverviewCard } from "./daily-overview-card";
import { SummaryCard } from "./summary-card";

type SummaryShellProps = {
  userEmail: string;
  selectedDate: string;
  dailySummary: DailySummary;
  periodAverages: PeriodAverage[];
  recentOverviews: DailyOverview[];
};

export function SummaryShell({
  userEmail,
  selectedDate,
  dailySummary,
  periodAverages,
  recentOverviews,
}: SummaryShellProps) {
  const dailyTotals = dailySummary.totals;

  return (
    <AppShell
      userEmail={userEmail}
      selectedDate={selectedDate}
      activeTab="summary"
    >
      <div className="space-y-6">
        <section className="rounded-[1.75rem] border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-5 py-5 shadow-[0_18px_40px_rgba(0,0,0,0.08)]">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--color-muted-strong)]">
                Daily snapshot
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--color-muted)]">
                Totals for the selected day.
              </p>
            </div>
            <p className="text-3xl font-semibold text-[var(--color-ink)]">
              {dailyTotals.caloriesKcal}
            </p>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-3">
            <div className="rounded-2xl bg-[var(--color-card-muted)] px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                Protein
              </p>
              <p className="mt-1 text-xl font-semibold text-[var(--color-ink)]">
                {dailyTotals.proteinG}g
              </p>
            </div>
            <div className="rounded-2xl bg-[var(--color-card-muted)] px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                Carbs
              </p>
              <p className="mt-1 text-xl font-semibold text-[var(--color-ink)]">
                {dailyTotals.carbsG}g
              </p>
            </div>
            <div className="rounded-2xl bg-[var(--color-card-muted)] px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                Fat
              </p>
              <p className="mt-1 text-xl font-semibold text-[var(--color-ink)]">
                {dailyTotals.fatG}g
              </p>
            </div>
          </div>
        </section>

        <section>
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--color-muted-strong)]">
              Average macros
            </p>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              Based only on days where at least one food item was logged.
            </p>
          </div>
          <div className="grid gap-4">
            {periodAverages.map((summary) => (
              <SummaryCard key={summary.label} summary={summary} />
            ))}
          </div>
        </section>

        <section>
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--color-muted-strong)]">
              Recent days
            </p>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              Quick overview of your most recent logged days.
            </p>
          </div>
          <div className="space-y-3">
            {recentOverviews.map((overview) => (
              <DailyOverviewCard key={overview.date} overview={overview} />
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
