import { getDailySummary, getDashboardQuickAddCandidates, getGymHomeSummary, getUserGoals } from "@macro-tracker/db";

import { DashboardShell } from "@/components/dashboard-shell";
import { normalizeComposeAction } from "@/lib/compose";
import { loadOnboardedPageContext } from "@/lib/page-context";
import { normalizePresetTemplateKind } from "@/lib/preset-modal-state";

type HomePageProps = {
  searchParams: Promise<{
    date?: string;
    compose?: string;
    templateKind?: string;
  }>;
};

export default async function HomePage({ searchParams }: HomePageProps) {
  const { params, sessionUser, selectedDate, userEmail, canAccessAdmin, today} =
    await loadOnboardedPageContext(searchParams);
  const initialComposeAction = normalizeComposeAction(params.compose);
  const initialPresetTemplateKind = normalizePresetTemplateKind(params.templateKind);

  const [dailySummary, goals, quickAddCandidates, gymSummary] = await Promise.all([
    getDailySummary(sessionUser.userId, selectedDate),
    getUserGoals(sessionUser.userId),
    getDashboardQuickAddCandidates(sessionUser.userId),
    getGymHomeSummary(sessionUser.userId, selectedDate),
  ]);

  return (
    <DashboardShell
      key={selectedDate}
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      todayStr={today}
      dailySummary={dailySummary}
      goals={goals}
      quickAddCandidates={quickAddCandidates}
      gymSummary={gymSummary}
      initialComposeAction={initialComposeAction}
      initialPresetTemplateKind={initialPresetTemplateKind}
    />
  );
}
