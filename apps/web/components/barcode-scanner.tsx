"use client";

import { useEffect, useRef, useState } from "react";

import { lookupBarcode, type OpenFoodFactsProduct } from "@/lib/openfoodfacts";

type BarcodeScannerProps = {
  onScan: (product: OpenFoodFactsProduct) => void;
  onNotFound: (barcode: string) => void;
  onClose: () => void;
};

export function BarcodeScanner({
  onScan,
  onNotFound,
  onClose,
}: BarcodeScannerProps) {
  const scannerRef = useRef<HTMLDivElement>(null);
  const html5QrCodeRef = useRef<unknown>(null);
  const lastScanRef = useRef<string>("");
  const isRunningRef = useRef(false);

  // Keep stable references to callbacks so the effect doesn't re-run
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const onNotFoundRef = useRef(onNotFound);
  onNotFoundRef.current = onNotFound;
  const [status, setStatus] = useState<"loading" | "scanning" | "looking-up" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;

    async function stopScanner(scanner: { stop?: () => Promise<void>; clear?: () => void }) {
      if (!isRunningRef.current) return;
      isRunningRef.current = false;
      try {
        await scanner.stop?.();
      } catch {
        // Scanner was already stopped or not running — safe to ignore
      }
    }

    async function startScanner() {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");

        if (stopped || !scannerRef.current) return;

        const scannerId = "barcode-scanner-region";
        scannerRef.current.id = scannerId;

        const html5QrCode = new Html5Qrcode(scannerId);
        html5QrCodeRef.current = html5QrCode;

        await html5QrCode.start(
          { facingMode: "environment" },
          {
            fps: 10,
            qrbox: { width: 250, height: 150 },
            aspectRatio: 1.0,
          },
          async (decodedText: string) => {
            // Debounce: ignore same barcode within 3 seconds
            if (decodedText === lastScanRef.current) return;
            lastScanRef.current = decodedText;

            setStatus("looking-up");

            await stopScanner(html5QrCode);

            try {
              const result = await lookupBarcode(decodedText);
              if (stopped) return;

              if (result.found) {
                onScanRef.current(result.product);
              } else {
                onNotFoundRef.current(result.barcode);
              }
            } catch {
              if (!stopped) {
                onNotFoundRef.current(decodedText);
              }
            }
          },
          () => {
            // ignore scan errors (no barcode found in frame)
          },
        );

        isRunningRef.current = true;

        if (!stopped) {
          setStatus("scanning");
        }
      } catch (err) {
        if (stopped) return;
        setStatus("error");
        const message =
          err instanceof Error ? err.message : "Failed to start camera.";

        if (message.toLowerCase().includes("permission")) {
          setErrorMessage(
            "Camera access was denied. Please allow camera access in your browser settings and try again.",
          );
        } else {
          setErrorMessage(message);
        }
      }
    }

    startScanner();

    return () => {
      stopped = true;
      const scanner = html5QrCodeRef.current as {
        stop?: () => Promise<void>;
        clear?: () => void;
      } | null;
      if (scanner) {
        stopScanner(scanner).then(() => scanner.clear?.());
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stored in refs
  }, []);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />

      {/* Close button */}
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-[calc(1rem+env(safe-area-inset-top))] z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white transition hover:bg-white/30"
        aria-label="Close scanner"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <line x1="4" y1="4" x2="14" y2="14" />
          <line x1="14" y1="4" x2="4" y2="14" />
        </svg>
      </button>

      {/* Scanner area */}
      <div className="relative z-10 w-full max-w-sm px-6">
        <div
          ref={scannerRef}
          className="overflow-hidden rounded-2xl bg-black"
          style={{ minHeight: 280 }}
        />

        {/* Status text */}
        <div className="mt-4 text-center">
          {status === "loading" && (
            <p className="text-sm text-white/70">Starting camera...</p>
          )}
          {status === "scanning" && (
            <p className="text-sm text-white/70">
              Point at a barcode on the product
            </p>
          )}
          {status === "looking-up" && (
            <p className="text-sm text-white">Looking up product...</p>
          )}
          {status === "error" && (
            <div className="space-y-3">
              <p className="text-sm text-red-400">
                {errorMessage ?? "Could not access camera."}
              </p>
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl bg-white/20 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/30"
              >
                Go back
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
