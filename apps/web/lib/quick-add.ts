import type { FoodPreset, MacroGoals, MacroNumbers, QuickAddCandidate } from "@macro-tracker/db";

import type { MealDraft } from "@/components/meal-card";

type RemainingStatus = "left" | "hit" | "over" | "unset";

type RemainingMetric = {
  goal: number | null;
  remaining: number | null;
  status: RemainingStatus;
};

export type RemainingMacros = {
  caloriesKcal: RemainingMetric;
  proteinG: RemainingMetric;
  carbsG: RemainingMetric;
  fatG: RemainingMetric;
};

type MacroField = keyof MacroNumbers;

function toDraftNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundForField(field: MacroField, value: number) {
  if (field === "caloriesKcal") {
    return Math.round(value);
  }

  return Math.round(value * 10) / 10;
}

function normalizeSignedZero(value: number) {
  return Object.is(value, -0) ? 0 : value;
}

function normalizeQuickAddLabel(label: string) {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function getQuickAddKey(candidate: Pick<QuickAddCandidate, "label" | "proteinG" | "carbsG" | "fatG" | "caloriesKcal">) {
  return [
    normalizeQuickAddLabel(candidate.label),
    roundForField("proteinG", candidate.proteinG),
    roundForField("carbsG", candidate.carbsG),
    roundForField("fatG", candidate.fatG),
    roundForField("caloriesKcal", candidate.caloriesKcal),
  ].join("|");
}

function compareNumberAsc(left: number, right: number) {
  return left - right;
}

function compareNumberDesc(left: number, right: number) {
  return right - left;
}

function getRecencyValue(sourceDate: string | null) {
  return sourceDate ? Date.parse(sourceDate) : 0;
}

function buildRemainingMetric(
  field: MacroField,
  goal: number | null,
  consumed: number,
): RemainingMetric {
  if (goal == null) {
    return {
      goal: null,
      remaining: null,
      status: "unset",
    };
  }

  const remaining = normalizeSignedZero(roundForField(field, goal - consumed));
  const status =
    remaining > 0 ? "left"
    : remaining < 0 ? "over"
    : "hit";

  return {
    goal,
    remaining,
    status,
  };
}

export function hasAnyMacroGoals(goals: MacroGoals | null | undefined) {
  return Boolean(
    goals &&
      (goals.caloriesKcal != null ||
        goals.proteinG != null ||
        goals.carbsG != null ||
        goals.fatG != null),
  );
}

export function computeLiveTotalsFromDrafts(drafts: MealDraft[]): MacroNumbers {
  return drafts.reduce(
    (totals, draft) => ({
      proteinG: roundForField("proteinG", totals.proteinG + toDraftNumber(draft.proteinG)),
      carbsG: roundForField("carbsG", totals.carbsG + toDraftNumber(draft.carbsG)),
      fatG: roundForField("fatG", totals.fatG + toDraftNumber(draft.fatG)),
      caloriesKcal: roundForField(
        "caloriesKcal",
        totals.caloriesKcal + toDraftNumber(draft.caloriesKcal),
      ),
    }),
    {
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      caloriesKcal: 0,
    } satisfies MacroNumbers,
  );
}

export function computeRemainingFromGoals(
  totals: MacroNumbers,
  goals: MacroGoals | null | undefined,
): RemainingMacros {
  return {
    caloriesKcal: buildRemainingMetric(
      "caloriesKcal",
      goals?.caloriesKcal ?? null,
      totals.caloriesKcal,
    ),
    proteinG: buildRemainingMetric("proteinG", goals?.proteinG ?? null, totals.proteinG),
    carbsG: buildRemainingMetric("carbsG", goals?.carbsG ?? null, totals.carbsG),
    fatG: buildRemainingMetric("fatG", goals?.fatG ?? null, totals.fatG),
  };
}

export function presetToQuickAddCandidate(preset: FoodPreset): QuickAddCandidate {
  return {
    source: "preset",
    sourceId: preset.id,
    label: preset.label,
    proteinG: preset.proteinG,
    carbsG: preset.carbsG,
    fatG: preset.fatG,
    caloriesKcal: preset.caloriesKcal,
    sourceDate: null,
  };
}

export function dedupeBestFitCandidates(candidates: QuickAddCandidate[]) {
  const deduped = new Map<string, QuickAddCandidate>();

  for (const candidate of candidates) {
    const key = getQuickAddKey(candidate);
    const existing = deduped.get(key);

    if (!existing) {
      deduped.set(key, candidate);
      continue;
    }

    if (existing.source !== "preset" && candidate.source === "preset") {
      deduped.set(key, candidate);
    }
  }

  return Array.from(deduped.values());
}

export function rankQuickAddCandidates(
  candidates: QuickAddCandidate[],
  remaining: RemainingMacros,
) {
  const hasGoals = Object.values(remaining).some((metric) => metric.goal != null);
  if (!hasGoals) {
    return [...candidates].sort((left, right) => {
      const recencyComparison = compareNumberDesc(
        getRecencyValue(left.sourceDate),
        getRecencyValue(right.sourceDate),
      );
      if (recencyComparison !== 0) {
        return recencyComparison;
      }

      return left.label.localeCompare(right.label);
    });
  }

  const clampedProteinRemaining = Math.max(remaining.proteinG.remaining ?? 0, 0);
  const clampedCaloriesRemaining = Math.max(remaining.caloriesKcal.remaining ?? 0, 0);
  const clampedCarbsRemaining = Math.max(remaining.carbsG.remaining ?? 0, 0);
  const clampedFatRemaining = Math.max(remaining.fatG.remaining ?? 0, 0);

  return [...candidates].sort((left, right) => {
    if (clampedProteinRemaining > 0) {
      const proteinGapComparison = compareNumberAsc(
        Math.max(clampedProteinRemaining - left.proteinG, 0),
        Math.max(clampedProteinRemaining - right.proteinG, 0),
      );
      if (proteinGapComparison !== 0) {
        return proteinGapComparison;
      }

      const usefulProteinComparison = compareNumberDesc(
        Math.min(left.proteinG, clampedProteinRemaining),
        Math.min(right.proteinG, clampedProteinRemaining),
      );
      if (usefulProteinComparison !== 0) {
        return usefulProteinComparison;
      }
    }

    if (remaining.caloriesKcal.goal != null) {
      const calorieOvershootComparison = compareNumberAsc(
        Math.max(left.caloriesKcal - clampedCaloriesRemaining, 0),
        Math.max(right.caloriesKcal - clampedCaloriesRemaining, 0),
      );
      if (calorieOvershootComparison !== 0) {
        return calorieOvershootComparison;
      }

      const calorieDistanceComparison = compareNumberAsc(
        Math.abs(left.caloriesKcal - clampedCaloriesRemaining),
        Math.abs(right.caloriesKcal - clampedCaloriesRemaining),
      );
      if (calorieDistanceComparison !== 0) {
        return calorieDistanceComparison;
      }
    }

    const macroDistanceComparison = compareNumberAsc(
      Math.abs(left.carbsG - clampedCarbsRemaining) +
        Math.abs(left.fatG - clampedFatRemaining),
      Math.abs(right.carbsG - clampedCarbsRemaining) +
        Math.abs(right.fatG - clampedFatRemaining),
    );
    if (macroDistanceComparison !== 0) {
      return macroDistanceComparison;
    }

    const recencyComparison = compareNumberDesc(
      getRecencyValue(left.sourceDate),
      getRecencyValue(right.sourceDate),
    );
    if (recencyComparison !== 0) {
      return recencyComparison;
    }

    return left.label.localeCompare(right.label);
  });
}
