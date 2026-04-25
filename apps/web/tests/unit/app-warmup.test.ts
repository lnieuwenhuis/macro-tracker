import { describe, expect, it } from "vitest";

import {
  getDailyMutationCacheKeys,
  getGoalsMutationCacheKeys,
  getNearbyDateStrings,
  getPresetMutationCacheKeys,
  getRecipeMutationCacheKeys,
  getWarmupRoutes,
  getWeightMutationCacheKeys,
} from "@/lib/app-warmup";

describe("app warmup helpers", () => {
  it("returns the bounded nearby date window", () => {
    expect(getNearbyDateStrings("2026-03-01")).toEqual({
      previousDate: "2026-02-28",
      selectedDate: "2026-03-01",
      nextDate: "2026-03-02",
    });
  });

  it("builds the hot route list for instant navigation", () => {
    expect(getWarmupRoutes("2026-03-19")).toEqual([
      "/?date=2026-03-19",
      "/?date=2026-03-18",
      "/?date=2026-03-20",
      "/progress?date=2026-03-19&tab=goals",
      "/progress?date=2026-03-19&tab=weight",
      "/recipes?date=2026-03-19",
      "/summary?date=2026-03-19",
    ]);
  });

  it("keeps cache invalidation scoped to affected data", () => {
    expect(getDailyMutationCacheKeys("2026-03-19")).toEqual([
      "dailySummary:2026-03-19",
      "summary:2026-03-19",
      "stats",
    ]);
    expect(getGoalsMutationCacheKeys("2026-03-19")).toEqual([
      "goals",
      "summary:2026-03-19",
      "stats",
    ]);
    expect(getPresetMutationCacheKeys()).toEqual(["presets"]);
    expect(getRecipeMutationCacheKeys("2026-03-19")).toEqual([
      "recipes",
      "dailySummary:2026-03-19",
      "summary:2026-03-19",
      "stats",
    ]);
    expect(getWeightMutationCacheKeys("2026-03-19")).toEqual([
      "weight:2026-03-19",
      "stats",
    ]);
  });
});
