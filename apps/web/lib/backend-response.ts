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
) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  const forwardsBody = request.method !== "GET" && request.method !== "HEAD";

  try {
    const response = await backendFetch(path, {
      method: request.method,
      headers,
      body: forwardsBody ? request.body : undefined,
      ...(forwardsBody ? { duplex: "half" as const } : {}),
    } as RequestInit & { duplex?: "half" });
    return createBackendProxyResponse(response);
  } catch {
    return Response.json(unavailableBody, { status: 502 });
  }
}
import { backendFetch } from "@macro-tracker/db";
