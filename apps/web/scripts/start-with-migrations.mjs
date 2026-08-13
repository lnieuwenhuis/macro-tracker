import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  getPostgresConnectionConfig,
  isPgliteConnectionString,
} from "../../../packages/db/src/postgres-config.js";

export { getPostgresConnectionConfig };

export function getStartupMigrationConnectionConfig(connectionString) {
  return getPostgresConnectionConfig(connectionString, { max: 1 });
}

export function shouldRunStartupMigrations(env = process.env) {
  const value = env.LEGACY_FRONTEND_RUN_MIGRATIONS?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

async function runMigrationsIfNeeded() {
  const connectionString = process.env.DATABASE_URL;

  if (!shouldRunStartupMigrations()) {
    console.info(
      "Skipping frontend startup migrations; backend service owns database migrations.",
    );
    return;
  }

  if (!connectionString || isPgliteConnectionString(connectionString)) {
    return;
  }

  // Imported lazily: the backend owns migrations, so the normal startup path
  // must not pull an ORM and a Postgres driver into the frontend process.
  // These are only reachable when LEGACY_FRONTEND_RUN_MIGRATIONS is set.
  const [{ drizzle }, { migrate }, { default: pg }] = await Promise.all([
    import("drizzle-orm/node-postgres"),
    import("drizzle-orm/node-postgres/migrator"),
    import("pg"),
  ]);

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(scriptDir, "../../../packages/db/drizzle");
  const pool = new pg.Pool(getStartupMigrationConnectionConfig(connectionString));

  try {
    console.info("Running database migrations before Next.js startup");
    await migrate(drizzle(pool), { migrationsFolder });
    console.info("Database migrations completed");
  } finally {
    await pool.end();
  }
}

function getAppDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function getStandaloneServerPath(appDir = getAppDir()) {
  const candidates = [
    resolve(appDir, ".next/standalone/apps/web/server.js"),
    resolve(appDir, ".next/standalone/server.js"),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

export function getNextServerEnv(env = process.env) {
  return {
    ...env,
    HOSTNAME: env.NEXT_SERVER_HOSTNAME ?? "0.0.0.0",
  };
}

function startNext() {
  const standaloneServerPath = getStandaloneServerPath();
  const command = standaloneServerPath ? process.execPath : "next";
  const args = standaloneServerPath ? [standaloneServerPath] : ["start"];
  const child = spawn(command, args, {
    stdio: "inherit",
    env: getNextServerEnv(),
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
      import.meta.url === pathToFileURL(resolve(process.argv[1])).href,
  );
}

if (isMainModule()) {
  runMigrationsIfNeeded()
    .then(startNext)
    .catch((error) => {
      console.error("Startup migrations failed", error);
      process.exit(1);
    });
}
