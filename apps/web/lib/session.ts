import type { SessionUser } from "@macro-tracker/db";
import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getServerEnv } from "./env";
import { getRequestProtocol } from "./request";

export const SESSION_COOKIE_NAME = "mt_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

// Hard ceiling on one sign-in's lifetime: proxy.ts re-mints `exp` every request, so without this a captured token would stay valid forever.
export const SESSION_ABSOLUTE_LIFETIME_SECONDS = 60 * 60 * 24 * 30;

// `authenticatedAt` is the *original* sign-in time, never the current renewal.
export type VerifiedSession = SessionUser & {
  authenticatedAt: number;
};

function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Cached to avoid a fresh TextEncoder allocation on every request; keyed by secret so a changed env value is still picked up.
let cachedSessionKey: { secret: string; key: Uint8Array } | null = null;

function getSessionKey() {
  const secret = getServerEnv().sessionSecret;

  if (cachedSessionKey?.secret !== secret) {
    cachedSessionKey = { secret, key: new TextEncoder().encode(secret) };
  }

  return cachedSessionKey.key;
}

export function shouldUseSecureCookies() {
  return new URL(getServerEnv().appUrl).protocol === "https:";
}

function getCookieOptions(
  maxAge = SESSION_MAX_AGE_SECONDS,
  secure = shouldUseSecureCookies(),
) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge,
  };
}

export function isSecureRequest(request: Request) {
  return getRequestProtocol(request) === "https:";
}

// Pass a VerifiedSession when renewing so the original sign-in time survives; omit it only on fresh authentication.
export async function createSessionToken(user: SessionUser & { authenticatedAt?: number }) {
  return new SignJWT({
    email: user.email,
    type: "mt_session",
    authenticatedAt: user.authenticatedAt ?? nowInSeconds(),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getSessionKey());
}

export async function verifySessionToken(
  token?: string | null,
): Promise<VerifiedSession | null> {
  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, getSessionKey(), {
      algorithms: ["HS256"],
    });

    if (
      payload.type !== "mt_session" ||
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string"
    ) {
      return null;
    }

    // The backend-minted initial token has no `authenticatedAt`, so its `iat` is the original sign-in time.
    const authenticatedAt =
      typeof payload.authenticatedAt === "number"
        ? payload.authenticatedAt
        : typeof payload.iat === "number"
          ? payload.iat
          : null;

    if (
      authenticatedAt === null ||
      nowInSeconds() - authenticatedAt > SESSION_ABSOLUTE_LIFETIME_SECONDS
    ) {
      return null;
    }

    return {
      userId: payload.sub,
      email: payload.email,
      authenticatedAt,
    } satisfies VerifiedSession;
  } catch {
    return null;
  }
}

export async function getSessionUserFromCookies() {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
}

export async function applySessionCookie(
  response: NextResponse,
  user: SessionUser & { authenticatedAt?: number },
  options?: {
    secure?: boolean;
  },
) {
  const token = await createSessionToken(user);
  response.cookies.set(
    SESSION_COOKIE_NAME,
    token,
    getCookieOptions(SESSION_MAX_AGE_SECONDS, options?.secure),
  );
  return response;
}

export function applySessionTokenCookie(
  response: NextResponse,
  token: string,
  options?: {
    maxAge?: number;
    secure?: boolean;
  },
) {
  response.cookies.set(
    SESSION_COOKIE_NAME,
    token,
    getCookieOptions(options?.maxAge ?? SESSION_MAX_AGE_SECONDS, options?.secure),
  );
  return response;
}

export function clearSessionCookie(
  response: NextResponse,
  options?: {
    secure?: boolean;
  },
) {
  response.cookies.set(SESSION_COOKIE_NAME, "", getCookieOptions(0, options?.secure));
  return response;
}
