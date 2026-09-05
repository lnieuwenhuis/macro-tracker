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
  GymHomeSummary,
  GymPageData,
  GymSlot,
  GymSlotInput,
  GymSlotStatus,
  MacroGoals,
  MealEntryInput,
  MealEntryRecord,
  MealEntryStatus,
  MealGroup,
  MealTemplate,
  MealTemplateInput,
  MealTemplateSummary,
  PeriodAverage,
  PlannedShoppingSummary,
  QuickAddCandidate,
  RecipeInput,
  RecipeRecord,
  RecipeSummary,
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

export async function upsertUserFromShooProfile(profile: ShooProfile) {
  return backendRpc<AppUser>("upsertUserFromShooProfile", { profile });
}

export async function getUserById(userId: string) {
  return backendRpc<AppUser | null>("getUserById", { userId });
}

/** Promotes to owner only if the backend's `ADMIN_OWNER_EMAILS` lists the address. */
export async function reconcileConfiguredOwner(userId: string) {
  return backendRpc<AppUser>("reconcileConfiguredOwner", { userId });
}

/** Rejected unless the backend runs with `BACKEND_ENABLE_TEST_ROUTES=true`. */
export async function ensureUserRoleForTesting(userId: string, role: AdminRole) {
  return backendRpc<AppUser>("ensureUserRoleForTesting", { userId, role });
}

export async function createApiToken(
  userId: string,
  input: { name: string; scopes: readonly string[]; expiresAt?: Date | string | null }
): Promise<CreatedApiToken> {
  return backendRpc("createApiToken", {
    userId,
    input: {
      ...input,
      expiresAt: input.expiresAt instanceof Date ? input.expiresAt.toISOString() : input.expiresAt,
    },
  });
}

export async function listApiTokens(userId: string): Promise<ApiTokenRecord[]> {
  return backendRpc("listApiTokens", { userId });
}

export async function revokeApiToken(userId: string, tokenId: string) {
  return backendRpc<boolean>("revokeApiToken", { userId, tokenId });
}

export async function authenticateApiToken(token: string | null): Promise<ApiTokenAuthResult> {
  return backendRpc("authenticateApiToken", { token });
}

export async function getMealGroups(userId: string): Promise<MealGroup[]> {
  return backendRpc("getMealGroups", { userId });
}

export async function createMealGroup(userId: string, input: { label: string }) {
  return backendRpc<MealGroup>("createMealGroup", { userId, input });
}

export async function updateMealGroup(userId: string, groupId: string, input: { label: string }) {
  return backendRpc<MealGroup>("updateMealGroup", { userId, groupId, input });
}

export async function deleteMealGroup(userId: string, groupId: string, ..._ignored: unknown[]) {
  return backendRpc<boolean>("deleteMealGroup", {
    userId,
    groupId,
    testFault: backendTestFault(_ignored),
  });
}

export async function getDailySummary(userId: string, date: string): Promise<DailySummary> {
  return backendRpc("getDailySummary", { userId, date });
}

export async function createMealEntry(
  userId: string,
  input: Omit<MealEntryInput, "sortOrder"> & { sortOrder?: number }
) {
  return backendRpc<MealEntryRecord>("createMealEntry", { userId, input });
}

export async function updateMealEntry(userId: string, entryId: string, input: MealEntryInput) {
  return backendRpc<MealEntryRecord>("updateMealEntry", { userId, entryId, input });
}

export async function deleteMealEntry(userId: string, entryId: string) {
  return backendRpc<boolean>("deleteMealEntry", { userId, entryId });
}

export async function markMealEntryStatus(
  userId: string,
  entryId: string,
  status: MealEntryStatus
) {
  return backendRpc<MealEntryRecord>("markMealEntryStatus", { userId, entryId, status });
}

export async function getUserGoals(userId: string): Promise<MacroGoals> {
  return backendRpc("getUserGoals", { userId });
}

export async function saveUserGoals(userId: string, goals: MacroGoals) {
  return backendRpc<void>("saveUserGoals", { userId, goals });
}

export async function completeOnboardingSetup(
  userId: string,
  input: CompleteOnboardingInput & Record<string, unknown>
) {
  return backendRpc<AppUser>("completeOnboardingSetup", { userId, input });
}

export async function completeUserOnboarding(userId: string, input: CompleteOnboardingInput) {
  return backendRpc<AppUser>("completeUserOnboarding", { userId, input });
}

export async function ensureDefaultMealGroups(userId: string) {
  return backendRpc<void>("ensureDefaultMealGroups", { userId });
}

