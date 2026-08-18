import { backendFetch } from "@macro-tracker/db";

/**
 * Hop-by-hop headers describe the single connection they arrived on (RFC 9110
 * §7.6.1) and are meaningless — at best — on the next hop. Only `host` used to
 * be stripped, so a client could hand the backend a `connection`, `te` or
 * `upgrade` header of its choosing.
 */
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
  // A `Connection: x-secret` request nominates further headers for removal;
  // honour that before dropping `connection` itself.
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
  options: { timeoutMs?: number } = {},
) {
  const headers = stripHopByHopHeaders(new Headers(request.headers));
  const forwardsBody = request.method !== "GET" && request.method !== "HEAD";

  try {
    const response = await backendFetch(path, {
      method: request.method,
      headers,
      body: forwardsBody ? request.body : undefined,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(forwardsBody ? { duplex: "half" as const } : {}),
    } as RequestInit & { duplex?: "half"; timeoutMs?: number });
    return createBackendProxyResponse(response);
  } catch (error) {
    // Logged rather than swallowed: a 502 here is indistinguishable from a
    // genuine "not found" once it reaches the client, so the cause has to be
    // recoverable from the server logs.
    console.error(`Backend proxy failure for ${path}`, error);
    return Response.json(unavailableBody, { status: 502 });
  }
}
