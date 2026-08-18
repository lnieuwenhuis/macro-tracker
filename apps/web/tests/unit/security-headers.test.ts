import type { NextRequest } from "next/server";
import type { ReactElement, ReactNode } from "react";

import { resetServerEnvForTests } from "@/lib/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  applySessionCookie: vi.fn(),
  verifySessionToken: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return {
    ...actual,
    applySessionCookie: mocked.applySessionCookie,
    verifySessionToken: mocked.verifySessionToken,
  };
});

vi.mock("next/headers", () => ({ headers: mocked.headers }));

// `next/font/google` is a build-time transform; the runtime module cannot run
// outside the Next compiler.
vi.mock("next/font/google", () => ({
  Fraunces: () => ({ variable: "--font-fraunces" }),
  Space_Grotesk: () => ({ variable: "--font-space-grotesk" }),
}));

import {
  buildContentSecurityPolicy,
  DEFAULT_SHOO_BASE_URL,
  getShooConnectOrigin,
  NONCE_HEADER,
  proxy,
} from "@/proxy";

import RootLayout from "@/app/layout";

const CSP_HEADER = "content-security-policy";
const NONCE = "test-nonce-value";

function directive(policy: string, name: string) {
  return policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
}

function proxyRequest(path = "/") {
  const url = `http://127.0.0.1:3000${path}`;

  return {
    nextUrl: new URL(url),
    url,
    method: "GET",
    headers: new Headers({
      "x-forwarded-proto": "https",
      "x-forwarded-host": "trusted.example",
      // A caller-supplied nonce must never survive into the render.
      [NONCE_HEADER]: "attacker-supplied",
      [CSP_HEADER]: "script-src 'nonce-attacker-supplied'",
    }),
    cookies: { get: vi.fn(() => undefined) },
  } as unknown as NextRequest;
}

/** The nonce the proxy forwarded to the renderer on the request headers. */
function forwardedNonce(response: Response) {
  const overridden = response.headers.get("x-middleware-override-headers");
  expect(overridden?.split(",")).toContain(NONCE_HEADER);

  return response.headers.get(`x-middleware-request-${NONCE_HEADER}`);
}

function nonceFromPolicy(policy: string | null) {
  return policy?.match(/'nonce-([^']+)'/)?.[1] ?? null;
}

function findById(node: ReactNode, id: string): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findById(child, id);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (!node || typeof node !== "object" || !("props" in node)) {
    return null;
  }

  const element = node as ReactElement<{ id?: string; children?: ReactNode }>;
  if (element.props.id === id) {
    return element;
  }

  return findById(element.props.children, id);
}

describe("content security policy", () => {
  it("lets the browser reach the identity provider", () => {
    // `@shoojs/auth` exchanges the code for an id_token from the browser, so
    // omitting this origin breaks sign-in with an opaque "Failed to fetch".
    const policy = buildContentSecurityPolicy(NONCE, "https://shoo.dev", false);

    expect(directive(policy, "connect-src")).toBe(
      "connect-src 'self' https://shoo.dev",
    );
  });

  it("tracks a custom SHOO_BASE_URL", () => {
    const policy = buildContentSecurityPolicy(
      NONCE,
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
    expect(
      directive(buildContentSecurityPolicy(NONCE), "form-action"),
    ).toBeUndefined();
  });

  it("keeps the directives that carry no functional risk", () => {
    const policy = buildContentSecurityPolicy(NONCE);

    expect(directive(policy, "object-src")).toBe("object-src 'none'");
    expect(directive(policy, "base-uri")).toBe("base-uri 'self'");
    expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(policy, "script-src")).toContain("'self'");
  });

  it("only allows eval in development", () => {
    expect(
      buildContentSecurityPolicy(NONCE, "https://shoo.dev", false),
    ).not.toContain("'unsafe-eval'");
    expect(
      buildContentSecurityPolicy(NONCE, "https://shoo.dev", true),
    ).toContain("'unsafe-eval'");
  });

  it("drops unsafe-inline from script-src in production and nonces it instead", () => {
    const script = directive(
      buildContentSecurityPolicy(NONCE, "https://shoo.dev", false),
      "script-src",
    );

    expect(script).toBe(`script-src 'self' 'nonce-${NONCE}'`);
    expect(script).not.toContain("'unsafe-inline'");
  });

  it("never emits unsafe-inline in script-src, even in development", () => {
    // A nonce makes browsers ignore 'unsafe-inline' anyway, so keeping it for
    // dev convenience would only mislead the next reader.
    expect(
      directive(
        buildContentSecurityPolicy(NONCE, "https://shoo.dev", true),
        "script-src",
      ),
    ).toBe(`script-src 'self' 'nonce-${NONCE}' 'unsafe-eval'`);
  });

  it("keeps unsafe-inline for styles and adds no style nonce", () => {
    // Adding a nonce here would make the browser ignore 'unsafe-inline' and
    // break every inline style Next and next/font emit.
    const style = directive(buildContentSecurityPolicy(NONCE), "style-src");

    expect(style).toBe("style-src 'self' 'unsafe-inline'");
  });
});

