import type {
  DailyOverview,
  DailySummary,
  MacroGoals,
  MealTemplate,
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
  templates: MealTemplate[];
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

export type AppWarmupScope = "core" | "extended";

export type AppWarmupCacheKey =
  | "goals"
  | "templates"
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

export function normalizeAppWarmupScope(
  value: string | null | undefined,
): AppWarmupScope | undefined {
  if (!value || value === "core") {
    return "core";
  }

  return value === "extended" ? "extended" : undefined;
}

export function getDailyMutationCacheKeys(date: string): AppWarmupCacheKey[] {
  return [`dailySummary:${date}`, `summary:${date}`, "stats"];
}

export function getGoalsMutationCacheKeys(date?: string): AppWarmupCacheKey[] {
  return date ? ["goals", `summary:${date}`, "stats"] : ["goals", "stats"];
}

export function getTemplateMutationCacheKeys(): AppWarmupCacheKey[] {
  return ["templates"];
}

export function getRecipeMutationCacheKeys(date?: string): AppWarmupCacheKey[] {
  return date ? ["recipes", ...getDailyMutationCacheKeys(date)] : ["recipes"];
}

export function getWeightMutationCacheKeys(date: string): AppWarmupCacheKey[] {
  return [`weight:${date}`, "stats"];
}
