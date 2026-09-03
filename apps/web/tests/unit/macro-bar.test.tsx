/** @vitest-environment jsdom */
import { MacroBarGroup } from "@/components/macro-bar";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

function readoutTexts() {
  return Array.from(document.querySelectorAll(".tabular-nums")).map((node) =>
    (node.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
}

describe("MacroBarGroup", () => {
  it("renders every macro with its goal", () => {
    render(
      <MacroBarGroup
        caloriesKcal={1800}
        proteinG={120}
        carbsG={210}
        fatG={55}
        goals={{
          caloriesKcal: 2200,
          proteinG: 150,
          carbsG: 250,
          fatG: 70,
        }}
      />,
    );

    for (const label of ["Calories", "Protein", "Carbs", "Fat"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }

    // Value, goal and unit are separate text nodes in one span; assert on rendered text, not node boundaries.
    expect(readoutTexts()).toContain("1800 / 2200 kcal");
    expect(readoutTexts()).toContain("120 / 150g");
  });

  it("omits the goal segment when no goal is set", () => {
    render(
      <MacroBarGroup caloriesKcal={900} proteinG={40} carbsG={80} fatG={20} />,
    );

    expect(readoutTexts()).toContain("900 kcal");
    expect(readoutTexts().some((text) => text.includes("/"))).toBe(false);
  });

  it("caps the eaten fill at 100% once the goal is exceeded", () => {
    const { container } = render(
      <MacroBarGroup
        caloriesKcal={3000}
        proteinG={0}
        carbsG={0}
        fatG={0}
        goals={{ caloriesKcal: 2000, proteinG: null, carbsG: null, fatG: null }}
      />,
    );

    const fill = container.querySelector<HTMLElement>(
      '[data-testid="macro-bar-calories-eaten-fill"]',
    );
    expect(fill?.style.width).toBe("100%");
  });

  it("draws no eaten fill at zero", () => {
    const { container } = render(
      <MacroBarGroup caloriesKcal={0} proteinG={0} carbsG={0} fatG={0} />,
    );

    expect(
      container.querySelector('[data-testid="macro-bar-calories-eaten-fill"]'),
    ).toBeNull();
  });

  it("shows a projected total when planned entries exist", () => {
    render(
      <MacroBarGroup
        caloriesKcal={1000}
        proteinG={50}
        carbsG={100}
        fatG={30}
        plannedTotals={{
          caloriesKcal: 500,
          proteinG: 25,
          carbsG: 50,
          fatG: 10,
        }}
      />,
    );

    expect(screen.getByText(/Projected 1500/)).toBeTruthy();
    expect(screen.getByText(/Projected 75/)).toBeTruthy();
  });

  it("renders the planned fill ahead of the eaten fill", () => {
    const { container } = render(
      <MacroBarGroup
        caloriesKcal={1000}
        proteinG={0}
        carbsG={0}
        fatG={0}
        plannedTotals={{ caloriesKcal: 500, proteinG: 0, carbsG: 0, fatG: 0 }}
        goals={{ caloriesKcal: 2000, proteinG: null, carbsG: null, fatG: null }}
      />,
    );

    const planned = container.querySelector<HTMLElement>(
      '[data-testid="macro-bar-calories-planned-fill"]',
    );
    const eaten = container.querySelector<HTMLElement>(
      '[data-testid="macro-bar-calories-eaten-fill"]',
    );

    expect(planned?.style.width).toBe("75%");
    expect(eaten?.style.width).toBe("50%");
  });
});
