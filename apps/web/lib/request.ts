export function getRequestProtocol(request: Request) {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const protocol = forwardedProto?.split(",")[0]?.trim();

  if (protocol) {
    return `${protocol}:`;
  }

  return new URL(request.url).protocol;
}

export function getRequestOrigin(request: Request) {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost?.split(",")[0]?.trim();

  if (host) {
    return `${getRequestProtocol(request)}//${host}`;
  }

  return new URL(request.url).origin;
}
