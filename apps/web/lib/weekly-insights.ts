import type { MacroGoals, StatsPageData } from "@macro-tracker/db";

export type WeeklyInsightTone = "good" | "warning" | "info";

export type WeeklyInsight = {
  id: string;
  title: string;
  value: string;
  body: string;
  tone: WeeklyInsightTone;
};

function formatSigned(value: number) {
  return value > 0 ? `+${value}` : String(value);
}

function pushInsight(
  insights: WeeklyInsight[],
  insight: WeeklyInsight,
  limit: number,
) {
  if (insights.length < limit) {
    insights.push(insight);
  }
}

export function buildWeeklyInsights(
  stats: StatsPageData,
  goals: MacroGoals,
  limit = 5,
): WeeklyInsight[] {
  if (stats.totalDaysTracked === 0) {
    return [
      {
        id: "no-data",
        title: "Start the trend",
        value: "0 days",
        body: "Log a few meals and this panel will summarize what is changing week to week.",
        tone: "info",
      },
    ];
  }

  const insights: WeeklyInsight[] = [];
  const calorieHitRate = stats.goalHitRates.days7.caloriesKcal;
  if (calorieHitRate != null) {
    pushInsight(
      insights,
      calorieHitRate >= 70
        ? {
            id: "calorie-adherence-strong",
            title: "Calories are steady",
            value: `${calorieHitRate}%`,
            body: "Your logged days are landing inside the calorie target band this week.",
            tone: "good",
          }
        : calorieHitRate < 40
          ? {
              id: "calorie-adherence-low",
              title: "Calories are drifting",
              value: `${calorieHitRate}%`,
              body: "Fewer logged days are landing near your calorie target this week.",
              tone: "warning",
            }
          : {
              id: "calorie-adherence-mixed",
              title: "Calories are mixed",
              value: `${calorieHitRate}%`,
              body: "You are hitting some calorie targets, but the week is not fully consistent yet.",
              tone: "info",
            },
      limit,
    );
  } else if (goals.caloriesKcal == null) {
    pushInsight(
      insights,
      {
        id: "missing-calorie-goal",
        title: "No calorie target",
        value: "Not set",
        body: "Set a calorie goal to unlock adherence and energy-balance insights.",
        tone: "info",
      },
      limit,
    );
  }

  const consistency = stats.macroConsistency.score;
  if (consistency != null) {
    pushInsight(
      insights,
      consistency >= 85
        ? {
            id: "consistency-strong",
            title: "Routine is tight",
            value: `${consistency}%`,
            body: "Your calorie intake is staying close to the target from day to day.",
            tone: "good",
          }
        : consistency <= 65
          ? {
              id: "consistency-low",
              title: "Routine is jumpy",
              value: `${consistency}%`,
              body: "Your logged calories are varying enough that planning a default day may help.",
              tone: "warning",
            }
          : {
              id: "consistency-mid",
              title: "Routine is forming",
              value: `${consistency}%`,
              body: "Your calorie pattern has a workable base, with room to tighten it up.",
              tone: "info",
            },
      limit,
    );
  }

  const dailyDelta = stats.estimatedEnergyBalance.averageDailyDeltaKcal;
  const weeklyWeight = stats.estimatedEnergyBalance.estimatedWeeklyWeightChangeKg;
  if (dailyDelta != null) {
    const absDelta = Math.abs(dailyDelta);
    pushInsight(
      insights,
      {
        id: dailyDelta > 0 ? "energy-surplus" : dailyDelta < 0 ? "energy-deficit" : "energy-even",
        title:
          absDelta <= 100
            ? "Energy is near target"
            : dailyDelta > 0
              ? "Energy is above target"
              : "Energy is below target",
        value: `${formatSigned(dailyDelta)} kcal/day`,
        body:
          weeklyWeight != null
            ? `That averages to about ${formatSigned(weeklyWeight)} kg per week against your current target.`
            : "This compares your average logged calories with your current target.",
        tone: absDelta <= 100 ? "good" : "warning",
      },
      limit,
    );
  }

  if (stats.proteinPerKg != null) {
    pushInsight(
      insights,
      {
        id: "protein-density",
        title: "Protein density",
        value: `${stats.proteinPerKg}g/kg`,
        body:
          stats.proteinPerKg >= 1.6
            ? "Your average protein intake is in a strong range for your latest logged weight."
            : "Your average protein per kg is below a common strength-focused target.",
        tone: stats.proteinPerKg >= 1.6 ? "good" : "info",
      },
      limit,
    );
  } else if (goals.proteinG == null) {
    pushInsight(
      insights,
      {
        id: "missing-protein-goal",
        title: "No protein target",
        value: "Not set",
        body: "Set a protein goal or log weight to make protein trends more useful.",
        tone: "info",
      },
      limit,
    );
  }

  if (stats.plannedAdherence.adherencePct != null) {
    const pct = stats.plannedAdherence.adherencePct;
    pushInsight(
      insights,
      {
        id: "planning-adherence",
        title: "Plan follow-through",
        value: `${pct}%`,
        body:
          pct >= 70
            ? "Most planned entries are becoming eaten entries."
            : "Some planned entries are being skipped or left planned, so the plan may need trimming.",
        tone: pct >= 70 ? "good" : "info",
      },
      limit,
    );
  }

  if (insights.length < limit && stats.currentStreak > 0) {
    pushInsight(
      insights,
      {
        id: "current-streak",
        title: "Logging streak",
        value: `${stats.currentStreak} day${stats.currentStreak === 1 ? "" : "s"}`,
        body: `Your best streak is ${stats.longestStreak} day${stats.longestStreak === 1 ? "" : "s"}.`,
        tone: "good",
      },
      limit,
    );
  }

  if (insights.length < limit && stats.topLabels.length > 0) {
    const top = stats.topLabels[0]!;
    pushInsight(
      insights,
      {
        id: "top-food",
        title: "Most repeated food",
        value: top.label,
        body: `Logged ${top.count} time${top.count === 1 ? "" : "s"} in your history.`,
        tone: "info",
      },
      limit,
    );
  }

  return insights.slice(0, limit);
}
