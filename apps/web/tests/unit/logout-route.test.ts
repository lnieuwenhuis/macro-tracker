import { resetServerEnvForTests } from "@/lib/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  clearSessionCookie: vi.fn(),
}));

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return {
    ...actual,
    clearSessionCookie: mocked.clearSessionCookie,
  };
});

import { GET, POST } from "@/app/api/auth/logout/route";

function logoutRequest(
  forwardedHost: string,
  overrides: { headers?: Record<string, string>; omit?: string[] } = {},
) {
  const headers: Record<string, string> = {
    "x-forwarded-proto": "https",
    "x-forwarded-host": forwardedHost,
    "sec-fetch-site": "same-origin",
    ...overrides.headers,
  };

  for (const key of overrides.omit ?? []) {
    delete headers[key];
  }

  return new Request("http://127.0.0.1:3000/api/auth/logout", { headers });
}

describe("GET /api/auth/logout", () => {
  beforeEach(() => {
    process.env.APP_URL = "http://app.internal";
    process.env.APP_TRUSTED_ORIGINS = "https://trusted.example";
    process.env.SESSION_SECRET = "logout-route-session-secret-32-chars";
    resetServerEnvForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.APP_TRUSTED_ORIGINS;
    resetServerEnvForTests();
  });

  it("clears secure cookies for trusted HTTPS request origins", async () => {
    await GET(logoutRequest("trusted.example"));

    expect(mocked.clearSessionCookie).toHaveBeenCalledWith(expect.anything(), {
      secure: true,
    });
  });

  it("does not let untrusted forwarded HTTPS headers force secure clearing", async () => {
    await GET(logoutRequest("evil.example"));

    expect(mocked.clearSessionCookie).toHaveBeenCalledWith(expect.anything(), {
      secure: false,
    });
  });

  // `SameSite=Lax` sends the session cookie on a top-level navigation, so
  // without a gate any site could sign a user out by linking here.
  it.each([
    ["a cross-site navigation", { headers: { "sec-fetch-site": "cross-site" } }],
    ["a request with no origin signal at all", { omit: ["sec-fetch-site"] }],
  ])("does not clear the session for %s", async (_name, overrides) => {
    const response = await GET(logoutRequest("trusted.example", overrides));

    expect(mocked.clearSessionCookie).not.toHaveBeenCalled();
    // Still lands on /login rather than erroring, so the genuine expiry
    // redirect cannot dead-end or loop.
    expect(response.headers.get("location")).toContain("/login");
  });

  it("does not let a cross-site form POST force a sign-out", async () => {
    const response = await POST(
      logoutRequest("trusted.example", {
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );

    expect(mocked.clearSessionCookie).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toContain("/login");
  });

  it("still clears the session for the in-app sign-out form", async () => {
    await POST(logoutRequest("trusted.example"));

    expect(mocked.clearSessionCookie).toHaveBeenCalledWith(expect.anything(), {
      secure: true,
    });
  });
});
