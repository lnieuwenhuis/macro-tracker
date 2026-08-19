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

function shooVerifyRequest(
  idToken: string,
  forwardedHost: string,
  overrides: { headers?: Record<string, string>; omit?: string[] } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-proto": "https",
    "x-forwarded-host": forwardedHost,
    // What a browser sends for the `fetch` in `auth-callback-client.tsx`.
    "sec-fetch-site": "same-origin",
    origin: `https://${forwardedHost}`,
    ...overrides.headers,
  };

  for (const key of overrides.omit ?? []) {
    delete headers[key];
  }

  return new Request("http://127.0.0.1:3000/api/auth/shoo/verify", {
    method: "POST",
    headers,
    body: JSON.stringify({ idToken }),
  });
}

function mockSuccessfulBackendVerify(expectedAppOrigin: string) {
  mocked.backendFetch.mockImplementation(async (path, init) => {
    expect(path).toBe("/internal/auth/shoo/verify");
    expect(JSON.parse(String(init?.body)).appOrigin).toBe(expectedAppOrigin);
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
}

describe("POST /api/auth/shoo/verify", () => {
  beforeEach(() => {
    process.env.APP_URL = "http://app.example";
    process.env.APP_TRUSTED_ORIGINS = "https://trusted.example";
    process.env.SESSION_SECRET = "shoo-verify-session-secret-32-chars";
    process.env.SHOO_BASE_URL = "https://shoo.dev";
    resetServerEnvForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.APP_TRUSTED_ORIGINS;
    resetServerEnvForTests();
  });

  describe("login CSRF gate", () => {
    // The response to this route sets `mt_session`, and `SameSite=Lax` governs
    // *sending* a cookie rather than *setting* one — so a cross-site POST that
    // is answered at all pins the victim to the attacker's account.
    it("rejects a cross-site Origin without setting a session cookie", async () => {
      const response = await POST(
        shooVerifyRequest("attacker-id-token", "trusted.example", {
          headers: { origin: "https://evil.example" },
          omit: ["sec-fetch-site"],
        }),
      );

      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(mocked.applySessionTokenCookie).not.toHaveBeenCalled();
      expect(mocked.backendFetch).not.toHaveBeenCalled();
    });

    it("rejects Sec-Fetch-Site: cross-site even with a same-origin Origin", async () => {
      const response = await POST(
        shooVerifyRequest("attacker-id-token", "trusted.example", {
          headers: { "sec-fetch-site": "cross-site" },
        }),
      );

      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(mocked.applySessionTokenCookie).not.toHaveBeenCalled();
      expect(mocked.backendFetch).not.toHaveBeenCalled();
    });

    it("rejects Sec-Fetch-Site: same-site — a sibling subdomain is not this origin", async () => {
      const response = await POST(
        shooVerifyRequest("attacker-id-token", "trusted.example", {
          headers: { "sec-fetch-site": "same-site" },
        }),
      );

      expect(response.status).toBe(403);
      expect(mocked.applySessionTokenCookie).not.toHaveBeenCalled();
    });

    it("fails closed when neither Sec-Fetch-Site nor Origin is present", async () => {
      const response = await POST(
        shooVerifyRequest("attacker-id-token", "trusted.example", {
          omit: ["sec-fetch-site", "origin"],
        }),
      );

      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(mocked.applySessionTokenCookie).not.toHaveBeenCalled();
      expect(mocked.backendFetch).not.toHaveBeenCalled();
    });

    it("rejects the CORS-safelisted content type the exploit form uses", async () => {
      // `enctype="text/plain"` is what removes the preflight, and
      // `request.json()` happily parses the resulting body.
      const response = await POST(
        shooVerifyRequest("attacker-id-token", "trusted.example", {
          headers: { "content-type": "text/plain;charset=UTF-8" },
        }),
      );

      expect(response.status).toBe(403);
      expect(mocked.applySessionTokenCookie).not.toHaveBeenCalled();
      expect(mocked.backendFetch).not.toHaveBeenCalled();
    });

    it("accepts a same-origin Origin when Sec-Fetch-Site is absent", async () => {
      mockSuccessfulBackendVerify("https://trusted.example");

      const response = await POST(
        shooVerifyRequest("token-for-trusted-origin", "trusted.example", {
          omit: ["sec-fetch-site"],
        }),
      );

      expect(response.status).toBe(200);
      expect(mocked.applySessionTokenCookie).toHaveBeenCalledTimes(1);
    });
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
      shooVerifyRequest("token-for-untrusted-origin", "evil.example", {
        omit: ["origin"],
      }),
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
      shooVerifyRequest("token-for-app-origin", "evil.example", {
        omit: ["origin"],
      }),
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
