import { getUserGoals, getWeightPageData } from "@macro-tracker/db";

import { ProgressShell } from "@/components/progress-shell";
import { loadOnboardedPageContext } from "@/lib/page-context";
import { normalizeProgressTab } from "@/lib/progress-tab";

type ProgressPageProps = {
  searchParams: Promise<{
    date?: string;
    tab?: string;
  }>;
};

export default async function ProgressPage({ searchParams }: ProgressPageProps) {
  const {
    params,
    sessionUser,
    selectedDate,
    userEmail,
    canAccessAdmin,
    preferredWeightUnit,
  } = await loadOnboardedPageContext(searchParams);
  const initialTab = normalizeProgressTab(params.tab);

  const [goals, weightData] = await Promise.all([
    getUserGoals(sessionUser.userId),
    getWeightPageData(sessionUser.userId, selectedDate),
  ]);

  return (
    <ProgressShell
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      goals={goals}
      weightData={weightData}
      initialTab={initialTab}
      weightUnit={preferredWeightUnit}
    />
  );
}
