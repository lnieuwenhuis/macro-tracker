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
    <>
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
      {/*
        The armed state is otherwise conveyed only by colour and a changed
        label on a control the user is already focused on, so a screen reader
        never announces that a second tap is now destructive.
      */}
      <span role="status" aria-live="polite" className="sr-only">
        {armed ? `${ariaLabel}: tap again within ${Math.round(timeoutMs / 1000)} seconds to confirm.` : ""}
      </span>
    </>
  );
}

type ConfirmSubmitButtonProps = {
  children: ReactNode;
  /** Copy shown once armed; also announced to assistive technology. */
  confirmLabel: string;
  className: string;
  armedClassName: string;
  disabled?: boolean;
  timeoutMs?: number;
};

/**
 * The same double-tap confirmation for a form's submit button.
 *
 * Role changes and API-token revocations are irreversible but used to fire on
 * a single click. The first click is swallowed and arms the button; the second
 * submits the form normally, so the server action is untouched.
 */
export function ConfirmSubmitButton({
  children,
  confirmLabel,
  className,
  armedClassName,
  disabled,
  timeoutMs = 3000,
}: ConfirmSubmitButtonProps) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (disabled || armed) {
      return;
    }

    event.preventDefault();
    setArmed(true);
    timerRef.current = window.setTimeout(() => {
      setArmed(false);
      timerRef.current = null;
    }, timeoutMs);
  }

  return (
    <>
      <button
        type="submit"
        disabled={disabled}
        onClick={handleClick}
        className={armed ? armedClassName : className}
        data-armed={armed ? "true" : undefined}
      >
        {armed ? confirmLabel : children}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {armed ? `${confirmLabel}. This cannot be undone.` : ""}
      </span>
    </>
  );
}
