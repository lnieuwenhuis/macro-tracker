/** @vitest-environment jsdom */
// UI-18: all sections must reflect one query (or label the stale one).
// UI-19: single-portion recipes use the singular label.
import type { FoodProduct, RecipeSummary } from "@macro-tracker/db";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocked.push,
    replace: mocked.replace,
    refresh: mocked.refresh,
  }),
  usePathname: () => "/library",
}));

import { LibraryShell } from "@/components/library-shell";

const products: FoodProduct[] = [
  {
    id: "product-1",
    name: "Oatmeal",
    brand: null,
    source: "personal",
    caloriesPer100: 100,
  } as unknown as FoodProduct,
];

const recipes: RecipeSummary[] = [
  {
    id: "recipe-1",
    label: "Solo bowl",
    portions: 1,
    perPortionMacros: { proteinG: 10, carbsG: 20, fatG: 5, caloriesKcal: 200 },
  },
  {
    id: "recipe-2",
    label: "Family pot",
    portions: 4,
    perPortionMacros: { proteinG: 10, carbsG: 20, fatG: 5, caloriesKcal: 200 },
  },
];

function renderLibrary(query: string) {
  return render(
    <LibraryShell
      userEmail="user@example.com"
      canAccessAdmin={false}
      selectedDate="2026-03-17"
      query={query}
      products={products}
      templates={[]}
      recipes={recipes}
      todayStr="2026-03-17"
    />,
  );
}

describe("UI-18/UI-19 library display", () => {
  it("labels Foods with the submitted query once the typed query diverges", async () => {
    renderLibrary("oat");
    expect(screen.queryByText(/Food results are for/)).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Search library"), {
      target: { value: "oatmeal banana" },
    });

    expect(await screen.findByText(/Food results are for/)).toBeTruthy();
  });

  it("uses singular/plural portion labels like the recipe card", () => {
    const { container } = renderLibrary("");
    expect(container.textContent).toContain("1 portion ·");
    expect(container.textContent).not.toContain("1 portions");
    expect(container.textContent).toContain("4 portions ·");
  });

  it("shows an invalid submitted query as a recoverable error with results intact", () => {
    render(
      <LibraryShell
        userEmail="user@example.com"
        canAccessAdmin={false}
        selectedDate="2026-03-17"
        query={"a".repeat(129)}
        products={[]}
        templates={[]}
        recipes={recipes}
        todayStr="2026-03-17"
        searchError="Search must be at most 128 characters."
      />,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Search must be at most 128 characters.")).toBeTruthy();
    // The query is preserved in the input and the other sections stay usable
    // (live-filtered by the typed query, hence no recipe match here).
    expect(screen.getByPlaceholderText("Search library")).toHaveProperty(
      "value",
      "a".repeat(129),
    );
    expect(screen.getByText("No recipes found.")).toBeTruthy();
  });
});
