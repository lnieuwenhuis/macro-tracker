import {
  canAccessAdmin,
  getDailySummary,
  getPeriodAverages,
  getRecentDailyOverviews,
  getRecentQuickAddCandidates,
  getRecipes,
  getStatsPageData,
  getTemplates,
  getUserById,
  getUserGoals,
  getWeightPageData,
} from "@macro-tracker/db";

import type { SessionUser } from "@macro-tracker/db";

import {
  type AppWarmupPayload,
  type AppWarmupScope,
  getNearbyDateStrings,
} from "./app-warmup";

export type AppWarmupBuilderDeps = {
  getUserById: typeof getUserById;
  getUserGoals: typeof getUserGoals;
  getTemplates: typeof getTemplates;
  getRecipes: typeof getRecipes;
  getRecentQuickAddCandidates: typeof getRecentQuickAddCandidates;
  getDailySummary: typeof getDailySummary;
  getPeriodAverages: typeof getPeriodAverages;
  getRecentDailyOverviews: typeof getRecentDailyOverviews;
  getStatsPageData: typeof getStatsPageData;
  getWeightPageData: typeof getWeightPageData;
};

const defaultDeps: AppWarmupBuilderDeps = {
  getUserById,
  getUserGoals,
  getTemplates,
  getRecipes,
  getRecentQuickAddCandidates,
  getDailySummary,
  getPeriodAverages,
  getRecentDailyOverviews,
  getStatsPageData,
  getWeightPageData,
};

export async function buildAppWarmupPayload({
  sessionUser,
  selectedDate,
  scope = "core",
  deps = defaultDeps,
}: {
  sessionUser: SessionUser;
  selectedDate: string;
  scope?: AppWarmupScope;
  deps?: AppWarmupBuilderDeps;
}): Promise<AppWarmupPayload> {
  const [
    user,
    goals,
    templates,
    recipes,
    recentCandidates,
    selectedSummary,
  ] = await Promise.all([
    deps.getUserById(sessionUser.userId),
    deps.getUserGoals(sessionUser.userId),
    deps.getTemplates(sessionUser.userId),
    deps.getRecipes(sessionUser.userId),
    deps.getRecentQuickAddCandidates(sessionUser.userId),
    deps.getDailySummary(sessionUser.userId, selectedDate),
  ]);

  let days: AppWarmupPayload["days"] = {
    [selectedDate]: selectedSummary,
  };
  let summary: AppWarmupPayload["summary"];
  let weight: AppWarmupPayload["weight"];

  if (scope === "extended") {
    const { previousDate, nextDate } = getNearbyDateStrings(selectedDate);
    const [
      previousSummary,
      nextSummary,
      periodAverages,
      recentOverviews,
      statsData,
      weightData,
    ] = await Promise.all([
      deps.getDailySummary(sessionUser.userId, previousDate),
      deps.getDailySummary(sessionUser.userId, nextDate),
      deps.getPeriodAverages(sessionUser.userId, selectedDate),
      deps.getRecentDailyOverviews(sessionUser.userId, selectedDate),
      deps.getStatsPageData(sessionUser.userId, selectedDate),
      deps.getWeightPageData(sessionUser.userId, selectedDate),
    ]);

    days = {
      [previousDate]: previousSummary,
      [selectedDate]: selectedSummary,
      [nextDate]: nextSummary,
    };
    summary = {
      periodAverages,
      recentOverviews,
      statsData,
    };
    weight = weightData;
  }

  return {
    user: {
      email: user?.email ?? sessionUser.email,
      canAccessAdmin: user ? canAccessAdmin(user.role) : false,
    },
    goals,
    templates,
    recipes,
    recentCandidates,
    days,
    summary,
    weight,
  };
}
