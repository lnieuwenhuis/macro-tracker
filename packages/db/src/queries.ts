import { and, desc, eq, gte, lte, max, sql } from "drizzle-orm";

import { getPeriodRanges } from "./dates";
import { getDb, type DatabaseClient } from "./client";
import { mealEntries, users } from "./schema";
import { validateMealEntryInput } from "./validators";
import type {
  DailySummary,
  MacroNumbers,
  MealEntryInput,
  MealEntryRecord,
  PeriodAverage,
  ShooProfile,
} from "./types";

type DailyTotalsRow = {
  entryDate: string;
  proteinG: string | number;
  carbsG: string | number;
  fatG: string | number;
  caloriesKcal: string | number;
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

  const weekRows = await getDailyTotalsForRange(
    userId,
    ranges.week.startDate,
    ranges.week.endDate,
    database,
  );
  const monthRows = await getDailyTotalsForRange(
    userId,
    ranges.month.startDate,
    ranges.month.endDate,
    database,
  );
  const rolling7Rows = await getDailyTotalsForRange(
    userId,
    ranges.rolling7.startDate,
    ranges.rolling7.endDate,
    database,
  );
  const rolling30Rows = await getDailyTotalsForRange(
    userId,
    ranges.rolling30.startDate,
    ranges.rolling30.endDate,
    database,
  );

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

export async function listRecentMealEntries(userId: string, db?: DatabaseClient) {
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
    .orderBy(desc(mealEntries.entryDate), mealEntries.sortOrder);
}
