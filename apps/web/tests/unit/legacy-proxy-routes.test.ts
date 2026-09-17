import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  backendFetch: vi.fn(),
}));

vi.mock("@macro-tracker/db", async () => (await import("./helpers/mock-db")).mockDbModule(mocked));

import { POST as benchmarkPost } from "@/app/api/admin/ai-model-benchmark/route";
import { POST as foodPhotoPost } from "@/app/api/ai/food-photo/route";
import { GET as barcodeGet } from "@/app/api/barcode/[barcode]/route";

describe("legacy backend proxy route failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a shaped JSON error when barcode lookup backendFetch throws", async () => {
    mocked.backendFetch.mockRejectedValue(new Error("backend unavailable"));

    const response = await barcodeGet(new Request("http://localhost/api/barcode/123"), {
      params: Promise.resolve({ barcode: "123" }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      found: false,
      error: "Barcode lookup service is unavailable.",
    });
  });

  it("returns a shaped JSON error when food-photo backendFetch throws", async () => {
    mocked.backendFetch.mockRejectedValue(new Error("backend unavailable"));

    const response = await foodPhotoPost(
      new Request("http://localhost/api/ai/food-photo", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ image: "data:image/png;base64,abc" }),
      }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      kind: "backend_unavailable",
      error: "Food photo analysis service is unavailable.",
    });
  });

  it("refuses a same-site sibling origin before contacting the gateway", async () => {
    // SEC-03: SameSite=Lax still attaches the victim's cookies to a same-site request.
    const response = await foodPhotoPost(
      new Request("http://localhost/api/ai/food-photo", {
        method: "POST",
        headers: {
          origin: "https://evil.example.com",
          "sec-fetch-site": "same-site",
          cookie: "mt_session=victim-session",
        },
        body: "image-bytes",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ kind: "forbidden" });
    expect(mocked.backendFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["cross-site", { "sec-fetch-site": "cross-site", origin: "https://evil.example.com" }],
    ["absent fetch metadata", {}],
  ])("refuses a %s food-photo request", async (_label, headers) => {
    const response = await foodPhotoPost(
      new Request("http://localhost/api/ai/food-photo", {
        method: "POST",
        headers,
        body: "image-bytes",
      }),
    );

    expect(response.status).toBe(403);
    expect(mocked.backendFetch).not.toHaveBeenCalled();
  });

  it("returns a shaped JSON error when benchmark backendFetch throws", async () => {
    mocked.backendFetch.mockRejectedValue(new Error("backend unavailable"));

    const response = await benchmarkPost(
      new Request("http://localhost/api/admin/ai-model-benchmark", {
        method: "POST",
        body: JSON.stringify({ mode: "compare" }),
      }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Benchmark service is unavailable.",
    });
  });
});
