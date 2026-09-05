/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useLazyCollection } from "@/lib/use-lazy-collection";

describe("useLazyCollection", () => {
  it("starts empty and loads once on the first ensureLoaded", async () => {
    const load = vi.fn().mockResolvedValue(["oats", "rice"]);
    const { result } = renderHook(() => useLazyCollection(load, "Unable to load."));

    expect(result.current.items).toEqual([]);
    expect(result.current.loaded).toBe(false);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      await result.current.ensureLoaded();
    });

    expect(result.current.items).toEqual(["oats", "rice"]);
    expect(result.current.loaded).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(load).toHaveBeenCalledOnce();

    await act(async () => {
      await result.current.ensureLoaded();
    });

    expect(load).toHaveBeenCalledOnce();
  });

  it("loads once when two calls race before the first resolves", async () => {
    let release: ((items: string[]) => void) | null = null;
    const load = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(() => useLazyCollection(load, "Unable to load."));

    await act(async () => {
      void result.current.ensureLoaded();
      void result.current.ensureLoaded();
    });

    expect(load).toHaveBeenCalledOnce();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      release!(["oats"]);
    });

    expect(result.current.items).toEqual(["oats"]);
    expect(result.current.loaded).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(load).toHaveBeenCalledOnce();
  });

  it("shows the failure message and retries on the next ensureLoaded", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("Unable to load templates."))
      .mockResolvedValueOnce(["oats"]);
    const { result } = renderHook(() => useLazyCollection(load, "Unable to load."));

    await act(async () => {
      await result.current.ensureLoaded();
    });

    expect(result.current.error).toBe("Unable to load templates.");
    expect(result.current.loaded).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.items).toEqual([]);

    await act(async () => {
      await result.current.ensureLoaded();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.items).toEqual(["oats"]);
    expect(result.current.loaded).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("falls back to the caller's message when the failure is not an Error", async () => {
    const load = vi.fn().mockRejectedValue("nope");
    const { result } = renderHook(() => useLazyCollection(load, "Unable to load."));

    await act(async () => {
      await result.current.ensureLoaded();
    });

    expect(result.current.error).toBe("Unable to load.");
  });

  it("keeps setItems usable after the load so callers can mutate the collection", async () => {
    const load = vi.fn().mockResolvedValue(["oats"]);
    const { result } = renderHook(() => useLazyCollection(load, "Unable to load."));

    await act(async () => {
      await result.current.ensureLoaded();
    });

    act(() => {
      result.current.setItems((items) => [...items, "rice"]);
    });

    expect(result.current.items).toEqual(["oats", "rice"]);
    expect(result.current.loaded).toBe(true);
    expect(load).toHaveBeenCalledOnce();
  });

  it("does not retain the initial loaded array after callers replace it", async () => {
    const initialItems = [{ id: "old", payload: "x".repeat(1024) }];
    const load = vi.fn().mockResolvedValue(initialItems);
    const { result } = renderHook(() => useLazyCollection(load, "Unable to load."));

    await act(async () => {
      await result.current.ensureLoaded();
    });

    const replacement = [{ id: "new", payload: "x".repeat(1024) }];
    act(() => {
      result.current.setItems(replacement);
    });

    await act(async () => {
      await result.current.ensureLoaded();
    });

    expect(result.current.items).toBe(replacement);
    expect(load).toHaveBeenCalledOnce();
  });
});
