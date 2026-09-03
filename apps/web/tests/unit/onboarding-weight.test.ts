import { describe, expect, it } from "vitest";

import {
  normalizeOnboardingWeightKg,
} from "@/lib/onboarding-weight";

describe("onboarding weight helpers", () => {
  it("converts lb onboarding weights to kg before saving", () => {
    expect(normalizeOnboardingWeightKg("220.46", "lb")).toBe(100);
  });

  it("keeps kg onboarding weights as kg", () => {
    expect(normalizeOnboardingWeightKg("82.5", "kg")).toBe(82.5);
  });

  it("treats blank or non-positive values as omitted", () => {
    expect(normalizeOnboardingWeightKg("0", "kg")).toBeNull();
  });
});
