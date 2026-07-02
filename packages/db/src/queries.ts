import { and, asc, count, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lt, lte, max, ne, or, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";

import { computeStreaks, getPeriodRanges } from "./dates";
import { getDb, type DatabaseClient } from "./client";
import { adminAuditEvents, apiTokens, foodProductRevisions, foodProducts, mealEntries, mealGroups, mealTemplateItems, mealTemplates, recipeIngredients, recipes, users, weightEntries } from "./schema";
import { validateFoodProductInput, validateMealEntryInput, validateRecipeInput, validateWeightEntryInput } from "./validators";
import type {
  AdminAuditListPage,
  AdminAuditEvent,
  AdminAuditEventDetail,
  AdminBarcodeListPage,
  AdminBarcodeRecord,
  AdminBarcodeReviewQueueItem,
  AdminBarcodeReviewQueuePage,
  AdminDashboardData,
  AdminRole,
  AdminUserDetail,
  AdminUserHealthFilter,
  AdminUserHealthSummary,
  AdminUserListItem,
  AdminUserListPage,
  AdminRecipeSummary,
  ApiScope,
  ApiTokenAuthResult,
  ApiTokenRecord,
  AppUser,
  BarcodeFoodProductInput,
  CompleteOnboardingInput,
  DailyOverview,
  DailySummary,
  FoodProduct,
  FoodProductInput,
  FoodProductRevision,
  FoodProductRevisionAction,
  MealEntryStatus,
  MealGroup,
  MealTemplate,
  MealTemplateInput,
  MealTemplateItem,
  MealTemplateType,
  MacroGoals,
  MacroNumbers,
  MealEntryInput,
  MealEntryRecord,
  PeriodAverage,
  QuickAddCandidate,
  QuantityUnit,
  RecipeIngredientRecord,
  RecipeInput,
  RecipeRecord,
  ShooProfile,
  StatsPageData,
  WeightEntryInput,
  WeightEntryRecord,
  WeightPageData,
  WeightUnit,
} from "./types";
import { API_SCOPE_VALUES, canAccessAdmin, isAdminRole, isApiScope, isOwnerRole } from "./types";

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
  role: string;
  createdAt: Date;
  lastLoginAt: Date;
  goalCaloriesKcal: number | null;
  goalProteinG: string | number | null;
  goalCarbsG: string | number | null;
  goalFatG: string | number | null;
  goalWeightKg: string | number | null;
  onboardingCompletedAt: Date | string | null;
  preferredWeightUnit: string;
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

function roundToTwoDecimals(value: number) {
  return Math.round(value * 100) / 100;
}

function fixed(value: number, digits: number) {
  return value.toFixed(digits);
}

function toTimestampString(value: Date | string | null | undefined) {
  if (!value) {
    return "";
  }

  return value instanceof Date ? value.toISOString() : value;
}

function toAdminRole(value: string): AdminRole {
  return isAdminRole(value) ? value : "user";
}

function toWeightUnit(value: string): WeightUnit {
  return value === "lb" ? "lb" : "kg";
}

function mapUserRow(row: UserSelectRow): AppUser {
  return {
    id: row.id,
    email: row.email,
    shooPairwiseSub: row.shooPairwiseSub,
    displayName: row.displayName,
    pictureUrl: row.pictureUrl,
    role: toAdminRole(row.role),
    createdAt: toTimestampString(row.createdAt),
    lastLoginAt: toTimestampString(row.lastLoginAt),
    goalCaloriesKcal: row.goalCaloriesKcal,
    goalProteinG:
      row.goalProteinG != null ? roundToSingleDecimal(toNumber(row.goalProteinG)) : null,
    goalCarbsG:
      row.goalCarbsG != null ? roundToSingleDecimal(toNumber(row.goalCarbsG)) : null,
    goalFatG:
      row.goalFatG != null ? roundToSingleDecimal(toNumber(row.goalFatG)) : null,
    goalWeightKg:
      row.goalWeightKg != null ? Math.round(toNumber(row.goalWeightKg) * 100) / 100 : null,
    onboardingCompletedAt: toTimestampString(row.onboardingCompletedAt) || null,
    preferredWeightUnit: toWeightUnit(row.preferredWeightUnit),
  };
}

function mapMealRow(row: {
  id: string;
  userId: string;
  date?: string;
  entryDate?: string;
  mealGroupId?: string | null;
  status?: string;
  productId?: string | null;
  label: string;
  sortOrder: number;
  quantity?: string | number;
  unit?: string;
  servingMultiplier?: string | number;
  proteinG: string | number;
  carbsG: string | number;
  fatG: string | number;
  caloriesKcal: number;
  clientMutationId?: string | null;
  sourceLabel?: string | null;
}): MealEntryRecord {
  const status = isKnownMealEntryStatus(row.status) ? row.status : "eaten";
  const unit = isKnownQuantityUnit(row.unit) ? row.unit : "serving";

  return {
    id: row.id,
    userId: row.userId,
    date: row.date ?? row.entryDate ?? "",
    mealGroupId: row.mealGroupId ?? null,
    status,
    productId: row.productId ?? null,
    label: row.label,
    sortOrder: row.sortOrder,
    quantity: roundToTwoDecimals(toNumber(row.quantity ?? 1)),
    unit,
    servingMultiplier: roundToTwoDecimals(toNumber(row.servingMultiplier ?? 1)),
    proteinG: roundToSingleDecimal(toNumber(row.proteinG)),
    carbsG: roundToSingleDecimal(toNumber(row.carbsG)),
    fatG: roundToSingleDecimal(toNumber(row.fatG)),
    caloriesKcal: row.caloriesKcal,
    clientMutationId: row.clientMutationId ?? null,
    sourceLabel: row.sourceLabel ?? null,
  };
}

function isKnownMealEntryStatus(value: string | null | undefined): value is MealEntryStatus {
  return value === "planned" || value === "eaten" || value === "skipped";
}

function isKnownQuantityUnit(value: string | null | undefined): value is QuantityUnit {
  return value === "g" || value === "ml" || value === "serving" || value === "count";
}

function mapMealGroupRow(row: {
  id: string;
  userId: string;
  label: string;
  sortOrder: number;
  isDefault: boolean;
}): MealGroup {
  return {
    id: row.id,
    userId: row.userId,
    label: row.label,
    sortOrder: row.sortOrder,
    isDefault: row.isDefault,
  };
}

function mapFoodProductRow(row: {
  id: string;
  ownerUserId: string | null;
  scope: string;
  source: string;
  barcode: string | null;
  name: string;
  brand: string;
  defaultServingQuantity: string | number;
  defaultServingUnit: string;
  proteinPer100: string | number;
  carbsPer100: string | number;
  fatPer100: string | number;
  caloriesPer100: number;
  servingWeightG: string | number | null;
  servingVolumeMl: string | number | null;
  submittedByUserId?: string | null;
  deletedByUserId?: string | null;
  sourceProvider?: string | null;
  sourceConfidence?: string | number | null;
  sourceMetadata?: unknown;
  correctedFromProductId?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  deletedAt?: Date | string | null;
}): FoodProduct {
  const scope =
    row.scope === "global" || row.scope === "legacy" || row.scope === "personal"
      ? row.scope
      : "personal";
  const source =
    row.source === "barcode" ||
    row.source === "ai_photo" ||
    row.source === "legacy" ||
    row.source === "recipe" ||
    row.source === "manual"
      ? row.source
      : "manual";
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    scope,
    source,
    barcode: row.barcode,
    name: row.name,
    brand: row.brand,
    defaultServingQuantity: roundToTwoDecimals(toNumber(row.defaultServingQuantity)),
    defaultServingUnit: isKnownQuantityUnit(row.defaultServingUnit)
      ? row.defaultServingUnit
      : "serving",
    proteinPer100: roundToSingleDecimal(toNumber(row.proteinPer100)),
    carbsPer100: roundToSingleDecimal(toNumber(row.carbsPer100)),
    fatPer100: roundToSingleDecimal(toNumber(row.fatPer100)),
    caloriesPer100: row.caloriesPer100,
    servingWeightG:
      row.servingWeightG != null ? roundToTwoDecimals(toNumber(row.servingWeightG)) : null,
    servingVolumeMl:
      row.servingVolumeMl != null ? roundToTwoDecimals(toNumber(row.servingVolumeMl)) : null,
    submittedByUserId: row.submittedByUserId ?? null,
    deletedByUserId: row.deletedByUserId ?? null,
    sourceProvider: row.sourceProvider ?? null,
    sourceConfidence:
      row.sourceConfidence != null ? roundToTwoDecimals(toNumber(row.sourceConfidence)) : null,
    sourceMetadata:
      row.sourceMetadata && typeof row.sourceMetadata === "object"
        ? (row.sourceMetadata as Record<string, unknown>)
        : {},
    correctedFromProductId: row.correctedFromProductId ?? null,
    createdAt: toTimestampString(row.createdAt),
    updatedAt: toTimestampString(row.updatedAt),
    deletedAt: row.deletedAt ? toTimestampString(row.deletedAt) : null,
  };
}

const foodProductSelectColumns = {
  id: foodProducts.id,
  ownerUserId: foodProducts.ownerUserId,
  scope: foodProducts.scope,
  source: foodProducts.source,
  barcode: foodProducts.barcode,
  name: foodProducts.name,
  brand: foodProducts.brand,
  defaultServingQuantity: foodProducts.defaultServingQuantity,
  defaultServingUnit: foodProducts.defaultServingUnit,
  proteinPer100: foodProducts.proteinPer100,
  carbsPer100: foodProducts.carbsPer100,
  fatPer100: foodProducts.fatPer100,
  caloriesPer100: foodProducts.caloriesPer100,
  servingWeightG: foodProducts.servingWeightG,
  servingVolumeMl: foodProducts.servingVolumeMl,
  submittedByUserId: foodProducts.submittedByUserId,
  deletedByUserId: foodProducts.deletedByUserId,
  sourceProvider: foodProducts.sourceProvider,
  sourceConfidence: foodProducts.sourceConfidence,
  sourceMetadata: foodProducts.sourceMetadata,
  correctedFromProductId: foodProducts.correctedFromProductId,
  createdAt: foodProducts.createdAt,
  updatedAt: foodProducts.updatedAt,
  deletedAt: foodProducts.deletedAt,
};

const mealEntryWithProductSelectColumns = {
  id: mealEntries.id,
  userId: mealEntries.userId,
  date: mealEntries.entryDate,
  mealGroupId: mealEntries.mealGroupId,
  status: mealEntries.status,
  productId: foodProducts.id,
  label: mealEntries.label,
  sortOrder: mealEntries.sortOrder,
  quantity: mealEntries.quantity,
  unit: mealEntries.unit,
  servingMultiplier: mealEntries.servingMultiplier,
  proteinG: mealEntries.proteinG,
  carbsG: mealEntries.carbsG,
  fatG: mealEntries.fatG,
  caloriesKcal: mealEntries.caloriesKcal,
  clientMutationId: mealEntries.clientMutationId,
  sourceLabel: foodProducts.name,
};

function selectMealEntriesWithAccessibleProduct(db: DatabaseClient, userId: string) {
  return db
    .select(mealEntryWithProductSelectColumns)
    .from(mealEntries)
    .leftJoin(
      foodProducts,
      and(eq(mealEntries.productId, foodProducts.id), productAccessPredicate(userId)),
    );
}

type ValidatedFoodProductInput = ReturnType<typeof validateFoodProductInput>;

function buildFoodProductInputValues(
  normalized: ValidatedFoodProductInput,
  options: {
    servingWeightFallback?: string | null;
    forceNullServingVolume?: boolean;
    sourceProviderFallback?: string | null;
    updatedAt?: Date;
  } = {},
) {
  return {
    source: normalized.source,
    barcode: normalized.barcode,
    name: normalized.name,
    brand: normalized.brand ?? "",
    defaultServingQuantity: fixed(normalized.defaultServingQuantity, 2),
    defaultServingUnit: normalized.defaultServingUnit,
    proteinPer100: fixed(normalized.proteinPer100, 2),
    carbsPer100: fixed(normalized.carbsPer100, 2),
    fatPer100: fixed(normalized.fatPer100, 2),
    caloriesPer100: normalized.caloriesPer100,
    servingWeightG:
      normalized.servingWeightG != null
        ? fixed(normalized.servingWeightG, 2)
        : options.servingWeightFallback ?? null,
    servingVolumeMl: options.forceNullServingVolume
      ? null
      : normalized.servingVolumeMl != null
        ? fixed(normalized.servingVolumeMl, 2)
        : null,
    sourceProvider: normalized.sourceProvider ?? options.sourceProviderFallback ?? null,
    sourceConfidence:
      normalized.sourceConfidence != null
        ? fixed(normalized.sourceConfidence, 2)
        : null,
    sourceMetadata: normalized.sourceMetadata ?? {},
    correctedFromProductId: normalized.correctedFromProductId ?? null,
    updatedAt: options.updatedAt ?? new Date(),
  };
}

function buildMealEntryValues(normalized: MealEntryInput) {
  return {
    entryDate: normalized.date,
    mealGroupId: normalized.mealGroupId,
    status: normalized.status ?? "eaten",
    productId: normalized.productId,
    label: normalized.label,
    sortOrder: normalized.sortOrder,
    quantity: normalized.quantity?.toFixed(2) ?? "1.00",
    unit: normalized.unit ?? "serving",
    servingMultiplier: normalized.servingMultiplier?.toFixed(2) ?? "1.00",
    proteinG: normalized.proteinG.toFixed(1),
    carbsG: normalized.carbsG.toFixed(1),
    fatG: normalized.fatG.toFixed(1),
    caloriesKcal: normalized.caloriesKcal,
    clientMutationId: normalized.clientMutationId,
    updatedAt: new Date(),
  };
}

function buildMealEntryInsertValues(userId: string, normalized: MealEntryInput) {
  return {
    id: crypto.randomUUID(),
    userId,
    ...buildMealEntryValues(normalized),
  };
}

function buildWeightEntryValues(userId: string, normalized: WeightEntryInput) {
  return {
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
  };
}

