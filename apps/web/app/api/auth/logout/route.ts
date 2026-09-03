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

// GET exists so a Server Component's redirect(...expired=1) can clear the cookie; gated same-origin, since forceable.
export async function GET(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.redirect(new URL(logoutDestination(request), request.url));
  }

  return createLogoutResponse(request);
}

// Used by the in-app sign-out buttons; a cross-site form gets the same no-op redirect as a cross-site GET.
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.redirect(new URL(logoutDestination(request), request.url));
  }

  return createLogoutResponse(request);
}
