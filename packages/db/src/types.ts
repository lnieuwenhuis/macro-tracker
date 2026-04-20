export type MacroNumbers = {
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
};

export type MacroGoals = {
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  caloriesKcal: number | null;
};

export type MealEntryInput = {
  date: string;
  label: string;
  sortOrder: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
};

export type MealEntryRecord = MealEntryInput & {
  id: string;
  userId: string;
};

export type DailySummary = {
  date: string;
  totals: MacroNumbers;
  meals: MealEntryRecord[];
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
};

export type FoodPreset = {
  id: string;
  userId: string;
  label: string;
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
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

export type RecipeIngredientInput = {
  label: string;
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
};

export type RecipeIngredientRecord = RecipeIngredientInput & {
  id: string;
  recipeId: string;
  sortOrder: number;
};

export type RecipeInput = {
  label: string;
  portions: number;
  ingredients: RecipeIngredientInput[];
};

export type RecipeRecord = {
  id: string;
  userId: string;
  label: string;
  portions: number;
  ingredients: RecipeIngredientRecord[];
  totalMacros: MacroNumbers;
  perPortionMacros: MacroNumbers;
};

export type CustomBarcodeProductInput = {
  barcode: string;
  name: string;
  brands: string;
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
  servingSizeG: number | null;
};

export type CustomBarcodeProduct = CustomBarcodeProductInput & {
  id: string;
  addedByUserId: string | null;
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
    presets: number;
    barcodeSubmissions: number;
  };
  recentMeals: MealEntryRecord[];
  recentWeights: WeightEntryRecord[];
  recentRecipes: AdminRecipeSummary[];
  recentPresets: FoodPreset[];
  recentBarcodeSubmissions: AdminBarcodeRecord[];
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
  items: AdminBarcodeRecord[];
  pagination: AdminPagination;
};

export type AdminAuditListPage = {
  items: AdminAuditEvent[];
  pagination: AdminPagination;
};

export type AdminDashboardData = {
  totalUsers: number;
  ownerCount: number;
  adminCount: number;
  newUsersLast7Days: number;
  activeUsersLast7Days: number;
  activeBarcodeCount: number;
  deletedBarcodeCount: number;
  recentBarcodeAdditions: AdminBarcodeRecord[];
  recentAuditEvents: AdminAuditEvent[];
};

export type StatsPageData = {
  allDailyTotals: Array<{
    date: string;
    proteinG: number;
    carbsG: number;
    fatG: number;
    caloriesKcal: number;
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
