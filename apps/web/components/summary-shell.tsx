"use client";

import type { DailyOverview, DailySummary, MacroGoals, PeriodAverage, StatsPageData } from "@macro-tracker/db";

import { AppShell } from "./app-shell";
import { DailyOverviewCard } from "./daily-overview-card";
import { ExperimentalAppShell, ExperimentalSettingsButton } from "./experimental-app-shell";
import { MacroBarGroup } from "./macro-bar";
import { StatsPanels } from "./stats-shell";
import { SummaryCard } from "./summary-card";
import type { UiMode } from "@/lib/ui-mode";

type SummaryShellProps = {
  userEmail: string;
  canAccessAdmin: boolean;
  selectedDate: string;
  dailySummary: DailySummary;
  periodAverages: PeriodAverage[];
  recentOverviews: DailyOverview[];
  goals: MacroGoals;
  statsData?: StatsPageData;
  uiMode?: UiMode;
};

export function SummaryShell({
  userEmail,
  canAccessAdmin,
  selectedDate,
  dailySummary,
  periodAverages,
  recentOverviews,
  goals,
  statsData,
  uiMode = "legacy",
}: SummaryShellProps) {
  const isExperimental = uiMode === "experimental";
  const dailyTotals = dailySummary.totals;
  const experimentalPeriodAverages = periodAverages.filter(
    (summary) => summary.label === "rolling7" || summary.label === "rolling30",
  );
  const content = (
    <div className="space-y-5">
      {!isExperimental ? (
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
      ) : null}

      <section>
        {!isExperimental ? (
          <div className="mb-4">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Average Macros
            </h2>
            <p className="mt-1.5 text-sm text-[var(--color-muted)]">
              Based on days with logged food.
            </p>
          </div>
        ) : null}
        <div className="space-y-3">
          {(isExperimental ? experimentalPeriodAverages : periodAverages).map((summary) => (
            <SummaryCard key={summary.label} summary={summary} goals={goals} />
          ))}
        </div>
      </section>

      {!isExperimental ? (
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
      ) : null}

      {isExperimental && statsData ? (
        <section>
          <div className="mb-4">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Historical Insights
            </h2>
            <p className="mt-1.5 text-sm text-[var(--color-muted)]">
              Long-range patterns, totals, and the foods that show up most often.
            </p>
          </div>
          <StatsPanels statsData={statsData} goals={goals} />
        </section>
      ) : null}
    </div>
  );

  return (
    isExperimental ? (
      <ExperimentalAppShell
        userEmail={userEmail}
        canAccessAdmin={canAccessAdmin}
        selectedDate={selectedDate}
        title="Summary"
        activeTab="summary"
        topBar={({ openSettings }) => (
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex min-h-12 items-center">
              <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
                Macro Trends
              </h2>
            </div>
            <ExperimentalSettingsButton onClick={openSettings} />
          </div>
        )}
      >
        {content}
      </ExperimentalAppShell>
    ) : (
      <AppShell
        userEmail={userEmail}
        canAccessAdmin={canAccessAdmin}
        selectedDate={selectedDate}
        activeTab="summary"
      >
        {content}
      </AppShell>
    )
  );
}
