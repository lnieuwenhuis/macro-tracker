import { describe, expect, it } from "vitest";

import { normalizeComposeAction } from "@/lib/compose";
import { normalizeProgressTab } from "@/lib/progress-tab";

describe("compose + progress helpers", () => {
  it("normalizes progress tabs", () => {
    expect(normalizeProgressTab("weight")).toBe("weight");
    expect(normalizeProgressTab("unexpected")).toBe("goals");
  });

  it("normalizes compose actions", () => {
    expect(normalizeComposeAction("custom")).toBe("custom");
    expect(normalizeComposeAction("preset")).toBe("template");
    expect(normalizeComposeAction("template")).toBe("template");
    expect(normalizeComposeAction("photo")).toBe("photo");
    expect(normalizeComposeAction("recipe")).toBe("recipe");
    expect(normalizeComposeAction("unexpected")).toBeNull();
  });
});
