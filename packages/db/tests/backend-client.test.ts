import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { backendFetch, getBackendUrl, resolveBackendUrl } from "../src/backend-client";

const originalNodeEnv = process.env.NODE_ENV;
const originalBackendUrl = process.env.BACKEND_URL;
const originalBackendInternalSecret = process.env.BACKEND_INTERNAL_SECRET;
const originalFetch = globalThis.fetch;

function mockFetch() {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function sentSecret(fetchMock: ReturnType<typeof mockFetch>) {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  return (init.headers as Headers).get("x-backend-internal-secret");
}

describe("backend client", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.BACKEND_URL = "http://127.0.0.1:4000";
  });

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
    delete process.env.BACKEND_URL;

    expect(getBackendUrl()).toBe("http://127.0.0.1:4000");
  });

  it("sends the configured backend internal secret", async () => {
    process.env.BACKEND_INTERNAL_SECRET = "  test-backend-secret  ";
    const fetchMock = mockFetch();

    await backendFetch("/internal/rpc", {
      method: "POST",
      body: "{}",
    });

    expect(sentSecret(fetchMock)).toBe("test-backend-secret");
  });

  it("overwrites a client-supplied internal-secret header instead of appending to it", async () => {
    process.env.BACKEND_INTERNAL_SECRET = "real-secret";
    const fetchMock = mockFetch();

    await backendFetch("/internal/rpc", {
      method: "POST",
      body: "{}",
      headers: { "x-backend-internal-secret": "spoofed-secret" },
    });

    expect(sentSecret(fetchMock)).toBe("real-secret");
  });

  it("strips a client-supplied internal-secret header when attachInternalSecret is false", async () => {
    process.env.BACKEND_INTERNAL_SECRET = "real-secret";
    const fetchMock = mockFetch();

    await backendFetch("/api/v1/foods", {
      attachInternalSecret: false,
      headers: { "x-backend-internal-secret": "spoofed-secret" },
    });

    expect(sentSecret(fetchMock)).toBeNull();
  });

  it("strips a client-supplied internal-secret header when no secret is configured outside production", async () => {
    delete process.env.BACKEND_INTERNAL_SECRET;
    const fetchMock = mockFetch();

    await backendFetch("/internal/rpc", {
      method: "POST",
      body: "{}",
      headers: { "x-backend-internal-secret": "spoofed-secret" },
    });

    expect(sentSecret(fetchMock)).toBeNull();
  });

  it.each([
    "/api/v1/../../internal/rpc",
    "/api/v1/%2e%2e/internal/rpc",
    "/api/v1/../internal/rpc?next=/internal/rpc",
  ])("rejects traversal path %s", (path) => {
    expect(() => resolveBackendUrl(path)).toThrow(
      "Backend path must not contain traversal segments.",
    );
  });
});
