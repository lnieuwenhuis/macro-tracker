import {
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().notNull(),
    shooPairwiseSub: text("shoo_pairwise_sub").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    pictureUrl: text("picture_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("users_shoo_pairwise_sub_key").on(table.shooPairwiseSub),
    uniqueIndex("users_email_key").on(table.email),
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

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type MealEntryRow = typeof mealEntries.$inferSelect;
export type NewMealEntryRow = typeof mealEntries.$inferInsert;
