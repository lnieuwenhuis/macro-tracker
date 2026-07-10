import {
  completeUserOnboarding,
  ensureUserRole,
  setUserOnboardingForTesting,
  upsertUserFromShooProfile,
} from "@macro-tracker/db";
import { NextResponse } from "next/server";

import { getServerEnv } from "@/lib/env";
import { applySessionCookie, isSecureRequest } from "@/lib/session";
import { ensureTestRouteRequest } from "@/lib/test-routes";

const TEST_LOGIN_BASES = new Set(["coach", "owner", "admin", "user", "setup"]);

function getTestLoginBase(email: string) {
  const match = /^([a-z]+)(?:\+[a-z0-9-]+)?@example\.com$/i.exec(email);
  const base = match?.[1]?.toLowerCase();

  return base && TEST_LOGIN_BASES.has(base) ? base : null;
}

async function createTestSessionResponse(
  email: string | undefined,
  request: Request,
  options: {
    redirectOnSuccess: boolean;
    onboarded: boolean;
  },
) {
  if (!email) {
    return NextResponse.json(
      { error: "Email is required." },
      { status: 400 },
    );
  }

  const testLoginBase = getTestLoginBase(email);

  if (!testLoginBase) {
    return NextResponse.json(
      { error: "This test login is not allowlisted." },
      { status: 403 },
    );
  }

  const user = await upsertUserFromShooProfile(
    {
      pairwiseSub: `test:${email}`,
      email,
      displayName: "Playwright User",
      pictureUrl: null,
    },
  );
  if (testLoginBase === "owner") {
    await ensureUserRole(user.id, "owner");
  }
  if (options.onboarded) {
    await completeUserOnboarding(user.id, { preferredWeightUnit: "kg" });
  } else {
    await setUserOnboardingForTesting(user.id, false);
  }
  const response = options.redirectOnSuccess
    ? NextResponse.redirect(new URL("/", request.url))
    : NextResponse.json({
        ok: true,
        user: {
          userId: user.id,
          email: user.email,
        },
      });

  await applySessionCookie(
    response,
    {
      userId: user.id,
      email: user.email,
    },
    {
      secure: isSecureRequest(request),
    },
  );

  return response;
}

export async function GET(request: Request) {
  const env = getServerEnv();
  const testRouteError = ensureTestRouteRequest(request, env);

  if (testRouteError) {
    return testRouteError;
  }

  const url = new URL(request.url);
  const email = url.searchParams.get("email")?.trim().toLowerCase();
  const onboarded = url.searchParams.get("onboarded") !== "false";

  return createTestSessionResponse(email, request, {
    redirectOnSuccess: true,
    onboarded,
  });
}

export async function POST(request: Request) {
  const env = getServerEnv();
  const testRouteError = ensureTestRouteRequest(request, env);

  if (testRouteError) {
    return testRouteError;
  }

  const body = (await request.json()) as { email?: string; onboarded?: boolean };
  const email = body.email?.trim().toLowerCase();

  return createTestSessionResponse(email, request, {
    redirectOnSuccess: false,
    onboarded: body.onboarded !== false,
  });
}
