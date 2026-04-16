import type { Metadata } from "next";
import { canAccessAdmin, getStatsPageData, getUserById, getUserGoals, todayDateString } from "@macro-tracker/db";

import { StatsShell } from "@/components/stats-shell";
import { requireSessionUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Stats | Macro Tracker",
};

export default async function StatsPage() {
  const sessionUser = await requireSessionUser();
  const today = todayDateString();

  const [statsData, goals, user] = await Promise.all([
    getStatsPageData(sessionUser.userId, today),
    getUserGoals(sessionUser.userId),
    getUserById(sessionUser.userId),
  ]);

  return (
    <StatsShell
      userEmail={user?.email ?? sessionUser.email}
      canAccessAdmin={user ? canAccessAdmin(user.role) : false}
      today={today}
      statsData={statsData}
      goals={goals}
    />
  );
}
