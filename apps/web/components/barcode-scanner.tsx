"use client";

import { useEffect, useRef, useState } from "react";

import { lookupBarcode, type OpenFoodFactsProduct } from "@/lib/openfoodfacts";

type ScannerStatus = "loading" | "scanning" | "looking-up" | "error";

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const isProcessingRef = useRef(false);
  const stoppedRef = useRef(false);

  // Keep stable references to callbacks so the effect doesn't re-run
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const onNotFoundRef = useRef(onNotFound);
  onNotFoundRef.current = onNotFound;

  const [status, setStatus] = useState<ScannerStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    stoppedRef.current = false;
    isProcessingRef.current = false;

    async function startScanner() {
      try {
        const [{ BrowserMultiFormatReader }, { DecodeHintType }] =
          await Promise.all([
            import("@zxing/browser"),
            import("@zxing/library"),
          ]);

        if (stoppedRef.current || !videoRef.current) return;

        // TRY_HARDER makes ZXing rotate and invert the image on each frame,
        // so barcodes are detected in any orientation — not just horizontal.
        const hints = new Map();
        hints.set(DecodeHintType.TRY_HARDER, true);

        const reader = new BrowserMultiFormatReader(hints, {
          delayBetweenScanAttempts: 80,
        });

        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: "environment" } },
          videoRef.current,
          async (result, _error, frameControls) => {
            if (!result || isProcessingRef.current || stoppedRef.current)
              return;

            isProcessingRef.current = true;
            const barcode = result.getText();

            // Stop scanning immediately so we don't fire again while awaiting
            frameControls.stop();
            setStatus("looking-up");

            try {
              const lookupResult = await lookupBarcode(barcode);
              if (stoppedRef.current) return;

              if (lookupResult.found) {
                onScanRef.current(lookupResult.product);
              } else {
                onNotFoundRef.current(lookupResult.barcode);
              }
            } catch {
              if (!stoppedRef.current) {
                onNotFoundRef.current(barcode);
              }
            }
          },
        );

        controlsRef.current = controls;
        if (!stoppedRef.current) setStatus("scanning");
      } catch (err) {
        if (stoppedRef.current) return;
        setStatus("error");
        const message =
          err instanceof Error ? err.message : "Failed to start camera.";

        if (/permission|notallowed|denied/i.test(message)) {
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
      stoppedRef.current = true;
      controlsRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stored in refs
  }, []);

  // Lock body scroll while scanner is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black">
      {/* Full-screen camera feed */}
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-cover"
        autoPlay
        playsInline
        muted
      />

      {/* Darkened overlay with a transparent scanning cutout via box-shadow */}
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center">
        <div
          className="relative"
          style={{
            width: 284,
            height: 164,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.60)",
          }}
        >
          {/* Corner brackets */}
          <span className="absolute left-0 top-0 h-6 w-6 border-l-2 border-t-2 border-white/90" />
          <span className="absolute right-0 top-0 h-6 w-6 border-r-2 border-t-2 border-white/90" />
          <span className="absolute bottom-0 left-0 h-6 w-6 border-b-2 border-l-2 border-white/90" />
          <span className="absolute bottom-0 right-0 h-6 w-6 border-b-2 border-r-2 border-white/90" />

          {/* Animated scan line — only shown while actively scanning */}
          {status === "scanning" && (
            <div className="scan-line absolute inset-x-2 h-px bg-[var(--color-accent)] opacity-80 shadow-[0_0_6px_1px_var(--color-accent)]" />
          )}
        </div>

        {/* Status text sits just below the scanning frame */}
        <div className="mt-8 flex min-h-[56px] flex-col items-center gap-3 px-8 text-center">
          {status === "loading" && (
            <p className="text-sm text-white/60">Starting camera…</p>
          )}
          {status === "scanning" && (
            <p className="text-sm text-white/70">
              Point the barcode at the frame
            </p>
          )}
          {status === "looking-up" && (
            <p className="text-sm font-medium text-white">
              Looking up product…
            </p>
          )}
          {status === "error" && (
            <>
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
            </>
          )}
        </div>
      </div>

      {/* Close button */}
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-[calc(1rem+env(safe-area-inset-top))] z-20 flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white transition hover:bg-white/30"
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
    </div>
  );
}