describe("proxy nonce delivery", () => {
  beforeEach(() => {
    process.env.APP_URL = "http://app.internal";
    process.env.SESSION_SECRET = "proxy-test-session-secret-32-chars-x";
    resetServerEnvForTests();
    vi.clearAllMocks();
    mocked.verifySessionToken.mockResolvedValue(null);
  });

  afterEach(() => {
    resetServerEnvForTests();
  });

  it("sets the policy on the response and forwards it to the renderer", async () => {
    const response = await proxy(proxyRequest("/login"));
    const policy = response.headers.get(CSP_HEADER);

    expect(policy).toContain("script-src 'self' 'nonce-");
    expect(directive(policy ?? "", "script-src")).not.toContain(
      "'unsafe-inline'",
    );

    const nonce = nonceFromPolicy(policy);
    expect(nonce).toBeTruthy();
    expect(forwardedNonce(response)).toBe(nonce);
  });

  it("overwrites a caller-supplied nonce instead of trusting it", async () => {
    const response = await proxy(proxyRequest("/login"));

    expect(forwardedNonce(response)).not.toBe("attacker-supplied");
    expect(response.headers.get(CSP_HEADER)).not.toContain(
      "attacker-supplied",
    );
  });

  it("generates a different nonce for every request", async () => {
    // A fixed nonce is worth exactly as much as 'unsafe-inline'.
    const nonces = new Set<string | null>();

    for (let index = 0; index < 5; index += 1) {
      const response = await proxy(proxyRequest("/login"));
      nonces.add(nonceFromPolicy(response.headers.get(CSP_HEADER)));
    }

    expect(nonces.size).toBe(5);
    expect(nonces.has(null)).toBe(false);
  });

  it("still carries the policy on the unauthenticated redirect to /login", async () => {
    const response = await proxy(proxyRequest("/summary"));

    expect(response.status).toBe(307);
    expect(response.headers.get(CSP_HEADER)).toContain("script-src 'self' 'nonce-");
  });
});

describe("root layout nonce threading", () => {
  it("puts the request's nonce on both inline bootstraps", async () => {
    mocked.headers.mockResolvedValue(
      new Headers({ [NONCE_HEADER]: "layout-nonce" }),
    );

    const tree = await RootLayout({ children: null });

    for (const id of ["theme-init", "timezone-init"]) {
      const script = findById(tree, id) as ReactElement<{
        nonce?: string;
      }> | null;

      expect(script, `missing bootstrap ${id}`).not.toBeNull();
      expect(script?.props.nonce).toBe("layout-nonce");
    }
  });

  it("matches the nonce the proxy put in the policy header", async () => {
    process.env.APP_URL = "http://app.internal";
    process.env.SESSION_SECRET = "proxy-test-session-secret-32-chars-x";
    resetServerEnvForTests();
    mocked.verifySessionToken.mockResolvedValue(null);

    const response = await proxy(proxyRequest("/login"));
    const nonce = nonceFromPolicy(response.headers.get(CSP_HEADER));

    // The renderer reads the header the proxy forwarded, so the rendered
    // script tags must carry exactly the value the browser was told to trust.
    mocked.headers.mockResolvedValue(
      new Headers({ [NONCE_HEADER]: forwardedNonce(response) ?? "" }),
    );

    const tree = await RootLayout({ children: null });
    const script = findById(tree, "timezone-init") as ReactElement<{
      nonce?: string;
    }> | null;

    expect(script?.props.nonce).toBe(nonce);
  });

  it("renders no nonce when the header is absent rather than an empty one", async () => {
    // An empty `nonce=""` attribute matches nothing and would be a silent
    // "scripts are blocked" state; `undefined` keeps the attribute off.
    mocked.headers.mockResolvedValue(new Headers());

    const tree = await RootLayout({ children: null });
    const script = findById(tree, "theme-init") as ReactElement<{
      nonce?: string;
    }> | null;

    expect(script?.props.nonce).toBeUndefined();
  });
});
