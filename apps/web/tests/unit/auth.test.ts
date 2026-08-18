import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetServerEnvForTests } from "@/lib/env";
import { getRequestOrigin } from "@/lib/request";
import {
  applySessionCookie,
  createSessionToken,
  isSecureRequest,
  SESSION_ABSOLUTE_LIFETIME_SECONDS,
  SESSION_COOKIE_NAME,
  shouldUseSecureCookies,
  verifySessionToken,
} from "@/lib/session";

const TEST_SESSION_SECRET = "auth-test-session-secret-32-chars-long";

describe("session auth helpers", () => {
  beforeEach(() => {
    process.env.APP_URL = "http://localhost:3000";
    delete process.env.APP_TRUSTED_ORIGINS;
    process.env.SESSION_SECRET = TEST_SESSION_SECRET;
    resetServerEnvForTests();
  });

  afterEach(() => resetServerEnvForTests());

  async function createRustLikeSessionToken(
    secret: string,
    userId: string,
    email: string,
    claims: Record<string, unknown> = {},
  ) {
    const encodeBase64Url = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const signingInput = [
      encodeBase64Url({ typ: "JWT", alg: "HS256" }),
      encodeBase64Url({
        sub: userId,
        email,
        type: "mt_session",
        exp: 4_102_444_800,
        iat: Math.floor(Date.now() / 1000),
        ...claims,
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

  it("uses identical SESSION_SECRET bytes for frontend and Rust-shaped session tokens", async () => {
    const sessionUser = {
      userId: "11111111-1111-4111-8111-111111111111",
      email: "coach@example.com",
    };
    process.env.SESSION_SECRET = "  whitespace-session-secret-with-at-least-32-chars  \n";
    resetServerEnvForTests();

    const frontendToken = await createSessionToken(sessionUser);
    expect(await verifySessionToken(frontendToken)).toMatchObject(sessionUser);
    const rustToken = await createRustLikeSessionToken(
      process.env.SESSION_SECRET,
      sessionUser.userId,
      sessionUser.email,
    );
    expect(await verifySessionToken(rustToken)).toMatchObject(sessionUser);

    process.env.SESSION_SECRET = process.env.SESSION_SECRET.trim();
    resetServerEnvForTests();
    expect(await verifySessionToken(rustToken)).toBeNull();
  });

  describe("absolute session lifetime", () => {
    const sessionUser = {
      userId: "11111111-1111-4111-8111-111111111111",
      email: "coach@example.com",
    };

    // Every authenticated request re-mints a 7-day token, so without an
    // absolute cap a captured token lives forever as long as it keeps being
    // used, and signing out invalidates nothing server-side.
    it("rejects a token whose original issuance predates the absolute lifetime", async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const staleToken = await createSessionToken({
        ...sessionUser,
        authenticatedAt: nowSeconds - SESSION_ABSOLUTE_LIFETIME_SECONDS - 60,
      });

      // The renewal window is still open — only the absolute cap rejects this.
      expect(await verifySessionToken(staleToken)).toBeNull();
    });

    it("accepts a token that is inside the absolute lifetime", async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const token = await createSessionToken({
        ...sessionUser,
        authenticatedAt: nowSeconds - SESSION_ABSOLUTE_LIFETIME_SECONDS + 3600,
      });

      expect(await verifySessionToken(token)).toMatchObject(sessionUser);
    });

    it("preserves the original authentication time across a renewal", async () => {
      const authenticatedAt = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 20;
      const original = await createSessionToken({ ...sessionUser, authenticatedAt });
      const verified = await verifySessionToken(original);

      expect(verified).not.toBeNull();
      expect(verified?.authenticatedAt).toBe(authenticatedAt);

      // What `proxy.ts` does on every authenticated request.
      const renewed = await createSessionToken(verified!);
      const reverified = await verifySessionToken(renewed);

      expect(reverified?.authenticatedAt).toBe(authenticatedAt);
    });

    it("renews a fresh token without moving its absolute deadline", async () => {
      const token = await createSessionToken(sessionUser);
      const verified = await verifySessionToken(token);
      const renewed = await createSessionToken(verified!);

      const reverified = await verifySessionToken(renewed);
      expect(reverified).toMatchObject(sessionUser);
      expect(reverified?.authenticatedAt).toBe(verified?.authenticatedAt);
    });

    it("falls back to iat for backend-minted tokens that carry no authenticatedAt", async () => {
      const staleIat =
        Math.floor(Date.now() / 1000) - SESSION_ABSOLUTE_LIFETIME_SECONDS - 60;
      const staleRustToken = await createRustLikeSessionToken(
        TEST_SESSION_SECRET,
        sessionUser.userId,
        sessionUser.email,
        { iat: staleIat },
      );

      expect(await verifySessionToken(staleRustToken)).toBeNull();
    });

    it("rejects a token that carries neither authenticatedAt nor iat", async () => {
      const undatedToken = await createRustLikeSessionToken(
        TEST_SESSION_SECRET,
        sessionUser.userId,
        sessionUser.email,
        { iat: undefined },
      );

      expect(await verifySessionToken(undatedToken)).toBeNull();
    });
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
      { userId: "user-123", email: "coach@example.com" },
      { secure: isSecureRequest(request) },
    );

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
      { userId: "user-123", email: "coach@example.com" },
      { secure: isSecureRequest(request) },
    );

    expect(getRequestOrigin(request)).toBe("http://app.internal");
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("uses the configured app URL to keep production cookies secure", async () => {
    process.env.APP_URL = "https://macro.safasfly.dev";
    resetServerEnvForTests();
    const response = NextResponse.json({ ok: true });

    await applySessionCookie(response, {
      userId: "user-123",
      email: "coach@example.com",
    });

    expect(shouldUseSecureCookies()).toBe(true);
    expect(response.cookies.get(SESSION_COOKIE_NAME)?.value).toBeTruthy();
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });
});
