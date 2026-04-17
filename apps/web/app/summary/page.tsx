import {
  canAccessAdmin,
  ensureDateString,
  getDailySummary,
  getPeriodAverages,
  getRecentDailyOverviews,
  getUserById,
  getUserGoals,
} from "@macro-tracker/db";

import { SummaryShell } from "@/components/summary-shell";
import { requireSessionUser } from "@/lib/auth";

type SummaryPageProps = {
  searchParams: Promise<{
    date?: string;
  }>;
};

export default async function SummaryPage({ searchParams }: SummaryPageProps) {
  const sessionUser = await requireSessionUser();
  const params = await searchParams;
  const selectedDate = ensureDateString(params.date);

  const [dailySummary, periodAverages, recentOverviews, goals, user] = await Promise.all([
    getDailySummary(sessionUser.userId, selectedDate),
    getPeriodAverages(sessionUser.userId, selectedDate),
    getRecentDailyOverviews(sessionUser.userId, selectedDate),
    getUserGoals(sessionUser.userId),
    getUserById(sessionUser.userId),
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
    />
  );
}
