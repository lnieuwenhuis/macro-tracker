import { canAccessAdmin, ensureDateString, getPresets, getUserById } from "@macro-tracker/db";

import { RecipeBuilderShell } from "@/components/recipe-builder-shell";
import { requireSessionUser } from "@/lib/auth";
import { getServerUiMode } from "@/lib/ui-mode-server";

type NewRecipePageProps = {
  searchParams: Promise<{
    date?: string;
  }>;
};

export default async function NewRecipePage({ searchParams }: NewRecipePageProps) {
  const sessionUser = await requireSessionUser();
  const params = await searchParams;
  const selectedDate = ensureDateString(params.date);
  const uiMode = await getServerUiMode();

  const [presets, user] = await Promise.all([
    getPresets(sessionUser.userId),
    getUserById(sessionUser.userId),
  ]);

  return (
    <RecipeBuilderShell
      userEmail={user?.email ?? sessionUser.email}
      canAccessAdmin={user ? canAccessAdmin(user.role) : false}
      selectedDate={selectedDate}
      presets={presets}
      mode="create"
      uiMode={uiMode}
    />
  );
}
