import { describe, expect, it, vi } from "vitest";

import type {
  AppUser,
  DailySummary,
  MacroGoals,
  PeriodAverage,
  StatsPageData,
  WeightPageData,
} from "@macro-tracker/db";

import {
  type AppWarmupBuilderDeps,
  buildAppWarmupPayload,
} from "@/lib/app-warmup.server";

const zeroGoals: MacroGoals = {
  caloriesKcal: null,
  proteinG: null,
  carbsG: null,
  fatG: null,
};

function buildSummary(date: string): DailySummary {
  return {
    date,
    totals: {
      caloriesKcal: 0,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
    },
    meals: [],
  };
}

function buildUser(overrides?: Partial<AppUser>): AppUser {
  return {
    id: "user-1",
    email: "coach@example.com",
    shooPairwiseSub: "ps_user",
    displayName: "Coach",
    pictureUrl: null,
    role: "user",
    createdAt: "2026-03-01T00:00:00.000Z",
    lastLoginAt: "2026-03-01T00:00:00.000Z",
    goalCaloriesKcal: null,
    goalProteinG: null,
    goalCarbsG: null,
    goalFatG: null,
    goalWeightKg: null,
    ...overrides,
  };
}

const periodAverages: PeriodAverage[] = [
  {
    label: "rolling7",
    startDate: "2026-03-13",
    endDate: "2026-03-19",
    loggedDays: 0,
    averages: {
      caloriesKcal: 0,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
    },
  },
];

const statsData: StatsPageData = {
  allDailyTotals: [],
  totalDaysTracked: 0,
  currentStreak: 0,
  longestStreak: 0,
  totalProteinG: 0,
  totalCarbsG: 0,
  totalFatG: 0,
  totalCaloriesKcal: 0,
  bestCalorieDay: null,
  topLabels: [],
};

const weight: WeightPageData = {
  entries: [],
  goalWeightKg: null,
  stats: {
    currentWeight: null,
    weekChange: null,
    monthChange: null,
    trendDirection: null,
  },
};

function buildDeps(overrides?: Partial<AppWarmupBuilderDeps>): AppWarmupBuilderDeps {
  return {
    getUserById: vi.fn().mockResolvedValue(buildUser({ role: "admin" })),
    getUserGoals: vi.fn().mockResolvedValue(zeroGoals),
    getPresets: vi.fn().mockResolvedValue([]),
    getRecipes: vi.fn().mockResolvedValue([]),
    getRecentQuickAddCandidates: vi.fn().mockResolvedValue([]),
    getDailySummary: vi.fn(async (_userId: string, date: string) => buildSummary(date)),
    getPeriodAverages: vi.fn().mockResolvedValue(periodAverages),
    getRecentDailyOverviews: vi.fn().mockResolvedValue([]),
    getStatsPageData: vi.fn().mockResolvedValue(statsData),
    getWeightPageData: vi.fn().mockResolvedValue(weight),
    ...overrides,
  };
}

describe("buildAppWarmupPayload", () => {
  it("loads reusable app data and the nearby day window", async () => {
    const deps = buildDeps();

    const payload = await buildAppWarmupPayload({
      sessionUser: {
        userId: "user-1",
        email: "session@example.com",
      },
      selectedDate: "2026-03-19",
      deps,
    });

    expect(payload.user).toEqual({
      email: "coach@example.com",
      canAccessAdmin: true,
    });
    expect(Object.keys(payload.days)).toEqual([
      "2026-03-18",
      "2026-03-19",
      "2026-03-20",
    ]);
    expect(payload.days["2026-03-19"]?.date).toBe("2026-03-19");
    expect(payload.summary?.periodAverages).toBe(periodAverages);
    expect(payload.summary?.statsData).toBe(statsData);
    expect(payload.weight).toBe(weight);
    expect(deps.getDailySummary).toHaveBeenCalledTimes(3);
    expect(deps.getDailySummary).toHaveBeenNthCalledWith(
      1,
      "user-1",
      "2026-03-18",
    );
    expect(deps.getDailySummary).toHaveBeenNthCalledWith(
      2,
      "user-1",
      "2026-03-19",
    );
    expect(deps.getDailySummary).toHaveBeenNthCalledWith(
      3,
      "user-1",
      "2026-03-20",
    );
  });

  it("falls back to the session email when the user row is missing", async () => {
    const deps = buildDeps({
      getUserById: vi.fn().mockResolvedValue(null),
    });

    const payload = await buildAppWarmupPayload({
      sessionUser: {
        userId: "user-1",
        email: "session@example.com",
      },
      selectedDate: "2026-03-19",
      deps,
    });

    expect(payload.user).toEqual({
      email: "session@example.com",
      canAccessAdmin: false,
    });
  });
});
