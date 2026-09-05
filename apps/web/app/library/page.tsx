import { getRecipeSummaries, getTemplateSummaries, searchFoodProducts } from "@macro-tracker/db";

import { LibraryShell } from "@/components/library-shell";
import { loadOnboardedPageContext } from "@/lib/page-context";

type LibraryPageProps = {
  searchParams: Promise<{ q?: string; date?: string }>;
};

export default async function LibraryPage({ searchParams }: LibraryPageProps) {
  const { params, sessionUser, selectedDate, userEmail, canAccessAdmin, today} =
    await loadOnboardedPageContext(searchParams);
  const query = params.q ?? "";
  const [templates, recipes, products] = await Promise.all([
    getTemplateSummaries(sessionUser.userId),
    getRecipeSummaries(sessionUser.userId),
    query.trim() ? searchFoodProducts(sessionUser.userId, query) : Promise.resolve([]),
  ]);

  return (
    <LibraryShell
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      todayStr={today}
      query={query}
      products={products}
      templates={templates}
      recipes={recipes}
    />
  );
}
