import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  backendFetch: vi.fn(),
}));

vi.mock("@macro-tracker/db", () => ({
  backendFetch: mocked.backendFetch,
}));

import { POST } from "@/app/api/admin/ai-model-benchmark/route";

function benchmarkRequest(body?: Record<string, unknown>) {
  return new Request("http://localhost/api/admin/ai-model-benchmark", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: "mt_session=session-token",
    },
    body: JSON.stringify({
      fixtureLimit: 4,
      mode: "compare",
      model: "candidate/free",
      ...body,
    }),
  });
}

describe("POST /api/admin/ai-model-benchmark", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("proxies benchmark requests to the Rust backend", async () => {
    mocked.backendFetch.mockImplementation(async (_path, init) => {
      const body = await new Response(init?.body as BodyInit).json();
      expect(body).toMatchObject({
        fixtureLimit: 18,
        mode: "compare",
        model: "candidate/free",
      });
      return Response.json({ ok: true, result: { fixtureCount: 18 } });
    });

    const response = await POST(benchmarkRequest({ fixtureLimit: 18 }));

    expect(response.status).toBe(200);
    expect(mocked.backendFetch).toHaveBeenCalledWith(
      "/api/admin/ai-model-benchmark",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
        duplex: "half",
      }),
    );
    await expect(response.json()).resolves.toEqual({
      ok: true,
      result: { fixtureCount: 18 },
    });
  });

  it("preserves backend benchmark lock responses", async () => {
    mocked.backendFetch.mockResolvedValue(
      Response.json(
        {
          ok: false,
          error: "A benchmark run is already in progress. Try again shortly.",
        },
        { status: 409, headers: { "Retry-After": "10" } },
      ),
    );

    const response = await POST(benchmarkRequest());

    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBe("10");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "A benchmark run is already in progress. Try again shortly.",
    });
  });
});
