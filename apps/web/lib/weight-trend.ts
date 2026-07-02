import { addDays, format, parseISO } from "date-fns";

import type { WeightPageData } from "@macro-tracker/db";

export type WeightGoalProjection = {
  status:
    | "insufficient_data"
    | "no_goal"
    | "at_goal"
    | "moving_toward"
    | "moving_away"
    | "maintaining";
  currentWeightKg: number | null;
  goalWeightKg: number | null;
  goalDeltaKg: number | null;
  weeklyRateKg: number | null;
  estimatedGoalDate: string | null;
  daysToGoal: number | null;
  message: string;
};

const GOAL_EPSILON_KG = 0.1;
const RATE_EPSILON_KG_PER_WEEK = 0.05;
const RECENT_TREND_WINDOW_DAYS = 30;

function roundToSingleDecimal(value: number) {
  return Math.round(value * 10) / 10;
}

function roundToTwoDecimals(value: number) {
  return Math.round(value * 100) / 100;
}

function daysBetween(startDate: string, endDate: string) {
  const start = parseISO(startDate).getTime();
  const end = parseISO(endDate).getTime();
  const diff = Math.round((end - start) / (24 * 60 * 60 * 1000));
  return Math.max(0, diff);
}

function getRecentTrendEntries(entries: WeightPageData["entries"]) {
  const sortedEntries = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sortedEntries[sortedEntries.length - 1];
  if (!latest) {
    return [];
  }

  const latestTime = parseISO(latest.date).getTime();
  const windowStartTime = latestTime - RECENT_TREND_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recentEntries = sortedEntries.filter(
    (entry) => parseISO(entry.date).getTime() >= windowStartTime,
  );

  return recentEntries.length >= 2 ? recentEntries : sortedEntries.slice(-2);
}

export function buildWeightGoalProjection(
  weightData: WeightPageData,
  referenceDate: string,
): WeightGoalProjection {
  const currentWeightKg = weightData.stats.currentWeight;
  const goalWeightKg = weightData.goalWeightKg;

  if (goalWeightKg == null) {
    return {
      status: "no_goal",
      currentWeightKg,
      goalWeightKg,
      goalDeltaKg: null,
      weeklyRateKg: null,
      estimatedGoalDate: null,
      daysToGoal: null,
      message: "Set a goal weight to see a projection.",
    };
  }

  if (currentWeightKg == null || weightData.entries.length < 2) {
    return {
      status: "insufficient_data",
      currentWeightKg,
      goalWeightKg,
      goalDeltaKg: currentWeightKg != null
        ? roundToSingleDecimal(goalWeightKg - currentWeightKg)
        : null,
      weeklyRateKg: null,
      estimatedGoalDate: null,
      daysToGoal: null,
      message: "Log at least two weight entries to calculate a trend.",
    };
  }

  const recentEntries = getRecentTrendEntries(weightData.entries);
  const latest = recentEntries[recentEntries.length - 1]!;
  const earliest = recentEntries[0]!;
  const elapsedDays = daysBetween(earliest.date, latest.date);
  const goalDeltaKg = roundToSingleDecimal(goalWeightKg - latest.weightKg);
  const absGoalDelta = Math.abs(goalDeltaKg);

  if (absGoalDelta <= GOAL_EPSILON_KG) {
    return {
      status: "at_goal",
      currentWeightKg,
      goalWeightKg,
      goalDeltaKg: 0,
      weeklyRateKg: 0,
      estimatedGoalDate: referenceDate,
      daysToGoal: 0,
      message: "You are effectively at your current goal weight.",
    };
  }

  if (elapsedDays === 0) {
    return {
      status: "insufficient_data",
      currentWeightKg,
      goalWeightKg,
      goalDeltaKg,
      weeklyRateKg: null,
      estimatedGoalDate: null,
      daysToGoal: null,
      message: "Use entries on different dates to calculate a projection.",
    };
  }

  const dailyRateKg = (latest.weightKg - earliest.weightKg) / elapsedDays;
  const weeklyRateKg = roundToTwoDecimals(dailyRateKg * 7);
  const movingTowardGoal =
    (goalDeltaKg < 0 && dailyRateKg < -RATE_EPSILON_KG_PER_WEEK / 7) ||
    (goalDeltaKg > 0 && dailyRateKg > RATE_EPSILON_KG_PER_WEEK / 7);
  const movingAwayFromGoal =
    (goalDeltaKg < 0 && dailyRateKg > RATE_EPSILON_KG_PER_WEEK / 7) ||
    (goalDeltaKg > 0 && dailyRateKg < -RATE_EPSILON_KG_PER_WEEK / 7);

  if (!movingTowardGoal && !movingAwayFromGoal) {
    return {
      status: "maintaining",
      currentWeightKg,
      goalWeightKg,
      goalDeltaKg,
      weeklyRateKg,
      estimatedGoalDate: null,
      daysToGoal: null,
      message: "Your recent weight trend is roughly flat.",
    };
  }

  if (movingAwayFromGoal) {
    return {
      status: "moving_away",
      currentWeightKg,
      goalWeightKg,
      goalDeltaKg,
      weeklyRateKg,
      estimatedGoalDate: null,
      daysToGoal: null,
      message: "Your recent trend is moving away from the current goal.",
    };
  }

  const daysToGoal = Math.ceil(absGoalDelta / Math.abs(dailyRateKg));
  const estimatedGoalDate = format(addDays(parseISO(latest.date), daysToGoal), "yyyy-MM-dd");

  return {
    status: "moving_toward",
    currentWeightKg,
    goalWeightKg,
    goalDeltaKg,
    weeklyRateKg,
    estimatedGoalDate,
    daysToGoal,
    message: "Your recent trend is moving toward the current goal.",
  };
}
