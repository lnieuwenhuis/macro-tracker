import { getDailySummary, getRecipeCount, getTemplates } from "@macro-tracker/db";

import { PlannerShell } from "@/components/planner-shell";
import { nextDateString } from "@/lib/formatting";
import { loadOnboardedPageContext } from "@/lib/page-context";

type PlannerPageProps = {
  searchParams: Promise<{ date?: string }>;
};

export default async function PlannerPage({ searchParams }: PlannerPageProps) {
  const { sessionUser, selectedDate, userEmail, canAccessAdmin } =
    await loadOnboardedPageContext(searchParams);
  const shoppingDates = Array.from({ length: 7 }).reduce<string[]>(
    (dates) => [
      ...dates,
      dates.length === 0 ? selectedDate : nextDateString(dates[dates.length - 1]!),
    ],
    [],
  );
  const [templates, recipeCount, shoppingSummaries] = await Promise.all([
    getTemplates(sessionUser.userId),
    getRecipeCount(sessionUser.userId),
    Promise.all(
      shoppingDates.map((date) => getDailySummary(sessionUser.userId, date)),
    ),
  ]);
  const dailySummary = shoppingSummaries[0]!;

  return (
    <PlannerShell
      key={selectedDate}
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      templates={templates}
      recipeCount={recipeCount}
      dailySummary={dailySummary}
      shoppingSummaries={shoppingSummaries}
    />
  );
}
