import {
  canAccessAdmin,
  getDailySummary,
  getPeriodAverages,
  getPresets,
  getRecentDailyOverviews,
  getRecentQuickAddCandidates,
  getRecipes,
  getStatsPageData,
  getUserById,
  getUserGoals,
  getWeightPageData,
} from "@macro-tracker/db";

import type { SessionUser } from "@macro-tracker/db";

import {
  type AppWarmupPayload,
  getNearbyDateStrings,
} from "./app-warmup";

export type AppWarmupBuilderDeps = {
  getUserById: typeof getUserById;
  getUserGoals: typeof getUserGoals;
  getPresets: typeof getPresets;
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
  getPresets,
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
  deps = defaultDeps,
}: {
  sessionUser: SessionUser;
  selectedDate: string;
  deps?: AppWarmupBuilderDeps;
}): Promise<AppWarmupPayload> {
  const { previousDate, nextDate } = getNearbyDateStrings(selectedDate);

  const [
    user,
    goals,
    presets,
    recipes,
    recentCandidates,
    previousSummary,
    selectedSummary,
    nextSummary,
    periodAverages,
    recentOverviews,
    statsData,
    weight,
  ] = await Promise.all([
    deps.getUserById(sessionUser.userId),
    deps.getUserGoals(sessionUser.userId),
    deps.getPresets(sessionUser.userId),
    deps.getRecipes(sessionUser.userId),
    deps.getRecentQuickAddCandidates(sessionUser.userId),
    deps.getDailySummary(sessionUser.userId, previousDate),
    deps.getDailySummary(sessionUser.userId, selectedDate),
    deps.getDailySummary(sessionUser.userId, nextDate),
    deps.getPeriodAverages(sessionUser.userId, selectedDate),
    deps.getRecentDailyOverviews(sessionUser.userId, selectedDate),
    deps.getStatsPageData(sessionUser.userId, selectedDate),
    deps.getWeightPageData(sessionUser.userId, selectedDate),
  ]);

  return {
    user: {
      email: user?.email ?? sessionUser.email,
      canAccessAdmin: user ? canAccessAdmin(user.role) : false,
    },
    goals,
    presets,
    recipes,
    recentCandidates,
    days: {
      [previousDate]: previousSummary,
      [selectedDate]: selectedSummary,
      [nextDate]: nextSummary,
    },
    summary: {
      periodAverages,
      recentOverviews,
      statsData,
    },
    weight,
  };
}
