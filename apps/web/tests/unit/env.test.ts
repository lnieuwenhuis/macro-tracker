import { getServerEnv, resetServerEnvForTests } from "@/lib/env";
import { afterEach, describe, expect, it } from "vitest";

const originalEnv = {
  APP_TRUSTED_ORIGINS: process.env.APP_TRUSTED_ORIGINS,
  APP_URL: process.env.APP_URL,
  ENABLE_TEST_ROUTES: process.env.ENABLE_TEST_ROUTES,
  NODE_ENV: process.env.NODE_ENV,
  SESSION_SECRET: process.env.SESSION_SECRET,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    setEnv(key, value);
  }
}

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("getServerEnv", () => {
  afterEach(() => {
    restoreEnv();
    resetServerEnvForTests();
  });

  it("requires APP_URL in production", () => {
    setEnv("NODE_ENV", "production");
    delete process.env.APP_URL;
    delete process.env.APP_TRUSTED_ORIGINS;
    process.env.SESSION_SECRET = "production-secret";
    resetServerEnvForTests();

    expect(() => getServerEnv()).toThrow("APP_URL is required.");
  });

  it("keeps the localhost APP_URL fallback outside production", () => {
    setEnv("NODE_ENV", "development");
    delete process.env.APP_URL;
    delete process.env.APP_TRUSTED_ORIGINS;
    process.env.SESSION_SECRET = "development-secret";
    resetServerEnvForTests();

    expect(getServerEnv()).toMatchObject({
      appUrl: "http://localhost:3000",
      trustedOrigins: ["http://localhost:3000"],
    });
  });

  it("requires SESSION_SECRET outside production too", () => {
    // The old dev fallback was a repo-visible literal, so a mis-set NODE_ENV
    // made every HS256 session forgeable.
    setEnv("NODE_ENV", "development");
    delete process.env.SESSION_SECRET;
    resetServerEnvForTests();

    expect(() => getServerEnv()).toThrow("SESSION_SECRET is required.");
  });

  it("enables test routes only on an explicit opt-in", () => {
    setEnv("NODE_ENV", "test");
    process.env.SESSION_SECRET = "test-secret";
    delete process.env.ENABLE_TEST_ROUTES;
    resetServerEnvForTests();
    expect(getServerEnv().enableTestRoutes).toBe(false);

    process.env.ENABLE_TEST_ROUTES = "true";
    resetServerEnvForTests();
    expect(getServerEnv().enableTestRoutes).toBe(true);
  });
});
