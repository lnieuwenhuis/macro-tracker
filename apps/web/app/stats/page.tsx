import type { Metadata } from "next";
import { canAccessAdmin, ensureDateString, getStatsPageData, getUserById, getUserGoals } from "@macro-tracker/db";

import { StatsShell } from "@/components/stats-shell";
import { requireSessionUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Stats | Macro Tracker",
};

type StatsPageProps = {
  searchParams: Promise<{ date?: string }>;
};

export default async function StatsPage({ searchParams }: StatsPageProps) {
  const sessionUser = await requireSessionUser();
  const params = await searchParams;
  const selectedDate = ensureDateString(params.date);

  const [statsData, goals, user] = await Promise.all([
    getStatsPageData(sessionUser.userId, selectedDate),
    getUserGoals(sessionUser.userId),
    getUserById(sessionUser.userId),
  ]);

  return (
    <StatsShell
      userEmail={user?.email ?? sessionUser.email}
      canAccessAdmin={user ? canAccessAdmin(user.role) : false}
      selectedDate={selectedDate}
      statsData={statsData}
      goals={goals}
    />
  );
}
