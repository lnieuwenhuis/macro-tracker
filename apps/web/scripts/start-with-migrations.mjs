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

function getWorkspaceRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function runCommand(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });

    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (signal) {
        rejectPromise(
          new Error(`${command} ${args.join(" ")} was terminated by signal ${signal}`),
        );
        return;
      }

      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
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

  // Routed through packages/db's db:migrate (advisory lock, DB-06/DB-07/DB-02) via pnpm/tsx: unbuilt TS, plain Node.
  console.info("Running database migrations before Next.js startup");
  await runCommand("pnpm", ["--filter", "@macro-tracker/db", "db:migrate"], {
    cwd: getWorkspaceRoot(),
    env: process.env,
  });
  console.info("Database migrations completed");
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
