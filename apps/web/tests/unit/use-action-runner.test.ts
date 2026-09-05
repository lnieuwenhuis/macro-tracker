/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocked.refresh }),
}));

import { useActionRunner } from "@/lib/use-action-runner";

beforeEach(() => {
  mocked.refresh.mockClear();
});

describe("useActionRunner", () => {
  it("runs the action, reports no error and skips the refresh by default", async () => {
    const { result } = renderHook(() => useActionRunner());
    const onSuccess = vi.fn();

    await act(async () => {
      result.current.run(async () => ({ ok: true as const, entry: "saved" }), {
        fallbackError: "Unable to save.",
        onSuccess,
      });
    });

    expect(onSuccess).toHaveBeenCalledWith({ ok: true, entry: "saved" });
    expect(result.current.error).toBeNull();
    expect(mocked.refresh).not.toHaveBeenCalled();
  });

  it("refreshes the router after onSuccess when refresh is set", async () => {
    const { result } = renderHook(() => useActionRunner());
    const order: string[] = [];
    mocked.refresh.mockImplementation(() => order.push("refresh"));

    await act(async () => {
      result.current.run(async () => ({ ok: true }), {
        fallbackError: "Unable to save.",
        refresh: true,
        onSuccess: () => order.push("onSuccess"),
      });
    });

    expect(order).toEqual(["onSuccess", "refresh"]);
    expect(mocked.refresh).toHaveBeenCalledTimes(1);
  });

  it("shows the action's own error message and skips onSuccess and the refresh", async () => {
    const { result } = renderHook(() => useActionRunner());
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await act(async () => {
      result.current.run(async () => ({ ok: false, error: "Slot overlaps." }), {
        fallbackError: "Unable to save.",
        refresh: true,
        onSuccess,
        onError,
      });
    });

    expect(result.current.error).toBe("Slot overlaps.");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mocked.refresh).not.toHaveBeenCalled();
  });

  it("falls back to the caller's message when the action reports no error", async () => {
    const { result } = renderHook(() => useActionRunner());

    await act(async () => {
      result.current.run(async () => ({ ok: false }), {
        fallbackError: "Unable to save.",
      });
    });

    expect(result.current.error).toBe("Unable to save.");
  });

  it("clears a previous error when the next run starts, unless asked not to", async () => {
    const { result } = renderHook(() => useActionRunner());

    await act(async () => {
      result.current.run(async () => ({ ok: false, error: "First failure." }), {
        fallbackError: "Unable to save.",
      });
    });
    expect(result.current.error).toBe("First failure.");

    let releaseKept: (() => void) | null = null;
    act(() => {
      result.current.run(
        () =>
          new Promise<{ ok: boolean }>((resolve) => {
            releaseKept = () => resolve({ ok: true });
          }),
        { fallbackError: "Unable to save.", clearErrorFirst: false },
      );
    });
    expect(result.current.error).toBe("First failure.");
    await act(async () => {
      releaseKept!();
    });
    expect(result.current.error).toBe("First failure.");

    let releaseCleared: (() => void) | null = null;
    act(() => {
      result.current.run(
        () =>
          new Promise<{ ok: boolean }>((resolve) => {
            releaseCleared = () => resolve({ ok: true });
          }),
        { fallbackError: "Unable to save." },
      );
    });
    expect(result.current.error).toBeNull();
    await act(async () => {
      releaseCleared!();
    });
  });

  it("reports isPending while the action is in flight", async () => {
    const { result } = renderHook(() => useActionRunner());
    let release: (() => void) | null = null;

    act(() => {
      result.current.run(
        () =>
          new Promise<{ ok: boolean }>((resolve) => {
            release = () => resolve({ ok: true });
          }),
        { fallbackError: "Unable to save." },
      );
    });

    await waitFor(() => expect(result.current.isPending).toBe(true));

    await act(async () => {
      release!();
    });

    expect(result.current.isPending).toBe(false);
  });

  it("clears the error on clearError", async () => {
    const { result } = renderHook(() => useActionRunner());

    await act(async () => {
      result.current.run(async () => ({ ok: false, error: "Nope." }), {
        fallbackError: "Unable to save.",
      });
    });
    expect(result.current.error).toBe("Nope.");

    act(() => {
      result.current.clearError();
    });

    expect(result.current.error).toBeNull();
  });

  it("exposes setError for validation messages that share the same slot", () => {
    const { result } = renderHook(() => useActionRunner());

    act(() => {
      result.current.setError("Enter grams greater than 0.");
    });

    expect(result.current.error).toBe("Enter grams greater than 0.");
  });
});
