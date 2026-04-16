"use client";

import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

type ConfirmDeleteButtonProps = {
  onConfirm: () => void;
  ariaLabel: string;
  children: ReactNode;
  disabled?: boolean;
  timeoutMs?: number;
  /**
   * Tailwind classes applied when idle. Defaults to a muted icon button that
   * goes red on hover — matches the existing delete-button look across the
   * app, so callers don't need to restyle anything.
   */
  className?: string;
  title?: string;
};

/**
 * A double-tap confirm button. First tap "arms" the button (red tint + swaps
 * the a11y label). A second tap within {@link timeoutMs} (default 3 s) invokes
 * `onConfirm`. This avoids modal friction and works much better on mobile than
 * `window.confirm`.
 *
 * Callers pass their existing SVG icon as `children` so idle visuals don't
 * change — only the confirm state changes the look.
 */
export function ConfirmDeleteButton({
  onConfirm,
  ariaLabel,
  children,
  disabled,
  timeoutMs = 3000,
  className,
  title,
}: ConfirmDeleteButtonProps) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<number | null>(null);

  function clearTimer() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  useEffect(() => {
    return clearTimer;
  }, []);

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (disabled) return;

    if (!armed) {
      setArmed(true);
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        setArmed(false);
        timerRef.current = null;
      }, timeoutMs);
      return;
    }

    clearTimer();
    setArmed(false);
    onConfirm();
  }

  const idleClass =
    className ??
    "shrink-0 rounded-lg p-1.5 text-[var(--color-muted)] transition hover:text-[var(--color-danger)] disabled:opacity-50";
  const armedClass =
    "shrink-0 rounded-lg p-1.5 bg-[var(--color-danger)]/15 text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/40 transition disabled:opacity-50";

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={handleClick}
      className={armed ? armedClass : idleClass}
      aria-label={armed ? "Tap again to confirm" : ariaLabel}
      title={armed ? "Tap again to confirm" : title}
      data-armed={armed ? "true" : undefined}
    >
      {children}
    </button>
  );
}
