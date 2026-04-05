import { ensureDateString, getRecipes, getUserById } from "@macro-tracker/db";

import { RecipesShell } from "@/components/recipes-shell";
import { requireSessionUser } from "@/lib/auth";

type RecipesPageProps = {
  searchParams: Promise<{
    date?: string;
  }>;
};

export default async function RecipesPage({ searchParams }: RecipesPageProps) {
  const sessionUser = await requireSessionUser();
  const params = await searchParams;
  const selectedDate = ensureDateString(params.date);

  const [recipes, user] = await Promise.all([
    getRecipes(sessionUser.userId),
    getUserById(sessionUser.userId),
  ]);

  return (
    <RecipesShell
      userEmail={user?.email ?? sessionUser.email}
      selectedDate={selectedDate}
      recipes={recipes}
    />
  );
}
