import { NextResponse } from "next/server";

import { getRequestOrigin } from "@/lib/request";
import { isSecureRequest } from "@/lib/session";
import { applySessionCookie } from "@/lib/session";
import { authorizeShooLogin, ShooAuthError } from "@/lib/shoo";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { idToken?: string };

    if (!body.idToken) {
      return NextResponse.json(
        {
          error: "Missing idToken.",
          code: "missing_token",
        },
        { status: 400 },
      );
    }

    const { sessionUser } = await authorizeShooLogin(body.idToken, undefined, {
      appOrigin: getRequestOrigin(request),
    });
    const response = NextResponse.json({
      ok: true,
      user: sessionUser,
    });

    await applySessionCookie(response, sessionUser, {
      secure: isSecureRequest(request),
    });
    return response;
  } catch (error) {
    if (error instanceof ShooAuthError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
        },
        { status: error.status },
      );
    }

    console.error("Unexpected Shoo login verification failure", error);

    return NextResponse.json(
      {
        error: "Unable to verify Shoo login.",
        code: "login_failed",
      },
      { status: 500 },
    );
  }
}
