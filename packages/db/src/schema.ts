import { sql } from "drizzle-orm";
import {
  date,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

function createdAtTimestamp() {
  return timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull();
}

function updatedAtTimestamp() {
  return timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull();
}

function createdUpdatedTimestamps() {
  return {
    createdAt: createdAtTimestamp(),
    updatedAt: updatedAtTimestamp(),
  };
}

function softDeleteTimestamps() {
  return {
    ...createdUpdatedTimestamps(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  };
}

function mealMacroColumns() {
  return {
    quantity: numeric("quantity", { precision: 8, scale: 2 })
      .notNull()
      .default("1"),
    unit: text("unit").notNull().default("serving"),
    servingMultiplier: numeric("serving_multiplier", { precision: 8, scale: 2 })
      .notNull()
      .default("1"),
    proteinG: numeric("protein_g", { precision: 6, scale: 1 }).notNull(),
    carbsG: numeric("carbs_g", { precision: 6, scale: 1 }).notNull(),
    fatG: numeric("fat_g", { precision: 6, scale: 1 }).notNull(),
    caloriesKcal: integer("calories_kcal").notNull(),
  };
}

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().notNull(),
    shooPairwiseSub: text("shoo_pairwise_sub").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    pictureUrl: text("picture_url"),
    role: text("role").notNull().default("user"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    goalCaloriesKcal: integer("goal_calories_kcal"),
    goalProteinG: numeric("goal_protein_g", { precision: 6, scale: 1 }),
    goalCarbsG: numeric("goal_carbs_g", { precision: 6, scale: 1 }),
    goalFatG: numeric("goal_fat_g", { precision: 6, scale: 1 }),
    goalWeightKg: numeric("goal_weight_kg", { precision: 5, scale: 2 }),
    onboardingCompletedAt: timestamp("onboarding_completed_at", {
      withTimezone: true,
    }),
    preferredWeightUnit: text("preferred_weight_unit")
      .notNull()
      .default("kg"),
  },
  (table) => [
    uniqueIndex("users_shoo_pairwise_sub_key").on(table.shooPairwiseSub),
    uniqueIndex("users_email_key").on(table.email),
  ],
);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    name: text("name").notNull(),
    scopes: jsonb("scopes").notNull().default([]),
    createdAt: createdAtTimestamp(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("api_tokens_token_hash_key").on(table.tokenHash),
    index("api_tokens_user_created_idx").on(table.userId, table.createdAt),
    index("api_tokens_user_revoked_idx").on(table.userId, table.revokedAt),
  ],
);

export const adminAuditEvents = pgTable(
  "admin_audit_events",
  {
    id: uuid("id").primaryKey().notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    actorRole: text("actor_role").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    detailsJson: jsonb("details_json").notNull().default({}),
    createdAt: createdAtTimestamp(),
  },
  (table) => [
    index("admin_audit_events_created_at_idx").on(table.createdAt),
    index("admin_audit_events_target_idx").on(table.targetType, table.targetId),
  ],
);

