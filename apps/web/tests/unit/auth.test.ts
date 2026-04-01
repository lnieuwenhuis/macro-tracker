import {
  createSessionToken,
  verifySessionToken,
} from "@/lib/session";
import {
  authorizeVerifiedShooClaims,
  isEmailAllowed,
  verifyShooToken,
} from "@/lib/shoo";
import { getUserById, type DatabaseRuntime } from "@macro-tracker/db";
import { createTestDatabase } from "@macro-tracker/db/testing";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetServerEnvForTests } from "@/lib/env";

describe("shoo auth helpers", () => {
  let runtime: DatabaseRuntime;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let localJwks: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    const keys = await generateKeyPair("ES256");
    privateKey = keys.privateKey;
    const publicJwk = await exportJWK(keys.publicKey);
    publicJwk.kid = "test-key";
    localJwks = createLocalJWKSet({
      keys: [publicJwk],
    });
  });

  beforeEach(async () => {
    process.env.APP_URL = "http://localhost:3000";
    process.env.ALLOWED_EMAILS = "coach@example.com,friend@example.com";
    process.env.SESSION_SECRET = "test-secret";
    process.env.SHOO_BASE_URL = "https://shoo.dev";
    resetServerEnvForTests();
    runtime = await createTestDatabase();
  });

  afterEach(async () => {
    await runtime.close();
    resetServerEnvForTests();
  });

  async function createToken(overrides?: {
    audience?: string;
    expirationTime?: string | number;
  }) {
    return new SignJWT({
      pairwise_sub: "ps_auth_test",
      email: "coach@example.com",
      name: "Coach",
    })
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setIssuer("https://shoo.dev")
      .setAudience(overrides?.audience ?? "origin:http://localhost:3000")
      .setIssuedAt()
      .setExpirationTime(overrides?.expirationTime ?? "5m")
      .sign(privateKey);
  }

  it("verifies a valid Shoo token", async () => {
    const token = await createToken();

    const payload = await verifyShooToken(token, {
      appUrl: "http://localhost:3000",
      shooBaseUrl: "https://shoo.dev",
      issuer: "https://shoo.dev",
      jwks: localJwks,
    });

    expect(payload.pairwise_sub).toBe("ps_auth_test");
    expect(payload.email).toBe("coach@example.com");
  });

  it("rejects a Shoo token with the wrong audience", async () => {
    const token = await createToken({
      audience: "origin:https://other-app.example",
    });

    await expect(
      verifyShooToken(token, {
        appUrl: "http://localhost:3000",
        shooBaseUrl: "https://shoo.dev",
        issuer: "https://shoo.dev",
        jwks: localJwks,
      }),
    ).rejects.toThrow();
  });

  it("rejects an expired Shoo token", async () => {
    const token = await createToken({
      expirationTime: Math.floor(Date.now() / 1000) - 60,
    });

    await expect(
      verifyShooToken(token, {
        appUrl: "http://localhost:3000",
        shooBaseUrl: "https://shoo.dev",
        issuer: "https://shoo.dev",
        jwks: localJwks,
      }),
    ).rejects.toThrow();
  });

  it("checks the allowlist and persists an authorized user session", async () => {
    expect(isEmailAllowed("coach@example.com")).toBe(true);
    expect(isEmailAllowed("stranger@example.com")).toBe(false);

    const result = await authorizeVerifiedShooClaims(
      {
        pairwise_sub: "ps_authorized",
        email: "coach@example.com",
        name: "Coach",
      },
      runtime.db,
    );

    const storedUser = await getUserById(result.sessionUser.userId, runtime.db);
    expect(storedUser?.email).toBe("coach@example.com");

    const sessionToken = await createSessionToken(result.sessionUser);
    const sessionUser = await verifySessionToken(sessionToken);
    expect(sessionUser).toEqual(result.sessionUser);
  });
});
