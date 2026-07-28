import { backendFetch } from "@macro-tracker/db";

import { createBackendProxyResponse } from "./backend-response";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type",
  "access-control-max-age": "86400",
};

export async function handleApiV1Request(
  request: Request,
  path: string[] | undefined,
  method = request.method,
) {
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // `openapi.json` is proxied like any other route. The backend serves the
  // generated contract straight from a compiled-in artifact, so there is no
  // reason to rebuild an equivalent document here on every request.
  const requestUrl = new URL(request.url);
  const encodedPath = (path ?? []).map(encodeURIComponent).join("/");
  const backendPath = `/api/v1/${encodedPath}${requestUrl.search}`;
  const headers = new Headers(request.headers);
  headers.delete("host");

  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  try {
    const backendResponse = await backendFetch(backendPath, init);
    return createBackendProxyResponse(backendResponse, { includeBody: method !== "HEAD" });
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
      { status: 502, headers: CORS_HEADERS },
    );
  }
}
