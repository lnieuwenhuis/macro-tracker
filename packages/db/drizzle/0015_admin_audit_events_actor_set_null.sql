-- DB-05: admin_audit_events.actor_user_id had no ON DELETE behavior (NO ACTION)
-- while every other user-referencing FK in this schema is `cascade` or `set
-- null`. There is no `DELETE FROM users` path today, so this was latent, but
-- the first account-deletion feature would fail with a FK violation for any
-- user who ever performed an admin action.
--
-- Decision: audit rows must survive the actor's account being deleted (the
-- audit trail is the point), so this sets the FK to `ON DELETE SET NULL` and
-- makes the column nullable to match.
ALTER TABLE "admin_audit_events" ALTER COLUMN "actor_user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "admin_audit_events" DROP CONSTRAINT "admin_audit_events_actor_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_audit_events"
  ADD CONSTRAINT "admin_audit_events_actor_user_id_users_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
