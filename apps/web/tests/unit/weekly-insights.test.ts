import { describe, expect, it } from "vitest";

import type { MacroGoals, StatsPageData } from "@macro-tracker/db";

import { buildWeeklyInsights } from "@/lib/weekly-insights";

const goals: MacroGoals = {
  caloriesKcal: 2000,
  proteinG: 160,
  carbsG: 220,
  fatG: 70,
};

function buildStats(overrides: Partial<StatsPageData> = {}): StatsPageData {
  return {
    allDailyTotals: [],
    totalDaysTracked: 7,
    currentStreak: 4,
    longestStreak: 8,
    totalProteinG: 1120,
    totalCarbsG: 1400,
    totalFatG: 420,
    totalCaloriesKcal: 14000,
    bestCalorieDay: { date: "2026-06-14", caloriesKcal: 2100 },
    topLabels: [{ label: "Greek yogurt", count: 6 }],
    goalHitRates: {
      days7: {
        caloriesKcal: 86,
        proteinG: 71,
        carbsG: 57,
        fatG: 71,
      },
      days30: {
        caloriesKcal: 76,
        proteinG: 70,
        carbsG: 60,
        fatG: 66,
      },
      days90: {
        caloriesKcal: 72,
        proteinG: 68,
        carbsG: 58,
        fatG: 62,
      },
    },
    macroConsistency: {
      calorieAvgAbsoluteDeviation: 120,
      score: 94,
    },
    rollingAverages: {
      days7: {
        proteinG: 160,
        carbsG: 200,
        fatG: 60,
        caloriesKcal: 2000,
      },
      days30: {
        proteinG: 150,
        carbsG: 210,
        fatG: 65,
        caloriesKcal: 2050,
      },
    },
    estimatedEnergyBalance: {
      averageDailyDeltaKcal: 50,
      estimatedWeeklyWeightChangeKg: 0.05,
    },
    proteinPerKg: 1.8,
    smoothedWeightTrend: [],
    plannedAdherence: {
      plannedCount: 10,
      eatenCount: 8,
      skippedCount: 1,
      adherencePct: 80,
    },
    ...overrides,
  };
}

describe("buildWeeklyInsights", () => {
  it("returns a starter insight when there is no data", () => {
    const insights = buildWeeklyInsights(buildStats({ totalDaysTracked: 0 }), goals);

    expect(insights).toEqual([
      expect.objectContaining({
        id: "no-data",
        tone: "info",
      }),
    ]);
  });

  it("recognizes strong adherence", () => {
    const insights = buildWeeklyInsights(buildStats(), goals);

    expect(insights[0]).toMatchObject({
      id: "calorie-adherence-strong",
      value: "86%",
      tone: "good",
    });
  });

  it("flags poor consistency", () => {
    const insights = buildWeeklyInsights(
      buildStats({
        macroConsistency: {
          calorieAvgAbsoluteDeviation: 420,
          score: 54,
        },
      }),
      goals,
    );

    expect(insights).toContainEqual(
      expect.objectContaining({
        id: "consistency-low",
        tone: "warning",
      }),
    );
  });

  it("surfaces energy surplus and deficit", () => {
    const surplus = buildWeeklyInsights(
      buildStats({
        estimatedEnergyBalance: {
          averageDailyDeltaKcal: 320,
          estimatedWeeklyWeightChangeKg: 0.29,
        },
      }),
      goals,
    );
    const deficit = buildWeeklyInsights(
      buildStats({
        estimatedEnergyBalance: {
          averageDailyDeltaKcal: -280,
          estimatedWeeklyWeightChangeKg: -0.25,
        },
      }),
      goals,
    );

    expect(surplus).toContainEqual(
      expect.objectContaining({ id: "energy-surplus", value: "+320 kcal/day" }),
    );
    expect(deficit).toContainEqual(
      expect.objectContaining({ id: "energy-deficit", value: "-280 kcal/day" }),
    );
  });

  it("handles missing goals with setup guidance", () => {
    const insights = buildWeeklyInsights(
      buildStats({
        goalHitRates: {
          days7: {
            caloriesKcal: null,
            proteinG: null,
            carbsG: null,
            fatG: null,
          },
          days30: {
            caloriesKcal: null,
            proteinG: null,
            carbsG: null,
            fatG: null,
          },
          days90: {
            caloriesKcal: null,
            proteinG: null,
            carbsG: null,
            fatG: null,
          },
        },
        estimatedEnergyBalance: {
          averageDailyDeltaKcal: null,
          estimatedWeeklyWeightChangeKg: null,
        },
      }),
      {
        caloriesKcal: null,
        proteinG: null,
        carbsG: null,
        fatG: null,
      },
    );

    expect(insights).toContainEqual(
      expect.objectContaining({
        id: "missing-calorie-goal",
        value: "Not set",
      }),
    );
  });
});
