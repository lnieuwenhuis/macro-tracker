"use client";

import { useEffect, useRef } from "react";

import { OverlayPortal, useBodyScrollLock } from "./overlay-portal";
import { ThemePicker } from "./theme-toggle";
import { TransitionLink } from "./transition-link";
import { UiModeToggle } from "./ui-mode-toggle";

type ExperimentalProfileSheetProps = {
  open: boolean;
  userEmail: string;
  canAccessAdmin: boolean;
  onClose: () => void;
};

export function ExperimentalProfileSheet({
  open,
  userEmail,
  canAccessAdmin,
  onClose,
}: ExperimentalProfileSheetProps) {
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
        <div className="absolute inset-y-0 right-0 flex w-full justify-end">
          <div
            ref={panelRef}
            className="flex h-full w-[23rem] max-w-[88vw] flex-col border-l border-[var(--color-border)] bg-[var(--color-surface-strong)] px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))] shadow-2xl"
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] pb-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
                  Settings
                </p>
                <p className="mt-1 text-sm text-[var(--color-muted)]">
                  Themes, account, and UI mode.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-muted)] transition hover:bg-[var(--color-card-muted)] hover:text-[var(--color-ink)]"
                aria-label="Close settings"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" />
                  <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" />
                </svg>
              </button>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto py-5">
              <ThemePicker />
              <div className="space-y-2.5">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
                  Interface
                </span>
                <UiModeToggle onModeChange={onClose} />
              </div>

              {canAccessAdmin ? (
                <div className="space-y-2.5">
                  <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
                    Admin
                  </span>
                  <TransitionLink
                    href="/admin"
                    motion="screen"
                    onClick={onClose}
                    className="flex items-center justify-between rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-4 py-3 text-sm font-semibold text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)]"
                  >
                    Admin Panel
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4.5 2.5h7v7" />
                      <path d="M11.5 2.5 2.5 11.5" />
                    </svg>
                  </TransitionLink>
                </div>
              ) : null}
            </div>

            <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
              <p className="truncate text-xs text-[var(--color-muted)]">
                {userEmail}
              </p>
              <form action="/api/auth/logout" method="post">
                <button
                  type="submit"
                  className="w-full rounded-xl border border-[var(--color-border)] px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-strong)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
                >
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </OverlayPortal>
  );
}
