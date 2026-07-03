import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getPostgresConnectionConfig, getSslConfig } from "../src";

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

describe("database client SSL config", () => {
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

  it("uses TLS with chain verification when remote sslmode is omitted", () => {
    expect(getSslConfig("postgres://user:pass@db.example.com:5432/macro")).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("rejects insecure remote sslmode values", () => {
    expect(
      () =>
        getSslConfig(
          "postgres://user:pass@db.example.com:5432/macro?sslmode=no-verify",
        ),
    ).toThrow("sslmode=no-verify");
    expect(
      () =>
        getSslConfig(
          "postgres://user:pass@db.example.com:5432/macro?sslmode=disable",
        ),
    ).toThrow("sslmode=disable");
  });

  it("preserves localhost non-TLS behavior", () => {
    expect(getSslConfig("postgres://user:pass@localhost:5432/macro")).toBe(false);
    expect(getSslConfig("postgres://user:pass@127.0.0.1:5432/macro")).toBe(false);
  });

  it("strips sslmode=require before constructing remote pool config", () => {
    expect(
      getPostgresConnectionConfig(
        "postgres://user:pass@db.example.com:5432/macro?sslmode=require",
      ),
    ).toEqual({
      connectionString: "postgres://user:pass@db.example.com:5432/macro",
      ssl: { rejectUnauthorized: false },
      ...poolDefaults,
    });
  });

  it("rejects unsupported remote sslmode=verify-ca", () => {
    expect(() =>
      getPostgresConnectionConfig(
        "postgres://user:pass@db.example.com:5432/macro?sslmode=verify-ca",
      ),
    ).toThrow("unsupported sslmode=verify-ca");
  });

  it("keeps chain verification for sslmode=verify-full", () => {
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

  it("allows the production pool size to be lowered from the environment", () => {
    process.env.POSTGRES_POOL_MAX = "2";
    process.env.POSTGRES_POOL_IDLE_TIMEOUT_MS = "2500";
    process.env.POSTGRES_POOL_CONNECTION_TIMEOUT_MS = "1500";

    expect(
      getPostgresConnectionConfig("postgres://user:pass@db.example.com:5432/macro"),
    ).toEqual({
      connectionString: "postgres://user:pass@db.example.com:5432/macro",
      ssl: { rejectUnauthorized: true },
      max: 2,
      idleTimeoutMillis: 2_500,
      connectionTimeoutMillis: 1_500,
      allowExitOnIdle: true,
    });
  });
});
