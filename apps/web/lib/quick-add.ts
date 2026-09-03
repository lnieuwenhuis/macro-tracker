import type { MacroGoals, MacroNumbers, MealEntryStatus, QuickAddCandidate } from "@macro-tracker/db";

import type { MealDraft } from "@/components/meal-card";
import { roundToSingleDecimal } from "@/lib/numbers";

function parseDraftValue(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptyTotals() {
  return { proteinG: 0, carbsG: 0, fatG: 0, caloriesKcal: 0 };
}

function accumulateDraftTotals(bucket: MacroNumbers, draft: MealDraft) {
  bucket.proteinG += parseDraftValue(draft.proteinG);
  bucket.carbsG += parseDraftValue(draft.carbsG);
  bucket.fatG += parseDraftValue(draft.fatG);
  bucket.caloriesKcal += parseDraftValue(draft.caloriesKcal);
}

function roundTotals(totals: MacroNumbers): MacroNumbers {
  return {
    proteinG: roundToSingleDecimal(totals.proteinG),
    carbsG: roundToSingleDecimal(totals.carbsG),
    fatG: roundToSingleDecimal(totals.fatG),
    caloriesKcal: Math.round(totals.caloriesKcal),
  };
}

/** Compute macro totals from the current draft array (unsaved edits included). */
export function computeLiveTotals(
  drafts: MealDraft[],
  status: MealEntryStatus = "eaten",
): MacroNumbers {
  const totals = emptyTotals();

  for (const draft of drafts) {
    if (draft.status !== status) {
      continue;
    }

    accumulateDraftTotals(totals, draft);
  }

  return roundTotals(totals);
}

// Totals for every status in one pass, since the dashboard needs all three at once.
export function computeLiveTotalsByStatus(
  drafts: MealDraft[],
): Record<MealEntryStatus, MacroNumbers> {
  const totals: Record<MealEntryStatus, MacroNumbers> = {
    eaten: emptyTotals(),
    planned: emptyTotals(),
    skipped: emptyTotals(),
  };

  for (const draft of drafts) {
    const bucket = totals[draft.status];
    if (!bucket) {
      continue;
    }

    accumulateDraftTotals(bucket, draft);
  }

  return {
    eaten: roundTotals(totals.eaten),
    planned: roundTotals(totals.planned),
    skipped: roundTotals(totals.skipped),
  };
}

export type RemainingMacros = {
  caloriesKcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
};

// Subtracts totals from goals; a dimension with no goal is null, and the result may go negative.
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

export function hasAnyGoal(goals: MacroGoals): boolean {
  return (
    goals.caloriesKcal !== null ||
    goals.proteinG !== null ||
    goals.carbsG !== null ||
    goals.fatG !== null
  );
}

function candidateKey(c: QuickAddCandidate): string {
  return `${c.label.toLowerCase().trim()}|${c.proteinG}|${c.carbsG}|${c.fatG}|${c.caloriesKcal}`;
}

function newestDate(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function mergeHabitData(
  existing: QuickAddCandidate,
  incoming: QuickAddCandidate,
): Pick<QuickAddCandidate, "peakHourUtc" | "habitCount"> {
  const existingCount = existing.habitCount ?? 0;
  const incomingCount = incoming.habitCount ?? 0;

  if (incomingCount > existingCount) {
    return {
      peakHourUtc: incoming.peakHourUtc,
      habitCount: incoming.habitCount,
    };
  }

  if (existingCount > 0) {
    return {
      peakHourUtc: existing.peakHourUtc,
      habitCount: existing.habitCount,
    };
  }

  return {};
}

function mergeCandidate(
  existing: QuickAddCandidate,
  incoming: QuickAddCandidate,
): QuickAddCandidate {
  const preferIncomingPreset =
    incoming.source === "preset" && existing.source !== "preset";
  const source =
    existing.source === "preset" || incoming.source === "preset"
      ? "preset"
      : "recent";
  const sourceDate = newestDate(existing.sourceDate, incoming.sourceDate);
  const observedUseDays = Math.max(
    existing.observedUseDays ?? 0,
    incoming.observedUseDays ?? 0,
  );
  const habitData = mergeHabitData(existing, incoming);

  return {
    label: preferIncomingPreset ? incoming.label : existing.label,
    proteinG: existing.proteinG,
    carbsG: existing.carbsG,
    fatG: existing.fatG,
    caloriesKcal: existing.caloriesKcal,
    source,
    ...(sourceDate ? { sourceDate } : {}),
    ...(source === "preset"
      ? { presetId: existing.presetId ?? incoming.presetId }
      : {}),
    ...(habitData.habitCount !== undefined ? habitData : {}),
    ...(observedUseDays > 0 ? { observedUseDays } : {}),
  };
}

// Merges preset + recent-history candidates by normalized label + macros; presets keep their source identity.
export function deduplicateCandidates(
  candidates: QuickAddCandidate[],
): QuickAddCandidate[] {
  const map = new Map<string, QuickAddCandidate>();

  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const existing = map.get(key);

    if (!existing) {
      map.set(key, candidate);
    } else {
      map.set(key, mergeCandidate(existing, candidate));
    }
  }

  return Array.from(map.values());
}

// Circular distance between two UTC hours, wrapping at 24 (e.g. distance(23, 1) = 2, not 22).
function hourDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 24;
  return diff > 12 ? 24 - diff : diff;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dateStringToUtcDay(value: string): number | null {
  if (!DATE_PATTERN.test(value)) {
    return null;
  }

  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function daysSinceDate(referenceDate: string, sourceDate?: string): number | null {
  if (!sourceDate) {
    return null;
  }

  const referenceDay = dateStringToUtcDay(referenceDate);
  const sourceDay = dateStringToUtcDay(sourceDate);
  if (referenceDay === null || sourceDay === null) {
    return null;
  }

  return Math.max(0, Math.floor((referenceDay - sourceDay) / MS_PER_DAY));
}

export type RankCandidatesOptions = {
  limit?: number;
  /** Current hour in UTC, matching `peakHourUtc` on the candidates. */
  currentHourUtc: number;
  // The caller's calendar day; required, not UTC-defaulted, or scoring would use the wrong day boundary.
  referenceDate: string;
};

function scoreCandidate(
  candidate: QuickAddCandidate,
  currentHourUtc: number,
  referenceDate: string,
): number {
  let score = 0;

  if (
    candidate.habitCount !== undefined &&
    candidate.habitCount >= 3 &&
    candidate.peakHourUtc !== undefined
  ) {
    const dist = hourDistance(currentHourUtc, candidate.peakHourUtc);
    if (dist <= 1) score += 80;
    else if (dist <= 2) score += 40;
  }

  const daysSinceLastUsed = daysSinceDate(referenceDate, candidate.sourceDate);
  if (daysSinceLastUsed !== null) {
    score += Math.max(0, 14 - daysSinceLastUsed) * 2;
  }

  score += Math.min(candidate.observedUseDays ?? 0, 6) * 6;

  return score;
}

// Ranks preset + recent candidates by likelihood-to-log: time-of-day habit, recency, then repeat frequency.
export function rankCandidates(
  candidates: QuickAddCandidate[],
  options: RankCandidatesOptions,
): QuickAddCandidate[] {
  const { limit = 10, currentHourUtc, referenceDate } = options;
  const pool = deduplicateCandidates(candidates);

  return pool
    .map((candidate, originalIndex) => ({
      candidate,
      originalIndex,
      score: scoreCandidate(candidate, currentHourUtc, referenceDate),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aDate = a.candidate.sourceDate ?? "";
      const bDate = b.candidate.sourceDate ?? "";
      if (bDate !== aDate) return bDate.localeCompare(aDate);
      const observedDelta =
        (b.candidate.observedUseDays ?? 0) - (a.candidate.observedUseDays ?? 0);
      if (observedDelta !== 0) return observedDelta;
      return a.originalIndex - b.originalIndex;
    })
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

// The N most-recently-used unique foods; presets without a sourceDate sort after any dated entry.
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
