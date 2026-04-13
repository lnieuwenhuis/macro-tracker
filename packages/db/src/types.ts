export type MacroNumbers = {
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
};

export type MacroGoals = {
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  caloriesKcal: number | null;
};

export type MealEntryInput = {
  date: string;
  label: string;
  sortOrder: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
};

export type MealEntryRecord = MealEntryInput & {
  id: string;
  userId: string;
};

export type DailySummary = {
  date: string;
  totals: MacroNumbers;
  meals: MealEntryRecord[];
};

export type DailyOverview = {
  date: string;
  totals: MacroNumbers;
  itemCount: number;
};

export type PeriodAverageLabel = "week" | "month" | "rolling7" | "rolling30";

export type PeriodAverage = {
  label: PeriodAverageLabel;
  startDate: string;
  endDate: string;
  loggedDays: number;
  averages: MacroNumbers;
};

export type ShooProfile = {
  pairwiseSub: string;
  email: string;
  displayName?: string | null;
  pictureUrl?: string | null;
};

export type SessionUser = {
  userId: string;
  email: string;
};

export type FoodPreset = {
  id: string;
  userId: string;
  label: string;
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
};

export type WeightEntryInput = {
  date: string;
  weightKg: number;
  bodyFatPct: number | null;
  notes: string | null;
};

export type WeightEntryRecord = WeightEntryInput & {
  id: string;
  userId: string;
};

export type WeightPageData = {
  entries: WeightEntryRecord[];
  goalWeightKg: number | null;
  stats: {
    currentWeight: number | null;
    weekChange: number | null;
    monthChange: number | null;
    trendDirection: "up" | "down" | "stable" | null;
  };
};

export type RecipeIngredientInput = {
  label: string;
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
};

export type RecipeIngredientRecord = RecipeIngredientInput & {
  id: string;
  recipeId: string;
  sortOrder: number;
};

export type RecipeInput = {
  label: string;
  portions: number;
  ingredients: RecipeIngredientInput[];
};

export type RecipeRecord = {
  id: string;
  userId: string;
  label: string;
  portions: number;
  ingredients: RecipeIngredientRecord[];
  totalMacros: MacroNumbers;
  perPortionMacros: MacroNumbers;
};

export type CustomBarcodeProductInput = {
  barcode: string;
  name: string;
  brands: string;
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
  servingSizeG: number | null;
};

export type CustomBarcodeProduct = CustomBarcodeProductInput & {
  id: string;
  addedByUserId: string | null;
};

export type StatsPageData = {
  allDailyTotals: Array<{
    date: string;
    proteinG: number;
    carbsG: number;
    fatG: number;
    caloriesKcal: number;
  }>;
  totalDaysTracked: number;
  currentStreak: number;
  longestStreak: number;
  totalProteinG: number;
  totalCarbsG: number;
  totalFatG: number;
  totalCaloriesKcal: number;
  bestCalorieDay: { date: string; caloriesKcal: number } | null;
  topLabels: Array<{ label: string; count: number }>;
};
