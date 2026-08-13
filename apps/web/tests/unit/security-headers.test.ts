import {
  DEFAULT_SHOO_BASE_URL,
  buildContentSecurityPolicy,
  getShooConnectOrigin,
} from "@/next.config";
import { describe, expect, it } from "vitest";

function directive(policy: string, name: string) {
  return policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
}

describe("content security policy", () => {
  it("lets the browser reach the identity provider", () => {
    // `@shoojs/auth` exchanges the code for an id_token from the browser, so
    // omitting this origin breaks sign-in with an opaque "Failed to fetch".
    const policy = buildContentSecurityPolicy("https://shoo.dev", false);

    expect(directive(policy, "connect-src")).toBe(
      "connect-src 'self' https://shoo.dev",
    );
  });

  it("tracks a custom SHOO_BASE_URL", () => {
    const policy = buildContentSecurityPolicy(
      getShooConnectOrigin("https://auth.example.com/some/path"),
      false,
    );

    expect(directive(policy, "connect-src")).toBe(
      "connect-src 'self' https://auth.example.com",
    );
  });

  it("falls back to the documented default for an unparseable base URL", () => {
    expect(getShooConnectOrigin("not a url")).toBe(
      new URL(DEFAULT_SHOO_BASE_URL).origin,
    );
  });

  it("omits form-action so POST-then-redirect forms still work", () => {
    // Chromium enforces form-action across the redirect chain, which blocks
    // sign-out and every admin server action that redirects.
    expect(directive(buildContentSecurityPolicy(), "form-action")).toBeUndefined();
  });

  it("keeps the directives that carry no functional risk", () => {
    const policy = buildContentSecurityPolicy();

    expect(directive(policy, "object-src")).toBe("object-src 'none'");
    expect(directive(policy, "base-uri")).toBe("base-uri 'self'");
    expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(policy, "script-src")).toContain("'self'");
  });

  it("only allows eval in development", () => {
    expect(buildContentSecurityPolicy("https://shoo.dev", false)).not.toContain(
      "'unsafe-eval'",
    );
    expect(buildContentSecurityPolicy("https://shoo.dev", true)).toContain(
      "'unsafe-eval'",
    );
  });
});
