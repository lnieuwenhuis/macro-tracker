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

// Like real fetch, the body errors with the signal's reason once the request is aborted.
function mockStreamingFetch(chunks: string[], { endStream = true } = {}) {
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    const signal = init.signal!;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (endStream) controller.close();
      },
    });
    return Promise.resolve(new Response(body, { status: 201, headers: { "x-test": "kept" } }));
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function sentSignal(fetchMock: { mock: { calls: unknown[][] } }) {
  return (fetchMock.mock.calls[0]?.[1] as RequestInit).signal!;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  it("passes status, headers and body through", async () => {
    mockStreamingFetch(['{"ok":', "true}"]);

    const response = await backendFetch("/internal/rpc", { timeoutMs: 1_000 });

    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("kept");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  // A pending timeout signal keeps the finished request reachable until it fires, inflating server memory.
  it("releases the deadline once the body has been read", async () => {
    const fetchMock = mockStreamingFetch(["{}"]);

    await (await backendFetch("/internal/rpc", { timeoutMs: 30 })).text();
    await sleep(60);

    expect(sentSignal(fetchMock).aborted).toBe(false);
  });

  it("releases the deadline for a response without a body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await backendFetch("/internal/rpc", { timeoutMs: 30 });
    await sleep(60);

    expect(response.status).toBe(204);
    expect(sentSignal(fetchMock).aborted).toBe(false);
  });

  it("still times out a body that stalls after the headers", async () => {
    mockStreamingFetch(["{"], { endStream: false });

    const response = await backendFetch("/internal/rpc", { timeoutMs: 30 });

    await expect(response.text()).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("forwards the caller's abort reason", async () => {
    const fetchMock = mockStreamingFetch(["{"], { endStream: false });
    const caller = new AbortController();

    const response = await backendFetch("/internal/rpc", { signal: caller.signal });
    caller.abort(new Error("client disconnected"));

    await expect(response.text()).rejects.toThrow("client disconnected");
    expect(sentSignal(fetchMock).reason).toEqual(new Error("client disconnected"));
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
