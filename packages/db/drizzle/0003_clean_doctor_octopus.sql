CREATE TABLE "weight_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"weight_kg" numeric(5, 2) NOT NULL,
	"body_fat_pct" numeric(4, 1),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "goal_weight_kg" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "weight_entries" ADD CONSTRAINT "weight_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "weight_entries_user_date_key" ON "weight_entries" USING btree ("user_id","entry_date");--> statement-breakpoint
CREATE INDEX "weight_entries_user_date_idx" ON "weight_entries" USING btree ("user_id","entry_date");