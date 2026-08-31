-- Gym schedule sharing: slots (one-off or weekly recurring), per-date slot
-- statuses, and mutual "gym buddy" relationships.
--
-- Design notes (see the feature PR for the full rationale):
--   * Slot status is a property of a DAY, not of the slot definition: a row in
--     gym_slot_statuses overrides the implicit default 'going' for one date.
--     This holds for BOTH recurrence kinds, so there is no polymorphic status
--     column on gym_slots that could silently rewrite history.
--   * end_minute may be 1440 ("until midnight") so a 23:00-00:00 slot is
--     representable; overnight slots (start >= end) are rejected.
--   * gym_buddies stores one row per unordered user pair, enforced by the
--     LEAST/GREATEST expression index below (must be an index, not a
--     constraint - constraints cannot use expressions). A 'declined' row is a
--     block: it survives and keeps the pair index occupied so re-invites fail.
--   * gym_buddies_requester_idx exists because the accepted-buddies lookup is
--     an OR over both sides; the expression index cannot serve
--     requester_user_id = $1 and without a btree on it Postgres seq-scans.
CREATE TABLE "gym_slots" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "title" text NOT NULL,
  "description" text,
  "recurrence" text NOT NULL,
  "slot_date" date,
  "weekday" integer,
  "start_minute" integer NOT NULL,
  "end_minute" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "gym_slots_recurrence_check"
    CHECK ("recurrence" IN ('once', 'weekly')),
  CONSTRAINT "gym_slots_recurrence_shape_check"
    CHECK (
      ("recurrence" = 'once' AND "slot_date" IS NOT NULL AND "weekday" IS NULL)
      OR ("recurrence" = 'weekly' AND "weekday" BETWEEN 1 AND 7 AND "slot_date" IS NULL)
    ),
  CONSTRAINT "gym_slots_minutes_check"
    CHECK ("start_minute" >= 0 AND "end_minute" <= 1440 AND "start_minute" < "end_minute")
);
--> statement-breakpoint
CREATE INDEX "gym_slots_user_date_idx" ON "gym_slots" USING btree ("user_id", "slot_date");
--> statement-breakpoint
CREATE INDEX "gym_slots_user_weekday_idx" ON "gym_slots" USING btree ("user_id", "weekday");
--> statement-breakpoint
CREATE TABLE "gym_slot_statuses" (
  "id" uuid PRIMARY KEY NOT NULL,
  "slot_id" uuid NOT NULL REFERENCES "gym_slots"("id") ON DELETE cascade,
  "status_date" date NOT NULL,
  "status" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "gym_slot_statuses_status_check"
    CHECK ("status" IN ('going', 'maybe', 'skipped', 'done'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "gym_slot_statuses_slot_date_key" ON "gym_slot_statuses" USING btree ("slot_id", "status_date");
--> statement-breakpoint
CREATE TABLE "gym_buddies" (
  "id" uuid PRIMARY KEY NOT NULL,
  "requester_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "addressee_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "gym_buddies_not_self_check"
    CHECK ("requester_user_id" <> "addressee_user_id"),
  CONSTRAINT "gym_buddies_status_check"
    CHECK ("status" IN ('pending', 'accepted', 'declined'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "gym_buddies_pair_key" ON "gym_buddies" USING btree (LEAST("requester_user_id", "addressee_user_id"), GREATEST("requester_user_id", "addressee_user_id"));
--> statement-breakpoint
CREATE INDEX "gym_buddies_addressee_idx" ON "gym_buddies" USING btree ("addressee_user_id", "status");
--> statement-breakpoint
CREATE INDEX "gym_buddies_requester_idx" ON "gym_buddies" USING btree ("requester_user_id", "status");
