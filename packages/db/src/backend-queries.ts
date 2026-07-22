import { backendRpc } from "./backend-client";
import { API_SCOPE_VALUES, type ApiScope } from "./types";
import type {
  AdminAuditEventDetail,
  AdminAuditListPage,
  AdminBarcodeListPage,
  AdminBarcodeReviewQueuePage,
  AdminDashboardData,
  AdminRole,
  AdminUserDetail,
  AdminUserHealthSummary,
  AdminUserListPage,
  ApiTokenAuthResult,
  ApiTokenRecord,
  AppUser,
  BarcodeFoodProductInput,
  CompleteOnboardingInput,
  CreatedApiToken,
  DailyOverview,
  DailySummary,
  FoodProduct,
  FoodProductInput,
  MacroGoals,
  MealEntryInput,
  MealEntryRecord,
  MealEntryStatus,
  MealGroup,
  MealTemplate,
  MealTemplateInput,
  PeriodAverage,
  QuickAddCandidate,
  RecipeInput,
  RecipeRecord,
  ShooProfile,
  StatsPageData,
  WeightEntryInput,
  WeightEntryRecord,
  WeightPageData,
} from "./types";

export type LeaderboardStats = {
  bestCalorieDay: StatsPageData["bestCalorieDay"];
  currentStreak: number;
  longestStreak: number;
  topLabels: StatsPageData["topLabels"];
};

export type DatabaseClient = any;
export type DatabaseRuntime = {
  db: DatabaseClient;
  close: () => Promise<void>;
};

type BackendTestFault = {
  kind: string;
  failOnCall?: number;
  message: string;
};

function backendTestFault(args: unknown[]): BackendTestFault | undefined {
  for (const arg of args) {
    if (!arg || typeof arg !== "object") {
      continue;
    }
    const fault = (arg as { __backendTestFault?: BackendTestFault }).__backendTestFault;
    if (fault) {
      return fault;
    }
  }
  return undefined;
}

export function getApiScopes(): ApiScope[] {
  return [...API_SCOPE_VALUES];
}

export async function upsertUserFromShooProfile(profile: ShooProfile, ..._ignored: unknown[]) {
  return backendRpc<AppUser>("upsertUserFromShooProfile", { profile });
}

export async function getUserById(userId: string, ..._ignored: unknown[]) {
  return backendRpc<AppUser | null>("getUserById", { userId });
}

export async function ensureUserRole(userId: string, role: AdminRole, ..._ignored: unknown[]) {
  return backendRpc<AppUser>("ensureUserRole", { userId, role });
}

export async function createApiToken(
  userId: string,
  input: { name: string; scopes: readonly string[]; expiresAt?: Date | string | null },
  ..._ignored: unknown[]
): Promise<CreatedApiToken> {
  return backendRpc("createApiToken", {
    userId,
    input: {
      ...input,
      expiresAt: input.expiresAt instanceof Date ? input.expiresAt.toISOString() : input.expiresAt,
    },
  });
}

export async function listApiTokens(userId: string, ..._ignored: unknown[]): Promise<ApiTokenRecord[]> {
  return backendRpc("listApiTokens", { userId });
}

export async function revokeApiToken(userId: string, tokenId: string, ..._ignored: unknown[]) {
  return backendRpc<boolean>("revokeApiToken", { userId, tokenId });
}

export async function authenticateApiToken(token: string | null, ..._ignored: unknown[]): Promise<ApiTokenAuthResult> {
  return backendRpc("authenticateApiToken", { token });
}

export async function getMealGroups(userId: string, ..._ignored: unknown[]): Promise<MealGroup[]> {
  return backendRpc("getMealGroups", { userId });
}

export async function createMealGroup(userId: string, input: { label: string }, ..._ignored: unknown[]) {
  return backendRpc<MealGroup>("createMealGroup", { userId, input });
}

export async function updateMealGroup(
  userId: string,
  groupId: string,
  input: { label: string },
  ..._ignored: unknown[]
) {
  return backendRpc<MealGroup>("updateMealGroup", { userId, groupId, input });
}

export async function deleteMealGroup(userId: string, groupId: string, ..._ignored: unknown[]) {
  return backendRpc<boolean>("deleteMealGroup", {
    userId,
    groupId,
    testFault: backendTestFault(_ignored),
  });
}

export async function reorderMealGroups(userId: string, orderedIds: string[], ..._ignored: unknown[]) {
  return backendRpc<MealGroup[]>("reorderMealGroups", { userId, orderedIds });
}

export async function getDailySummary(
  userId: string,
  date: string,
  ..._ignored: unknown[]
): Promise<DailySummary> {
  return backendRpc("getDailySummary", { userId, date });
}

