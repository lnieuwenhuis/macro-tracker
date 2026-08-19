import { NextResponse } from "next/server";
import { backendFetch } from "@macro-tracker/db";

import { getRequestOrigin, isSameOriginRequest } from "@/lib/request";
import { applySessionTokenCookie, isSecureRequest } from "@/lib/session";

/**
 * The `enctype="text/plain"` form that makes this route cross-site reachable
 * without a preflight cannot set a JSON content type, and `request.json()`
 * ignores the header entirely — so pinning it here is a second, independent
 * lock on the same door as the origin check below.
 */
function hasJsonContentType(request: Request) {
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim();

  return mediaType?.toLowerCase() === "application/json";
}

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
  // This route is unauthenticated (`/api/auth` is public in `proxy.ts`) and its
  // response carries `Set-Cookie: mt_session`. `SameSite=Lax` restricts when a
  // cookie is *sent*, not when it is *set*, so without this gate any site could
  // auto-submit a form carrying its own valid Shoo id_token and silently move
  // the victim into the attacker's account (session fixation).
  if (!isSameOriginRequest(request) || !hasJsonContentType(request)) {
    return NextResponse.json(
      {
        error: "Sign-in must be completed from this site.",
        code: "invalid_origin",
      },
      { status: 403 },
    );
  }

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
