import {
  getPeriodAverages,
  getStatsPageData,
  getUserGoals,
} from "@macro-tracker/db";

import { SummaryShell } from "@/components/summary-shell";
import { loadOnboardedPageContext } from "@/lib/page-context";

type SummaryPageProps = {
  searchParams: Promise<{
    date?: string;
  }>;
};

export default async function SummaryPage({ searchParams }: SummaryPageProps) {
  const { sessionUser, selectedDate, userEmail, canAccessAdmin, today} =
    await loadOnboardedPageContext(searchParams);

  const [periodAverages, goals, statsData] = await Promise.all([
    getPeriodAverages(sessionUser.userId, selectedDate),
    getUserGoals(sessionUser.userId),
    getStatsPageData(sessionUser.userId, selectedDate),
  ]);

  return (
    <SummaryShell
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      todayStr={today}
      periodAverages={periodAverages}
      goals={goals}
      statsData={statsData}
    />
  );
}
