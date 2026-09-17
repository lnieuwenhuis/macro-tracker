/** @vitest-environment jsdom */
import type { DailySummary, MacroGoals, MealEntryRecord } from "@macro-tracker/db";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));

import { DashboardShell } from "@/components/dashboard-shell";

const goals: MacroGoals = {
  proteinG: null,
  carbsG: null,
  fatG: null,
  caloriesKcal: null,
};

function meal(overrides: Partial<MealEntryRecord> & { id: string }): MealEntryRecord {
  return {
    userId: "user-1",
    date: "2026-08-18",
    mealGroupId: null,
    status: "eaten",
    productId: null,
    label: "Meal",
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
    ...overrides,
  };
}

function summary(meals: MealEntryRecord[]): DailySummary {
  return {
    date: "2026-08-18",
    totals: { proteinG: 10, carbsG: 20, fatG: 5, caloriesKcal: 200 },
    plannedTotals: { proteinG: 0, carbsG: 0, fatG: 0, caloriesKcal: 0 },
    skippedTotals: { proteinG: 0, carbsG: 0, fatG: 0, caloriesKcal: 0 },
    meals,
    mealGroups: [],
  };
}

function renderShell(meals: MealEntryRecord[]) {
  return render(
    <DashboardShell
      userEmail="user@example.com"
      canAccessAdmin={false}
      selectedDate="2026-08-18"
      dailySummary={summary(meals)}
      goals={goals}
      quickAddCandidates={[]}
      todayStr="2026-08-18"
    />,
  );
}

async function expandCard(label: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`Edit details for ${label}`, "i") }));
  await screen.findByDisplayValue(label);
}

describe("DashboardShell dirty preservation (UI-03)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.loadRecipeSummariesAction.mockResolvedValue({ ok: true, recipes: [] });
    mocked.loadTemplatesAction.mockResolvedValue({ ok: true, templates: [] });
  });

  it("preserves unsaved label edits when the status changes", async () => {
    const saved = meal({ id: "meal-1", label: "Oatmeal", status: "planned" });
    renderShell([saved]);
    await expandCard("Oatmeal");

    fireEvent.change(screen.getByPlaceholderText(/chicken breast/i), {
      target: { value: "Oatmeal + honey" },
    });

    mocked.markMealEntryStatusAction.mockResolvedValue({
      ok: true,
      entry: { ...saved, status: "eaten" as const },
    });
    fireEvent.click(screen.getByRole("button", { name: /mark eaten/i }));

    await waitFor(() => {
      expect(mocked.markMealEntryStatusAction).toHaveBeenCalledTimes(1);
    });

    // The status commits but the unsaved label edit survives.
    await waitFor(() => {
      expect(screen.queryByDisplayValue("Oatmeal + honey")).not.toBeNull();
    });
    expect(screen.getByText("eaten")).not.toBeNull();
  });

  it("keeps card A dirty when a refresh arrives from another card", async () => {
    const mealA = meal({ id: "meal-a", label: "Oats", sortOrder: 0 });
    const { rerender } = renderShell([mealA]);
    await expandCard("Oats");

    fireEvent.change(screen.getByPlaceholderText(/chicken breast/i), {
      target: { value: "Oats + berries" },
    });

    // Simulate a same-day refresh (e.g. another card saved): fresh fetch,
    // same server content, new array identity.
    rerender(
      <DashboardShell
        userEmail="user@example.com"
        canAccessAdmin={false}
        selectedDate="2026-08-18"
        dailySummary={summary([{ ...mealA }])}
        goals={goals}
        quickAddCandidates={[]}
        todayStr="2026-08-18"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByDisplayValue("Oats + berries")).not.toBeNull();
    });
  });

  it("adopts fresh server values for untouched fields on refresh", async () => {
    const mealA = meal({ id: "meal-a", label: "Oats", proteinG: 10, sortOrder: 0 });
    const { rerender } = renderShell([mealA]);
    await expandCard("Oats");

    // Server-side change (e.g. corrected elsewhere) with no local edits.
    const updated = { ...mealA, proteinG: 30 };
    rerender(
      <DashboardShell
        userEmail="user@example.com"
        canAccessAdmin={false}
        selectedDate="2026-08-18"
        dailySummary={summary([updated])}
        goals={goals}
        quickAddCandidates={[]}
        todayStr="2026-08-18"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByDisplayValue("30")).not.toBeNull();
    });
  });
});

describe("DashboardShell per-card pending state (UI-25)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.loadRecipeSummariesAction.mockResolvedValue({ ok: true, recipes: [] });
    mocked.loadTemplatesAction.mockResolvedValue({ ok: true, templates: [] });
  });

  it("tracks two saves independently: neither completion releases the other", async () => {
    const mealA = meal({ id: "meal-a", label: "Oats", sortOrder: 0 });
    const mealB = meal({ id: "meal-b", label: "Rice", sortOrder: 1 });
    renderShell([mealA, mealB]);
    await expandCard("Oats");
    await expandCard("Rice");

    let resolveA!: (value: unknown) => void;
    let resolveB!: (value: unknown) => void;
    mocked.saveMealEntryAction
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveA = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveB = resolve;
        }),
      );

    const updateButtons = screen.getAllByRole("button", { name: /^update$/i });
    expect(updateButtons).toHaveLength(2);
    fireEvent.click(updateButtons[0]!);
    fireEvent.click(updateButtons[1]!);

    await waitFor(() => {
      expect(mocked.saveMealEntryAction).toHaveBeenCalledTimes(2);
    });

    // Both cards busy; saving B never released A.
    expect(screen.getAllByRole("button", { name: /saving/i })).toHaveLength(2);

    await act(async () => {
      resolveA({ ok: true, entry: mealA });
    });

    // A settled but B is still pending on its own marker.
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /saving/i })).toHaveLength(1);
    });

    await act(async () => {
      resolveB({ ok: true, entry: mealB });
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /saving/i })).toBeNull();
    });
  });

  it("releases only the failed card on transport rejection and retries cleanly", async () => {
    const mealA = meal({ id: "meal-a", label: "Oats", sortOrder: 0 });
    renderShell([mealA]);
    await expandCard("Oats");

    mocked.saveMealEntryAction.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: /^update$/i }));

    await screen.findByText(/unable to save food item/i);
    // Busy reset for the failed card; retry is available.
    expect(
      (screen.getByRole("button", { name: /^update$/i }) as HTMLButtonElement).disabled,
    ).toBe(false);

    mocked.saveMealEntryAction.mockResolvedValueOnce({ ok: true, entry: mealA });
    fireEvent.click(screen.getByRole("button", { name: /^update$/i }));
    await waitFor(() => {
      expect(mocked.saveMealEntryAction).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByText(/unable to save food item/i)).toBeNull();
    });
  });
});
