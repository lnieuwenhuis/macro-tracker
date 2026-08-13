"use client";

import type { MacroGoals, PeriodAverage, StatsPageData } from "@macro-tracker/db";

import { AppShell, SettingsButton } from "./app-shell";
import { StatsPanels } from "./stats-shell";
import { SummaryCard } from "./summary-card";

type SummaryShellProps = {
  userEmail: string;
  canAccessAdmin: boolean;
  selectedDate: string;
  periodAverages: PeriodAverage[];
  goals: MacroGoals;
  statsData: StatsPageData;
};

export function SummaryShell({
  userEmail,
  canAccessAdmin,
  selectedDate,
  periodAverages,
  goals,
  statsData,
}: SummaryShellProps) {
  const nonEmptyAverages = periodAverages.filter((summary) => summary.loggedDays > 0);
  const rollingAverages = nonEmptyAverages.filter(
    (summary) => summary.label === "rolling7" || summary.label === "rolling30",
  );
  const content = (
    <div className="space-y-5">
      <section>
        <div className="space-y-3">
          {rollingAverages.map((summary) => (
            <SummaryCard key={summary.label} summary={summary} goals={goals} />
          ))}
        </div>
      </section>

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
    </div>
  );

  return (
    <AppShell
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
          <SettingsButton onClick={openSettings} />
        </div>
      )}
    >
      {content}
    </AppShell>
  );
}
