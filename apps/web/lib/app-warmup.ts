import type {
  DailyOverview,
  DailySummary,
  FoodPreset,
  MacroGoals,
  PeriodAverage,
  QuickAddCandidate,
  RecipeRecord,
  StatsPageData,
  WeightPageData,
} from "@macro-tracker/db";

import { nextDateString, previousDateString } from "./formatting";

export type AppWarmupPayload = {
  user: {
    email: string;
    canAccessAdmin: boolean;
  };
  goals: MacroGoals;
  presets: FoodPreset[];
  recipes: RecipeRecord[];
  recentCandidates: QuickAddCandidate[];
  days: Record<string, DailySummary>;
  summary?: {
    periodAverages: PeriodAverage[];
    recentOverviews: DailyOverview[];
    statsData?: StatsPageData;
  };
  weight?: WeightPageData;
};

export type AppWarmupCacheKey =
  | "goals"
  | "presets"
  | "recipes"
  | "stats"
  | `dailySummary:${string}`
  | `summary:${string}`
  | `weight:${string}`;

export function getNearbyDateStrings(selectedDate: string) {
  return {
    previousDate: previousDateString(selectedDate),
    selectedDate,
    nextDate: nextDateString(selectedDate),
  };
}

export function getWarmupRoutes(selectedDate: string) {
  const { previousDate, nextDate } = getNearbyDateStrings(selectedDate);

  return [
    `/?date=${selectedDate}`,
    `/?date=${previousDate}`,
    `/?date=${nextDate}`,
    `/progress?date=${selectedDate}&tab=goals`,
    `/progress?date=${selectedDate}&tab=weight`,
    `/recipes?date=${selectedDate}`,
    `/summary?date=${selectedDate}`,
  ];
}

export function getDailyMutationCacheKeys(date: string): AppWarmupCacheKey[] {
  return [`dailySummary:${date}`, `summary:${date}`, "stats"];
}

export function getGoalsMutationCacheKeys(date?: string): AppWarmupCacheKey[] {
  return date ? ["goals", `summary:${date}`, "stats"] : ["goals", "stats"];
}

export function getPresetMutationCacheKeys(): AppWarmupCacheKey[] {
  return ["presets"];
}

export function getRecipeMutationCacheKeys(date?: string): AppWarmupCacheKey[] {
  return date ? ["recipes", ...getDailyMutationCacheKeys(date)] : ["recipes"];
}

export function getWeightMutationCacheKeys(date: string): AppWarmupCacheKey[] {
  return [`weight:${date}`, "stats"];
}
