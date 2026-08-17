import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

type StartupMigrationModule = {
  getPostgresConnectionConfig: (connectionString: string) => {
    connectionString: string;
    ssl: false | { rejectUnauthorized: boolean };
    max: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
    allowExitOnIdle: boolean;
  };
  getStartupMigrationConnectionConfig: (connectionString: string) => {
    connectionString: string;
    ssl: false | { rejectUnauthorized: boolean };
    max: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
    allowExitOnIdle: boolean;
  };
  getStandaloneServerPath: (appDir?: string) => string | undefined;
  getNextServerEnv: (
    env?: Record<string, string | undefined>,
  ) => Record<string, string | undefined>;
  shouldRunStartupMigrations: (
    env?: Record<string, string | undefined>,
  ) => boolean;
};

const poolDefaults = {
  max: 3,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: true,
};

const originalPoolEnv = {
  POSTGRES_POOL_MAX: process.env.POSTGRES_POOL_MAX,
  POSTGRES_POOL_IDLE_TIMEOUT_MS: process.env.POSTGRES_POOL_IDLE_TIMEOUT_MS,
  POSTGRES_POOL_CONNECTION_TIMEOUT_MS:
    process.env.POSTGRES_POOL_CONNECTION_TIMEOUT_MS,
};

async function getStartupMigrationModule() {
  const moduleUrl = new URL(
    "../../scripts/start-with-migrations.mjs",
    import.meta.url,
  ).href;

  return (await import(moduleUrl)) as StartupMigrationModule;
}

describe("startup migration database SSL config", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_POOL_MAX;
    delete process.env.POSTGRES_POOL_IDLE_TIMEOUT_MS;
    delete process.env.POSTGRES_POOL_CONNECTION_TIMEOUT_MS;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalPoolEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("uses TLS with chain verification when remote sslmode is omitted", async () => {
    const { getPostgresConnectionConfig } = await getStartupMigrationModule();

    expect(
      getPostgresConnectionConfig("postgres://user:pass@db.example.com:5432/macro"),
    ).toEqual({
      connectionString: "postgres://user:pass@db.example.com:5432/macro",
      ssl: { rejectUnauthorized: true },
      ...poolDefaults,
    });
  });

  it("rejects insecure remote sslmode=no-verify", async () => {
    const { getPostgresConnectionConfig } = await getStartupMigrationModule();

    expect(() =>
      getPostgresConnectionConfig(
        "postgres://user:pass@db.example.com:5432/macro?sslmode=no-verify",
      ),
    ).toThrow("sslmode=no-verify");
  });

  it("verifies the certificate chain for remote sslmode=require", async () => {
    // SEC-04: `require` used to yield rejectUnauthorized:false, i.e. the exact TLS posture
    // `no-verify` is rejected for a few lines above. Railway/Neon/Supabase all hand out
    // `?sslmode=require`, so that was the likely production value.
    const { getPostgresConnectionConfig } = await getStartupMigrationModule();

    expect(
      getPostgresConnectionConfig(
        "postgres://user:pass@db.example.com:5432/macro?sslmode=require",
      ),
    ).toEqual({
      connectionString: "postgres://user:pass@db.example.com:5432/macro",
      ssl: { rejectUnauthorized: true },
      ...poolDefaults,
    });
  });

  it("preserves localhost non-TLS behavior", async () => {
    const { getPostgresConnectionConfig } = await getStartupMigrationModule();

    expect(
      getPostgresConnectionConfig("postgres://user:pass@localhost:5432/macro"),
    ).toEqual({
      connectionString: "postgres://user:pass@localhost:5432/macro",
      ssl: false,
      ...poolDefaults,
    });
  });

  it("rejects unsupported remote sslmode=verify-ca", async () => {
    const { getPostgresConnectionConfig } = await getStartupMigrationModule();

    expect(() =>
      getPostgresConnectionConfig(
        "postgres://user:pass@db.example.com:5432/macro?sslmode=verify-ca",
      ),
    ).toThrow("unsupported sslmode=verify-ca");
  });

  it("keeps chain verification for remote sslmode=verify-full", async () => {
    const { getPostgresConnectionConfig } = await getStartupMigrationModule();

    expect(
      getPostgresConnectionConfig(
        "postgres://user:pass@db.example.com:5432/macro?sslmode=verify-full",
      ),
    ).toEqual({
      connectionString: "postgres://user:pass@db.example.com:5432/macro",
      ssl: { rejectUnauthorized: true },
      ...poolDefaults,
    });
  });

  it("caps startup migrations at one database connection", async () => {
    const { getStartupMigrationConnectionConfig } =
      await getStartupMigrationModule();

    expect(
      getStartupMigrationConnectionConfig(
        "postgres://user:***@db.example.com:5432/macro",
      ),
    ).toEqual({
      connectionString: "postgres://user:***@db.example.com:5432/macro",
      ssl: { rejectUnauthorized: true },
      ...poolDefaults,
      max: 1,
    });
  });

  it("does not run frontend startup migrations unless legacy mode is explicitly enabled", async () => {
    const { shouldRunStartupMigrations } = await getStartupMigrationModule();

    expect(
      shouldRunStartupMigrations({
        DATABASE_URL: "postgres://user:***@db.example.com:5432/macro",
      }),
    ).toBe(false);
    expect(
      shouldRunStartupMigrations({
        DATABASE_URL: "postgres://user:***@db.example.com:5432/macro",
        LEGACY_FRONTEND_RUN_MIGRATIONS: "true",
      }),
    ).toBe(true);
  });

  it("prefers the traced standalone app server when present", async () => {
    const { getStandaloneServerPath } = await getStartupMigrationModule();
    const appDir = await mkdtemp(join(tmpdir(), "macro-standalone-"));
    const serverPath = join(
      appDir,
      ".next",
      "standalone",
      "apps",
      "web",
      "server.js",
    );

    try {
      await mkdir(dirname(serverPath), { recursive: true });
      await writeFile(serverPath, "");

      expect(getStandaloneServerPath(appDir)).toBe(serverPath);
    } finally {
      await rm(appDir, { force: true, recursive: true });
    }
  });

  it("falls back to the root standalone server when needed", async () => {
    const { getStandaloneServerPath } = await getStartupMigrationModule();
    const appDir = await mkdtemp(join(tmpdir(), "macro-standalone-"));
    const serverPath = join(appDir, ".next", "standalone", "server.js");

    try {
      await mkdir(dirname(serverPath), { recursive: true });
      await writeFile(serverPath, "");

      expect(getStandaloneServerPath(appDir)).toBe(serverPath);
    } finally {
      await rm(appDir, { force: true, recursive: true });
    }
  });

  it("binds the Next server to all interfaces by default", async () => {
    const { getNextServerEnv } = await getStartupMigrationModule();

    expect(
      getNextServerEnv({
        HOSTNAME: "railway-container-hostname",
        PORT: "3000",
      }),
    ).toEqual({
      HOSTNAME: "0.0.0.0",
      PORT: "3000",
    });
  });

  it("allows an explicit Next server hostname override", async () => {
    const { getNextServerEnv } = await getStartupMigrationModule();

    expect(
      getNextServerEnv({
        HOSTNAME: "railway-container-hostname",
        NEXT_SERVER_HOSTNAME: "127.0.0.1",
      }).HOSTNAME,
    ).toBe("127.0.0.1");
  });
});
