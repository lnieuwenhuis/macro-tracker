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

const VALID_SECRET = "env-test-session-secret-32-chars-long";

describe("getServerEnv", () => {
  afterEach(() => {
    restoreEnv();
    resetServerEnvForTests();
  });

  it("requires APP_URL in production", () => {
    setEnv("NODE_ENV", "production");
    delete process.env.APP_URL;
    delete process.env.APP_TRUSTED_ORIGINS;
    process.env.SESSION_SECRET = VALID_SECRET;
    resetServerEnvForTests();

    expect(() => getServerEnv()).toThrow("APP_URL is required.");
  });

  it("keeps the localhost APP_URL fallback outside production", () => {
    setEnv("NODE_ENV", "development");
    delete process.env.APP_URL;
    delete process.env.APP_TRUSTED_ORIGINS;
    process.env.SESSION_SECRET = VALID_SECRET;
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
    process.env.SESSION_SECRET = VALID_SECRET;
    delete process.env.ENABLE_TEST_ROUTES;
    resetServerEnvForTests();
    expect(getServerEnv().enableTestRoutes).toBe(false);

    process.env.ENABLE_TEST_ROUTES = "true";
    resetServerEnvForTests();
    expect(getServerEnv().enableTestRoutes).toBe(true);
  });

  describe("SESSION_SECRET strength", () => {
    // `jose` enforces no minimum HMAC key length, so without this the web app
    // happily signs HS256 sessions with a one-character secret while the Rust
    // backend refuses to start on the same value.
    it("rejects a secret shorter than the backend's minimum", () => {
      setEnv("NODE_ENV", "production");
      process.env.APP_URL = "https://app.example";
      process.env.SESSION_SECRET = "short";
      resetServerEnvForTests();

      expect(() => getServerEnv()).toThrow(
        "SESSION_SECRET must be at least 32 characters.",
      );
    });

    it("measures length on the trimmed secret", () => {
      setEnv("NODE_ENV", "production");
      process.env.APP_URL = "https://app.example";
      process.env.SESSION_SECRET = `   ${" ".repeat(40)}short   `;
      resetServerEnvForTests();

      expect(() => getServerEnv()).toThrow(
        "SESSION_SECRET must be at least 32 characters.",
      );
    });

    it("rejects the README placeholder even though it is long enough", () => {
      setEnv("NODE_ENV", "production");
      process.env.APP_URL = "https://app.example";
      // 35 characters, so a naive length check passes it.
      process.env.SESSION_SECRET = "change-this-to-a-long-random-string";
      resetServerEnvForTests();

      expect(() => getServerEnv()).toThrow(
        "SESSION_SECRET must not be a known placeholder or development value.",
      );
    });

    it.each([
      "macro-tracker-dev-session-secret",
      "macro-tracker-local-backend-secret",
      "  change-this-to-a-long-random-string  ",
    ])("rejects the committed development literal %s", (secret) => {
      setEnv("NODE_ENV", "production");
      process.env.APP_URL = "https://app.example";
      process.env.SESSION_SECRET = secret;
      resetServerEnvForTests();

      expect(() => getServerEnv()).toThrow(
        "SESSION_SECRET must not be a known placeholder or development value.",
      );
    });

    it("accepts a long random secret", () => {
      setEnv("NODE_ENV", "production");
      process.env.APP_URL = "https://app.example";
      process.env.SESSION_SECRET = VALID_SECRET;
      resetServerEnvForTests();

      expect(getServerEnv().sessionSecret).toBe(VALID_SECRET);
    });

    it("still allows the committed dev literal on a loopback APP_URL", () => {
      // Mirrors the backend's insecure-local posture so `pnpm dev` and the
      // Playwright default keep working; a deployment cannot be on loopback.
      setEnv("NODE_ENV", "development");
      process.env.APP_URL = "http://localhost:3000";
      process.env.SESSION_SECRET = "macro-tracker-dev-session-secret";
      resetServerEnvForTests();

      expect(getServerEnv().sessionSecret).toBe("macro-tracker-dev-session-secret");
    });

    it("still enforces the minimum length on a loopback APP_URL", () => {
      setEnv("NODE_ENV", "development");
      process.env.APP_URL = "http://localhost:3000";
      process.env.SESSION_SECRET = "short";
      resetServerEnvForTests();

      expect(() => getServerEnv()).toThrow(
        "SESSION_SECRET must be at least 32 characters.",
      );
    });

    it("keeps the raw value so the signing bytes still match the backend", () => {
      // The backend hashes the untrimmed env value; trimming here would make
      // the two services sign different tokens.
      setEnv("NODE_ENV", "production");
      process.env.APP_URL = "https://app.example";
      process.env.SESSION_SECRET = `  ${VALID_SECRET}  `;
      resetServerEnvForTests();

      expect(getServerEnv().sessionSecret).toBe(`  ${VALID_SECRET}  `);
    });
  });
});
