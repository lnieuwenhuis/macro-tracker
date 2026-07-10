import { NextResponse } from "next/server";
import { backendFetch } from "@macro-tracker/db";

import { getRequestOrigin } from "@/lib/request";
import { applySessionTokenCookie, isSecureRequest } from "@/lib/session";

type ShooVerifyPayload =
  | {
      ok: true;
      data: {
        sessionToken: string;
        sessionMaxAgeSeconds: number;
        user: {
          userId: string;
          email: string;
        };
      };
    }
  | {
      ok: false;
      error?: {
        code?: string;
        message?: string;
      };
    };

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

    const backendResponse = await backendFetch("/internal/auth/shoo/verify", {
      method: "POST",
      body: JSON.stringify({
        idToken: body.idToken,
        appOrigin: getRequestOrigin(request),
      }),
    });
    const payload = (await backendResponse.json().catch(() => null)) as ShooVerifyPayload | null;

    if (!backendResponse.ok || !payload?.ok) {
      const errorPayload = payload && !payload.ok ? payload.error : undefined;
      return NextResponse.json(
        {
          error: errorPayload?.message ?? "Unable to verify Shoo login.",
          code: errorPayload?.code ?? "login_failed",
        },
        { status: backendResponse.status || 500 },
      );
    }

    const response = NextResponse.json({
      ok: true,
      user: payload.data.user,
    });

    applySessionTokenCookie(response, payload.data.sessionToken, {
      maxAge: payload.data.sessionMaxAgeSeconds,
      secure: isSecureRequest(request),
    });
    return response;
  } catch (error) {
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
