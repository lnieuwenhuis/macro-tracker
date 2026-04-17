import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { migrate as migrateNode } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzleNode, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { dirname, resolve } from "node:path";

import * as schema from "./schema";

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

function getMigrationsFolder() {
  return resolve(dbPackageRoot, "drizzle");
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

function isPgliteConnectionString(connectionString: string) {
  return connectionString === "memory:" || connectionString.startsWith("file:");
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

function getSslConfig(connectionString: string) {
  if (
    /sslmode=disable/i.test(connectionString) ||
    /localhost|127\.0\.0\.1/i.test(connectionString)
  ) {
    return false;
  }

  return { rejectUnauthorized: false };
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
      "goal_weight_kg" numeric(5, 2)
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
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "meal_entries" (
      "id" uuid PRIMARY KEY NOT NULL,
      "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
      "entry_date" date NOT NULL,
      "label" text NOT NULL,
      "sort_order" integer NOT NULL,
      "protein_g" numeric(6, 1) NOT NULL,
      "carbs_g" numeric(6, 1) NOT NULL,
      "fat_g" numeric(6, 1) NOT NULL,
      "calories_kcal" integer NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `));
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
  await db.execute(
    sql.raw(
      `ALTER TABLE "food_presets" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone`,
    ),
  );
  await db.execute(
    sql.raw(
      `CREATE INDEX IF NOT EXISTS "food_presets_user_idx" ON "food_presets" USING btree ("user_id")`,
    ),
  );
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
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `));
  await db.execute(
    sql.raw(
      `CREATE INDEX IF NOT EXISTS "recipes_user_idx" ON "recipes" USING btree ("user_id")`,
    ),
  );
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "recipe_ingredients" (
      "id" uuid PRIMARY KEY NOT NULL,
      "recipe_id" uuid NOT NULL REFERENCES "recipes"("id") ON DELETE cascade,
      "sort_order" integer NOT NULL,
      "label" text NOT NULL,
      "protein_g" numeric(6, 1) NOT NULL,
      "carbs_g" numeric(6, 1) NOT NULL,
      "fat_g" numeric(6, 1) NOT NULL,
      "calories_kcal" integer NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `));
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

async function ensureDatabaseSchema(runtime: DatabaseRuntime) {
  if (runtime.mode === "postgres") {
    console.info("Ensuring database schema via Drizzle migrations");
    await migrateNode(runtime.db as NodePgDatabase<typeof schema>, {
      migrationsFolder: getMigrationsFolder(),
    });
    console.info("Database schema is ready");
  }

  return runtime;
}

export async function createDatabaseRuntime(
  connectionString = process.env.DATABASE_URL,
): Promise<DatabaseRuntime> {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required.");
  }

  if (isPgliteConnectionString(connectionString)) {
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

  const pool = new Pool({
    connectionString,
    ssl: getSslConfig(connectionString),
  });
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
    globalDatabaseState.__macroTrackerRuntime = createDatabaseRuntime().then(
      ensureDatabaseSchema,
    );
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