export async function getDashboardData(userId: string, selectedDate: string, ..._ignored: unknown[]) {
  return backendRpc<{ dailySummary: DailySummary; periodAverages: PeriodAverage[] }>(
    "getDashboardData",
    { userId, selectedDate },
  );
}

export async function createMealEntry(
  userId: string,
  input: Omit<MealEntryInput, "sortOrder"> & { sortOrder?: number },
  ..._ignored: unknown[]
) {
  return backendRpc<MealEntryRecord>("createMealEntry", { userId, input });
}

export async function getMealEntryById(userId: string, entryId: string, ..._ignored: unknown[]) {
  return backendRpc<MealEntryRecord | null>("getMealEntryById", { userId, entryId });
}

export async function updateMealEntry(
  userId: string,
  entryId: string,
  input: MealEntryInput,
  ..._ignored: unknown[]
) {
  return backendRpc<MealEntryRecord>("updateMealEntry", { userId, entryId, input });
}

export async function deleteMealEntry(userId: string, entryId: string, ..._ignored: unknown[]) {
  return backendRpc<boolean>("deleteMealEntry", { userId, entryId });
}

export async function markMealEntryStatus(
  userId: string,
  entryId: string,
  status: MealEntryStatus,
  ..._ignored: unknown[]
) {
  return backendRpc<MealEntryRecord>("markMealEntryStatus", { userId, entryId, status });
}

export async function getUserGoals(userId: string, ..._ignored: unknown[]): Promise<MacroGoals> {
  return backendRpc("getUserGoals", { userId });
}

export async function saveUserGoals(userId: string, goals: MacroGoals, ..._ignored: unknown[]) {
  return backendRpc<void>("saveUserGoals", { userId, goals });
}

export async function completeOnboardingSetup(
  userId: string,
  input: CompleteOnboardingInput & Record<string, unknown>,
  ..._ignored: unknown[]
) {
  return backendRpc<AppUser>("completeOnboardingSetup", { userId, input });
}

export async function completeUserOnboarding(
  userId: string,
  input: CompleteOnboardingInput,
  ..._ignored: unknown[]
) {
  return backendRpc<AppUser>("completeUserOnboarding", { userId, input });
}

export async function ensureDefaultMealGroups(userId: string, ..._ignored: unknown[]) {
  return backendRpc<void>("ensureDefaultMealGroups", { userId });
}

export async function setUserOnboardingForTesting(
  userId: string,
  onboarded: boolean,
  ..._ignored: unknown[]
) {
  return backendRpc<AppUser>("setUserOnboardingForTesting", { userId, onboarded });
}

export async function listRecentMealEntries(userId: string, limit = 200, ..._ignored: unknown[]) {
  return backendRpc<MealEntryRecord[]>("listRecentMealEntries", { userId, limit });
}

export async function searchMealEntries(userId: string, query: string, ..._ignored: unknown[]) {
  return backendRpc<MealEntryRecord[]>("searchMealEntries", { userId, query });
}

export async function searchFoodProducts(userId: string, query: string, ..._ignored: unknown[]) {
  return backendRpc<FoodProduct[]>("searchFoodProducts", { userId, query });
}

export async function createPersonalFoodProduct(
  userId: string,
  input: FoodProductInput,
  ..._ignored: unknown[]
) {
  return backendRpc<FoodProduct>("createPersonalFoodProduct", { userId, input });
}

export async function updatePersonalFoodProduct(
  userId: string,
  productId: string,
  input: FoodProductInput,
  ..._ignored: unknown[]
) {
  return backendRpc<FoodProduct>("updatePersonalFoodProduct", { userId, productId, input });
}

export async function getFoodProductByIdForUser(userId: string, productId: string, ..._ignored: unknown[]) {
  return backendRpc<FoodProduct | null>("getFoodProductByIdForUser", { userId, productId });
}

export function resolveProductNutritionForQuantity(
  product: FoodProduct,
  quantity: number,
  unit: string,
  servingMultiplier = 1,
) {
  const safeQuantity = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  const safeMultiplier =
    Number.isFinite(servingMultiplier) && servingMultiplier > 0 ? servingMultiplier : 1;
  const factor =
    unit === "g" || unit === "ml"
      ? safeQuantity / 100
      : (safeQuantity * safeMultiplier * (product.servingWeightG ?? product.servingVolumeMl ?? 100)) /
        100;

  return {
    proteinG: Math.round(product.proteinPer100 * factor * 10) / 10,
    carbsG: Math.round(product.carbsPer100 * factor * 10) / 10,
    fatG: Math.round(product.fatPer100 * factor * 10) / 10,
    caloriesKcal: Math.round(product.caloriesPer100 * factor),
  };
}

