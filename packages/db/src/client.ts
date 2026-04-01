import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleNode, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { Pool } from "pg";
import { resolve } from "node:path";

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
};

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

export async function createDatabaseRuntime(
  connectionString = process.env.DATABASE_URL,
): Promise<DatabaseRuntime> {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required.");
  }

  if (isPgliteConnectionString(connectionString)) {
    const client = new PGlite(getPglitePath(connectionString));
    const db = drizzlePglite(client, { schema });

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
