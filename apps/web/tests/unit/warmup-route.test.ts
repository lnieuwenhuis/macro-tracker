import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  buildAppWarmupPayload: vi.fn(),
  requireOnboardedSessionUser: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireOnboardedSessionUser: mocked.requireOnboardedSessionUser,
}));

vi.mock("@/lib/app-warmup.server", () => ({
  buildAppWarmupPayload: mocked.buildAppWarmupPayload,
}));

import { GET } from "@/app/api/app/warmup/route";

describe("GET /api/app/warmup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.requireOnboardedSessionUser.mockResolvedValue({
      id: "user-1",
      email: "lars@example.com",
    });
    mocked.buildAppWarmupPayload.mockResolvedValue({
      goals: {},
      templates: [],
      recipes: [],
      recentCandidates: [],
      days: {},
      user: { email: "lars@example.com", canAccessAdmin: false },
    });
  });

  it("uses the extended warmup scope when explicitly requested", async () => {
    const response = await GET(
      new Request("http://localhost/api/app/warmup?date=2026-03-19&scope=extended"),
    );

    expect(response.status).toBe(200);
    expect(mocked.buildAppWarmupPayload).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "extended", selectedDate: "2026-03-19" }),
    );
  });

  it("returns 400 for unsupported non-empty warmup scopes", async () => {
    const response = await GET(
      new Request("http://localhost/api/app/warmup?scope=everything"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Unsupported warmup scope "everything". Expected "core" or "extended".',
    });
    expect(mocked.requireOnboardedSessionUser).not.toHaveBeenCalled();
    expect(mocked.buildAppWarmupPayload).not.toHaveBeenCalled();
  });
});