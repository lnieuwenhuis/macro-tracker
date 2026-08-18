import { getTemplates } from "@macro-tracker/db";

import { RecipeBuilderShell } from "@/components/recipe-builder-shell";
import { loadOnboardedPageContext } from "@/lib/page-context";

type NewRecipePageProps = {
  searchParams: Promise<{
    date?: string;
  }>;
};

export default async function NewRecipePage({ searchParams }: NewRecipePageProps) {
  const { sessionUser, selectedDate, userEmail, canAccessAdmin, today} =
    await loadOnboardedPageContext(searchParams);
  const templates = await getTemplates(sessionUser.userId);

  return (
    <RecipeBuilderShell
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      todayStr={today}
      templates={templates}
      mode="create"
    />
  );
}