function buildWeightEntryUpdateValues(normalized: WeightEntryInput) {
  return {
    entryDate: normalized.date,
    weightKg: normalized.weightKg.toFixed(2),
    bodyFatPct:
      normalized.bodyFatPct != null
        ? normalized.bodyFatPct.toFixed(1)
        : null,
    notes: normalized.notes,
    updatedAt: new Date(),
  };
}

function mapFoodProductRevisionRow(row: {
  id: string;
  productId: string;
  actorUserId: string | null;
  action: string;
  snapshotJson: unknown;
  createdAt: Date | string;
}): FoodProductRevision {
  const action = isKnownFoodProductRevisionAction(row.action)
    ? row.action
    : "updated";
  return {
    id: row.id,
    productId: row.productId,
    actorUserId: row.actorUserId,
    action,
    snapshot:
      row.snapshotJson && typeof row.snapshotJson === "object"
        ? (row.snapshotJson as Record<string, unknown>)
        : {},
    createdAt: toTimestampString(row.createdAt),
  };
}

function isKnownFoodProductRevisionAction(
  value: string | null | undefined,
): value is FoodProductRevisionAction {
  return (
    value === "created" ||
    value === "updated" ||
    value === "corrected" ||
    value === "deleted" ||
    value === "restored" ||
    value === "imported"
  );
}

function isKnownMealTemplateType(
  value: string | null | undefined,
): value is MealTemplateType {
  return value === "meal" || value === "day";
}

function mapMealTemplateItemRow(row: {
  id: string;
  templateId: string;
  productId: string | null;
  mealGroupLabel?: string | null;
  sortOrder: number;
  label: string;
  quantity: string | number;
  unit: string;
  servingMultiplier: string | number;
  proteinG: string | number;
  carbsG: string | number;
  fatG: string | number;
  caloriesKcal: number;
}): MealTemplateItem {
  return {
    id: row.id,
    templateId: row.templateId,
    productId: row.productId,
    mealGroupLabel: row.mealGroupLabel ?? null,
    sortOrder: row.sortOrder,
    label: row.label,
    quantity: roundToTwoDecimals(toNumber(row.quantity)),
    unit: isKnownQuantityUnit(row.unit) ? row.unit : "serving",
    servingMultiplier: roundToTwoDecimals(toNumber(row.servingMultiplier)),
    proteinG: roundToSingleDecimal(toNumber(row.proteinG)),
    carbsG: roundToSingleDecimal(toNumber(row.carbsG)),
    fatG: roundToSingleDecimal(toNumber(row.fatG)),
    caloriesKcal: row.caloriesKcal,
  };
}

function mapMealTemplateRow(
  row: {
    id: string;
    userId: string;
    type: string;
    label: string;
    notes: string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
  },
  items: MealTemplateItem[],
): MealTemplate {
  return {
    id: row.id,
    userId: row.userId,
    type: isKnownMealTemplateType(row.type) ? row.type : "meal",
    label: row.label,
    notes: row.notes,
    items,
    createdAt: toTimestampString(row.createdAt),
    updatedAt: toTimestampString(row.updatedAt),
  };
}

async function resolveDb(db?: DatabaseClient) {
  return db ?? (await getDb());
}

function dailyMacroTotalsSelectColumns() {
  return {
    entryDate: mealEntries.entryDate,
    proteinG: sql<string>`coalesce(sum(${mealEntries.proteinG}), 0)`,
    carbsG: sql<string>`coalesce(sum(${mealEntries.carbsG}), 0)`,
    fatG: sql<string>`coalesce(sum(${mealEntries.fatG}), 0)`,
    caloriesKcal: sql<string>`coalesce(sum(${mealEntries.caloriesKcal}), 0)`,
  };
}

function selectDailyMacroTotals(db: DatabaseClient) {
  return db
    .select(dailyMacroTotalsSelectColumns())
    .from(mealEntries);
}

function selectDailyMacroTotalsWithItemCount(db: DatabaseClient) {
  return db
    .select({
      ...dailyMacroTotalsSelectColumns(),
      itemCount: sql<string>`count(${mealEntries.id})`,
    })
    .from(mealEntries);
}

function selectDailyMacroTotalsWithEntryCount(db: DatabaseClient) {
  return db
    .select({
      ...dailyMacroTotalsSelectColumns(),
      entryCount: sql<string>`count(${mealEntries.id})`,
    })
    .from(mealEntries);
}

async function getDailyTotalsForRange(
  userId: string,
  startDate: string,
  endDate: string,
  db?: DatabaseClient,
) {
  const database = await resolveDb(db);

  const rows = await selectDailyMacroTotals(database)
    .where(
      and(
        eatenEntryPredicate(userId),
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
      role: users.role,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
      goalCaloriesKcal: users.goalCaloriesKcal,
      goalProteinG: users.goalProteinG,
      goalCarbsG: users.goalCarbsG,
      goalFatG: users.goalFatG,
      goalWeightKg: users.goalWeightKg,
      onboardingCompletedAt: users.onboardingCompletedAt,
      preferredWeightUnit: users.preferredWeightUnit,
    })
    .from(users)
    .where(
      or(
        eq(users.shooPairwiseSub, profile.pairwiseSub),
        eq(users.email, profile.email),
      ),
    )
    .limit(1);

  if (existing[0]) {
    const [updated] = await database
      .update(users)
      .set({
        shooPairwiseSub: profile.pairwiseSub,
        email: profile.email,
        displayName: profile.displayName ?? null,
        pictureUrl: profile.pictureUrl ?? null,
        lastLoginAt: new Date(),
      })
      .where(eq(users.id, existing[0].id))
      .returning();

    return mapUserRow(updated as UserSelectRow);
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

  return mapUserRow(created as UserSelectRow);
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
      role: users.role,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
      goalCaloriesKcal: users.goalCaloriesKcal,
      goalProteinG: users.goalProteinG,
      goalCarbsG: users.goalCarbsG,
      goalFatG: users.goalFatG,
      goalWeightKg: users.goalWeightKg,
      onboardingCompletedAt: users.onboardingCompletedAt,
      preferredWeightUnit: users.preferredWeightUnit,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return user ? mapUserRow(user as UserSelectRow) : null;
}

export function getApiScopes(): ApiScope[] {
  return [...API_SCOPE_VALUES];
}

function normalizeApiTokenExpiry(expiresAt: Date | string | null | undefined) {
  if (expiresAt === undefined) {
    return defaultApiTokenExpiry();
  }

  if (expiresAt === null) {
    return null;
  }

  const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("API token expiry is invalid.");
  }

  return date;
}

function apiTokenSelectColumns() {
  return {
    id: apiTokens.id,
    userId: apiTokens.userId,
    tokenPrefix: apiTokens.tokenPrefix,
    name: apiTokens.name,
    scopes: apiTokens.scopes,
    createdAt: apiTokens.createdAt,
    lastUsedAt: apiTokens.lastUsedAt,
    expiresAt: apiTokens.expiresAt,
    revokedAt: apiTokens.revokedAt,
  };
}

export async function createApiToken(
  userId: string,
  input: {
    name: string;
    scopes: readonly string[];
    expiresAt?: Date | string | null;
  },
  db?: DatabaseClient,
): Promise<{ token: string; record: ApiTokenRecord }> {
  const database = await resolveDb(db);
  const name = input.name.trim();
  if (!name) {
    throw new Error("API token name is required.");
  }

  const scopes = normalizeApiTokenScopes(input.scopes);
  const token = generateApiTokenSecret();
  const tokenHash = hashApiToken(token);
  const [created] = await database
    .insert(apiTokens)
    .values({
      id: crypto.randomUUID(),
      userId,
      tokenHash,
      tokenPrefix: buildApiTokenDisplayPrefix(tokenHash),
      name,
      scopes,
      expiresAt: normalizeApiTokenExpiry(input.expiresAt),
    })
    .returning();

  return {
    token,
    record: mapApiTokenRow(created as ApiTokenSelectRow),
  };
}

export async function listApiTokens(
  userId: string,
  db?: DatabaseClient,
): Promise<ApiTokenRecord[]> {
  const database = await resolveDb(db);
  const rows = await database
    .select(apiTokenSelectColumns())
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt));

  return rows.map((row) => mapApiTokenRow(row as ApiTokenSelectRow));
}

export async function revokeApiToken(
  userId: string,
  tokenId: string,
  db?: DatabaseClient,
): Promise<boolean> {
  const database = await resolveDb(db);
  const [revoked] = await database
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiTokens.id, tokenId),
        eq(apiTokens.userId, userId),
        isNull(apiTokens.revokedAt),
      ),
    )
    .returning();

  return Boolean(revoked);
}

export async function authenticateApiToken(
  token: string | null | undefined,
  db?: DatabaseClient,
): Promise<ApiTokenAuthResult> {
  if (!token) {
    return { ok: false, reason: "missing" };
  }

  if (!token.startsWith(API_TOKEN_PREFIX) || token.length <= API_TOKEN_PREFIX.length) {
    return { ok: false, reason: "malformed" };
  }

  const database = await resolveDb(db);
  const tokenHash = hashApiToken(token);
  const now = new Date();
  const [row] = await database
    .select(apiTokenSelectColumns())
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, tokenHash))
    .limit(1);

  if (!row) {
    return { ok: false, reason: "invalid" };
  }

  const record = mapApiTokenRow(row as ApiTokenSelectRow);
  if (record.revokedAt) {
    return { ok: false, reason: "revoked" };
  }

  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  const staleLastUsedAt = new Date(now.getTime() - API_TOKEN_LAST_USED_THROTTLE_MS);
  const lastUsedAt = record.lastUsedAt ? new Date(record.lastUsedAt) : null;
  if (!lastUsedAt || lastUsedAt.getTime() < staleLastUsedAt.getTime()) {
    const [updated] = await database
      .update(apiTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(apiTokens.id, record.id),
          isNull(apiTokens.revokedAt),
          or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
          or(isNull(apiTokens.lastUsedAt), lt(apiTokens.lastUsedAt, staleLastUsedAt)),
        ),
      )
      .returning();

    return {
      ok: true,
      token: mapApiTokenRow((updated ?? row) as ApiTokenSelectRow),
    };
  }

  return { ok: true, token: record };
}

const DEFAULT_MEAL_GROUP_LABELS = ["Breakfast", "Lunch", "Dinner", "Snack"] as const;

function deterministicUuid(seed: string) {
  const hash = createHash("md5").update(seed).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function defaultMealGroupId(userId: string, label: string) {
  return deterministicUuid(`${userId}:meal-group:${label}`);
}

export async function ensureDefaultMealGroups(userId: string, db?: DatabaseClient) {
  const database = await resolveDb(db);
  const existing = await database
    .select({ id: mealGroups.id })
    .from(mealGroups)
    .where(and(eq(mealGroups.userId, userId), isNull(mealGroups.deletedAt)))
    .limit(1);

  if (existing.length > 0) {
    return;
  }

  const now = new Date();
  await database
    .insert(mealGroups)
    .values(DEFAULT_MEAL_GROUP_LABELS.map((label, index) => ({
      id: defaultMealGroupId(userId, label),
      userId,
      label,
      sortOrder: index,
      isDefault: true,
      updatedAt: now,
    })))
    .onConflictDoUpdate({
      target: mealGroups.id,
      set: {
        label: sql`excluded.label`,
        sortOrder: sql`excluded.sort_order`,
        isDefault: true,
        deletedAt: null,
        updatedAt: now,
      },
    });
}

export async function getMealGroups(
  userId: string,
  db?: DatabaseClient,
): Promise<MealGroup[]> {
  const database = await resolveDb(db);
  await ensureDefaultMealGroups(userId, database);
  const rows = await database
    .select({
      id: mealGroups.id,
      userId: mealGroups.userId,
      label: mealGroups.label,
      sortOrder: mealGroups.sortOrder,
      isDefault: mealGroups.isDefault,
    })
    .from(mealGroups)
    .where(and(eq(mealGroups.userId, userId), isNull(mealGroups.deletedAt)))
    .orderBy(mealGroups.sortOrder, mealGroups.label);

  return rows.map(mapMealGroupRow);
}

export async function createMealGroup(
  userId: string,
  input: { label: string },
  db?: DatabaseClient,
): Promise<MealGroup> {
  const database = await resolveDb(db);
  const label = input.label.trim();
  if (!label) {
    throw new Error("Meal group name is required.");
  }

  const [row] = await database
    .select({ maxSortOrder: max(mealGroups.sortOrder) })
    .from(mealGroups)
    .where(and(eq(mealGroups.userId, userId), isNull(mealGroups.deletedAt)));

  const [created] = await database
    .insert(mealGroups)
    .values({
      id: crypto.randomUUID(),
      userId,
      label,
      sortOrder: (row?.maxSortOrder ?? -1) + 1,
      isDefault: false,
      updatedAt: new Date(),
    })
    .returning();

  return mapMealGroupRow(created);
}

export async function updateMealGroup(
  userId: string,
  groupId: string,
  input: { label: string },
  db?: DatabaseClient,
): Promise<MealGroup> {
  const database = await resolveDb(db);
  const label = input.label.trim();
  if (!label) {
    throw new Error("Meal group name is required.");
  }

  const [updated] = await database
    .update(mealGroups)
    .set({ label, updatedAt: new Date() })
    .where(and(eq(mealGroups.id, groupId), eq(mealGroups.userId, userId)))
    .returning();

  if (!updated) {
    throw new Error("Meal group not found.");
  }

  return mapMealGroupRow(updated);
}

export async function deleteMealGroup(
  userId: string,
  groupId: string,
  db?: DatabaseClient,
): Promise<boolean> {
  const database = await resolveDb(db);
  return database.transaction(async (tx) => {
    const now = new Date();
    const [deleted] = await tx
      .update(mealGroups)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(mealGroups.id, groupId),
          eq(mealGroups.userId, userId),
          isNull(mealGroups.deletedAt),
        ),
      )
      .returning();

    if (!deleted) {
      return false;
    }

    await tx
      .update(mealEntries)
      .set({ mealGroupId: null, updatedAt: now })
      .where(and(eq(mealEntries.userId, userId), eq(mealEntries.mealGroupId, groupId)));

    return true;
  });
}

