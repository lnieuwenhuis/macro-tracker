WITH default_group_candidates AS (
  SELECT
    "meal_groups"."id",
    "meal_groups"."user_id",
    "meal_groups"."label",
    "meal_groups"."created_at",
    (
      SELECT count(*)
      FROM "meal_entries"
      WHERE "meal_entries"."meal_group_id" = "meal_groups"."id"
    ) AS "reference_count"
  FROM "meal_groups"
  WHERE "meal_groups"."deleted_at" IS NULL
    AND "meal_groups"."is_default" = true
),
ranked_default_groups AS (
  SELECT
    "id",
    first_value("id") OVER (
      PARTITION BY "user_id", "label"
      ORDER BY "reference_count" DESC, "created_at", "id"
    ) AS "keeper_id",
    row_number() OVER (
      PARTITION BY "user_id", "label"
      ORDER BY "reference_count" DESC, "created_at", "id"
    ) AS "duplicate_rank"
  FROM default_group_candidates
),
duplicate_default_groups AS (
  SELECT "id", "keeper_id"
  FROM ranked_default_groups
  WHERE "duplicate_rank" > 1
)
UPDATE "meal_entries"
SET
  "meal_group_id" = duplicate_default_groups."keeper_id",
  "updated_at" = now()
FROM duplicate_default_groups
WHERE "meal_entries"."meal_group_id" = duplicate_default_groups."id";
--> statement-breakpoint
WITH default_group_candidates AS (
  SELECT
    "meal_groups"."id",
    "meal_groups"."user_id",
    "meal_groups"."label",
    "meal_groups"."created_at",
    (
      SELECT count(*)
      FROM "meal_entries"
      WHERE "meal_entries"."meal_group_id" = "meal_groups"."id"
    ) AS "reference_count"
  FROM "meal_groups"
  WHERE "meal_groups"."deleted_at" IS NULL
    AND "meal_groups"."is_default" = true
),
ranked_default_groups AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "user_id", "label"
      ORDER BY "reference_count" DESC, "created_at", "id"
    ) AS "duplicate_rank"
  FROM default_group_candidates
)
UPDATE "meal_groups"
SET
  "deleted_at" = now(),
  "updated_at" = now()
FROM ranked_default_groups
WHERE "meal_groups"."id" = ranked_default_groups."id"
  AND ranked_default_groups."duplicate_rank" > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "meal_groups_active_default_label_key"
ON "meal_groups" USING btree ("user_id", "label")
WHERE "deleted_at" IS NULL AND "is_default" = true;
