import { backendFetch } from "@macro-tracker/db";

export async function createBackendProxyResponse(
  response: Response,
  options: { includeBody?: boolean } = {},
) {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");

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
  const headers = new Headers(request.headers);
  headers.delete("host");
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
