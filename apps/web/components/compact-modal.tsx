"use client";

import { type ReactNode, useRef } from "react";

import { CloseButton } from "./close-button";
import {
  OverlayPortal,
  useBodyScrollLock,
  useEscapeDismiss,
  useFocusTrap,
} from "./overlay-portal";

type CompactModalProps = {
  ariaLabel: string;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
};

export function CompactModal({
  ariaLabel,
  title,
  onClose,
  children,
}: CompactModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useBodyScrollLock();
  useEscapeDismiss(true, onClose);
  useFocusTrap(true, dialogRef);

  return (
    <OverlayPortal>
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className="fixed inset-x-4 top-[8%] z-50 mx-auto max-h-[82vh] max-w-sm overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5 shadow-2xl outline-none"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-[var(--color-ink)]">
            {title}
          </h2>
          <CloseButton
            onClick={onClose}
            className="-m-2 flex h-11 w-11 items-center justify-center rounded-lg text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
            iconSize={18}
          />
        </div>

        {children}
      </div>
    </OverlayPortal>
  );
}
