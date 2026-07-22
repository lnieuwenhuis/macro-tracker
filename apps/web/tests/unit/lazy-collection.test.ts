import { describe, expect, it, vi } from "vitest";

import { createLazyCollectionLoader } from "@/lib/lazy-collection";

describe("createLazyCollectionLoader", () => {
  it("loads once on first use and reuses the collection afterward", async () => {
    const load = vi.fn().mockResolvedValue(["one", "two"]);
    const loader = createLazyCollectionLoader(load);

    const [first, concurrent] = await Promise.all([loader.load(), loader.load()]);
    const reused = await loader.load();

    expect(first).toEqual(["one", "two"]);
    expect(concurrent).toBe(first);
    expect(reused).toBe(first);
    expect(load).toHaveBeenCalledOnce();
  });

  it("allows retry after a failed first load", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValueOnce(["loaded"]);
    const loader = createLazyCollectionLoader(load);

    await expect(loader.load()).rejects.toThrow("temporarily unavailable");
    await expect(loader.load()).resolves.toEqual(["loaded"]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
