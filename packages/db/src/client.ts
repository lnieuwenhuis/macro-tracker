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

type DatabaseClient =
  | NodePgDatabase<typeof schema>
  | PgliteDatabase<typeof schema>;

export type DatabaseRuntime = {
  db: DatabaseClient;
  mode: "postgres" | "pglite-memory" | "pglite-file";
  migrationPool?: Pool;
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
    // Schema creation is the migrator's job -- see `migrateDatabase`, which
    // handles the PGlite dialect too. This used to replay a hand-maintained
    // copy of every migration instead, which had to be updated twice for each
    // schema change and could silently drift from `drizzle/`.
    const db = drizzlePglite(client, { schema });

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
    migrationPool: pool,
    close: async () => {
      await pool.end();
    },
  };
}

export async function getDatabaseRuntime() {
  if (!globalDatabaseState.__macroTrackerRuntime) {
    globalDatabaseState.__macroTrackerRuntime = createDatabaseRuntime();
  }

  return globalDatabaseState.__macroTrackerRuntime;
}

export async function closeDatabase() {
  if (!globalDatabaseState.__macroTrackerRuntime) {
    return;
  }

  const runtime = await globalDatabaseState.__macroTrackerRuntime;
  globalDatabaseState.__macroTrackerRuntime = undefined;
  await runtime.close();
}
