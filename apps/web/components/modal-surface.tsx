"use client";

import { type ReactNode, useRef } from "react";

import { useBodyScrollLock, useEscapeDismiss, useFocusTrap } from "./overlay-portal";

type ModalSurfaceProps = {
  ariaLabel: string;
  onClose: () => void;
  /** Set `false` while a dismissal would abandon in-flight work. */
  dismissable?: boolean;
  lockScroll?: boolean;
  className?: string;
  children: ReactNode;
};

/**
 * The panel of a hand-rolled overlay: dialog semantics, Escape, focus trap and
 * scroll lock in one place.
 *
 * `CompactModal` owns the standard centred dialog; this exists for the
 * full-screen and bottom-sheet flows whose chrome differs too much to share
 * that shell, so they at least share the accessibility behaviour.
 */
export function ModalSurface({
  ariaLabel,
  onClose,
  dismissable = true,
  lockScroll = true,
  className,
  children,
}: ModalSurfaceProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useBodyScrollLock(lockScroll);
  useEscapeDismiss(dismissable, onClose);
  useFocusTrap(true, dialogRef);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      className={className}
    >
      {children}
    </div>
  );
}
