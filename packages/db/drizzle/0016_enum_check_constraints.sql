-- DB-09: enum-like text columns had no CHECK constraint even though
-- `types.ts` models each as a closed union enforced by the Rust backend at
-- the application layer (`apps/backend/src/db.rs`, `matches!(...)` guards).
-- Allowed sets below were derived from `packages/db/src/types.ts` and cross-
-- checked against every literal the backend actually writes/validates for
-- each column (grep for `matches!` and the literal string values in
-- `apps/backend/src/db.rs`):
--   users.role                     -> ADMIN_ROLE_VALUES            (user, admin, owner)
--   meal_entries.status            -> MEAL_ENTRY_STATUS_VALUES     (planned, eaten, skipped)
--   meal_templates.type            -> MEAL_TEMPLATE_TYPE_VALUES    (meal, day)
--   food_products.scope            -> FOOD_PRODUCT_SCOPE_VALUES    (global, personal, legacy)
--   food_products.source           -> FOOD_PRODUCT_SOURCE_VALUES   (manual, barcode, ai_photo, legacy, recipe)
--   users.preferred_weight_unit    -> WEIGHT_UNIT_VALUES           (kg, lb)
--
-- `users.role`, `meal_entries.status`, `food_products.scope`,
-- `food_products.source`, and `users.preferred_weight_unit` are all guarded
-- by an explicit `matches!(...)` check in the backend before every write, so
-- there should be no existing row outside the allowed set for those columns.
--
-- `meal_templates.type` is the one exception: `create_template_json` /
-- `update_template_json` / `create_template_from_date_json` read it with
-- `required_string(input, "type")`, which only checks for a non-empty
-- string -- there is no `matches!` guard, so an out-of-union value could
-- already exist in production (this is API-07 in the audit; the backend-side
-- validation fix is tracked separately and owned by another group).
--
-- Because this runs as a blocking Railway `preDeployCommand` and there is no
-- way to inspect production data from this package, every constraint here
-- is added `NOT VALID`: it is enforced for every new INSERT/UPDATE from the
-- moment this migration applies, but does NOT scan or validate existing
-- rows, so it cannot fail the deploy over a legacy value. Once the data is
-- confirmed clean (e.g. `SELECT DISTINCT type FROM meal_templates` inspected
-- against the allowed set), a follow-up hand-authored migration should run
-- `ALTER TABLE ... VALIDATE CONSTRAINT ...` to close the gap fully.
ALTER TABLE "users"
  ADD CONSTRAINT "users_role_check"
  CHECK ("role" IN ('user', 'admin', 'owner')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "users"
  ADD CONSTRAINT "users_preferred_weight_unit_check"
  CHECK ("preferred_weight_unit" IN ('kg', 'lb')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "meal_entries"
  ADD CONSTRAINT "meal_entries_status_check"
  CHECK ("status" IN ('planned', 'eaten', 'skipped')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "meal_templates"
  ADD CONSTRAINT "meal_templates_type_check"
  CHECK ("type" IN ('meal', 'day')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "food_products"
  ADD CONSTRAINT "food_products_scope_check"
  CHECK ("scope" IN ('global', 'personal', 'legacy')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "food_products"
  ADD CONSTRAINT "food_products_source_check"
  CHECK ("source" IN ('manual', 'barcode', 'ai_photo', 'legacy', 'recipe')) NOT VALID;
