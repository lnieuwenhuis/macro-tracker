import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  getSessionUserFromCookies: vi.fn(),
  getUserById: vi.fn(),
  ensureUserRole: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));

vi.mock("@/lib/session", () => ({
  getSessionUserFromCookies: mocked.getSessionUserFromCookies,
}));

vi.mock("@macro-tracker/db", () => ({
  getUserById: mocked.getUserById,
  ensureUserRole: mocked.ensureUserRole,
  canAccessAdmin: (role: string) => role === "admin" || role === "owner",
  isOwnerRole: (role: string) => role === "owner",
}));

vi.mock("next/navigation", () => ({
  redirect: mocked.redirect,
  notFound: mocked.notFound,
}));

import { getCurrentAppUser, requireAdminUser, requireOwnerUser } from "@/lib/auth";
import { resetServerEnvForTests } from "@/lib/env";

function buildUser(overrides?: Partial<Awaited<ReturnType<typeof getCurrentAppUser>>>) {
  return {
    id: "user-1",
    email: "owner@example.com",
    shooPairwiseSub: "ps_owner",
    displayName: "Owner",
    pictureUrl: null,
    role: "user",
    createdAt: "2026-04-17T10:00:00.000Z",
    lastLoginAt: "2026-04-17T10:00:00.000Z",
    goalCaloriesKcal: null,
    goalProteinG: null,
    goalCarbsG: null,
    goalFatG: null,
    goalWeightKg: null,
    ...overrides,
  };
}

describe("admin auth helpers", () => {
  beforeEach(() => {
    process.env.APP_URL = "http://localhost:3000";
    process.env.SESSION_SECRET = "test-secret";
    process.env.SHOO_BASE_URL = "https://shoo.dev";
    process.env.ADMIN_OWNER_EMAILS = "owner@example.com";
    resetServerEnvForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetServerEnvForTests();
  });

  it("bootstraps configured owner emails to the owner role", async () => {
    mocked.getSessionUserFromCookies.mockResolvedValue({
      userId: "user-1",
      email: "owner@example.com",
    });
    mocked.getUserById.mockResolvedValue(buildUser());
    mocked.ensureUserRole.mockResolvedValue(buildUser({ role: "owner" }));

    const user = await getCurrentAppUser();

    expect(user?.role).toBe("owner");
    expect(mocked.ensureUserRole).toHaveBeenCalledWith("user-1", "owner");
  });

  it("returns notFound for non-admin users hitting admin routes", async () => {
    mocked.getSessionUserFromCookies.mockResolvedValue({
      userId: "user-1",
      email: "user@example.com",
    });
    mocked.getUserById.mockResolvedValue(
      buildUser({ email: "user@example.com", role: "user" }),
    );

    await expect(requireAdminUser()).rejects.toThrow("notFound");
    expect(mocked.notFound).toHaveBeenCalled();
  });

  it("allows owners through owner-only routes", async () => {
    mocked.getSessionUserFromCookies.mockResolvedValue({
      userId: "user-1",
      email: "owner@example.com",
    });
    mocked.getUserById.mockResolvedValue(buildUser({ role: "owner" }));

    const user = await requireOwnerUser();

    expect(user.role).toBe("owner");
    expect(mocked.notFound).not.toHaveBeenCalled();
  });
});
