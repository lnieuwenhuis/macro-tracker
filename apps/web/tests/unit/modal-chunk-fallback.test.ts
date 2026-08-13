// @vitest-environment jsdom

import {
  act,
  createElement,
  lazy,
  type ComponentType,
  type ReactNode,
  Suspense,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import {
  ModalChunkDismissProvider,
  ModalChunkFallback,
  OverlayBackdropFallback,
} from "@/components/modal-chunk-fallback";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function createDeferredModal() {
  let resolve!: (module: { default: ComponentType }) => void;
  const promise = new Promise<{ default: ComponentType }>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

async function proveDismissalStaysClosed({
  dismiss,
  fallback,
  fallbackSelector,
}: {
  dismiss: () => void;
  fallback: ReactNode;
  fallbackSelector: string;
}) {
  const deferred = createDeferredModal();
  const LazyModal = lazy(() => deferred.promise);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  function Harness() {
    const [open, setOpen] = useState(true);
    if (!open) return null;

    return createElement(
      ModalChunkDismissProvider,
      { onDismiss: () => setOpen(false) },
      createElement(Suspense, { fallback }, createElement(LazyModal)),
    );
  }

  try {
    await act(async () => {
      root.render(createElement(Harness));
    });
    expect(document.querySelector(fallbackSelector)).not.toBeNull();

    await act(async () => {
      dismiss();
    });
    expect(document.querySelector(fallbackSelector)).toBeNull();

    await act(async () => {
      deferred.resolve({
        default: () =>
          createElement("div", { "data-testid": "resolved-modal" }, "Resolved"),
      });
      await deferred.promise;
    });

    expect(document.querySelector('[data-testid="resolved-modal"]')).toBeNull();
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
}

describe("lazy modal chunk fallbacks", () => {
  it("keeps a deferred compact modal closed after its close button is clicked", async () => {
    await proveDismissalStaysClosed({
      fallback: createElement(ModalChunkFallback, { title: "Deferred modal" }),
      fallbackSelector: '[role="dialog"]',
      dismiss: () =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(),
    });
  });

  it("keeps a deferred compact modal closed after its backdrop is clicked", async () => {
    await proveDismissalStaysClosed({
      fallback: createElement(ModalChunkFallback, { title: "Deferred modal" }),
      fallbackSelector: '[role="dialog"]',
      dismiss: () =>
        document.querySelector<HTMLElement>('[aria-hidden="true"]')!.click(),
    });
  });

  it("keeps a deferred compact modal closed after Escape", async () => {
    await proveDismissalStaysClosed({
      fallback: createElement(ModalChunkFallback, { title: "Deferred modal" }),
      fallbackSelector: '[role="dialog"]',
      dismiss: () =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    });
  });

  it("keeps a deferred full-screen modal closed after backdrop cancellation", async () => {
    await proveDismissalStaysClosed({
      fallback: createElement(OverlayBackdropFallback),
      fallbackSelector: 'button[aria-label="Cancel loading modal"]',
      dismiss: () =>
        document
          .querySelector<HTMLButtonElement>('button[aria-label="Cancel loading modal"]')!
          .click(),
    });
  });

  it("keeps a deferred full-screen modal closed after Escape", async () => {
    await proveDismissalStaysClosed({
      fallback: createElement(OverlayBackdropFallback),
      fallbackSelector: 'button[aria-label="Cancel loading modal"]',
      dismiss: () =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    });
  });
});
