import { NextResponse } from "next/server";

import { isSameOriginRequest } from "@/lib/request";
import { clearSessionCookie, isSecureRequest } from "@/lib/session";

function logoutDestination(request: Request) {
  const url = new URL(request.url);
  const expired = url.searchParams.get("expired") === "1";

  return expired ? "/login?error=session_expired" : "/login?loggedOut=1";
}

function createLogoutResponse(request: Request) {
  const response = NextResponse.redirect(
    new URL(logoutDestination(request), request.url),
  );
  clearSessionCookie(response, {
    secure: isSecureRequest(request),
  });
  return response;
}

/**
 * `GET` exists because the session-expiry path is a server-side
 * `redirect("/api/auth/logout?expired=1")` from a Server Component, which the
 * browser follows as a navigation — a Server Component cannot clear a cookie
 * during render, so the route has to.
 *
 * That also makes it forceable from any site by top-level navigation, which is
 * why the cookie is only cleared for a same-origin request. A cross-site GET
 * still lands on `/login` so the honest expiry flow never dead-ends; it just
 * leaves the session intact.
 *
 * `proxy.ts` deliberately does not bounce `/login?error=...` back to `/`, so
 * arriving here with a still-verifiable token cannot loop.
 */
export async function GET(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.redirect(new URL(logoutDestination(request), request.url));
  }

  return createLogoutResponse(request);
}

/**
 * The in-app sign-out buttons in `profile-sheet.tsx` and `admin-shell.tsx`.
 * A same-origin form POST carries both `Sec-Fetch-Site: same-origin` and
 * `Origin`, so the gate is transparent to them; a cross-site form gets the same
 * side-effect-free redirect as a cross-site GET.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.redirect(new URL(logoutDestination(request), request.url));
  }

  return createLogoutResponse(request);
}
