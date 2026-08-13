import { resetServerEnvForTests } from "@/lib/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  applySessionCookie: vi.fn(),
  completeUserOnboarding: vi.fn(),
  ensureUserRoleForTesting: vi.fn(),
  getDb: vi.fn(),
  upsertUserFromShooProfile: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return {
    ...actual,
    applySessionCookie: mocked.applySessionCookie,
  };
});

vi.mock("@macro-tracker/db", () => ({
  completeUserOnboarding: mocked.completeUserOnboarding,
  ensureUserRoleForTesting: mocked.ensureUserRoleForTesting,
  getDb: mocked.getDb,
  upsertUserFromShooProfile: mocked.upsertUserFromShooProfile,
}));

import { POST } from "@/app/api/test/session/route";

const TEST_ROUTE_SECRET = "unit-test-route-secret";

function testSessionRequest(
  forwardedHost: string,
  options: {
    email?: string;
    includeSecret?: boolean;
  } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-proto": "https",
    "x-forwarded-host": forwardedHost,
  };

  if (options.includeSecret !== false) {
    headers["x-test-route-secret"] = TEST_ROUTE_SECRET;
  }

  return new Request("http://127.0.0.1:3000/api/test/session", {
    method: "POST",
    headers,
    body: JSON.stringify({ email: options.email ?? "coach@example.com" }),
  });
}

describe("POST /api/test/session", () => {
  beforeEach(() => {
    process.env.APP_URL = "http://app.internal";
    process.env.APP_TRUSTED_ORIGINS = "https://trusted.example";
    process.env.ENABLE_TEST_ROUTES = "true";
    process.env.TEST_ROUTES_SECRET = TEST_ROUTE_SECRET;
    resetServerEnvForTests();
    vi.clearAllMocks();
    mocked.execute.mockResolvedValue(undefined);
    mocked.getDb.mockResolvedValue({
      execute: mocked.execute,
    });
    mocked.completeUserOnboarding.mockResolvedValue(undefined);
    mocked.ensureUserRoleForTesting.mockResolvedValue(undefined);
    mocked.upsertUserFromShooProfile.mockResolvedValue({
      id: "user-1",
      email: "coach@example.com",
    });
  });

  afterEach(() => {
    delete process.env.APP_TRUSTED_ORIGINS;
    delete process.env.ENABLE_TEST_ROUTES;
    delete process.env.TEST_ROUTES_SECRET;
    resetServerEnvForTests();
  });

  it("creates secure cookies for trusted HTTPS request origins", async () => {
    const response = await POST(testSessionRequest("trusted.example"));

    expect(response.status).toBe(200);
    expect(mocked.applySessionCookie).toHaveBeenCalledWith(
      expect.anything(),
      {
        userId: "user-1",
        email: "coach@example.com",
      },
      {
        secure: true,
      },
    );
  });

  it("does not let untrusted forwarded HTTPS headers force secure test sessions", async () => {
    const response = await POST(testSessionRequest("evil.example"));

    expect(response.status).toBe(200);
    expect(mocked.applySessionCookie).toHaveBeenCalledWith(
      expect.anything(),
      {
        userId: "user-1",
        email: "coach@example.com",
      },
      {
        secure: false,
      },
    );
  });

  it("rejects owner promotion without the test route secret", async () => {
    const response = await POST(
      testSessionRequest("trusted.example", {
        email: "owner+unsafe@example.com",
        includeSecret: false,
      }),
    );

    expect(response.status).toBe(403);
    expect(mocked.upsertUserFromShooProfile).not.toHaveBeenCalled();
    expect(mocked.ensureUserRoleForTesting).not.toHaveBeenCalled();
  });

  it("promotes owner test logins when the test route secret is valid", async () => {
    mocked.upsertUserFromShooProfile.mockResolvedValueOnce({
      id: "owner-1",
      email: "owner+safe@example.com",
    });

    const response = await POST(
      testSessionRequest("trusted.example", {
        email: "owner+safe@example.com",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocked.ensureUserRoleForTesting).toHaveBeenCalledWith("owner-1", "owner");
  });
});