export async function getPeriodAverages(userId: string, selectedDate: string, ..._ignored: unknown[]) {
  return backendRpc<PeriodAverage[]>("getPeriodAverages", { userId, selectedDate });
}

export async function getRecentDailyOverviews(
  userId: string,
  dateOrDays: string | number = 7,
  daysOrDb?: number | unknown,
  ..._ignored: unknown[]
): Promise<DailyOverview[]> {
  const selectedDate = typeof dateOrDays === "string" ? dateOrDays : undefined;
  const days =
    typeof dateOrDays === "number"
      ? dateOrDays
      : typeof daysOrDb === "number"
        ? daysOrDb
        : 7;
  return backendRpc("getRecentDailyOverviews", { userId, selectedDate, days });
}

export async function getTemplates(userId: string, ..._ignored: unknown[]) {
  return backendRpc<MealTemplate[]>("getTemplates", { userId });
}

export async function getTemplateById(userId: string, templateId: string, ..._ignored: unknown[]) {
  return backendRpc<MealTemplate | null>("getTemplateById", { userId, templateId });
}

export async function createTemplate(userId: string, input: MealTemplateInput, ..._ignored: unknown[]) {
  return backendRpc<MealTemplate>("createTemplate", { userId, input });
}

export async function updateTemplate(
  userId: string,
  templateId: string,
  input: MealTemplateInput,
  ..._ignored: unknown[]
) {
  return backendRpc<MealTemplate>("updateTemplate", { userId, templateId, input });
}

export async function deleteTemplate(userId: string, templateId: string, ..._ignored: unknown[]) {
  return backendRpc<boolean>("deleteTemplate", { userId, templateId });
}

export async function applyTemplateToDate(
  userId: string,
  input: { templateId: string; date: string; status?: MealEntryStatus },
  ..._ignored: unknown[]
) {
  return backendRpc<MealEntryRecord[]>("applyTemplateToDate", {
    userId,
    input,
    testFault: backendTestFault(_ignored),
  });
}

export async function createTemplateFromDate(
  userId: string,
  input: { date: string; type: "meal" | "day"; label: string },
  ..._ignored: unknown[]
) {
  return backendRpc<MealTemplate>("createTemplateFromDate", { userId, input });
}

export async function getStatsPageData(userId: string, today: string, ..._ignored: unknown[]) {
  return backendRpc<StatsPageData>("getStatsPageData", { userId, today });
}

export async function getWeightEntries(userId: string, ..._ignored: unknown[]) {
  return backendRpc<WeightEntryRecord[]>("getWeightEntries", { userId });
}

export async function createWeightEntry(userId: string, input: WeightEntryInput, ..._ignored: unknown[]) {
  return backendRpc<WeightEntryRecord>("createWeightEntry", { userId, input });
}

export async function createWeightEntryNoOverwrite(userId: string, input: WeightEntryInput, ..._ignored: unknown[]) {
  return backendRpc<WeightEntryRecord | null>("createWeightEntryNoOverwrite", { userId, input });
}

export async function updateWeightEntry(
  userId: string,
  entryId: string,
  input: WeightEntryInput,
  ..._ignored: unknown[]
) {
  return backendRpc<WeightEntryRecord>("updateWeightEntry", { userId, entryId, input });
}

export async function deleteWeightEntry(userId: string, entryId: string, ..._ignored: unknown[]) {
  return backendRpc<boolean>("deleteWeightEntry", { userId, entryId });
}

export async function getWeightGoal(userId: string, ..._ignored: unknown[]) {
  return backendRpc<number | null>("getWeightGoal", { userId });
}

export async function saveWeightGoal(userId: string, goalWeightKg: number | null, ..._ignored: unknown[]) {
  return backendRpc<void>("saveWeightGoal", { userId, goalWeightKg });
}

export async function getWeightPageData(userId: string, selectedDate: string, ..._ignored: unknown[]) {
  return backendRpc<WeightPageData>("getWeightPageData", { userId, selectedDate });
}

export async function getRecipes(userId: string, ..._ignored: unknown[]) {
  return backendRpc<RecipeRecord[]>("getRecipes", { userId });
}

export async function getRecipeCount(userId: string, ..._ignored: unknown[]) {
  return backendRpc<number>("getRecipeCount", { userId });
}

export async function getRecipeById(userId: string, recipeId: string, ..._ignored: unknown[]) {
  return backendRpc<RecipeRecord | null>("getRecipeById", { userId, recipeId });
}

export async function createRecipe(userId: string, input: RecipeInput, ..._ignored: unknown[]) {
  return backendRpc<RecipeRecord>("createRecipe", {
    userId,
    input,
    testFault: backendTestFault(_ignored),
  });
}

