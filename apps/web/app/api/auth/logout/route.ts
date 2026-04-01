import { NextResponse } from "next/server";

import { clearSessionCookie } from "@/lib/session";

function createLogoutResponse(request: Request) {
  const url = new URL(request.url);
  const expired = url.searchParams.get("expired") === "1";
  const destination = expired ? "/login?error=session_expired" : "/login?loggedOut=1";
  const response = NextResponse.redirect(new URL(destination, request.url));
  clearSessionCookie(response);
  return response;
}

export async function GET(request: Request) {
  return createLogoutResponse(request);
}

export async function POST(request: Request) {
  return createLogoutResponse(request);
}
