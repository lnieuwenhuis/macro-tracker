"use client";

import { useRef } from "react";

import { APP_VERSION_LABEL } from "@/lib/app-version";

import { CloseButton } from "./close-button";
import {
  OverlayPortal,
  useBodyScrollLock,
  useDismissableLayer,
  useFocusTrap,
} from "./overlay-portal";
import { ThemePicker } from "./theme-toggle";
import { TransitionLink } from "./transition-link";

type ProfileSheetProps = {
  open: boolean;
  userEmail: string;
  canAccessAdmin: boolean;
  selectedDate: string;
  onClose: () => void;
};

export function ProfileSheet({
  open,
  userEmail,
  canAccessAdmin,
  selectedDate,
  onClose,
}: ProfileSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useBodyScrollLock(open);
  useDismissableLayer({ active: open, layerRef: panelRef, onDismiss: onClose });
  useFocusTrap(open, panelRef);

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
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            tabIndex={-1}
            className="flex h-full w-[23rem] max-w-[88vw] flex-col border-l border-[var(--color-border)] bg-[var(--color-surface-strong)] px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))] shadow-2xl outline-none"
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] pb-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
                  Settings
                </p>
                <p className="mt-1 text-sm text-[var(--color-muted)]">
                  Themes and account.
                </p>
              </div>
              <CloseButton
                onClick={onClose}
                className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--color-muted)] transition hover:bg-[var(--color-card-muted)] hover:text-[var(--color-ink)]"
                label="Close settings"
              />
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto py-5">
              <ThemePicker />

              <div className="space-y-2.5">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
                  Library
                </span>
                <TransitionLink
                  href={`/library?date=${selectedDate}`}
                  motion="screen"
                  onClick={onClose}
                  className="flex items-center justify-between rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-4 py-3 text-sm font-semibold text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)]"
                >
                  Food Library
                  <span aria-hidden="true">+</span>
                </TransitionLink>
                <TransitionLink
                  href={`/planner?date=${selectedDate}`}
                  motion="screen"
                  onClick={onClose}
                  className="flex items-center justify-between rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-4 py-3 text-sm font-semibold text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)]"
                >
                  Meal Planner
                  <span aria-hidden="true">+</span>
                </TransitionLink>
                <TransitionLink
                  href="/settings/api"
                  motion="screen"
                  onClick={onClose}
                  className="flex items-center justify-between rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-4 py-3 text-sm font-semibold text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)]"
                >
                  API Access
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4.5 2.5h7v7" />
                    <path d="M11.5 2.5 2.5 11.5" />
                  </svg>
                </TransitionLink>
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
              <div className="flex items-center justify-between gap-3 text-xs text-[var(--color-muted)]">
                <p className="min-w-0 truncate">
                  {userEmail}
                </p>
                <p className="shrink-0 font-semibold tabular-nums">
                  {APP_VERSION_LABEL}
                </p>
              </div>
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
