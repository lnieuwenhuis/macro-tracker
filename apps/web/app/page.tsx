import { canAccessAdmin, ensureDateString, getDailySummary, getPresets, getRecentQuickAddCandidates, getRecipes, getUserById, getUserGoals } from "@macro-tracker/db";

import { DashboardShell } from "@/components/dashboard-shell";
import { requireSessionUser } from "@/lib/auth";
import { normalizeComposeAction } from "@/lib/compose";
import { getServerUiMode } from "@/lib/ui-mode-server";

type HomePageProps = {
  searchParams: Promise<{
    date?: string;
    compose?: string;
  }>;
};

export default async function HomePage({ searchParams }: HomePageProps) {
  const sessionUser = await requireSessionUser();
  const params = await searchParams;
  const selectedDate = ensureDateString(params.date);
  const uiMode = await getServerUiMode();
  const initialComposeAction = normalizeComposeAction(params.compose);

  const [dailySummary, goals, user, presets, recipes, recentCandidates] = await Promise.all([
    getDailySummary(sessionUser.userId, selectedDate),
    getUserGoals(sessionUser.userId),
    getUserById(sessionUser.userId),
    getPresets(sessionUser.userId),
    getRecipes(sessionUser.userId),
    getRecentQuickAddCandidates(sessionUser.userId),
  ]);
  const dashboardKey = JSON.stringify({ selectedDate, dailySummary });

  return (
    <DashboardShell
      key={dashboardKey}
      userEmail={user?.email ?? sessionUser.email}
      canAccessAdmin={user ? canAccessAdmin(user.role) : false}
      selectedDate={selectedDate}
      dailySummary={dailySummary}
      goals={goals}
      presets={presets}
      recipes={recipes}
      recentCandidates={recentCandidates}
      uiMode={uiMode}
      initialComposeAction={initialComposeAction}
    />
  );
}
