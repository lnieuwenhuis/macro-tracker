/** @vitest-environment jsdom */
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
}));

import { DashboardShell } from "@/components/dashboard-shell";

const mealGroupA: MealGroup = {
  id: "group-a",
  userId: "user-1",
  label: "Breakfast",
  sortOrder: 0,
  isDefault: false,
};

const mealGroupB: MealGroup = {
  id: "group-b",
  userId: "user-1",
  label: "Lunch",
  sortOrder: 1,
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
    mealGroups: [mealGroupA, mealGroupB],
  };
}

describe("DashboardShell handleGroupChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.loadRecipesAction.mockResolvedValue({ ok: true, recipes: [] });
    mocked.loadTemplatesAction.mockResolvedValue({ ok: true, templates: [] });
  });

  it("rolls back the meal group and shows an error when the save fails", async () => {
    mocked.saveMealEntryAction.mockResolvedValue({
      ok: false,
      error: "Unable to update group.",
    });

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

    // Expand the saved meal card so its group <select> is in the DOM.
    fireEvent.click(screen.getByRole("button", { name: /Edit details for Oatmeal/i }));

    const initialSelect = (await screen.findByLabelText("Group")) as HTMLSelectElement;
    expect(initialSelect.value).toBe(mealGroupA.id);

    fireEvent.change(initialSelect, { target: { value: mealGroupB.id } });

    await waitFor(() => {
      expect(mocked.saveMealEntryAction).toHaveBeenCalledTimes(1);
    });

    // Group change remounts and collapses the card; re-expand to confirm rollback rather than stale reassignment.
    const collapsedButton = await screen.findByRole("button", {
      name: /Edit details for Oatmeal/i,
    });
    fireEvent.click(collapsedButton);

    const settledSelect = (await screen.findByLabelText("Group")) as HTMLSelectElement;
    expect(settledSelect.value).toBe(mealGroupA.id);
    expect(screen.getByText("Unable to update group.")).not.toBeNull();
  });
});
