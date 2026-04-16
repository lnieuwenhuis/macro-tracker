import { and, asc, desc, eq, gte, ilike, inArray, lte, max, sql } from "drizzle-orm";

import { computeStreaks, getPeriodRanges } from "./dates";
import { getDb, type DatabaseClient } from "./client";
import { barcodeProducts, foodPresets, mealEntries, recipeIngredients, recipes, users, weightEntries } from "./schema";
import { validateMealEntryInput, validateRecipeInput, validateWeightEntryInput } from "./validators";
import type {
  CustomBarcodeProduct,
  CustomBarcodeProductInput,
  DailyOverview,
  DailySummary,
  FoodPreset,
  MacroGoals,
  MacroNumbers,
  MealEntryInput,
  MealEntryRecord,
  PeriodAverage,
  QuickAddCandidate,
  RecentQuickAddItem,
  RecipeIngredientRecord,
  RecipeInput,
  RecipeRecord,
  ShooProfile,
  StatsPageData,
  WeightEntryInput,
  WeightEntryRecord,
  WeightPageData,
} from "./types";

type DailyTotalsRow = {
  entryDate: string;
  proteinG: string | number;
  carbsG: string | number;
  fatG: string | number;
  caloriesKcal: string | number;
  itemCount?: string | number;
};

type UserSelectRow = {
  id: string;
  email: string;
  shooPairwiseSub: string;
  displayName: string | null;
  pictureUrl: string | null;
};

function toNumber(value: string | number | null | undefined) {
  return Number(value ?? 0);
}

function zeroMacros(): MacroNumbers {
  return {
    proteinG: 0,
    carbsG: 0,
    fatG: 0,
    caloriesKcal: 0,
  };
}

function roundToSingleDecimal(value: number) {
  return Math.round(value * 10) / 10;
}

function normalizeQuickAddLabel(label: string) {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function getQuickAddCandidateKey(candidate: Pick<QuickAddCandidate, "label" | "proteinG" | "carbsG" | "fatG" | "caloriesKcal">) {
  return [
    normalizeQuickAddLabel(candidate.label),
    roundToSingleDecimal(candidate.proteinG),
    roundToSingleDecimal(candidate.carbsG),
    roundToSingleDecimal(candidate.fatG),
    Math.round(candidate.caloriesKcal),
  ].join("|");
}

function mapMealRow(row: {
  id: string;
  userId: string;
  date?: string;
  entryDate?: string;
  label: string;
  sortOrder: number;
  proteinG: string | number;
  carbsG: string | number;
  fatG: string | number;
  caloriesKcal: number;
}): MealEntryRecord {
  return {
    id: row.id,
    userId: row.userId,
    date: row.date ?? row.entryDate ?? "",
    label: row.label,
    sortOrder: row.sortOrder,
    proteinG: roundToSingleDecimal(toNumber(row.proteinG)),
    carbsG: roundToSingleDecimal(toNumber(row.carbsG)),
    fatG: roundToSingleDecimal(toNumber(row.fatG)),
    caloriesKcal: row.caloriesKcal,
  };
}

async function resolveDb(db?: DatabaseClient) {
  return db ?? (await getDb());
}

async function getDailyTotalsForRange(
  userId: string,
  startDate: string,
  endDate: string,
  db?: DatabaseClient,
) {
  const database = await resolveDb(db);

  const rows = await database
    .select({
      entryDate: mealEntries.entryDate,
      proteinG: sql<string>`coalesce(sum(${mealEntries.proteinG}), 0)`,
      carbsG: sql<string>`coalesce(sum(${mealEntries.carbsG}), 0)`,
      fatG: sql<string>`coalesce(sum(${mealEntries.fatG}), 0)`,
      caloriesKcal: sql<string>`coalesce(sum(${mealEntries.caloriesKcal}), 0)`,
    })
    .from(mealEntries)
    .where(
      and(
        eq(mealEntries.userId, userId),
        gte(mealEntries.entryDate, startDate),
        lte(mealEntries.entryDate, endDate),
      ),
    )
    .groupBy(mealEntries.entryDate)
    .orderBy(mealEntries.entryDate);

  return rows as DailyTotalsRow[];
}

function buildAverage(
  label: PeriodAverage["label"],
  startDate: string,
  endDate: string,
  rows: DailyTotalsRow[],
): PeriodAverage {
  if (rows.length === 0) {
    return {
      label,
      startDate,
      endDate,
      loggedDays: 0,
      averages: zeroMacros(),
    };
  }

  const totals = rows.reduce(
    (carry, row) => ({
      proteinG: carry.proteinG + toNumber(row.proteinG),
      carbsG: carry.carbsG + toNumber(row.carbsG),
      fatG: carry.fatG + toNumber(row.fatG),
      caloriesKcal: carry.caloriesKcal + toNumber(row.caloriesKcal),
    }),
    zeroMacros(),
  );
  const loggedDays = rows.length;

  return {
    label,
    startDate,
    endDate,
    loggedDays,
    averages: {
      proteinG: roundToSingleDecimal(totals.proteinG / loggedDays),
      carbsG: roundToSingleDecimal(totals.carbsG / loggedDays),
      fatG: roundToSingleDecimal(totals.fatG / loggedDays),
      caloriesKcal: Math.round(totals.caloriesKcal / loggedDays),
    },
  };
}

export async function upsertUserFromShooProfile(
  profile: ShooProfile,
  db?: DatabaseClient,
) {
  const database = await resolveDb(db);

  const existing = await database
    .select({
      id: users.id,
      email: users.email,
      shooPairwiseSub: users.shooPairwiseSub,
      displayName: users.displayName,
      pictureUrl: users.pictureUrl,
    })
    .from(users)
    .where(eq(users.shooPairwiseSub, profile.pairwiseSub))
    .limit(1);

  if (existing[0]) {
    const [updated] = await database
      .update(users)
      .set({
        email: profile.email,
        displayName: profile.displayName ?? null,
        pictureUrl: profile.pictureUrl ?? null,
        lastLoginAt: new Date(),
      })
      .where(eq(users.id, existing[0].id))
      .returning();

    return updated as UserSelectRow;
  }

  const [created] = await database
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      shooPairwiseSub: profile.pairwiseSub,
      email: profile.email,
      displayName: profile.displayName ?? null,
      pictureUrl: profile.pictureUrl ?? null,
      lastLoginAt: new Date(),
    })
    .returning();

  return created as UserSelectRow;
}

