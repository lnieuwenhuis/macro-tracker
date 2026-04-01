import type { SessionUser } from "@macro-tracker/db";
import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getServerEnv } from "./env";
import { getRequestProtocol } from "./request";

export const SESSION_COOKIE_NAME = "mt_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function getSessionKey() {
  return new TextEncoder().encode(getServerEnv().sessionSecret);
}

function getCookieOptions(
  maxAge = SESSION_MAX_AGE_SECONDS,
  secure = getServerEnv().appUrl.startsWith("https://"),
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

export async function createSessionToken(user: SessionUser) {
  return new SignJWT({
    email: user.email,
    type: "mt_session",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getSessionKey());
}

export async function verifySessionToken(token?: string | null) {
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

    return {
      userId: payload.sub,
      email: payload.email,
    } satisfies SessionUser;
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
  user: SessionUser,
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

export function clearSessionCookie(
  response: NextResponse,
  options?: {
    secure?: boolean;
  },
) {
  response.cookies.set(SESSION_COOKIE_NAME, "", getCookieOptions(0, options?.secure));
  return response;
}
