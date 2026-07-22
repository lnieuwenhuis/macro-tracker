import { describe, expect, it, vi } from "vitest";

import { createBackendProxyResponse } from "@/lib/backend-response";

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