export async function getUserById(userId: string, db?: DatabaseClient) {
  const database = await resolveDb(db);
  const [user] = await database
    .select({
      id: users.id,
      email: users.email,
      shooPairwiseSub: users.shooPairwiseSub,
      displayName: users.displayName,
      pictureUrl: users.pictureUrl,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return (user ?? null) as UserSelectRow | null;
}

export async function getDailySummary(
  userId: string,
  selectedDate: string,
  db?: DatabaseClient,
): Promise<DailySummary> {
  const database = await resolveDb(db);
  const rows = await database
    .select({
      id: mealEntries.id,
      userId: mealEntries.userId,
      date: mealEntries.entryDate,
      label: mealEntries.label,
      sortOrder: mealEntries.sortOrder,
      proteinG: mealEntries.proteinG,
      carbsG: mealEntries.carbsG,
      fatG: mealEntries.fatG,
      caloriesKcal: mealEntries.caloriesKcal,
    })
    .from(mealEntries)
    .where(
      and(eq(mealEntries.userId, userId), eq(mealEntries.entryDate, selectedDate)),
    )
    .orderBy(mealEntries.sortOrder, mealEntries.createdAt);

  const meals = rows.map((row) => mapMealRow(row));
  const totals = meals.reduce(
    (carry, meal) => ({
      proteinG: roundToSingleDecimal(carry.proteinG + meal.proteinG),
      carbsG: roundToSingleDecimal(carry.carbsG + meal.carbsG),
      fatG: roundToSingleDecimal(carry.fatG + meal.fatG),
      caloriesKcal: carry.caloriesKcal + meal.caloriesKcal,
    }),
    zeroMacros(),
  );

  return {
    date: selectedDate,
    totals,
    meals,
  };
}

export async function getPeriodAverages(
  userId: string,
  selectedDate: string,
  db?: DatabaseClient,
): Promise<PeriodAverage[]> {
  const ranges = getPeriodRanges(selectedDate);
  const database = await resolveDb(db);

  const [weekRows, monthRows, rolling7Rows, rolling30Rows] = await Promise.all([
    getDailyTotalsForRange(userId, ranges.week.startDate, ranges.week.endDate, database),
    getDailyTotalsForRange(userId, ranges.month.startDate, ranges.month.endDate, database),
    getDailyTotalsForRange(userId, ranges.rolling7.startDate, ranges.rolling7.endDate, database),
    getDailyTotalsForRange(userId, ranges.rolling30.startDate, ranges.rolling30.endDate, database),
  ]);

  return [
    buildAverage("week", ranges.week.startDate, ranges.week.endDate, weekRows),
    buildAverage("month", ranges.month.startDate, ranges.month.endDate, monthRows),
    buildAverage(
      "rolling7",
      ranges.rolling7.startDate,
      ranges.rolling7.endDate,
      rolling7Rows,
    ),
    buildAverage(
      "rolling30",
      ranges.rolling30.startDate,
      ranges.rolling30.endDate,
      rolling30Rows,
    ),
  ];
}

export async function getRecentDailyOverviews(
  userId: string,
  selectedDate: string,
  limit = 8,
  db?: DatabaseClient,
): Promise<DailyOverview[]> {
  const database = await resolveDb(db);

  const rows = await database
    .select({
      entryDate: mealEntries.entryDate,
      proteinG: sql<string>`coalesce(sum(${mealEntries.proteinG}), 0)`,
      carbsG: sql<string>`coalesce(sum(${mealEntries.carbsG}), 0)`,
      fatG: sql<string>`coalesce(sum(${mealEntries.fatG}), 0)`,
      caloriesKcal: sql<string>`coalesce(sum(${mealEntries.caloriesKcal}), 0)`,
      itemCount: sql<string>`count(${mealEntries.id})`,
    })
    .from(mealEntries)
    .where(
      and(
        eq(mealEntries.userId, userId),
        lte(mealEntries.entryDate, selectedDate),
      ),
    )
    .groupBy(mealEntries.entryDate)
    .orderBy(desc(mealEntries.entryDate))
    .limit(limit);

  return (rows as DailyTotalsRow[]).map((row) => ({
    date: row.entryDate,
    itemCount: toNumber(row.itemCount),
    totals: {
      proteinG: roundToSingleDecimal(toNumber(row.proteinG)),
      carbsG: roundToSingleDecimal(toNumber(row.carbsG)),
      fatG: roundToSingleDecimal(toNumber(row.fatG)),
      caloriesKcal: toNumber(row.caloriesKcal),
    },
  }));
}

export async function getDashboardData(
  userId: string,
  selectedDate: string,
  db?: DatabaseClient,
) {
  const database = await resolveDb(db);
  const [dailySummary, periodAverages] = await Promise.all([
    getDailySummary(userId, selectedDate, database),
    getPeriodAverages(userId, selectedDate, database),
  ]);

  return {
    dailySummary,
    periodAverages,
  };
}

export async function createMealEntry(
  userId: string,
  input: Omit<MealEntryInput, "sortOrder"> & { sortOrder?: number },
  db?: DatabaseClient,
) {
  const database = await resolveDb(db);

  let nextSortOrder = input.sortOrder;
  if (typeof nextSortOrder !== "number") {
    const [row] = await database
      .select({
        maxSortOrder: max(mealEntries.sortOrder),
      })
      .from(mealEntries)
      .where(
        and(eq(mealEntries.userId, userId), eq(mealEntries.entryDate, input.date)),
      );

    nextSortOrder = (row?.maxSortOrder ?? -1) + 1;
  }

  const normalized = validateMealEntryInput({
    ...input,
    sortOrder: nextSortOrder,
  });

  const [created] = await database
    .insert(mealEntries)
    .values({
      id: crypto.randomUUID(),
      userId,
      entryDate: normalized.date,
      label: normalized.label,
      sortOrder: normalized.sortOrder,
      proteinG: normalized.proteinG.toFixed(1),
      carbsG: normalized.carbsG.toFixed(1),
      fatG: normalized.fatG.toFixed(1),
      caloriesKcal: normalized.caloriesKcal,
      updatedAt: new Date(),
    })
    .returning();

  return mapMealRow(created);
}

export async function updateMealEntry(
  userId: string,
  entryId: string,
  input: MealEntryInput,
  db?: DatabaseClient,
) {
  const database = await resolveDb(db);
  const normalized = validateMealEntryInput(input);

  const [updated] = await database
    .update(mealEntries)
    .set({
      entryDate: normalized.date,
      label: normalized.label,
      sortOrder: normalized.sortOrder,
      proteinG: normalized.proteinG.toFixed(1),
      carbsG: normalized.carbsG.toFixed(1),
      fatG: normalized.fatG.toFixed(1),
      caloriesKcal: normalized.caloriesKcal,
      updatedAt: new Date(),
    })
    .where(and(eq(mealEntries.id, entryId), eq(mealEntries.userId, userId)))
    .returning();

  if (!updated) {
    throw new Error("Meal entry not found.");
  }

  return mapMealRow(updated);
}

export async function deleteMealEntry(
  userId: string,
  entryId: string,
  db?: DatabaseClient,
) {
  const database = await resolveDb(db);
  const [deleted] = await database
    .delete(mealEntries)
    .where(and(eq(mealEntries.id, entryId), eq(mealEntries.userId, userId)))
    .returning();

  return Boolean(deleted);
}

export async function getUserGoals(
  userId: string,
  db?: DatabaseClient,
): Promise<MacroGoals> {
  const database = await resolveDb(db);
  const [user] = await database
    .select({
      goalCaloriesKcal: users.goalCaloriesKcal,
      goalProteinG: users.goalProteinG,
      goalCarbsG: users.goalCarbsG,
      goalFatG: users.goalFatG,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return {
    caloriesKcal: user?.goalCaloriesKcal ?? null,
    proteinG: user?.goalProteinG != null ? roundToSingleDecimal(toNumber(user.goalProteinG)) : null,
    carbsG: user?.goalCarbsG != null ? roundToSingleDecimal(toNumber(user.goalCarbsG)) : null,
    fatG: user?.goalFatG != null ? roundToSingleDecimal(toNumber(user.goalFatG)) : null,
  };
}

export async function saveUserGoals(
  userId: string,
  goals: MacroGoals,
  db?: DatabaseClient,
): Promise<void> {
  const database = await resolveDb(db);
  await database
    .update(users)
    .set({
      goalCaloriesKcal: goals.caloriesKcal,
      goalProteinG: goals.proteinG != null ? goals.proteinG.toFixed(1) : null,
      goalCarbsG: goals.carbsG != null ? goals.carbsG.toFixed(1) : null,
      goalFatG: goals.fatG != null ? goals.fatG.toFixed(1) : null,
    })
    .where(eq(users.id, userId));
}

export async function listRecentMealEntries(userId: string, limit = 200, db?: DatabaseClient) {
  const database = await resolveDb(db);

  return database
    .select({
      id: mealEntries.id,
      userId: mealEntries.userId,
      date: mealEntries.entryDate,
      label: mealEntries.label,
      sortOrder: mealEntries.sortOrder,
      proteinG: mealEntries.proteinG,
      carbsG: mealEntries.carbsG,
      fatG: mealEntries.fatG,
      caloriesKcal: mealEntries.caloriesKcal,
    })
    .from(mealEntries)
    .where(eq(mealEntries.userId, userId))
    .orderBy(desc(mealEntries.entryDate), mealEntries.sortOrder)
    .limit(limit);
}

function escapeLikePattern(value: string) {
  return value.replace(/[%_\\]/g, "\\$&");
}

export async function searchMealEntries(
  userId: string,
  query: string,
  db?: DatabaseClient,
): Promise<MealEntryRecord[]> {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const database = await resolveDb(db);
  const wordConditions = words.map((word) =>
    ilike(mealEntries.label, `%${escapeLikePattern(word)}%`),
  );
  const rows = await database
    .select({
      id: mealEntries.id,
      userId: mealEntries.userId,
      date: mealEntries.entryDate,
      label: mealEntries.label,
      sortOrder: mealEntries.sortOrder,
      proteinG: mealEntries.proteinG,
      carbsG: mealEntries.carbsG,
      fatG: mealEntries.fatG,
      caloriesKcal: mealEntries.caloriesKcal,
    })
    .from(mealEntries)
    .where(and(eq(mealEntries.userId, userId), ...wordConditions))
    .orderBy(desc(mealEntries.entryDate), asc(mealEntries.sortOrder))
    .limit(100);

  // Deduplicate: keep only the most recent entry for each unique
  // (label, proteinG, carbsG, fatG, caloriesKcal) combination so the same
  // food logged on multiple days only appears once in the results.
  const seen = new Set<string>();
  const unique: MealEntryRecord[] = [];
  for (const row of rows.map(mapMealRow)) {
    const key = `${row.label.toLowerCase()}|${row.proteinG}|${row.carbsG}|${row.fatG}|${row.caloriesKcal}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(row);
    }
  }
  return unique.slice(0, 50);
}

export async function getPresets(userId: string, db?: DatabaseClient): Promise<FoodPreset[]> {
  const database = await resolveDb(db);
  const rows = await database
    .select({
      id: foodPresets.id,
      userId: foodPresets.userId,
      label: foodPresets.label,
      proteinG: foodPresets.proteinG,
      carbsG: foodPresets.carbsG,
      fatG: foodPresets.fatG,
      caloriesKcal: foodPresets.caloriesKcal,
    })
    .from(foodPresets)
    .where(eq(foodPresets.userId, userId))
    .orderBy(
      sql`${foodPresets.lastUsedAt} DESC NULLS LAST`,
      asc(foodPresets.label),
    );

  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    label: row.label,
    proteinG: roundToSingleDecimal(toNumber(row.proteinG)),
    carbsG: roundToSingleDecimal(toNumber(row.carbsG)),
    fatG: roundToSingleDecimal(toNumber(row.fatG)),
    caloriesKcal: toNumber(row.caloriesKcal),
  }));
}

export async function getRecentQuickAddCandidates(
  userId: string,
  limit = 24,
  db?: DatabaseClient,
): Promise<RecentQuickAddItem[]> {
  const database = await resolveDb(db);
  const rows = await database
    .select({
      id: mealEntries.id,
      entryDate: mealEntries.entryDate,
      label: mealEntries.label,
      proteinG: mealEntries.proteinG,
      carbsG: mealEntries.carbsG,
      fatG: mealEntries.fatG,
      caloriesKcal: mealEntries.caloriesKcal,
      createdAt: mealEntries.createdAt,
    })
    .from(mealEntries)
    .where(eq(mealEntries.userId, userId))
    .orderBy(
      desc(mealEntries.entryDate),
      desc(mealEntries.createdAt),
      desc(mealEntries.sortOrder),
    )
    .limit(limit * 8);

  const seen = new Set<string>();
  const unique: RecentQuickAddItem[] = [];

  for (const row of rows) {
    const candidate: RecentQuickAddItem = {
      source: "recent",
      sourceId: row.id,
      label: row.label,
      proteinG: roundToSingleDecimal(toNumber(row.proteinG)),
      carbsG: roundToSingleDecimal(toNumber(row.carbsG)),
      fatG: roundToSingleDecimal(toNumber(row.fatG)),
      caloriesKcal: toNumber(row.caloriesKcal),
      sourceDate: row.entryDate,
    };
    const key = getQuickAddCandidateKey(candidate);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(candidate);

    if (unique.length >= limit) {
      break;
    }
  }

  return unique;
}

export async function touchPresetLastUsed(
  userId: string,
  presetId: string,
  db?: DatabaseClient,
): Promise<void> {
  const database = await resolveDb(db);
  await database
    .update(foodPresets)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(foodPresets.id, presetId), eq(foodPresets.userId, userId)));
}

export async function createPreset(
  userId: string,
  input: Omit<FoodPreset, "id" | "userId">,
  db?: DatabaseClient,
): Promise<FoodPreset> {
  const database = await resolveDb(db);
  const [created] = await database
    .insert(foodPresets)
    .values({
      id: crypto.randomUUID(),
      userId,
      label: input.label.trim(),
      proteinG: input.proteinG.toFixed(1),
      carbsG: input.carbsG.toFixed(1),
      fatG: input.fatG.toFixed(1),
      caloriesKcal: Math.round(input.caloriesKcal),
    })
    .returning();

  return {
    id: created.id,
    userId: created.userId,
    label: created.label,
    proteinG: roundToSingleDecimal(toNumber(created.proteinG)),
    carbsG: roundToSingleDecimal(toNumber(created.carbsG)),
    fatG: roundToSingleDecimal(toNumber(created.fatG)),
    caloriesKcal: toNumber(created.caloriesKcal),
  };
}

export async function updatePreset(
  userId: string,
  presetId: string,
  input: Omit<FoodPreset, "id" | "userId">,
  db?: DatabaseClient,
): Promise<FoodPreset> {
  const database = await resolveDb(db);
  const [updated] = await database
    .update(foodPresets)
    .set({
      label: input.label.trim(),
      proteinG: input.proteinG.toFixed(1),
      carbsG: input.carbsG.toFixed(1),
      fatG: input.fatG.toFixed(1),
      caloriesKcal: Math.round(input.caloriesKcal),
    })
    .where(and(eq(foodPresets.id, presetId), eq(foodPresets.userId, userId)))
    .returning();

  if (!updated) {
    throw new Error("Preset not found.");
  }

  return {
    id: updated.id,
    userId: updated.userId,
    label: updated.label,
    proteinG: roundToSingleDecimal(toNumber(updated.proteinG)),
    carbsG: roundToSingleDecimal(toNumber(updated.carbsG)),
    fatG: roundToSingleDecimal(toNumber(updated.fatG)),
    caloriesKcal: toNumber(updated.caloriesKcal),
  };
}

export async function deletePreset(
  userId: string,
  presetId: string,
  db?: DatabaseClient,
): Promise<boolean> {
  const database = await resolveDb(db);
  const [deleted] = await database
    .delete(foodPresets)
    .where(and(eq(foodPresets.id, presetId), eq(foodPresets.userId, userId)))
    .returning();

  return Boolean(deleted);
}

export async function getStatsPageData(
  userId: string,
  today: string,
  db?: DatabaseClient,
): Promise<StatsPageData> {
  const database = await resolveDb(db);

  const [dailyRows, labelRows] = await Promise.all([
    database
      .select({
        entryDate: mealEntries.entryDate,
        proteinG: sql<string>`coalesce(sum(${mealEntries.proteinG}), 0)`,
        carbsG: sql<string>`coalesce(sum(${mealEntries.carbsG}), 0)`,
        fatG: sql<string>`coalesce(sum(${mealEntries.fatG}), 0)`,
        caloriesKcal: sql<string>`coalesce(sum(${mealEntries.caloriesKcal}), 0)`,
      })
      .from(mealEntries)
      .where(eq(mealEntries.userId, userId))
      .groupBy(mealEntries.entryDate)
      .orderBy(asc(mealEntries.entryDate)),
    database
      .select({
        label: mealEntries.label,
        count: sql<string>`count(*)`,
      })
      .from(mealEntries)
      .where(eq(mealEntries.userId, userId))
      .groupBy(mealEntries.label)
      .orderBy(desc(sql`count(*)`))
      .limit(5),
  ]);

  const sortedDates = dailyRows.map((r) => r.entryDate);
  const { currentStreak, longestStreak } = computeStreaks(sortedDates, today);

  let totalProteinG = 0;
  let totalCarbsG = 0;
  let totalFatG = 0;
  let totalCaloriesKcal = 0;
  let bestCalorieDay: { date: string; caloriesKcal: number } | null = null;

  for (const row of dailyRows) {
    const cals = Math.round(toNumber(row.caloriesKcal));
    totalProteinG += toNumber(row.proteinG);
    totalCarbsG += toNumber(row.carbsG);
    totalFatG += toNumber(row.fatG);
    totalCaloriesKcal += cals;
    if (!bestCalorieDay || cals > bestCalorieDay.caloriesKcal) {
      bestCalorieDay = { date: row.entryDate, caloriesKcal: cals };
    }
  }

  return {
    allDailyTotals: dailyRows.map((row) => ({
      date: row.entryDate,
      proteinG: roundToSingleDecimal(toNumber(row.proteinG)),
      carbsG: roundToSingleDecimal(toNumber(row.carbsG)),
      fatG: roundToSingleDecimal(toNumber(row.fatG)),
      caloriesKcal: Math.round(toNumber(row.caloriesKcal)),
    })),
    totalDaysTracked: dailyRows.length,
    currentStreak,
    longestStreak,
    totalProteinG: Math.round(totalProteinG),
    totalCarbsG: Math.round(totalCarbsG),
    totalFatG: Math.round(totalFatG),
    totalCaloriesKcal: Math.round(totalCaloriesKcal),
    bestCalorieDay,
    topLabels: labelRows.map((r) => ({ label: r.label, count: toNumber(r.count) })),
  };
}

// ---------------------------------------------------------------------------
// Weight tracking
// ---------------------------------------------------------------------------

function roundToTwoDecimals(value: number) {
  return Math.round(value * 100) / 100;
}

function mapWeightRow(row: {
  id: string;
  userId: string;
  entryDate: string;
  weightKg: string | number;
  bodyFatPct: string | number | null;
  notes: string | null;
}): WeightEntryRecord {
  return {
    id: row.id,
    userId: row.userId,
    date: row.entryDate,
    weightKg: roundToTwoDecimals(toNumber(row.weightKg)),
    bodyFatPct:
      row.bodyFatPct != null
        ? roundToSingleDecimal(toNumber(row.bodyFatPct))
        : null,
    notes: row.notes,
  };
}

export async function getWeightEntries(
  userId: string,
  db?: DatabaseClient,
): Promise<WeightEntryRecord[]> {
  const database = await resolveDb(db);
  const rows = await database
    .select({
      id: weightEntries.id,
      userId: weightEntries.userId,
      entryDate: weightEntries.entryDate,
      weightKg: weightEntries.weightKg,
      bodyFatPct: weightEntries.bodyFatPct,
      notes: weightEntries.notes,
    })
    .from(weightEntries)
    .where(eq(weightEntries.userId, userId))
    .orderBy(asc(weightEntries.entryDate));

  return rows.map(mapWeightRow);
}

export async function createWeightEntry(
  userId: string,
  input: WeightEntryInput,
  db?: DatabaseClient,
): Promise<WeightEntryRecord> {
  const database = await resolveDb(db);
  const normalized = validateWeightEntryInput(input);

  const [created] = await database
    .insert(weightEntries)
    .values({
      id: crypto.randomUUID(),
      userId,
      entryDate: normalized.date,
      weightKg: normalized.weightKg.toFixed(2),
      bodyFatPct:
        normalized.bodyFatPct != null
          ? normalized.bodyFatPct.toFixed(1)
          : null,
      notes: normalized.notes,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [weightEntries.userId, weightEntries.entryDate],
      set: {
        weightKg: normalized.weightKg.toFixed(2),
        bodyFatPct:
          normalized.bodyFatPct != null
            ? normalized.bodyFatPct.toFixed(1)
            : null,
        notes: normalized.notes,
        updatedAt: new Date(),
      },
    })
    .returning();

  return mapWeightRow(created);
}

export async function updateWeightEntry(
  userId: string,
  entryId: string,
  input: WeightEntryInput,
  db?: DatabaseClient,
): Promise<WeightEntryRecord | null> {
  const database = await resolveDb(db);
  const normalized = validateWeightEntryInput(input);

  const [updated] = await database
    .update(weightEntries)
    .set({
      entryDate: normalized.date,
      weightKg: normalized.weightKg.toFixed(2),
      bodyFatPct:
        normalized.bodyFatPct != null
          ? normalized.bodyFatPct.toFixed(1)
          : null,
      notes: normalized.notes,
      updatedAt: new Date(),
    })
    .where(
      and(eq(weightEntries.id, entryId), eq(weightEntries.userId, userId)),
    )
    .returning();

  if (!updated) return null;
  return mapWeightRow(updated);
}

export async function deleteWeightEntry(
  userId: string,
  entryId: string,
  db?: DatabaseClient,
): Promise<boolean> {
  const database = await resolveDb(db);
  const [deleted] = await database
    .delete(weightEntries)
    .where(
      and(eq(weightEntries.id, entryId), eq(weightEntries.userId, userId)),
    )
    .returning();

  return Boolean(deleted);
}

export async function getWeightGoal(
  userId: string,
  db?: DatabaseClient,
): Promise<number | null> {
  const database = await resolveDb(db);
  const [user] = await database
    .select({ goalWeightKg: users.goalWeightKg })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return user?.goalWeightKg != null
    ? roundToTwoDecimals(toNumber(user.goalWeightKg))
    : null;
}

export async function saveWeightGoal(
  userId: string,
  goalWeightKg: number | null,
  db?: DatabaseClient,
): Promise<void> {
  const database = await resolveDb(db);
  await database
    .update(users)
    .set({
      goalWeightKg:
        goalWeightKg != null ? goalWeightKg.toFixed(2) : null,
    })
    .where(eq(users.id, userId));
}

export async function getWeightPageData(
  userId: string,
  today: string,
  db?: DatabaseClient,
): Promise<WeightPageData> {
  const database = await resolveDb(db);

  const [entries, goalWeightKg] = await Promise.all([
    getWeightEntries(userId, database),
    getWeightGoal(userId, database),
  ]);

  let currentWeight: number | null = null;
  let weekChange: number | null = null;
  let monthChange: number | null = null;
  let trendDirection: WeightPageData["stats"]["trendDirection"] = null;

  if (entries.length > 0) {
    const latest = entries[entries.length - 1]!;
    currentWeight = latest.weightKg;

    // Find entry closest to 7 days ago
    const todayMs = new Date(today).getTime();
    const weekAgoMs = todayMs - 7 * 24 * 60 * 60 * 1000;
    const monthAgoMs = todayMs - 30 * 24 * 60 * 60 * 1000;

    let closestWeek: WeightEntryRecord | null = null;
    let closestMonth: WeightEntryRecord | null = null;

    for (const entry of entries) {
      const entryMs = new Date(entry.date).getTime();
      if (entryMs <= weekAgoMs) {
        if (
          !closestWeek ||
          Math.abs(entryMs - weekAgoMs) <
            Math.abs(new Date(closestWeek.date).getTime() - weekAgoMs)
        ) {
          closestWeek = entry;
        }
      }
      if (entryMs <= monthAgoMs) {
        if (
          !closestMonth ||
          Math.abs(entryMs - monthAgoMs) <
            Math.abs(new Date(closestMonth.date).getTime() - monthAgoMs)
        ) {
          closestMonth = entry;
        }
      }
    }

    if (closestWeek) {
      weekChange = roundToTwoDecimals(
        latest.weightKg - closestWeek.weightKg,
      );
    }
    if (closestMonth) {
      monthChange = roundToTwoDecimals(
        latest.weightKg - closestMonth.weightKg,
      );
    }

    // Trend: compare last 3 entries if available
    if (entries.length >= 3) {
      const last3 = entries.slice(-3);
      const diffs = [
        last3[1]!.weightKg - last3[0]!.weightKg,
        last3[2]!.weightKg - last3[1]!.weightKg,
      ];
      const avgDiff = (diffs[0]! + diffs[1]!) / 2;
      if (avgDiff > 0.1) trendDirection = "up";
      else if (avgDiff < -0.1) trendDirection = "down";
      else trendDirection = "stable";
    } else if (entries.length === 2) {
      const diff = entries[1]!.weightKg - entries[0]!.weightKg;
      if (diff > 0.1) trendDirection = "up";
      else if (diff < -0.1) trendDirection = "down";
      else trendDirection = "stable";
    }
  }

  return {
    entries,
    goalWeightKg,
    stats: {
      currentWeight,
      weekChange,
      monthChange,
      trendDirection,
    },
  };
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

function buildRecipeRecord(
  recipe: { id: string; userId: string; label: string; portions: number },
  ingredientRows: Array<{
    id: string;
    recipeId: string;
    sortOrder: number;
    label: string;
    proteinG: string | number;
    carbsG: string | number;
    fatG: string | number;
    caloriesKcal: number;
  }>,
): RecipeRecord {
  const ingredients: RecipeIngredientRecord[] = ingredientRows.map((row) => ({
    id: row.id,
    recipeId: row.recipeId,
    sortOrder: row.sortOrder,
    label: row.label,
    proteinG: roundToSingleDecimal(toNumber(row.proteinG)),
    carbsG: roundToSingleDecimal(toNumber(row.carbsG)),
    fatG: roundToSingleDecimal(toNumber(row.fatG)),
    caloriesKcal: toNumber(row.caloriesKcal),
  }));

  const totalMacros = ingredients.reduce(
    (acc, ing) => ({
      proteinG: roundToSingleDecimal(acc.proteinG + ing.proteinG),
      carbsG: roundToSingleDecimal(acc.carbsG + ing.carbsG),
      fatG: roundToSingleDecimal(acc.fatG + ing.fatG),
      caloriesKcal: acc.caloriesKcal + ing.caloriesKcal,
    }),
    zeroMacros(),
  );

  const portions = Math.max(recipe.portions, 1);
  const perPortionMacros: MacroNumbers = {
    proteinG: roundToSingleDecimal(totalMacros.proteinG / portions),
    carbsG: roundToSingleDecimal(totalMacros.carbsG / portions),
    fatG: roundToSingleDecimal(totalMacros.fatG / portions),
    caloriesKcal: Math.round(totalMacros.caloriesKcal / portions),
  };

  return {
    id: recipe.id,
    userId: recipe.userId,
    label: recipe.label,
    portions,
    ingredients,
    totalMacros,
    perPortionMacros,
  };
}

export async function getRecipes(
  userId: string,
  db?: DatabaseClient,
): Promise<RecipeRecord[]> {
  const database = await resolveDb(db);

  const recipeRows = await database
    .select({
      id: recipes.id,
      userId: recipes.userId,
      label: recipes.label,
      portions: recipes.portions,
    })
    .from(recipes)
    .where(eq(recipes.userId, userId))
    .orderBy(asc(recipes.label));

  if (recipeRows.length === 0) return [];

  const recipeIds = recipeRows.map((r) => r.id);
  const ingredientRows = await database
    .select({
      id: recipeIngredients.id,
      recipeId: recipeIngredients.recipeId,
      sortOrder: recipeIngredients.sortOrder,
      label: recipeIngredients.label,
      proteinG: recipeIngredients.proteinG,
      carbsG: recipeIngredients.carbsG,
      fatG: recipeIngredients.fatG,
      caloriesKcal: recipeIngredients.caloriesKcal,
    })
    .from(recipeIngredients)
    .where(inArray(recipeIngredients.recipeId, recipeIds))
    .orderBy(asc(recipeIngredients.sortOrder));

  const ingredientsByRecipe = new Map<string, typeof ingredientRows>();
  for (const row of ingredientRows) {
    const existing = ingredientsByRecipe.get(row.recipeId) ?? [];
    existing.push(row);
    ingredientsByRecipe.set(row.recipeId, existing);
  }

  return recipeRows.map((recipe) =>
    buildRecipeRecord(recipe, ingredientsByRecipe.get(recipe.id) ?? []),
  );
}

export async function getRecipeById(
  userId: string,
  recipeId: string,
  db?: DatabaseClient,
): Promise<RecipeRecord | null> {
  const database = await resolveDb(db);

  const [recipe] = await database
    .select({
      id: recipes.id,
      userId: recipes.userId,
      label: recipes.label,
      portions: recipes.portions,
    })
    .from(recipes)
    .where(and(eq(recipes.id, recipeId), eq(recipes.userId, userId)))
    .limit(1);

  if (!recipe) return null;

  const ingredientRows = await database
    .select({
      id: recipeIngredients.id,
      recipeId: recipeIngredients.recipeId,
      sortOrder: recipeIngredients.sortOrder,
      label: recipeIngredients.label,
      proteinG: recipeIngredients.proteinG,
      carbsG: recipeIngredients.carbsG,
      fatG: recipeIngredients.fatG,
      caloriesKcal: recipeIngredients.caloriesKcal,
    })
    .from(recipeIngredients)
    .where(eq(recipeIngredients.recipeId, recipeId))
    .orderBy(asc(recipeIngredients.sortOrder));

  return buildRecipeRecord(recipe, ingredientRows);
}

export async function createRecipe(
  userId: string,
  input: RecipeInput,
  db?: DatabaseClient,
): Promise<RecipeRecord> {
  const database = await resolveDb(db);
  const validated = validateRecipeInput(input);
  const recipeId = crypto.randomUUID();

  const [created] = await database
    .insert(recipes)
    .values({
      id: recipeId,
      userId,
      label: validated.label,
      portions: validated.portions,
      updatedAt: new Date(),
    })
    .returning();

  const ingredientRows = [];
  for (let i = 0; i < validated.ingredients.length; i++) {
    const ing = validated.ingredients[i]!;
    const [row] = await database
      .insert(recipeIngredients)
      .values({
        id: crypto.randomUUID(),
        recipeId,
        sortOrder: i,
        label: ing.label,
        proteinG: ing.proteinG.toFixed(1),
        carbsG: ing.carbsG.toFixed(1),
        fatG: ing.fatG.toFixed(1),
        caloriesKcal: Math.round(ing.caloriesKcal),
      })
      .returning();
    ingredientRows.push(row!);
  }

  return buildRecipeRecord(created!, ingredientRows);
}

export async function updateRecipe(
  userId: string,
  recipeId: string,
  input: RecipeInput,
  db?: DatabaseClient,
): Promise<RecipeRecord> {
  const database = await resolveDb(db);
  const validated = validateRecipeInput(input);

  // Verify ownership
  const [existing] = await database
    .select({ id: recipes.id })
    .from(recipes)
    .where(and(eq(recipes.id, recipeId), eq(recipes.userId, userId)))
    .limit(1);

  if (!existing) {
    throw new Error("Recipe not found.");
  }

  // Update recipe row
  await database
    .update(recipes)
    .set({
      label: validated.label,
      portions: validated.portions,
      updatedAt: new Date(),
    })
    .where(eq(recipes.id, recipeId));

  // Replace all ingredients
  await database
    .delete(recipeIngredients)
    .where(eq(recipeIngredients.recipeId, recipeId));

  const ingredientRows = [];
  for (let i = 0; i < validated.ingredients.length; i++) {
    const ing = validated.ingredients[i]!;
    const [row] = await database
      .insert(recipeIngredients)
      .values({
        id: crypto.randomUUID(),
        recipeId,
        sortOrder: i,
        label: ing.label,
        proteinG: ing.proteinG.toFixed(1),
        carbsG: ing.carbsG.toFixed(1),
        fatG: ing.fatG.toFixed(1),
        caloriesKcal: Math.round(ing.caloriesKcal),
      })
      .returning();
    ingredientRows.push(row!);
  }

  return buildRecipeRecord(
    { id: recipeId, userId, label: validated.label, portions: validated.portions },
    ingredientRows,
  );
}

export async function deleteRecipe(
  userId: string,
  recipeId: string,
  db?: DatabaseClient,
): Promise<boolean> {
  const database = await resolveDb(db);
  const [deleted] = await database
    .delete(recipes)
    .where(and(eq(recipes.id, recipeId), eq(recipes.userId, userId)))
    .returning();

  return Boolean(deleted);
}

// ---------------------------------------------------------------------------
// Leaderboard / personal records
// ---------------------------------------------------------------------------

export type LeaderboardStats = {
  currentStreak: number;
  longestStreak: number;
  totalDaysTracked: number;
  bestCalorieDay: { date: string; caloriesKcal: number } | null;
  bestProteinDay: { date: string; proteinG: number } | null;
  bestCarbsDay: { date: string; carbsG: number } | null;
  mostActiveDay: { date: string; entryCount: number } | null;
};

export async function getLeaderboardStats(
  userId: string,
  today: string,
  db?: DatabaseClient,
): Promise<LeaderboardStats> {
  const database = await resolveDb(db);

  const rows = await database
    .select({
      entryDate: mealEntries.entryDate,
      proteinG: sql<string>`coalesce(sum(${mealEntries.proteinG}), 0)`,
      carbsG: sql<string>`coalesce(sum(${mealEntries.carbsG}), 0)`,
      caloriesKcal: sql<string>`coalesce(sum(${mealEntries.caloriesKcal}), 0)`,
      entryCount: sql<string>`count(${mealEntries.id})`,
    })
    .from(mealEntries)
    .where(eq(mealEntries.userId, userId))
    .groupBy(mealEntries.entryDate)
    .orderBy(asc(mealEntries.entryDate));

  const sortedDates = rows.map((r) => r.entryDate);
  const { currentStreak, longestStreak } = computeStreaks(sortedDates, today);

  let bestCalorieDay: LeaderboardStats["bestCalorieDay"] = null;
  let bestProteinDay: LeaderboardStats["bestProteinDay"] = null;
  let bestCarbsDay: LeaderboardStats["bestCarbsDay"] = null;
  let mostActiveDay: LeaderboardStats["mostActiveDay"] = null;

  for (const row of rows) {
    const cals = Math.round(toNumber(row.caloriesKcal));
    const protein = roundToSingleDecimal(toNumber(row.proteinG));
    const carbs = roundToSingleDecimal(toNumber(row.carbsG));
    const count = toNumber(row.entryCount);

    if (!bestCalorieDay || cals > bestCalorieDay.caloriesKcal) {
      bestCalorieDay = { date: row.entryDate, caloriesKcal: cals };
    }
    if (!bestProteinDay || protein > bestProteinDay.proteinG) {
      bestProteinDay = { date: row.entryDate, proteinG: protein };
    }
    if (!bestCarbsDay || carbs > bestCarbsDay.carbsG) {
      bestCarbsDay = { date: row.entryDate, carbsG: carbs };
    }
    if (!mostActiveDay || count > mostActiveDay.entryCount) {
      mostActiveDay = { date: row.entryDate, entryCount: count };
    }
  }

  return {
    currentStreak,
    longestStreak,
    totalDaysTracked: rows.length,
    bestCalorieDay,
    bestProteinDay,
    bestCarbsDay,
    mostActiveDay,
  };
}

// ---------------------------------------------------------------------------
// Community barcode product catalogue
// ---------------------------------------------------------------------------

function mapBarcodeProductRow(row: {
  id: string;
  barcode: string;
  name: string;
  brands: string;
  proteinG: string | number;
  carbsG: string | number;
  fatG: string | number;
  caloriesKcal: number;
  servingSizeG: string | number | null;
  addedByUserId: string | null;
}): CustomBarcodeProduct {
  return {
    id: row.id,
    barcode: row.barcode,
    name: row.name,
    brands: row.brands,
    proteinG: roundToSingleDecimal(toNumber(row.proteinG)),
    carbsG: roundToSingleDecimal(toNumber(row.carbsG)),
    fatG: roundToSingleDecimal(toNumber(row.fatG)),
    caloriesKcal: toNumber(row.caloriesKcal),
    servingSizeG:
      row.servingSizeG != null
        ? roundToSingleDecimal(toNumber(row.servingSizeG))
        : null,
    addedByUserId: row.addedByUserId,
  };
}

export async function lookupCustomBarcodeProduct(
  barcode: string,
  db?: DatabaseClient,
): Promise<CustomBarcodeProduct | null> {
  const database = await resolveDb(db);

  const [row] = await database
    .select()
    .from(barcodeProducts)
    .where(eq(barcodeProducts.barcode, barcode))
    .limit(1);

  return row ? mapBarcodeProductRow(row) : null;
}

export async function saveCustomBarcodeProduct(
  addedByUserId: string,
  input: CustomBarcodeProductInput,
  db?: DatabaseClient,
): Promise<CustomBarcodeProduct> {
  const database = await resolveDb(db);

  const [created] = await database
    .insert(barcodeProducts)
    .values({
      id: crypto.randomUUID(),
      barcode: input.barcode.trim(),
      name: input.name.trim(),
      brands: input.brands.trim(),
      proteinG: input.proteinG.toFixed(1),
      carbsG: input.carbsG.toFixed(1),
      fatG: input.fatG.toFixed(1),
      caloriesKcal: Math.round(input.caloriesKcal),
      servingSizeG:
        input.servingSizeG != null ? input.servingSizeG.toFixed(1) : null,
      addedByUserId,
    })
    .returning();

  return mapBarcodeProductRow(created);
}
