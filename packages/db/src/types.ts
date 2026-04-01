export type MacroNumbers = {
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
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
