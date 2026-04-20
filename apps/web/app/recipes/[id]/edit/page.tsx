import { canAccessAdmin, ensureDateString, getPresets, getRecipeById, getUserById } from "@macro-tracker/db";
import { notFound } from "next/navigation";

import { RecipeBuilderShell } from "@/components/recipe-builder-shell";
import { requireSessionUser } from "@/lib/auth";
import { getServerUiMode } from "@/lib/ui-mode-server";

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
  const sessionUser = await requireSessionUser();
  const [routeParams, queryParams] = await Promise.all([params, searchParams]);
  const selectedDate = ensureDateString(queryParams.date);
  const uiMode = await getServerUiMode();

  const [recipe, presets, user] = await Promise.all([
    getRecipeById(sessionUser.userId, routeParams.id),
    getPresets(sessionUser.userId),
    getUserById(sessionUser.userId),
  ]);

  if (!recipe) {
    notFound();
  }

  return (
    <RecipeBuilderShell
      key={recipe.id}
      userEmail={user?.email ?? sessionUser.email}
      canAccessAdmin={user ? canAccessAdmin(user.role) : false}
      selectedDate={selectedDate}
      presets={presets}
      mode="edit"
      recipe={recipe}
      uiMode={uiMode}
    />
  );
}
