-- HealthKit sync marker for eaten meal entries.
--
-- History note (why this is 0019 and idempotent): this migration originally
-- shipped to PRODUCTION as `0015_meal_entries_healthkit_sync` via a PR that
-- merged straight to main, while dev/staging independently shipped their own
-- 0015-0018 (audit fixes + gym schedule). When the branches were reunified,
-- production had applied THIS migration but not 0015-0018, and staging had
-- applied 0015-0018 but not this one. Drizzle selects pending migrations by
-- comparing `when` against the last applied timestamp, so the unified journal
-- renumbers the audit migrations above production's healthkit timestamp and
-- re-tags healthkit as 0019 above staging's 0018 - which means production
-- re-runs this file. Every statement is therefore guarded so the re-run is a
-- no-op there, while staging/dev apply it for real.
ALTER TABLE "meal_entries" ADD COLUMN IF NOT EXISTS "healthkit_synced_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meal_entries_healthkit_unsynced_idx" ON "meal_entries" USING btree ("user_id", "entry_date") WHERE "healthkit_synced_at" IS NULL AND "status" = 'eaten';
