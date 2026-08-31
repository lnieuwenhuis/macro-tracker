import type { SessionUser } from "@macro-tracker/db";
import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getServerEnv } from "./env";
import { getRequestProtocol } from "./request";

export const SESSION_COOKIE_NAME = "mt_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/**
 * Hard ceiling on how long one sign-in can be extended for.
 *
 * `proxy.ts` re-mints a fresh 7-day token on every authenticated request, so
 * `exp` alone never expires for anyone who keeps using the app — a token
 * captured once would stay valid indefinitely, and `clearSessionCookie` only
 * deletes the browser's copy. Carrying the *original* authentication time
 * through every renewal and refusing anything older than this bounds that
 * window without a per-request database lookup or a schema change.
 */
export const SESSION_ABSOLUTE_LIFETIME_SECONDS = 60 * 60 * 24 * 30;

/**
 * A session that passed verification. `authenticatedAt` is Unix seconds for the
 * *original* sign-in — never the current renewal — so it must be threaded back
 * into `createSessionToken` whenever the cookie is refreshed.
 */
export type VerifiedSession = SessionUser & {
  authenticatedAt: number;
};

function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Signing and verifying both run on every request, so cache the encoded secret
// instead of allocating a TextEncoder and a fresh Uint8Array each time. Keyed
// by secret so a changed env value is still picked up.
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

/**
 * Pass a {@link VerifiedSession} when renewing so the original sign-in time
 * survives; omit it only when the user has just authenticated.
 */
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

    // The Rust backend mints the token for the initial sign-in and does not set
    // `authenticatedAt`, so its `iat` is the original authentication time.
    // A token carrying neither cannot be lifetime-bounded, so it is refused.
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
