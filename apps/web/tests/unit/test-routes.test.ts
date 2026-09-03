import { describe, expect, it } from "vitest";

import { ensureTestRouteRequest } from "@/lib/test-routes";

function requestWithSecret(secret?: string) {
  const headers = new Headers();
  if (secret !== undefined) {
    headers.set("x-test-route-secret", secret);
  }
  return new Request("http://localhost/api/test/session", { headers });
}

describe("ensureTestRouteRequest", () => {
  it("answers 404 both when routes are disabled and when the secret is wrong, so a prober can't tell them apart", async () => {
    const disabled = ensureTestRouteRequest(requestWithSecret("right"), {
      enableTestRoutes: false,
      testRoutesSecret: "right",
    });
    const wrongSecret = ensureTestRouteRequest(requestWithSecret("wrong"), {
      enableTestRoutes: true,
      testRoutesSecret: "right",
    });

    expect(disabled?.status).toBe(404);
    expect(wrongSecret?.status).toBe(404);
  });

  it("allows the request through when routes are enabled and the secret matches", () => {
    const result = ensureTestRouteRequest(requestWithSecret("right"), {
      enableTestRoutes: true,
      testRoutesSecret: "right",
    });

    expect(result).toBeNull();
  });
});
