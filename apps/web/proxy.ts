import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  applySessionCookie,
  SESSION_COOKIE_NAME,
  isSecureRequest,
  verifySessionToken,
} from "@/lib/session";

function isPublicPath(pathname: string) {
  return (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/test") ||
    pathname === "/login" ||
    pathname === "/auth/callback" ||
    pathname === "/sw.js" ||
    pathname === "/manifest.webmanifest" ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".ico")
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const sessionUser = await verifySessionToken(token);

  if (pathname === "/login" && sessionUser) {
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
