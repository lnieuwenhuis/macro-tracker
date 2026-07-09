import { afterEach, describe, expect, it, vi } from "vitest";

import { backendFetch } from "../src/backend-client";

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
    delete process.env.BACKEND_INTERNAL_SECRET;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(backendFetch("/internal/rpc")).rejects.toThrow(
      "BACKEND_INTERNAL_SECRET is required",
    );
    expect(fetchMock).not.toHaveBeenCalled();
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
});
