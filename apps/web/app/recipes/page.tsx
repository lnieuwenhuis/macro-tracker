import { getRecipes } from "@macro-tracker/db";

import { RecipesShell } from "@/components/recipes-shell";
import { loadOnboardedPageContext } from "@/lib/page-context";

type RecipesPageProps = {
  searchParams: Promise<{
    date?: string;
  }>;
};

export default async function RecipesPage({ searchParams }: RecipesPageProps) {
  const { sessionUser, selectedDate, userEmail, canAccessAdmin, today} =
    await loadOnboardedPageContext(searchParams);
  const recipes = await getRecipes(sessionUser.userId);

  return (
    <RecipesShell
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      todayStr={today}
      recipes={recipes}
    />
  );
}
