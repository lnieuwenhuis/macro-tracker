import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  getDailySummary: vi.fn(),
  getDashboardQuickAddCandidates: vi.fn(),
  getGymHomeSummary: vi.fn(),
  getUserGoals: vi.fn(),
  loadOnboardedPageContext: vi.fn(),
}));

vi.mock("@macro-tracker/db", async () => (await import("./helpers/mock-db")).mockDbModule(mocked));

vi.mock("@/components/dashboard-shell", () => ({
  DashboardShell: () => null,
}));

vi.mock("@/lib/page-context", () => ({
  loadOnboardedPageContext: mocked.loadOnboardedPageContext,
}));

import HomePage from "@/app/page";

describe("dashboard page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.getDailySummary.mockResolvedValue({ meals: [], mealGroups: [] });
    mocked.getDashboardQuickAddCandidates.mockResolvedValue([]);
    mocked.getGymHomeSummary.mockResolvedValue({
      overlaps: [],
      pendingInviteCount: 0,
    });
    mocked.getUserGoals.mockResolvedValue(null);
  });

  it("remounts the dashboard shell when the selected date changes", async () => {
    mocked.loadOnboardedPageContext
      .mockResolvedValueOnce({
        params: {},
        sessionUser: { userId: "user-1" },
        selectedDate: "2026-07-06",
        userEmail: "user@example.com",
        canAccessAdmin: false,
      })
      .mockResolvedValueOnce({
        params: {},
        sessionUser: { userId: "user-1" },
        selectedDate: "2026-07-07",
        userEmail: "user@example.com",
        canAccessAdmin: false,
      });

    const firstDashboard = await HomePage({ searchParams: Promise.resolve({}) });
    const secondDashboard = await HomePage({ searchParams: Promise.resolve({}) });

    expect(firstDashboard.key).toBe("2026-07-06");
    expect(secondDashboard.key).toBe("2026-07-07");
  });
});