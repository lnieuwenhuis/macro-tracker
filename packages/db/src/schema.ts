import {
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const barcodeProducts = pgTable(
  "barcode_products",
  {
    id: uuid("id").primaryKey().notNull(),
    barcode: text("barcode").notNull(),
    name: text("name").notNull(),
    brands: text("brands").notNull().default(""),
    proteinG: numeric("protein_g", { precision: 6, scale: 1 }).notNull(),
    carbsG: numeric("carbs_g", { precision: 6, scale: 1 }).notNull(),
    fatG: numeric("fat_g", { precision: 6, scale: 1 }).notNull(),
    caloriesKcal: integer("calories_kcal").notNull(),
    servingSizeG: numeric("serving_size_g", { precision: 6, scale: 1 }),
    addedByUserId: uuid("added_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: uuid("deleted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("barcode_products_barcode_key").on(table.barcode),
    index("barcode_products_deleted_at_idx").on(table.deletedAt),
  ],
);

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
  },
  (table) => [
    uniqueIndex("users_shoo_pairwise_sub_key").on(table.shooPairwiseSub),
    uniqueIndex("users_email_key").on(table.email),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("admin_audit_events_created_at_idx").on(table.createdAt),
    index("admin_audit_events_target_idx").on(table.targetType, table.targetId),
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
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull(),
    proteinG: numeric("protein_g", { precision: 6, scale: 1 }).notNull(),
    carbsG: numeric("carbs_g", { precision: 6, scale: 1 }).notNull(),
    fatG: numeric("fat_g", { precision: 6, scale: 1 }).notNull(),
    caloriesKcal: integer("calories_kcal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("meal_entries_user_date_idx").on(table.userId, table.entryDate),
    index("meal_entries_user_date_sort_idx").on(
      table.userId,
      table.entryDate,
      table.sortOrder,
    ),
  ],
);

export const foodPresets = pgTable(
  "food_presets",
  {
    id: uuid("id").primaryKey().notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    proteinG: numeric("protein_g", { precision: 6, scale: 1 }).notNull(),
    carbsG: numeric("carbs_g", { precision: 6, scale: 1 }).notNull(),
    fatG: numeric("fat_g", { precision: 6, scale: 1 }).notNull(),
    caloriesKcal: integer("calories_kcal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    index("food_presets_user_idx").on(table.userId),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
    sortOrder: integer("sort_order").notNull(),
    label: text("label").notNull(),
    proteinG: numeric("protein_g", { precision: 6, scale: 1 }).notNull(),
    carbsG: numeric("carbs_g", { precision: 6, scale: 1 }).notNull(),
    fatG: numeric("fat_g", { precision: 6, scale: 1 }).notNull(),
    caloriesKcal: integer("calories_kcal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("recipe_ingredients_recipe_idx").on(table.recipeId),
  ],
);

export type FoodPresetRow = typeof foodPresets.$inferSelect;
export type NewFoodPresetRow = typeof foodPresets.$inferInsert;
export type WeightEntryRow = typeof weightEntries.$inferSelect;
export type NewWeightEntryRow = typeof weightEntries.$inferInsert;
export type RecipeRow = typeof recipes.$inferSelect;
export type NewRecipeRow = typeof recipes.$inferInsert;
export type RecipeIngredientRow = typeof recipeIngredients.$inferSelect;
export type NewRecipeIngredientRow = typeof recipeIngredients.$inferInsert;
export type BarcodeProductRow = typeof barcodeProducts.$inferSelect;
export type NewBarcodeProductRow = typeof barcodeProducts.$inferInsert;
export type AdminAuditEventRow = typeof adminAuditEvents.$inferSelect;
export type NewAdminAuditEventRow = typeof adminAuditEvents.$inferInsert;
