/** @vitest-environment jsdom */
// The flash timer must be cleared on unmount; tests spy real timers and check the exact id is cleared.
import type { DailySummary, MacroGoals, MealEntryRecord } from "@macro-tracker/db";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  saveMealEntryAction: vi.fn(),
  markMealEntryStatusAction: vi.fn(),
  deleteMealEntryAction: vi.fn(),
  createMealGroupAction: vi.fn(),
  updateMealGroupAction: vi.fn(),
  deleteMealGroupAction: vi.fn(),
  loadRecipeSummariesAction: vi.fn(),
  loadTemplatesAction: vi.fn(),
  applyTemplateAction: vi.fn(),
  searchFoodsAction: vi.fn(),
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
  loadRecipeSummariesAction: mocked.loadRecipeSummariesAction,
  loadTemplatesAction: mocked.loadTemplatesAction,
  applyTemplateAction: mocked.applyTemplateAction,
  searchFoodsAction: mocked.searchFoodsAction,
}));

import { DashboardShell } from "@/components/dashboard-shell";
import { FoodSearchModal } from "@/components/food-search-modal";

/** Finds the setTimeout call scheduled with `delayMs` and returns its real timer id. */
function findScheduledTimerId(setTimeoutSpy: ReturnType<typeof vi.spyOn>, delayMs: number) {
  const callIndex = setTimeoutSpy.mock.calls.findIndex(
    (call: unknown[]) => call[1] === delayMs,
  );
  expect(callIndex).toBeGreaterThanOrEqual(0);
  return setTimeoutSpy.mock.results[callIndex]!.value;
}

describe("copied-flash timer cleanup", () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;
  let clearTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setTimeoutSpy = vi.spyOn(window, "setTimeout");
    clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    mocked.loadRecipeSummariesAction.mockResolvedValue({ ok: true, recipes: [] });
    mocked.loadTemplatesAction.mockResolvedValue({ ok: true, templates: [] });
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it("clears the DashboardShell copy-to-today flash timer on unmount", async () => {
    const savedMeal: MealEntryRecord = {
      id: "meal-1",
      userId: "user-1",
      date: "2026-08-17",
      mealGroupId: null,
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
    const goals: MacroGoals = { proteinG: null, carbsG: null, fatG: null, caloriesKcal: null };
    const dailySummary: DailySummary = {
      date: "2026-08-17",
      totals: { proteinG: 10, carbsG: 20, fatG: 5, caloriesKcal: 200 },
      plannedTotals: { proteinG: 0, carbsG: 0, fatG: 0, caloriesKcal: 0 },
      skippedTotals: { proteinG: 0, carbsG: 0, fatG: 0, caloriesKcal: 0 },
      meals: [savedMeal],
      mealGroups: [],
    };

    mocked.saveMealEntryAction.mockResolvedValue({ ok: true, entry: savedMeal });

    // A past day so the "Copy to today" action is offered.
    const { unmount } = render(
      <DashboardShell
        userEmail="user@example.com"
        canAccessAdmin={false}
        selectedDate="2026-08-17"
        dailySummary={dailySummary}
        goals={goals}
        quickAddCandidates={[]}
        todayStr="2026-08-18"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /more actions for oatmeal/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /copy to today/i }));

    await waitFor(() => {
      expect(mocked.saveMealEntryAction).toHaveBeenCalledTimes(1);
    });

    const timerId = await waitFor(() => findScheduledTimerId(setTimeoutSpy, 2000));

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId);
  });

  it("clears the FoodSearchModal copy flash timer on unmount", async () => {
    const historyEntry: MealEntryRecord = {
      id: "history-1",
      userId: "user-1",
      date: "2026-08-10",
      mealGroupId: null,
      status: "eaten",
      productId: null,
      label: "Toast",
      quantity: 1,
      unit: "serving",
      servingMultiplier: 1,
      proteinG: 5,
      carbsG: 15,
      fatG: 2,
      caloriesKcal: 120,
      sortOrder: 0,
      clientMutationId: null,
      sourceLabel: null,
    };

    mocked.searchFoodsAction.mockResolvedValue({
      ok: true,
      results: [historyEntry],
      products: [],
    });
    mocked.saveMealEntryAction.mockResolvedValue({ ok: true, entry: historyEntry });

    const { unmount } = render(
      <FoodSearchModal onClose={vi.fn()} onViewDate={vi.fn()} />,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "toast" } });

    const addTodayButton = await screen.findByRole("button", { name: /add today/i });
    fireEvent.click(addTodayButton);

    await waitFor(() => {
      expect(mocked.saveMealEntryAction).toHaveBeenCalledTimes(1);
    });

    const timerId = await waitFor(() => findScheduledTimerId(setTimeoutSpy, 2500));

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId);
  });
});
