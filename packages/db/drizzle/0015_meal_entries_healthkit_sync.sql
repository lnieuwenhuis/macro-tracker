ALTER TABLE "meal_entries" ADD COLUMN "healthkit_synced_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "meal_entries_healthkit_unsynced_idx" ON "meal_entries" USING btree ("user_id", "entry_date") WHERE "healthkit_synced_at" IS NULL AND "status" = 'eaten';
