"use client";

import { useEffect, useRef, useState } from "react";

import { lookupBarcode, type OpenFoodFactsProduct } from "@/lib/openfoodfacts";
import { ModalSurface } from "./modal-surface";
import { OverlayPortal } from "./overlay-portal";

type ScannerStatus = "loading" | "scanning" | "looking-up" | "error";

type BarcodeScannerProps = {
  onScan: (product: OpenFoodFactsProduct) => void;
  onNotFound: (barcode: string) => void;
  onClose: () => void;
};

const LOOKUP_UNAVAILABLE_MESSAGE =
  "Could not reach the product database. Check your connection and try again.";

export function BarcodeScanner({
  onScan,
  onNotFound,
  onClose,
}: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Keep stable references to callbacks so the effect doesn't re-run
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const onNotFoundRef = useRef(onNotFound);
  onNotFoundRef.current = onNotFound;

  const [status, setStatus] = useState<ScannerStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let isProcessing = false;
    let stream: MediaStream | null = null;
    let controls: { stop: () => void } | null = null;
    let scanningStopped = false;
    const lookupController = new AbortController();

    function stopStream() {
      stream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current?.srcObject === stream) {
        videoRef.current.srcObject = null;
      }
    }

    function stopScanning() {
      if (scanningStopped) return;
      scanningStopped = true;
      controls?.stop();
      stopStream();
    }

    function failLookup() {
      setStatus("error");
      setErrorMessage(LOOKUP_UNAVAILABLE_MESSAGE);
    }

    async function startScanner() {
      try {
        const [{ BrowserMultiFormatReader }, { DecodeHintType }] =
          await Promise.all([
            import("@zxing/browser"),
            import("@zxing/library"),
          ]);

        if (cancelled || !videoRef.current) return;

        // TRY_HARDER makes ZXing rotate/invert each frame, so barcodes are detected in any orientation.
        const hints = new Map();
        hints.set(DecodeHintType.TRY_HARDER, true);

        const reader = new BrowserMultiFormatReader(hints, {
          delayBetweenScanAttempts: 80,
        });

        // Acquire the stream ourselves: ZXing 0.1.x globally retains streams created through decodeFromConstraints.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) {
          stopStream();
          return;
        }

        const startedControls = await reader.decodeFromStream(
          stream,
          videoRef.current,
          async (result, _error, frameControls) => {
            if (!result || isProcessing || cancelled) return;

            isProcessing = true;
            const barcode = result.getText();

            // Stop scanning immediately so we don't fire again while awaiting
            frameControls.stop();
            stopScanning();
            setStatus("looking-up");

            try {
              const lookupResult = await lookupBarcode(
                barcode,
                lookupController.signal,
              );
              if (cancelled) return;

              if (lookupResult.found) {
                onScanRef.current(lookupResult.product);
              } else if (lookupResult.reason === "unavailable") {
                // Not a catalogue miss: the lookup failed, so don't send the user to re-enter a product that may exist.
                failLookup();
              } else {
                onNotFoundRef.current(lookupResult.barcode);
              }
            } catch {
              if (!cancelled) {
                failLookup();
              }
            }
          },
        );

        controls = startedControls;
        if (cancelled || scanningStopped) {
          stopScanning();
          return;
        }
        setStatus("scanning");
      } catch (err) {
        if (cancelled) return;
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
      cancelled = true;
      lookupController.abort();
      stopScanning();
    };
  }, []);

  return (
    <OverlayPortal>
      <ModalSurface
        ariaLabel="Barcode scanner"
        onClose={onClose}
        className="fixed inset-0 z-50 bg-black outline-none"
      >
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
            <span className="absolute left-0 top-0 h-6 w-6 border-l-2 border-t-2 border-white/90" />
            <span className="absolute right-0 top-0 h-6 w-6 border-r-2 border-t-2 border-white/90" />
            <span className="absolute bottom-0 left-0 h-6 w-6 border-b-2 border-l-2 border-white/90" />
            <span className="absolute bottom-0 right-0 h-6 w-6 border-b-2 border-r-2 border-white/90" />

            {status === "scanning" && (
              <div className="scan-line absolute inset-x-2 h-px bg-[var(--color-accent)] opacity-80 shadow-[0_0_6px_1px_var(--color-accent)]" />
            )}
          </div>

          <div
            role="status"
            aria-live="polite"
            className="mt-8 flex min-h-[56px] flex-col items-center gap-3 px-8 text-center"
          >
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
                {/* Fixed light red, not --color-danger: this overlay is always
                    black, so the themed token can drop below contrast. */}
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

        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-[calc(1rem+env(safe-area-inset-top))] z-20 flex h-11 w-11 items-center justify-center rounded-full bg-white/20 text-white transition hover:bg-white/30"
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
      </ModalSurface>
    </OverlayPortal>
  );
}
