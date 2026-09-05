/** @vitest-environment jsdom */
import { StrictMode } from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  decodeFromStream: vi.fn(),
  getUserMedia: vi.fn(),
}));

vi.mock("@zxing/browser", () => ({
  BrowserMultiFormatReader: class {
    decodeFromStream = mocked.decodeFromStream;
  },
}));

vi.mock("@zxing/library", () => ({
  DecodeHintType: { TRY_HARDER: "TRY_HARDER" },
}));

import { BarcodeScanner } from "@/components/barcode-scanner";

describe("BarcodeScanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops a camera stream that resolves after the scanner is dismissed", async () => {
    let resolveCamera!: (stream: MediaStream) => void;
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    mocked.getUserMedia.mockReturnValue(
      new Promise<MediaStream>((resolve) => {
        resolveCamera = resolve;
      }),
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: mocked.getUserMedia },
    });

    const { unmount } = render(
      <BarcodeScanner onScan={vi.fn()} onNotFound={vi.fn()} onClose={vi.fn()} />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    unmount();

    await act(async () => {
      resolveCamera(stream);
      await Promise.resolve();
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(mocked.decodeFromStream).not.toHaveBeenCalled();
  });

  it("does not start the canceled Strict Mode scanner generation", async () => {
    mocked.getUserMedia.mockReturnValue(new Promise<MediaStream>(() => {}));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: mocked.getUserMedia },
    });

    const { unmount } = render(
      <StrictMode>
        <BarcodeScanner onScan={vi.fn()} onNotFound={vi.fn()} onClose={vi.fn()} />
      </StrictMode>,
    );

    await vi.waitFor(() => {
      expect(mocked.getUserMedia).toHaveBeenCalledOnce();
    });
    unmount();
  });
});
