"use client";

import { useEffect, useRef } from "react";

import type { ComposeAction } from "@/lib/compose";

import { OverlayPortal, useBodyScrollLock } from "./overlay-portal";

type ExperimentalAddSheetProps = {
  open: boolean;
  onClose: () => void;
  onSelect: (action: ComposeAction) => void;
};

const ACTIONS: Array<{
  action: ComposeAction;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    action: "preset",
    label: "Preset",
    description: "Reuse a saved meal",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="12" height="12" rx="2.5" />
        <line x1="9" y1="6" x2="9" y2="12" />
        <line x1="6" y1="9" x2="12" y2="9" />
      </svg>
    ),
  },
  {
    action: "custom",
    label: "Custom",
    description: "Enter macros manually",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
        <line x1="9" y1="4" x2="9" y2="14" />
        <line x1="4" y1="9" x2="14" y2="9" />
      </svg>
    ),
  },
  {
    action: "scan",
    label: "Scan",
    description: "Use the barcode scanner",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
        <rect x="2" y="2" width="4" height="4" />
        <rect x="12" y="2" width="4" height="4" />
        <rect x="2" y="12" width="4" height="4" />
        <line x1="9" y1="2" x2="9" y2="7" />
        <line x1="9" y1="11" x2="9" y2="16" />
        <line x1="12" y1="12" x2="16" y2="12" />
        <line x1="12" y1="15" x2="16" y2="15" />
      </svg>
    ),
  },
  {
    action: "recipe",
    label: "Recipe",
    description: "Add a saved recipe",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="2.5" width="12" height="13" rx="2" />
        <path d="M6 6h6" />
        <path d="M6 9h6" />
        <path d="M6 12h4" />
      </svg>
    ),
  },
];

export function ExperimentalAddSheet({
  open,
  onClose,
  onSelect,
}: ExperimentalAddSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useBodyScrollLock(open);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (panelRef.current?.contains(target)) {
        return;
      }

      onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <OverlayPortal>
      <div className="fixed inset-0 z-50">
        <div className="absolute inset-0 bg-black/35 backdrop-blur-sm" />
        <div className="absolute inset-x-0 bottom-0 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div
            ref={panelRef}
            className="mx-auto w-full max-w-3xl rounded-[2rem] border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5 shadow-[0_30px_80px_rgba(0,0,0,0.24)]"
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
                  Add to Food Log
                </p>
                <p className="mt-1 text-sm text-[var(--color-muted)]">
                  Pick how you want to add the next item.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-muted)] transition hover:bg-[var(--color-card-muted)] hover:text-[var(--color-ink)]"
                aria-label="Close add menu"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" />
                  <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" />
                </svg>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {ACTIONS.map((item) => (
                <button
                  key={item.action}
                  type="button"
                  onClick={() => onSelect(item.action)}
                  className="rounded-[1.5rem] border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-4 text-left transition hover:-translate-y-0.5 hover:border-[var(--color-accent)]"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--color-card-muted)] text-[var(--color-accent)]">
                    {item.icon}
                  </span>
                  <span className="mt-4 block text-sm font-bold text-[var(--color-ink)]">
                    {item.label}
                  </span>
                  <span className="mt-1 block text-xs text-[var(--color-muted)]">
                    {item.description}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </OverlayPortal>
  );
}
