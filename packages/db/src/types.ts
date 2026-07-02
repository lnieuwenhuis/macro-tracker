export type MacroNumbers = {
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
};

export type MacroFoodInput = MacroNumbers & {
  productId?: string | null;
  label: string;
  quantity?: number;
  unit?: QuantityUnit;
  servingMultiplier?: number;
};

export const API_SCOPE_VALUES = [
  "read:account",
  "read:daily",
  "write:daily",
  "read:foods",
  "write:foods",
  "read:templates",
  "write:templates",
  "read:recipes",
  "write:recipes",
  "read:weight",
  "write:weight",
  "read:goals",
  "write:goals",
  "read:stats",
] as const;
export type ApiScope = (typeof API_SCOPE_VALUES)[number];

export function isApiScope(value: string): value is ApiScope {
  return API_SCOPE_VALUES.includes(value as ApiScope);
}

export type ApiTokenRecord = {
  id: string;
  userId: string;
  tokenPrefix: string;
  name: string;
  scopes: ApiScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

export type CreatedApiToken = {
  token: string;
  record: ApiTokenRecord;
};

export type ApiTokenAuthResult =
  | { ok: true; token: ApiTokenRecord }
  | {
      ok: false;
      reason: "missing" | "malformed" | "invalid" | "expired" | "revoked";
    };

export const QUANTITY_UNIT_VALUES = ["g", "ml", "serving", "count"] as const;
export type QuantityUnit = (typeof QUANTITY_UNIT_VALUES)[number];

export function isQuantityUnit(value: string): value is QuantityUnit {
  return QUANTITY_UNIT_VALUES.includes(value as QuantityUnit);
}

export const MEAL_ENTRY_STATUS_VALUES = ["planned", "eaten", "skipped"] as const;
export type MealEntryStatus = (typeof MEAL_ENTRY_STATUS_VALUES)[number];

export function isMealEntryStatus(value: string): value is MealEntryStatus {
  return MEAL_ENTRY_STATUS_VALUES.includes(value as MealEntryStatus);
}

export const FOOD_PRODUCT_SCOPE_VALUES = ["global", "personal", "legacy"] as const;
export type FoodProductScope = (typeof FOOD_PRODUCT_SCOPE_VALUES)[number];

export const FOOD_PRODUCT_SOURCE_VALUES = [
  "manual",
  "barcode",
  "ai_photo",
  "legacy",
  "recipe",
] as const;
export type FoodProductSource = (typeof FOOD_PRODUCT_SOURCE_VALUES)[number];

export const WEIGHT_UNIT_VALUES = ["kg", "lb"] as const;
export type WeightUnit = (typeof WEIGHT_UNIT_VALUES)[number];

export function isWeightUnit(value: string): value is WeightUnit {
  return WEIGHT_UNIT_VALUES.includes(value as WeightUnit);
}

export const MEAL_TEMPLATE_TYPE_VALUES = ["meal", "day"] as const;
export type MealTemplateType = (typeof MEAL_TEMPLATE_TYPE_VALUES)[number];

export function isMealTemplateType(value: string): value is MealTemplateType {
  return MEAL_TEMPLATE_TYPE_VALUES.includes(value as MealTemplateType);
}

export const FOOD_PRODUCT_REVISION_ACTION_VALUES = [
  "created",
  "updated",
  "corrected",
  "deleted",
  "restored",
  "imported",
] as const;
export type FoodProductRevisionAction =
  (typeof FOOD_PRODUCT_REVISION_ACTION_VALUES)[number];

export type MacroGoals = {
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  caloriesKcal: number | null;
};

export type FoodProductInput = {
  scope?: FoodProductScope;
  source?: FoodProductSource;
  barcode?: string | null;
  name: string;
  brand?: string | null;
  defaultServingQuantity?: number;
  defaultServingUnit?: QuantityUnit;
  proteinPer100: number;
  carbsPer100: number;
  fatPer100: number;
  caloriesPer100: number;
  servingWeightG?: number | null;
  servingVolumeMl?: number | null;
  submittedByUserId?: string | null;
  deletedByUserId?: string | null;
  sourceProvider?: string | null;
  sourceConfidence?: number | null;
  sourceMetadata?: Record<string, unknown> | null;
  correctedFromProductId?: string | null;
};

export type FoodProduct = Required<
  Pick<
    FoodProductInput,
    | "name"
    | "proteinPer100"
    | "carbsPer100"
    | "fatPer100"
    | "caloriesPer100"
  >
> & {
  id: string;
  ownerUserId: string | null;
  scope: FoodProductScope;
  source: FoodProductSource;
  barcode: string | null;
  brand: string;
  defaultServingQuantity: number;
  defaultServingUnit: QuantityUnit;
  servingWeightG: number | null;
  servingVolumeMl: number | null;
  submittedByUserId: string | null;
  deletedByUserId: string | null;
  sourceProvider: string | null;
  sourceConfidence: number | null;
  sourceMetadata: Record<string, unknown>;
  correctedFromProductId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type FoodProductRevision = {
  id: string;
  productId: string;
  actorUserId: string | null;
  action: FoodProductRevisionAction;
  snapshot: Record<string, unknown>;
  createdAt: string;
};

export type MealGroup = {
  id: string;
  userId: string;
  label: string;
  sortOrder: number;
  isDefault: boolean;
};

export type MealEntryInput = {
  date: string;
  mealGroupId?: string | null;
  status?: MealEntryStatus;
  sortOrder: number;
  clientMutationId?: string | null;
} & MacroFoodInput;

export type MealEntryRecord = MealEntryInput & {
  id: string;
  userId: string;
  mealGroupId: string | null;
  status: MealEntryStatus;
  productId: string | null;
  quantity: number;
  unit: QuantityUnit;
  servingMultiplier: number;
  clientMutationId: string | null;
  sourceLabel: string | null;
};

export type DailySummary = {
  date: string;
  totals: MacroNumbers;
  plannedTotals: MacroNumbers;
  skippedTotals: MacroNumbers;
  meals: MealEntryRecord[];
  mealGroups: MealGroup[];
};

export type DailyOverview = {
  date: string;
  totals: MacroNumbers;
  itemCount: number;
};

export type PeriodAverageLabel = "week" | "month" | "rolling7" | "rolling30";

export type PeriodAverage = {
  label: PeriodAverageLabel;
  startDate: string;
  endDate: string;
  loggedDays: number;
  averages: MacroNumbers;
};

export type ShooProfile = {
  pairwiseSub: string;
  email: string;
  displayName?: string | null;
  pictureUrl?: string | null;
};

export const ADMIN_ROLE_VALUES = ["user", "admin", "owner"] as const;

export type AdminRole = (typeof ADMIN_ROLE_VALUES)[number];

export function isAdminRole(value: string): value is AdminRole {
  return ADMIN_ROLE_VALUES.includes(value as AdminRole);
}

export function canAccessAdmin(role: AdminRole) {
  return role === "admin" || role === "owner";
}

export function isOwnerRole(role: AdminRole) {
  return role === "owner";
}

export type SessionUser = {
  userId: string;
  email: string;
};

export type AppUser = {
  id: string;
  email: string;
  shooPairwiseSub: string;
  displayName: string | null;
  pictureUrl: string | null;
  role: AdminRole;
  createdAt: string;
  lastLoginAt: string;
  goalCaloriesKcal: number | null;
  goalProteinG: number | null;
  goalCarbsG: number | null;
  goalFatG: number | null;
  goalWeightKg: number | null;
  onboardingCompletedAt: string | null;
  preferredWeightUnit: WeightUnit;
};

export type UserPreferences = {
  onboardingCompletedAt: string | null;
  preferredWeightUnit: WeightUnit;
};

export type CompleteOnboardingInput = {
  preferredWeightUnit: WeightUnit;
};

export type WeightEntryInput = {
  date: string;
  weightKg: number;
  bodyFatPct: number | null;
  notes: string | null;
};

export type WeightEntryRecord = WeightEntryInput & {
  id: string;
  userId: string;
};

export type WeightPageData = {
  entries: WeightEntryRecord[];
  goalWeightKg: number | null;
  stats: {
    currentWeight: number | null;
    weekChange: number | null;
    monthChange: number | null;
    trendDirection: "up" | "down" | "stable" | null;
  };
};

export type RecipeIngredientInput = MacroFoodInput;

export type RecipeIngredientRecord = RecipeIngredientInput & {
  id: string;
  recipeId: string;
  sortOrder: number;
};

export type RecipeInput = {
  label: string;
  portions: number;
  totalCookedWeightG?: number | null;
  ingredients: RecipeIngredientInput[];
};

export type RecipeRecord = {
  id: string;
  userId: string;
  label: string;
  portions: number;
  totalCookedWeightG: number | null;
  ingredients: RecipeIngredientRecord[];
  totalMacros: MacroNumbers;
  perPortionMacros: MacroNumbers;
};

export type MealTemplateItemInput = {
  mealGroupLabel?: string | null;
} & MacroFoodInput;

export type MealTemplateInput = {
  type: MealTemplateType;
  label: string;
  notes?: string | null;
  items: MealTemplateItemInput[];
};

export type MealTemplateItem = MealTemplateItemInput & {
  id: string;
  templateId: string;
  productId: string | null;
  mealGroupLabel: string | null;
  quantity: number;
  unit: QuantityUnit;
  servingMultiplier: number;
  sortOrder: number;
};

export type MealTemplate = {
  id: string;
  userId: string;
  type: MealTemplateType;
  label: string;
  notes: string | null;
  items: MealTemplateItem[];
  createdAt: string;
  updatedAt: string;
};

export type BarcodeFoodProductInput = {
  barcode: string;
  name: string;
  brands?: string | null;
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
  servingSizeG: number | null;
};

export type AdminAuditEvent = {
  id: string;
  actorUserId: string;
  actorEmail: string | null;
  actorDisplayName: string | null;
  actorRole: AdminRole;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export type AdminAuditEventDetail = AdminAuditEvent;

export type AdminBarcodeReviewReason =
  | "low_confidence"
  | "missing_serving_size"
  | "recently_deleted"
  | "recently_restored"
  | "duplicate_name"
  | "frequent_revisions";

export type AdminBarcodeReviewQueueItem = FoodProduct & {
  reviewReasons: AdminBarcodeReviewReason[];
  revisionCount30Days: number;
  duplicateNameCount: number;
  latestAuditAction: string | null;
  latestAuditAt: string | null;
};

export type AdminBarcodeRecord = {
  id: string;
  barcode: string;
  name: string;
  brands: string;
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
  servingSizeG: number | null;
  addedByUserId: string | null;
  addedByEmail: string | null;
  deletedByUserId: string | null;
  deletedByEmail: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  status: "active" | "deleted";
};

export type AdminRecipeSummary = {
  id: string;
  label: string;
  portions: number;
  updatedAt: string;
};

export type AdminUserListItem = {
  id: string;
  email: string;
  displayName: string | null;
  pictureUrl: string | null;
  role: AdminRole;
  createdAt: string;
  lastLoginAt: string;
};

export type AdminUserDetail = {
  user: AppUser;
  goals: MacroGoals;
  counts: {
    mealEntries: number;
    weightEntries: number;
    recipes: number;
    templates: number;
    barcodeSubmissions: number;
  };
  recentMeals: MealEntryRecord[];
  recentWeights: WeightEntryRecord[];
  recentRecipes: AdminRecipeSummary[];
  recentTemplates: MealTemplate[];
  recentBarcodeSubmissions: FoodProduct[];
};

export type AdminPagination = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

export type AdminUserListPage = {
  items: AdminUserListItem[];
  pagination: AdminPagination;
};

export type AdminBarcodeListPage = {
  items: FoodProduct[];
  pagination: AdminPagination;
};

export type AdminBarcodeReviewQueuePage = {
  items: AdminBarcodeReviewQueueItem[];
  pagination: AdminPagination;
};

export type AdminAuditListPage = {
  items: AdminAuditEvent[];
  pagination: AdminPagination;
};

export type AdminUserHealthSegmentId =
  | "onboarded_no_logs"
  | "no_goals"
  | "inactive7"
  | "inactive30"
  | "no_weight_entries"
  | "heavy_barcode_submitters";

export type AdminUserHealthSegment = {
  id: AdminUserHealthSegmentId;
  label: string;
  count: number;
  href: string;
};

export type AdminUserHealthSummary = {
  segments: AdminUserHealthSegment[];
};

export type AdminUserHealthFilter =
  | "onboarded_no_logs"
  | "no_goals"
  | "no_weight_entries"
  | "heavy_barcode_submitters";

export type AdminDashboardData = {
  totalUsers: number;
  ownerCount: number;
  adminCount: number;
  newUsersLast7Days: number;
  activeUsersLast7Days: number;
  activeBarcodeCount: number;
  deletedBarcodeCount: number;
  recentBarcodeAdditions: FoodProduct[];
  recentAuditEvents: AdminAuditEvent[];
  health: AdminUserHealthSummary;
};

export type StatsPageData = {
  allDailyTotals: Array<{
    date: string;
    proteinG: number;
    carbsG: number;
    fatG: number;
    caloriesKcal: number;
    plannedTotals: MacroNumbers;
  }>;
  totalDaysTracked: number;
  currentStreak: number;
  longestStreak: number;
  totalProteinG: number;
  totalCarbsG: number;
  totalFatG: number;
  totalCaloriesKcal: number;
  bestCalorieDay: { date: string; caloriesKcal: number } | null;
  topLabels: Array<{ label: string; count: number }>;
  goalHitRates: {
    days7: Record<keyof MacroNumbers, number | null>;
    days30: Record<keyof MacroNumbers, number | null>;
    days90: Record<keyof MacroNumbers, number | null>;
  };
  macroConsistency: {
    calorieAvgAbsoluteDeviation: number | null;
    score: number | null;
  };
  rollingAverages: {
    days7: MacroNumbers;
    days30: MacroNumbers;
  };
  estimatedEnergyBalance: {
    averageDailyDeltaKcal: number | null;
    estimatedWeeklyWeightChangeKg: number | null;
  };
  proteinPerKg: number | null;
  smoothedWeightTrend: Array<{
    date: string;
    weightKg: number;
    smoothedWeightKg: number;
  }>;
  plannedAdherence: {
    plannedCount: number;
    eatenCount: number;
    skippedCount: number;
    adherencePct: number | null;
  };
};

export type QuickAddSource = "preset" | "recent";

export type QuickAddCandidate = {
  label: string;
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
  source: QuickAddSource;
  /** ISO date string of the most recent log entry seen in history, if any */
  sourceDate?: string;
  /** Preset ID, used for touch/ranking (preset items only) */
  presetId?: string;
  /**
   * UTC hour (0–23) at the centre of the 3-hour window where this food is most
   * frequently logged. Only set when habitCount ≥ 3 (a clear, repeated habit).
   */
  peakHourUtc?: number;
  /** Number of log entries that fall within the peak time window. */
  habitCount?: number;
  /** Number of distinct logged dates seen for this food in the history sample. */
  observedUseDays?: number;
};
