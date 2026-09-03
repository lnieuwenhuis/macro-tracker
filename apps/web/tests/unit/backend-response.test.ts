import { describe, expect, it, vi } from "vitest";

import { createBackendProxyResponse, stripHopByHopHeaders } from "@/lib/backend-response";

describe("stripHopByHopHeaders", () => {
  it("removes hop-by-hop headers and host", () => {
    const headers = new Headers({
      connection: "keep-alive",
      "keep-alive": "timeout=5",
      te: "trailers",
      upgrade: "websocket",
      host: "example.com",
      "content-type": "application/json",
    });

    const stripped = stripHopByHopHeaders(headers);

    expect(stripped.has("connection")).toBe(false);
    expect(stripped.has("keep-alive")).toBe(false);
    expect(stripped.has("te")).toBe(false);
    expect(stripped.has("upgrade")).toBe(false);
    expect(stripped.has("host")).toBe(false);
    expect(stripped.get("content-type")).toBe("application/json");
  });

  it("also drops headers nominated by a Connection header before dropping connection itself", () => {
    const headers = new Headers({
      connection: "x-secret, x-other",
      "x-secret": "leak-me",
      "x-other": "leak-me-too",
      "x-safe": "keep-me",
    });

    const stripped = stripHopByHopHeaders(headers);

    expect(stripped.has("x-secret")).toBe(false);
    expect(stripped.has("x-other")).toBe(false);
    expect(stripped.get("x-safe")).toBe("keep-me");
  });
});

describe("createBackendProxyResponse", () => {
  it("forwards the backend body as a stream without buffering", async () => {
    const response = new Response("streamed", {
      status: 201,
      headers: {
        "content-type": "text/plain",
        "content-length": "8",
        "x-request-id": "request-1",
      },
    });
    const arrayBuffer = vi.spyOn(response, "arrayBuffer");

    const proxied = await createBackendProxyResponse(response);

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(proxied.status).toBe(201);
    expect(proxied.headers.get("x-request-id")).toBe("request-1");
    expect(proxied.headers.has("content-length")).toBe(false);
    expect(await proxied.text()).toBe("streamed");
  });

  it.each([
    ["HEAD", 200],
    ["GET", 204],
    ["GET", 304],
  ])("suppresses the response body for %s %s", async (method, status) => {
    const response = new Response(status === 200 ? "ignored" : null, { status });
    const proxied = await createBackendProxyResponse(response, {
      includeBody: method !== "HEAD",
    });

    expect(proxied.body).toBeNull();
    expect(await proxied.text()).toBe("");
  });
});
