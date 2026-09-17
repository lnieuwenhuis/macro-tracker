/** @vitest-environment jsdom */
// The manual-entry form must not be dismissable while a save is in flight.
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
    // A test-controlled promise so the component stays isSaving as long as needed.
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

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    // `BarcodeResult` renders via `OverlayPortal`, so the backdrop is not inside the RTL container.
    const backdrop = document.body.querySelector(".absolute.inset-0.bg-black\\/40");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).not.toHaveBeenCalled();

    const closeButton = screen.getByRole("button", { name: /close/i });
    expect((closeButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(closeButton);
    expect(onClose).not.toHaveBeenCalled();

    // Waiting only for DOM state can observe the commit before useEscapeDismiss reattaches its listener.
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

describe("BarcodeResult edited values (UI-09)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves commas in the product name while normalizing numeric commas", () => {
    const onAddToLog = vi.fn();
    render(
      <BarcodeResult
        product={{
          productId: null,
          name: "Yoghurt",
          brands: "",
          barcode: "12345678",
          proteinG: 10,
          carbsG: 10,
          fatG: 10,
          caloriesKcal: 100,
          servingSizeG: 100,
          imageUrl: null,
          source: "openfoodfacts",
        }}
        notFoundBarcode={null}
        onAddToLog={onAddToLog}
        onSaveAsPreset={vi.fn()}
        onScanAnother={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /edit values/i }));

    // The Name field is a plain label + input pair without htmlFor, so find it by value.
    fireEvent.change(screen.getByDisplayValue("Yoghurt"), {
      target: { value: "Yoghurt, Grieks" },
    });
    fireEvent.change(screen.getByLabelText("Protein in g"), {
      target: { value: "1,5" },
    });

    fireEvent.click(screen.getByRole("button", { name: /add to log/i }));

    expect(onAddToLog).toHaveBeenCalledTimes(1);
    const submitted = onAddToLog.mock.calls[0]![0] as {
      label: string;
      proteinG: number;
    };
    expect(submitted.label).toBe("Yoghurt, Grieks");
    expect(submitted.proteinG).toBe(1.5);
  });
});

describe("BarcodeResult template save feedback (UI-01)", () => {
  const product = {
    productId: null,
    name: "Test bar",
    brands: "",
    barcode: "12345678",
    proteinG: 10,
    carbsG: 10,
    fatG: 10,
    caloriesKcal: 100,
    servingSizeG: 100,
    imageUrl: null,
    source: "openfoodfacts",
  } as const;

  function renderResult(onSaveAsPreset: (input: unknown) => Promise<boolean>) {
    render(
      <BarcodeResult
        product={{ ...product }}
        notFoundBarcode={null}
        onAddToLog={vi.fn()}
        onSaveAsPreset={onSaveAsPreset as never}
        onScanAnother={vi.fn()}
        onClose={vi.fn()}
      />,
    );
  }

  it("marks Saved only after the save succeeds", async () => {
    renderResult(async () => true);
    fireEvent.click(screen.getByRole("button", { name: /save as template/i }));
    await screen.findByRole("button", { name: /saved!/i });
  });

  it("shows pending, then an error on resolved failure, and retries to Saved", async () => {
    let resolveSave!: (saved: boolean) => void;
    const onSaveAsPreset = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSave = resolve;
        }),
    );
    renderResult(onSaveAsPreset);

    fireEvent.click(screen.getByRole("button", { name: /save as template/i }));
    await screen.findByRole("button", { name: /saving/i });

    await act(async () => {
      resolveSave(false);
    });
    await screen.findByText(/unable to save template/i);
    expect(screen.queryByRole("button", { name: /saved!/i })).toBeNull();

    onSaveAsPreset.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: /save as template/i }));
    await screen.findByRole("button", { name: /saved!/i });
  });

  it("never shows Saved when the save transport rejects", async () => {
    renderResult(async () => {
      throw new Error("offline");
    });
    fireEvent.click(screen.getByRole("button", { name: /save as template/i }));
    await screen.findByText(/unable to save template/i);
    expect(screen.queryByRole("button", { name: /saved!/i })).toBeNull();
  });

  it("surfaces a retryable error when the manual product save transport rejects", async () => {
    mocked.saveBarcodeFoodProductAction.mockRejectedValue(new Error("offline"));
    render(
      <BarcodeResult
        product={null}
        notFoundBarcode="0000000000000"
        onAddToLog={vi.fn()}
        onSaveAsPreset={async () => true}
        onScanAnother={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /add product/i }));
    fireEvent.change(screen.getByPlaceholderText("e.g. Pindakaas"), {
      target: { value: "Peanut Butter" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save product$/i }));

    await screen.findByText(/failed to save product/i);
    // The form stays open for retry instead of hanging on Saving…
    expect(
      (screen.getByRole("button", { name: /^save product$/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