export async function reorderMealGroups(
  userId: string,
  orderedGroupIds: string[],
  db?: DatabaseClient,
): Promise<MealGroup[]> {
  const database = await resolveDb(db);
  const groups = await getMealGroups(userId, database);
  const activeGroupIds = new Set(groups.map((group) => group.id));
  const orderedIdSet = new Set(orderedGroupIds);
  if (
    orderedGroupIds.length !== groups.length ||
    orderedIdSet.size !== orderedGroupIds.length ||
    orderedGroupIds.some((groupId) => !activeGroupIds.has(groupId))
  ) {
    throw new Error("orderedIds must include each active meal group exactly once.");
  }

  const now = new Date();
  await database.transaction(async (tx) => {
    for (const [index, groupId] of orderedGroupIds.entries()) {
      await tx
        .update(mealGroups)
        .set({ sortOrder: index, updatedAt: now })
        .where(and(eq(mealGroups.id, groupId), eq(mealGroups.userId, userId)));
    }
  });

  return getMealGroups(userId, database);
}

export async function getDailySummary(
  userId: string,
  selectedDate: string,
  db?: DatabaseClient,
): Promise<DailySummary> {
  const database = await resolveDb(db);
  const [rows, groups] = await Promise.all([
    selectMealEntriesWithAccessibleProduct(database, userId)
      .where(
        and(eq(mealEntries.userId, userId), eq(mealEntries.entryDate, selectedDate)),
      )
      .orderBy(mealEntries.sortOrder, mealEntries.createdAt),
    getMealGroups(userId, database),
  ]);

  const meals = rows.map((row) => mapMealRow(row));
  const sumMeals = (status: MealEntryStatus) => meals
    .filter((meal) => meal.status === status)
    .reduce(
      (carry, meal) => ({
        proteinG: roundToSingleDecimal(carry.proteinG + meal.proteinG),
        carbsG: roundToSingleDecimal(carry.carbsG + meal.carbsG),
        fatG: roundToSingleDecimal(carry.fatG + meal.fatG),
        caloriesKcal: carry.caloriesKcal + meal.caloriesKcal,
      }),
      zeroMacros(),
    );
  const totals = sumMeals("eaten");
  const plannedTotals = sumMeals("planned");
  const skippedTotals = sumMeals("skipped");

  return {
    date: selectedDate,
    totals,
    plannedTotals,
    skippedTotals,
    meals,
    mealGroups: groups,
  };
}

function eatenEntryPredicate(userId: string) {
  return and(eq(mealEntries.userId, userId), eq(mealEntries.status, "eaten"));
}

function productAccessPredicate(userId: string) {
  return and(
    isNull(foodProducts.deletedAt),
    or(eq(foodProducts.ownerUserId, userId), isNull(foodProducts.ownerUserId)),
  );
}

function foodProductSnapshot(product: FoodProduct): Record<string, unknown> {
  return {
    id: product.id,
    ownerUserId: product.ownerUserId,
    scope: product.scope,
    source: product.source,
    barcode: product.barcode,
    name: product.name,
    brand: product.brand,
    defaultServingQuantity: product.defaultServingQuantity,
    defaultServingUnit: product.defaultServingUnit,
    proteinPer100: product.proteinPer100,
    carbsPer100: product.carbsPer100,
    fatPer100: product.fatPer100,
    caloriesPer100: product.caloriesPer100,
    servingWeightG: product.servingWeightG,
    servingVolumeMl: product.servingVolumeMl,
    submittedByUserId: product.submittedByUserId,
    deletedByUserId: product.deletedByUserId,
    sourceProvider: product.sourceProvider,
    sourceConfidence: product.sourceConfidence,
    sourceMetadata: product.sourceMetadata,
    correctedFromProductId: product.correctedFromProductId,
  };
}

async function insertFoodProductRevision(
  db: DatabaseClient | any,
  input: {
    product: FoodProduct;
    actorUserId?: string | null;
    action: FoodProductRevisionAction;
  },
) {
  await db.insert(foodProductRevisions).values({
    id: crypto.randomUUID(),
    productId: input.product.id,
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    snapshotJson: foodProductSnapshot(input.product),
  });
}

export async function searchFoodProducts(
  userId: string,
  query: string,
  db?: DatabaseClient,
): Promise<FoodProduct[]> {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }

  const database = await resolveDb(db);
  const wordConditions = words.map((word) => {
    const pattern = `%${escapeLikePattern(word)}%`;
    return or(
      ilike(foodProducts.name, pattern),
      ilike(foodProducts.brand, pattern),
      ilike(foodProducts.barcode, pattern),
    );
  });

  const rows = await database
    .select(foodProductSelectColumns)
    .from(foodProducts)
    .where(and(productAccessPredicate(userId), ...wordConditions))
    .orderBy(
      sql`case
        when ${foodProducts.ownerUserId} = ${userId} and ${foodProducts.correctedFromProductId} is not null then 0
        when ${foodProducts.ownerUserId} = ${userId} then 1
        else 2
      end`,
      asc(foodProducts.name),
    )
    .limit(50);

  return rows.map(mapFoodProductRow);
}

export async function createPersonalFoodProduct(
  userId: string,
  input: FoodProductInput,
  db?: DatabaseClient,
): Promise<FoodProduct> {
  const database = await resolveDb(db);
  const normalizedInput = validateFoodProductInput(input);
  const normalized = {
    ...normalizedInput,
    scope: "personal" as const,
  };

  return (database as any).transaction(async (tx: any) => {
    const [created] = await tx
      .insert(foodProducts)
      .values({
        id: crypto.randomUUID(),
        ownerUserId: userId,
        scope: normalized.scope,
        ...buildFoodProductInputValues(normalized),
        submittedByUserId: normalized.submittedByUserId ?? userId,
        deletedByUserId: normalized.deletedByUserId ?? null,
      })
      .returning();

    const product = mapFoodProductRow(created);
    await insertFoodProductRevision(tx, {
      product,
      actorUserId: userId,
      action: product.correctedFromProductId ? "corrected" : "created",
    });
    return product;
  });
}

export async function getFoodProductByIdForUser(
  userId: string,
  productId: string,
  db?: DatabaseClient,
): Promise<FoodProduct | null> {
  const database = await resolveDb(db);
  const [row] = await database
    .select(foodProductSelectColumns)
    .from(foodProducts)
    .where(and(eq(foodProducts.id, productId), productAccessPredicate(userId)))
    .limit(1);

  return row ? mapFoodProductRow(row) : null;
}

async function assertFoodProductsAccessibleForUser(
  userId: string,
  productIds: Array<string | null | undefined>,
  db: DatabaseClient,
) {
  const uniqueProductIds = Array.from(
    new Set(productIds.filter((productId): productId is string => Boolean(productId))),
  );

  for (const productId of uniqueProductIds) {
    const product = await getFoodProductByIdForUser(userId, productId, db);
    if (!product) {
      throw new Error("Food product not found.");
    }
  }
}

async function assertMealGroupAccessibleForUser(
  userId: string,
  mealGroupId: string | null | undefined,
  db: DatabaseClient,
) {
  if (!mealGroupId) {
    return;
  }

  const [row] = await db
    .select({ id: mealGroups.id })
    .from(mealGroups)
    .where(
      and(
        eq(mealGroups.id, mealGroupId),
        eq(mealGroups.userId, userId),
        isNull(mealGroups.deletedAt),
      ),
    )
    .limit(1);

  if (!row) {
    throw new Error("Meal group not found.");
  }
}

function productControlsMealMacros(product: FoodProduct) {
  return product.scope !== "legacy" && product.source !== "legacy";
}

async function resolveMealProductDefaults(
  userId: string,
  input: Pick<
    MealEntryInput,
    "productId" | "quantity" | "unit" | "servingMultiplier"
  >,
  db: DatabaseClient,
  options: { recalculateProductMacros?: boolean } = {},
) {
  if (!input.productId) {
    return { productLabel: null, productMacros: null };
  }

  const product = await getFoodProductByIdForUser(userId, input.productId, db);
  if (!product) {
    throw new Error("Food product not found.");
  }

  const productLabel = product.brand ? `${product.name} (${product.brand})` : product.name;
  const shouldRecalculate =
    options.recalculateProductMacros !== false && productControlsMealMacros(product);
  const productMacros = shouldRecalculate
    ? resolveProductNutritionForQuantity(
        product,
        input.quantity ?? product.defaultServingQuantity,
        input.unit ?? product.defaultServingUnit,
        input.servingMultiplier ?? 1,
      )
    : null;

  return { productLabel, productMacros };
}

export async function updatePersonalFoodProduct(
  userId: string,
  productId: string,
  input: FoodProductInput,
  db?: DatabaseClient,
): Promise<FoodProduct> {
  const database = await resolveDb(db);
  const normalized = validateFoodProductInput(input);
  return (database as any).transaction(async (tx: any) => {
    const [updated] = await tx
      .update(foodProducts)
      .set(buildFoodProductInputValues(normalized))
      .where(
        and(
          eq(foodProducts.id, productId),
          eq(foodProducts.ownerUserId, userId),
          isNull(foodProducts.deletedAt),
        ),
      )
      .returning();

    if (!updated) {
      throw new Error("Food product not found.");
    }

    const product = mapFoodProductRow(updated);
    await insertFoodProductRevision(tx, {
      product,
      actorUserId: userId,
      action: "updated",
    });
    return product;
  });
}