export const foodProducts = pgTable(
  "food_products",
  {
    id: uuid("id").primaryKey().notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    scope: text("scope").notNull().default("personal"),
    source: text("source").notNull().default("manual"),
    barcode: text("barcode"),
    name: text("name").notNull(),
    brand: text("brand").notNull().default(""),
    defaultServingQuantity: numeric("default_serving_quantity", {
      precision: 8,
      scale: 2,
    })
      .notNull()
      .default("1"),
    defaultServingUnit: text("default_serving_unit").notNull().default("serving"),
    proteinPer100: numeric("protein_per_100", {
      precision: 7,
      scale: 2,
    }).notNull(),
    carbsPer100: numeric("carbs_per_100", {
      precision: 7,
      scale: 2,
    }).notNull(),
    fatPer100: numeric("fat_per_100", {
      precision: 7,
      scale: 2,
    }).notNull(),
    caloriesPer100: integer("calories_per_100").notNull(),
    servingWeightG: numeric("serving_weight_g", { precision: 8, scale: 2 }),
    servingVolumeMl: numeric("serving_volume_ml", { precision: 8, scale: 2 }),
    submittedByUserId: uuid("submitted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deletedByUserId: uuid("deleted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    sourceProvider: text("source_provider"),
    sourceConfidence: numeric("source_confidence", { precision: 4, scale: 2 }),
    sourceMetadata: jsonb("source_metadata").notNull().default({}),
    correctedFromProductId: uuid("corrected_from_product_id").references(
      (): AnyPgColumn => foodProducts.id,
      { onDelete: "set null" },
    ),
    createdAt: createdAtTimestamp(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("food_products_owner_name_idx").on(table.ownerUserId, table.name),
    index("food_products_barcode_idx").on(table.barcode),
    uniqueIndex("food_products_active_global_barcode_key")
      .on(table.barcode)
      .where(
        sql`${table.ownerUserId} IS NULL AND ${table.source} = 'barcode' AND ${table.deletedAt} IS NULL AND ${table.barcode} IS NOT NULL`,
      ),
    index("food_products_scope_source_idx").on(table.scope, table.source),
    index("food_products_deleted_at_idx").on(table.deletedAt),
    index("food_products_submitted_by_idx").on(table.submittedByUserId),
    index("food_products_corrected_from_idx").on(table.correctedFromProductId),
  ],
);

export const foodProductRevisions = pgTable(
  "food_product_revisions",
  {
    id: uuid("id").primaryKey().notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => foodProducts.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    snapshotJson: jsonb("snapshot_json").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("food_product_revisions_product_idx").on(table.productId),
    index("food_product_revisions_actor_idx").on(table.actorUserId),
    index("food_product_revisions_created_at_idx").on(table.createdAt),
  ],
);

export const mealGroups = pgTable(
  "meal_groups",
  {
    id: uuid("id").primaryKey().notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    ...softDeleteTimestamps(),
  },
  (table) => [
    index("meal_groups_user_sort_idx").on(table.userId, table.sortOrder),
    uniqueIndex("meal_groups_active_default_label_key")
      .on(table.userId, table.label)
      .where(sql`${table.deletedAt} IS NULL AND ${table.isDefault} = true`),
    index("meal_groups_deleted_at_idx").on(table.deletedAt),
  ],
);

export const mealEntries = pgTable(
  "meal_entries",
  {
    id: uuid("id").primaryKey().notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entryDate: date("entry_date").notNull(),
    mealGroupId: uuid("meal_group_id").references(() => mealGroups.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("eaten"),
    productId: uuid("product_id").references(() => foodProducts.id, {
      onDelete: "set null",
    }),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull(),
    ...mealMacroColumns(),
    clientMutationId: text("client_mutation_id"),
    healthkitSyncedAt: timestamp("healthkit_synced_at", { withTimezone: true }),
    ...createdUpdatedTimestamps(),
  },
  (table) => [
    index("meal_entries_user_date_idx").on(table.userId, table.entryDate),
    index("meal_entries_user_date_status_idx").on(
      table.userId,
      table.entryDate,
      table.status,
    ),
    index("meal_entries_meal_group_idx").on(table.mealGroupId),
    index("meal_entries_product_idx").on(table.productId),
    uniqueIndex("meal_entries_user_client_mutation_key").on(
      table.userId,
      table.clientMutationId,
    ),
    index("meal_entries_user_date_sort_idx").on(
      table.userId,
      table.entryDate,
      table.sortOrder,
    ),
    index("meal_entries_healthkit_unsynced_idx")
      .on(table.userId, table.entryDate)
      .where(sql`${table.healthkitSyncedAt} IS NULL AND ${table.status} = 'eaten'`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type NewApiTokenRow = typeof apiTokens.$inferInsert;
export type MealEntryRow = typeof mealEntries.$inferSelect;
export type NewMealEntryRow = typeof mealEntries.$inferInsert;
export const weightEntries = pgTable(
  "weight_entries",
  {
    id: uuid("id").primaryKey().notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entryDate: date("entry_date").notNull(),
    weightKg: numeric("weight_kg", { precision: 5, scale: 2 }).notNull(),
    bodyFatPct: numeric("body_fat_pct", { precision: 4, scale: 1 }),
    notes: text("notes"),
    ...createdUpdatedTimestamps(),
  },
  (table) => [
    uniqueIndex("weight_entries_user_date_key").on(
      table.userId,
      table.entryDate,
    ),
    index("weight_entries_user_date_idx").on(table.userId, table.entryDate),
  ],
);

export const recipes = pgTable(
  "recipes",
  {
    id: uuid("id").primaryKey().notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    portions: integer("portions").notNull().default(1),
    totalCookedWeightG: numeric("total_cooked_weight_g", {
      precision: 8,
      scale: 2,
    }),
    ...createdUpdatedTimestamps(),
  },
  (table) => [
    index("recipes_user_idx").on(table.userId),
  ],
);

export const recipeIngredients = pgTable(
  "recipe_ingredients",
  {
    id: uuid("id").primaryKey().notNull(),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => foodProducts.id, {
      onDelete: "set null",
    }),
    sortOrder: integer("sort_order").notNull(),
    label: text("label").notNull(),
    ...mealMacroColumns(),
    createdAt: createdAtTimestamp(),
  },
  (table) => [
    index("recipe_ingredients_recipe_idx").on(table.recipeId),
    index("recipe_ingredients_product_idx").on(table.productId),
  ],
);

export const mealTemplates = pgTable(
  "meal_templates",
  {
    id: uuid("id").primaryKey().notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("meal"),
    label: text("label").notNull(),
    notes: text("notes"),
    ...softDeleteTimestamps(),
  },
  (table) => [
    index("meal_templates_user_type_idx").on(table.userId, table.type),
    index("meal_templates_deleted_at_idx").on(table.deletedAt),
  ],
);

export const mealTemplateItems = pgTable(
  "meal_template_items",
  {
    id: uuid("id").primaryKey().notNull(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => mealTemplates.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => foodProducts.id, {
      onDelete: "set null",
    }),
    mealGroupLabel: text("meal_group_label"),
    sortOrder: integer("sort_order").notNull(),
    label: text("label").notNull(),
    ...mealMacroColumns(),
    createdAt: createdAtTimestamp(),
  },
  (table) => [
    index("meal_template_items_template_idx").on(table.templateId),
    index("meal_template_items_product_idx").on(table.productId),
  ],
);

export type WeightEntryRow = typeof weightEntries.$inferSelect;
export type NewWeightEntryRow = typeof weightEntries.$inferInsert;
export type RecipeRow = typeof recipes.$inferSelect;
export type NewRecipeRow = typeof recipes.$inferInsert;
export type RecipeIngredientRow = typeof recipeIngredients.$inferSelect;
export type NewRecipeIngredientRow = typeof recipeIngredients.$inferInsert;
export type FoodProductRow = typeof foodProducts.$inferSelect;
export type NewFoodProductRow = typeof foodProducts.$inferInsert;
export type FoodProductRevisionRow = typeof foodProductRevisions.$inferSelect;
export type NewFoodProductRevisionRow = typeof foodProductRevisions.$inferInsert;
export type MealGroupRow = typeof mealGroups.$inferSelect;
export type NewMealGroupRow = typeof mealGroups.$inferInsert;
export type MealTemplateRow = typeof mealTemplates.$inferSelect;
export type NewMealTemplateRow = typeof mealTemplates.$inferInsert;
export type MealTemplateItemRow = typeof mealTemplateItems.$inferSelect;
export type NewMealTemplateItemRow = typeof mealTemplateItems.$inferInsert;
export type AdminAuditEventRow = typeof adminAuditEvents.$inferSelect;
export type NewAdminAuditEventRow = typeof adminAuditEvents.$inferInsert;
