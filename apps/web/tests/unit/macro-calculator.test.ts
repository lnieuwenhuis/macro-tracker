import { describe, expect, it } from "vitest";

import {
  GOAL_PRESET_OPTIONS,
  calculateMacroTargets,
  getWeeklyWeightChangeEstimateKg,
} from "@/lib/macro-calculator";

describe("macro calculator presets", () => {
  it("exposes five goal presets", () => {
    expect(GOAL_PRESET_OPTIONS).toHaveLength(5);
  });

  it("caps the largest cut preset at a 1000 kcal deficit", () => {
    const aggressiveCut = GOAL_PRESET_OPTIONS.find(
      (option) => option.id === "aggressive_cut",
    );

    expect(aggressiveCut?.calorieAdjustmentKcal).toBe(-1000);
  });

  it("estimates weekly pace from the calorie adjustment", () => {
    expect(getWeeklyWeightChangeEstimateKg(-1000)).toBe(0.9);
    expect(getWeeklyWeightChangeEstimateKg(-500)).toBe(0.5);
    expect(getWeeklyWeightChangeEstimateKg(250)).toBe(0.2);
  });
});

describe("calculateMacroTargets", () => {
  it("calculates moderate cut targets for a leaner user from actual body weight", () => {
    const result = calculateMacroTargets({
      sex: "male",
      age: 30,
      heightCm: 180,
      weightKg: 80,
      activityLevel: "moderate",
      goalPreset: "moderate_cut",
    });

    expect(result).toEqual({
      bmrKcal: 1780,
      tdeeKcal: 2759,
      targetCaloriesKcal: 2259,
      proteinReferenceWeightKg: 80,
      proteinReferenceType: "actual",
      proteinTargetGPerKg: 1.8,
      weeklyWeightChangeEstimateKg: 0.5,
      weeklyWeightChangeDirection: "loss",
      macros: {
        proteinG: 144,
        carbsG: 210.4,
        fatG: 93.5,
        caloriesKcal: 2259,
      },
    });
  });

  it("uses adjusted weight for protein when body weight is well above a BMI-25 reference", () => {
    const result = calculateMacroTargets({
      sex: "male",
      age: 22,
      heightCm: 183,
      weightKg: 110,
      activityLevel: "moderate",
      goalPreset: "aggressive_cut",
    });

    expect(result).toEqual({
      bmrKcal: 2139,
      tdeeKcal: 3315,
      targetCaloriesKcal: 2315,
      proteinReferenceWeightKg: 90.3,
      proteinReferenceType: "adjusted",
      proteinTargetGPerKg: 2,
      weeklyWeightChangeEstimateKg: 0.9,
      weeklyWeightChangeDirection: "loss",
      macros: {
        proteinG: 180.6,
        carbsG: 199.1,
        fatG: 88.5,
        caloriesKcal: 2315,
      },
    });
  });

  it("clamps the calorie target to the protein floor for very low-TDEE users", () => {
    const result = calculateMacroTargets({
      sex: "female",
      age: 70,
      heightCm: 140,
      weightKg: 35,
      activityLevel: "sedentary",
      goalPreset: "aggressive_cut",
    });

    expect(result).toEqual({
      bmrKcal: 714,
      tdeeKcal: 857,
      targetCaloriesKcal: 280,
      proteinReferenceWeightKg: 35,
      proteinReferenceType: "actual",
      proteinTargetGPerKg: 2,
      weeklyWeightChangeEstimateKg: 0.9,
      weeklyWeightChangeDirection: "loss",
      macros: {
        proteinG: 70,
        carbsG: 0,
        fatG: 0,
        caloriesKcal: 280,
      },
    });
  });
});
