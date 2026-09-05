import { getPlannedShoppingSummaries, getRecipeCount, getTemplateSummaries } from "@macro-tracker/db";

import { PlannerShell } from "@/components/planner-shell";
import { nextDateString } from "@/lib/formatting";
import { loadOnboardedPageContext } from "@/lib/page-context";

type PlannerPageProps = {
  searchParams: Promise<{ date?: string }>;
};

export default async function PlannerPage({ searchParams }: PlannerPageProps) {
  const { sessionUser, selectedDate, userEmail, canAccessAdmin, today} =
    await loadOnboardedPageContext(searchParams);
  const shoppingDates = Array.from({ length: 7 }).reduce<string[]>(
    (dates) => [
      ...dates,
      dates.length === 0 ? selectedDate : nextDateString(dates[dates.length - 1]!),
    ],
    [],
  );
  const [templates, recipeCount, shoppingSummaries] = await Promise.all([
    getTemplateSummaries(sessionUser.userId),
    getRecipeCount(sessionUser.userId),
    getPlannedShoppingSummaries(sessionUser.userId, shoppingDates),
  ]);
  const selectedDaySummary = shoppingSummaries[0]!;

  return (
    <PlannerShell
      key={selectedDate}
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      todayStr={today}
      templates={templates}
      recipeCount={recipeCount}
      selectedDayEntryCount={selectedDaySummary.entryCount}
      selectedDayPlannedCaloriesKcal={selectedDaySummary.plannedCaloriesKcal}
      shoppingSummaries={shoppingSummaries}
    />
  );
}
