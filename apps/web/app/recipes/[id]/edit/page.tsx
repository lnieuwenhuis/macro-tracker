import { getRecipeById, getTemplates } from "@macro-tracker/db";
import { notFound } from "next/navigation";

import { RecipeBuilderShell } from "@/components/recipe-builder-shell";
import { isRouteUuid } from "@/lib/input-validation";
import { loadOnboardedPageContext } from "@/lib/page-context";

type EditRecipePageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    date?: string;
  }>;
};

export default async function EditRecipePage({
  params,
  searchParams,
}: EditRecipePageProps) {
  const [routeParams, pageContext] = await Promise.all([
    params,
    loadOnboardedPageContext(searchParams),
  ]);
  const { sessionUser, selectedDate, today, userEmail, canAccessAdmin } = pageContext;

  // Malformed ids are a 404 after auth; only genuine backend failures reach
  // the error boundary. Well-formed-but-missing ids 404 on the null below.
  if (!isRouteUuid(routeParams.id)) {
    notFound();
  }

  const [recipe, templates] = await Promise.all([
    getRecipeById(sessionUser.userId, routeParams.id),
    getTemplates(sessionUser.userId),
  ]);

  if (!recipe) {
    notFound();
  }

  return (
    <RecipeBuilderShell
      key={recipe.id}
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      todayStr={today}
      templates={templates}
      mode="edit"
      recipe={recipe}
    />
  );
}
