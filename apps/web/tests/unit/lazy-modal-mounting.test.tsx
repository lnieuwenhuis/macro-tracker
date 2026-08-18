/**
 * @vitest-environment jsdom
 *
 * TEST-04: this used to read `dashboard-shell.tsx` / `recipe-builder-shell.tsx`
 * as raw source text and assert on substrings (`source.indexOf("<BarcodeCaptureModals")`,
 * `.toContain('{showPresetsModal && (')`). That verifies the source text survives,
 * not that the guard actually withholds mounting at runtime -- renaming the guard
 * variable, moving the conditional into a helper, or flipping `&&`/`||` in the
 * boolean all still pass as long as the literal substring is present somewhere.
 *
 * These tests render the real shells with React Testing Library and assert on
 * the DOM: the lazy chunk's content (a "Close scanner" button from the real,
 * dynamically-imported `BarcodeScanner`, or a `role="dialog"` from the real
 * `PresetModal`) must be absent before the flow starts, present once it starts,
 * and absent again once it is dismissed.
 */
import type { DailySummary, MacroGoals, MealEntryRecord, MealGroup } from "@macro-tracker/db";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  saveMealEntryAction: vi.fn(),
  markMealEntryStatusAction: vi.fn(),
  deleteMealEntryAction: vi.fn(),
  createMealGroupAction: vi.fn(),
  updateMealGroupAction: vi.fn(),
  deleteMealGroupAction: vi.fn(),
  loadRecipesAction: vi.fn(),
  loadTemplatesAction: vi.fn(),
  applyTemplateAction: vi.fn(),
  saveTemplateAction: vi.fn(),
  updateTemplateAction: vi.fn(),
  deleteTemplateAction: vi.fn(),
  saveRecipeAction: vi.fn(),
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
  usePathname: () => "/",
}));

vi.mock("@/lib/actions", () => ({
  saveMealEntryAction: mocked.saveMealEntryAction,
  markMealEntryStatusAction: mocked.markMealEntryStatusAction,
  deleteMealEntryAction: mocked.deleteMealEntryAction,
  createMealGroupAction: mocked.createMealGroupAction,
  updateMealGroupAction: mocked.updateMealGroupAction,
  deleteMealGroupAction: mocked.deleteMealGroupAction,
  loadRecipesAction: mocked.loadRecipesAction,
  loadTemplatesAction: mocked.loadTemplatesAction,
  applyTemplateAction: mocked.applyTemplateAction,
  saveTemplateAction: mocked.saveTemplateAction,
  updateTemplateAction: mocked.updateTemplateAction,
  deleteTemplateAction: mocked.deleteTemplateAction,
  saveRecipeAction: mocked.saveRecipeAction,
}));

import { DashboardShell } from "@/components/dashboard-shell";
import { RecipeBuilderShell } from "@/components/recipe-builder-shell";

const mealGroupA: MealGroup = {
  id: "group-a",
  userId: "user-1",
  label: "Breakfast",
  sortOrder: 0,
  isDefault: false,
};

const savedMeal: MealEntryRecord = {
  id: "meal-1",
  userId: "user-1",
  date: "2026-08-18",
  mealGroupId: mealGroupA.id,
  status: "eaten",
  productId: null,
  label: "Oatmeal",
  quantity: 100,
  unit: "g",
  servingMultiplier: 1,
  proteinG: 10,
  carbsG: 20,
  fatG: 5,
  caloriesKcal: 200,
  sortOrder: 0,
  clientMutationId: null,
  sourceLabel: null,
};

const goals: MacroGoals = {
  proteinG: null,
  carbsG: null,
  fatG: null,
  caloriesKcal: null,
};

function buildDailySummary(): DailySummary {
  return {
    date: "2026-08-18",
    totals: { proteinG: 10, carbsG: 20, fatG: 5, caloriesKcal: 200 },
    plannedTotals: { proteinG: 0, carbsG: 0, fatG: 0, caloriesKcal: 0 },
    skippedTotals: { proteinG: 0, carbsG: 0, fatG: 0, caloriesKcal: 0 },
    meals: [savedMeal],
    mealGroups: [mealGroupA],
  };
}

