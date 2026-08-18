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
    return NextResponse.redirect(new URL("/", request.url));
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (!sessionUser) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const response = NextResponse.next();
  await applySessionCookie(response, sessionUser, {
    secure: isSecureRequest(request),
  });
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
