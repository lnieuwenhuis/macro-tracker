import { migrate as migrateNode } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
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

const POSTGRES_MIGRATION_LOCK_ID = 1_836_027_411;

/**
 * Bounds how long a blocked DDL statement (e.g. an `ALTER TABLE` fighting a
 * long-running query for a table lock) can hold up the migration before it
 * aborts and rolls back, instead of stalling every query queued behind it.
 * This runs as a Railway `preDeployCommand` while the previous version is
 * still serving traffic, so "hang forever" is not an acceptable failure mode.
 */
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 3_000;
/** Overall cap per migration statement, independent of lock waits. */
const DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS = 300_000;
/**
 * How long to keep retrying `pg_try_advisory_lock` before giving up. Without
 * a bound, a hung-but-alive previous migration process (holding the
 * advisory lock without releasing it) blocks every subsequent deploy
 * silently and indefinitely.
 */
const DEFAULT_MIGRATION_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
const MIGRATION_LOCK_RETRY_INTERVAL_MS = 1_000;

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type MigrationLockClient = {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: T[] }>;
};

/**
 * Applies the bounded statement/lock timeouts to the migration connection.
 * Must run before `migrateNode` touches the connection (DB-02).
 */
async function applyMigrationConnectionTimeouts(client: MigrationLockClient) {
  const lockTimeoutMs = readPositiveIntegerEnv(
    "MIGRATION_LOCK_TIMEOUT_MS",
    DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  );
  const statementTimeoutMs = readPositiveIntegerEnv(
    "MIGRATION_STATEMENT_TIMEOUT_MS",
    DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
  );

  // `SET` does not accept bind parameters; both values are validated
  // positive integers from readPositiveIntegerEnv, never raw env text.
  await client.query(`SET lock_timeout = ${lockTimeoutMs}`);
  await client.query(`SET statement_timeout = ${statementTimeoutMs}`);
}

/**
 * Acquires the migration advisory lock with `pg_try_advisory_lock` in a
 * bounded retry loop instead of the blocking `pg_advisory_lock`, so a
 * hung previous migration process fails the deploy loudly after
 * `MIGRATION_LOCK_ACQUIRE_TIMEOUT_MS` instead of blocking it forever (DB-07).
 */
async function acquireMigrationLock(client: MigrationLockClient) {
  const acquireTimeoutMs = readPositiveIntegerEnv(
    "MIGRATION_LOCK_ACQUIRE_TIMEOUT_MS",
    DEFAULT_MIGRATION_LOCK_ACQUIRE_TIMEOUT_MS,
  );
  const deadline = Date.now() + acquireTimeoutMs;

  for (;;) {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [POSTGRES_MIGRATION_LOCK_ID],
    );

    if (result.rows[0]?.acquired) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${acquireTimeoutMs}ms waiting for the database migration ` +
          `advisory lock (id ${POSTGRES_MIGRATION_LOCK_ID}). Another migration run may ` +
          "be hung holding it; investigate before retrying the deploy.",
      );
    }

    await sleep(MIGRATION_LOCK_RETRY_INTERVAL_MS);
  }
}

export async function migrateDatabase(
  runtime: DatabaseRuntime,
  migrationsFolder = getMigrationsFolder(),
) {
  if (runtime.mode === "postgres") {
    if (!runtime.migrationPool) {
      throw new Error("PostgreSQL migration pool is unavailable.");
    }

    const client = await runtime.migrationPool.connect();
    try {
      await applyMigrationConnectionTimeouts(client);
      await acquireMigrationLock(client);
      await migrateNode(drizzleNode(client, { schema }), { migrationsFolder });
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [POSTGRES_MIGRATION_LOCK_ID]);
      } finally {
        client.release();
      }
    }
    return;
  }

  await migratePglite(runtime.db as PgliteDatabase<typeof schema>, {
    migrationsFolder,
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
        gym_slot_statuses,
        gym_buddies,
        gym_slots,
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
