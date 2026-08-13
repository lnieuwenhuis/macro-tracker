"use client";

import { type ReactNode, type RefObject, useEffect } from "react";
import { createPortal } from "react-dom";

export function useBodyScrollLock(active = true) {
  useEffect(() => {
    if (!active) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [active]);
}

export function useDismissableLayer<T extends HTMLElement>({
  active = true,
  layerRef,
  onDismiss,
  onKeyDown,
}: {
  active?: boolean;
  layerRef: RefObject<T | null>;
  onDismiss: () => void;
  onKeyDown?: (event: KeyboardEvent) => void;
}) {
  useEffect(() => {
    if (!active) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onDismiss();
        return;
      }

      onKeyDown?.(event);
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (layerRef.current?.contains(target)) {
        return;
      }

      onDismiss();
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [active, layerRef, onDismiss, onKeyDown]);
}

export function useEscapeDismiss(active: boolean, onDismiss: () => void) {
  useEffect(() => {
    if (!active) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onDismiss();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [active, onDismiss]);
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function isFocusable(element: HTMLElement) {
  if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") {
    return false;
  }

  // `offsetParent` is not a usable visibility test — it is null for anything
  // inside a `position: fixed` subtree, which is exactly what these dialogs
  // are. `checkVisibility` is; where it is unavailable, err towards including
  // the element so the trap stays closed.
  return typeof element.checkVisibility === "function"
    ? element.checkVisibility()
    : true;
}

function getFocusableElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(isFocusable);
}

/**
 * Keeps Tab focus inside an open dialog and restores it to the trigger on
 * close.
 *
 * Without this a keyboard user tabs straight out of the dialog into the page
 * behind it — which is still fully interactive and still announced by screen
 * readers.
 */
export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  containerRef: RefObject<T | null>,
) {
  useEffect(() => {
    if (!active) {
      return;
    }

    const container = containerRef.current;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (container) {
      const [first] = getFocusableElements(container);
      // Fall back to the container itself so the reading position moves into
      // the dialog even when it holds no focusable control yet.
      (first ?? container).focus({ preventScroll: true });
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") {
        return;
      }

      const current = containerRef.current;
      if (!current) {
        return;
      }

      const focusable = getFocusableElements(current);
      if (focusable.length === 0) {
        event.preventDefault();
        current.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;

      if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
        return;
      }

      if (event.shiftKey && (activeElement === first || activeElement === current)) {
        event.preventDefault();
        last.focus();
        return;
      }

      if (activeElement instanceof Node && !current.contains(activeElement)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [active, containerRef]);
}

export function OverlayPortal({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(children, document.body);
}
