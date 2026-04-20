import { describe, expect, it } from "vitest";

import type { MacroGoals, MacroNumbers, QuickAddCandidate } from "@macro-tracker/db";

import {
  computeLiveTotals,
  computeRemaining,
  deduplicateCandidates,
  getRecentRepeats,
  hasAnyGoal,
  rankCandidates,
} from "@/lib/quick-add";
import type { MealDraft } from "@/components/meal-card";

// ---------------------------------------------------------------------------
// computeLiveTotals
// ---------------------------------------------------------------------------

describe("computeLiveTotals", () => {
  it("returns zeros when there are no drafts", () => {
    expect(computeLiveTotals([])).toEqual({
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      caloriesKcal: 0,
    });
  });

  it("sums numeric string values across all drafts", () => {
    const drafts: MealDraft[] = [
      {
        clientId: "a",
        label: "Eggs",
        proteinG: "12",
        carbsG: "1",
        fatG: "9",
        caloriesKcal: "130",
        sortOrder: 0,
      },
      {
        clientId: "b",
        label: "Oats",
        proteinG: "5",
        carbsG: "27",
        fatG: "3",
        caloriesKcal: "150",
        sortOrder: 1,
      },
    ];

    expect(computeLiveTotals(drafts)).toEqual({
      proteinG: 17,
      carbsG: 28,
      fatG: 12,
      caloriesKcal: 280,
    });
  });

  it("treats empty strings as zero", () => {
    const drafts: MealDraft[] = [
      {
        clientId: "a",
        label: "Partial",
        proteinG: "",
        carbsG: "10",
        fatG: "",
        caloriesKcal: "100",
        sortOrder: 0,
      },
    ];

    expect(computeLiveTotals(drafts)).toEqual({
      proteinG: 0,
      carbsG: 10,
      fatG: 0,
      caloriesKcal: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// computeRemaining
// ---------------------------------------------------------------------------

describe("computeRemaining", () => {
  const totals: MacroNumbers = {
    proteinG: 80,
    carbsG: 150,
    fatG: 50,
    caloriesKcal: 1400,
  };

  it("computes positive remaining when under goal", () => {
    const goals: MacroGoals = {
      proteinG: 150,
      carbsG: 250,
      fatG: 80,
      caloriesKcal: 2000,
    };
    expect(computeRemaining(totals, goals)).toEqual({
      proteinG: 70,
      carbsG: 100,
      fatG: 30,
      caloriesKcal: 600,
    });
  });

  it("returns negative values when over goal (not clamped)", () => {
    const goals: MacroGoals = {
      proteinG: 60,
      carbsG: 100,
      fatG: 40,
      caloriesKcal: 1200,
    };
    expect(computeRemaining(totals, goals)).toEqual({
      proteinG: -20,
      carbsG: -50,
      fatG: -10,
      caloriesKcal: -200,
    });
  });

  it("returns null for dimensions with no goal", () => {
    const goals: MacroGoals = {
      proteinG: 150,
      carbsG: null,
      fatG: null,
      caloriesKcal: null,
    };
    const result = computeRemaining(totals, goals);
    expect(result.proteinG).toBe(70);
    expect(result.carbsG).toBeNull();
    expect(result.fatG).toBeNull();
    expect(result.caloriesKcal).toBeNull();
  });

  it("returns all nulls when no goals are set", () => {
    const goals: MacroGoals = {
      proteinG: null,
      carbsG: null,
      fatG: null,
      caloriesKcal: null,
    };
    expect(computeRemaining(totals, goals)).toEqual({
      proteinG: null,
      carbsG: null,
      fatG: null,
      caloriesKcal: null,
    });
  });
});

// ---------------------------------------------------------------------------
// hasAnyGoal
// ---------------------------------------------------------------------------

describe("hasAnyGoal", () => {
  it("returns false when no goals are set", () => {
    expect(
      hasAnyGoal({ proteinG: null, carbsG: null, fatG: null, caloriesKcal: null }),
    ).toBe(false);
  });

  it("returns true when any single goal is set", () => {
    expect(
      hasAnyGoal({ proteinG: 150, carbsG: null, fatG: null, caloriesKcal: null }),
    ).toBe(true);
  });

  it("returns true when all goals are set", () => {
    expect(
      hasAnyGoal({ proteinG: 150, carbsG: 250, fatG: 80, caloriesKcal: 2000 }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deduplicateCandidates
// ---------------------------------------------------------------------------

describe("deduplicateCandidates", () => {
  it("removes exact duplicates keeping the first occurrence", () => {
    const candidates: QuickAddCandidate[] = [
      {
        label: "Chicken breast",
        proteinG: 30,
        carbsG: 0,
        fatG: 3,
        caloriesKcal: 150,
        source: "recent",
        sourceDate: "2026-04-15",
      },
      {
        label: "Chicken breast",
        proteinG: 30,
        carbsG: 0,
        fatG: 3,
        caloriesKcal: 150,
        source: "recent",
        sourceDate: "2026-04-10",
      },
    ];
    const result = deduplicateCandidates(candidates);
    expect(result).toHaveLength(1);
    expect(result[0]!.sourceDate).toBe("2026-04-15");
  });

  it("merges recent metadata into an equivalent preset candidate", () => {
    const candidates: QuickAddCandidate[] = [
      {
        label: "Greek Yogurt",
        proteinG: 17,
        carbsG: 6,
        fatG: 0,
        caloriesKcal: 100,
        source: "recent",
        sourceDate: "2026-04-14",
        peakHourUtc: 7,
        habitCount: 4,
        observedUseDays: 5,
      },
      {
        label: "Greek Yogurt",
        proteinG: 17,
        carbsG: 6,
        fatG: 0,
        caloriesKcal: 100,
        source: "preset",
        presetId: "preset-1",
      },
    ];
    const result = deduplicateCandidates(candidates);
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("preset");
    expect(result[0]!.presetId).toBe("preset-1");
    expect(result[0]!.sourceDate).toBe("2026-04-14");
    expect(result[0]!.peakHourUtc).toBe(7);
    expect(result[0]!.habitCount).toBe(4);
    expect(result[0]!.observedUseDays).toBe(5);
  });

  it("keeps items with different macros even with the same label", () => {
    const candidates: QuickAddCandidate[] = [
      {
        label: "Chicken breast",
        proteinG: 30,
        carbsG: 0,
        fatG: 3,
        caloriesKcal: 150,
        source: "recent",
      },
      {
        label: "Chicken breast",
        proteinG: 25,
        carbsG: 0,
        fatG: 2,
        caloriesKcal: 120,
        source: "recent",
      },
    ];
    const result = deduplicateCandidates(candidates);
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// rankCandidates
// ---------------------------------------------------------------------------

describe("rankCandidates", () => {
  const defaultRankOptions = {
    currentHourUtc: 12,
    referenceDate: "2026-04-20",
  };

  const highProteinItem: QuickAddCandidate = {
    label: "Chicken breast",
    proteinG: 40,
    carbsG: 0,
    fatG: 5,
    caloriesKcal: 205,
    source: "preset",
    sourceDate: "2026-04-14",
  };

  const lowProteinItem: QuickAddCandidate = {
    label: "White rice",
    proteinG: 4,
    carbsG: 45,
    fatG: 0,
    caloriesKcal: 200,
    source: "recent",
    sourceDate: "2026-04-13",
  };

  const remaining = {
    proteinG: 80,
    carbsG: 100,
    fatG: 30,
    caloriesKcal: 600,
  };

  it("ranks higher-protein items first when protein is the main deficit", () => {
    const ranked = rankCandidates(
      [lowProteinItem, highProteinItem],
      remaining,
      defaultRankOptions,
    );
    expect(ranked[0]!.label).toBe("Chicken breast");
  });

  it("respects the limit", () => {
    const many: QuickAddCandidate[] = Array.from({ length: 20 }, (_, i) => ({
      label: `Food ${i}`,
      proteinG: i,
      carbsG: 10,
      fatG: 5,
      caloriesKcal: 100,
      source: "recent" as const,
      sourceDate: `2026-04-${String(i + 1).padStart(2, "0")}`,
    }));
    expect(
      rankCandidates(many, remaining, { ...defaultRankOptions, limit: 5 }),
    ).toHaveLength(5);
  });

  it("still returns results when the day is already over goal", () => {
    const overGoalRemaining = {
      proteinG: -10,
      carbsG: -50,
      fatG: -5,
      caloriesKcal: -200,
    };
    const result = rankCandidates(
      [highProteinItem, lowProteinItem],
      overGoalRemaining,
      defaultRankOptions,
    );
    expect(result.length).toBeGreaterThan(0);
  });

  it("boosts a habit food to the top when the current hour is near its peak", () => {
    const habitOats: QuickAddCandidate = {
      label: "Oats",
      proteinG: 5,
      carbsG: 30,
      fatG: 3,
      caloriesKcal: 170,
      source: "recent",
      sourceDate: "2026-04-15",
      peakHourUtc: 7,
      habitCount: 5,
      observedUseDays: 5,
    };

    const ranked = rankCandidates([highProteinItem, habitOats], remaining, {
      ...defaultRankOptions,
      currentHourUtc: 7,
    });
    expect(ranked[0]!.label).toBe("Oats");
  });

  it("does not boost a habit food when the current hour is far from its peak", () => {
    const habitOats: QuickAddCandidate = {
      label: "Oats",
      proteinG: 5,
      carbsG: 30,
      fatG: 3,
      caloriesKcal: 170,
      source: "recent",
      sourceDate: "2026-04-15",
      peakHourUtc: 7,
      habitCount: 5,
      observedUseDays: 5,
    };

    const ranked = rankCandidates([highProteinItem, habitOats], remaining, {
      ...defaultRankOptions,
      currentHourUtc: 20,
    });
    expect(ranked[0]!.label).toBe("Chicken breast");
  });

  it("ignores habit signal when habitCount is below threshold", () => {
    const weakHabit: QuickAddCandidate = {
      label: "Yogurt",
      proteinG: 5,
      carbsG: 10,
      fatG: 2,
      caloriesKcal: 80,
      source: "recent",
      peakHourUtc: 8,
      habitCount: 2,
      sourceDate: "2026-04-19",
      observedUseDays: 2,
    };

    const ranked = rankCandidates([highProteinItem, weakHabit], remaining, {
      ...defaultRankOptions,
      currentHourUtc: 8,
    });
    expect(ranked[0]!.label).toBe("Chicken breast");
  });

  it("lets a merged preset duplicate keep its habit bonus", () => {
    const presetOats: QuickAddCandidate = {
      label: "Oats",
      proteinG: 5,
      carbsG: 30,
      fatG: 3,
      caloriesKcal: 170,
      source: "preset",
      presetId: "preset-oats",
    };

    const recentOats: QuickAddCandidate = {
      label: "Oats",
      proteinG: 5,
      carbsG: 30,
      fatG: 3,
      caloriesKcal: 170,
      source: "recent",
      sourceDate: "2026-04-19",
      peakHourUtc: 7,
      habitCount: 5,
      observedUseDays: 5,
    };

    const ranked = rankCandidates(
      [highProteinItem, presetOats, recentOats],
      remaining,
      { ...defaultRankOptions, currentHourUtc: 7 },
    );

    expect(ranked[0]!.label).toBe("Oats");
    expect(ranked[0]!.source).toBe("preset");
    expect(ranked[0]!.presetId).toBe("preset-oats");
  });

  it("prefers more recently used items when macro fit is equal", () => {
    const noGoalRemaining = {
      proteinG: null,
      carbsG: null,
      fatG: null,
      caloriesKcal: null,
    };
    const recentItem: QuickAddCandidate = {
      label: "Wrap",
      proteinG: 20,
      carbsG: 20,
      fatG: 10,
      caloriesKcal: 250,
      source: "recent",
      sourceDate: "2026-04-19",
      observedUseDays: 1,
    };
    const staleItem: QuickAddCandidate = {
      label: "Toast",
      proteinG: 20,
      carbsG: 20,
      fatG: 10,
      caloriesKcal: 250,
      source: "recent",
      sourceDate: "2026-04-01",
      observedUseDays: 1,
    };

    const ranked = rankCandidates(
      [staleItem, recentItem],
      noGoalRemaining,
      defaultRankOptions,
    );
    expect(ranked[0]!.label).toBe("Wrap");
  });

  it("prefers items used on more distinct days when recency is equal", () => {
    const noGoalRemaining = {
      proteinG: null,
      carbsG: null,
      fatG: null,
      caloriesKcal: null,
    };
    const frequentItem: QuickAddCandidate = {
      label: "Bagel",
      proteinG: 20,
      carbsG: 20,
      fatG: 10,
      caloriesKcal: 250,
      source: "recent",
      sourceDate: "2026-04-18",
      observedUseDays: 5,
    };
    const infrequentItem: QuickAddCandidate = {
      label: "Muffin",
      proteinG: 20,
      carbsG: 20,
      fatG: 10,
      caloriesKcal: 250,
      source: "recent",
      sourceDate: "2026-04-18",
      observedUseDays: 1,
    };

    const ranked = rankCandidates(
      [infrequentItem, frequentItem],
      noGoalRemaining,
      defaultRankOptions,
    );
    expect(ranked[0]!.label).toBe("Bagel");
  });

  it("demotes items that overshoot carbs and fat heavily", () => {
    const lowOvershootItem: QuickAddCandidate = {
      label: "Greek Yogurt",
      proteinG: 20,
      carbsG: 5,
      fatG: 2,
      caloriesKcal: 120,
      source: "recent",
      sourceDate: "2026-04-18",
      observedUseDays: 2,
    };
    const highOvershootItem: QuickAddCandidate = {
      label: "Pastry",
      proteinG: 20,
      carbsG: 40,
      fatG: 20,
      caloriesKcal: 320,
      source: "recent",
      sourceDate: "2026-04-18",
      observedUseDays: 2,
    };
    const tightRemaining = {
      proteinG: null,
      carbsG: 10,
      fatG: 5,
      caloriesKcal: null,
    };

    const ranked = rankCandidates(
      [highOvershootItem, lowOvershootItem],
      tightRemaining,
      defaultRankOptions,
    );
    expect(ranked[0]!.label).toBe("Greek Yogurt");
  });

  it("still ranks no-goal users by usage signals", () => {
    const noGoalRemaining = {
      proteinG: null,
      carbsG: null,
      fatG: null,
      caloriesKcal: null,
    };
    const likelyNext: QuickAddCandidate = {
      label: "Apple",
      proteinG: 1,
      carbsG: 20,
      fatG: 0,
      caloriesKcal: 80,
      source: "recent",
      sourceDate: "2026-04-20",
      observedUseDays: 4,
    };
    const lessLikely: QuickAddCandidate = {
      label: "Peanut Butter",
      proteinG: 1,
      carbsG: 20,
      fatG: 0,
      caloriesKcal: 80,
      source: "recent",
      sourceDate: "2026-04-05",
      observedUseDays: 1,
    };

    const ranked = rankCandidates(
      [lessLikely, likelyNext],
      noGoalRemaining,
      defaultRankOptions,
    );
    expect(ranked[0]!.label).toBe("Apple");
  });

  it("keeps original input order when all tie-breakers are equal", () => {
    const noGoalRemaining = {
      proteinG: null,
      carbsG: null,
      fatG: null,
      caloriesKcal: null,
    };
    const first: QuickAddCandidate = {
      label: "Food A",
      proteinG: 10,
      carbsG: 10,
      fatG: 10,
      caloriesKcal: 150,
      source: "preset",
      presetId: "preset-a",
    };
    const second: QuickAddCandidate = {
      label: "Food B",
      proteinG: 10,
      carbsG: 10,
      fatG: 10,
      caloriesKcal: 150,
      source: "preset",
      presetId: "preset-b",
    };

    const ranked = rankCandidates([first, second], noGoalRemaining, defaultRankOptions);
    expect(ranked.map((item) => item.label)).toEqual(["Food A", "Food B"]);
  });
});

// ---------------------------------------------------------------------------
// getRecentRepeats
// ---------------------------------------------------------------------------

describe("getRecentRepeats", () => {
  it("returns items sorted by most-recent date first", () => {
    const candidates: QuickAddCandidate[] = [
      {
        label: "Oats",
        proteinG: 5,
        carbsG: 27,
        fatG: 3,
        caloriesKcal: 150,
        source: "recent",
        sourceDate: "2026-04-10",
      },
      {
        label: "Eggs",
        proteinG: 12,
        carbsG: 1,
        fatG: 9,
        caloriesKcal: 130,
        source: "recent",
        sourceDate: "2026-04-15",
      },
    ];
    const result = getRecentRepeats(candidates, 5);
    expect(result[0]!.label).toBe("Eggs");
    expect(result[1]!.label).toBe("Oats");
  });

  it("respects the limit", () => {
    const many: QuickAddCandidate[] = Array.from({ length: 15 }, (_, i) => ({
      label: `Food ${i}`,
      proteinG: i,
      carbsG: 10,
      fatG: 5,
      caloriesKcal: 100,
      source: "recent" as const,
      sourceDate: `2026-04-${String(i + 1).padStart(2, "0")}`,
    }));
    expect(getRecentRepeats(many, 5)).toHaveLength(5);
  });

  it("deduplicates before returning", () => {
    const candidates: QuickAddCandidate[] = [
      {
        label: "Chicken breast",
        proteinG: 30,
        carbsG: 0,
        fatG: 3,
        caloriesKcal: 150,
        source: "recent",
        sourceDate: "2026-04-15",
      },
      {
        label: "Chicken breast",
        proteinG: 30,
        carbsG: 0,
        fatG: 3,
        caloriesKcal: 150,
        source: "recent",
        sourceDate: "2026-04-12",
      },
    ];
    expect(getRecentRepeats(candidates, 10)).toHaveLength(1);
  });
});
