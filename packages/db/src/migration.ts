import { migrate as migrateNode } from "drizzle-orm/node-postgres/migrator";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { type PgliteDatabase } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";

import { createDatabaseRuntime, getDatabaseRuntime, type DatabaseRuntime } from "./client";
import * as schema from "./schema";
import { resolveDestructiveTestDatabaseUrl } from "./test-database-safety";

const migratedPostgresTestDatabaseUrls = new Set<string>();

function getMigrationsFolder() {
  return fileURLToPath(new URL("../drizzle", import.meta.url));
}

export async function migrateDatabase(runtime: DatabaseRuntime) {
  if (runtime.mode === "postgres") {
    await migrateNode(runtime.db as NodePgDatabase<typeof schema>, {
      migrationsFolder: getMigrationsFolder(),
    });
    return;
  }

  await migratePglite(runtime.db as PgliteDatabase<typeof schema>, {
    migrationsFolder: getMigrationsFolder(),
  });
}

export async function migrateCurrentDatabase() {
  const runtime = await getDatabaseRuntime();
  await migrateDatabase(runtime);
}

export async function migrateDatabaseUrl(connectionString: string) {
  const runtime = await createDatabaseRuntime(connectionString);
  try {
    await migrateDatabase(runtime);
  } finally {
    await runtime.close();
  }
}

async function migratePostgresTestDatabaseOnce(
  runtime: DatabaseRuntime,
  databaseUrl: string,
) {
  if (migratedPostgresTestDatabaseUrls.has(databaseUrl)) {
    return;
  }

  await migrateDatabase(runtime);
  migratedPostgresTestDatabaseUrls.add(databaseUrl);
}

export async function createMigratedTestDatabase() {
  const databaseUrl = resolveDestructiveTestDatabaseUrl(process.env, {
    explicitEnvNames: ["TEST_DATABASE_URL"],
    purpose: "database unit tests",
  });
  if (
    databaseUrl &&
    !databaseUrl.startsWith("file:") &&
    databaseUrl !== "memory:"
  ) {
    const runtime = await createDatabaseRuntime(databaseUrl);
    await migratePostgresTestDatabaseOnce(runtime, databaseUrl);
    await runtime.db.execute(sql.raw(`
      TRUNCATE TABLE
        admin_audit_events,
        api_tokens,
        meal_template_items,
        meal_templates,
        recipe_ingredients,
        recipes,
        weight_entries,
        meal_entries,
        meal_groups,
        food_product_revisions,
        food_products,
        users
      RESTART IDENTITY CASCADE
    `));
    return runtime;
  }

  const runtime = await createDatabaseRuntime("memory:");
  await migrateDatabase(runtime);
  return runtime;
}
