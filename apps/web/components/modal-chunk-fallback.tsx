"use client";

import { createContext, type ReactNode, useContext } from "react";

import { CompactModal } from "./compact-modal";
import {
  OverlayPortal,
  useEscapeDismiss,
} from "./overlay-portal";

const ModalChunkDismissContext = createContext<(() => void) | null>(null);

export function ModalChunkDismissProvider({
  children,
  onDismiss,
}: {
  children: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <ModalChunkDismissContext.Provider value={onDismiss}>
      {children}
    </ModalChunkDismissContext.Provider>
  );
}

function useModalChunkDismiss() {
  const onDismiss = useContext(ModalChunkDismissContext);
  if (!onDismiss) {
    throw new Error("Modal chunk fallbacks require a dismissal provider.");
  }
  return onDismiss;
}

export function ModalChunkFallback({ title }: { title: string }) {
  const onDismiss = useModalChunkDismiss();

  return (
    <CompactModal ariaLabel={title} title={title} onClose={onDismiss}>
      <div className="py-8 text-center">
        <p className="text-sm text-[var(--color-muted)]">Loading…</p>
      </div>
    </CompactModal>
  );
}

// The photo and barcode flows render their own full-screen shells.
export function OverlayBackdropFallback() {
  const onDismiss = useModalChunkDismiss();
  useEscapeDismiss(true, onDismiss);

  return (
    <OverlayPortal>
      <button
        type="button"
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]"
        aria-label="Cancel loading modal"
        onClick={onDismiss}
      />
    </OverlayPortal>
  );
}
