import { backendFetch } from "@macro-tracker/db";

import { createBackendProxyResponse, stripHopByHopHeaders } from "./backend-response";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type",
  "access-control-max-age": "86400",
};

/**
 * These responses are per-token and wildcard-CORS'd. RFC 9111 §3.5 already
 * keeps a compliant shared cache from storing an `Authorization`-bearing
 * request, but a single misconfigured CDN rule would turn that into cross-user
 * cache poisoning, so the intent is stated rather than assumed.
 */
const NO_SHARED_CACHE_HEADERS = {
  vary: "Authorization",
  "cache-control": "no-store",
};

export async function handleApiV1Request(
  request: Request,
  path: string[] | undefined,
  method = request.method,
) {
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const segments = path ?? [];

  // Next normalizes dot-segments before route matching, so the router never
  // hands us one — but `handleApiV1Request` is exported and called directly
  // (including from tests), and `encodeURIComponent("..") === ".."`, so the
  // encoding below is not itself a traversal defense.
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return Response.json(
      {
        ok: false,
        error: { code: "not_found", message: "Unknown API route." },
      },
      { status: 404, headers: { ...CORS_HEADERS, ...NO_SHARED_CACHE_HEADERS } },
    );
  }

  // `openapi.json` is proxied like any other route. The backend serves the
  // generated contract straight from a compiled-in artifact, so there is no
  // reason to rebuild an equivalent document here on every request.
  const requestUrl = new URL(request.url);
  const encodedPath = segments.map(encodeURIComponent).join("/");
  const backendPath = `/api/v1/${encodedPath}${requestUrl.search}`;
  const headers = stripHopByHopHeaders(new Headers(request.headers));

  const init: RequestInit & { duplex?: "half"; attachInternalSecret?: boolean } = {
    method,
    headers,
    // The backend authenticates `/api/v1/*` with the caller's Bearer token, so
    // the internal secret has no business on this path.
    attachInternalSecret: false,
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
