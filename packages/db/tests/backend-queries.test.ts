import { afterEach, describe, expect, it, vi } from "vitest";

const backendRpc = vi.fn();

vi.mock("../src/backend-client", () => ({
  backendRpc,
}));

const { getRecentDailyOverviews, getRecentQuickAddCandidates } = await import("../src/backend-queries");

describe("backend query facade", () => {
  afterEach(() => {
    backendRpc.mockReset();
  });

  it("passes selectedDate through for recent daily overviews", async () => {
    backendRpc.mockResolvedValue([]);

    await getRecentDailyOverviews("user-1", "2026-03-19", 8);

    expect(backendRpc).toHaveBeenCalledWith("getRecentDailyOverviews", {
      userId: "user-1",
      selectedDate: "2026-03-19",
      days: 8,
    });
  });

  it("uses the legacy quick-add default limit when omitted", async () => {
    backendRpc.mockResolvedValue([]);

    await getRecentQuickAddCandidates("user-1");

    expect(backendRpc).toHaveBeenCalledWith("getRecentQuickAddCandidates", {
      userId: "user-1",
      limit: 30,
    });
  });
});