export async function updateRecipe(userId: string, recipeId: string, input: RecipeInput, ..._ignored: unknown[]) {
  return backendRpc<RecipeRecord>("updateRecipe", {
    userId,
    recipeId,
    input,
    testFault: backendTestFault(_ignored),
  });
}

export async function deleteRecipe(userId: string, recipeId: string, ..._ignored: unknown[]) {
  return backendRpc<boolean>("deleteRecipe", { userId, recipeId });
}

export async function getLeaderboardStats(userId: string, referenceDate: string, ..._ignored: unknown[]) {
  return backendRpc<LeaderboardStats>("getLeaderboardStats", { userId, referenceDate });
}

export async function lookupBarcodeFoodProduct(barcode: string, ..._ignored: unknown[]) {
  return backendRpc<FoodProduct | null>("lookupBarcodeFoodProduct", { barcode });
}

export async function saveBarcodeFoodProduct(
  userId: string,
  input: BarcodeFoodProductInput,
  ..._ignored: unknown[]
) {
  return backendRpc<FoodProduct>("saveBarcodeFoodProduct", {
    userId,
    input,
    testFault: backendTestFault(_ignored),
  });
}

export async function getRecentQuickAddCandidates(userId: string, limit = 30, ..._ignored: unknown[]) {
  return backendRpc<QuickAddCandidate[]>("getRecentQuickAddCandidates", { userId, limit });
}

export async function getDashboardQuickAddCandidates(
  userId: string,
  limitPerSource = 30,
  ..._ignored: unknown[]
) {
  return backendRpc<QuickAddCandidate[]>("getDashboardQuickAddCandidates", {
    userId,
    limitPerSource,
  });
}

export async function getAdminDashboardData(..._ignored: unknown[]) {
  return backendRpc<AdminDashboardData>("getAdminDashboardData");
}

export async function getAdminUserHealthSummary(..._ignored: unknown[]) {
  return backendRpc<AdminUserHealthSummary>("getAdminUserHealthSummary");
}

export async function listAdminUsers(input = {}, ..._ignored: unknown[]) {
  return backendRpc<AdminUserListPage>("listAdminUsers", { input });
}

export async function getAdminUserDetail(userId: string, ..._ignored: unknown[]) {
  return backendRpc<AdminUserDetail | null>("getAdminUserDetail", { userId });
}

export async function setUserRole(actorUserId: string, targetUserId: string, nextRole: AdminRole, ..._ignored: unknown[]) {
  return backendRpc<AppUser>("setUserRole", { actorUserId, targetUserId, nextRole });
}

export async function listAdminBarcodeProducts(input = {}, ..._ignored: unknown[]) {
  return backendRpc<AdminBarcodeListPage>("listAdminBarcodeProducts", { input });
}

export async function listAdminBarcodeReviewQueue(input = {}, ..._ignored: unknown[]) {
  return backendRpc<AdminBarcodeReviewQueuePage>("listAdminBarcodeReviewQueue", { input });
}

export async function getAdminBarcodeProductById(barcodeProductId: string, ..._ignored: unknown[]) {
  return backendRpc<FoodProduct | null>("getAdminBarcodeProductById", { barcodeProductId });
}

export async function createAdminBarcodeProduct(
  actorUserId: string,
  input: BarcodeFoodProductInput,
  ..._ignored: unknown[]
) {
  return backendRpc<FoodProduct>("createAdminBarcodeProduct", { actorUserId, input });
}

export async function updateAdminBarcodeProduct(
  actorUserId: string,
  barcodeProductId: string,
  input: BarcodeFoodProductInput,
  ..._ignored: unknown[]
) {
  return backendRpc<FoodProduct>("updateAdminBarcodeProduct", {
    actorUserId,
    barcodeProductId,
    input,
  });
}

export async function softDeleteAdminBarcodeProduct(
  actorUserId: string,
  barcodeProductId: string,
  ..._ignored: unknown[]
) {
  return backendRpc<FoodProduct>("softDeleteAdminBarcodeProduct", {
    actorUserId,
    barcodeProductId,
  });
}

export async function restoreAdminBarcodeProduct(
  actorUserId: string,
  barcodeProductId: string,
  ..._ignored: unknown[]
) {
  return backendRpc<FoodProduct>("restoreAdminBarcodeProduct", {
    actorUserId,
    barcodeProductId,
  });
}

export async function listAdminAuditEvents(input = {}, ..._ignored: unknown[]) {
  return backendRpc<AdminAuditListPage>("listAdminAuditEvents", { input });
}

export async function getAdminAuditEventById(eventId: string, ..._ignored: unknown[]) {
  return backendRpc<AdminAuditEventDetail | null>("getAdminAuditEventById", { eventId });
}
