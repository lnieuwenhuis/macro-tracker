/** @vitest-environment node */
// UI-23: rounded macro shares must never go negative and must total 100.
import { describe, expect, it } from "vitest";

import { allocateMacroShares } from "@/components/stats-shell";

describe("UI-23 macro share allocation", () => {
  it("fixes the 33.5/66.5/0 case that showed -1% fat", () => {
    expect(allocateMacroShares(33.5, 66.5, 0)).toEqual({
      proteinPct: 34,
      carbsPct: 66,
      fatPct: 0,
    });
  });

  it("gives a single macro the full bar", () => {
    expect(allocateMacroShares(100, 0, 0)).toEqual({
      proteinPct: 100,
      carbsPct: 0,
      fatPct: 0,
    });
    expect(allocateMacroShares(0, 0, 50)).toEqual({
      proteinPct: 0,
      carbsPct: 0,
      fatPct: 100,
    });
  });

  it("returns zeros for empty input", () => {
    expect(allocateMacroShares(0, 0, 0)).toEqual({
      proteinPct: 0,
      carbsPct: 0,
      fatPct: 0,
    });
  });

  it("keeps small fractions nonnegative and totalling 100", () => {
    const shares = allocateMacroShares(0.1, 0.1, 0.1);
    expect(shares.proteinPct).toBeGreaterThanOrEqual(0);
    expect(shares.carbsPct).toBeGreaterThanOrEqual(0);
    expect(shares.fatPct).toBeGreaterThanOrEqual(0);
    expect(shares.proteinPct + shares.carbsPct + shares.fatPct).toBe(100);
  });

  it("never goes negative and always totals 100 across a sweep", () => {
    const values = [0, 0.3, 1.7, 12.5, 33.5, 66.5, 100];
    for (const protein of values) {
      for (const carbs of values) {
        for (const fat of values) {
          const shares = allocateMacroShares(protein, carbs, fat);
          expect(shares.proteinPct).toBeGreaterThanOrEqual(0);
          expect(shares.carbsPct).toBeGreaterThanOrEqual(0);
          expect(shares.fatPct).toBeGreaterThanOrEqual(0);
          if (protein + carbs + fat === 0) continue;
          expect(
            shares.proteinPct + shares.carbsPct + shares.fatPct,
          ).toBe(100);
        }
      }
    }
  });
});
