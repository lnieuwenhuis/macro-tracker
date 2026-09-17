import {
  BackendError,
  getRecipeSummaries,
  getTemplateSummaries,
  searchFoodProducts,
  type FoodProduct,
} from "@macro-tracker/db";

import { LibraryShell } from "@/components/library-shell";
import { validateSearchQuery } from "@/lib/input-validation";
import { loadOnboardedPageContext } from "@/lib/page-context";

type LibraryPageProps = {
  searchParams: Promise<{ q?: string; date?: string }>;
};

function isSearchValidationError(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  const name = (error as { name?: string } | null)?.name;
  return (
    code === "bad_request" &&
    (error instanceof BackendError || name === "BackendError")
  );
}

export default async function LibraryPage({ searchParams }: LibraryPageProps) {
  const { params, sessionUser, selectedDate, userEmail, canAccessAdmin, today} =
    await loadOnboardedPageContext(searchParams);
  const query = params.q ?? "";
  const [templates, recipes] = await Promise.all([
    getTemplateSummaries(sessionUser.userId),
    getRecipeSummaries(sessionUser.userId),
  ]);

  // Invalid input stays on the page as an actionable message with the query
  // preserved; only genuine backend outages reach the error boundary.
  let products: FoodProduct[] = [];
  let searchError: string | null = null;
  if (query.trim()) {
    searchError = validateSearchQuery(query);
    if (!searchError) {
      try {
        products = await searchFoodProducts(sessionUser.userId, query);
      } catch (error) {
        if (isSearchValidationError(error)) {
          searchError = (error as Error).message;
        } else {
          throw error;
        }
      }
    }
  }

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
      searchError={searchError}
    />
  );
}
