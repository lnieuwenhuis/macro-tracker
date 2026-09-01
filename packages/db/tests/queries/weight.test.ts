import {
  createWeightEntry,
  getWeightPageData,
  upsertUserFromShooProfile,
  type DatabaseRuntime,
} from "../../src";
import { createTestDatabase } from "../../src/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("weight queries", () => {
  let runtime: DatabaseRuntime;
  let userId: string;

  beforeEach(async () => {
    runtime = await createTestDatabase();
    const user = await upsertUserFromShooProfile(
      {
        pairwiseSub: "ps_test_user",
        email: "coach@example.com",
        displayName: "Coach",
      },
      runtime.db,
    );
    userId = user.id;
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("computes weight progress stats from the selected reference date", async () => {
    for (const entry of [
      { date: "2026-05-29", weightKg: 85 },
      { date: "2026-05-31", weightKg: 84.5 },
      { date: "2026-06-22", weightKg: 83.5 },
      { date: "2026-06-23", weightKg: 83 },
      { date: "2026-06-29", weightKg: 82 },
      { date: "2026-06-30", weightKg: 81.5 },
    ]) {
      await createWeightEntry(
        userId,
        {
          ...entry,
          bodyFatPct: null,
          notes: null,
        },
        runtime.db,
      );
    }

    const weightData = await getWeightPageData(userId, "2026-06-30", runtime.db);

    expect(weightData.entries.map((entry) => entry.date)).toEqual([
      "2026-05-29",
      "2026-05-31",
      "2026-06-22",
      "2026-06-23",
      "2026-06-29",
      "2026-06-30",
    ]);
    expect(weightData.stats).toEqual({
      currentWeight: 81.5,
      weekChange: -1.5,
      monthChange: -3,
      trendDirection: "down",
    });
  });
});
