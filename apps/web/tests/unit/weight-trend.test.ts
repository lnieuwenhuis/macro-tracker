import { describe, expect, it } from "vitest";

import type { WeightPageData } from "@macro-tracker/db";

import { buildWeightGoalProjection } from "@/lib/weight-trend";

function buildWeightData(overrides: Partial<WeightPageData> = {}): WeightPageData {
  return {
    goalWeightKg: 80,
    entries: [
      {
        id: "w1",
        userId: "user",
        date: "2026-06-01",
        weightKg: 84,
        bodyFatPct: null,
        notes: null,
      },
      {
        id: "w2",
        userId: "user",
        date: "2026-06-15",
        weightKg: 82,
        bodyFatPct: null,
        notes: null,
      },
    ],
    stats: {
      currentWeight: 82,
      weekChange: -1,
      monthChange: null,
      trendDirection: "down",
    },
    ...overrides,
  };
}

describe("buildWeightGoalProjection", () => {
  it("requires a goal", () => {
    expect(
      buildWeightGoalProjection(
        buildWeightData({
          goalWeightKg: null,
        }),
        "2026-06-15",
      ),
    ).toMatchObject({
      status: "no_goal",
      estimatedGoalDate: null,
    });
  });

  it("requires at least two entries", () => {
    expect(
      buildWeightGoalProjection(
        buildWeightData({
          entries: [
            {
              id: "w1",
              userId: "user",
              date: "2026-06-15",
              weightKg: 82,
              bodyFatPct: null,
              notes: null,
            },
          ],
        }),
        "2026-06-15",
      ),
    ).toMatchObject({
      status: "insufficient_data",
      weeklyRateKg: null,
    });
  });

  it("detects when the user is already at goal", () => {
    expect(
      buildWeightGoalProjection(
        buildWeightData({
          goalWeightKg: 82.05,
        }),
        "2026-06-15",
      ),
    ).toMatchObject({
      status: "at_goal",
      daysToGoal: 0,
    });
  });

  it("projects a date when moving toward goal", () => {
    const projection = buildWeightGoalProjection(buildWeightData(), "2026-06-15");

    expect(projection).toMatchObject({
      status: "moving_toward",
      goalDeltaKg: -2,
      weeklyRateKg: -1,
      estimatedGoalDate: "2026-06-29",
      daysToGoal: 14,
    });
  });

  it("projects from the latest entry date instead of the selected reference date", () => {
    const projection = buildWeightGoalProjection(buildWeightData(), "2026-07-01");

    expect(projection).toMatchObject({
      status: "moving_toward",
      estimatedGoalDate: "2026-06-29",
      daysToGoal: 14,
    });
  });

  it("detects moving away from goal", () => {
    expect(
      buildWeightGoalProjection(
        buildWeightData({
          entries: [
            {
              id: "w1",
              userId: "user",
              date: "2026-06-01",
              weightKg: 82,
              bodyFatPct: null,
              notes: null,
            },
            {
              id: "w2",
              userId: "user",
              date: "2026-06-15",
              weightKg: 84,
              bodyFatPct: null,
              notes: null,
            },
          ],
          stats: {
            currentWeight: 84,
            weekChange: 1,
            monthChange: null,
            trendDirection: "up",
          },
        }),
        "2026-06-15",
      ),
    ).toMatchObject({
      status: "moving_away",
      estimatedGoalDate: null,
    });
  });

  it("uses recent sorted entries when long-term and recent trends disagree", () => {
    const projection = buildWeightGoalProjection(
      buildWeightData({
        entries: [
          {
            id: "w2",
            userId: "user",
            date: "2026-05-01",
            weightKg: 82,
            bodyFatPct: null,
            notes: null,
          },
          {
            id: "w4",
            userId: "user",
            date: "2026-06-15",
            weightKg: 83,
            bodyFatPct: null,
            notes: null,
          },
          {
            id: "w1",
            userId: "user",
            date: "2026-01-01",
            weightKg: 90,
            bodyFatPct: null,
            notes: null,
          },
          {
            id: "w3",
            userId: "user",
            date: "2026-06-01",
            weightKg: 81,
            bodyFatPct: null,
            notes: null,
          },
        ],
        stats: {
          currentWeight: 83,
          weekChange: 1,
          monthChange: 1,
          trendDirection: "up",
        },
      }),
      "2026-06-15",
    );

    expect(projection).toMatchObject({
      status: "moving_away",
      goalDeltaKg: -3,
      weeklyRateKg: 1,
      estimatedGoalDate: null,
    });
  });
});
