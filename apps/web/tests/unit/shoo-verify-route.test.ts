import { resetServerEnvForTests } from "@/lib/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  applySessionTokenCookie: vi.fn(),
  backendFetch: vi.fn(),
}));

vi.mock("@macro-tracker/db", () => ({
  backendFetch: mocked.backendFetch,
}));

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return {
    ...actual,
    applySessionTokenCookie: mocked.applySessionTokenCookie,
  };
});

import { POST } from "@/app/api/auth/shoo/verify/route";

function shooVerifyRequest(idToken: string, forwardedHost: string) {
  return new Request("http://127.0.0.1:3000/api/auth/shoo/verify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-proto": "https",
      "x-forwarded-host": forwardedHost,
    },
    body: JSON.stringify({ idToken }),
  });
}

describe("POST /api/auth/shoo/verify", () => {
  beforeEach(() => {
    process.env.APP_URL = "http://app.example";
    process.env.APP_TRUSTED_ORIGINS = "https://trusted.example";
    process.env.SESSION_SECRET = "test-secret";
    process.env.SHOO_BASE_URL = "https://shoo.dev";
    resetServerEnvForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.APP_TRUSTED_ORIGINS;
    resetServerEnvForTests();
  });

  it("accepts a token for a configured trusted forwarded origin", async () => {
    mocked.backendFetch.mockImplementation(async (path, init) => {
      expect(path).toBe("/internal/auth/shoo/verify");
      expect(JSON.parse(String(init?.body))).toEqual({
        idToken: "token-for-trusted-origin",
        appOrigin: "https://trusted.example",
      });
      return Response.json({
        ok: true,
        data: {
          sessionToken: "session-token",
          sessionMaxAgeSeconds: 3600,
          user: {
            userId: "user-1",
            email: "coach@example.com",
          },
        },
      });
    });

    const response = await POST(
      shooVerifyRequest("token-for-trusted-origin", "trusted.example"),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      user: {
        userId: "user-1",
        email: "coach@example.com",
      },
    });
    expect(response.status).toBe(200);
    expect(mocked.backendFetch).toHaveBeenCalledTimes(1);
    expect(mocked.applySessionTokenCookie).toHaveBeenCalledTimes(1);
    expect(mocked.applySessionTokenCookie).toHaveBeenCalledWith(
      expect.anything(),
      "session-token",
      {
        maxAge: 3600,
        secure: true,
      },
    );
  });

  it("rejects a token for an untrusted forwarded origin", async () => {
    mocked.backendFetch.mockImplementation(async (path, init) => {
      expect(path).toBe("/internal/auth/shoo/verify");
      expect(JSON.parse(String(init?.body))).toEqual({
        idToken: "token-for-untrusted-origin",
        appOrigin: "http://app.example",
      });
      return Response.json(
        {
          ok: false,
          error: {
            message: "Shoo token has an invalid audience.",
            code: "invalid_token",
          },
        },
        { status: 401 },
      );
    });

    const response = await POST(
      shooVerifyRequest("token-for-untrusted-origin", "evil.example"),
    );

    await expect(response.json()).resolves.toEqual({
      error: "Shoo token has an invalid audience.",
      code: "invalid_token",
    });
    expect(response.status).toBe(401);
    expect(mocked.backendFetch).toHaveBeenCalledTimes(1);
    expect(mocked.applySessionTokenCookie).not.toHaveBeenCalled();
  });

  it("does not use untrusted forwarded HTTPS headers for secure cookies", async () => {
    mocked.backendFetch.mockImplementation(async (path, init) => {
      expect(path).toBe("/internal/auth/shoo/verify");
      expect(JSON.parse(String(init?.body))).toEqual({
        idToken: "token-for-app-origin",
        appOrigin: "http://app.example",
      });
      return Response.json({
        ok: true,
        data: {
          sessionToken: "session-token",
          sessionMaxAgeSeconds: 3600,
          user: {
            userId: "user-1",
            email: "coach@example.com",
          },
        },
      });
    });

    const response = await POST(
      shooVerifyRequest("token-for-app-origin", "evil.example"),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      user: {
        userId: "user-1",
        email: "coach@example.com",
      },
    });
    expect(response.status).toBe(200);
    expect(mocked.applySessionTokenCookie).toHaveBeenCalledWith(
      expect.anything(),
      "session-token",
      {
        maxAge: 3600,
        secure: false,
      },
    );
  });
});
