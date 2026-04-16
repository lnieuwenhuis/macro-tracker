import type { MacroGoals, QuickAddCandidate } from "@macro-tracker/db";
import { describe, expect, it } from "vitest";

import type { MealDraft } from "@/components/meal-card";
import {
  computeLiveTotalsFromDrafts,
  computeRemainingFromGoals,
  dedupeBestFitCandidates,
  presetToQuickAddCandidate,
  rankQuickAddCandidates,
} from "@/lib/quick-add";

function createDraft(overrides: Partial<MealDraft> = {}): MealDraft {
  return {
    clientId: overrides.clientId ?? crypto.randomUUID(),
    label: overrides.label ?? "Draft item",
    proteinG: overrides.proteinG ?? "0",
    carbsG: overrides.carbsG ?? "0",
    fatG: overrides.fatG ?? "0",
    caloriesKcal: overrides.caloriesKcal ?? "0",
    sortOrder: overrides.sortOrder ?? 0,
    id: overrides.id,
  };
}

function createCandidate(
  label: string,
  overrides: Partial<QuickAddCandidate> = {},
): QuickAddCandidate {
  return {
    source: overrides.source ?? "recent",
    sourceId: overrides.sourceId ?? crypto.randomUUID(),
    label,
    proteinG: overrides.proteinG ?? 0,
    carbsG: overrides.carbsG ?? 0,
    fatG: overrides.fatG ?? 0,
    caloriesKcal: overrides.caloriesKcal ?? 0,
    sourceDate: "sourceDate" in overrides ? (overrides.sourceDate ?? null) : "2026-03-19",
  };
}

describe("quick add helpers", () => {
  const noGoals: MacroGoals = {
    caloriesKcal: null,
    proteinG: null,
    carbsG: null,
    fatG: null,
  };

  it("computes live totals and remaining values with goals set", () => {
    const totals = computeLiveTotalsFromDrafts([
      createDraft({
        label: "Greek yogurt",
        proteinG: "30",
        carbsG: "20",
        fatG: "5",
        caloriesKcal: "245",
      }),
      createDraft({
        label: "Bagel",
        proteinG: "12.5",
        carbsG: "48.5",
        fatG: "2",
        caloriesKcal: "260",
        sortOrder: 1,
      }),
    ]);

    expect(totals).toEqual({
      proteinG: 42.5,
      carbsG: 68.5,
      fatG: 7,
      caloriesKcal: 505,
    });

    expect(
      computeRemainingFromGoals(totals, {
        caloriesKcal: 2200,
        proteinG: 180,
        carbsG: 240,
        fatG: 70,
      }),
    ).toEqual({
      caloriesKcal: { goal: 2200, remaining: 1695, status: "left" },
      proteinG: { goal: 180, remaining: 137.5, status: "left" },
      carbsG: { goal: 240, remaining: 171.5, status: "left" },
      fatG: { goal: 70, remaining: 63, status: "left" },
    });
  });

  it("handles unset goals and already-over states without clamping the UI values", () => {
    const totals = {
      proteinG: 190,
      carbsG: 260,
      fatG: 85,
      caloriesKcal: 2305,
    };

    expect(computeRemainingFromGoals(totals, noGoals)).toEqual({
      caloriesKcal: { goal: null, remaining: null, status: "unset" },
      proteinG: { goal: null, remaining: null, status: "unset" },
      carbsG: { goal: null, remaining: null, status: "unset" },
      fatG: { goal: null, remaining: null, status: "unset" },
    });

    expect(
      computeRemainingFromGoals(totals, {
        caloriesKcal: 2200,
        proteinG: 180,
        carbsG: 250,
        fatG: 80,
      }),
    ).toEqual({
      caloriesKcal: { goal: 2200, remaining: -105, status: "over" },
      proteinG: { goal: 180, remaining: -10, status: "over" },
      carbsG: { goal: 250, remaining: -10, status: "over" },
      fatG: { goal: 80, remaining: -5, status: "over" },
    });
  });

  it("ranks protein-helpful items ahead of slightly closer calorie matches", () => {
    const remaining = computeRemainingFromGoals(
      {
        proteinG: 80,
        carbsG: 120,
        fatG: 35,
        caloriesKcal: 1580,
      },
      {
        caloriesKcal: 1800,
        proteinG: 120,
        carbsG: 150,
        fatG: 45,
      },
    );

    const ranked = rankQuickAddCandidates(
      [
        createCandidate("Lean chicken wrap", {
          proteinG: 30,
          carbsG: 18,
          fatG: 7,
          caloriesKcal: 260,
          sourceDate: "2026-03-18",
        }),
        createCandidate("Banana", {
          proteinG: 2,
          carbsG: 25,
          fatG: 0,
          caloriesKcal: 210,
          sourceDate: "2026-03-19",
        }),
        createCandidate("Pastry", {
          proteinG: 6,
          carbsG: 28,
          fatG: 16,
          caloriesKcal: 220,
          sourceDate: "2026-03-20",
        }),
      ],
      remaining,
    );

    expect(ranked.map((item) => item.label)).toEqual([
      "Lean chicken wrap",
      "Pastry",
      "Banana",
    ]);
  });

  it("dedupes preset/history collisions in favor of presets", () => {
    const preset = presetToQuickAddCandidate({
      id: "preset-1",
      userId: "user-1",
      label: "Chicken & Rice",
      proteinG: 40,
      carbsG: 50,
      fatG: 10,
      caloriesKcal: 470,
    });

    const deduped = dedupeBestFitCandidates([
      createCandidate(" chicken & rice ", {
        source: "recent",
        sourceId: "recent-1",
        proteinG: 40,
        carbsG: 50,
        fatG: 10,
        caloriesKcal: 470,
        sourceDate: "2026-03-20",
      }),
      preset,
      createCandidate("Greek yogurt", {
        source: "recent",
        sourceId: "recent-2",
        proteinG: 25,
        carbsG: 15,
        fatG: 5,
        caloriesKcal: 205,
      }),
    ]);

    expect(deduped).toEqual([
      preset,
      expect.objectContaining({
        source: "recent",
        sourceId: "recent-2",
        label: "Greek yogurt",
      }),
    ]);
  });

  it("falls back cleanly in no-goal mode", () => {
    const ranked = rankQuickAddCandidates(
      [
        createCandidate("Older preset-like item", {
          source: "preset",
          sourceDate: null,
        }),
        createCandidate("Yesterday lunch", {
          sourceDate: "2026-03-19",
        }),
        createCandidate("Today breakfast", {
          sourceDate: "2026-03-20",
        }),
      ],
      computeRemainingFromGoals(
        {
          proteinG: 0,
          carbsG: 0,
          fatG: 0,
          caloriesKcal: 0,
        },
        noGoals,
      ),
    );

    expect(ranked.map((item) => item.label)).toEqual([
      "Today breakfast",
      "Yesterday lunch",
      "Older preset-like item",
    ]);
  });
});
