import { getServerEnv } from "./env";

function getFirstForwardedValue(value: string | null) {
  return value?.split(",")[0]?.trim() || null;
}

function normalizeProtocol(value: string | null) {
  const protocol = value?.replace(/:$/, "").toLowerCase();

  return protocol === "http" || protocol === "https" ? `${protocol}:` : null;
}

function normalizeHost(value: string | null) {
  const host = value?.trim().toLowerCase();

  if (!host || host.includes("/") || host.includes("@")) {
    return null;
  }

  try {
    return new URL(`http://${host}`).host;
  } catch {
    return null;
  }
}

function getTrustedOrigins() {
  return new Set(getServerEnv().trustedOrigins);
}

function buildOrigin(protocol: string | null, host: string | null) {
  if (!protocol || !host) {
    return null;
  }

  return new URL(`${protocol}//${host}`).origin;
}

export function getRequestProtocol(request: Request) {
  return new URL(getRequestOrigin(request)).protocol;
}

// CSRF gate: SameSite=Lax governs sending a cookie, not setting one; prefer Sec-Fetch-Site over Origin, fail closed.
export function isSameOriginRequest(request: Request) {
  const secFetchSite = request.headers.get("sec-fetch-site");

  if (secFetchSite) {
    return secFetchSite.trim().toLowerCase() === "same-origin";
  }

  const origin = request.headers.get("origin");

  if (!origin) {
    return false;
  }

  let callerOrigin: string;

  try {
    // A sandboxed iframe sends the literal `null`, which is not a valid URL.
    callerOrigin = new URL(origin).origin;
  } catch {
    return false;
  }

  return (
    callerOrigin === getRequestOrigin(request) || getTrustedOrigins().has(callerOrigin)
  );
}

export function getRequestOrigin(request: Request) {
  const trustedOrigins = getTrustedOrigins();
  const appOrigin = new URL(getServerEnv().appUrl).origin;
  const forwardedOrigin = buildOrigin(
    normalizeProtocol(getFirstForwardedValue(request.headers.get("x-forwarded-proto"))),
    normalizeHost(getFirstForwardedValue(request.headers.get("x-forwarded-host"))),
  );

  if (forwardedOrigin && trustedOrigins.has(forwardedOrigin)) {
    return forwardedOrigin;
  }

  const requestOrigin = new URL(request.url).origin;

  if (trustedOrigins.has(requestOrigin)) {
    return requestOrigin;
  }

  return appOrigin;
}
