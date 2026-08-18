import { resetServerEnvForTests } from "@/lib/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createTemplate: vi.fn(),
  getSessionUserFromCookies: vi.fn(),
}));

vi.mock("@macro-tracker/db", () => ({
  createTemplate: mocked.createTemplate,
}));

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return {
    ...actual,
    getSessionUserFromCookies: mocked.getSessionUserFromCookies,
  };
});

import { POST } from "@/app/api/test/templates/route";

const TEST_ROUTE_SECRET = "unit-test-route-secret";

function testTemplatesRequest(
  options: {
    secret?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (options.secret) {
    headers["x-test-route-secret"] = options.secret;
  }

  return new Request("http://127.0.0.1:3000/api/test/templates", {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "day",
      label: "Seeded template",
      items: [],
    }),
  });
}

describe("POST /api/test/templates", () => {
  beforeEach(() => {
    process.env.ENABLE_TEST_ROUTES = "true";
    process.env.TEST_ROUTES_SECRET = TEST_ROUTE_SECRET;
    process.env.SESSION_SECRET = "test-templates-route-secret-32-char";
    resetServerEnvForTests();
    vi.clearAllMocks();
    mocked.getSessionUserFromCookies.mockResolvedValue({ userId: "user-1" });
    mocked.createTemplate.mockResolvedValue({
      id: "template-1",
      label: "Seeded template",
    });
  });

  afterEach(() => {
    delete process.env.ENABLE_TEST_ROUTES;
    delete process.env.TEST_ROUTES_SECRET;
    resetServerEnvForTests();
  });

  it("rejects missing test route secrets before reading the session", async () => {
    const response = await POST(testTemplatesRequest());

    // 404 for both a wrong secret and disabled test routes, so the response
    // does not tell a prober that ENABLE_TEST_ROUTES is on.
    expect(response.status).toBe(404);
    expect(mocked.getSessionUserFromCookies).not.toHaveBeenCalled();
    expect(mocked.createTemplate).not.toHaveBeenCalled();
  });

  it("rejects invalid test route secrets before creating templates", async () => {
    const response = await POST(
      testTemplatesRequest({ secret: "wrong-secret" }),
    );

    expect(response.status).toBe(404);
    expect(mocked.getSessionUserFromCookies).not.toHaveBeenCalled();
    expect(mocked.createTemplate).not.toHaveBeenCalled();
  });

  it("creates templates when the test route secret is valid", async () => {
    const response = await POST(
      testTemplatesRequest({ secret: TEST_ROUTE_SECRET }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      template: {
        id: "template-1",
        label: "Seeded template",
      },
    });
    expect(mocked.createTemplate).toHaveBeenCalledWith("user-1", {
      type: "day",
      label: "Seeded template",
      items: [],
    });
  });
});
