import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  applySessionCookie,
  isSecureRequest,
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from "@/lib/session";

/**
 * Static files served straight out of `public/`. Listed explicitly rather than
 * matched by extension: `pathname.endsWith(".png")` also matched
 * `/api/barcode/1234.png` and `/admin/barcodes/abc.png`, which let any route
 * skip the session gate simply by ending in an image extension.
 */
const PUBLIC_STATIC_FILES = new Set([
  "/favicon.ico",
  "/icon.svg",
  "/icon-maskable.svg",
  "/apple-touch-icon.svg",
  "/manifest.webmanifest",
  "/sw.js",
]);

const CSP_HEADER = "content-security-policy";

/**
 * Header the root layout reads the request's nonce back from. Next also parses
 * the nonce out of the `Content-Security-Policy` *request* header on its own
 * (see `getScriptNonceFromHeader`) to nonce React's bootstrap and RSC payload
 * scripts; this header is only so `app/layout.tsx` can put the same value on
 * the two `next/script` bootstraps.
 */
export const NONCE_HEADER = "x-nonce";

const isDev = process.env.NODE_ENV === "development";

export const DEFAULT_SHOO_BASE_URL = "https://shoo.dev";

/**
 * Origin the browser talks to directly during sign-in.
 *
 * `@shoojs/auth` runs the code-for-token exchange **in the browser**
 * (`fetch("<shooBaseUrl>/token")`) and re-checks the session against
 * `/session/check`, so the identity provider has to be in `connect-src`.
 */
export function getShooConnectOrigin(
  shooBaseUrl = process.env.SHOO_BASE_URL ?? DEFAULT_SHOO_BASE_URL,
) {
  try {
    return new URL(shooBaseUrl).origin;
  } catch {
    return new URL(DEFAULT_SHOO_BASE_URL).origin;
  }
}

/**
 * 128 random bits, base64. Must be unpredictable and must differ per request —
 * a reused nonce is exactly as good as `'unsafe-inline'`.
 */
function createNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  return btoa(String.fromCharCode(...bytes));
}

/**
 * Defence-in-depth. There is no known XSS here (no `dangerouslySetInnerHTML`,
 * no `eval`, `httpOnly` + `SameSite=Lax` cookies), so this exists to bound the
 * damage of a future one.
 *
 * `script-src` is nonce-based: `'unsafe-inline'` is gone, so an injected
 * `<script>` or `onerror=` attribute cannot run. Next applies `nonce` to its
 * own bootstrap and RSC payload scripts by parsing it out of the CSP request
 * header, and `app/layout.tsx` passes it to the two `next/script` bootstraps.
 * The cost is that every route now renders dynamically, because the root
 * layout reads the nonce from `headers()`.
 *
 * `'strict-dynamic'` is deliberately **absent**. It would make `'self'` be
 * ignored, so every script tag — including ones Next may add without a nonce —
 * would have to be nonced or injected by already-trusted code, for no gain
 * here: nothing on this origin serves attacker-controlled JavaScript, so
 * `'self'` is not a usable injection source. Keeping `'self'` also means a
 * missing nonce degrades to today's behaviour for external scripts instead of
 * blanking the app.
 *
 * `style-src` keeps `'unsafe-inline'` and gets **no** nonce on purpose: adding
 * one would make the browser ignore `'unsafe-inline'` and break every inline
 * style Next and `next/font` emit.
 *
 * `img-src https:` covers supermarket product thumbnails; `blob:` covers the
 * camera preview and the AI photo preview.
 *
 * `form-action` is deliberately **absent**. Chromium enforces it across the
 * whole redirect chain, and this app's forms are all POST-then-redirect —
 * signing out (`/api/auth/logout` → `/login`) and every admin server action
 * that calls `redirect()`. With `form-action 'self'` those submissions are
 * blocked outright and the page silently stays put. The directive only guards
 * against form-jacking to an external origin, and no form here takes a
 * caller-supplied action, so the trade is not worth a broken sign-out.
 */
export function buildContentSecurityPolicy(
  nonce: string,
  shooOrigin = getShooConnectOrigin(),
  dev = isDev,
) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${shooOrigin}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
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

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const nonce = createNonce();
  const contentSecurityPolicy = buildContentSecurityPolicy(nonce);

  // `set`, never `append`: a caller can send its own `content-security-policy`
  // or `x-nonce` request header, and the renderer trusts whatever it finds.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CSP_HEADER, contentSecurityPolicy);
  requestHeaders.set(NONCE_HEADER, nonce);

  function withPolicy(response: NextResponse) {
    response.headers.set(CSP_HEADER, contentSecurityPolicy);
    return response;
  }

  // The nonce only reaches the renderer through the forwarded *request*
  // headers; setting it on the response alone would leave every inline script
  // unnonced and therefore blocked.
  function renderResponse() {
    return withPolicy(
      NextResponse.next({ request: { headers: requestHeaders } }),
    );
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const sessionUser = await verifySessionToken(token);

  // `?error=` means the user was just bounced here by a failed authorization
  // check. Bouncing them back to `/` would restart that check and loop, which
  // is reachable whenever the token still verifies but the account behind it
  // does not resolve (deleted account), or when `/api/auth/logout` declined to
  // clear the cookie for a cross-site request.
  if (
    pathname === "/login" &&
    sessionUser &&
    !request.nextUrl.searchParams.has("error")
  ) {
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
