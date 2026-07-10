import {
  createSessionToken,
  isSecureRequest,
  shouldUseSecureCookies,
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
    delete process.env.APP_TRUSTED_ORIGINS;
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

  async function createRustLikeSessionToken(secret: string, userId: string, email: string) {
    const encodeBase64Url = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const signingInput = [
      encodeBase64Url({ typ: "JWT", alg: "HS256" }),
      encodeBase64Url({
        sub: userId,
        email,
        type: "mt_session",
        exp: 4_102_444_800,
        iat: 1_893_456_000,
      }),
    ].join(".");
    const signature = await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      new TextEncoder().encode(signingInput),
    );

    return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
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

  it("uses identical SESSION_SECRET bytes for frontend and Rust-shaped session tokens", async () => {
    const sessionUser = {
      userId: "11111111-1111-4111-8111-111111111111",
      email: "coach@example.com",
    };
    process.env.SESSION_SECRET = "  whitespace-session-secret-with-at-least-32-chars  \n";
    resetServerEnvForTests();

    const frontendToken = await createSessionToken(sessionUser);
    expect(await verifySessionToken(frontendToken)).toEqual(sessionUser);

    const rustToken = await createRustLikeSessionToken(
      process.env.SESSION_SECRET,
      sessionUser.userId,
      sessionUser.email,
    );
    expect(await verifySessionToken(rustToken)).toEqual(sessionUser);

    process.env.SESSION_SECRET = process.env.SESSION_SECRET.trim();
    resetServerEnvForTests();
    expect(await verifySessionToken(rustToken)).toBeNull();
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

  it("uses only trusted forwarded headers to resolve the public request origin", () => {
    process.env.APP_URL = "https://macro.safasfly.dev";
    resetServerEnvForTests();

    const request = new Request("http://127.0.0.1:3000/api/auth/shoo/verify", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "macro.safasfly.dev",
      },
    });

    expect(getRequestOrigin(request)).toBe("https://macro.safasfly.dev");
  });

  it("does not use spoofed forwarded headers as the Shoo audience", async () => {
    process.env.APP_URL = "https://macro.safasfly.dev";
    resetServerEnvForTests();
    const request = new Request("http://127.0.0.1:3000/api/auth/shoo/verify", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "evil.example",
      },
    });
    const token = await createToken({
      audience: "origin:https://evil.example",
    });

    expect(getRequestOrigin(request)).toBe("https://macro.safasfly.dev");
    await expect(
      verifyShooToken(token, {
        appOrigin: getRequestOrigin(request),
        shooBaseUrl: "https://shoo.dev",
        issuer: "https://shoo.dev",
        jwks: localJwks,
      }),
    ).rejects.toThrow();
  });

  it("uses trusted HTTPS request origins for secure session cookies", async () => {
    process.env.APP_URL = "http://app.internal";
    process.env.APP_TRUSTED_ORIGINS = "https://macro.safasfly.dev";
    resetServerEnvForTests();
    const request = new Request("http://127.0.0.1:3000/api/auth/shoo/verify", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "macro.safasfly.dev",
      },
    });
    const response = NextResponse.json({ ok: true });

    await applySessionCookie(
      response,
      {
        userId: "user-123",
        email: "coach@example.com",
      },
      {
        secure: isSecureRequest(request),
      },
    );

    expect(getRequestOrigin(request)).toBe("https://macro.safasfly.dev");
    expect(shouldUseSecureCookies()).toBe(false);
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("ignores untrusted forwarded HTTPS spoofing for secure session cookies", async () => {
    process.env.APP_URL = "http://app.internal";
    process.env.APP_TRUSTED_ORIGINS = "https://macro.safasfly.dev";
    resetServerEnvForTests();
    const request = new Request("http://127.0.0.1:3000/api/auth/shoo/verify", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "evil.example",
      },
    });
    const response = NextResponse.json({ ok: true });

    await applySessionCookie(
      response,
      {
        userId: "user-123",
        email: "coach@example.com",
      },
      {
        secure: isSecureRequest(request),
      },
    );

    expect(getRequestOrigin(request)).toBe("http://app.internal");
    expect(shouldUseSecureCookies()).toBe(false);
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("uses configured app URL to keep production cookies secure", async () => {
    process.env.APP_URL = "https://macro.safasfly.dev";
    resetServerEnvForTests();
    const request = new Request("http://127.0.0.1:3000/api/auth/shoo/verify", {
      headers: {
        "x-forwarded-proto": "http",
        "x-forwarded-host": "macro.safasfly.dev",
      },
    });
    const response = NextResponse.json({ ok: true });

    await applySessionCookie(
      response,
      {
        userId: "user-123",
        email: "coach@example.com",
      },
    );

    expect(getRequestOrigin(request)).toBe("https://macro.safasfly.dev");
    expect(shouldUseSecureCookies()).toBe(true);
    expect(response.cookies.get(SESSION_COOKIE_NAME)?.value).toBeTruthy();
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });
});
