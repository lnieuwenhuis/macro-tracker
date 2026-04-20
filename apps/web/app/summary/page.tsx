import {
  canAccessAdmin,
  ensureDateString,
  getDailySummary,
  getPeriodAverages,
  getRecentDailyOverviews,
  getStatsPageData,
  getUserById,
  getUserGoals,
} from "@macro-tracker/db";

import { SummaryShell } from "@/components/summary-shell";
import { requireSessionUser } from "@/lib/auth";
import { getServerUiMode } from "@/lib/ui-mode-server";

type SummaryPageProps = {
  searchParams: Promise<{
    date?: string;
  }>;
};

export default async function SummaryPage({ searchParams }: SummaryPageProps) {
  const sessionUser = await requireSessionUser();
  const params = await searchParams;
  const selectedDate = ensureDateString(params.date);
  const uiMode = await getServerUiMode();

  const [dailySummary, periodAverages, recentOverviews, goals, user, statsData] = await Promise.all([
    getDailySummary(sessionUser.userId, selectedDate),
    getPeriodAverages(sessionUser.userId, selectedDate),
    getRecentDailyOverviews(sessionUser.userId, selectedDate),
    getUserGoals(sessionUser.userId),
    getUserById(sessionUser.userId),
    uiMode === "experimental"
      ? getStatsPageData(sessionUser.userId, selectedDate)
      : Promise.resolve(undefined),
  ]);

  return (
    <SummaryShell
      userEmail={user?.email ?? sessionUser.email}
      canAccessAdmin={user ? canAccessAdmin(user.role) : false}
      selectedDate={selectedDate}
      dailySummary={dailySummary}
      periodAverages={periodAverages}
      recentOverviews={recentOverviews}
      goals={goals}
      statsData={statsData}
      uiMode={uiMode}
    />
  );
}
