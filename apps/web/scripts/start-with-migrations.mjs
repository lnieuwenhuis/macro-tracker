import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import {
  getPostgresConnectionConfig,
  isPgliteConnectionString,
} from "../../../packages/db/src/postgres-config.js";

export { getPostgresConnectionConfig };

export function getStartupMigrationConnectionConfig(connectionString) {
  return getPostgresConnectionConfig(connectionString, { max: 1 });
}

async function runMigrationsIfNeeded() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString || isPgliteConnectionString(connectionString)) {
    return;
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(scriptDir, "../../../packages/db/drizzle");
  const pool = new Pool(getStartupMigrationConnectionConfig(connectionString));

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

function startNext() {
  const standaloneServerPath = getStandaloneServerPath();
  const command = standaloneServerPath ? process.execPath : "next";
  const args = standaloneServerPath ? [standaloneServerPath] : ["start"];
  const child = spawn(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      HOSTNAME: process.env.HOSTNAME ?? "0.0.0.0",
    },
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
