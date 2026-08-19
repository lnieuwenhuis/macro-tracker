/**
 * @vitest-environment jsdom
 *
 * UI-05: the manual-entry "Add product" form in `barcode-result.tsx` could
 * be dismissed mid-save -- the backdrop click and the `CloseButton` were not
 * gated on `isSaving`, and `ModalSurface` was given no `dismissable` prop
 * (defaults to `true`, so Escape closed it too). `ai-food-photo-modal.tsx`
 * already handles the identical situation with `dismissable={!isAnalyzing}`;
 * this applies the same pattern here.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  saveBarcodeFoodProductAction: vi.fn(),
}));

vi.mock("@/lib/actions", () => ({
  saveBarcodeFoodProductAction: mocked.saveBarcodeFoodProductAction,
}));

import { BarcodeResult } from "@/components/barcode-result";

describe("BarcodeResult manual-entry form dismissal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderForm(onClose = vi.fn()) {
    const utils = render(
      <BarcodeResult
        product={null}
        notFoundBarcode="0000000000000"
        onAddToLog={vi.fn()}
        onSaveAsPreset={vi.fn()}
        onScanAnother={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(utils.getByRole("button", { name: /add product/i }));
    return { ...utils, onClose };
  }

  it("does not close on Escape, backdrop click, or the close button while saving", async () => {
    // A promise the test controls so the component stays "isSaving" for as
    // long as needed.
    let resolveSave!: (value: { ok: boolean }) => void;
    mocked.saveBarcodeFoodProductAction.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );

    const { onClose } = renderForm();

    fireEvent.change(screen.getByPlaceholderText("e.g. Pindakaas"), {
      target: { value: "Peanut Butter" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save product/i }));

    await waitFor(() => {
      expect((screen.getByRole("button", { name: /saving/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    // Escape should not dismiss.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    // The backdrop click should not dismiss. `BarcodeResult` renders via
    // `OverlayPortal` (a portal to `document.body`), so it is not inside the
    // RTL `container`.
    const backdrop = document.body.querySelector(".absolute.inset-0.bg-black\\/40");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).not.toHaveBeenCalled();

    // The close button should be disabled and not dismiss.
    const closeButton = screen.getByRole("button", { name: /close/i });
    expect((closeButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(closeButton);
    expect(onClose).not.toHaveBeenCalled();

    // Flush the promise resolution, resulting state update, and passive effects
    // together. Waiting only for the button's DOM state can observe the commit
    // before `useEscapeDismiss` has reattached its document listener.
    await act(async () => {
      resolveSave({ ok: false });
    });
    expect(
      (screen.getByRole("button", { name: /^save product$/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
