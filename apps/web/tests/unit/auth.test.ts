import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetServerEnvForTests } from "@/lib/env";
import { getRequestOrigin } from "@/lib/request";
import {
  applySessionCookie,
  createSessionToken,
  isSecureRequest,
  SESSION_COOKIE_NAME,
  shouldUseSecureCookies,
  verifySessionToken,
} from "@/lib/session";

describe("session auth helpers", () => {
  beforeEach(() => {
    process.env.APP_URL = "http://localhost:3000";
    delete process.env.APP_TRUSTED_ORIGINS;
    process.env.SESSION_SECRET = "test-secret";
    resetServerEnvForTests();
  });

  afterEach(() => resetServerEnvForTests());

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
