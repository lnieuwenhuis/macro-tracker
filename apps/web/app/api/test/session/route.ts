import { getDb, upsertUserFromShooProfile } from "@macro-tracker/db";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getServerEnv } from "@/lib/env";
import { applySessionCookie } from "@/lib/session";
import { isEmailAllowed } from "@/lib/shoo";

async function ensureTestSchema() {
  const db = await getDb();

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "users" (
      "id" uuid PRIMARY KEY NOT NULL,
      "shoo_pairwise_sub" text NOT NULL,
      "email" text NOT NULL,
      "display_name" text,
      "picture_url" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "last_login_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `));
  await db.execute(
    sql.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS "users_shoo_pairwise_sub_key" ON "users" USING btree ("shoo_pairwise_sub")`,
    ),
  );
  await db.execute(
    sql.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users" USING btree ("email")`,
    ),
  );
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "meal_entries" (
      "id" uuid PRIMARY KEY NOT NULL,
      "user_id" uuid NOT NULL,
      "entry_date" date NOT NULL,
      "label" text NOT NULL,
      "sort_order" integer NOT NULL,
      "protein_g" numeric(6, 1) NOT NULL,
      "carbs_g" numeric(6, 1) NOT NULL,
      "fat_g" numeric(6, 1) NOT NULL,
      "calories_kcal" integer NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `));
  await db.execute(
    sql.raw(
      `CREATE INDEX IF NOT EXISTS "meal_entries_user_date_idx" ON "meal_entries" USING btree ("user_id","entry_date")`,
    ),
  );
  await db.execute(
    sql.raw(
      `CREATE INDEX IF NOT EXISTS "meal_entries_user_date_sort_idx" ON "meal_entries" USING btree ("user_id","entry_date","sort_order")`,
    ),
  );

  return db;
}

async function createTestSessionResponse(
  email: string | undefined,
  requestUrl: string,
  options: {
    redirectOnSuccess: boolean;
  },
) {
  if (!email) {
    return NextResponse.json(
      { error: "Email is required." },
      { status: 400 },
    );
  }

  if (!isEmailAllowed(email)) {
    return NextResponse.json(
      { error: "Email is not allowed." },
      { status: 403 },
    );
  }

  const db = await ensureTestSchema();
  const user = await upsertUserFromShooProfile(
    {
      pairwiseSub: `test:${email}`,
      email,
      displayName: "Playwright User",
      pictureUrl: null,
    },
    db,
  );
  const response = options.redirectOnSuccess
    ? NextResponse.redirect(new URL("/", requestUrl))
    : NextResponse.json({
        ok: true,
        user: {
          userId: user.id,
          email: user.email,
        },
      });

  await applySessionCookie(response, {
    userId: user.id,
    email: user.email,
  });

  return response;
}

export async function GET(request: Request) {
  if (!getServerEnv().enableTestRoutes) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const url = new URL(request.url);
  const email = url.searchParams.get("email")?.trim().toLowerCase();

  return createTestSessionResponse(email, request.url, {
    redirectOnSuccess: true,
  });
}

export async function POST(request: Request) {
  if (!getServerEnv().enableTestRoutes) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const body = (await request.json()) as { email?: string };
  const email = body.email?.trim().toLowerCase();

  return createTestSessionResponse(email, request.url, {
    redirectOnSuccess: false,
  });
}
