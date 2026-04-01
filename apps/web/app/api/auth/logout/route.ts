import { NextResponse } from "next/server";

import { clearSessionCookie } from "@/lib/session";

export async function POST(request: Request) {
  const response = NextResponse.redirect(new URL("/login?loggedOut=1", request.url));
  clearSessionCookie(response);
  return response;
}
