/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/image-optimization", () => ({
  optimizeFoodPhoto: vi.fn((file: File) => Promise.resolve(file)),
  replaceFoodPhotoObjectUrl: vi.fn(() => "blob:mock-url"),
  setOptimizedFoodPhoto: vi.fn(),
}));

import { AiFoodPhotoModal } from "@/components/ai-food-photo-modal";

function photoFile(name: string) {
  return new File(["photo-bytes"], name, { type: "image/jpeg" });
}

function estimatePayload(label: string) {
  return {
    ok: true,
    analysis: {
      status: "ready",
      question: null,
      estimate: {
        label,
        caloriesKcal: 100,
        proteinG: 1,
        carbsG: 2,
        fatG: 3,
        confidence: 0.9,
        notes: [],
      },
    },
  };
}

function clarificationPayload(question: string) {
  return {
    ok: true,
    analysis: { status: "needs_clarification", question, estimate: null },
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function selectPhoto(file: File) {
  // The modal renders through OverlayPortal, so inputs live on document.body.
  const input = document.body.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  expect(input).not.toBeNull();
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
}

describe("AiFoodPhotoModal stale-photo protection (UI-02)", () => {
  it("ignores a held estimate for photo A after photo B is selected", async () => {
    let releaseA!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseA = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AiFoodPhotoModal
        onClose={vi.fn()}
        onAddToLog={vi.fn()}
        onSaveAsPreset={vi.fn()}
      />,
    );

    await selectPhoto(photoFile("a.jpg"));
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: /estimate macros/i }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: /estimate macros/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Replace the photo (and finish optimizing B) while A is still pending.
    await selectPhoto(photoFile("b.jpg"));
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: /estimate macros/i }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    await act(async () => {
      releaseA(jsonResponse(estimatePayload("Photo A meal")));
    });

    // The stale A estimate must never appear on photo B.
    expect(screen.queryByText("Photo A meal")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /add to log/i }),
    ).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a held clarification question for photo A after photo B is selected", async () => {
    let releaseA!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseA = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AiFoodPhotoModal
        onClose={vi.fn()}
        onAddToLog={vi.fn()}
        onSaveAsPreset={vi.fn()}
      />,
    );

    await selectPhoto(photoFile("a.jpg"));
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: /estimate macros/i }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: /estimate macros/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await selectPhoto(photoFile("b.jpg"));
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: /estimate macros/i }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    await act(async () => {
      releaseA(jsonResponse(clarificationPayload("What sauce was on A?")));
    });

    expect(screen.queryByText("What sauce was on A?")).toBeNull();
    expect(
      screen.queryByPlaceholderText(/missing detail/i),
    ).toBeNull();
  });
});
