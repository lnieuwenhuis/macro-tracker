import { migrate as migrateNode } from "drizzle-orm/node-postgres/migrator";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { type PgliteDatabase } from "drizzle-orm/pglite";
import { fileURLToPath } from "node:url";

import { createDatabaseRuntime, getDatabaseRuntime, type DatabaseRuntime } from "./client";
import * as schema from "./schema";

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

export async function createMigratedTestDatabase() {
  const runtime = await createDatabaseRuntime("memory:");
  await migrateDatabase(runtime);
  return runtime;
}
