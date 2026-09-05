/** @vitest-environment jsdom */
import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
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

describe("BarcodeScanner", () => {
  beforeEach(() => {
    vi.resetModules();
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

    const BarcodeScanner = await loadScanner();
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

    const BarcodeScanner = await loadScanner();
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

  it("stops late scanner controls after dismissal during video startup", async () => {
    let resolveControls!: (controls: { stop: () => void }) => void;
    const stopTrack = vi.fn();
    const stopControls = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    mocked.getUserMedia.mockResolvedValue(stream);
    mocked.decodeFromStream.mockReturnValue(
      new Promise((resolve) => {
        resolveControls = resolve;
      }),
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: mocked.getUserMedia },
    });

    const BarcodeScanner = await loadScanner();
    const { unmount } = render(
      <BarcodeScanner onScan={vi.fn()} onNotFound={vi.fn()} onClose={vi.fn()} />,
    );
    await vi.waitFor(() => {
      expect(mocked.decodeFromStream).toHaveBeenCalledOnce();
    });

    unmount();
    await act(async () => {
      resolveControls({ stop: stopControls });
    });

    expect(stopControls).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("stops the acquired stream when video startup fails", async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    mocked.getUserMedia.mockResolvedValue(stream);
    mocked.decodeFromStream.mockRejectedValue(new Error("Video playback failed"));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: mocked.getUserMedia },
    });

    const BarcodeScanner = await loadScanner();
    render(<BarcodeScanner onScan={vi.fn()} onNotFound={vi.fn()} onClose={vi.fn()} />);

    await screen.findByText("Video playback failed");
    expect(stopTrack).toHaveBeenCalledOnce();
  });
});
