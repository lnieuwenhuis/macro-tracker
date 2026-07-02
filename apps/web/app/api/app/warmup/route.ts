import { ensureDateString } from "@macro-tracker/db";
import { NextResponse } from "next/server";

import { requireOnboardedSessionUser } from "@/lib/auth";
import { normalizeAppWarmupScope } from "@/lib/app-warmup";
import { buildAppWarmupPayload } from "@/lib/app-warmup.server";

export async function GET(request: Request) {
  const sessionUser = await requireOnboardedSessionUser();
  const url = new URL(request.url);
  const selectedDate = ensureDateString(url.searchParams.get("date") ?? undefined);
  const scope = normalizeAppWarmupScope(url.searchParams.get("scope"));
  const payload = await buildAppWarmupPayload({ sessionUser, selectedDate, scope });

  return NextResponse.json(payload);
}