export function resolveProductNutritionForQuantity(
  product: FoodProduct,
  quantity: number,
  unit: QuantityUnit,
  servingMultiplier = 1,
): MacroNumbers {
  const safeQuantity = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  const safeMultiplier =
    Number.isFinite(servingMultiplier) && servingMultiplier > 0
      ? servingMultiplier
      : 1;
  let factor: number;

  if (unit === "g") {
    factor = safeQuantity / 100;
  } else if (unit === "ml") {
    factor = safeQuantity / 100;
  } else {
    const baseAmount =
      product.servingWeightG ?? product.servingVolumeMl ?? 100;
    factor = (safeQuantity * safeMultiplier * baseAmount) / 100;
  }

  return {
    proteinG: roundToSingleDecimal(product.proteinPer100 * factor),
    carbsG: roundToSingleDecimal(product.carbsPer100 * factor),
    fatG: roundToSingleDecimal(product.fatPer100 * factor),
    caloriesKcal: Math.round(product.caloriesPer100 * factor),
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

  const rows = await selectDailyMacroTotalsWithItemCount(database)
    .where(
      and(
        eq(mealEntries.userId, userId),
        eq(mealEntries.status, "eaten"),
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

async function getMealEntryByClientMutationId(
  userId: string,
  clientMutationId: string,
  db: DatabaseClient,
): Promise<MealEntryRecord | null> {
  const [existing] = await selectMealEntriesWithAccessibleProduct(db, userId)
    .where(
      and(
        eq(mealEntries.userId, userId),
        eq(mealEntries.clientMutationId, clientMutationId),
      ),
    )
    .limit(1);

  return existing ? mapMealRow(existing) : null;
}

export async function getMealEntryById(
  userId: string,
  entryId: string,
  db?: DatabaseClient,
): Promise<MealEntryRecord | null> {
  const database = await resolveDb(db);
  const [existing] = await selectMealEntriesWithAccessibleProduct(database, userId)
    .where(and(eq(mealEntries.id, entryId), eq(mealEntries.userId, userId)))
    .limit(1);

  return existing ? mapMealRow(existing) : null;
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

  await assertMealGroupAccessibleForUser(userId, input.mealGroupId, database);

  const { productLabel, productMacros } = await resolveMealProductDefaults(
    userId,
    input,
    database,
  );

  const normalized = validateMealEntryInput({
    ...input,
    sortOrder: nextSortOrder,
    label: input.label || productLabel || "",
    ...(productMacros ?? {}),
  });

  const insertValues = buildMealEntryInsertValues(userId, normalized);

  const [created] = normalized.clientMutationId
    ? await database
        .insert(mealEntries)
        .values(insertValues)
        .onConflictDoNothing({
          target: [mealEntries.userId, mealEntries.clientMutationId],
        })
        .returning()
    : await database.insert(mealEntries).values(insertValues).returning();

  if (!created && normalized.clientMutationId) {
    const existing = await getMealEntryByClientMutationId(
      userId,
      normalized.clientMutationId,
      database,
    );
    if (existing) {
      return existing;
    }
  }

  if (!created) {
    throw new Error("Unable to create meal entry.");
  }

  return mapMealRow(created);
}

export async function updateMealEntry(
  userId: string,
  entryId: string,
  input: MealEntryInput,
  db?: DatabaseClient,
  options?: { recalculateProductMacros?: boolean },
) {
  const database = await resolveDb(db);
  await assertMealGroupAccessibleForUser(userId, input.mealGroupId, database);

  const { productLabel, productMacros } = await resolveMealProductDefaults(
    userId,
    input,
    database,
    { recalculateProductMacros: options?.recalculateProductMacros },
  );
  const normalized = validateMealEntryInput({
    ...input,
    label: input.label || productLabel || "",
    ...(productMacros ?? {}),
  });

  const [updated] = await database
    .update(mealEntries)
    .set(buildMealEntryValues(normalized))
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

export async function markMealEntryStatus(
  userId: string,
  entryId: string,
  status: MealEntryStatus,
  db?: DatabaseClient,
) {
  const database = await resolveDb(db);
  if (!isKnownMealEntryStatus(status)) {
    throw new Error("Meal status is invalid.");
  }

  const [updated] = await database
    .update(mealEntries)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(mealEntries.id, entryId), eq(mealEntries.userId, userId)))
    .returning();

  if (!updated) {
    throw new Error("Meal entry not found.");
  }

  return mapMealRow(updated);
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

type CompleteOnboardingSetupInput = {
  preferredWeightUnit: WeightUnit;
  goals: MacroGoals;
  goalWeightKg: number | null;
  currentWeight: WeightEntryInput | null;
  starterTemplate: MealTemplateInput | null;
};

export async function completeOnboardingSetup(
  userId: string,
  input: CompleteOnboardingSetupInput,
  db?: DatabaseClient,
): Promise<AppUser> {
  const database = await resolveDb(db);

  return (database as any).transaction(async (tx: any) => {
    await saveUserGoals(userId, input.goals, tx);
    await saveWeightGoal(userId, input.goalWeightKg, tx);

    if (input.currentWeight) {
      await createWeightEntry(userId, input.currentWeight, tx);
    }

    if (input.starterTemplate) {
      await createTemplate(userId, input.starterTemplate, tx);
    }

    const user = await completeUserOnboarding(
      userId,
      { preferredWeightUnit: input.preferredWeightUnit },
      tx,
    );
    if (!user) {
      throw new Error("User not found.");
    }

    return user;
  });
}

export async function completeUserOnboarding(
  userId: string,
  input: CompleteOnboardingInput,
  db?: DatabaseClient,
): Promise<AppUser | null> {
  const database = await resolveDb(db);
  const [updated] = await database
    .update(users)
    .set({
      onboardingCompletedAt: new Date(),
      preferredWeightUnit: input.preferredWeightUnit,
    })
    .where(eq(users.id, userId))
    .returning();

  return updated ? mapUserRow(updated as UserSelectRow) : null;
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
    .where(eatenEntryPredicate(userId))
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
  const rows = await selectMealEntriesWithAccessibleProduct(database, userId)
    .where(and(eatenEntryPredicate(userId), ...wordConditions))
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

function normalizeTemplateInput(input: MealTemplateInput): MealTemplateInput {
  const label = input.label.trim();
  if (!label) {
    throw new Error("Template name is required.");
  }
  if (!isKnownMealTemplateType(input.type)) {
    throw new Error("Template type is invalid.");
  }
  if (input.items.length === 0) {
    throw new Error("A template must include at least one item.");
  }

  const items = input.items.map((item, index) => {
    const normalized = validateMealEntryInput({
      date: "2000-01-01",
      label: item.label,
      sortOrder: index,
      productId: item.productId,
      quantity: item.quantity,
      unit: item.unit,
      servingMultiplier: item.servingMultiplier,
      proteinG: item.proteinG,
      carbsG: item.carbsG,
      fatG: item.fatG,
      caloriesKcal: item.caloriesKcal,
    });

    return {
      productId: normalized.productId,
      mealGroupLabel: item.mealGroupLabel?.trim() || null,
      label: normalized.label,
      quantity: normalized.quantity,
      unit: normalized.unit,
      servingMultiplier: normalized.servingMultiplier,
      proteinG: normalized.proteinG,
      carbsG: normalized.carbsG,
      fatG: normalized.fatG,
      caloriesKcal: normalized.caloriesKcal,
    };
  });

  return {
    type: input.type,
    label,
    notes: input.notes?.trim() || null,
    items,
  };
}

function buildTemplateItemValues(
  templateId: string,
  item: MealTemplateInput["items"][number],
  index: number,
) {
  return {
    id: crypto.randomUUID(),
    templateId,
    productId: item.productId,
    mealGroupLabel: item.mealGroupLabel,
    sortOrder: index,
    label: item.label,
    quantity: item.quantity?.toFixed(2) ?? "1.00",
    unit: item.unit ?? "serving",
    servingMultiplier: item.servingMultiplier?.toFixed(2) ?? "1.00",
    proteinG: item.proteinG.toFixed(1),
    carbsG: item.carbsG.toFixed(1),
    fatG: item.fatG.toFixed(1),
    caloriesKcal: item.caloriesKcal,
  };
}

async function insertTemplateItems(
  tx: any,
  templateId: string,
  items: MealTemplateInput["items"],
) {
  await tx.insert(mealTemplateItems).values(
    items.map((item, index) => buildTemplateItemValues(templateId, item, index)),
  );
}

async function getTemplateRows(
  userId: string,
  db: DatabaseClient,
  templateId?: string,
): Promise<MealTemplate[]> {
  const templateConditions = [
    eq(mealTemplates.userId, userId),
    isNull(mealTemplates.deletedAt),
  ];
  if (templateId) {
    templateConditions.push(eq(mealTemplates.id, templateId));
  }

  const rows = await db
    .select({
      id: mealTemplates.id,
      userId: mealTemplates.userId,
      type: mealTemplates.type,
      label: mealTemplates.label,
      notes: mealTemplates.notes,
      createdAt: mealTemplates.createdAt,
      updatedAt: mealTemplates.updatedAt,
    })
    .from(mealTemplates)
    .where(and(...templateConditions))
    .orderBy(asc(mealTemplates.label));

  if (rows.length === 0) {
    return [];
  }

  const templateIds = rows.map((row) => row.id);
  const itemRows = await db
    .select({
      id: mealTemplateItems.id,
      templateId: mealTemplateItems.templateId,
      productId: mealTemplateItems.productId,
      mealGroupLabel: mealTemplateItems.mealGroupLabel,
      sortOrder: mealTemplateItems.sortOrder,
      label: mealTemplateItems.label,
      quantity: mealTemplateItems.quantity,
      unit: mealTemplateItems.unit,
      servingMultiplier: mealTemplateItems.servingMultiplier,
      proteinG: mealTemplateItems.proteinG,
      carbsG: mealTemplateItems.carbsG,
      fatG: mealTemplateItems.fatG,
      caloriesKcal: mealTemplateItems.caloriesKcal,
    })
    .from(mealTemplateItems)
    .where(inArray(mealTemplateItems.templateId, templateIds))
    .orderBy(asc(mealTemplateItems.sortOrder));

  const itemsByTemplate = new Map<string, MealTemplateItem[]>();
  for (const item of itemRows.map(mapMealTemplateItemRow)) {
    const items = itemsByTemplate.get(item.templateId) ?? [];
    items.push(item);
    itemsByTemplate.set(item.templateId, items);
  }

  return rows.map((row) => mapMealTemplateRow(row, itemsByTemplate.get(row.id) ?? []));
}

export async function getTemplates(
  userId: string,
  db?: DatabaseClient,
): Promise<MealTemplate[]> {
  const database = await resolveDb(db);
  return getTemplateRows(userId, database);
}

export async function getTemplateById(
  userId: string,
  templateId: string,
  db?: DatabaseClient,
): Promise<MealTemplate | null> {
  const database = await resolveDb(db);
  const [template] = await getTemplateRows(userId, database, templateId);
  return template ?? null;
}

export async function createTemplate(
  userId: string,
  input: MealTemplateInput,
  db?: DatabaseClient,
): Promise<MealTemplate> {
  const database = await resolveDb(db);
  const normalized = normalizeTemplateInput(input);

  return (database as any).transaction(async (tx: any) => {
    await assertFoodProductsAccessibleForUser(
      userId,
      normalized.items.map((item) => item.productId),
      tx,
    );

    const templateId = crypto.randomUUID();
    const now = new Date();
    await tx.insert(mealTemplates).values({
      id: templateId,
      userId,
      type: normalized.type,
      label: normalized.label,
      notes: normalized.notes,
      updatedAt: now,
    });
    await insertTemplateItems(tx, templateId, normalized.items);

    const [created] = await getTemplateRows(userId, tx, templateId);
    if (!created) {
      throw new Error("Unable to create template.");
    }
    return created;
  });
}

export async function updateTemplate(
  userId: string,
  templateId: string,
  input: MealTemplateInput,
  db?: DatabaseClient,
): Promise<MealTemplate> {
  const database = await resolveDb(db);
  const normalized = normalizeTemplateInput(input);

  return (database as any).transaction(async (tx: any) => {
    const now = new Date();
    const [updated] = await tx
      .update(mealTemplates)
      .set({
        type: normalized.type,
        label: normalized.label,
        notes: normalized.notes,
        updatedAt: now,
      })
      .where(
        and(
          eq(mealTemplates.id, templateId),
          eq(mealTemplates.userId, userId),
          isNull(mealTemplates.deletedAt),
        ),
      )
      .returning();

    if (!updated) {
      throw new Error("Template not found.");
    }

    await assertFoodProductsAccessibleForUser(
      userId,
      normalized.items.map((item) => item.productId),
      tx,
    );

    await tx
      .delete(mealTemplateItems)
      .where(eq(mealTemplateItems.templateId, templateId));
    await insertTemplateItems(tx, templateId, normalized.items);

    const [template] = await getTemplateRows(userId, tx, templateId);
    if (!template) {
      throw new Error("Template not found.");
    }
    return template;
  });
}

export async function deleteTemplate(
  userId: string,
  templateId: string,
  db?: DatabaseClient,
): Promise<boolean> {
  const database = await resolveDb(db);
  const now = new Date();
  const [deleted] = await database
    .update(mealTemplates)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(mealTemplates.id, templateId),
        eq(mealTemplates.userId, userId),
        isNull(mealTemplates.deletedAt),
      ),
    )
    .returning();

  return Boolean(deleted);
}

export async function applyTemplateToDate(
  userId: string,
  input: {
    templateId: string;
    date: string;
    status?: MealEntryStatus;
  },
  db?: DatabaseClient,
): Promise<MealEntryRecord[]> {
  const database = await resolveDb(db);
  return (database as any).transaction(async (tx: any) => {
    const template = await getTemplateById(userId, input.templateId, tx);
    if (!template) {
      throw new Error("Template not found.");
    }

    await assertFoodProductsAccessibleForUser(
      userId,
      template.items.map((item) => item.productId),
      tx,
    );

    const groups = await getMealGroups(userId, tx);
    const groupByLabel = new Map(
      groups.map((group) => [group.label.toLowerCase(), group.id]),
    );
    const created: MealEntryRecord[] = [];

    for (const item of template.items) {
      const mealGroupId =
        item.mealGroupLabel
          ? groupByLabel.get(item.mealGroupLabel.toLowerCase()) ?? null
          : null;
      created.push(
        await createMealEntry(
          userId,
          {
            date: input.date,
            mealGroupId,
            status: input.status ?? "planned",
            productId: item.productId,
            label: item.label,
            quantity: item.quantity,
            unit: item.unit,
            servingMultiplier: item.servingMultiplier,
            proteinG: item.proteinG,
            carbsG: item.carbsG,
            fatG: item.fatG,
            caloriesKcal: item.caloriesKcal,
          },
          tx,
        ),
      );
    }

    return created;
  });
}

export async function createTemplateFromDate(
  userId: string,
  input: {
    date: string;
    type: MealTemplateType;
    label: string;
  },
  db?: DatabaseClient,
): Promise<MealTemplate> {
  const database = await resolveDb(db);
  const summary = await getDailySummary(userId, input.date, database);
  const groupById = new Map(summary.mealGroups.map((group) => [group.id, group.label]));
  const meals = summary.meals.filter((meal) => meal.status !== "skipped");
  return createTemplate(
    userId,
    {
      type: input.type,
      label: input.label,
      items: meals.map((meal) => ({
        productId: meal.productId,
        mealGroupLabel: meal.mealGroupId
          ? groupById.get(meal.mealGroupId) ?? null
          : null,
        label: meal.label,
        quantity: meal.quantity,
        unit: meal.unit,
        servingMultiplier: meal.servingMultiplier,
        proteinG: meal.proteinG,
        carbsG: meal.carbsG,
        fatG: meal.fatG,
        caloriesKcal: meal.caloriesKcal,
      })),
    },
    database,
  );
}

export async function getStatsPageData(
  userId: string,
  today: string,
  db?: DatabaseClient,
): Promise<StatsPageData> {
  const database = await resolveDb(db);

  const [dailyRows, plannedTrendRows, labelRows, goals, weights, statusRows] = await Promise.all([
    selectDailyMacroTotals(database)
      .where(eatenEntryPredicate(userId))
      .groupBy(mealEntries.entryDate)
      .orderBy(asc(mealEntries.entryDate)),
    selectDailyMacroTotals(database)
      .where(
        and(
          eq(mealEntries.userId, userId),
          lte(mealEntries.entryDate, today),
          eq(mealEntries.status, "planned"),
        ),
      )
      .groupBy(mealEntries.entryDate)
      .orderBy(asc(mealEntries.entryDate)),
    database
      .select({
        label: mealEntries.label,
        count: sql<string>`count(*)`,
      })
      .from(mealEntries)
      .where(eatenEntryPredicate(userId))
      .groupBy(mealEntries.label)
      .orderBy(desc(sql`count(*)`))
      .limit(5),
    getUserGoals(userId, database),
    getWeightEntries(userId, database),
    database
      .select({
        status: mealEntries.status,
        count: sql<string>`count(*)`,
      })
      .from(mealEntries)
      .where(eq(mealEntries.userId, userId))
      .groupBy(mealEntries.status),
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

  const eatenDailyTotals = dailyRows.map((row) => ({
    date: row.entryDate,
    proteinG: roundToSingleDecimal(toNumber(row.proteinG)),
    carbsG: roundToSingleDecimal(toNumber(row.carbsG)),
    fatG: roundToSingleDecimal(toNumber(row.fatG)),
    caloriesKcal: Math.round(toNumber(row.caloriesKcal)),
  }));

  const trendDaysByDate = new Map<string, StatsPageData["allDailyTotals"][number]>();
  for (const row of eatenDailyTotals) {
    trendDaysByDate.set(row.date, {
      ...row,
      plannedTotals: zeroMacros(),
    });
  }

  const getTrendDay = (date: string) => {
    let day = trendDaysByDate.get(date);
    if (!day) {
      day = {
        date,
        ...zeroMacros(),
        plannedTotals: zeroMacros(),
      };
      trendDaysByDate.set(date, day);
    }
    return day;
  };

  for (const row of plannedTrendRows) {
    const day = getTrendDay(row.entryDate);
    day.plannedTotals = {
      proteinG: roundToSingleDecimal(toNumber(row.proteinG)),
      carbsG: roundToSingleDecimal(toNumber(row.carbsG)),
      fatG: roundToSingleDecimal(toNumber(row.fatG)),
      caloriesKcal: Math.round(toNumber(row.caloriesKcal)),
    };
  }

  const allDailyTotals = Array.from(trendDaysByDate.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const averageForDays = (days: number) => {
    const windowRows = eatenDailyTotals.slice(-days);
    if (windowRows.length === 0) return zeroMacros();
    const totals = windowRows.reduce(
      (acc, row) => ({
        proteinG: acc.proteinG + row.proteinG,
        carbsG: acc.carbsG + row.carbsG,
        fatG: acc.fatG + row.fatG,
        caloriesKcal: acc.caloriesKcal + row.caloriesKcal,
      }),
      zeroMacros(),
    );
    return {
      proteinG: roundToSingleDecimal(totals.proteinG / windowRows.length),
      carbsG: roundToSingleDecimal(totals.carbsG / windowRows.length),
      fatG: roundToSingleDecimal(totals.fatG / windowRows.length),
      caloriesKcal: Math.round(totals.caloriesKcal / windowRows.length),
    };
  };
  const hitRatesForDays = (days: number) => {
    const windowRows = eatenDailyTotals.slice(-days);
    const minimumRate = (field: keyof MacroNumbers, goal: number | null) => {
      if (goal == null || goal <= 0 || windowRows.length === 0) return null;
      const hits = windowRows.filter((row) => row[field] >= goal * 0.9).length;
      return Math.round((hits / windowRows.length) * 100);
    };
    const targetBandRate = (field: keyof MacroNumbers, goal: number | null) => {
      if (goal == null || goal <= 0 || windowRows.length === 0) return null;
      const hits = windowRows.filter(
        (row) => row[field] >= goal * 0.9 && row[field] <= goal * 1.1,
      ).length;
      return Math.round((hits / windowRows.length) * 100);
    };
    return {
      proteinG: minimumRate("proteinG", goals.proteinG),
      carbsG: minimumRate("carbsG", goals.carbsG),
      fatG: minimumRate("fatG", goals.fatG),
      caloriesKcal: targetBandRate("caloriesKcal", goals.caloriesKcal),
    };
  };
  const calorieDeviationRows =
    goals.caloriesKcal != null
      ? eatenDailyTotals.map((row) => Math.abs(row.caloriesKcal - goals.caloriesKcal!))
      : [];
  const calorieAvgAbsoluteDeviation =
    calorieDeviationRows.length > 0
      ? Math.round(
          calorieDeviationRows.reduce((sum, value) => sum + value, 0) /
            calorieDeviationRows.length,
        )
      : null;
  const consistencyScore =
    calorieAvgAbsoluteDeviation != null && goals.caloriesKcal
      ? Math.max(0, Math.round(100 - (calorieAvgAbsoluteDeviation / goals.caloriesKcal) * 100))
      : null;
  const avgCalories = eatenDailyTotals.length > 0
    ? Math.round(totalCaloriesKcal / eatenDailyTotals.length)
    : 0;
  const averageDailyDeltaKcal =
    goals.caloriesKcal != null && eatenDailyTotals.length > 0
      ? avgCalories - goals.caloriesKcal
      : null;
  const latestWeight = weights[weights.length - 1]?.weightKg ?? null;
  const avgProtein = eatenDailyTotals.length > 0
    ? totalProteinG / eatenDailyTotals.length
    : 0;
  const statusCounts = new Map(statusRows.map((row) => [row.status, toNumber(row.count)]));
  const plannedCount = statusCounts.get("planned") ?? 0;
  const eatenCount = statusCounts.get("eaten") ?? 0;
  const skippedCount = statusCounts.get("skipped") ?? 0;
  const plannedBase = plannedCount + eatenCount + skippedCount;

  return {
    allDailyTotals,
    totalDaysTracked: dailyRows.length,
    currentStreak,
    longestStreak,
    totalProteinG: Math.round(totalProteinG),
    totalCarbsG: Math.round(totalCarbsG),
    totalFatG: Math.round(totalFatG),
    totalCaloriesKcal: Math.round(totalCaloriesKcal),
    bestCalorieDay,
    topLabels: labelRows.map((r) => ({ label: r.label, count: toNumber(r.count) })),
    goalHitRates: {
      days7: hitRatesForDays(7),
      days30: hitRatesForDays(30),
      days90: hitRatesForDays(90),
    },
    macroConsistency: {
      calorieAvgAbsoluteDeviation,
      score: consistencyScore,
    },
    rollingAverages: {
      days7: averageForDays(7),
      days30: averageForDays(30),
    },
    estimatedEnergyBalance: {
      averageDailyDeltaKcal,
      estimatedWeeklyWeightChangeKg:
        averageDailyDeltaKcal != null
          ? roundToTwoDecimals((averageDailyDeltaKcal * 7) / 7700)
          : null,
    },
    proteinPerKg:
      latestWeight != null && latestWeight > 0
        ? roundToTwoDecimals(avgProtein / latestWeight)
        : null,
    smoothedWeightTrend: weights.map((entry, index) => {
      const window = weights.slice(Math.max(0, index - 6), index + 1);
      const avg =
        window.reduce((sum, value) => sum + value.weightKg, 0) / window.length;
      return {
        date: entry.date,
        weightKg: entry.weightKg,
        smoothedWeightKg: roundToTwoDecimals(avg),
      };
    }),
    plannedAdherence: {
      plannedCount,
      eatenCount,
      skippedCount,
      adherencePct:
        plannedBase > 0 ? Math.round((eatenCount / plannedBase) * 100) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Weight tracking
// ---------------------------------------------------------------------------

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
    .values(buildWeightEntryValues(userId, normalized))
    .onConflictDoUpdate({
      target: [weightEntries.userId, weightEntries.entryDate],
      set: buildWeightEntryUpdateValues(normalized),
    })
    .returning();

  return mapWeightRow(created);
}

export async function createWeightEntryNoOverwrite(
  userId: string,
  input: WeightEntryInput,
  db?: DatabaseClient,
): Promise<WeightEntryRecord | null> {
  const database = await resolveDb(db);
  const normalized = validateWeightEntryInput(input);

  const [created] = await database
    .insert(weightEntries)
    .values(buildWeightEntryValues(userId, normalized))
    .onConflictDoNothing({
      target: [weightEntries.userId, weightEntries.entryDate],
    })
    .returning();

  return created ? mapWeightRow(created) : null;
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
    .set(buildWeightEntryUpdateValues(normalized))
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
  recipe: {
    id: string;
    userId: string;
    label: string;
    portions: number;
    totalCookedWeightG?: string | number | null;
  },
  ingredientRows: Array<{
    id: string;
    recipeId: string;
    productId?: string | null;
    sortOrder: number;
    label: string;
    quantity?: string | number;
    unit?: string;
    servingMultiplier?: string | number;
    proteinG: string | number;
    carbsG: string | number;
    fatG: string | number;
    caloriesKcal: number;
  }>,
): RecipeRecord {
  const ingredients: RecipeIngredientRecord[] = ingredientRows.map((row) => ({
    id: row.id,
    recipeId: row.recipeId,
    productId: row.productId ?? null,
    sortOrder: row.sortOrder,
    label: row.label,
    quantity: roundToTwoDecimals(toNumber(row.quantity ?? 1)),
    unit: isKnownQuantityUnit(row.unit) ? row.unit : "serving",
    servingMultiplier: roundToTwoDecimals(toNumber(row.servingMultiplier ?? 1)),
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
    totalCookedWeightG:
      recipe.totalCookedWeightG != null
        ? roundToTwoDecimals(toNumber(recipe.totalCookedWeightG))
        : null,
    ingredients,
    totalMacros,
    perPortionMacros,
  };
}

function buildRecipeIngredientValues(
  recipeId: string,
  ingredient: RecipeInput["ingredients"][number],
  index: number,
) {
  return {
    id: crypto.randomUUID(),
    recipeId,
    productId: ingredient.productId ?? null,
    sortOrder: index,
    label: ingredient.label,
    quantity: ingredient.quantity?.toFixed(2) ?? "1.00",
    unit: ingredient.unit ?? "serving",
    servingMultiplier: ingredient.servingMultiplier?.toFixed(2) ?? "1.00",
    proteinG: ingredient.proteinG.toFixed(1),
    carbsG: ingredient.carbsG.toFixed(1),
    fatG: ingredient.fatG.toFixed(1),
    caloriesKcal: Math.round(ingredient.caloriesKcal),
  };
}

async function insertRecipeIngredientRows(
  tx: any,
  recipeId: string,
  ingredients: RecipeInput["ingredients"],
) {
  const ingredientRows = [];
  for (let i = 0; i < ingredients.length; i++) {
    const ingredient = ingredients[i]!;
    const [row] = await tx
      .insert(recipeIngredients)
      .values(buildRecipeIngredientValues(recipeId, ingredient, i))
      .returning();

    ingredientRows.push(row!);
  }

  return ingredientRows;
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
      totalCookedWeightG: recipes.totalCookedWeightG,
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
      productId: recipeIngredients.productId,
      sortOrder: recipeIngredients.sortOrder,
      label: recipeIngredients.label,
      quantity: recipeIngredients.quantity,
      unit: recipeIngredients.unit,
      servingMultiplier: recipeIngredients.servingMultiplier,
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

const API_TOKEN_PREFIX = "mtk_v1_";
const API_TOKEN_FINGERPRINT_LENGTH = 12;
const API_TOKEN_DEFAULT_EXPIRY_DAYS = 90;
const API_TOKEN_LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

type ApiTokenSelectRow = {
  id: string;
  userId: string;
  tokenPrefix: string;
  name: string;
  scopes: unknown;
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
  expiresAt: Date | string | null;
  revokedAt: Date | string | null;
};

function normalizeStoredApiScopes(value: unknown): ApiScope[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const scopes = value.filter((scope): scope is ApiScope => (
    typeof scope === "string" && isApiScope(scope)
  ));
  return Array.from(new Set(scopes));
}

function normalizeApiTokenScopes(scopes: readonly string[]): ApiScope[] {
  const normalized = Array.from(new Set(scopes));
  if (normalized.length === 0) {
    throw new Error("At least one API scope is required.");
  }

  for (const scope of normalized) {
    if (!isApiScope(scope)) {
      throw new Error(`API scope is invalid: ${scope}`);
    }
  }

  return normalized as ApiScope[];
}

function mapApiTokenRow(row: ApiTokenSelectRow): ApiTokenRecord {
  return {
    id: row.id,
    userId: row.userId,
    tokenPrefix: row.tokenPrefix,
    name: row.name,
    scopes: normalizeStoredApiScopes(row.scopes),
    createdAt: toTimestampString(row.createdAt),
    lastUsedAt: toTimestampString(row.lastUsedAt) || null,
    expiresAt: toTimestampString(row.expiresAt) || null,
    revokedAt: toTimestampString(row.revokedAt) || null,
  };
}

function hashApiToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function buildApiTokenDisplayPrefix(tokenHash: string) {
  return `${API_TOKEN_PREFIX}${tokenHash.slice(0, API_TOKEN_FINGERPRINT_LENGTH)}`;
}

function generateApiTokenSecret() {
  return `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function defaultApiTokenExpiry() {
  return new Date(Date.now() + API_TOKEN_DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

export async function getRecipeCount(
  userId: string,
  db?: DatabaseClient,
): Promise<number> {
  const database = await resolveDb(db);
  const [row] = await database
    .select({ total: count() })
    .from(recipes)
    .where(eq(recipes.userId, userId));

  return toNumber(row?.total);
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
      totalCookedWeightG: recipes.totalCookedWeightG,
    })
    .from(recipes)
    .where(and(eq(recipes.id, recipeId), eq(recipes.userId, userId)))
    .limit(1);

  if (!recipe) return null;

  const ingredientRows = await database
    .select({
      id: recipeIngredients.id,
      recipeId: recipeIngredients.recipeId,
      productId: recipeIngredients.productId,
      sortOrder: recipeIngredients.sortOrder,
      label: recipeIngredients.label,
      quantity: recipeIngredients.quantity,
      unit: recipeIngredients.unit,
      servingMultiplier: recipeIngredients.servingMultiplier,
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

  return (database as any).transaction(async (tx: any) => {
    await assertFoodProductsAccessibleForUser(
      userId,
      validated.ingredients.map((ingredient) => ingredient.productId),
      tx,
    );

    const [created] = await tx
      .insert(recipes)
      .values({
        id: recipeId,
        userId,
        label: validated.label,
        portions: validated.portions,
        totalCookedWeightG:
          validated.totalCookedWeightG != null
            ? validated.totalCookedWeightG.toFixed(2)
            : null,
        updatedAt: new Date(),
      })
      .returning();

    if (!created) {
      throw new Error("Unable to create recipe.");
    }

    const ingredientRows = await insertRecipeIngredientRows(
      tx,
      recipeId,
      validated.ingredients,
    );

    return buildRecipeRecord(created, ingredientRows);
  });
}

export async function updateRecipe(
  userId: string,
  recipeId: string,
  input: RecipeInput,
  db?: DatabaseClient,
): Promise<RecipeRecord> {
  const database = await resolveDb(db);
  const validated = validateRecipeInput(input);

  return (database as any).transaction(async (tx: any) => {
    const [existing] = await tx
      .select({ id: recipes.id })
      .from(recipes)
      .where(and(eq(recipes.id, recipeId), eq(recipes.userId, userId)))
      .limit(1);

    if (!existing) {
      throw new Error("Recipe not found.");
    }

    await assertFoodProductsAccessibleForUser(
      userId,
      validated.ingredients.map((ingredient) => ingredient.productId),
      tx,
    );

    const [updatedRecipe] = await tx
      .update(recipes)
      .set({
        label: validated.label,
        portions: validated.portions,
        totalCookedWeightG:
          validated.totalCookedWeightG != null
            ? validated.totalCookedWeightG.toFixed(2)
            : null,
        updatedAt: new Date(),
      })
      .where(and(eq(recipes.id, recipeId), eq(recipes.userId, userId)))
      .returning({
        id: recipes.id,
        userId: recipes.userId,
        label: recipes.label,
        portions: recipes.portions,
        totalCookedWeightG: recipes.totalCookedWeightG,
      });

    if (!updatedRecipe) {
      throw new Error("Recipe not found.");
    }

    await tx
      .delete(recipeIngredients)
      .where(eq(recipeIngredients.recipeId, recipeId));

    const ingredientRows = await insertRecipeIngredientRows(
      tx,
      recipeId,
      validated.ingredients,
    );

    return buildRecipeRecord(updatedRecipe, ingredientRows);
  });
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

  const rows = await selectDailyMacroTotalsWithEntryCount(database)
    .where(eatenEntryPredicate(userId))
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
// Canonical barcode food products
// ---------------------------------------------------------------------------

function normalizeBarcodeFoodInput(input: BarcodeFoodProductInput): FoodProductInput {
  const barcode = input.barcode.trim();
  const name = input.name.trim();
  if (!barcode) {
    throw new Error("Barcode is required.");
  }
  if (!name) {
    throw new Error("Product name is required.");
  }

  return {
    scope: "global",
    source: "barcode",
    barcode,
    name,
    brand: input.brands?.trim() ?? "",
    defaultServingQuantity: 1,
    defaultServingUnit: "serving",
    proteinPer100: input.proteinG,
    carbsPer100: input.carbsG,
    fatPer100: input.fatG,
    caloriesPer100: Math.round(input.caloriesKcal),
    servingWeightG: input.servingSizeG ?? 100,
    servingVolumeMl: null,
    sourceProvider: "community",
    sourceMetadata: {
      servingSizeG: input.servingSizeG,
    },
  };
}

async function findGlobalBarcodeFoodProduct(
  barcode: string,
  db: DatabaseClient,
  excludeProductId?: string,
): Promise<FoodProduct | null> {
  const conditions = [
    isNull(foodProducts.ownerUserId),
    eq(foodProducts.source, "barcode"),
    eq(foodProducts.barcode, barcode.trim()),
    isNull(foodProducts.deletedAt),
  ];
  if (excludeProductId) {
    conditions.push(ne(foodProducts.id, excludeProductId));
  }
  const [row] = await db
    .select()
    .from(foodProducts)
    .where(and(...conditions))
    .orderBy(desc(foodProducts.updatedAt))
    .limit(1);
  return row ? mapFoodProductRow(row) : null;
}

export async function lookupBarcodeFoodProduct(
  barcode: string,
  db?: DatabaseClient,
): Promise<FoodProduct | null> {
  const database = await resolveDb(db);
  return findGlobalBarcodeFoodProduct(barcode, database);
}

async function insertBarcodeFoodProduct(
  db: DatabaseClient | any,
  submittedByUserId: string,
  input: BarcodeFoodProductInput,
): Promise<FoodProduct> {
  const normalized = validateFoodProductInput({
    ...normalizeBarcodeFoodInput(input),
    submittedByUserId,
  });
  const existing = await findGlobalBarcodeFoodProduct(
    normalized.barcode ?? "",
    db,
  );
  if (existing) {
    throw new Error("That barcode already exists.");
  }

  const now = new Date();
  const [created] = await db
    .insert(foodProducts)
    .values({
      id: crypto.randomUUID(),
      ownerUserId: null,
      scope: "global",
      ...buildFoodProductInputValues(normalized, {
        servingWeightFallback: "100.00",
        forceNullServingVolume: true,
        sourceProviderFallback: "community",
        updatedAt: now,
      }),
      submittedByUserId,
    })
    .returning();

  const product = mapFoodProductRow(created);
  await insertFoodProductRevision(db, {
    product,
    actorUserId: submittedByUserId,
    action: "created",
  });
  return product;
}

export async function saveBarcodeFoodProduct(
  submittedByUserId: string,
  input: BarcodeFoodProductInput,
  db?: DatabaseClient,
): Promise<FoodProduct> {
  const database = await resolveDb(db);
  return (database as any).transaction(async (tx: any) => {
    return insertBarcodeFoodProduct(tx, submittedByUserId, input);
  });
}

// ---------------------------------------------------------------------------
// Quick-add candidate history
// ---------------------------------------------------------------------------

export async function getRecentQuickAddCandidates(
  userId: string,
  limit = 30,
  db?: DatabaseClient,
): Promise<QuickAddCandidate[]> {
  const database = await resolveDb(db);

  // Fetch more rows than needed: extra history gives the habit detector enough
  // data to spot recurring time-of-day patterns across different days.
  const rows = await database
    .select({
      label: mealEntries.label,
      date: mealEntries.entryDate,
      proteinG: mealEntries.proteinG,
      carbsG: mealEntries.carbsG,
      fatG: mealEntries.fatG,
      caloriesKcal: mealEntries.caloriesKcal,
      createdAt: mealEntries.createdAt,
    })
    .from(mealEntries)
    .where(eatenEntryPredicate(userId))
    .orderBy(desc(mealEntries.entryDate), desc(mealEntries.createdAt))
    .limit(400);

  // First pass: collect UTC-hour observations per unique food key so we can
  // detect time-of-day habits before we deduplicate down to one row per food.
  const hourObservations = new Map<string, number[]>();
  const mostRecentDates = new Map<string, string>();
  const dateObservations = new Map<string, Set<string>>();

  for (const row of rows) {
    const protein = roundToSingleDecimal(toNumber(row.proteinG));
    const carbs = roundToSingleDecimal(toNumber(row.carbsG));
    const fat = roundToSingleDecimal(toNumber(row.fatG));
    const cals = toNumber(row.caloriesKcal);
    const key = `${row.label.toLowerCase().trim()}|${protein}|${carbs}|${fat}|${cals}`;

    if (!mostRecentDates.has(key)) {
      mostRecentDates.set(key, row.date);
    }

    const dates = dateObservations.get(key) ?? new Set<string>();
    dates.add(row.date);
    dateObservations.set(key, dates);

    if (row.createdAt) {
      const hour = new Date(row.createdAt).getUTCHours();
      const bucket = hourObservations.get(key) ?? [];
      bucket.push(hour);
      hourObservations.set(key, bucket);
    }
  }

  // Determine whether a food has a clear time-of-day habit.
  // Strategy: bucket observations into 3-hour windows (8 buckets / day).
  // A habit exists when ≥ 3 distinct log entries share the same bucket.
  function detectHabit(
    hours: number[],
  ): { peakHourUtc: number; habitCount: number } | null {
    if (hours.length < 3) return null;

    const bucketCounts: Record<number, number> = {};
    for (const h of hours) {
      const bucket = Math.floor(h / 3); // 0–7
      bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1;
    }

    let peakBucket = -1;
    let peakCount = 0;
    for (const [b, c] of Object.entries(bucketCounts)) {
      if (c > peakCount) {
        peakCount = c;
        peakBucket = Number(b);
      }
    }

    if (peakCount < 3) return null;

    // Centre of the 3-hour bucket (e.g. bucket 2 → hours 6-8 → centre = 7)
    const peakHourUtc = peakBucket * 3 + 1;
    return { peakHourUtc, habitCount: peakCount };
  }

  // Second pass: deduplicate, keeping most-recent instance per food, and
  // attach any detected habit data.
  const seen = new Set<string>();
  const candidates: QuickAddCandidate[] = [];

  for (const row of rows) {
    const protein = roundToSingleDecimal(toNumber(row.proteinG));
    const carbs = roundToSingleDecimal(toNumber(row.carbsG));
    const fat = roundToSingleDecimal(toNumber(row.fatG));
    const cals = toNumber(row.caloriesKcal);
    const key = `${row.label.toLowerCase().trim()}|${protein}|${carbs}|${fat}|${cals}`;

    if (!seen.has(key)) {
      seen.add(key);
      const habit = detectHabit(hourObservations.get(key) ?? []);
      candidates.push({
        label: row.label,
        proteinG: protein,
        carbsG: carbs,
        fatG: fat,
        caloriesKcal: cals,
        source: "recent",
        sourceDate: mostRecentDates.get(key) ?? row.date,
        observedUseDays: dateObservations.get(key)?.size ?? 0,
        ...(habit !== null
          ? { peakHourUtc: habit.peakHourUtc, habitCount: habit.habitCount }
          : {}),
      });
    }

    if (candidates.length >= limit) break;
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

type AdminActor = {
  id: string;
  email: string;
  role: AdminRole;
};

function normalizeAdminRole(role: string): AdminRole {
  if (!isAdminRole(role)) {
    throw new Error("Invalid admin role.");
  }

  return role;
}

function normalizePageNumber(page: number | undefined) {
  return typeof page === "number" && Number.isFinite(page) && page > 0
    ? Math.floor(page)
    : 1;
}

function buildPagination(page: number, pageSize: number, totalItems: number) {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: Math.max(1, Math.ceil(totalItems / pageSize)),
  };
}

function mapAdminBarcodeRow(row: {
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
  addedByEmail?: string | null;
  deletedByUserId: string | null;
  deletedByEmail?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
}): AdminBarcodeRecord {
  return {
    id: row.id,
    barcode: row.barcode,
    name: row.name,
    brands: row.brands,
    proteinG: roundToSingleDecimal(toNumber(row.proteinG)),
    carbsG: roundToSingleDecimal(toNumber(row.carbsG)),
    fatG: roundToSingleDecimal(toNumber(row.fatG)),
    caloriesKcal: Math.round(toNumber(row.caloriesKcal)),
    servingSizeG:
      row.servingSizeG != null
        ? roundToSingleDecimal(toNumber(row.servingSizeG))
        : null,
    addedByUserId: row.addedByUserId,
    addedByEmail: row.addedByEmail ?? null,
    deletedByUserId: row.deletedByUserId,
    deletedByEmail: row.deletedByEmail ?? null,
    createdAt: toTimestampString(row.createdAt),
    updatedAt: toTimestampString(row.updatedAt),
    deletedAt: row.deletedAt ? toTimestampString(row.deletedAt) : null,
    status: row.deletedAt ? "deleted" : "active",
  };
}

function mapAdminAuditEventRow(row: {
  id: string;
  actorUserId: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  detailsJson: Record<string, unknown> | null;
  createdAt: Date | string;
  actorEmail?: string | null;
  actorDisplayName?: string | null;
}): AdminAuditEvent {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    actorEmail: row.actorEmail ?? null,
    actorDisplayName: row.actorDisplayName ?? null,
    actorRole: normalizeAdminRole(row.actorRole),
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    details: row.detailsJson ?? {},
    createdAt: toTimestampString(row.createdAt),
  };
}

async function requireAdminActor(
  actorUserId: string,
  requiredRole: "admin" | "owner",
  db: DatabaseClient,
): Promise<AdminActor> {
  const actor = await getUserById(actorUserId, db);

  if (!actor) {
    throw new Error("Admin actor not found.");
  }

  if (requiredRole === "owner" && !isOwnerRole(actor.role)) {
    throw new Error("Owner access is required.");
  }

  if (requiredRole === "admin" && !canAccessAdmin(actor.role)) {
    throw new Error("Admin access is required.");
  }

  return {
    id: actor.id,
    email: actor.email,
    role: actor.role,
  };
}

async function insertAdminAuditEvent(
  tx: any,
  input: {
    actorUserId: string;
    actorRole: AdminRole;
    action: string;
    targetType: string;
    targetId: string;
    details: Record<string, unknown>;
  },
) {
  await tx.insert(adminAuditEvents).values({
    id: crypto.randomUUID(),
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    detailsJson: input.details,
  });
}

async function applyAdminBarcodeLifecycleChange(
  tx: any,
  input: {
    actor: Pick<AppUser, "id" | "role">;
    existing: FoodProduct;
    barcodeProductId: string;
    updateValues: Record<string, unknown>;
    revisionAction: FoodProductRevisionAction;
    auditAction: string;
  },
) {
  const [updated] = await tx
    .update(foodProducts)
    .set(input.updateValues)
    .where(eq(foodProducts.id, input.barcodeProductId))
    .returning();

  if (!updated) {
    throw new Error("Barcode product not found.");
  }

  const product = mapFoodProductRow(updated);
  await insertFoodProductRevision(tx, {
    product,
    actorUserId: input.actor.id,
    action: input.revisionAction,
  });

  await insertAdminAuditEvent(tx, {
    actorUserId: input.actor.id,
    actorRole: input.actor.role,
    action: input.auditAction,
    targetType: "food_product",
    targetId: input.barcodeProductId,
    details: {
      barcode: input.existing.barcode,
      name: input.existing.name,
    },
  });

  return product;
}

async function getOwnerCount(db: DatabaseClient | any) {
  const [row] = await db
    .select({
      total: count(),
    })
    .from(users)
    .where(eq(users.role, "owner"));

  return toNumber(row?.total);
}

function noMealEntriesCondition() {
  return sql`not exists (select 1 from ${mealEntries} where ${mealEntries.userId} = ${users.id})`;
}

function noWeightEntriesCondition() {
  return sql`not exists (select 1 from ${weightEntries} where ${weightEntries.userId} = ${users.id})`;
}

function heavyBarcodeSubmitterCondition() {
  return sql`(select count(*) from ${foodProducts} where ${foodProducts.submittedByUserId} = ${users.id} and ${foodProducts.source} = 'barcode') >= 5`;
}

function noGoalsCondition() {
  return and(
    isNull(users.goalCaloriesKcal),
    isNull(users.goalProteinG),
    isNull(users.goalCarbsG),
    isNull(users.goalFatG),
    isNull(users.goalWeightKg),
  );
}

function getAdminUserHealthCondition(health?: AdminUserHealthFilter | "all") {
  if (!health || health === "all") {
    return undefined;
  }

  if (health === "onboarded_no_logs") {
    return and(isNotNull(users.onboardingCompletedAt), noMealEntriesCondition());
  }

  if (health === "no_goals") {
    return noGoalsCondition();
  }

  if (health === "no_weight_entries") {
    return noWeightEntriesCondition();
  }

  if (health === "heavy_barcode_submitters") {
    return heavyBarcodeSubmitterCondition();
  }

  return undefined;
}

async function countUsersWhere(db: DatabaseClient | any, whereClause: any) {
  const [row] = await db
    .select({
      total: count(),
    })
    .from(users)
    .where(whereClause);

  return toNumber(row?.total);
}

export async function getAdminUserHealthSummary(
  db?: DatabaseClient,
): Promise<AdminUserHealthSummary> {
  const database = await resolveDb(db);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    onboardedNoLogs,
    noGoals,
    inactive7,
    inactive30,
    noWeightEntries,
    heavyBarcodeSubmitters,
  ] = await Promise.all([
    countUsersWhere(
      database,
      and(isNotNull(users.onboardingCompletedAt), noMealEntriesCondition()),
    ),
    countUsersWhere(database, noGoalsCondition()),
    countUsersWhere(database, lte(users.lastLoginAt, sevenDaysAgo)),
    countUsersWhere(database, lte(users.lastLoginAt, thirtyDaysAgo)),
    countUsersWhere(database, noWeightEntriesCondition()),
    countUsersWhere(database, heavyBarcodeSubmitterCondition()),
  ]);

  return {
    segments: [
      {
        id: "onboarded_no_logs",
        label: "Onboarded but no logs",
        count: onboardedNoLogs,
        href: "/admin/users?health=onboarded_no_logs",
      },
      {
        id: "no_goals",
        label: "No goals set",
        count: noGoals,
        href: "/admin/users?health=no_goals",
      },
      {
        id: "inactive7",
        label: "Inactive 7+ days",
        count: inactive7,
        href: "/admin/users?activity=inactive7",
      },
      {
        id: "inactive30",
        label: "Inactive 30+ days",
        count: inactive30,
        href: "/admin/users?activity=inactive30",
      },
      {
        id: "no_weight_entries",
        label: "No weight entries",
        count: noWeightEntries,
        href: "/admin/users?health=no_weight_entries",
      },
      {
        id: "heavy_barcode_submitters",
        label: "Heavy barcode submitters",
        count: heavyBarcodeSubmitters,
        href: "/admin/users?health=heavy_barcode_submitters",
      },
    ],
  };
}

export async function ensureUserRole(
  userId: string,
  role: AdminRole,
  db?: DatabaseClient,
) {
  const database = await resolveDb(db);
  const normalizedRole = normalizeAdminRole(role);

  const [updated] = await database
    .update(users)
    .set({
      role: normalizedRole,
    })
    .where(eq(users.id, userId))
    .returning();

  return updated ? mapUserRow(updated as UserSelectRow) : null;
}

export async function getAdminDashboardData(
  db?: DatabaseClient,
): Promise<AdminDashboardData> {
  const database = await resolveDb(db);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalUsersRow,
    ownerCountRow,
    adminCountRow,
    newUsersRow,
    activeUsersRow,
    activeBarcodesRow,
    deletedBarcodesRow,
    recentBarcodeRows,
    recentAuditPage,
    health,
  ] = await Promise.all([
    database.select({ total: count() }).from(users),
    database.select({ total: count() }).from(users).where(eq(users.role, "owner")),
    database.select({ total: count() }).from(users).where(eq(users.role, "admin")),
    database.select({ total: count() }).from(users).where(gte(users.createdAt, sevenDaysAgo)),
    database.select({ total: count() }).from(users).where(gte(users.lastLoginAt, sevenDaysAgo)),
    database.select({ total: count() }).from(foodProducts).where(
      and(
        isNull(foodProducts.ownerUserId),
        eq(foodProducts.source, "barcode"),
        isNull(foodProducts.deletedAt),
      ),
    ),
    database.select({ total: count() }).from(foodProducts).where(
      and(
        isNull(foodProducts.ownerUserId),
        eq(foodProducts.source, "barcode"),
        isNotNull(foodProducts.deletedAt),
      ),
    ),
    database
      .select()
      .from(foodProducts)
      .where(
        and(
          isNull(foodProducts.ownerUserId),
          eq(foodProducts.source, "barcode"),
        ),
      )
      .orderBy(desc(foodProducts.createdAt))
      .limit(6),
    listAdminAuditEvents(
      {
        page: 1,
        pageSize: 6,
      },
      database,
    ),
    getAdminUserHealthSummary(database),
  ]);

  return {
    totalUsers: toNumber(totalUsersRow[0]?.total),
    ownerCount: toNumber(ownerCountRow[0]?.total),
    adminCount: toNumber(adminCountRow[0]?.total),
    newUsersLast7Days: toNumber(newUsersRow[0]?.total),
    activeUsersLast7Days: toNumber(activeUsersRow[0]?.total),
    activeBarcodeCount: toNumber(activeBarcodesRow[0]?.total),
    deletedBarcodeCount: toNumber(deletedBarcodesRow[0]?.total),
    recentBarcodeAdditions: recentBarcodeRows.map(mapFoodProductRow),
    recentAuditEvents: recentAuditPage.items,
    health,
  };
}

export async function listAdminUsers(
  input: {
    q?: string;
    role?: AdminRole | "all";
    activity?: "all" | "active7" | "inactive7" | "inactive30";
    health?: AdminUserHealthFilter | "all";
    page?: number;
    pageSize?: number;
  } = {},
  db?: DatabaseClient,
): Promise<AdminUserListPage> {
  const database = await resolveDb(db);
  const page = normalizePageNumber(input.page);
  const pageSize = input.pageSize ?? 25;
  const offset = (page - 1) * pageSize;
  const conditions = [];
  const query = input.q?.trim();
  const activeSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const inactiveSince30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  if (query) {
    const pattern = `%${escapeLikePattern(query)}%`;
    conditions.push(
      or(ilike(users.email, pattern), ilike(users.displayName, pattern)),
    );
  }

  if (input.role && input.role !== "all") {
    conditions.push(eq(users.role, normalizeAdminRole(input.role)));
  }

  if (input.activity === "active7") {
    conditions.push(gte(users.lastLoginAt, activeSince));
  } else if (input.activity === "inactive7") {
    conditions.push(lte(users.lastLoginAt, activeSince));
  } else if (input.activity === "inactive30") {
    conditions.push(lte(users.lastLoginAt, inactiveSince30));
  }

  const healthCondition = getAdminUserHealthCondition(input.health);
  if (healthCondition) {
    conditions.push(healthCondition);
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const [countRows, rows] = await Promise.all([
    database
      .select({
        total: count(),
      })
      .from(users)
      .where(whereClause),
    database
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        pictureUrl: users.pictureUrl,
        role: users.role,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(whereClause)
      .orderBy(desc(users.lastLoginAt), asc(users.email))
      .limit(pageSize)
      .offset(offset),
  ]);

  const items: AdminUserListItem[] = rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    pictureUrl: row.pictureUrl,
    role: normalizeAdminRole(row.role),
    createdAt: toTimestampString(row.createdAt),
    lastLoginAt: toTimestampString(row.lastLoginAt),
  }));

  return {
    items,
    pagination: buildPagination(page, pageSize, toNumber(countRows[0]?.total)),
  };
}

export async function getAdminUserDetail(
  userId: string,
  db?: DatabaseClient,
): Promise<AdminUserDetail | null> {
  const database = await resolveDb(db);
  const user = await getUserById(userId, database);

  if (!user) {
    return null;
  }

  const [
    mealCountRows,
    weightCountRows,
    recipeCountRows,
    templateCountRows,
    barcodeCountRows,
    recentMeals,
    recentWeights,
    recentRecipes,
    recentTemplates,
    recentBarcodeRows,
  ] = await Promise.all([
    database.select({ total: count() }).from(mealEntries).where(eq(mealEntries.userId, userId)),
    database.select({ total: count() }).from(weightEntries).where(eq(weightEntries.userId, userId)),
    database.select({ total: count() }).from(recipes).where(eq(recipes.userId, userId)),
    database.select({ total: count() }).from(mealTemplates).where(
      and(eq(mealTemplates.userId, userId), isNull(mealTemplates.deletedAt)),
    ),
    database
      .select({ total: count() })
      .from(foodProducts)
      .where(
        and(
          eq(foodProducts.submittedByUserId, userId),
          eq(foodProducts.source, "barcode"),
        ),
      ),
    database
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
      .orderBy(desc(mealEntries.entryDate), asc(mealEntries.sortOrder))
      .limit(10),
    database
      .select({
        id: weightEntries.id,
        userId: weightEntries.userId,
        date: weightEntries.entryDate,
        weightKg: weightEntries.weightKg,
        bodyFatPct: weightEntries.bodyFatPct,
        notes: weightEntries.notes,
      })
      .from(weightEntries)
      .where(eq(weightEntries.userId, userId))
      .orderBy(desc(weightEntries.entryDate))
      .limit(10),
    database
      .select({
        id: recipes.id,
        label: recipes.label,
        portions: recipes.portions,
        updatedAt: recipes.updatedAt,
      })
      .from(recipes)
      .where(eq(recipes.userId, userId))
      .orderBy(desc(recipes.updatedAt))
      .limit(10),
    database
      .select({
        id: mealTemplates.id,
        userId: mealTemplates.userId,
        type: mealTemplates.type,
        label: mealTemplates.label,
        notes: mealTemplates.notes,
        createdAt: mealTemplates.createdAt,
        updatedAt: mealTemplates.updatedAt,
      })
      .from(mealTemplates)
      .where(and(eq(mealTemplates.userId, userId), isNull(mealTemplates.deletedAt)))
      .orderBy(desc(mealTemplates.updatedAt), asc(mealTemplates.label))
      .limit(10),
    database
      .select()
      .from(foodProducts)
      .where(
        and(
          eq(foodProducts.submittedByUserId, userId),
          eq(foodProducts.source, "barcode"),
        ),
      )
      .orderBy(desc(foodProducts.createdAt))
      .limit(10),
  ]);

  const recentTemplateItemRows =
    recentTemplates.length === 0
      ? []
      : await database
          .select({
            id: mealTemplateItems.id,
            templateId: mealTemplateItems.templateId,
            productId: mealTemplateItems.productId,
            mealGroupLabel: mealTemplateItems.mealGroupLabel,
            sortOrder: mealTemplateItems.sortOrder,
            label: mealTemplateItems.label,
            quantity: mealTemplateItems.quantity,
            unit: mealTemplateItems.unit,
            servingMultiplier: mealTemplateItems.servingMultiplier,
            proteinG: mealTemplateItems.proteinG,
            carbsG: mealTemplateItems.carbsG,
            fatG: mealTemplateItems.fatG,
            caloriesKcal: mealTemplateItems.caloriesKcal,
          })
          .from(mealTemplateItems)
          .where(
            inArray(
              mealTemplateItems.templateId,
              recentTemplates.map((row) => row.id),
            ),
          )
          .orderBy(asc(mealTemplateItems.sortOrder));

  const recentTemplateItemsByTemplate = new Map<string, MealTemplateItem[]>();
  for (const item of recentTemplateItemRows.map(mapMealTemplateItemRow)) {
    const items = recentTemplateItemsByTemplate.get(item.templateId) ?? [];
    items.push(item);
    recentTemplateItemsByTemplate.set(item.templateId, items);
  }

  return {
    user,
    goals: {
      caloriesKcal: user.goalCaloriesKcal,
      proteinG: user.goalProteinG,
      carbsG: user.goalCarbsG,
      fatG: user.goalFatG,
    },
    counts: {
      mealEntries: toNumber(mealCountRows[0]?.total),
      weightEntries: toNumber(weightCountRows[0]?.total),
      recipes: toNumber(recipeCountRows[0]?.total),
      templates: toNumber(templateCountRows[0]?.total),
      barcodeSubmissions: toNumber(barcodeCountRows[0]?.total),
    },
    recentMeals: recentMeals.map((row) => mapMealRow(row)),
    recentWeights: recentWeights.map((row) => ({
      id: row.id,
      userId: row.userId,
      date: row.date,
      weightKg: Math.round(toNumber(row.weightKg) * 100) / 100,
      bodyFatPct:
        row.bodyFatPct != null ? roundToSingleDecimal(toNumber(row.bodyFatPct)) : null,
      notes: row.notes,
    })),
    recentRecipes: recentRecipes.map(
      (row): AdminRecipeSummary => ({
        id: row.id,
        label: row.label,
        portions: row.portions,
        updatedAt: toTimestampString(row.updatedAt),
      }),
    ),
    recentTemplates: recentTemplates.map((row) =>
      mapMealTemplateRow(row, recentTemplateItemsByTemplate.get(row.id) ?? []),
    ),
    recentBarcodeSubmissions: recentBarcodeRows.map(mapFoodProductRow),
  };
}

export async function setUserRole(
  actorUserId: string,
  targetUserId: string,
  nextRole: AdminRole,
  db?: DatabaseClient,
) {
  const database = await resolveDb(db);
  const normalizedRole = normalizeAdminRole(nextRole);

  return (database as any).transaction(async (tx: any) => {
    const actor = await requireAdminActor(actorUserId, "owner", tx);
    const target = await getUserById(targetUserId, tx);

    if (!target) {
      throw new Error("User not found.");
    }

    if (target.role === normalizedRole) {
      return target;
    }

    if (target.role === "owner" && normalizedRole !== "owner") {
      const ownerCount = await getOwnerCount(tx);
      if (ownerCount <= 1) {
        throw new Error("You cannot demote the last owner.");
      }
    }

    const [updated] = await tx
      .update(users)
      .set({
        role: normalizedRole,
      })
      .where(eq(users.id, targetUserId))
      .returning();

    if (!updated) {
      throw new Error("User not found.");
    }

    await insertAdminAuditEvent(tx, {
      actorUserId: actor.id,
      actorRole: actor.role,
      action: "user.role_changed",
      targetType: "user",
      targetId: targetUserId,
      details: {
        fromRole: target.role,
        toRole: normalizedRole,
        targetEmail: target.email,
      },
    });

    return mapUserRow(updated as UserSelectRow);
  });
}

export async function listAdminBarcodeProducts(
  input: {
    q?: string;
    status?: "all" | "active" | "deleted";
    submitter?: string;
    page?: number;
    pageSize?: number;
  } = {},
  db?: DatabaseClient,
): Promise<AdminBarcodeListPage> {
  const database = await resolveDb(db);
  const page = normalizePageNumber(input.page);
  const pageSize = input.pageSize ?? 25;
  const offset = (page - 1) * pageSize;
  const conditions = [
    isNull(foodProducts.ownerUserId),
    eq(foodProducts.source, "barcode"),
  ];

  if (input.q?.trim()) {
    const pattern = `%${escapeLikePattern(input.q.trim())}%`;
    const searchCondition = or(
      ilike(foodProducts.barcode, pattern),
      ilike(foodProducts.name, pattern),
      ilike(foodProducts.brand, pattern),
    );
    if (searchCondition) {
      conditions.push(searchCondition);
    }
  }

  if (input.status === "active") {
    conditions.push(isNull(foodProducts.deletedAt));
  } else if (input.status === "deleted") {
    conditions.push(isNotNull(foodProducts.deletedAt));
  }

  if (input.submitter?.trim()) {
    const submitterPattern = `%${escapeLikePattern(input.submitter.trim())}%`;
    conditions.push(ilike(users.email, submitterPattern));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const [countRows, rows] = await Promise.all([
    database
      .select({
        total: count(),
      })
      .from(foodProducts)
      .leftJoin(users, eq(users.id, foodProducts.submittedByUserId))
      .where(whereClause),
    database
      .select(foodProductSelectColumns)
      .from(foodProducts)
      .leftJoin(users, eq(users.id, foodProducts.submittedByUserId))
      .where(whereClause)
      .orderBy(desc(foodProducts.createdAt))
      .limit(pageSize)
      .offset(offset),
  ]);

  return {
    items: rows.map(mapFoodProductRow),
    pagination: buildPagination(page, pageSize, toNumber(countRows[0]?.total)),
  };
}

type AdminBarcodeReviewQueueRow = {
  id: string;
  owner_user_id: string | null;
  scope: string;
  source: string;
  barcode: string | null;
  name: string;
  brand: string;
  default_serving_quantity: string | number;
  default_serving_unit: string;
  protein_per_100: string | number;
  carbs_per_100: string | number;
  fat_per_100: string | number;
  calories_per_100: number;
  serving_weight_g: string | number | null;
  serving_volume_ml: string | number | null;
  submitted_by_user_id: string | null;
  deleted_by_user_id: string | null;
  source_provider: string | null;
  source_confidence: string | number | null;
  source_metadata: unknown;
  corrected_from_product_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
  revision_count_30_days: string | number;
  duplicate_name_count: string | number;
  latest_audit_action: string | null;
  latest_audit_at: Date | string | null;
  recently_deleted: boolean;
  recently_restored: boolean;
};

function rawRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { rows?: unknown[] }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function mapAdminBarcodeReviewQueueRow(
  row: AdminBarcodeReviewQueueRow,
): AdminBarcodeReviewQueueItem {
  const product = mapFoodProductRow({
    id: row.id,
    ownerUserId: row.owner_user_id,
    scope: row.scope,
    source: row.source,
    barcode: row.barcode,
    name: row.name,
    brand: row.brand,
    defaultServingQuantity: row.default_serving_quantity,
    defaultServingUnit: row.default_serving_unit,
    proteinPer100: row.protein_per_100,
    carbsPer100: row.carbs_per_100,
    fatPer100: row.fat_per_100,
    caloriesPer100: row.calories_per_100,
    servingWeightG: row.serving_weight_g,
    servingVolumeMl: row.serving_volume_ml,
    submittedByUserId: row.submitted_by_user_id,
    deletedByUserId: row.deleted_by_user_id,
    sourceProvider: row.source_provider,
    sourceConfidence: row.source_confidence,
    sourceMetadata: row.source_metadata,
    correctedFromProductId: row.corrected_from_product_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  });
  const revisionCount30Days = toNumber(row.revision_count_30_days);
  const duplicateNameCount = toNumber(row.duplicate_name_count);
  const reviewReasons: AdminBarcodeReviewQueueItem["reviewReasons"] = [];

  if (product.sourceConfidence != null && product.sourceConfidence < 0.75) {
    reviewReasons.push("low_confidence");
  }
  if (product.servingWeightG == null && product.servingVolumeMl == null) {
    reviewReasons.push("missing_serving_size");
  }
  if (row.recently_deleted) {
    reviewReasons.push("recently_deleted");
  }
  if (row.recently_restored) {
    reviewReasons.push("recently_restored");
  }
  if (duplicateNameCount > 1) {
    reviewReasons.push("duplicate_name");
  }
  if (revisionCount30Days >= 3) {
    reviewReasons.push("frequent_revisions");
  }

  return {
    ...product,
    reviewReasons,
    revisionCount30Days,
    duplicateNameCount,
    latestAuditAction: row.latest_audit_action,
    latestAuditAt: row.latest_audit_at
      ? toTimestampString(row.latest_audit_at)
      : null,
  };
}

export async function listAdminBarcodeReviewQueue(
  input: {
    page?: number;
    pageSize?: number;
  } = {},
  db?: DatabaseClient,
): Promise<AdminBarcodeReviewQueuePage> {
  const database = await resolveDb(db);
  const page = normalizePageNumber(input.page);
  const pageSize = input.pageSize ?? 25;
  const offset = (page - 1) * pageSize;
  const reviewCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const candidateCtes = sql`
    with barcode_products as (
      select
        *,
        nullif(regexp_replace(lower(trim(name)), '\\s+', ' ', 'g'), '') as review_name
      from food_products
      where owner_user_id is null and source = 'barcode'
    ),
    duplicate_names as (
      select review_name, count(*) as duplicate_name_count
      from barcode_products
      where review_name is not null
      group by review_name
    ),
    revision_counts as (
      select product_id, count(*) as revision_count_30_days
      from food_product_revisions
      where created_at >= ${reviewCutoff}
      group by product_id
    ),
    latest_audit as (
      select distinct on (target_id) target_id, action, created_at
      from admin_audit_events
      where target_type = 'food_product' and created_at >= ${reviewCutoff}
      order by target_id, created_at desc
    ),
    recently_restored as (
      select target_id
      from admin_audit_events
      where
        target_type = 'food_product'
        and action = 'barcode.restored'
        and created_at >= ${reviewCutoff}
      group by target_id
    ),
    review_candidates as (
      select
        bp.*,
        coalesce(rc.revision_count_30_days, 0) as revision_count_30_days,
        coalesce(dn.duplicate_name_count, 0) as duplicate_name_count,
        la.action as latest_audit_action,
        la.created_at as latest_audit_at,
        bp.deleted_at is not null and bp.deleted_at >= ${reviewCutoff} as recently_deleted,
        rr.target_id is not null as recently_restored
      from barcode_products bp
      left join duplicate_names dn on dn.review_name = bp.review_name
      left join revision_counts rc on rc.product_id = bp.id
      left join latest_audit la on la.target_id = bp.id::text
      left join recently_restored rr on rr.target_id = bp.id::text
      where
        (bp.source_confidence is not null and bp.source_confidence < 0.75)
        or (bp.serving_weight_g is null and bp.serving_volume_ml is null)
        or (bp.deleted_at is not null and bp.deleted_at >= ${reviewCutoff})
        or rr.target_id is not null
        or coalesce(dn.duplicate_name_count, 0) > 1
        or coalesce(rc.revision_count_30_days, 0) >= 3
    )`;

  const [countResult, pageResult] = await Promise.all([
    database.execute(sql`${candidateCtes}
      select count(*) as total_count from review_candidates`),
    database.execute(sql<AdminBarcodeReviewQueueRow>`${candidateCtes}
      select *
      from review_candidates
      order by updated_at desc
      limit ${pageSize}
      offset ${offset}`),
  ]);
  const totalCount = toNumber(
    rawRows<{ total_count: string | number }>(countResult)[0]?.total_count,
  );
  const queueItems = rawRows<AdminBarcodeReviewQueueRow>(pageResult).map(
    mapAdminBarcodeReviewQueueRow,
  );

  return {
    items: queueItems,
    pagination: buildPagination(page, pageSize, totalCount),
  };
}

export async function getAdminBarcodeProductById(
  barcodeProductId: string,
  db?: DatabaseClient,
): Promise<FoodProduct | null> {
  const database = await resolveDb(db);
  const [row] = await database
    .select(foodProductSelectColumns)
    .from(foodProducts)
    .where(
      and(
        eq(foodProducts.id, barcodeProductId),
        isNull(foodProducts.ownerUserId),
        eq(foodProducts.source, "barcode"),
      ),
    )
    .limit(1);

  return row ? mapFoodProductRow(row) : null;
}

export async function createAdminBarcodeProduct(
  actorUserId: string,
  input: BarcodeFoodProductInput,
  db?: DatabaseClient,
) {
  const database = await resolveDb(db);

  return (database as any).transaction(async (tx: any) => {
    const actor = await requireAdminActor(actorUserId, "admin", tx);
    const product = await insertBarcodeFoodProduct(tx, actor.id, input);

    await insertAdminAuditEvent(tx, {
      actorUserId: actor.id,
      actorRole: actor.role,
      action: "barcode.created",
      targetType: "food_product",
      targetId: product.id,
      details: {
        barcode: product.barcode,
        name: product.name,
      },
    });

    return product;
  });
}

export async function updateAdminBarcodeProduct(
  actorUserId: string,
  barcodeProductId: string,
  input: BarcodeFoodProductInput,
  db?: DatabaseClient,
) {
  const database = await resolveDb(db);

  return (database as any).transaction(async (tx: any) => {
    const actor = await requireAdminActor(actorUserId, "admin", tx);
    const before = await getAdminBarcodeProductById(barcodeProductId, tx);

    if (!before) {
      throw new Error("Barcode product not found.");
    }

    const normalized = validateFoodProductInput({
      ...normalizeBarcodeFoodInput(input),
      submittedByUserId: before.submittedByUserId ?? actor.id,
    });
    const duplicate = await findGlobalBarcodeFoodProduct(
      normalized.barcode ?? "",
      tx,
      before.id,
    );
    if (duplicate) {
      throw new Error("That barcode already exists.");
    }

    const [updated] = await tx
      .update(foodProducts)
      .set(
        buildFoodProductInputValues(normalized, {
          servingWeightFallback: "100.00",
          forceNullServingVolume: true,
          sourceProviderFallback: "community",
        }),
      )
      .where(eq(foodProducts.id, barcodeProductId))
      .returning();

    if (!updated) {
      throw new Error("Barcode product not found.");
    }

    const product = mapFoodProductRow(updated);
    await insertFoodProductRevision(tx, {
      product,
      actorUserId: actor.id,
      action: "updated",
    });

    await insertAdminAuditEvent(tx, {
      actorUserId: actor.id,
      actorRole: actor.role,
      action: "barcode.updated",
      targetType: "food_product",
      targetId: barcodeProductId,
      details: {
        before,
        after: {
          barcode: product.barcode,
          name: product.name,
          brand: product.brand,
          caloriesKcal: product.caloriesPer100,
        },
      },
    });

    return product;
  });
}

export async function softDeleteAdminBarcodeProduct(
  actorUserId: string,
  barcodeProductId: string,
  db?: DatabaseClient,
) {
  const database = await resolveDb(db);

  return (database as any).transaction(async (tx: any) => {
    const actor = await requireAdminActor(actorUserId, "admin", tx);
    const existing = await getAdminBarcodeProductById(barcodeProductId, tx);

    if (!existing) {
      throw new Error("Barcode product not found.");
    }

    if (existing.deletedAt) {
      return existing;
    }

    const deletedAt = new Date();
    return applyAdminBarcodeLifecycleChange(tx, {
      actor,
      existing,
      barcodeProductId,
      updateValues: {
        deletedAt,
        deletedByUserId: actor.id,
        updatedAt: deletedAt,
      },
      revisionAction: "deleted",
      auditAction: "barcode.deleted",
    });
  });
}

export async function restoreAdminBarcodeProduct(
  actorUserId: string,
  barcodeProductId: string,
  db?: DatabaseClient,
) {
  const database = await resolveDb(db);

  return (database as any).transaction(async (tx: any) => {
    const actor = await requireAdminActor(actorUserId, "admin", tx);
    const existing = await getAdminBarcodeProductById(barcodeProductId, tx);

    if (!existing) {
      throw new Error("Barcode product not found.");
    }

    if (!existing.deletedAt) {
      return existing;
    }

    if (existing.barcode) {
      const duplicate = await findGlobalBarcodeFoodProduct(existing.barcode, tx);
      if (duplicate && duplicate.id !== existing.id) {
        throw new Error("That barcode already exists.");
      }
    }

    return applyAdminBarcodeLifecycleChange(tx, {
      actor,
      existing,
      barcodeProductId,
      updateValues: {
        deletedAt: null,
        deletedByUserId: null,
        updatedAt: new Date(),
      },
      revisionAction: "restored",
      auditAction: "barcode.restored",
    });
  });
}

export async function listAdminAuditEvents(
  input: {
    page?: number;
    pageSize?: number;
    targetType?: string;
    targetId?: string;
  } = {},
  db?: DatabaseClient,
): Promise<AdminAuditListPage> {
  const database = await resolveDb(db);
  const page = normalizePageNumber(input.page);
  const pageSize = input.pageSize ?? 25;
  const offset = (page - 1) * pageSize;
  const conditions = [];

  if (input.targetType) {
    conditions.push(eq(adminAuditEvents.targetType, input.targetType));
  }

  if (input.targetId) {
    conditions.push(eq(adminAuditEvents.targetId, input.targetId));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const [countRows, rows] = await Promise.all([
    database
      .select({
        total: count(),
      })
      .from(adminAuditEvents)
      .where(whereClause),
    database
      .select({
        id: adminAuditEvents.id,
        actorUserId: adminAuditEvents.actorUserId,
        actorRole: adminAuditEvents.actorRole,
        action: adminAuditEvents.action,
        targetType: adminAuditEvents.targetType,
        targetId: adminAuditEvents.targetId,
        detailsJson: adminAuditEvents.detailsJson,
        createdAt: adminAuditEvents.createdAt,
        actorEmail: users.email,
        actorDisplayName: users.displayName,
      })
      .from(adminAuditEvents)
      .leftJoin(users, eq(users.id, adminAuditEvents.actorUserId))
      .where(whereClause)
      .orderBy(desc(adminAuditEvents.createdAt))
      .limit(pageSize)
      .offset(offset),
  ]);

  return {
    items: rows.map((row) =>
      mapAdminAuditEventRow({
        ...row,
        detailsJson: row.detailsJson as Record<string, unknown> | null,
      }),
    ),
    pagination: buildPagination(page, pageSize, toNumber(countRows[0]?.total)),
  };
}

export async function getAdminAuditEventById(
  eventId: string,
  db?: DatabaseClient,
): Promise<AdminAuditEventDetail | null> {
  const database = await resolveDb(db);
  const [row] = await database
    .select({
      id: adminAuditEvents.id,
      actorUserId: adminAuditEvents.actorUserId,
      actorRole: adminAuditEvents.actorRole,
      action: adminAuditEvents.action,
      targetType: adminAuditEvents.targetType,
      targetId: adminAuditEvents.targetId,
      detailsJson: adminAuditEvents.detailsJson,
      createdAt: adminAuditEvents.createdAt,
      actorEmail: users.email,
      actorDisplayName: users.displayName,
    })
    .from(adminAuditEvents)
    .leftJoin(users, eq(users.id, adminAuditEvents.actorUserId))
    .where(eq(adminAuditEvents.id, eventId))
    .limit(1);

  return row
    ? mapAdminAuditEventRow({
        ...row,
        detailsJson: row.detailsJson as Record<string, unknown> | null,
      })
    : null;
}
