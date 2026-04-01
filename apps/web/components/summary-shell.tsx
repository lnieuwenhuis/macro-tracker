"use client";

import type { DailyOverview, DailySummary, MacroGoals, PeriodAverage } from "@macro-tracker/db";

import { AppShell } from "./app-shell";
import { DailyOverviewCard } from "./daily-overview-card";
import { MacroBarGroup } from "./macro-bar";
import { SummaryCard } from "./summary-card";

type SummaryShellProps = {
  userEmail: string;
  selectedDate: string;
  dailySummary: DailySummary;
  periodAverages: PeriodAverage[];
  recentOverviews: DailyOverview[];
  goals: MacroGoals;
};

export function SummaryShell({
  userEmail,
  selectedDate,
  dailySummary,
  periodAverages,
  recentOverviews,
  goals,
}: SummaryShellProps) {
  const dailyTotals = dailySummary.totals;

  return (
    <AppShell
      userEmail={userEmail}
      selectedDate={selectedDate}
      activeTab="summary"
    >
      <div className="space-y-5">
        {/* Daily snapshot with bar charts */}
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5 shadow-[0_12px_32px_rgba(0,0,0,0.06)]">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Daily Snapshot
            </h2>
            <span className="text-2xl font-bold tabular-nums text-[var(--color-ink)]">
              {dailyTotals.caloriesKcal}
              <span className="ml-1 text-xs font-semibold text-[var(--color-muted)]">kcal</span>
            </span>
          </div>

          <MacroBarGroup
            proteinG={dailyTotals.proteinG}
            carbsG={dailyTotals.carbsG}
            fatG={dailyTotals.fatG}
            caloriesKcal={dailyTotals.caloriesKcal}
            goals={goals}
          />
        </section>

        {/* Period averages with bar charts */}
        <section>
          <div className="mb-4">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Average Macros
            </h2>
            <p className="mt-1.5 text-sm text-[var(--color-muted)]">
              Based on days with logged food.
            </p>
          </div>
          <div className="space-y-3">
            {periodAverages.map((summary) => (
              <SummaryCard key={summary.label} summary={summary} goals={goals} />
            ))}
          </div>
        </section>

        {/* Recent days */}
        <section>
          <div className="mb-4">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Recent Days
            </h2>
            <p className="mt-1.5 text-sm text-[var(--color-muted)]">
              Your most recent logged days.
            </p>
          </div>
          <div className="space-y-3">
            {recentOverviews.map((overview) => (
              <DailyOverviewCard key={overview.date} overview={overview} goals={goals} />
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
