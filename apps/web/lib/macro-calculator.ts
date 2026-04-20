function roundToSingleDecimal(value: number) {
  return Math.round(value * 10) / 10;
}

export function getWeeklyWeightChangeEstimateKg(calorieAdjustmentKcal: number) {
  return roundToSingleDecimal(Math.abs(calorieAdjustmentKcal) * 7 / 7700);
}

export const ACTIVITY_LEVEL_OPTIONS = [
  {
    id: "sedentary",
    label: "Sedentary",
    description: "Desk job, little to no exercise",
    multiplier: 1.2,
  },
  {
    id: "light",
    label: "Lightly active",
    description: "Training or sports 1 to 3 days per week",
    multiplier: 1.375,
  },
  {
    id: "moderate",
    label: "Moderately active",
    description: "Training or sports 3 to 5 days per week",
    multiplier: 1.55,
  },
  {
    id: "very",
    label: "Very active",
    description: "Training or sports 6 to 7 days per week",
    multiplier: 1.725,
  },
  {
    id: "extra",
    label: "Extra active",
    description: "Physical job and regular hard training",
    multiplier: 1.9,
  },
] as const;

export const GOAL_PRESET_OPTIONS = [
  {
    id: "aggressive_cut",
    label: "Aggressive cut",
    description: "Faster fat loss with a larger deficit",
    calorieAdjustmentKcal: -1000,
    proteinTargetGPerKg: 2,
    macroSplit: { carbs: 0.5, fat: 0.5 },
  },
  {
    id: "moderate_cut",
    label: "Moderate cut",
    description: "Steadier fat loss with a smaller deficit",
    calorieAdjustmentKcal: -500,
    proteinTargetGPerKg: 1.8,
    macroSplit: { carbs: 0.5, fat: 0.5 },
  },
  {
    id: "maintain",
    label: "Maintain",
    description: "Hold body weight and support training",
    calorieAdjustmentKcal: 0,
    proteinTargetGPerKg: 1.6,
    macroSplit: { carbs: 0.6, fat: 0.4 },
  },
  {
    id: "lean_bulk",
    label: "Lean bulk",
    description: "Slow muscle gain with a modest surplus",
    calorieAdjustmentKcal: 250,
    proteinTargetGPerKg: 1.6,
    macroSplit: { carbs: 0.65, fat: 0.35 },
  },
  {
    id: "aggressive_bulk",
    label: "Aggressive bulk",
    description: "Faster scale gain with a larger surplus",
    calorieAdjustmentKcal: 500,
    proteinTargetGPerKg: 1.6,
    macroSplit: { carbs: 0.65, fat: 0.35 },
  },
] as const;

export type MacroCalculatorSex = "male" | "female";
export type ActivityLevelId = (typeof ACTIVITY_LEVEL_OPTIONS)[number]["id"];
export type GoalPresetId = (typeof GOAL_PRESET_OPTIONS)[number]["id"];

export type MacroCalculatorInput = {
  sex: MacroCalculatorSex;
  age: number;
  heightCm: number;
  weightKg: number;
  activityLevel: ActivityLevelId;
  goalPreset: GoalPresetId;
};

export type MacroCalculationResult = {
  bmrKcal: number;
  tdeeKcal: number;
  targetCaloriesKcal: number;
  proteinReferenceWeightKg: number;
  proteinReferenceType: "actual" | "adjusted";
  proteinTargetGPerKg: number;
  weeklyWeightChangeEstimateKg: number;
  weeklyWeightChangeDirection: "loss" | "gain" | "maintain";
  macros: {
    proteinG: number;
    carbsG: number;
    fatG: number;
    caloriesKcal: number;
  };
};

function getActivityLevel(activityLevel: ActivityLevelId) {
  const option = ACTIVITY_LEVEL_OPTIONS.find((item) => item.id === activityLevel);
  if (!option) {
    throw new Error(`Unknown activity level: ${activityLevel}`);
  }

  return option;
}

function getGoalPreset(goalPreset: GoalPresetId) {
  const option = GOAL_PRESET_OPTIONS.find((item) => item.id === goalPreset);
  if (!option) {
    throw new Error(`Unknown goal preset: ${goalPreset}`);
  }

  return option;
}

function getProteinReferenceWeight(weightKg: number, heightCm: number) {
  const heightM = heightCm / 100;
  const bmi25WeightKg = 25 * heightM * heightM;

  if (weightKg <= bmi25WeightKg) {
    return {
      weightKg: weightKg,
      type: "actual" as const,
    };
  }

  const adjustedWeightKg = bmi25WeightKg + 0.25 * (weightKg - bmi25WeightKg);

  return {
    weightKg: adjustedWeightKg,
    type: "adjusted" as const,
  };
}

function getWeeklyWeightChangeDirection(
  calorieAdjustmentKcal: number,
): MacroCalculationResult["weeklyWeightChangeDirection"] {
  if (calorieAdjustmentKcal < 0) return "loss";
  if (calorieAdjustmentKcal > 0) return "gain";
  return "maintain";
}

export function calculateMacroTargets(
  input: MacroCalculatorInput,
): MacroCalculationResult {
  const activity = getActivityLevel(input.activityLevel);
  const preset = getGoalPreset(input.goalPreset);

  const bmr =
    input.sex === "male"
      ? 10 * input.weightKg + 6.25 * input.heightCm - 5 * input.age + 5
      : 10 * input.weightKg + 6.25 * input.heightCm - 5 * input.age - 161;

  const bmrKcal = Math.round(bmr);
  const tdeeKcal = Math.round(bmr * activity.multiplier);
  const rawTargetCaloriesKcal = tdeeKcal + preset.calorieAdjustmentKcal;

  const proteinReference = getProteinReferenceWeight(
    input.weightKg,
    input.heightCm,
  );
  const proteinG = roundToSingleDecimal(
    proteinReference.weightKg * preset.proteinTargetGPerKg,
  );
  const proteinCalories = proteinG * 4;
  const targetCaloriesKcal = Math.max(
    rawTargetCaloriesKcal,
    Math.ceil(proteinCalories),
  );
  const remainingCalories = Math.max(targetCaloriesKcal - proteinCalories, 0);

  const carbsCalories = remainingCalories * preset.macroSplit.carbs;
  const fatCalories = remainingCalories * preset.macroSplit.fat;

  return {
    bmrKcal,
    tdeeKcal,
    targetCaloriesKcal,
    proteinReferenceWeightKg: roundToSingleDecimal(proteinReference.weightKg),
    proteinReferenceType: proteinReference.type,
    proteinTargetGPerKg: preset.proteinTargetGPerKg,
    weeklyWeightChangeEstimateKg: getWeeklyWeightChangeEstimateKg(
      preset.calorieAdjustmentKcal,
    ),
    weeklyWeightChangeDirection: getWeeklyWeightChangeDirection(
      preset.calorieAdjustmentKcal,
    ),
    macros: {
      proteinG,
      carbsG: roundToSingleDecimal(carbsCalories / 4),
      fatG: roundToSingleDecimal(fatCalories / 9),
      caloriesKcal: targetCaloriesKcal,
    },
  };
}
