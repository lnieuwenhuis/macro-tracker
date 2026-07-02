import { sql } from "drizzle-orm";
import { drizzle as drizzleNode, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { dirname, resolve } from "node:path";

import * as schema from "./schema";
import {
  getPostgresConnectionConfig,
  isPgliteConnectionString,
} from "./postgres-config.js";

export {
  getPostgresConnectionConfig,
  getSslConfig,
  isPgliteConnectionString,
} from "./postgres-config.js";

export type DatabaseClient =
  | NodePgDatabase<typeof schema>
  | PgliteDatabase<typeof schema>;

export type DatabaseRuntime = {
  db: DatabaseClient;
  mode: "postgres" | "pglite-memory" | "pglite-file";
  close: () => Promise<void>;
};

const globalDatabaseState = globalThis as typeof globalThis & {
  __macroTrackerRuntime?: Promise<DatabaseRuntime>;
  __macroTrackerPgliteAssets?: Promise<PgliteAssets>;
};

type PgliteAssets = {
  fsBundle: Blob;
  pgliteWasmModule: WebAssembly.Module;
  initdbWasmModule: WebAssembly.Module;
};

function findDbPackageJsonPath() {
  let currentDir = process.cwd();

  while (true) {
    const workspaceCandidate = resolve(currentDir, "packages", "db", "package.json");
    if (existsSync(workspaceCandidate)) {
      return workspaceCandidate;
    }

    const directCandidate = resolve(currentDir, "package.json");
    const directNodeModulesCandidate = resolve(
      currentDir,
      "node_modules",
      "@electric-sql",
      "pglite",
    );

    if (existsSync(directCandidate) && existsSync(directNodeModulesCandidate)) {
      return directCandidate;
    }

    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
  }

  return resolve(process.cwd(), "packages", "db", "package.json");
}

const dbPackageRoot = dirname(findDbPackageJsonPath());
const pgliteDistPath = resolve(
  dbPackageRoot,
  "node_modules",
  "@electric-sql",
  "pglite",
  "dist",
);

function getPgliteAssetPath(fileName: string) {
  return resolve(pgliteDistPath, fileName);
}

function deterministicUuidSql(seedExpression: string) {
  return `(
        substr(md5(${seedExpression}), 1, 8) || '-' ||
        substr(md5(${seedExpression}), 9, 4) || '-' ||
        substr(md5(${seedExpression}), 13, 4) || '-' ||
        substr(md5(${seedExpression}), 17, 4) || '-' ||
        substr(md5(${seedExpression}), 21, 12)
      )::uuid`;
}

async function loadPgliteAssets(): Promise<PgliteAssets> {
  const [fsBundleBuffer, pgliteWasmBuffer, initdbWasmBuffer] = await Promise.all([
    readFile(getPgliteAssetPath("pglite.data")),
    readFile(getPgliteAssetPath("pglite.wasm")),
    readFile(getPgliteAssetPath("initdb.wasm")),
  ]);

  const [pgliteWasmModule, initdbWasmModule] = await Promise.all([
    WebAssembly.compile(pgliteWasmBuffer),
    WebAssembly.compile(initdbWasmBuffer),
  ]);

  return {
    fsBundle: new Blob([fsBundleBuffer]),
    pgliteWasmModule,
    initdbWasmModule,
  };
}

async function getPgliteAssets() {
  if (!globalDatabaseState.__macroTrackerPgliteAssets) {
    globalDatabaseState.__macroTrackerPgliteAssets = loadPgliteAssets();
  }

  return globalDatabaseState.__macroTrackerPgliteAssets;
}

function getPglitePath(connectionString: string) {
  if (connectionString === "memory:") {
    return undefined;
  }

  return resolve(
    /* turbopackIgnore: true */ process.cwd(),
    connectionString.slice("file:".length),
  );
}

async function bootstrapLocalSchema(db: PgliteDatabase<typeof schema>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "users" (
      "id" uuid PRIMARY KEY NOT NULL,
      "shoo_pairwise_sub" text NOT NULL,
      "email" text NOT NULL,
      "display_name" text,
      "picture_url" text,
      "role" text DEFAULT 'user' NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "last_login_at" timestamp with time zone DEFAULT now() NOT NULL,
      "goal_calories_kcal" integer,
      "goal_protein_g" numeric(6, 1),
      "goal_carbs_g" numeric(6, 1),
      "goal_fat_g" numeric(6, 1),
      "goal_weight_kg" numeric(5, 2),
      "onboarding_completed_at" timestamp with time zone,
      "preferred_weight_unit" text DEFAULT 'kg' NOT NULL
    )
  `));
  await db.execute(
    sql.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS "users_shoo_pairwise_sub_key" ON "users" USING btree ("shoo_pairwise_sub")`,
    ),
  );
  await db.execute(
    sql.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users" USING btree ("email")`,
    ),
  );
  await db.execute(
    sql.raw(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'user' NOT NULL`,
    ),
  );
  await db.execute(
    sql.raw(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarding_completed_at" timestamp with time zone`,
    ),
  );
  await db.execute(
    sql.raw(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "preferred_weight_unit" text DEFAULT 'kg' NOT NULL`,
    ),
  );
  await db.execute(sql.raw(`
    UPDATE "users"
    SET "onboarding_completed_at" = COALESCE("onboarding_completed_at", "created_at", now())
    WHERE "onboarding_completed_at" IS NULL
  `));
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "api_tokens" (
      "id" uuid PRIMARY KEY NOT NULL,
      "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
      "token_hash" text NOT NULL,
      "token_prefix" text NOT NULL,
      "name" text NOT NULL,
      "scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "last_used_at" timestamp with time zone,
      "expires_at" timestamp with time zone,
      "revoked_at" timestamp with time zone
    )
  `));
  await db.execute(
    sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS "api_tokens_token_hash_key" ON "api_tokens" USING btree ("token_hash")`),
  );
  await db.execute(
    sql.raw(`CREATE INDEX IF NOT EXISTS "api_tokens_user_created_idx" ON "api_tokens" USING btree ("user_id","created_at")`),
  );
  await db.execute(
    sql.raw(`CREATE INDEX IF NOT EXISTS "api_tokens_user_revoked_idx" ON "api_tokens" USING btree ("user_id","revoked_at")`),
  );
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "food_products" (
      "id" uuid PRIMARY KEY NOT NULL,
      "owner_user_id" uuid REFERENCES "users"("id") ON DELETE cascade,
      "scope" text DEFAULT 'personal' NOT NULL,
      "source" text DEFAULT 'manual' NOT NULL,
      "barcode" text,
      "name" text NOT NULL,
      "brand" text DEFAULT '' NOT NULL,
      "default_serving_quantity" numeric(8, 2) DEFAULT '1' NOT NULL,
      "default_serving_unit" text DEFAULT 'serving' NOT NULL,
      "protein_per_100" numeric(7, 2) NOT NULL,
      "carbs_per_100" numeric(7, 2) NOT NULL,
      "fat_per_100" numeric(7, 2) NOT NULL,
      "calories_per_100" integer NOT NULL,
      "serving_weight_g" numeric(8, 2),
      "serving_volume_ml" numeric(8, 2),
      "submitted_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
      "deleted_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
      "source_provider" text,
      "source_confidence" numeric(4, 2),
      "source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
      "corrected_from_product_id" uuid REFERENCES "food_products"("id") ON DELETE SET NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      "deleted_at" timestamp with time zone
    )
  `));
  await db.execute(sql.raw(`ALTER TABLE "food_products" ADD COLUMN IF NOT EXISTS "submitted_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL`));
  await db.execute(sql.raw(`ALTER TABLE "food_products" ADD COLUMN IF NOT EXISTS "deleted_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL`));
  await db.execute(sql.raw(`ALTER TABLE "food_products" ADD COLUMN IF NOT EXISTS "source_provider" text`));
  await db.execute(sql.raw(`ALTER TABLE "food_products" ADD COLUMN IF NOT EXISTS "source_confidence" numeric(4, 2)`));
  await db.execute(sql.raw(`ALTER TABLE "food_products" ADD COLUMN IF NOT EXISTS "source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL`));
  await db.execute(sql.raw(`ALTER TABLE "food_products" ADD COLUMN IF NOT EXISTS "corrected_from_product_id" uuid REFERENCES "food_products"("id") ON DELETE SET NULL`));
  await db.execute(
    sql.raw(`CREATE INDEX IF NOT EXISTS "food_products_owner_name_idx" ON "food_products" USING btree ("owner_user_id","name")`),
  );
  await db.execute(
    sql.raw(`CREATE INDEX IF NOT EXISTS "food_products_barcode_idx" ON "food_products" USING btree ("barcode")`),
  );
  await db.execute(sql.raw(`
    WITH active_global_barcode_duplicates AS (
      SELECT
        "id",
        row_number() OVER (
          PARTITION BY "barcode"
          ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
        ) AS "duplicate_rank"
      FROM "food_products"
      WHERE
        "owner_user_id" IS NULL
        AND "source" = 'barcode'
        AND "deleted_at" IS NULL
        AND "barcode" IS NOT NULL
    )
    UPDATE "food_products"
    SET
      "deleted_at" = now(),
      "updated_at" = now(),
      "source_metadata" = COALESCE("source_metadata", '{}'::jsonb) || jsonb_build_object(
        'deduplicatedByMigration',
        '0011_active_global_barcode_unique'
      )
    FROM active_global_barcode_duplicates
    WHERE
      "food_products"."id" = active_global_barcode_duplicates."id"
      AND active_global_barcode_duplicates."duplicate_rank" > 1
  `));
  await db.execute(
    sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS "food_products_active_global_barcode_key" ON "food_products" USING btree ("barcode") WHERE "owner_user_id" IS NULL AND "source" = 'barcode' AND "deleted_at" IS NULL AND "barcode" IS NOT NULL`),
  );
  await db.execute(
    sql.raw(`CREATE INDEX IF NOT EXISTS "food_products_scope_source_idx" ON "food_products" USING btree ("scope","source")`),
  );
  await db.execute(
    sql.raw(`CREATE INDEX IF NOT EXISTS "food_products_deleted_at_idx" ON "food_products" USING btree ("deleted_at")`),
  );
  await db.execute(
    sql.raw(`CREATE INDEX IF NOT EXISTS "food_products_submitted_by_idx" ON "food_products" USING btree ("submitted_by_user_id")`),
  );
  await db.execute(
    sql.raw(`CREATE INDEX IF NOT EXISTS "food_products_corrected_from_idx" ON "food_products" USING btree ("corrected_from_product_id")`),
  );
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "food_product_revisions" (
      "id" uuid PRIMARY KEY NOT NULL,
      "product_id" uuid NOT NULL REFERENCES "food_products"("id") ON DELETE cascade,
      "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
      "action" text NOT NULL,
      "snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `));
  await db.execute(
    sql.raw(`CREATE INDEX IF NOT EXISTS "food_product_revisions_product_idx" ON "food_product_revisions" USING btree ("product_id")`),
  );
  await db.execute(
    sql.raw(`CREATE INDEX IF NOT EXISTS "food_product_revisions_actor_idx" ON "food_product_revisions" USING btree ("actor_user_id")`),
  );
  await db.execute(
    sql.raw(`CREATE INDEX IF NOT EXISTS "food_product_revisions_created_at_idx" ON "food_product_revisions" USING btree ("created_at")`),
  );
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "meal_groups" (
      "id" uuid PRIMARY KEY NOT NULL,
      "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
      "label" text NOT NULL,
      "sort_order" integer NOT NULL,
      "is_default" boolean DEFAULT false NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      "deleted_at" timestamp with time zone
    )
  `));
  await db.execute(
    sql.raw(`CREATE INDEX IF NOT EXISTS "meal_groups_user_sort_idx" ON "meal_groups" USING btree ("user_id","sort_order")`),
  );
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "meal_entries" (
      "id" uuid PRIMARY KEY NOT NULL,
      "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
      "entry_date" date NOT NULL,
      "meal_group_id" uuid REFERENCES "meal_groups"("id") ON DELETE SET NULL,
      "status" text DEFAULT 'eaten' NOT NULL,
      "product_id" uuid REFERENCES "food_products"("id") ON DELETE SET NULL,
      "label" text NOT NULL,
      "sort_order" integer NOT NULL,
      "quantity" numeric(8, 2) DEFAULT '1' NOT NULL,
      "unit" text DEFAULT 'serving' NOT NULL,
      "serving_multiplier" numeric(8, 2) DEFAULT '1' NOT NULL,
      "protein_g" numeric(6, 1) NOT NULL,
      "carbs_g" numeric(6, 1) NOT NULL,
      "fat_g" numeric(6, 1) NOT NULL,
      "calories_kcal" integer NOT NULL,
      "client_mutation_id" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `));
  await db.execute(sql.raw(`ALTER TABLE "meal_entries" ADD COLUMN IF NOT EXISTS "meal_group_id" uuid`));
  await db.execute(sql.raw(`ALTER TABLE "meal_entries" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'eaten' NOT NULL`));
  await db.execute(sql.raw(`ALTER TABLE "meal_entries" ADD COLUMN IF NOT EXISTS "product_id" uuid`));
  await db.execute(sql.raw(`ALTER TABLE "meal_entries" ADD COLUMN IF NOT EXISTS "quantity" numeric(8, 2) DEFAULT '1' NOT NULL`));
  await db.execute(sql.raw(`ALTER TABLE "meal_entries" ADD COLUMN IF NOT EXISTS "unit" text DEFAULT 'serving' NOT NULL`));
  await db.execute(sql.raw(`ALTER TABLE "meal_entries" ADD COLUMN IF NOT EXISTS "serving_multiplier" numeric(8, 2) DEFAULT '1' NOT NULL`));
  await db.execute(sql.raw(`ALTER TABLE "meal_entries" ADD COLUMN IF NOT EXISTS "client_mutation_id" text`));
  await db.execute(
    sql.raw(
      `CREATE INDEX IF NOT EXISTS "meal_entries_user_date_idx" ON "meal_entries" USING btree ("user_id","entry_date")`,
    ),
  );
  await db.execute(
    sql.raw(
      `CREATE INDEX IF NOT EXISTS "meal_entries_user_date_sort_idx" ON "meal_entries" USING btree ("user_id","entry_date","sort_order")`,
    ),
  );
  await db.execute(
    sql.raw(`CREATE INDEX IF NOT EXISTS "meal_entries_user_date_status_idx" ON "meal_entries" USING btree ("user_id","entry_date","status")`),
  );
  await db.execute(
    sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS "meal_entries_user_client_mutation_key" ON "meal_entries" USING btree ("user_id","client_mutation_id")`),
  );
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "food_presets" (
      "id" uuid PRIMARY KEY NOT NULL,
      "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
      "label" text NOT NULL,
      "protein_g" numeric(6, 1) NOT NULL,
      "carbs_g" numeric(6, 1) NOT NULL,
      "fat_g" numeric(6, 1) NOT NULL,
      "calories_kcal" integer NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "last_used_at" timestamp with time zone
    )
  `));
  await db.execute(sql.raw(`ALTER TABLE "food_presets" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone`));
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "meal_templates" (
      "id" uuid PRIMARY KEY NOT NULL,
      "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
      "type" text DEFAULT 'meal' NOT NULL,
      "label" text NOT NULL,
      "notes" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      "deleted_at" timestamp with time zone
    )
  `));
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "meal_template_items" (
      "id" uuid PRIMARY KEY NOT NULL,
      "template_id" uuid NOT NULL REFERENCES "meal_templates"("id") ON DELETE cascade,
      "product_id" uuid REFERENCES "food_products"("id") ON DELETE SET NULL,
      "meal_group_label" text,
      "sort_order" integer NOT NULL,
      "label" text NOT NULL,
      "quantity" numeric(8, 2) DEFAULT '1' NOT NULL,
      "unit" text DEFAULT 'serving' NOT NULL,
      "serving_multiplier" numeric(8, 2) DEFAULT '1' NOT NULL,
      "protein_g" numeric(6, 1) NOT NULL,
      "carbs_g" numeric(6, 1) NOT NULL,
      "fat_g" numeric(6, 1) NOT NULL,
      "calories_kcal" integer NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `));
  await db.execute(
    sql.raw(`CREATE INDEX IF NOT EXISTS "meal_templates_user_type_idx" ON "meal_templates" USING btree ("user_id","type")`),
  );
  await db.execute(
    sql.raw(`CREATE INDEX IF NOT EXISTS "meal_templates_deleted_at_idx" ON "meal_templates" USING btree ("deleted_at")`),
  );
  await db.execute(
    sql.raw(`CREATE INDEX IF NOT EXISTS "meal_template_items_template_idx" ON "meal_template_items" USING btree ("template_id")`),
  );
  await db.execute(
    sql.raw(`CREATE INDEX IF NOT EXISTS "meal_template_items_product_idx" ON "meal_template_items" USING btree ("product_id")`),
  );
  await db.execute(sql.raw(`
    INSERT INTO "meal_templates" (
      "id",
      "user_id",
      "type",
      "label",
      "created_at",
      "updated_at"
    )
    SELECT
      "food_presets"."id",
      "food_presets"."user_id",
      'meal',
      "food_presets"."label",
      "food_presets"."created_at",
      COALESCE("food_presets"."last_used_at", "food_presets"."created_at")
    FROM "food_presets"
    ON CONFLICT ("id") DO NOTHING
  `));
  await db.execute(sql.raw(`
    INSERT INTO "meal_template_items" (
      "id",
      "template_id",
      "product_id",
      "meal_group_label",
      "sort_order",
      "label",
      "quantity",
      "unit",
      "serving_multiplier",
      "protein_g",
      "carbs_g",
      "fat_g",
      "calories_kcal",
      "created_at"
    )
    SELECT
      ${deterministicUuidSql(`'meal-template-item:preset:' || "food_presets"."id"::text`)},
      "food_presets"."id",
      NULL,
      NULL,
      0,
      "food_presets"."label",
      '1.00',
      'serving',
      '1.00',
      "food_presets"."protein_g",
      "food_presets"."carbs_g",
      "food_presets"."fat_g",
      "food_presets"."calories_kcal",
      "food_presets"."created_at"
    FROM "food_presets"
    ON CONFLICT ("id") DO NOTHING
  `));
  await db.execute(sql.raw(`DROP TABLE IF EXISTS "food_presets"`));
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "weight_entries" (
      "id" uuid PRIMARY KEY NOT NULL,
      "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
      "entry_date" date NOT NULL,
      "weight_kg" numeric(5, 2) NOT NULL,
      "body_fat_pct" numeric(4, 1),
      "notes" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `));
  await db.execute(
    sql.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS "weight_entries_user_date_key" ON "weight_entries" USING btree ("user_id","entry_date")`,
    ),
  );
  await db.execute(
    sql.raw(
      `CREATE INDEX IF NOT EXISTS "weight_entries_user_date_idx" ON "weight_entries" USING btree ("user_id","entry_date")`,
    ),
  );
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "recipes" (
      "id" uuid PRIMARY KEY NOT NULL,
      "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
      "label" text NOT NULL,
      "portions" integer DEFAULT 1 NOT NULL,
      "total_cooked_weight_g" numeric(8, 2),
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `));
  await db.execute(sql.raw(`ALTER TABLE "recipes" ADD COLUMN IF NOT EXISTS "total_cooked_weight_g" numeric(8, 2)`));
  await db.execute(
    sql.raw(
      `CREATE INDEX IF NOT EXISTS "recipes_user_idx" ON "recipes" USING btree ("user_id")`,
    ),
  );
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "recipe_ingredients" (
      "id" uuid PRIMARY KEY NOT NULL,
      "recipe_id" uuid NOT NULL REFERENCES "recipes"("id") ON DELETE cascade,
      "product_id" uuid REFERENCES "food_products"("id") ON DELETE SET NULL,
      "sort_order" integer NOT NULL,
      "label" text NOT NULL,
      "quantity" numeric(8, 2) DEFAULT '1' NOT NULL,
      "unit" text DEFAULT 'serving' NOT NULL,
      "serving_multiplier" numeric(8, 2) DEFAULT '1' NOT NULL,
      "protein_g" numeric(6, 1) NOT NULL,
      "carbs_g" numeric(6, 1) NOT NULL,
      "fat_g" numeric(6, 1) NOT NULL,
      "calories_kcal" integer NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `));
  await db.execute(sql.raw(`ALTER TABLE "recipe_ingredients" ADD COLUMN IF NOT EXISTS "product_id" uuid`));
  await db.execute(sql.raw(`ALTER TABLE "recipe_ingredients" ADD COLUMN IF NOT EXISTS "quantity" numeric(8, 2) DEFAULT '1' NOT NULL`));
  await db.execute(sql.raw(`ALTER TABLE "recipe_ingredients" ADD COLUMN IF NOT EXISTS "unit" text DEFAULT 'serving' NOT NULL`));
  await db.execute(sql.raw(`ALTER TABLE "recipe_ingredients" ADD COLUMN IF NOT EXISTS "serving_multiplier" numeric(8, 2) DEFAULT '1' NOT NULL`));
  await db.execute(
    sql.raw(
      `CREATE INDEX IF NOT EXISTS "recipe_ingredients_recipe_idx" ON "recipe_ingredients" USING btree ("recipe_id")`,
    ),
  );
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "barcode_products" (
      "id" uuid PRIMARY KEY NOT NULL,
      "barcode" text NOT NULL,
      "name" text NOT NULL,
      "brands" text DEFAULT '' NOT NULL,
      "protein_g" numeric(6, 1) NOT NULL,
      "carbs_g" numeric(6, 1) NOT NULL,
      "fat_g" numeric(6, 1) NOT NULL,
      "calories_kcal" integer NOT NULL,
      "serving_size_g" numeric(6, 1),
      "added_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      "deleted_at" timestamp with time zone,
      "deleted_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL
    )
  `));
  await db.execute(
    sql.raw(
      `ALTER TABLE "barcode_products" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL`,
    ),
  );
  await db.execute(
    sql.raw(
      `ALTER TABLE "barcode_products" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone`,
    ),
  );
  await db.execute(
    sql.raw(
      `ALTER TABLE "barcode_products" ADD COLUMN IF NOT EXISTS "deleted_by_user_id" uuid`,
    ),
  );
  await db.execute(
    sql.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS "barcode_products_barcode_key" ON "barcode_products" USING btree ("barcode")`,
    ),
  );
  await db.execute(
    sql.raw(
      `CREATE INDEX IF NOT EXISTS "barcode_products_deleted_at_idx" ON "barcode_products" USING btree ("deleted_at")`,
    ),
  );
  await db.execute(sql.raw(`
    UPDATE "food_products"
    SET
      "name" = "barcode_products"."name",
      "brand" = "barcode_products"."brands",
      "default_serving_quantity" = '1.00',
      "default_serving_unit" = 'serving',
      "protein_per_100" = "barcode_products"."protein_g",
      "carbs_per_100" = "barcode_products"."carbs_g",
      "fat_per_100" = "barcode_products"."fat_g",
      "calories_per_100" = "barcode_products"."calories_kcal",
      "serving_weight_g" = COALESCE("barcode_products"."serving_size_g", '100.00'),
      "serving_volume_ml" = NULL,
      "submitted_by_user_id" = "barcode_products"."added_by_user_id",
      "deleted_by_user_id" = "barcode_products"."deleted_by_user_id",
      "source_provider" = COALESCE("food_products"."source_provider", 'community'),
      "source_metadata" = jsonb_build_object(
        'legacyBarcodeProductId', "barcode_products"."id",
        'servingSizeG', "barcode_products"."serving_size_g"
      ),
      "updated_at" = "barcode_products"."updated_at",
      "deleted_at" = "barcode_products"."deleted_at"
    FROM "barcode_products"
    WHERE
      "food_products"."owner_user_id" IS NULL
      AND "food_products"."source" = 'barcode'
      AND "food_products"."barcode" = "barcode_products"."barcode"
  `));
  await db.execute(sql.raw(`
    WITH source_barcode_products AS (
      SELECT
        ${deterministicUuidSql(`'global-barcode-food:' || "barcode_products"."barcode"`)} AS "id",
        "barcode_products"."barcode",
        "barcode_products"."name",
        "barcode_products"."brands",
        "barcode_products"."protein_g",
        "barcode_products"."carbs_g",
        "barcode_products"."fat_g",
        "barcode_products"."calories_kcal",
        "barcode_products"."serving_size_g",
        "barcode_products"."added_by_user_id",
        "barcode_products"."deleted_by_user_id",
        "barcode_products"."created_at",
        "barcode_products"."updated_at",
        "barcode_products"."deleted_at"
      FROM "barcode_products"
    )
    INSERT INTO "food_products" (
      "id",
      "owner_user_id",
      "scope",
      "source",
      "barcode",
      "name",
      "brand",
      "default_serving_quantity",
      "default_serving_unit",
      "protein_per_100",
      "carbs_per_100",
      "fat_per_100",
      "calories_per_100",
      "serving_weight_g",
      "serving_volume_ml",
      "submitted_by_user_id",
      "deleted_by_user_id",
      "source_provider",
      "source_metadata",
      "created_at",
      "updated_at",
      "deleted_at"
    )
    SELECT
      "id",
      NULL,
      'global',
      'barcode',
      "barcode",
      "name",
      "brands",
      '1.00',
      'serving',
      "protein_g",
      "carbs_g",
      "fat_g",
      "calories_kcal",
      COALESCE("serving_size_g", '100.00'),
      NULL,
      "added_by_user_id",
      "deleted_by_user_id",
      'community',
      jsonb_build_object(
        'legacyBarcodeProductId', "id",
        'servingSizeG', "serving_size_g"
      ),
      "created_at",
      "updated_at",
      "deleted_at"
    FROM source_barcode_products
    WHERE NOT EXISTS (
      SELECT 1
      FROM "food_products"
      WHERE
        "food_products"."owner_user_id" IS NULL
        AND "food_products"."source" = 'barcode'
        AND "food_products"."barcode" = source_barcode_products."barcode"
    )
  `));
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "admin_audit_events" (
      "id" uuid PRIMARY KEY NOT NULL,
      "actor_user_id" uuid NOT NULL REFERENCES "users"("id"),
      "actor_role" text NOT NULL,
      "action" text NOT NULL,
      "target_type" text NOT NULL,
      "target_id" text NOT NULL,
      "details_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `));
  await db.execute(sql.raw(`
    UPDATE "admin_audit_events"
    SET
      "target_type" = 'food_product',
      "target_id" = "food_products"."id"::text,
      "details_json" = COALESCE("admin_audit_events"."details_json", '{}'::jsonb) || jsonb_build_object(
        'legacyBarcodeProductId', "admin_audit_events"."target_id"
      )
    FROM "food_products"
    WHERE
      "admin_audit_events"."target_type" = 'barcode_product'
      AND "food_products"."owner_user_id" IS NULL
      AND "food_products"."source" = 'barcode'
      AND "food_products"."source_metadata"->>'legacyBarcodeProductId' = "admin_audit_events"."target_id"
  `));
  await db.execute(sql.raw(`
    INSERT INTO "food_product_revisions" (
      "id",
      "product_id",
      "actor_user_id",
      "action",
      "snapshot_json",
      "created_at"
    )
    SELECT
      ${deterministicUuidSql(`'food-product-revision:imported:' || "food_products"."id"::text`)},
      "food_products"."id",
      "food_products"."submitted_by_user_id",
      'imported',
      jsonb_build_object(
        'id', "food_products"."id",
        'scope', "food_products"."scope",
        'source', "food_products"."source",
        'barcode', "food_products"."barcode",
        'name', "food_products"."name",
        'brand', "food_products"."brand",
        'proteinPer100', "food_products"."protein_per_100",
        'carbsPer100', "food_products"."carbs_per_100",
        'fatPer100', "food_products"."fat_per_100",
        'caloriesPer100', "food_products"."calories_per_100",
        'servingWeightG', "food_products"."serving_weight_g",
        'servingVolumeMl', "food_products"."serving_volume_ml"
      ),
      "food_products"."created_at"
    FROM "food_products"
    WHERE NOT EXISTS (
      SELECT 1
      FROM "food_product_revisions"
      WHERE "food_product_revisions"."product_id" = "food_products"."id"
    )
    ON CONFLICT ("id") DO NOTHING
  `));
  await db.execute(sql.raw(`DROP TABLE IF EXISTS "barcode_products"`));
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "admin_audit_events" (
      "id" uuid PRIMARY KEY NOT NULL,
      "actor_user_id" uuid NOT NULL REFERENCES "users"("id"),
      "actor_role" text NOT NULL,
      "action" text NOT NULL,
      "target_type" text NOT NULL,
      "target_id" text NOT NULL,
      "details_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `));
  await db.execute(
    sql.raw(
      `CREATE INDEX IF NOT EXISTS "admin_audit_events_created_at_idx" ON "admin_audit_events" USING btree ("created_at")`,
    ),
  );
  await db.execute(
    sql.raw(
      `CREATE INDEX IF NOT EXISTS "admin_audit_events_target_idx" ON "admin_audit_events" USING btree ("target_type","target_id")`,
    ),
  );
}

export async function createDatabaseRuntime(
  connectionString = process.env.DATABASE_URL,
): Promise<DatabaseRuntime> {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required.");
  }

  if (isPgliteConnectionString(connectionString)) {
    const [{ PGlite }, { drizzle: drizzlePglite }] = await Promise.all([
      import("@electric-sql/pglite"),
      import("drizzle-orm/pglite"),
    ]);
    const client = new PGlite({
      dataDir: getPglitePath(connectionString),
      ...(await getPgliteAssets()),
    });
    const db = drizzlePglite(client, { schema });

    if (process.env.NODE_ENV !== "test") {
      await bootstrapLocalSchema(db);
    }

    return {
      db,
      mode: connectionString === "memory:" ? "pglite-memory" : "pglite-file",
      close: async () => {
        await client.close();
      },
    };
  }

  const pool = new Pool(getPostgresConnectionConfig(connectionString));
  const db = drizzleNode(pool, { schema });

  return {
    db,
    mode: "postgres",
    close: async () => {
      await pool.end();
    },
  };
}

export function setDatabaseRuntimeForTesting(runtime?: DatabaseRuntime) {
  globalDatabaseState.__macroTrackerRuntime = runtime
    ? Promise.resolve(runtime)
    : undefined;
}

export async function getDatabaseRuntime() {
  if (!globalDatabaseState.__macroTrackerRuntime) {
    globalDatabaseState.__macroTrackerRuntime = createDatabaseRuntime();
  }

  return globalDatabaseState.__macroTrackerRuntime;
}

export async function getDb() {
  const runtime = await getDatabaseRuntime();
  return runtime.db;
}

export async function closeDatabase() {
  if (!globalDatabaseState.__macroTrackerRuntime) {
    return;
  }

  const runtime = await globalDatabaseState.__macroTrackerRuntime;
  globalDatabaseState.__macroTrackerRuntime = undefined;
  await runtime.close();
}