export async function setUserOnboardingForTesting(userId: string, onboarded: boolean) {
  return backendRpc<AppUser>("setUserOnboardingForTesting", { userId, onboarded });
}

export async function searchMealEntries(userId: string, query: string) {
  return backendRpc<MealEntryRecord[]>("searchMealEntries", { userId, query });
}

export async function searchFoodProducts(userId: string, query: string) {
  return backendRpc<FoodProduct[]>("searchFoodProducts", { userId, query });
}

export async function createPersonalFoodProduct(userId: string, input: FoodProductInput) {
  return backendRpc<FoodProduct>("createPersonalFoodProduct", { userId, input });
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

export async function getPeriodAverages(userId: string, selectedDate: string) {
  return backendRpc<PeriodAverage[]>("getPeriodAverages", { userId, selectedDate });
}

export async function getRecentDailyOverviews(
  userId: string,
  dateOrDays: string | number = 7,
  daysOrDb?: number | unknown
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

export async function getTemplates(userId: string) {
  return backendRpc<MealTemplate[]>("getTemplates", { userId });
}

export async function getTemplateSummaries(userId: string) {
  return backendRpc<MealTemplateSummary[]>("getTemplateSummaries", { userId });
}

export async function getTemplateById(userId: string, templateId: string) {
  return backendRpc<MealTemplate | null>("getTemplateById", { userId, templateId });
}

export async function createTemplate(userId: string, input: MealTemplateInput) {
  return backendRpc<MealTemplate>("createTemplate", { userId, input });
}

export async function updateTemplate(userId: string, templateId: string, input: MealTemplateInput) {
  return backendRpc<MealTemplate>("updateTemplate", { userId, templateId, input });
}

export async function deleteTemplate(userId: string, templateId: string) {
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
  input: { date: string; type: "meal" | "day"; label: string }
) {
  return backendRpc<MealTemplate>("createTemplateFromDate", { userId, input });
}

export async function getStatsPageData(userId: string, today: string) {
  return backendRpc<StatsPageData>("getStatsPageData", { userId, today });
}

export async function createWeightEntry(userId: string, input: WeightEntryInput) {
  return backendRpc<WeightEntryRecord>("createWeightEntry", { userId, input });
}

export async function updateWeightEntry(userId: string, entryId: string, input: WeightEntryInput) {
  return backendRpc<WeightEntryRecord>("updateWeightEntry", { userId, entryId, input });
}

export async function deleteWeightEntry(userId: string, entryId: string) {
  return backendRpc<boolean>("deleteWeightEntry", { userId, entryId });
}

export async function saveWeightGoal(userId: string, goalWeightKg: number | null) {
  return backendRpc<void>("saveWeightGoal", { userId, goalWeightKg });
}

export async function getWeightPageData(userId: string, selectedDate: string) {
  return backendRpc<WeightPageData>("getWeightPageData", { userId, selectedDate });
}

export async function getRecipes(userId: string) {
  return backendRpc<RecipeRecord[]>("getRecipes", { userId });
}

export async function getRecipeSummaries(userId: string) {
  return backendRpc<RecipeSummary[]>("getRecipeSummaries", { userId });
}

export async function getPlannedShoppingSummaries(userId: string, dates: string[]) {
  return backendRpc<PlannedShoppingSummary[]>("getPlannedShoppingSummaries", {
    userId,
    dates,
  });
}

export async function getRecipeCount(userId: string) {
  return backendRpc<number>("getRecipeCount", { userId });
}

export async function getRecipeById(userId: string, recipeId: string) {
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

export async function deleteRecipe(userId: string, recipeId: string) {
  return backendRpc<boolean>("deleteRecipe", { userId, recipeId });
}

export async function getLeaderboardStats(userId: string, referenceDate: string) {
  return backendRpc<LeaderboardStats>("getLeaderboardStats", { userId, referenceDate });
}

export async function lookupBarcodeFoodProduct(barcode: string) {
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

export async function getRecentQuickAddCandidates(userId: string, limit = 30) {
  return backendRpc<QuickAddCandidate[]>("getRecentQuickAddCandidates", { userId, limit });
}

export async function getDashboardQuickAddCandidates(userId: string, limitPerSource = 30) {
  return backendRpc<QuickAddCandidate[]>("getDashboardQuickAddCandidates", {
    userId,
    limitPerSource,
  });
}

// Admin reads take the acting user so the backend enforces the role server-side.
export async function getAdminDashboardData(actorUserId: string) {
  return backendRpc<AdminDashboardData>("getAdminDashboardData", { actorUserId });
}

export async function getAdminUserHealthSummary(actorUserId: string) {
  return backendRpc<AdminUserHealthSummary>("getAdminUserHealthSummary", { actorUserId });
}

export async function listAdminUsers(actorUserId: string, input = {}) {
  return backendRpc<AdminUserListPage>("listAdminUsers", { actorUserId, input });
}

export async function getAdminUserDetail(actorUserId: string, userId: string) {
  return backendRpc<AdminUserDetail | null>("getAdminUserDetail", { actorUserId, userId });
}

export async function setUserRole(actorUserId: string, targetUserId: string, nextRole: AdminRole) {
  return backendRpc<AppUser>("setUserRole", { actorUserId, targetUserId, nextRole });
}

export async function listAdminBarcodeProducts(actorUserId: string, input = {}) {
  return backendRpc<AdminBarcodeListPage>("listAdminBarcodeProducts", { actorUserId, input });
}

export async function listAdminBarcodeReviewQueue(actorUserId: string, input = {}) {
  return backendRpc<AdminBarcodeReviewQueuePage>("listAdminBarcodeReviewQueue", {
    actorUserId,
    input,
  });
}

export async function getAdminBarcodeProductById(actorUserId: string, barcodeProductId: string) {
  return backendRpc<FoodProduct | null>("getAdminBarcodeProductById", {
    actorUserId,
    barcodeProductId,
  });
}

export async function createAdminBarcodeProduct(
  actorUserId: string,
  input: BarcodeFoodProductInput
) {
  return backendRpc<FoodProduct>("createAdminBarcodeProduct", { actorUserId, input });
}

export async function updateAdminBarcodeProduct(
  actorUserId: string,
  barcodeProductId: string,
  input: BarcodeFoodProductInput
) {
  return backendRpc<FoodProduct>("updateAdminBarcodeProduct", {
    actorUserId,
    barcodeProductId,
    input,
  });
}

export async function softDeleteAdminBarcodeProduct(actorUserId: string, barcodeProductId: string) {
  return backendRpc<FoodProduct>("softDeleteAdminBarcodeProduct", {
    actorUserId,
    barcodeProductId,
  });
}

export async function restoreAdminBarcodeProduct(actorUserId: string, barcodeProductId: string) {
  return backendRpc<FoodProduct>("restoreAdminBarcodeProduct", {
    actorUserId,
    barcodeProductId,
  });
}

export async function listAdminAuditEvents(actorUserId: string, input = {}) {
  return backendRpc<AdminAuditListPage>("listAdminAuditEvents", { actorUserId, input });
}

export async function getAdminAuditEventById(actorUserId: string, eventId: string) {
  return backendRpc<AdminAuditEventDetail | null>("getAdminAuditEventById", {
    actorUserId,
    eventId,
  });
}

export async function createGymSlot(userId: string, input: GymSlotInput) {
  return backendRpc<GymSlot>("createGymSlot", { userId, input });
}

export async function updateGymSlot(userId: string, slotId: string, input: GymSlotInput) {
  return backendRpc<GymSlot>("updateGymSlot", { userId, slotId, input });
}

export async function deleteGymSlot(userId: string, slotId: string) {
  return backendRpc<{ deleted: boolean }>("deleteGymSlot", { userId, slotId });
}

export async function setGymSlotStatus(
  userId: string,
  slotId: string,
  date: string,
  status: GymSlotStatus
) {
  return backendRpc<{ slotId: string; date: string; status: GymSlotStatus }>(
    "setGymSlotStatus",
    { userId, slotId, date, status },
  );
}

/** `identifier` is an email address or a friend code; the backend classifies. */
export async function inviteGymBuddy(userId: string, identifier: string) {
  return backendRpc<{ id: string; result: "invited" | "accepted" }>("inviteGymBuddy", {
    userId,
    identifier,
  });
}

export async function respondGymBuddyInvite(userId: string, buddyId: string, accept: boolean) {
  return backendRpc<{ status: "accepted" | "declined" }>("respondGymBuddyInvite", {
    userId,
    buddyId,
    accept,
  });
}

export async function removeGymBuddy(userId: string, buddyId: string) {
  return backendRpc<{ removed: boolean }>("removeGymBuddy", { userId, buddyId });
}

export async function getGymPageData(userId: string, date: string) {
  return backendRpc<GymPageData>("getGymPageData", { userId, date });
}

export async function getGymHomeSummary(userId: string, date: string) {
  return backendRpc<GymHomeSummary>("getGymHomeSummary", { userId, date });
}
