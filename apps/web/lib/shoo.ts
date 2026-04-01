import { upsertUserFromShooProfile, type DatabaseClient } from "@macro-tracker/db";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import { getServerEnv } from "./env";

type JwksResolver = Parameters<typeof jwtVerify>[1];

type ShooClaims = JWTPayload & {
  pairwise_sub: string;
  email?: string;
  name?: string;
  picture?: string;
};

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(shooBaseUrl: string) {
  if (!jwksCache.has(shooBaseUrl)) {
    jwksCache.set(
      shooBaseUrl,
      createRemoteJWKSet(new URL("/.well-known/jwks.json", shooBaseUrl)),
    );
  }

  return jwksCache.get(shooBaseUrl)!;
}

export class ShooAuthError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ShooAuthError";
    this.status = status;
    this.code = code;
  }
}

export function isEmailAllowed(
  email: string,
  allowedEmails = getServerEnv().allowedEmails,
) {
  return allowedEmails.includes(email.trim().toLowerCase());
}

export async function verifyShooToken(
  idToken: string,
  options?: {
    appUrl?: string;
    appOrigin?: string;
    shooBaseUrl?: string;
    issuer?: string;
    jwks?: JwksResolver;
  },
) {
  const env = getServerEnv();
  const appOrigin =
    options?.appOrigin ?? new URL(options?.appUrl ?? env.appUrl).origin;
  const shooBaseUrl = options?.shooBaseUrl ?? env.shooBaseUrl;
  const issuer = options?.issuer ?? shooBaseUrl;
  const jwks = options?.jwks ?? getJwks(shooBaseUrl);

  const { payload } = await jwtVerify(idToken, jwks, {
    issuer,
    audience: `origin:${appOrigin}`,
  });

  if (typeof payload.pairwise_sub !== "string") {
    throw new ShooAuthError(
      "Shoo token is missing pairwise_sub.",
      401,
      "invalid_token",
    );
  }

  return payload as ShooClaims;
}

export async function authorizeShooLogin(
  idToken: string,
  db?: DatabaseClient,
  options?: {
    appUrl?: string;
    appOrigin?: string;
    shooBaseUrl?: string;
    issuer?: string;
    jwks?: JwksResolver;
  },
) {
  const claims = await verifyShooToken(idToken, options);
  return authorizeVerifiedShooClaims(claims, db);
}

export async function authorizeVerifiedShooClaims(
  claims: ShooClaims,
  db?: DatabaseClient,
) {
  if (typeof claims.email !== "string" || !claims.email.trim()) {
    throw new ShooAuthError(
      "Shoo token did not include an email address.",
      400,
      "missing_email",
    );
  }

  const email = claims.email.trim().toLowerCase();
  if (!isEmailAllowed(email)) {
    throw new ShooAuthError(
      "This Google account is not allowed to use the app.",
      403,
      "not_allowed",
    );
  }

  const user = await upsertUserFromShooProfile(
    {
      pairwiseSub: claims.pairwise_sub,
      email,
      displayName: typeof claims.name === "string" ? claims.name : null,
      pictureUrl: typeof claims.picture === "string" ? claims.picture : null,
    },
    db,
  );

  return {
    sessionUser: {
      userId: user.id,
      email: user.email,
    },
    claims,
    user,
  };
}
