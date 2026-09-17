import { afterEach, describe, expect, it, vi } from "vitest";

import { lookupBarcode } from "@/lib/openfoodfacts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("lookupBarcode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the product for a found barcode, coercing malformed numeric fields to 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          found: true,
          product: {
            name: "Test bar",
            proteinG: "12",
            carbsG: -5,
            fatG: Number.NaN,
            caloriesKcal: 100,
          },
        }),
      ),
    );

    const result = await lookupBarcode("12345678");

    expect(result).toEqual({
      found: true,
      product: {
        productId: null,
        name: "Test bar",
        brands: "",
        barcode: "12345678",
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
        caloriesKcal: 100,
        servingSizeG: null,
        imageUrl: null,
        source: "openfoodfacts",
      },
    });
  });

  it("returns not_found for a genuine catalogue miss", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ found: false })));

    const result = await lookupBarcode("00000000");

    expect(result).toEqual({ found: false, barcode: "00000000", reason: "not_found" });
  });

  it("returns unavailable, not not_found, when the response status is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 502)));

    const result = await lookupBarcode("11111111");

    expect(result).toEqual({ found: false, barcode: "11111111", reason: "unavailable" });
  });

  it("returns unavailable when found:true carries an unusable product body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ found: true, product: null })),
    );

    const result = await lookupBarcode("22222222");

    expect(result).toEqual({ found: false, barcode: "22222222", reason: "unavailable" });
  });

  it("returns unavailable, not not_found, on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await lookupBarcode("33333333");

    expect(result).toEqual({ found: false, barcode: "33333333", reason: "unavailable" });
  });

  it("returns auth for direct 401 and 403 instead of a connectivity failure", async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({ error: "denied" }, status)),
      );

      const result = await lookupBarcode("44444444");

      expect(result).toEqual({ found: false, barcode: "44444444", reason: "auth" });
    }
  });

  it("returns auth for a redirected login page and HTML bodies", async () => {
    const htmlHeaders = { "content-type": "text/html" };
    const redirected = new Response("<html>login</html>", {
      status: 200,
      headers: htmlHeaders,
    });
    Object.defineProperty(redirected, "redirected", { value: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(redirected));
    expect(await lookupBarcode("55555555")).toEqual({
      found: false,
      barcode: "55555555",
      reason: "auth",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>login</html>", { status: 200, headers: htmlHeaders }),
      ),
    );
    expect(await lookupBarcode("55555555")).toEqual({
      found: false,
      barcode: "55555555",
      reason: "auth",
    });

    // HTML login served as 200 without a content-type header is still auth.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<!DOCTYPE html><html>login</html>", { status: 200 })),
    );
    expect(await lookupBarcode("55555555")).toEqual({
      found: false,
      barcode: "55555555",
      reason: "auth",
    });
  });

  it("keeps genuine misses and outages distinct from auth", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ found: false })));
    expect(await lookupBarcode("00000000")).toEqual({
      found: false,
      barcode: "00000000",
      reason: "not_found",
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 502)));
    expect(await lookupBarcode("11111111")).toEqual({
      found: false,
      barcode: "11111111",
      reason: "unavailable",
    });
  });

  it("keeps an HTML outage page an outage instead of auth recovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>503 Service Unavailable</html>", {
          status: 503,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    expect(await lookupBarcode("77777777")).toEqual({
      found: false,
      barcode: "77777777",
      reason: "unavailable",
    });
  });
});
