import type { NextRequest } from "next/server";

import { resetServerEnvForTests } from "@/lib/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  applySessionCookie: vi.fn(),
  verifySessionToken: vi.fn(),
}));

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return {
    ...actual,
    applySessionCookie: mocked.applySessionCookie,
    verifySessionToken: mocked.verifySessionToken,
  };
});

import { proxy } from "@/proxy";

const sessionUser = {
  userId: "user-1",
  email: "coach@example.com",
};

function proxyRequest(
  forwardedHost: string,
  options: {
    path?: string;
    method?: string;
    sessionToken?: string;
    headers?: HeadersInit;
  } = {},
) {
  const url = `http://127.0.0.1:3000${options.path ?? "/dashboard"}`;
  const headers = new Headers({
    "x-forwarded-proto": "https",
    "x-forwarded-host": forwardedHost,
    ...options.headers,
  });

  return {
    nextUrl: new URL(url),
    url,
    method: options.method ?? "GET",
    headers,
    cookies: {
      get: vi.fn(() =>
        options.sessionToken === undefined
          ? undefined
          : { value: options.sessionToken },
      ),
    },
  } as unknown as NextRequest;
}

describe("proxy session refresh", () => {
  beforeEach(() => {
    process.env.APP_URL = "http://app.internal";
    process.env.APP_TRUSTED_ORIGINS = "https://trusted.example";
    process.env.SESSION_SECRET = "proxy-test-session-secret-32-chars-x";
    resetServerEnvForTests();
    vi.clearAllMocks();
    mocked.verifySessionToken.mockResolvedValue(sessionUser);
  });

  afterEach(() => {
    delete process.env.APP_TRUSTED_ORIGINS;
    resetServerEnvForTests();
  });

  it("refreshes secure cookies for trusted HTTPS request origins", async () => {
    await proxy(proxyRequest("trusted.example", { sessionToken: "session-token" }));

    expect(mocked.verifySessionToken).toHaveBeenCalledWith("session-token");
    expect(mocked.applySessionCookie).toHaveBeenCalledWith(
      expect.anything(),
      sessionUser,
      {
        secure: true,
      },
    );
  });

  it("does not let untrusted forwarded HTTPS headers force secure refreshes", async () => {
    await proxy(proxyRequest("evil.example", { sessionToken: "session-token" }));

    expect(mocked.verifySessionToken).toHaveBeenCalledWith("session-token");
    expect(mocked.applySessionCookie).toHaveBeenCalledWith(
      expect.anything(),
      sessionUser,
      {
        secure: false,
      },
    );
  });

  it("lets unauthenticated API v1 preflight requests reach the route handler", async () => {
    mocked.verifySessionToken.mockResolvedValue(null);

    const response = await proxy(
      proxyRequest("trusted.example", {
        path: "/api/v1/goals",
        method: "OPTIONS",
        headers: {
          origin: "https://client.example",
          "access-control-request-method": "GET",
        },
      }),
    );

    expect(response.headers.get("location")).toBeNull();
  });

  it("lets unauthenticated API v1 bearer requests reach the route handler", async () => {
    mocked.verifySessionToken.mockResolvedValue(null);

    const response = await proxy(
      proxyRequest("trusted.example", {
        path: "/api/v1/goals",
        headers: {
          authorization: "Bearer mtk_v1_token",
        },
      }),
    );

    expect(response.headers.get("location")).toBeNull();
  });

  it("lets unauthenticated OpenAPI JSON requests reach the route handler", async () => {
    mocked.verifySessionToken.mockResolvedValue(null);

    const response = await proxy(
      proxyRequest("trusted.example", { path: "/api/v1/openapi.json" }),
    );

    expect(response.headers.get("location")).toBeNull();
  });

  it("lets unauthenticated API docs requests render the public docs page", async () => {
    mocked.verifySessionToken.mockResolvedValue(null);

    const response = await proxy(
      proxyRequest("trusted.example", { path: "/docs/api" }),
    );

    expect(response.headers.get("location")).toBeNull();
  });

  describe("public path allowlist", () => {
    // Extension match must anchor to the basename, not `pathname.endsWith`.
    it.each([
      "/api/barcode/1234.png",
      "/admin/barcodes/abc.png",
      "/admin/users/evil.svg",
      "/settings/api.ico",
    ])("still gates %s", async (path) => {
      mocked.verifySessionToken.mockResolvedValue(null);

      const response = await proxy(proxyRequest("trusted.example", { path }));

      expect(response.headers.get("location")).toContain("/login");
    });

    it.each(["/sw.js", "/manifest.webmanifest", "/icon.svg", "/favicon.ico"])(
      "still serves %s without a session",
      async (path) => {
        mocked.verifySessionToken.mockResolvedValue(null);

        const response = await proxy(proxyRequest("trusted.example", { path }));

        expect(response.headers.get("location")).toBeNull();
      },
    );
  });

  it("redirects a signed-in user away from a bare /login", async () => {
    const response = await proxy(
      proxyRequest("trusted.example", {
        path: "/login",
        sessionToken: "session-token",
      }),
    );

    expect(response.headers.get("location")).toBe("http://127.0.0.1:3000/");
  });

  it("lets /login render for a session that was just bounced with an error", async () => {
    // Otherwise a verified token for a no-longer-resolving account ping-pongs with the page that rejected it.
    const response = await proxy(
      proxyRequest("trusted.example", {
        path: "/login?error=session_expired",
        sessionToken: "session-token",
      }),
    );

    expect(response.headers.get("location")).toBeNull();
  });
});
