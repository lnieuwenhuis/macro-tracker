"use client";

import type { OpenFoodFactsProduct } from "@/lib/openfoodfacts";

import {
  BarcodeResult,
  type BarcodeFoodSelection,
} from "./barcode-result";
import { BarcodeScanner } from "./barcode-scanner";

type BarcodeCaptureModalsProps = {
  showScanner: boolean;
  scanResult: OpenFoodFactsProduct | null;
  notFoundBarcode: string | null;
  setShowScanner: (showScanner: boolean) => void;
  setScanResult: (product: OpenFoodFactsProduct | null) => void;
  setNotFoundBarcode: (barcode: string | null) => void;
  onAddToLog: (input: BarcodeFoodSelection) => void;
  // UI-01: resolves true only when the template actually persisted.
  onSaveAsPreset: (input: BarcodeFoodSelection) => Promise<boolean>;
};

export function BarcodeCaptureModals({
  showScanner,
  scanResult,
  notFoundBarcode,
  setShowScanner,
  setScanResult,
  setNotFoundBarcode,
  onAddToLog,
  onSaveAsPreset,
}: BarcodeCaptureModalsProps) {
  function clearScanResult() {
    setScanResult(null);
    setNotFoundBarcode(null);
  }

  return (
    <>
      {showScanner && (
        <BarcodeScanner
          onScan={(product) => {
            setShowScanner(false);
            setScanResult(product);
            setNotFoundBarcode(null);
          }}
          onNotFound={(barcode) => {
            setShowScanner(false);
            setScanResult(null);
            setNotFoundBarcode(barcode);
          }}
          onClose={() => setShowScanner(false)}
        />
      )}

      {(scanResult || notFoundBarcode) && (
        <BarcodeResult
          product={scanResult}
          notFoundBarcode={notFoundBarcode}
          onAddToLog={(input) => {
            onAddToLog(input);
            clearScanResult();
          }}
          onSaveAsPreset={onSaveAsPreset}
          onScanAnother={() => {
            clearScanResult();
            setShowScanner(true);
          }}
          onClose={clearScanResult}
        />
      )}
    </>
  );
}
