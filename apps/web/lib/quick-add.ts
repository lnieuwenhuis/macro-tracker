import type { MacroGoals, MacroNumbers, QuickAddCandidate } from "@macro-tracker/db";

import type { MealDraft } from "@/components/meal-card";

// ---------------------------------------------------------------------------
// Live totals
// ---------------------------------------------------------------------------

function parseDraftValue(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Compute macro totals from the current draft array (unsaved edits included). */
export function computeLiveTotals(drafts: MealDraft[]): MacroNumbers {
  let proteinG = 0;
  let carbsG = 0;
  let fatG = 0;
  let caloriesKcal = 0;

  for (const draft of drafts) {
    proteinG += parseDraftValue(draft.proteinG);
    carbsG += parseDraftValue(draft.carbsG);
    fatG += parseDraftValue(draft.fatG);
    caloriesKcal += parseDraftValue(draft.caloriesKcal);
  }

  return {
    proteinG: Math.round(proteinG * 10) / 10,
    carbsG: Math.round(carbsG * 10) / 10,
    fatG: Math.round(fatG * 10) / 10,
    caloriesKcal: Math.round(caloriesKcal),
  };
}

// ---------------------------------------------------------------------------
// Remaining macros
// ---------------------------------------------------------------------------

export type RemainingMacros = {
  caloriesKcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
};

/**
 * Subtract totals from goals. Returns null for any dimension that has no goal.
 * Values can be negative (meaning the user has gone over goal for that macro).
 */
export function computeRemaining(
  totals: MacroNumbers,
  goals: MacroGoals,
): RemainingMacros {
  return {
    caloriesKcal:
      goals.caloriesKcal !== null
        ? goals.caloriesKcal - totals.caloriesKcal
        : null,
    proteinG:
      goals.proteinG !== null ? goals.proteinG - totals.proteinG : null,
    carbsG: goals.carbsG !== null ? goals.carbsG - totals.carbsG : null,
    fatG: goals.fatG !== null ? goals.fatG - totals.fatG : null,
  };
}

/** Returns true when at least one goal dimension is configured. */
export function hasAnyGoal(goals: MacroGoals): boolean {
  return (
    goals.caloriesKcal !== null ||
    goals.proteinG !== null ||
    goals.carbsG !== null ||
    goals.fatG !== null
  );
}

// ---------------------------------------------------------------------------
// Candidate deduplication
// ---------------------------------------------------------------------------

function candidateKey(c: QuickAddCandidate): string {
  return `${c.label.toLowerCase().trim()}|${c.proteinG}|${c.carbsG}|${c.fatG}|${c.caloriesKcal}`;
}

/**
 * Merge preset + recent history candidates, preferring the preset record when
 * label + macros are identical (avoids near-duplicate suggestions).
 */
export function deduplicateCandidates(
  candidates: QuickAddCandidate[],
): QuickAddCandidate[] {
  const map = new Map<string, QuickAddCandidate>();

  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const existing = map.get(key);

    if (!existing) {
      map.set(key, candidate);
    } else if (candidate.source === "preset" && existing.source === "recent") {
      // Prefer the preset entry over the history entry
      map.set(key, candidate);
    }
    // If both are the same source type, keep the one already stored (first wins)
  }

  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

function scoreCandidate(
  candidate: QuickAddCandidate,
  remaining: RemainingMacros,
): number {
  let score = 0;

  // 1. Protein contribution — highest priority (weight ×3)
  if (remaining.proteinG !== null) {
    const remainingClamped = Math.max(0, remaining.proteinG);
    const contribution = Math.min(candidate.proteinG, remainingClamped);
    score += contribution * 3;
  }

  // 2. Calorie proximity — reward fitting within budget; penalise overshoot
  if (remaining.caloriesKcal !== null) {
    const calBudget = Math.max(0, remaining.caloriesKcal);
    if (candidate.caloriesKcal <= calBudget) {
      // The closer to the budget the better (max bonus at ≤200 kcal gap)
      const gap = calBudget - candidate.caloriesKcal;
      score += Math.max(0, 200 - gap) * 0.5;
    } else {
      // Overshoot: penalise proportionally
      const overshoot = candidate.caloriesKcal - calBudget;
      score -= overshoot * 1.5;
    }
  }

  // 3. Carb contribution (weight ×0.5)
  if (remaining.carbsG !== null) {
    const carbBudget = Math.max(0, remaining.carbsG);
    const contribution = Math.min(candidate.carbsG, carbBudget);
    score += contribution * 0.5;
  }

  // 4. Fat contribution (weight ×0.5)
  if (remaining.fatG !== null) {
    const fatBudget = Math.max(0, remaining.fatG);
    const contribution = Math.min(candidate.fatG, fatBudget);
    score += contribution * 0.5;
  }

  return score;
}

/**
 * Rank a mixed pool of preset + recent candidates against the remaining macros.
 * Deduplicates first, then scores, then uses recency as the final tie-breaker.
 */
export function rankCandidates(
  candidates: QuickAddCandidate[],
  remaining: RemainingMacros,
  limit = 10,
): QuickAddCandidate[] {
  const pool = deduplicateCandidates(candidates);

  return pool
    .map((c) => ({ candidate: c, score: scoreCandidate(c, remaining) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Recency tie-breaker: more recent first. Presets with no date sort last.
      const aDate = a.candidate.sourceDate ?? "";
      const bDate = b.candidate.sourceDate ?? "";
      return bDate.localeCompare(aDate);
    })
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

// ---------------------------------------------------------------------------
// Recent repeats (always shown, no goal required)
// ---------------------------------------------------------------------------

/**
 * Return the N most-recently-used unique foods from the candidate pool.
 * Presets without a sourceDate come after any history entry with a date.
 */
export function getRecentRepeats(
  candidates: QuickAddCandidate[],
  limit = 10,
): QuickAddCandidate[] {
  // Sort most-recent first before deduplication so dedup keeps the right one
  const sorted = [...candidates].sort((a, b) => {
    const aDate = a.sourceDate ?? "";
    const bDate = b.sourceDate ?? "";
    return bDate.localeCompare(aDate);
  });

  return deduplicateCandidates(sorted).slice(0, limit);
}
