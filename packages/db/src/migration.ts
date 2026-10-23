import { migrate as migrateNode } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { type PgliteDatabase } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";

import { createDatabaseRuntime, getDatabaseRuntime, type DatabaseRuntime } from "./client";
import * as schema from "./schema";
import { readPositiveIntegerEnv } from "./postgres-config.js";
import { resolveDestructiveTestDatabaseUrl } from "./test-database-safety";

const migratedPostgresTestDatabaseUrls = new Set<string>();

function getMigrationsFolder() {
  return fileURLToPath(new URL("../drizzle", import.meta.url));
}

const POSTGRES_MIGRATION_LOCK_ID = 1_836_027_411;

// Caps how long blocked DDL stalls the migration, which runs as a Railway preDeployCommand while the old version still serves traffic.
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 3_000;
const DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS = 300_000;
// Without this bound, a hung-but-alive previous migration process holding the advisory lock blocks every subsequent deploy indefinitely.
const DEFAULT_MIGRATION_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
const MIGRATION_LOCK_RETRY_INTERVAL_MS = 1_000;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type MigrationLockClient = {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: T[] }>;
};

type MigrationSessionTimeouts = {
  lockTimeout: string;
  statementTimeout: string;
};

async function readMigrationSessionTimeouts(
  client: MigrationLockClient,
): Promise<MigrationSessionTimeouts> {
  const result = await client.query<{ lock_timeout: string; statement_timeout: string }>(
    "SELECT current_setting('lock_timeout') AS lock_timeout, " +
      "current_setting('statement_timeout') AS statement_timeout",
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Could not read the migration connection's session timeouts.");
  }

  return { lockTimeout: row.lock_timeout, statementTimeout: row.statement_timeout };
}

// TEST-02: the migration pool is reused for queries after createMigratedTestDatabase
// (and for startup migrations in the same process), so the session-level SETs above
// must not outlive the migration. set_config accepts parameters, unlike SET, and the
// values are PostgreSQL's own renderings read back from current_setting.
async function restoreMigrationSessionTimeouts(
  client: MigrationLockClient,
  previous: MigrationSessionTimeouts,
) {
  await client.query(
    "SELECT set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)",
    [previous.lockTimeout, previous.statementTimeout],
  );
}

// Must run before migrateNode touches the connection (DB-02).
async function applyMigrationConnectionTimeouts(client: MigrationLockClient) {
  const lockTimeoutMs = readPositiveIntegerEnv(
    "MIGRATION_LOCK_TIMEOUT_MS",
    DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  );
  const statementTimeoutMs = readPositiveIntegerEnv(
    "MIGRATION_STATEMENT_TIMEOUT_MS",
    DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
  );

  // SET does not accept bind parameters; both values are validated positive integers, never raw env text.
  await client.query(`SET lock_timeout = ${lockTimeoutMs}`);
  await client.query(`SET statement_timeout = ${statementTimeoutMs}`);
}

// Bounded pg_try_advisory_lock retries rather than blocking pg_advisory_lock, so a hung prior migration fails the deploy loudly (DB-07).
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
    let previousTimeouts: MigrationSessionTimeouts | undefined;
    let migrationError: unknown;
    try {
      previousTimeouts = await readMigrationSessionTimeouts(client);
      await applyMigrationConnectionTimeouts(client);
      await acquireMigrationLock(client);
      await migrateNode(drizzleNode(client, { schema }), { migrationsFolder });
    } catch (error) {
      migrationError = error;
      throw error;
    } finally {
      try {
        if (previousTimeouts) {
          await restoreMigrationSessionTimeouts(client, previousTimeouts);
        }
        await client.query("SELECT pg_advisory_unlock($1)", [POSTGRES_MIGRATION_LOCK_ID]);
        client.release();
      } catch (cleanupError) {
        // A connection whose session state is unknown must not be reused; the next
        // checkout has to fail loudly instead of inheriting migration settings.
        client.release(
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
        );
        if (migrationError === undefined) {
          throw cleanupError;
        }
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
