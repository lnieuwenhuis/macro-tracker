import { backendFetch } from "@macro-tracker/db";

import { createBackendProxyResponse, stripHopByHopHeaders } from "./backend-response";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type",
  "access-control-max-age": "86400",
};

// Per-token, wildcard-CORS'd responses; state no-shared-cache explicitly (RFC 9111 §3.5) against a misconfigured CDN.
const NO_SHARED_CACHE_HEADERS = {
  vary: "Authorization",
  "cache-control": "no-store",
};

// The backend bounds one `/api/v1` dispatch at 30s (`API_REQUEST_TIMEOUT`) and answers 504 with the
// `timeout` code itself. The proxy budget must outlive that so the backend envelope normally wins;
// it only fires when the backend is unreachable or its own deadline layer cannot answer.
export const API_V1_BACKEND_TIMEOUT_MS = 35_000;

const TIMEOUT_ERROR = {
  ok: false,
  error: {
    code: "timeout",
    message: "The request took too long to complete.",
  },
};

/** `AbortSignal.timeout` rejects with a DOMException named `TimeoutError`; match by name across runtimes. */
function isTimeoutFailure(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "TimeoutError"
  );
}

export async function handleApiV1Request(
  request: Request,
  path: string[] | undefined,
  method = request.method,
  options: { timeoutMs?: number } = {},
) {
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const segments = path ?? [];

  // Called directly (e.g. from tests) too, bypassing Next's dot-segment normalization, so reject it explicitly.
  // encodeURIComponent("..") is "..", so the encoding below is not itself a traversal defense.
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return Response.json(
      {
        ok: false,
        error: { code: "not_found", message: "Unknown API route." },
      },
      { status: 404, headers: { ...CORS_HEADERS, ...NO_SHARED_CACHE_HEADERS } },
    );
  }

  // openapi.json is proxied like any other route; the backend serves it from a compiled-in artifact.
  const requestUrl = new URL(request.url);
  const encodedPath = segments.map(encodeURIComponent).join("/");
  const backendPath = `/api/v1/${encodedPath}${requestUrl.search}`;
  const headers = stripHopByHopHeaders(new Headers(request.headers));

  const init: RequestInit & {
    duplex?: "half";
    attachInternalSecret?: boolean;
    timeoutMs?: number;
  } = {
    method,
    headers,
    // /api/v1/* is authenticated with the caller's Bearer token, not the internal secret.
    attachInternalSecret: false,
    timeoutMs: options.timeoutMs ?? API_V1_BACKEND_TIMEOUT_MS,
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  try {
    const backendResponse = await backendFetch(backendPath, init);
    return createBackendProxyResponse(backendResponse, {
      includeBody: method !== "HEAD",
      extraHeaders: NO_SHARED_CACHE_HEADERS,
    });
  } catch (error) {
    // A deadline expiry is reported the same way the backend reports its own 30s deadline, and the
    // failed request is never retried: a timed-out mutation may still have been applied.
    if (isTimeoutFailure(error)) {
      console.error(`API v1 backend proxy deadline exceeded for ${backendPath}`, error);
      return Response.json(TIMEOUT_ERROR, {
        status: 504,
        headers: { ...CORS_HEADERS, ...NO_SHARED_CACHE_HEADERS },
      });
    }
    console.error("API v1 backend proxy failure", error);
    return Response.json(
      {
        ok: false,
        error: {
          code: "upstream_error",
          message: "Backend service is unavailable.",
        },
      },
      { status: 502, headers: { ...CORS_HEADERS, ...NO_SHARED_CACHE_HEADERS } },
    );
  }
}
