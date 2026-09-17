/** @vitest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import { act, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  decodeFromStream: vi.fn(),
  getUserMedia: vi.fn(),
}));

async function loadScanner() {
  vi.doMock("@zxing/browser", () => ({
    BrowserMultiFormatReader: class {
      decodeFromStream = mocked.decodeFromStream;
    },
  }));
  vi.doMock("@zxing/library", () => ({
    DecodeHintType: { TRY_HARDER: "TRY_HARDER" },
  }));
  return (await import("@/components/barcode-scanner")).BarcodeScanner;
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function productPayload(barcode: string) {
  return {
    found: true,
    product: {
      name: "Recovered bar",
      brands: "",
      barcode,
      proteinG: 5,
      carbsG: 5,
      fatG: 5,
      caloriesKcal: 100,
      servingSizeG: 100,
      imageUrl: null,
      source: "openfoodfacts",
    },
  };
}

describe("BarcodeScanner auth recovery (UI-07)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows sign-in recovery for 401 and retries the kept code", async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    mocked.getUserMedia.mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: mocked.getUserMedia },
    });

    // First the camera decodes a barcode; the lookup then hits an expired session.
    mocked.decodeFromStream.mockImplementation(
      async (_stream: unknown, _video: unknown, callback: Function) => {
        queueMicrotask(() =>
          callback({ getText: () => "12345678" }, null, { stop: vi.fn() }),
        );
        return { stop: vi.fn() };
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "expired" }, 401)),
    );

    const BarcodeScanner = await loadScanner();
    const onScan = vi.fn();
    const onNotFound = vi.fn();
    render(<BarcodeScanner onScan={onScan} onNotFound={onNotFound} onClose={vi.fn()} />);

    const signIn = await screen.findByRole("link", { name: /sign in/i });
    expect(signIn.getAttribute("href")).toBe("/login");
    expect(
      screen.queryByText(/could not reach the product database/i),
    ).toBeNull();
    expect(onScan).not.toHaveBeenCalled();
    expect(onNotFound).not.toHaveBeenCalled();

    // After signing in elsewhere, Retry reuses the kept code and succeeds.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(productPayload("12345678")));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    });

    await waitFor(() => expect(onScan).toHaveBeenCalledTimes(1));
    expect(onScan.mock.calls[0]![0]).toMatchObject({ barcode: "12345678" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/barcode/12345678"),
      expect.anything(),
    );
  });
});
