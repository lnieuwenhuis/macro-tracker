import { describe, expect, it } from "vitest";

import { isFrameworkControlFlowError } from "@/lib/framework-control-flow";

function digestError(digest: string) {
  return Object.assign(new Error("framework control flow"), { digest });
}

describe("isFrameworkControlFlowError", () => {
  it("recognizes redirect and not-found digests Next throws through actions", () => {
    expect(isFrameworkControlFlowError(digestError("NEXT_REDIRECT;replace;/login;307;"))).toBe(
      true,
    );
    expect(isFrameworkControlFlowError(digestError("NEXT_NOT_FOUND"))).toBe(true);
  });

  it("does not match ordinary transport failures or unrelated errors", () => {
    expect(isFrameworkControlFlowError(new Error("network down"))).toBe(false);
    expect(isFrameworkControlFlowError(digestError("RANDOM_DIGEST"))).toBe(false);
    expect(isFrameworkControlFlowError({ digest: "NEXT_REDIRECT" })).toBe(false);
    expect(isFrameworkControlFlowError(null)).toBe(false);
    expect(isFrameworkControlFlowError("NEXT_REDIRECT")).toBe(false);
  });
});
