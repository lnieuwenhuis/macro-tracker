import {
  computeStreaks,
  createMealEntry,
  deleteMealEntry,
  getDailySummary,
  getPeriodAverages,
  getRecentQuickAddCandidates,
  updateMealEntry,
  upsertUserFromShooProfile,
  type DatabaseRuntime,
} from "../src";
import { createTestDatabase } from "../src/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("database queries", () => {
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

  it("calculates daily totals and logged-day-only averages", async () => {
    await createMealEntry(
      userId,
      {
        date: "2026-03-17",
        label: "Lunch",
        proteinG: 30,
        carbsG: 40,
        fatG: 10,
        caloriesKcal: 370,
      },
      runtime.db,
    );
    await createMealEntry(
      userId,
      {
        date: "2026-03-19",
        label: "Breakfast",
        proteinG: 20,
        carbsG: 30,
        fatG: 10,
        caloriesKcal: 290,
      },
      runtime.db,
    );
    await createMealEntry(
      userId,
      {
        date: "2026-03-19",
        label: "Dinner",
        proteinG: 30,
        carbsG: 30,
        fatG: 10,
        caloriesKcal: 330,
      },
      runtime.db,
    );
    await createMealEntry(
      userId,
      {
        date: "2026-03-01",
        label: "Snack",
        proteinG: 20,
        carbsG: 10,
        fatG: 5,
        caloriesKcal: 165,
      },
      runtime.db,
    );

    const dailySummary = await getDailySummary(userId, "2026-03-19", runtime.db);
    expect(dailySummary.totals).toEqual({
      proteinG: 50,
      carbsG: 60,
      fatG: 20,
      caloriesKcal: 620,
    });

    const periodAverages = await getPeriodAverages(userId, "2026-03-19", runtime.db);
    const week = periodAverages.find((item) => item.label === "week");
    const month = periodAverages.find((item) => item.label === "month");
    const rolling7 = periodAverages.find((item) => item.label === "rolling7");
    const rolling30 = periodAverages.find((item) => item.label === "rolling30");

    expect(week).toMatchObject({
      loggedDays: 2,
      averages: {
        proteinG: 40,
        carbsG: 50,
        fatG: 15,
        caloriesKcal: 495,
      },
    });
    expect(month?.loggedDays).toBe(3);
    expect(month?.averages.proteinG).toBeCloseTo(33.3, 1);
    expect(month?.averages.carbsG).toBeCloseTo(36.7, 1);
    expect(month?.averages.fatG).toBeCloseTo(11.7, 1);
    expect(month?.averages.caloriesKcal).toBe(385);
    expect(rolling7?.loggedDays).toBe(2);
    expect(rolling30?.loggedDays).toBe(3);
  });

  it("creates, updates, and deletes meal entries while keeping totals in sync", async () => {
    const breakfast = await createMealEntry(
      userId,
      {
        date: "2026-03-21",
        label: "Breakfast",
        proteinG: 25,
        carbsG: 45,
        fatG: 12,
        caloriesKcal: 390,
      },
      runtime.db,
    );
    const dinner = await createMealEntry(
      userId,
      {
        date: "2026-03-21",
        label: "Dinner",
        proteinG: 35,
        carbsG: 55,
        fatG: 18,
        caloriesKcal: 550,
      },
      runtime.db,
    );

    let dailySummary = await getDailySummary(userId, "2026-03-21", runtime.db);
    expect(dailySummary.totals).toEqual({
      proteinG: 60,
      carbsG: 100,
      fatG: 30,
      caloriesKcal: 940,
    });

    await updateMealEntry(
      userId,
      breakfast.id,
      {
        date: "2026-03-21",
        label: "Breakfast",
        sortOrder: breakfast.sortOrder,
        proteinG: 30,
        carbsG: 42,
        fatG: 11,
        caloriesKcal: 395,
      },
      runtime.db,
    );

    dailySummary = await getDailySummary(userId, "2026-03-21", runtime.db);
    expect(dailySummary.totals).toEqual({
      proteinG: 65,
      carbsG: 97,
      fatG: 29,
      caloriesKcal: 945,
    });

    await deleteMealEntry(userId, dinner.id, runtime.db);
    dailySummary = await getDailySummary(userId, "2026-03-21", runtime.db);

    expect(dailySummary.meals).toHaveLength(1);
    expect(dailySummary.totals).toEqual({
      proteinG: 30,
      carbsG: 42,
      fatG: 11,
      caloriesKcal: 395,
    });
  });

  it("computes streaks from local date strings", () => {
    expect(
      computeStreaks(
        ["2026-03-01", "2026-03-02", "2026-03-04", "2026-03-05", "2026-03-06"],
        "2026-03-07",
      ),
    ).toEqual({
      currentStreak: 3,
      longestStreak: 3,
    });

    expect(
      computeStreaks(
        ["2026-03-01", "2026-03-02", "2026-03-04", "2026-03-05", "2026-03-06"],
        "2026-03-06",
      ),
    ).toEqual({
      currentStreak: 3,
      longestStreak: 3,
    });
  });

  it("returns recent quick add candidates deduped to the most recent matching food", async () => {
    await createMealEntry(
      userId,
      {
        date: "2026-03-17",
        label: "Chicken Rice Bowl",
        proteinG: 42,
        carbsG: 55,
        fatG: 12,
        caloriesKcal: 520,
      },
      runtime.db,
    );
    const mostRecentDuplicate = await createMealEntry(
      userId,
      {
        date: "2026-03-19",
        label: "  chicken   rice bowl ",
        proteinG: 42,
        carbsG: 55,
        fatG: 12,
        caloriesKcal: 520,
      },
      runtime.db,
    );
    await createMealEntry(
      userId,
      {
        date: "2026-03-18",
        label: "Greek Yogurt",
        proteinG: 25,
        carbsG: 15,
        fatG: 5,
        caloriesKcal: 205,
      },
      runtime.db,
    );

    const recent = await getRecentQuickAddCandidates(userId, 10, runtime.db);

    expect(recent).toEqual([
      {
        source: "recent",
        sourceId: mostRecentDuplicate.id,
        sourceDate: "2026-03-19",
        label: "  chicken   rice bowl ",
        proteinG: 42,
        carbsG: 55,
        fatG: 12,
        caloriesKcal: 520,
      },
      {
        source: "recent",
        sourceId: expect.any(String),
        sourceDate: "2026-03-18",
        label: "Greek Yogurt",
        proteinG: 25,
        carbsG: 15,
        fatG: 5,
        caloriesKcal: 205,
      },
    ]);
  });
});
