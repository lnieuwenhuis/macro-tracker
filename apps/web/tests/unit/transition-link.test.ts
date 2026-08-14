import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { shouldPrepareNavigationMotion } from "@/components/transition-link";

const primaryClick = {
  altKey: false,
  button: 0,
  ctrlKey: false,
  defaultPrevented: false,
  metaKey: false,
  shiftKey: false,
};

describe("TransitionLink", () => {
  it("keeps click motion for ordinary navigation only", () => {
    expect(shouldPrepareNavigationMotion(primaryClick)).toBe(true);
    expect(shouldPrepareNavigationMotion({ ...primaryClick, ctrlKey: true })).toBe(false);
    expect(shouldPrepareNavigationMotion({ ...primaryClick, button: 1 })).toBe(false);
    expect(shouldPrepareNavigationMotion(primaryClick, "_blank")).toBe(false);
  });

  it("keeps prefetch off by default without hover, focus, or touch prefetch hooks", async () => {
    const source = await readFile(
      new URL("../../components/transition-link.tsx", import.meta.url),
      "utf8",
    );

    // Links must opt in to prefetching individually (the bottom-nav tabs do);
    // defaulting it on would render every linked route on the server for every
    // page view, which the constrained hosting cannot afford.
    expect(source).toContain("prefetch = false");
    expect(source).not.toMatch(/onMouseEnter|onFocus|onTouchStart|prefetchFullRoute/);
  });
});
