import { ensureDateString } from "@macro-tracker/db";
import { NextResponse } from "next/server";

import { requireSessionUser } from "@/lib/auth";
import { buildAppWarmupPayload } from "@/lib/app-warmup.server";

export async function GET(request: Request) {
  const sessionUser = await requireSessionUser();
  const url = new URL(request.url);
  const selectedDate = ensureDateString(url.searchParams.get("date") ?? undefined);
  const payload = await buildAppWarmupPayload({ sessionUser, selectedDate });

  return NextResponse.json(payload);
}
