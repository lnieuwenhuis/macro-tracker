ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'user' NOT NULL;
--> statement-breakpoint
ALTER TABLE "barcode_products" ADD COLUMN "updated_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "barcode_products" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "barcode_products" ALTER COLUMN "updated_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "barcode_products" ALTER COLUMN "updated_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "barcode_products" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "barcode_products" ADD COLUMN "deleted_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "barcode_products"
  ADD CONSTRAINT "barcode_products_deleted_by_user_id_users_id_fk"
  FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "barcode_products_deleted_at_idx" ON "barcode_products" USING btree ("deleted_at");
--> statement-breakpoint
CREATE TABLE "admin_audit_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "actor_user_id" uuid NOT NULL,
  "actor_role" text NOT NULL,
  "action" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "details_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_audit_events"
  ADD CONSTRAINT "admin_audit_events_actor_user_id_users_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "admin_audit_events_created_at_idx" ON "admin_audit_events" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "admin_audit_events_target_idx" ON "admin_audit_events" USING btree ("target_type","target_id");
