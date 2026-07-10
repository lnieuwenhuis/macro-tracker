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

  return new Response(includeBody ? await response.arrayBuffer() : null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
