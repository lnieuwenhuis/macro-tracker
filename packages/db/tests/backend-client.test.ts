import { afterEach, describe, expect, it, vi } from "vitest";

import { backendFetch, getBackendUrl, resolveBackendUrl } from "../src/backend-client";

const originalNodeEnv = process.env.NODE_ENV;
const originalBackendUrl = process.env.BACKEND_URL;
const originalBackendInternalSecret = process.env.BACKEND_INTERNAL_SECRET;
const originalFetch = globalThis.fetch;

describe("backend client", () => {
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalBackendUrl == null) {
      delete process.env.BACKEND_URL;
    } else {
      process.env.BACKEND_URL = originalBackendUrl;
    }
    if (originalBackendInternalSecret == null) {
      delete process.env.BACKEND_INTERNAL_SECRET;
    } else {
      process.env.BACKEND_INTERNAL_SECRET = originalBackendInternalSecret;
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fails closed in production when BACKEND_INTERNAL_SECRET is missing", async () => {
    process.env.NODE_ENV = "production";
    process.env.BACKEND_URL = "https://backend.example.com";
    delete process.env.BACKEND_INTERNAL_SECRET;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(backendFetch("/internal/rpc")).rejects.toThrow(
      "BACKEND_INTERNAL_SECRET is required",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires BACKEND_URL in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.BACKEND_URL;

    expect(() => getBackendUrl()).toThrow("BACKEND_URL is required");
  });

  it("keeps the localhost backend URL default outside production", () => {
    process.env.NODE_ENV = "test";
    delete process.env.BACKEND_URL;

    expect(getBackendUrl()).toBe("http://127.0.0.1:4000");
  });

  it("sends the configured backend internal secret", async () => {
    process.env.NODE_ENV = "test";
    process.env.BACKEND_URL = "http://127.0.0.1:4000";
    process.env.BACKEND_INTERNAL_SECRET = "  test-backend-secret  ";
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await backendFetch("/internal/rpc", {
      method: "POST",
      body: "{}",
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Headers).get("x-backend-internal-secret")).toBe(
      "test-backend-secret",
    );
  });

  it("overwrites a client-supplied internal-secret header instead of appending to it", async () => {
    process.env.NODE_ENV = "test";
    process.env.BACKEND_URL = "http://127.0.0.1:4000";
    process.env.BACKEND_INTERNAL_SECRET = "real-secret";
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await backendFetch("/internal/rpc", {
      method: "POST",
      body: "{}",
      headers: { "x-backend-internal-secret": "spoofed-secret" },
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Headers).get("x-backend-internal-secret")).toBe("real-secret");
  });

  it("rejects a literal traversal segment before URL normalization can rewrite it", () => {
    process.env.NODE_ENV = "test";
    process.env.BACKEND_URL = "http://127.0.0.1:4000";

    expect(() => resolveBackendUrl("/api/v1/../../internal/rpc")).toThrow(
      "Backend path must not contain traversal segments.",
    );
  });

  it("rejects a percent-encoded traversal segment, since encodeURIComponent('..') === '..'", () => {
    process.env.NODE_ENV = "test";
    process.env.BACKEND_URL = "http://127.0.0.1:4000";

    expect(() => resolveBackendUrl("/api/v1/%2e%2e/internal/rpc")).toThrow(
      "Backend path must not contain traversal segments.",
    );
  });
});
