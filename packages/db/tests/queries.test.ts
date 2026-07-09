import {
  authenticateApiToken,
  computeStreaks,
  createApiToken,
  createMealGroup,
  createRecipe,
  createMealEntry,
  createWeightEntry,
  completeOnboardingSetup,
  createPersonalFoodProduct,
  createTemplate,
  deleteMealGroup,
  deleteMealEntry,
  ensureDefaultMealGroups,
  getDailySummary,
  getLeaderboardStats,
  getMealGroups,
  getPeriodAverages,
  getRecipeById,
  getRecentQuickAddCandidates,
  getStatsPageData,
  getTemplates,
  getUserById,
  getUserGoals,
  getWeightPageData,
  lookupBarcodeFoodProduct,
  listApiTokens,
  markMealEntryStatus,
  applyTemplateToDate,
  revokeApiToken,
  resolveProductNutritionForQuantity,
  saveBarcodeFoodProduct,
  saveUserGoals,
  searchFoodProducts,
  updateRecipe,
  updateMealEntry,
  updateTemplate,
  upsertUserFromShooProfile,
  type DatabaseRuntime,
} from "../src";
import {
  apiTokens,
  foodProducts,
  mealEntries,
  mealTemplateItems,
  mealTemplates,
  recipeIngredients,
  recipes,
} from "../src/schema";
import { createTestDatabase } from "../src/testing";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
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

  async function createMealWithCreatedAt(
    input: Parameters<typeof createMealEntry>[1],
    createdAtIso: string,
  ) {
    const entry = await createMealEntry(userId, input, runtime.db);
    const timestamp = new Date(createdAtIso);

    await runtime.db
      .update(mealEntries)
      .set({
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .where(eq(mealEntries.id, entry.id));

    return entry;
  }

  async function createOtherUser() {
    const user = await upsertUserFromShooProfile(
      {
        pairwiseSub: "ps_other_user",
        email: "other@example.com",
        displayName: "Other",
      },
      runtime.db,
    );

    return user.id;
  }

  async function createOtherUserProduct(
    input: Parameters<typeof createPersonalFoodProduct>[1],
  ) {
    return createPersonalFoodProduct(await createOtherUser(), input, runtime.db);
  }

  function createFailingDbProxy(input: {
    method: "insert" | "update";
    table: unknown;
    failOnCall?: number;
    message: string;
    backendFault: {
      kind: string;
      failOnCall?: number;
      message: string;
    };
  }) {
    let callCount = 0;

    function wrapClient(client: any) {
      return new Proxy(client, {
        get(target, prop, receiver) {
          if (prop === "__backendTestFault") {
            return input.backendFault;
          }

          if (prop === input.method) {
            return (table: unknown) => {
              if (table === input.table) {
                callCount += 1;
                if (callCount === (input.failOnCall ?? 1)) {
                  throw new Error(input.message);
                }
              }

              return target[input.method](table);
            };
          }

          if (prop === "transaction") {
            return async (callback: (tx: unknown) => unknown) =>
              target.transaction(async (tx: unknown) => callback(wrapClient(tx)));
          }

          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }

    return wrapClient(runtime.db as any);
  }

  function createFailingRecipeDb(failOnIngredientInsertNumber: number) {
    return createFailingDbProxy({
      method: "insert",
      table: recipeIngredients,
      failOnCall: failOnIngredientInsertNumber,
      message: "Forced ingredient insert failure.",
      backendFault: {
        kind: "recipe_ingredient_insert",
        failOnCall: failOnIngredientInsertNumber,
        message: "Forced ingredient insert failure.",
      },
    });
  }

  function createFailingBarcodeFoodProductDb() {
    return createFailingDbProxy({
      method: "insert",
      table: foodProducts,
      message: "Forced barcode food product insert failure.",
      backendFault: {
        kind: "barcode_food_product_insert",
        message: "Forced barcode food product insert failure.",
      },
    });
  }

  function createFailingMealEntryInsertDb(failOnMealEntryInsertNumber: number) {
    return createFailingDbProxy({
      method: "insert",
      table: mealEntries,
      failOnCall: failOnMealEntryInsertNumber,
      message: "Forced meal entry insert failure.",
      backendFault: {
        kind: "meal_entry_insert",
        failOnCall: failOnMealEntryInsertNumber,
        message: "Forced meal entry insert failure.",
      },
    });
  }

  function createFailingMealGroupDeleteDb() {
    return createFailingDbProxy({
      method: "update",
      table: mealEntries,
      message: "Forced meal group unassign failure.",
      backendFault: {
        kind: "meal_group_unassign",
        message: "Forced meal group unassign failure.",
      },
    });
  }

  it("creates API tokens as one-time-visible secrets with stored hashes", async () => {
    const created = await createApiToken(
      userId,
      {
        name: "Mobile app",
        scopes: ["read:daily", "write:daily"],
      },
      runtime.db,
    );

    expect(created.token).toMatch(/^mtk_v1_/);
    const rawTokenSecretPrefix = created.token.slice("mtk_v1_".length, 19);
    expect(created.record).toMatchObject({
      userId,
      tokenPrefix: expect.stringMatching(/^mtk_v1_[a-f0-9]{12}$/),
      name: "Mobile app",
      scopes: ["read:daily", "write:daily"],
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(created.record.tokenPrefix).not.toContain(rawTokenSecretPrefix);
    expect(created.record.expiresAt).toBeTruthy();

    const [stored] = await runtime.db.select().from(apiTokens);
    expect(stored?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.tokenHash).not.toBe(created.token);
    expect(stored?.tokenPrefix).not.toContain(rawTokenSecretPrefix);

    const listed = await listApiTokens(userId, runtime.db);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.tokenPrefix).not.toContain(rawTokenSecretPrefix);
    expect(JSON.stringify(listed)).not.toContain(stored!.tokenHash);
    expect(JSON.stringify(listed)).not.toContain(created.token);
  });

  it("supports never-expiring API tokens explicitly", async () => {
    const created = await createApiToken(
      userId,
      {
        name: "No expiry",
        scopes: ["read:stats"],
        expiresAt: null,
      },
      runtime.db,
    );

    expect(created.record.expiresAt).toBeNull();
  });

  it("validates and dedupes API token scopes", async () => {
    await expect(
      createApiToken(userId, { name: "Empty", scopes: [] }, runtime.db),
    ).rejects.toThrow("API token must include at least one scope.");
    await expect(
      createApiToken(userId, { name: "Bad", scopes: ["read:daily", "admin:*"] }, runtime.db),
    ).rejects.toThrow("API token scope is invalid.");

    const created = await createApiToken(
      userId,
      {
        name: "Duplicates",
        scopes: ["read:daily", "write:daily", "read:daily"],
      },
      runtime.db,
    );

    expect(created.record.scopes).toEqual(["read:daily", "write:daily"]);
  });

  it("rejects invalid API token expiry strings with validation errors", async () => {
    await expect(
      createApiToken(
        userId,
        {
          name: "Bad expiry",
          scopes: ["read:daily"],
          expiresAt: "not-a-date",
        },
        runtime.db,
      ),
    ).rejects.toThrow("API token expiry is invalid.");
  });

  it("defaults API token expiry to about ninety days", async () => {
    const before = Date.now();
    const created = await createApiToken(
      userId,
      {
        name: "Default expiry",
        scopes: ["read:daily"],
      },
      runtime.db,
    );
    const after = Date.now();
    const expiresAt = new Date(created.record.expiresAt!).getTime();

    expect(expiresAt).toBeGreaterThanOrEqual(before + 89 * 24 * 60 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 91 * 24 * 60 * 60 * 1000);
  });

  it("authenticates valid API tokens and updates last-used time", async () => {
    const created = await createApiToken(
      userId,
      {
        name: "Reader",
        scopes: ["read:daily"],
      },
      runtime.db,
    );

    const result = await authenticateApiToken(created.token, runtime.db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token.userId).toBe(userId);
      expect(result.token.scopes).toEqual(["read:daily"]);
      expect(result.token.lastUsedAt).toBeTruthy();
    }

    const listed = await listApiTokens(userId, runtime.db);
    expect(listed[0]?.lastUsedAt).toBeTruthy();
  });

  it("throttles API token last-used updates within a short window", async () => {
    const created = await createApiToken(
      userId,
      {
        name: "Reader",
        scopes: ["read:daily"],
      },
      runtime.db,
    );

    const first = await authenticateApiToken(created.token, runtime.db);
    expect(first.ok).toBe(true);
    const firstLastUsedAt = first.ok ? first.token.lastUsedAt : null;
    expect(firstLastUsedAt).toBeTruthy();

    const second = await authenticateApiToken(created.token, runtime.db);
    expect(second.ok).toBe(true);
    expect(second.ok ? second.token.lastUsedAt : null).toEqual(firstLastUsedAt);
    const [storedAfterSecond] = await runtime.db.select().from(apiTokens);
    expect(new Date(storedAfterSecond!.lastUsedAt!).getTime()).toBe(
      new Date(firstLastUsedAt!).getTime(),
    );

    const staleLastUsedAt = new Date(Date.now() - 10 * 60 * 1000);
    await runtime.db
      .update(apiTokens)
      .set({ lastUsedAt: staleLastUsedAt })
      .where(eq(apiTokens.id, created.record.id));

    const stale = await authenticateApiToken(created.token, runtime.db);
    expect(stale.ok).toBe(true);
    expect(stale.ok ? new Date(stale.token.lastUsedAt!).getTime() : 0).toBeGreaterThan(
      staleLastUsedAt.getTime(),
    );
  });

  it("rejects malformed, unknown, expired, and revoked API tokens", async () => {
    await expect(authenticateApiToken(null, runtime.db)).resolves.toEqual({
      ok: false,
      reason: "missing",
    });
    await expect(authenticateApiToken("not-a-token", runtime.db)).resolves.toEqual({
      ok: false,
      reason: "malformed",
    });
    await expect(
      authenticateApiToken("mtk_v1_unknown", runtime.db),
    ).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });

    const expired = await createApiToken(
      userId,
      {
        name: "Expired",
        scopes: ["read:daily"],
        expiresAt: new Date(Date.now() - 60_000),
      },
      runtime.db,
    );
    await expect(authenticateApiToken(expired.token, runtime.db)).resolves.toEqual({
      ok: false,
      reason: "expired",
    });
    await expect(listApiTokens(userId, runtime.db)).resolves.toContainEqual(
      expect.objectContaining({
        id: expired.record.id,
        lastUsedAt: null,
      }),
    );

    const active = await createApiToken(
      userId,
      {
        name: "Revoked",
        scopes: ["read:daily"],
      },
      runtime.db,
    );
    await expect(
      revokeApiToken(userId, active.record.id, runtime.db),
    ).resolves.toBe(true);
    await expect(authenticateApiToken(active.token, runtime.db)).resolves.toEqual({
      ok: false,
      reason: "revoked",
    });
    await expect(listApiTokens(userId, runtime.db)).resolves.toContainEqual(
      expect.objectContaining({
        id: active.record.id,
        lastUsedAt: null,
      }),
    );
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

  it("does not count calorie overshoots as goal hits", async () => {
    await saveUserGoals(
      userId,
      {
        caloriesKcal: 2000,
        proteinG: null,
        carbsG: null,
        fatG: null,
      },
      runtime.db,
    );
    await createMealEntry(
      userId,
      {
        date: "2026-03-18",
        label: "Target day",
        proteinG: 120,
        carbsG: 220,
        fatG: 70,
        caloriesKcal: 2000,
      },
      runtime.db,
    );
    await createMealEntry(
      userId,
      {
        date: "2026-03-19",
        label: "Overshoot day",
        proteinG: 150,
        carbsG: 300,
        fatG: 90,
        caloriesKcal: 2300,
      },
      runtime.db,
    );

    const stats = await getStatsPageData(userId, "2026-03-19", runtime.db);

    expect(stats.goalHitRates.days7.caloriesKcal).toBe(50);
  });

  it("includes planned macros in stats trend data without counting them as eaten totals", async () => {
    await createMealEntry(
      userId,
      {
        date: "2026-03-19",
        label: "Logged lunch",
        sortOrder: 0,
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
        status: "planned",
        label: "Planned dinner",
        sortOrder: 1,
        proteinG: 25,
        carbsG: 50,
        fatG: 15,
        caloriesKcal: 435,
      },
      runtime.db,
    );
    await createMealEntry(
      userId,
      {
        date: "2026-03-20",
        status: "planned",
        label: "Tomorrow oats",
        sortOrder: 0,
        proteinG: 10,
        carbsG: 35,
        fatG: 5,
        caloriesKcal: 225,
      },
      runtime.db,
    );

    const stats = await getStatsPageData(userId, "2026-03-20", runtime.db);

    expect(stats.totalDaysTracked).toBe(1);
    expect(stats.totalCaloriesKcal).toBe(370);
    expect(stats.rollingAverages.days7.caloriesKcal).toBe(370);
    expect(stats.allDailyTotals).toEqual([
      {
        date: "2026-03-19",
        proteinG: 30,
        carbsG: 40,
        fatG: 10,
        caloriesKcal: 370,
        plannedTotals: {
          proteinG: 25,
          carbsG: 50,
          fatG: 15,
          caloriesKcal: 435,
        },
      },
      {
        date: "2026-03-20",
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
        caloriesKcal: 0,
        plannedTotals: {
          proteinG: 10,
          carbsG: 35,
          fatG: 5,
          caloriesKcal: 225,
        },
      },
    ]);
  });

  it("excludes future planned entries from earlier stats trend data", async () => {
    await createMealEntry(
      userId,
      {
        date: "2026-03-20",
        status: "planned",
        label: "Tomorrow oats",
        sortOrder: 0,
        proteinG: 10,
        carbsG: 35,
        fatG: 5,
        caloriesKcal: 225,
      },
      runtime.db,
    );

    const earlierStats = await getStatsPageData(userId, "2026-03-19", runtime.db);

    expect(earlierStats.totalDaysTracked).toBe(0);
    expect(earlierStats.totalCaloriesKcal).toBe(0);
    expect(earlierStats.allDailyTotals).toEqual([]);

    const plannedDateStats = await getStatsPageData(userId, "2026-03-20", runtime.db);

    expect(plannedDateStats.totalDaysTracked).toBe(0);
    expect(plannedDateStats.totalCaloriesKcal).toBe(0);
    expect(plannedDateStats.allDailyTotals).toEqual([
      {
        date: "2026-03-20",
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
        caloriesKcal: 0,
        plannedTotals: {
          proteinG: 10,
          carbsG: 35,
          fatG: 5,
          caloriesKcal: 225,
        },
      },
    ]);
  });

  it("keeps future eaten entries in stats trend data to match aggregate totals", async () => {
    await createMealEntry(
      userId,
      {
        date: "2026-03-20",
        label: "Logged ahead",
        sortOrder: 0,
        proteinG: 42,
        carbsG: 60,
        fatG: 20,
        caloriesKcal: 588,
      },
      runtime.db,
    );
    await createMealEntry(
      userId,
      {
        date: "2026-03-20",
        status: "planned",
        label: "Future planned snack",
        sortOrder: 1,
        proteinG: 15,
        carbsG: 20,
        fatG: 8,
        caloriesKcal: 212,
      },
      runtime.db,
    );

    const stats = await getStatsPageData(userId, "2026-03-19", runtime.db);

    expect(stats.totalDaysTracked).toBe(1);
    expect(stats.totalCaloriesKcal).toBe(588);
    expect(stats.rollingAverages.days7.caloriesKcal).toBe(588);
    expect(stats.allDailyTotals).toEqual([
      {
        date: "2026-03-20",
        proteinG: 42,
        carbsG: 60,
        fatG: 20,
        caloriesKcal: 588,
        plannedTotals: {
          proteinG: 0,
          carbsG: 0,
          fatG: 0,
          caloriesKcal: 0,
        },
      },
    ]);
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

  it("tracks meal groups and excludes planned or skipped entries from eaten totals", async () => {
    const groups = await getMealGroups(userId, runtime.db);
    expect(groups.map((group) => group.label)).toEqual([
      "Breakfast",
      "Lunch",
      "Dinner",
      "Snack",
    ]);

    const supper = await createMealGroup(userId, { label: "Supper" }, runtime.db);
    const eaten = await createMealEntry(
      userId,
      {
        date: "2026-04-12",
        mealGroupId: supper.id,
        label: "Salmon bowl",
        proteinG: 40,
        carbsG: 50,
        fatG: 18,
        caloriesKcal: 520,
      },
      runtime.db,
    );
    const planned = await createMealEntry(
      userId,
      {
        date: "2026-04-12",
        status: "planned",
        label: "Evening shake",
        proteinG: 30,
        carbsG: 10,
        fatG: 2,
        caloriesKcal: 180,
      },
      runtime.db,
    );

    let summary = await getDailySummary(userId, "2026-04-12", runtime.db);
    expect(summary.totals.caloriesKcal).toBe(520);
    expect(summary.plannedTotals.caloriesKcal).toBe(180);
    expect(summary.meals.find((meal) => meal.id === eaten.id)?.mealGroupId).toBe(supper.id);

    await markMealEntryStatus(userId, planned.id, "eaten", runtime.db);
    summary = await getDailySummary(userId, "2026-04-12", runtime.db);
    expect(summary.totals.caloriesKcal).toBe(700);
    expect(summary.plannedTotals.caloriesKcal).toBe(0);
  });

  it("rejects inaccessible or deleted meal groups on meal entry saves", async () => {
    const otherUserId = await createOtherUser();
    const otherGroup = await createMealGroup(
      otherUserId,
      { label: "Other user's dinner" },
      runtime.db,
    );

    await expect(
      createMealEntry(
        userId,
        {
          date: "2026-05-01",
          mealGroupId: otherGroup.id,
          label: "Cross-user group",
          proteinG: 10,
          carbsG: 10,
          fatG: 5,
          caloriesKcal: 125,
        },
        runtime.db,
      ),
    ).rejects.toThrow("Meal group not found.");

    const meal = await createMealEntry(
      userId,
      {
        date: "2026-05-01",
        label: "Owned meal",
        proteinG: 20,
        carbsG: 20,
        fatG: 10,
        caloriesKcal: 250,
      },
      runtime.db,
    );

    await expect(
      updateMealEntry(
        userId,
        meal.id,
        {
          date: meal.date,
          mealGroupId: otherGroup.id,
          label: meal.label,
          sortOrder: meal.sortOrder,
          proteinG: 25,
          carbsG: 20,
          fatG: 10,
          caloriesKcal: 270,
        },
        runtime.db,
      ),
    ).rejects.toThrow("Meal group not found.");

    const deletedGroup = await createMealGroup(
      userId,
      { label: "Temporary" },
      runtime.db,
    );
    await deleteMealGroup(userId, deletedGroup.id, runtime.db);

    await expect(
      createMealEntry(
        userId,
        {
          date: "2026-05-01",
          mealGroupId: deletedGroup.id,
          label: "Deleted group",
          proteinG: 10,
          carbsG: 10,
          fatG: 5,
          caloriesKcal: 125,
        },
        runtime.db,
      ),
    ).rejects.toThrow("Meal group not found.");
  });

  it("rejects inaccessible products and hides their labels from daily summaries", async () => {
    const otherProduct = await createOtherUserProduct({
      name: "Other user's yogurt",
      source: "manual",
      proteinPer100: 10,
      carbsPer100: 4,
      fatPer100: 2,
      caloriesPer100: 74,
    });

    await expect(
      createMealEntry(
        userId,
        {
          date: "2026-05-02",
          productId: otherProduct.id,
          label: "Cross-user product",
          proteinG: 15,
          carbsG: 6,
          fatG: 3,
          caloriesKcal: 111,
        },
        runtime.db,
      ),
    ).rejects.toThrow("Food product not found.");

    const meal = await createMealEntry(
      userId,
      {
        date: "2026-05-02",
        label: "Manual meal",
        proteinG: 20,
        carbsG: 20,
        fatG: 10,
        caloriesKcal: 250,
      },
      runtime.db,
    );

    await expect(
      updateMealEntry(
        userId,
        meal.id,
        {
          date: meal.date,
          productId: otherProduct.id,
          label: meal.label,
          sortOrder: meal.sortOrder,
          proteinG: 25,
          carbsG: 20,
          fatG: 10,
          caloriesKcal: 270,
        },
        runtime.db,
      ),
    ).rejects.toThrow("Food product not found.");

    const deletedProduct = await createPersonalFoodProduct(
      userId,
      {
        name: "Deleted product",
        source: "manual",
        proteinPer100: 10,
        carbsPer100: 4,
        fatPer100: 2,
        caloriesPer100: 74,
      },
      runtime.db,
    );
    await runtime.db
      .update(foodProducts)
      .set({ deletedAt: new Date() })
      .where(eq(foodProducts.id, deletedProduct.id));

    await expect(
      createMealEntry(
        userId,
        {
          date: "2026-05-02",
          productId: deletedProduct.id,
          label: "Deleted product meal",
          proteinG: 15,
          carbsG: 6,
          fatG: 3,
          caloriesKcal: 111,
        },
        runtime.db,
      ),
    ).rejects.toThrow("Food product not found.");

    await runtime.db.insert(mealEntries).values({
      id: randomUUID(),
      userId,
      entryDate: "2026-05-03",
      productId: otherProduct.id,
      label: "Bad legacy link",
      sortOrder: 0,
      proteinG: "1.0",
      carbsG: "1.0",
      fatG: "1.0",
      caloriesKcal: 16,
      updatedAt: new Date(),
    });

    const summary = await getDailySummary(userId, "2026-05-03", runtime.db);
    expect(summary.meals).toHaveLength(1);
    expect(summary.meals[0]?.productId).toBeNull();
    expect(summary.meals[0]?.sourceLabel).toBeNull();
  });

  it("rejects inaccessible template item products on create", async () => {
    const otherProduct = await createOtherUserProduct({
      name: "Other user's shake",
      source: "manual",
      proteinPer100: 24,
      carbsPer100: 12,
      fatPer100: 3,
      caloriesPer100: 171,
    });

    await expect(
      createTemplate(
        userId,
        {
          type: "meal",
          label: "Cross-user template",
          items: [
            {
              productId: otherProduct.id,
              label: "Cross-user shake",
              quantity: 76,
              unit: "g",
              servingMultiplier: 0.5,
              proteinG: 24,
              carbsG: 12,
              fatG: 3,
              caloriesKcal: 171,
            },
          ],
        },
        runtime.db,
      ),
    ).rejects.toThrow("Food product not found.");

    const deletedProduct = await createPersonalFoodProduct(
      userId,
      {
        name: "Deleted template product",
        source: "manual",
        proteinPer100: 10,
        carbsPer100: 4,
        fatPer100: 2,
        caloriesPer100: 74,
      },
      runtime.db,
    );
    await runtime.db
      .update(foodProducts)
      .set({ deletedAt: new Date() })
      .where(eq(foodProducts.id, deletedProduct.id));

    await expect(
      createTemplate(
        userId,
        {
          type: "meal",
          label: "Deleted product template",
          items: [
            {
              productId: deletedProduct.id,
              label: "Deleted product",
              proteinG: 10,
              carbsG: 4,
              fatG: 2,
              caloriesKcal: 74,
            },
          ],
        },
        runtime.db,
      ),
    ).rejects.toThrow("Food product not found.");

    expect(await getTemplates(userId, runtime.db)).toHaveLength(0);
  });

  it("rejects inaccessible template item products on update", async () => {
    const original = await createTemplate(
      userId,
      {
        type: "meal",
        label: "Original template",
        items: [
          {
            label: "Original oats",
            proteinG: 20,
            carbsG: 40,
            fatG: 8,
            caloriesKcal: 312,
          },
        ],
      },
      runtime.db,
    );
    const otherProduct = await createOtherUserProduct({
      name: "Other user's yogurt",
      source: "manual",
      proteinPer100: 10,
      carbsPer100: 4,
      fatPer100: 2,
      caloriesPer100: 74,
    });

    await expect(
      updateTemplate(
        userId,
        original.id,
        {
          type: "meal",
          label: "Cross-user update",
          items: [
            {
              productId: otherProduct.id,
              label: "Yogurt",
              proteinG: 15,
              carbsG: 6,
              fatG: 3,
              caloriesKcal: 111,
            },
          ],
        },
        runtime.db,
      ),
    ).rejects.toThrow("Food product not found.");

    const deletedProduct = await createPersonalFoodProduct(
      userId,
      {
        name: "Deleted template yogurt",
        source: "manual",
        proteinPer100: 10,
        carbsPer100: 4,
        fatPer100: 2,
        caloriesPer100: 74,
      },
      runtime.db,
    );
    await runtime.db
      .update(foodProducts)
      .set({ deletedAt: new Date() })
      .where(eq(foodProducts.id, deletedProduct.id));

    await expect(
      updateTemplate(
        userId,
        original.id,
        {
          type: "meal",
          label: "Deleted product update",
          items: [
            {
              productId: deletedProduct.id,
              label: "Deleted yogurt",
              proteinG: 15,
              carbsG: 6,
              fatG: 3,
              caloriesKcal: 111,
            },
          ],
        },
        runtime.db,
      ),
    ).rejects.toThrow("Food product not found.");

    const stored = (await getTemplates(userId, runtime.db)).find(
      (template) => template.id === original.id,
    );
    expect(stored).toMatchObject({
      label: "Original template",
      type: "meal",
    });
    expect(stored?.items).toHaveLength(1);
    expect(stored?.items[0]).toMatchObject({
      productId: null,
      label: "Original oats",
      quantity: 1,
      unit: "serving",
      servingMultiplier: 1,
    });
  });

  it("allows global barcode products in templates and preserves quantity details", async () => {
    const product = await saveBarcodeFoodProduct(
      userId,
      {
        barcode: "8712345000099",
        name: "Scanned Protein Drink",
        brands: "Macro Lab",
        proteinG: 20,
        carbsG: 8,
        fatG: 2,
        caloriesKcal: 130,
        servingSizeG: 250,
      },
      runtime.db,
    );

    const created = await createTemplate(
      userId,
      {
        type: "meal",
        label: "Scanned protein drink",
        items: [
          {
            productId: product.id,
            label: "Scanned Protein Drink",
            quantity: 76,
            unit: "g",
            servingMultiplier: 0.76,
            proteinG: 6.1,
            carbsG: 2.4,
            fatG: 0.6,
            caloriesKcal: 40,
          },
        ],
      },
      runtime.db,
    );
    expect(created.items[0]).toMatchObject({
      productId: product.id,
      quantity: 76,
      unit: "g",
      servingMultiplier: 0.76,
    });

    const updated = await updateTemplate(
      userId,
      created.id,
      {
        type: "meal",
        label: "Scanned protein drink updated",
        items: [
          {
            productId: product.id,
            label: "Scanned Protein Drink",
            quantity: 125,
            unit: "g",
            servingMultiplier: 1.25,
            proteinG: 10,
            carbsG: 4,
            fatG: 1,
            caloriesKcal: 65,
          },
        ],
      },
      runtime.db,
    );
    expect(updated.items[0]).toMatchObject({
      productId: product.id,
      quantity: 125,
      unit: "g",
      servingMultiplier: 1.25,
    });
  });

  it("prevalidates all template item product access before applying a template", async () => {
    const otherProduct = await createOtherUserProduct({
      name: "Other user's shake",
      source: "manual",
      proteinPer100: 24,
      carbsPer100: 12,
      fatPer100: 3,
      caloriesPer100: 171,
    });
    const templateId = randomUUID();
    await runtime.db.insert(mealTemplates).values({
      id: templateId,
      userId,
      type: "day",
      label: "Blocked template",
      updatedAt: new Date(),
    });
    await runtime.db.insert(mealTemplateItems).values([
      {
        id: randomUUID(),
        templateId,
        productId: null,
        mealGroupLabel: null,
        sortOrder: 0,
        label: "Accessible oats",
        quantity: "1.00",
        unit: "serving",
        servingMultiplier: "1.00",
        proteinG: "20.0",
        carbsG: "40.0",
        fatG: "8.0",
        caloriesKcal: 312,
      },
      {
        id: randomUUID(),
        templateId,
        productId: otherProduct.id,
        mealGroupLabel: null,
        sortOrder: 1,
        label: "Cross-user shake",
        quantity: "1.00",
        unit: "serving",
        servingMultiplier: "1.00",
        proteinG: "24.0",
        carbsG: "12.0",
        fatG: "3.0",
        caloriesKcal: 171,
      },
    ]);

    await expect(
      applyTemplateToDate(
        userId,
        {
          templateId,
          date: "2026-05-03",
        },
        runtime.db,
      ),
    ).rejects.toThrow("Food product not found.");

    const summary = await getDailySummary(userId, "2026-05-03", runtime.db);
    expect(summary.meals).toHaveLength(0);
  });

  it("rolls back all template entries when one item insert fails", async () => {
    const template = await createTemplate(
      userId,
      {
        type: "day",
        label: "Two item template",
        items: [
          {
            label: "Oats",
            proteinG: 20,
            carbsG: 40,
            fatG: 8,
            caloriesKcal: 312,
          },
          {
            label: "Yogurt",
            proteinG: 25,
            carbsG: 12,
            fatG: 2,
            caloriesKcal: 166,
          },
        ],
      },
      runtime.db,
    );

    await expect(
      applyTemplateToDate(
        userId,
        {
          templateId: template.id,
          date: "2026-05-04",
        },
        createFailingMealEntryInsertDb(2),
      ),
    ).rejects.toThrow("Forced meal entry insert failure.");

    const summary = await getDailySummary(userId, "2026-05-04", runtime.db);
    expect(summary.meals).toHaveLength(0);
  });

  it("rejects inaccessible recipe ingredient products on create", async () => {
    const otherProduct = await createOtherUserProduct({
      name: "Other user's oats",
      source: "manual",
      proteinPer100: 12,
      carbsPer100: 60,
      fatPer100: 7,
      caloriesPer100: 351,
    });

    await expect(
      createRecipe(
        userId,
        {
          label: "Cross-user recipe",
          portions: 2,
          ingredients: [
            {
              productId: otherProduct.id,
              label: "Oats",
              proteinG: 12,
              carbsG: 60,
              fatG: 7,
              caloriesKcal: 351,
            },
          ],
        },
        runtime.db,
      ),
    ).rejects.toThrow("Food product not found.");

    const deletedProduct = await createPersonalFoodProduct(
      userId,
      {
        name: "Deleted recipe product",
        source: "manual",
        proteinPer100: 10,
        carbsPer100: 4,
        fatPer100: 2,
        caloriesPer100: 74,
      },
      runtime.db,
    );
    await runtime.db
      .update(foodProducts)
      .set({ deletedAt: new Date() })
      .where(eq(foodProducts.id, deletedProduct.id));

    await expect(
      createRecipe(
        userId,
        {
          label: "Deleted product recipe",
          portions: 2,
          ingredients: [
            {
              productId: deletedProduct.id,
              label: "Deleted product",
              proteinG: 10,
              carbsG: 4,
              fatG: 2,
              caloriesKcal: 74,
            },
          ],
        },
        runtime.db,
      ),
    ).rejects.toThrow("Food product not found.");

    expect(await runtime.db.select().from(recipes)).toHaveLength(0);
    expect(await runtime.db.select().from(recipeIngredients)).toHaveLength(0);
  });

  it("rejects inaccessible recipe ingredient products on update", async () => {
    const original = await createRecipe(
      userId,
      {
        label: "Original recipe",
        portions: 2,
        ingredients: [
          {
            label: "Eggs",
            proteinG: 12,
            carbsG: 1,
            fatG: 10,
            caloriesKcal: 140,
          },
        ],
      },
      runtime.db,
    );
    const otherProduct = await createOtherUserProduct({
      name: "Other user's yogurt",
      source: "manual",
      proteinPer100: 10,
      carbsPer100: 4,
      fatPer100: 2,
      caloriesPer100: 74,
    });

    await expect(
      updateRecipe(
        userId,
        original.id,
        {
          label: "Invalid update",
          portions: 3,
          ingredients: [
            {
              productId: otherProduct.id,
              label: "Yogurt",
              proteinG: 15,
              carbsG: 6,
              fatG: 3,
              caloriesKcal: 111,
            },
          ],
        },
        runtime.db,
      ),
    ).rejects.toThrow("Food product not found.");

    const deletedProduct = await createPersonalFoodProduct(
      userId,
      {
        name: "Deleted yogurt",
        source: "manual",
        proteinPer100: 10,
        carbsPer100: 4,
        fatPer100: 2,
        caloriesPer100: 74,
      },
      runtime.db,
    );
    await runtime.db
      .update(foodProducts)
      .set({ deletedAt: new Date() })
      .where(eq(foodProducts.id, deletedProduct.id));

    await expect(
      updateRecipe(
        userId,
        original.id,
        {
          label: "Invalid deleted update",
          portions: 3,
          ingredients: [
            {
              productId: deletedProduct.id,
              label: "Deleted yogurt",
              proteinG: 15,
              carbsG: 6,
              fatG: 3,
              caloriesKcal: 111,
            },
          ],
        },
        runtime.db,
      ),
    ).rejects.toThrow("Food product not found.");

    const stored = await getRecipeById(userId, original.id, runtime.db);
    expect(stored).toMatchObject({
      label: "Original recipe",
      portions: 2,
    });
    expect(stored?.ingredients).toHaveLength(1);
    expect(stored?.ingredients[0]).toMatchObject({
      label: "Eggs",
      productId: null,
    });
  });

  it("preserves manual macro edits for legacy product-linked meals", async () => {
    const legacyProduct = await createPersonalFoodProduct(
      userId,
      {
        name: "Legacy oats",
        scope: "legacy",
        source: "legacy",
        defaultServingQuantity: 1,
        defaultServingUnit: "serving",
        proteinPer100: 100,
        carbsPer100: 100,
        fatPer100: 100,
        caloriesPer100: 1600,
        servingWeightG: 100,
      },
      runtime.db,
    );

    const entry = await createMealEntry(
      userId,
      {
        date: "2026-05-04",
        productId: legacyProduct.id,
        label: "Legacy oats",
        quantity: 1,
        unit: "serving",
        proteinG: 5,
        carbsG: 27,
        fatG: 3,
        caloriesKcal: 150,
      },
      runtime.db,
    );

    expect(entry).toMatchObject({
      productId: legacyProduct.id,
      proteinG: 5,
      carbsG: 27,
      fatG: 3,
      caloriesKcal: 150,
    });

    const updated = await updateMealEntry(
      userId,
      entry.id,
      {
        date: entry.date,
        productId: legacyProduct.id,
        label: "Legacy oats edited",
        sortOrder: entry.sortOrder,
        quantity: 1,
        unit: "serving",
        proteinG: 7,
        carbsG: 30,
        fatG: 4,
        caloriesKcal: 180,
      },
      runtime.db,
    );

    expect(updated).toMatchObject({
      productId: legacyProduct.id,
      label: "Legacy oats edited",
      proteinG: 7,
      carbsG: 30,
      fatG: 4,
      caloriesKcal: 180,
    });
  });

  it("seeds default meal groups idempotently across concurrent first requests", async () => {
    await Promise.all([
      ensureDefaultMealGroups(userId, runtime.db),
      ensureDefaultMealGroups(userId, runtime.db),
    ]);

    const groups = await getMealGroups(userId, runtime.db);
    expect(groups.map((group) => group.label)).toEqual([
      "Breakfast",
      "Lunch",
      "Dinner",
      "Snack",
    ]);
    expect(new Set(groups.map((group) => group.id)).size).toBe(4);
  });

  it("rolls back meal group deletion when unassigning entries fails", async () => {
    const group = await createMealGroup(userId, { label: "Supper" }, runtime.db);
    const entry = await createMealEntry(
      userId,
      {
        date: "2026-05-05",
        mealGroupId: group.id,
        label: "Salmon bowl",
        proteinG: 40,
        carbsG: 50,
        fatG: 18,
        caloriesKcal: 520,
      },
      runtime.db,
    );

    await expect(
      deleteMealGroup(userId, group.id, createFailingMealGroupDeleteDb()),
    ).rejects.toThrow("Forced meal group unassign failure.");

    const groups = await getMealGroups(userId, runtime.db);
    expect(groups.map((item) => item.id)).toContain(group.id);

    const summary = await getDailySummary(userId, "2026-05-05", runtime.db);
    expect(summary.meals.find((meal) => meal.id === entry.id)?.mealGroupId).toBe(
      group.id,
    );
  });

  it("returns the existing meal for concurrent creates with the same client mutation id", async () => {
    const input = {
      date: "2026-05-06",
      label: "Idempotent shake",
      proteinG: 30,
      carbsG: 20,
      fatG: 5,
      caloriesKcal: 245,
      clientMutationId: "meal-entry-concurrent-1",
    };

    const [first, second] = await Promise.all([
      createMealEntry(userId, input, runtime.db),
      createMealEntry(userId, input, runtime.db),
    ]);

    expect(second.id).toBe(first.id);
    const summary = await getDailySummary(userId, "2026-05-06", runtime.db);
    expect(
      summary.meals.filter(
        (meal) => meal.clientMutationId === "meal-entry-concurrent-1",
      ),
    ).toHaveLength(1);
  });

  it("creates searchable products and resolves quantity-scaled nutrition", async () => {
    const product = await createPersonalFoodProduct(
      userId,
      {
        name: "Greek yogurt 2%",
        source: "manual",
        defaultServingQuantity: 150,
        defaultServingUnit: "g",
        proteinPer100: 10,
        carbsPer100: 4,
        fatPer100: 2,
        caloriesPer100: 74,
      },
      runtime.db,
    );

    const results = await searchFoodProducts(userId, "greek", runtime.db);
    expect(results.map((item) => item.id)).toContain(product.id);
    expect(resolveProductNutritionForQuantity(product, 150, "g")).toEqual({
      proteinG: 15,
      carbsG: 6,
      fatG: 3,
      caloriesKcal: 111,
    });
  });

  it("creates community barcode products and searchable food products atomically", async () => {
    const input = {
      barcode: "8712345000001",
      name: "Community Protein Drink",
      brands: "Macro Lab",
      proteinG: 20,
      carbsG: 8,
      fatG: 2,
      caloriesKcal: 130,
      servingSizeG: 250,
    };

    await expect(
      saveBarcodeFoodProduct(userId, input, createFailingBarcodeFoodProductDb()),
    ).rejects.toThrow("Forced barcode food product insert failure.");

    expect(await lookupBarcodeFoodProduct(input.barcode, runtime.db)).toBeNull();
    expect(await searchFoodProducts(userId, "Community Protein", runtime.db)).toEqual(
      [],
    );

    const saved = await saveBarcodeFoodProduct(userId, input, runtime.db);
    expect(saved).toMatchObject({
      barcode: input.barcode,
      name: input.name,
      submittedByUserId: userId,
      sourceProvider: "community",
    });

    const products = await searchFoodProducts(
      userId,
      "Community Protein",
      runtime.db,
    );
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      ownerUserId: null,
      scope: "global",
      source: "barcode",
      barcode: input.barcode,
      name: input.name,
      brand: input.brands,
      proteinPer100: 20,
      carbsPer100: 8,
      fatPer100: 2,
      caloriesPer100: 130,
      servingWeightG: 250,
    });

    await expect(
      searchFoodProducts(userId, "Macro Lab", runtime.db),
    ).resolves.toHaveLength(1);
    await expect(
      searchFoodProducts(userId, input.barcode, runtime.db),
    ).resolves.toHaveLength(1);
  });

  it("forces user-created products to personal scope and validates product enums", async () => {
    const baseProduct = {
      name: "Shared almonds",
      source: "manual" as const,
      defaultServingQuantity: 100,
      defaultServingUnit: "g" as const,
      proteinPer100: 21,
      carbsPer100: 22,
      fatPer100: 49,
      caloriesPer100: 579,
    };
    const product = await createPersonalFoodProduct(
      userId,
      {
        ...baseProduct,
        scope: "global",
      },
      runtime.db,
    );

    expect(product.scope).toBe("personal");
    expect(product.ownerUserId).toBe(userId);

    const otherUserId = await createOtherUser();
    const otherResults = await searchFoodProducts(
      otherUserId,
      "shared almonds",
      runtime.db,
    );
    expect(otherResults.map((item) => item.id)).not.toContain(product.id);

    await expect(
      createPersonalFoodProduct(
        userId,
        { ...baseProduct, name: "Bad scope", scope: "shared" as never },
        runtime.db,
      ),
    ).rejects.toThrow("Product scope is invalid.");

    await expect(
      createPersonalFoodProduct(
        userId,
        { ...baseProduct, name: "Bad source", source: "feed" as never },
        runtime.db,
      ),
    ).rejects.toThrow("Product source is invalid.");
  });

  it("preserves recipe cooked weight and ingredient quantity metadata", async () => {
    const recipe = await createRecipe(
      userId,
      {
        label: "Rice pot",
        portions: 4,
        totalCookedWeightG: 900,
        ingredients: [
          {
            label: "Rice",
            quantity: 250,
            unit: "g",
            proteinG: 18,
            carbsG: 190,
            fatG: 2,
            caloriesKcal: 850,
          },
        ],
      },
      runtime.db,
    );

    expect(recipe.totalCookedWeightG).toBe(900);
    expect(recipe.ingredients[0]).toMatchObject({
      quantity: 250,
      unit: "g",
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

  it("returns quick-add candidates with sourceDate, observedUseDays, and habit metadata", async () => {
    await createMealWithCreatedAt(
      {
        date: "2026-04-01",
        label: "Oats",
        proteinG: 5,
        carbsG: 27,
        fatG: 3,
        caloriesKcal: 150,
      },
      "2026-04-01T07:15:00.000Z",
    );
    await createMealWithCreatedAt(
      {
        date: "2026-04-03",
        label: "Oats",
        proteinG: 5,
        carbsG: 27,
        fatG: 3,
        caloriesKcal: 150,
      },
      "2026-04-03T07:30:00.000Z",
    );
    await createMealWithCreatedAt(
      {
        date: "2026-04-05",
        label: "Oats",
        proteinG: 5,
        carbsG: 27,
        fatG: 3,
        caloriesKcal: 150,
      },
      "2026-04-05T08:00:00.000Z",
    );

    const candidates = await getRecentQuickAddCandidates(userId, 10, runtime.db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      label: "Oats",
      sourceDate: "2026-04-05",
      observedUseDays: 3,
      peakHourUtc: 7,
      habitCount: 3,
    });
  });

  it("completes onboarding setup with goals, weight, starter template, and user preferences", async () => {
    const user = await completeOnboardingSetup(
      userId,
      {
        preferredWeightUnit: "lb",
        goals: {
          caloriesKcal: 2200,
          proteinG: 170,
          carbsG: 240,
          fatG: 70,
        },
        goalWeightKg: 78,
        currentWeight: {
          date: "2026-06-20",
          weightKg: 82.5,
          bodyFatPct: null,
          notes: "Onboarding",
        },
        starterTemplate: {
          type: "meal",
          label: "Greek yogurt",
          items: [
            {
              label: "Greek yogurt",
              proteinG: 30,
              carbsG: 12,
              fatG: 2,
              caloriesKcal: 186,
            },
          ],
        },
      },
      runtime.db,
    );

    expect(user).toMatchObject({
      onboardingCompletedAt: expect.any(String),
      preferredWeightUnit: "lb",
    });
    await expect(getUserGoals(userId, runtime.db)).resolves.toEqual({
      caloriesKcal: 2200,
      proteinG: 170,
      carbsG: 240,
      fatG: 70,
    });
    const weightData = await getWeightPageData(userId, "2026-06-20", runtime.db);
    expect(weightData.goalWeightKg).toBe(78);
    expect(weightData.entries).toMatchObject([
      {
        date: "2026-06-20",
        weightKg: 82.5,
        notes: "Onboarding",
      },
    ]);
    await expect(getTemplates(userId, runtime.db)).resolves.toMatchObject([
      {
        label: "Greek yogurt",
        type: "meal",
      },
    ]);
  });

  it("rolls back onboarding setup when starter template creation fails", async () => {
    await expect(
      completeOnboardingSetup(
        userId,
        {
          preferredWeightUnit: "kg",
          goals: {
            caloriesKcal: 2200,
            proteinG: 170,
            carbsG: 240,
            fatG: 70,
          },
          goalWeightKg: 78,
          currentWeight: {
            date: "2026-06-20",
            weightKg: 82.5,
            bodyFatPct: null,
            notes: "Onboarding",
          },
          starterTemplate: {
            type: "meal",
            label: "Broken starter",
            items: [],
          },
        },
        runtime.db,
      ),
    ).rejects.toThrow("A template must include at least one item.");

    await expect(getUserGoals(userId, runtime.db)).resolves.toEqual({
      caloriesKcal: null,
      proteinG: null,
      carbsG: null,
      fatG: null,
    });
    const weightData = await getWeightPageData(userId, "2026-06-20", runtime.db);
    expect(weightData.goalWeightKg).toBeNull();
    expect(weightData.entries).toHaveLength(0);
    await expect(getTemplates(userId, runtime.db)).resolves.toEqual([]);
    await expect(getUserById(userId, runtime.db)).resolves.toMatchObject({
      onboardingCompletedAt: null,
      preferredWeightUnit: "kg",
    });
  });

  it("uses the requested leaderboard reference date for streaks", async () => {
    await createMealEntry(userId, {
      date: "2026-03-18",
      mealGroupId: null,
      status: "eaten",
      label: "Protein bowl",
      proteinG: 35,
      carbsG: 45,
      fatG: 12,
      caloriesKcal: 430,
    }, runtime.db);
    await createMealEntry(userId, {
      date: "2026-03-19",
      mealGroupId: null,
      status: "eaten",
      label: "Rice bowl",
      proteinG: 25,
      carbsG: 60,
      fatG: 8,
      caloriesKcal: 500,
    }, runtime.db);
    await createMealEntry(userId, {
      date: "2026-03-20",
      mealGroupId: null,
      status: "eaten",
      label: "Yogurt",
      proteinG: 20,
      carbsG: 25,
      fatG: 4,
      caloriesKcal: 240,
    }, runtime.db);

    await expect(getLeaderboardStats(userId, "2026-03-20", runtime.db)).resolves.toMatchObject({
      currentStreak: 3,
      longestStreak: 3,
    });
    await expect(getLeaderboardStats(userId, "2026-03-22", runtime.db)).resolves.toMatchObject({
      currentStreak: 0,
      longestStreak: 3,
    });
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

  it("counts distinct logged dates for observedUseDays", async () => {
    await createMealWithCreatedAt(
      {
        date: "2026-04-08",
        label: "Bagel",
        proteinG: 10,
        carbsG: 40,
        fatG: 4,
        caloriesKcal: 230,
      },
      "2026-04-08T07:10:00.000Z",
    );
    await createMealWithCreatedAt(
      {
        date: "2026-04-08",
        label: "Bagel",
        proteinG: 10,
        carbsG: 40,
        fatG: 4,
        caloriesKcal: 230,
      },
      "2026-04-08T07:40:00.000Z",
    );
    await createMealWithCreatedAt(
      {
        date: "2026-04-10",
        label: "Bagel",
        proteinG: 10,
        carbsG: 40,
        fatG: 4,
        caloriesKcal: 230,
      },
      "2026-04-10T07:25:00.000Z",
    );

    const candidates = await getRecentQuickAddCandidates(userId, 10, runtime.db);
    expect(candidates[0]).toMatchObject({
      label: "Bagel",
      sourceDate: "2026-04-10",
      observedUseDays: 2,
    });
  });

  it("only marks a habit once at least three logs share the same time bucket", async () => {
    await createMealWithCreatedAt(
      {
        date: "2026-04-11",
        label: "Toast",
        proteinG: 6,
        carbsG: 20,
        fatG: 2,
        caloriesKcal: 130,
      },
      "2026-04-11T07:00:00.000Z",
    );
    await createMealWithCreatedAt(
      {
        date: "2026-04-12",
        label: "Toast",
        proteinG: 6,
        carbsG: 20,
        fatG: 2,
        caloriesKcal: 130,
      },
      "2026-04-12T08:00:00.000Z",
    );

    let candidates = await getRecentQuickAddCandidates(userId, 10, runtime.db);
    expect(candidates[0]).toMatchObject({
      label: "Toast",
      observedUseDays: 2,
    });
    expect(candidates[0]?.peakHourUtc).toBeUndefined();
    expect(candidates[0]?.habitCount).toBeUndefined();

    await createMealWithCreatedAt(
      {
        date: "2026-04-13",
        label: "Toast",
        proteinG: 6,
        carbsG: 20,
        fatG: 2,
        caloriesKcal: 130,
      },
      "2026-04-13T07:20:00.000Z",
    );

    candidates = await getRecentQuickAddCandidates(userId, 10, runtime.db);
    expect(candidates[0]).toMatchObject({
      label: "Toast",
      observedUseDays: 3,
      peakHourUtc: 7,
      habitCount: 3,
    });
  });

  it("rolls back recipe creation if an ingredient insert fails mid-transaction", async () => {
    const failingDb = createFailingRecipeDb(2);

    await expect(
      createRecipe(
        userId,
        {
          label: "Failed Recipe",
          portions: 2,
          ingredients: [
            {
              label: "Chicken",
              proteinG: 30,
              carbsG: 0,
              fatG: 5,
              caloriesKcal: 170,
            },
            {
              label: "Rice",
              proteinG: 4,
              carbsG: 40,
              fatG: 1,
              caloriesKcal: 185,
            },
          ],
        },
        failingDb,
      ),
    ).rejects.toThrow("Forced ingredient insert failure.");

    const recipeRows = await runtime.db.select().from(recipes);
    const ingredientRows = await runtime.db.select().from(recipeIngredients);

    expect(recipeRows).toHaveLength(0);
    expect(ingredientRows).toHaveLength(0);
  });

  it("rolls back recipe updates when replacing ingredients fails mid-transaction", async () => {
    const original = await createRecipe(
      userId,
      {
        label: "Original Recipe",
        portions: 2,
        ingredients: [
          {
            label: "Eggs",
            proteinG: 12,
            carbsG: 1,
            fatG: 10,
            caloriesKcal: 140,
          },
          {
            label: "Toast",
            proteinG: 4,
            carbsG: 20,
            fatG: 2,
            caloriesKcal: 120,
          },
        ],
      },
      runtime.db,
    );
    const failingDb = createFailingRecipeDb(2);

    await expect(
      updateRecipe(
        userId,
        original.id,
        {
          label: "Updated Recipe",
          portions: 3,
          ingredients: [
            {
              label: "Yogurt",
              proteinG: 15,
              carbsG: 8,
              fatG: 0,
              caloriesKcal: 92,
            },
            {
              label: "Berries",
              proteinG: 1,
              carbsG: 12,
              fatG: 0,
              caloriesKcal: 49,
            },
          ],
        },
        failingDb,
      ),
    ).rejects.toThrow("Forced ingredient insert failure.");

    const stored = await getRecipeById(userId, original.id, runtime.db);

    expect(stored).toMatchObject({
      id: original.id,
      label: "Original Recipe",
      portions: 2,
    });
    expect(stored?.ingredients.map((ingredient) => ingredient.label)).toEqual([
      "Eggs",
      "Toast",
    ]);
  });
});
