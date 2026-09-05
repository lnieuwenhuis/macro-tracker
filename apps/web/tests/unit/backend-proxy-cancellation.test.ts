import { beforeEach, describe, expect, it, vi } from "vitest";

const backendFetch = vi.hoisted(() => vi.fn());
vi.mock("@macro-tracker/db", () => ({ backendFetch }));
import { proxyBackendRoute } from "@/lib/backend-response";

beforeEach(() => {
  backendFetch.mockReset().mockResolvedValue(new Response("ok"));
});

describe("abandoned read cancellation", () => {
  it.each(["GET", "HEAD"])("forwards the request signal for an opted-in %s", async (method) => {
    const controller = new AbortController();
    const request = new Request("http://localhost/api/barcode/123456", { method, signal: controller.signal });
    await proxyBackendRoute(request, "/api/barcode/123456", {}, { cancelReadOnDisconnect: true });
    const signal = backendFetch.mock.calls[0][1].signal;
    expect(signal).toBe(request.signal);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it.each(["GET", "POST", "PUT", "PATCH", "DELETE"])("keeps default %s work independent of disconnect", async (method) => {
    const request = new Request("http://localhost/api/example", { method });
    await proxyBackendRoute(request, "/api/example", {});
    expect(backendFetch.mock.calls[0][1].signal).toBeUndefined();
  });

  it("never cancels mutations even if a caller accidentally opts in", async () => {
    await proxyBackendRoute(new Request("http://localhost/api/example", { method: "POST" }), "/api/example", {}, { cancelReadOnDisconnect: true });
    expect(backendFetch.mock.calls[0][1].signal).toBeUndefined();
  });

  it("does not log expected client cancellation as a backend outage", async () => {
    const controller = new AbortController();
    backendFetch.mockImplementation(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await proxyBackendRoute(new Request("http://localhost/api/example", { signal: controller.signal }), "/api/example", {}, { cancelReadOnDisconnect: true });
      expect(error).not.toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });

  it("still reports backend failures and timeouts", async () => {
    backendFetch.mockRejectedValue(new DOMException("timeout", "TimeoutError"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await proxyBackendRoute(new Request("http://localhost/api/example"), "/api/example", { error: "unavailable" }, { cancelReadOnDisconnect: true });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "unavailable" });
      expect(error).toHaveBeenCalledOnce();
    } finally { error.mockRestore(); }
  });
});
