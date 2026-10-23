/** @vitest-environment node */
// UI-14: unbounded history and multi-year projections must be unambiguous.
import type { WeightPageData } from "@macro-tracker/db";
import { describe, expect, it } from "vitest";

import {
  formatSelectedDateWithYear,
  formatShortDateWithYear,
} from "@/lib/formatting";
import { buildWeightGoalProjection } from "@/lib/weight-trend";

function entry(date: string, weightKg: number): WeightPageData["entries"][number] {
  return {
    id: date,
    userId: "user-1",
    date,
    weightKg,
    bodyFatPct: null,
    notes: null,
  };
}

describe("UI-14 year-inclusive history", () => {
  it("disambiguates the same day/month across years", () => {
    expect(formatShortDateWithYear("2025-03-16")).toBe("16 Mar 2025");
    expect(formatShortDateWithYear("2026-03-16")).toBe("16 Mar 2026");
    expect(formatSelectedDateWithYear("2025-03-16")).toContain("2025");
    expect(formatSelectedDateWithYear("2026-03-16")).toContain("2026");
  });

  it("renders a multi-year goal ETA with its year", () => {
    const weightData: WeightPageData = {
      entries: [entry("2026-01-01", 90), entry("2026-01-31", 89)],
      goalWeightKg: 70,
      stats: {
        currentWeight: 89,
        weekChange: -0.2,
        monthChange: -1,
        trendDirection: "down",
      },
    };
    const projection = buildWeightGoalProjection(weightData, "2026-01-31");

    expect(projection.status).toBe("moving_toward");
    expect(projection.estimatedGoalDate).not.toBeNull();
    expect(projection.estimatedGoalDate!.startsWith("2027")).toBe(true);
    expect(formatShortDateWithYear(projection.estimatedGoalDate!)).toContain(
      "2027",
    );
  });
});
