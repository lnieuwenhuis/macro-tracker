import { ensureDateString, getDailySummary, getUserById } from "@macro-tracker/db";

import { DashboardShell } from "@/components/dashboard-shell";
import { requireSessionUser } from "@/lib/auth";

type HomePageProps = {
  searchParams: Promise<{
    date?: string;
  }>;
};

export default async function HomePage({ searchParams }: HomePageProps) {
  const sessionUser = await requireSessionUser();
  const params = await searchParams;
  const selectedDate = ensureDateString(params.date);

  const [dailySummary, user] = await Promise.all([
    getDailySummary(sessionUser.userId, selectedDate),
    getUserById(sessionUser.userId),
  ]);
  const dashboardKey = JSON.stringify({
    selectedDate,
    dailySummary,
  });

  return (
    <DashboardShell
      key={dashboardKey}
      userEmail={user?.email ?? sessionUser.email}
      selectedDate={selectedDate}
      dailySummary={dailySummary}
    />
  );
}
