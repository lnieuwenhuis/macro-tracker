/**
 * @vitest-environment jsdom
 *
 * UI-03: the overflow menu declared `role="menu"`/`role="menuitem"` but had
 * no Escape handler and no outside-click dismissal -- a keyboard or
 * screen-reader user could only close it by clicking the trigger again or
 * picking an item. The fix reuses `useDismissableLayer` from
 * `overlay-portal.tsx`, the same hook every other dropdown in this codebase
 * (e.g. `add-food-button.tsx`) already uses for Escape + outside-pointerdown
 * dismissal.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MealCard, type MealDraft } from "@/components/meal-card";

function buildDraft(overrides: Partial<MealDraft> = {}): MealDraft {
  return {
    clientId: "meal-1",
    id: "meal-1",
    mealGroupId: null,
    status: "eaten",
    productId: null,
    label: "Oatmeal",
    quantity: "100",
    unit: "g",
    servingMultiplier: "1",
    proteinG: "10",
    carbsG: "20",
    fatG: "5",
    caloriesKcal: "200",
    sortOrder: 0,
    ...overrides,
  };
}

function renderCard() {
  return render(
    <MealCard
      draft={buildDraft()}
      busy={false}
      onChange={vi.fn()}
      onSave={vi.fn().mockResolvedValue(true)}
      onDelete={vi.fn()}
      onDuplicate={vi.fn()}
    />,
  );
}

describe("MealCard overflow menu dismissal", () => {
  it("closes on Escape", () => {
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: /more actions for oatmeal/i }));
    expect(screen.getByRole("menu")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on an outside pointerdown", () => {
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: /more actions for oatmeal/i }));
    expect(screen.getByRole("menu")).not.toBeNull();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("stays open for a pointerdown inside the menu", () => {
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: /more actions for oatmeal/i }));
    const menu = screen.getByRole("menu");

    fireEvent.pointerDown(menu);
    expect(screen.queryByRole("menu")).not.toBeNull();
  });
});
