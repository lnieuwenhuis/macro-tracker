import {
  createSessionToken,
  verifySessionToken,
} from "@/lib/session";
import {
  authorizeVerifiedShooClaims,
  verifyShooToken,
} from "@/lib/shoo";
import { getRequestOrigin } from "@/lib/request";
import { applySessionCookie, SESSION_COOKIE_NAME } from "@/lib/session";
import { getUserById, type DatabaseRuntime } from "@macro-tracker/db";
import { createTestDatabase } from "@macro-tracker/db/testing";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { NextResponse } from "next/server";
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

  it("verifies a Shoo token against the current request origin", async () => {
    const token = await createToken({
      audience: "origin:https://macro.safasfly.dev",
    });

    const payload = await verifyShooToken(token, {
      appOrigin: "https://macro.safasfly.dev",
      shooBaseUrl: "https://shoo.dev",
      issuer: "https://shoo.dev",
      jwks: localJwks,
    });

    expect(payload.email).toBe("coach@example.com");
  });

  it("persists an authorized user session", async () => {
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

  it("updates shooPairwiseSub when a user with the same email logs in with a different sub", async () => {
    // 1. Initial login
    const firstResult = await authorizeVerifiedShooClaims(
      {
        pairwise_sub: "sub_1",
        email: "user@example.com",
        name: "User One",
      },
      runtime.db,
    );

    const userId = firstResult.sessionUser.userId;

    // 2. Second login with SAME email but DIFFERENT sub
    const secondResult = await authorizeVerifiedShooClaims(
      {
        pairwise_sub: "sub_2",
        email: "user@example.com",
        name: "User Two",
      },
      runtime.db,
    );

    // Should be the same user ID
    expect(secondResult.sessionUser.userId).toBe(userId);

    // Should have updated the sub in the database
    const updatedUser = await getUserById(userId, runtime.db);
    expect(updatedUser?.shooPairwiseSub).toBe("sub_2");
    expect(updatedUser?.displayName).toBe("User Two");
  });

  it("uses forwarded headers to resolve the public request origin", () => {
    const request = new Request("http://127.0.0.1:3000/api/auth/shoo/verify", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "macro.safasfly.dev",
      },
    });

    expect(getRequestOrigin(request)).toBe("https://macro.safasfly.dev");
  });

  it("can set a secure session cookie from the current request protocol", async () => {
    const response = NextResponse.json({ ok: true });

    await applySessionCookie(
      response,
      {
        userId: "user-123",
        email: "coach@example.com",
      },
      {
        secure: true,
      },
    );

    expect(response.cookies.get(SESSION_COOKIE_NAME)?.value).toBeTruthy();
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });
});
