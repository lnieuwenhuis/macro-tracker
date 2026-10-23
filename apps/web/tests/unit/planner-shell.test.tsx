/** @vitest-environment jsdom */
import type { PlannedShoppingSummary } from "@macro-tracker/db";
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
  usePathname: () => "/planner",
}));

vi.mock("@/lib/actions", () => ({
  applyTemplateAction: vi.fn(),
  createTemplateFromDateAction: vi.fn(),
}));

import { PlannerShell } from "@/components/planner-shell";

const summaries: PlannedShoppingSummary[] = [
  { date: "2026-03-16", entryCount: 0, plannedCaloriesKcal: 0, meals: [] },
  { date: "2026-03-17", entryCount: 0, plannedCaloriesKcal: 0, meals: [] },
  { date: "2026-03-18", entryCount: 0, plannedCaloriesKcal: 0, meals: [] },
];

function renderShopping() {
  render(
    <PlannerShell
      userEmail="user@example.com"
      canAccessAdmin={false}
      selectedDate="2026-03-17"
      templates={[]}
      recipeCount={0}
      selectedDayEntryCount={0}
      selectedDayPlannedCaloriesKcal={0}
      shoppingSummaries={summaries}
      todayStr="2026-03-17"
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Shopping" }));
}

describe("PlannerShell shopping dates (UI-04)", () => {
  it("stays usable when the start date is keyboard-cleared", () => {
    renderShopping();
    const startInput = screen.getByLabelText("Start") as HTMLInputElement;

    fireEvent.change(startInput, { target: { value: "" } });

    expect(startInput.value).toBe("");
    // No error boundary: the range label falls back to the default range.
    expect(screen.getByText(/Planned entries from/)).toBeTruthy();
  });

  it("stays usable when the end date is keyboard-cleared and recovers with a valid date", () => {
    renderShopping();
    const endInput = screen.getByLabelText("End") as HTMLInputElement;

    fireEvent.change(endInput, { target: { value: "" } });
    expect(endInput.value).toBe("");
    expect(screen.getByText(/Planned entries from/)).toBeTruthy();

    fireEvent.change(endInput, { target: { value: "2026-03-17" } });
    expect(endInput.value).toBe("2026-03-17");
    expect(screen.getByText(/Planned entries from/)).toBeTruthy();
  });

  it("ignores incomplete dates without crashing", () => {
    renderShopping();
    const startInput = screen.getByLabelText("Start") as HTMLInputElement;

    fireEvent.change(startInput, { target: { value: "2026-03" } });
    expect(screen.getByText(/Planned entries from/)).toBeTruthy();
  });
});
