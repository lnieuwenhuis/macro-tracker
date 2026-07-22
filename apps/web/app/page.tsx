import { getDailySummary, getDashboardQuickAddCandidates, getUserGoals } from "@macro-tracker/db";

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
  const { params, sessionUser, selectedDate, userEmail, canAccessAdmin } =
    await loadOnboardedPageContext(searchParams);
  const initialComposeAction = normalizeComposeAction(params.compose);
  const initialPresetTemplateKind = normalizePresetTemplateKind(params.templateKind);

  const [dailySummary, goals, quickAddCandidates] = await Promise.all([
    getDailySummary(sessionUser.userId, selectedDate),
    getUserGoals(sessionUser.userId),
    getDashboardQuickAddCandidates(sessionUser.userId),
  ]);

  return (
    <DashboardShell
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      dailySummary={dailySummary}
      goals={goals}
      quickAddCandidates={quickAddCandidates}
      initialComposeAction={initialComposeAction}
      initialPresetTemplateKind={initialPresetTemplateKind}
    />
  );
}
