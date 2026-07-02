import { ensureDateString } from "@macro-tracker/db";
import { NextResponse } from "next/server";

import { requireOnboardedSessionUser } from "@/lib/auth";
import { normalizeAppWarmupScope } from "@/lib/app-warmup";
import { buildAppWarmupPayload } from "@/lib/app-warmup.server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requestedScope = url.searchParams.get("scope");
  const scope = normalizeAppWarmupScope(requestedScope);

  if (!scope) {
    return NextResponse.json(
      {
        error: `Unsupported warmup scope "${requestedScope}". Expected "core" or "extended".`,
      },
      { status: 400 },
    );
  }

  const sessionUser = await requireOnboardedSessionUser();
  const selectedDate = ensureDateString(url.searchParams.get("date") ?? undefined);
  const payload = await buildAppWarmupPayload({ sessionUser, selectedDate, scope });

  return NextResponse.json(payload);
}
