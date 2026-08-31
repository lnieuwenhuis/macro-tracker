import { describe, expect, it } from "vitest";

import {
  getInitialPresetTemplateKind,
  normalizePresetTemplateKind,
  resolvePresetModalActiveKind,
} from "@/lib/preset-modal-state";

describe("preset modal state", () => {
  it("defaults to days when only day templates are available", () => {
    expect(
      getInitialPresetTemplateKind({
        foodItemCount: 0,
        dayCount: 1,
      }),
    ).toBe("day");
  });

  it("keeps an empty selected food tab active when day templates exist", () => {
    expect(
      resolvePresetModalActiveKind({
        selectedKind: "food",
      }),
    ).toBe("food");
  });

  it("normalizes food-specific template route hints", () => {
    expect(normalizePresetTemplateKind("food")).toBe("food");
    expect(normalizePresetTemplateKind("day")).toBe("day");
    expect(normalizePresetTemplateKind("recipe")).toBeNull();
  });
});
