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

  // TEST-06: every other case above drives a "loss" (cut) preset. This case
  // exercises "lean_bulk" (a surplus preset) so the "gain" branch of
  // `weeklyWeightChangeDirection` and the surplus arithmetic get coverage.
  //
  // Expected values are hand-derived from lib/macro-calculator.ts:
  //   bmr (male) = 10*weightKg + 6.25*heightCm - 5*age + 5
  //              = 10*70 + 6.25*175 - 5*25 + 5 = 1673.75 -> round -> 1674
  //   tdee = round(bmr * activityMultiplier[light=1.375])
  //        = round(1673.75 * 1.375) = round(2301.406..) = 2301
  //   lean_bulk preset: calorieAdjustmentKcal=+250, proteinTargetGPerKg=1.6,
  //     macroSplit { carbs: 0.65, fat: 0.35 }
  //   rawTargetCalories = 2301 + 250 = 2551
  //   BMI-25 reference weight = 25 * 1.75^2 = 76.5625kg; 70kg is under that,
  //     so protein reference weight is the actual body weight (70kg, "actual").
  //   proteinG = round1(70 * 1.6) = 112 -> proteinCalories = 448
  //   targetCalories = max(2551, ceil(448)) = 2551
  //   remainingCalories = 2551 - 448 = 2103
  //   carbsG = round1((2103*0.65)/4) = round1(1366.95/4) = round1(341.7375) = 341.7
  //   fatG = round1((2103*0.35)/9) = round1(736.05/9) = round1(81.7833..) = 81.8
  //   weeklyWeightChangeEstimateKg = round1(abs(250)*7/7700) = round1(0.22727..) = 0.2
  it("calculates lean bulk (surplus) targets and reports a gain direction", () => {
    const result = calculateMacroTargets({
      sex: "male",
      age: 25,
      heightCm: 175,
      weightKg: 70,
      activityLevel: "light",
      goalPreset: "lean_bulk",
    });

    expect(result).toEqual({
      bmrKcal: 1674,
      tdeeKcal: 2301,
      targetCaloriesKcal: 2551,
      proteinReferenceWeightKg: 70,
      proteinReferenceType: "actual",
      proteinTargetGPerKg: 1.6,
      weeklyWeightChangeEstimateKg: 0.2,
      weeklyWeightChangeDirection: "gain",
      macros: {
        proteinG: 112,
        carbsG: 341.7,
        fatG: 81.8,
        caloriesKcal: 2551,
      },
    });
  });
});
