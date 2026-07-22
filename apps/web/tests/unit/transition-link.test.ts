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

  it("disables prefetch without installing hover, focus, or touch prefetch hooks", async () => {
    const source = await readFile(
      new URL("../../components/transition-link.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("prefetch={false}");
    expect(source).not.toMatch(/onMouseEnter|onFocus|onTouchStart|prefetchFullRoute/);
  });
});
