import { backendFetch } from "@macro-tracker/db";

// Hop-by-hop headers describe only the connection they arrived on and must not be forwarded (RFC 9110 §7.6.1).
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export function stripHopByHopHeaders(headers: Headers) {
  // A Connection header nominates further headers for removal; honour that before dropping connection itself.
  for (const nominated of headers.get("connection")?.split(",") ?? []) {
    const name = nominated.trim();
    if (name) {
      headers.delete(name);
    }
  }

  for (const name of HOP_BY_HOP_HEADERS) {
    headers.delete(name);
  }

  headers.delete("host");

  return headers;
}

export async function createBackendProxyResponse(
  response: Response,
  options: { includeBody?: boolean; extraHeaders?: Record<string, string> } = {},
) {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");

  for (const [name, value] of Object.entries(options.extraHeaders ?? {})) {
    headers.set(name, value);
  }

  const includeBody =
    options.includeBody !== false && response.status !== 204 && response.status !== 304;

  if (!includeBody) {
    await response.body?.cancel();
  }

  return new Response(includeBody ? response.body : null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function proxyBackendRoute(
  request: Request,
  path: string,
  unavailableBody: unknown,
  options: {
    timeoutMs?: number;
    /** Opt in only for reads whose work may be abandoned when the client leaves. */
    cancelReadOnDisconnect?: boolean;
  } = {},
) {
  const headers = stripHopByHopHeaders(new Headers(request.headers));
  const forwardsBody = request.method !== "GET" && request.method !== "HEAD";
  const signal =
    options.cancelReadOnDisconnect && !forwardsBody ? request.signal : undefined;

  try {
    const response = await backendFetch(path, {
      method: request.method,
      headers,
      body: forwardsBody ? request.body : undefined,
      ...(signal ? { signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(forwardsBody ? { duplex: "half" as const } : {}),
    } as RequestInit & { duplex?: "half"; timeoutMs?: number });
    return createBackendProxyResponse(response);
  } catch (error) {
    // Logged rather than swallowed: a 502 is indistinguishable from a genuine "not found" once it reaches the client.
    if (!signal?.aborted) {
      console.error(`Backend proxy failure for ${path}`, error);
    }
    return Response.json(unavailableBody, { status: 502 });
  }
}
