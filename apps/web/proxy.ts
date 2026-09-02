import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import type { VerifiedSession } from "@/lib/session";
import {
  applySessionCookie,
  isSecureRequest,
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from "@/lib/session";

// Listed explicitly, not matched by extension: an extension match would also exempt routes like /api/barcode/1234.png from the session gate below.
const PUBLIC_STATIC_FILES = new Set([
  "/favicon.ico",
  "/icon.svg",
  "/icon-maskable.svg",
  "/apple-touch-icon.svg",
  "/manifest.webmanifest",
  "/sw.js",
]);

const CSP_HEADER = "content-security-policy";

// Header app/layout.tsx reads the request's nonce back from, to put on its two next/script bootstraps.
export const NONCE_HEADER = "x-nonce";

const isDev = process.env.NODE_ENV === "development";

export const DEFAULT_SHOO_BASE_URL = "https://shoo.dev";

// @shoojs/auth exchanges the code for a token from the browser, so the identity provider must be in connect-src.
export function getShooConnectOrigin(
  shooBaseUrl = process.env.SHOO_BASE_URL ?? DEFAULT_SHOO_BASE_URL,
) {
  try {
    return new URL(shooBaseUrl).origin;
  } catch {
    return new URL(DEFAULT_SHOO_BASE_URL).origin;
  }
}

// 128 random bits, base64: a reused nonce is exactly as good as 'unsafe-inline'.
function createNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  return btoa(String.fromCharCode(...bytes));
}

// Defence-in-depth: no known XSS exists here, so this bounds the damage of a future one.
export function buildContentSecurityPolicy(
  nonce: string,
  shooOrigin = getShooConnectOrigin(),
  dev = isDev,
) {
  return [
    "default-src 'self'",
    // The nonce forces every route to render dynamically: app/layout.tsx reads it from headers(). No strict-dynamic: nothing here serves attacker-controlled JS.
    `script-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-eval'" : ""}`,
    // No nonce: that would make the browser ignore 'unsafe-inline' and break Next/next/font inline styles.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https:", // https: for supermarket thumbnails, blob: for camera/AI photo previews
    "font-src 'self' data:",
    `connect-src 'self' ${shooOrigin}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
    // form-action omitted: Chromium enforces it across redirects, breaking POST-then-redirect sign-out; safe only while no form takes a caller-supplied action.
  ].join("; ");
}

function isPublicPath(pathname: string) {
  return (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/test") ||
    pathname === "/api/v1" ||
    pathname.startsWith("/api/v1/") ||
    pathname === "/docs/api" ||
    pathname === "/login" ||
    pathname === "/auth/callback" ||
    PUBLIC_STATIC_FILES.has(pathname)
  );
}

// `?error=` marks a bounce from a failed authorization check; redirecting it to `/` again would loop.
function isAuthenticatedVisitToLoginWithoutErrorBounce(
  sessionUser: VerifiedSession | null,
  request: NextRequest,
) {
  return (
    request.nextUrl.pathname === "/login" &&
    sessionUser !== null &&
    !request.nextUrl.searchParams.has("error")
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const nonce = createNonce();
  const contentSecurityPolicy = buildContentSecurityPolicy(nonce);

  // `set`, never `append`: a caller-supplied header here would be trusted by the renderer.
  const requestHeaders = new Headers(request.headers);
  // Next (getScriptNonceFromHeader) parses the nonce back out of this request-header CSP for its own bootstrap/RSC scripts.
  requestHeaders.set(CSP_HEADER, contentSecurityPolicy);
  requestHeaders.set(NONCE_HEADER, nonce);

  function withPolicy(response: NextResponse) {
    response.headers.set(CSP_HEADER, contentSecurityPolicy);
    return response;
  }

  // The nonce reaches the renderer only via the forwarded request headers, not the response.
  function renderResponse() {
    return withPolicy(
      NextResponse.next({ request: { headers: requestHeaders } }),
    );
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const sessionUser = await verifySessionToken(token);

  if (isAuthenticatedVisitToLoginWithoutErrorBounce(sessionUser, request)) {
    return withPolicy(NextResponse.redirect(new URL("/", request.url)));
  }

  if (isPublicPath(pathname)) {
    return renderResponse();
  }

  if (!sessionUser) {
    return withPolicy(NextResponse.redirect(new URL("/login", request.url)));
  }

  const response = renderResponse();
  await applySessionCookie(response, sessionUser, {
    secure: isSecureRequest(request),
  });
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
