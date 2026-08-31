-- Static friend codes for gym-buddy invites, so users can share a code
-- instead of revealing their email address.
--
--   * users.friend_code: 8 chars from an unambiguous alphabet (no 0/O/1/I/L),
--     generated lazily by the backend on first gym-page access (app-generated
--     like every other identifier here - no gen_random_uuid()/pgcrypto, which
--     PGlite does not guarantee). Nullable until first use; uniqueness via a
--     partial index so the many NULLs stay out of it.
--   * gym_buddies.invite_identifier: exactly what the requester typed
--     (normalized) - the email OR the code. The sent-invites list echoes this
--     back instead of always projecting the addressee's email, because a
--     code-based invite must NOT reveal the target's email to the inviter.
--     Backfilled with the addressee's email for pre-existing rows, which were
--     all created by email invites.
ALTER TABLE "users" ADD COLUMN "friend_code" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_friend_code_key" ON "users" USING btree ("friend_code") WHERE "friend_code" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "gym_buddies" ADD COLUMN "invite_identifier" text;
--> statement-breakpoint
UPDATE "gym_buddies" b
SET "invite_identifier" = u."email"
FROM "users" u
WHERE u."id" = b."addressee_user_id"
  AND b."invite_identifier" IS NULL;
