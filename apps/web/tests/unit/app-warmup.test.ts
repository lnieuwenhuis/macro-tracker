import { describe, expect, it } from "vitest";

import {
  getDailyMutationCacheKeys,
  getGoalsMutationCacheKeys,
  getNearbyDateStrings,
  getRecipeMutationCacheKeys,
  getTemplateMutationCacheKeys,
  getWarmupRoutes,
  getWeightMutationCacheKeys,
  normalizeAppWarmupScope,
} from "@/lib/app-warmup";

describe("app warmup helpers", () => {
  it("returns the bounded nearby date window", () => {
    expect(getNearbyDateStrings("2026-03-01")).toEqual({
      previousDate: "2026-02-28",
      selectedDate: "2026-03-01",
      nextDate: "2026-03-02",
    });
  });

  it("builds the conservative route list for intent-based prefetching", () => {
    expect(getWarmupRoutes("2026-03-19")).toEqual([
      "/?date=2026-03-19",
      "/progress?date=2026-03-19&tab=goals",
      "/library?date=2026-03-19",
      "/summary?date=2026-03-19",
    ]);
  });

  it("defaults warmup requests to the core payload", () => {
    expect(normalizeAppWarmupScope(undefined)).toBe("core");
    expect(normalizeAppWarmupScope("core")).toBe("core");
    expect(normalizeAppWarmupScope("extended")).toBe("extended");
    expect(normalizeAppWarmupScope("everything")).toBe("core");
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
    expect(getTemplateMutationCacheKeys()).toEqual(["templates"]);
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