// The "From template" button that opens the preset modal only renders in the
// "no food items logged yet" empty state, so this variant has no meals.
function buildEmptyDailySummary(): DailySummary {
  return {
    date: "2026-08-18",
    totals: { proteinG: 0, carbsG: 0, fatG: 0, caloriesKcal: 0 },
    plannedTotals: { proteinG: 0, carbsG: 0, fatG: 0, caloriesKcal: 0 },
    skippedTotals: { proteinG: 0, carbsG: 0, fatG: 0, caloriesKcal: 0 },
    meals: [],
    mealGroups: [mealGroupA],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.loadRecipesAction.mockResolvedValue({ ok: true, recipes: [] });
  mocked.loadTemplatesAction.mockResolvedValue({ ok: true, templates: [] });
});

describe("dashboard shell lazy modal mounting", () => {
  it("only mounts the barcode scanner chunk while a capture flow is active", async () => {
    render(
      <DashboardShell
        userEmail="user@example.com"
        canAccessAdmin={false}
        selectedDate="2026-08-18"
        dailySummary={buildDailySummary()}
        goals={goals}
        quickAddCandidates={[]}
        todayStr="2026-08-18"
        initialComposeAction="scan"
      />,
    );

    // `initialComposeAction="scan"` is the same prop `app/page.tsx` derives
    // from `?compose=scan`, so this drives the real `showScanner` state path
    // rather than reaching into internals.
    const closeScannerButton = await screen.findByRole("button", {
      name: "Close scanner",
    });
    expect(closeScannerButton).not.toBeNull();

    fireEvent.click(closeScannerButton);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Close scanner" })).toBeNull();
    });
  });

  it("does not mount the barcode scanner chunk on an ordinary render", () => {
    render(
      <DashboardShell
        userEmail="user@example.com"
        canAccessAdmin={false}
        selectedDate="2026-08-18"
        dailySummary={buildDailySummary()}
        goals={goals}
        quickAddCandidates={[]}
        todayStr="2026-08-18"
      />,
    );

    expect(screen.queryByRole("button", { name: "Close scanner" })).toBeNull();
  });

  it("only mounts the preset modal chunk while it is open", async () => {
    render(
      <DashboardShell
        userEmail="user@example.com"
        canAccessAdmin={false}
        selectedDate="2026-08-18"
        dailySummary={buildEmptyDailySummary()}
        goals={goals}
        quickAddCandidates={[]}
        todayStr="2026-08-18"
      />,
    );

    expect(screen.queryByRole("dialog", { name: "Meal Templates" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "From template" }));

    const dialog = await screen.findByRole("dialog", { name: "Meal Templates" });
    expect(dialog).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Meal Templates" })).toBeNull();
    });
  });
});

describe("recipe builder shell lazy modal mounting", () => {
  function renderRecipeBuilder() {
    return render(
      <RecipeBuilderShell
        userEmail="user@example.com"
        canAccessAdmin={false}
        selectedDate="2026-08-18"
        templates={[]}
        mode="create"
        todayStr="2026-08-18"
      />,
    );
  }

  it("does not mount the barcode scanner or preset modal chunks on an ordinary render", () => {
    renderRecipeBuilder();

    expect(screen.queryByRole("button", { name: "Close scanner" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Meal Templates" })).toBeNull();
  });

  it("only mounts the barcode scanner chunk while a capture flow is active", async () => {
    renderRecipeBuilder();

    fireEvent.click(screen.getByRole("button", { name: "Add food" }));
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));

    const closeScannerButton = await screen.findByRole("button", {
      name: "Close scanner",
    });
    expect(closeScannerButton).not.toBeNull();

    fireEvent.click(closeScannerButton);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Close scanner" })).toBeNull();
    });
  });

  it("only mounts the preset modal chunk while it is open", async () => {
    renderRecipeBuilder();

    fireEvent.click(screen.getByRole("button", { name: "Add food" }));
    fireEvent.click(screen.getByRole("button", { name: "Template" }));

    const dialog = await screen.findByRole("dialog", { name: "Meal Templates" });
    expect(dialog).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Meal Templates" })).toBeNull();
    });
  });
});
