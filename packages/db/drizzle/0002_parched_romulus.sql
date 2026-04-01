CREATE TABLE "food_presets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"protein_g" numeric(6, 1) NOT NULL,
	"carbs_g" numeric(6, 1) NOT NULL,
	"fat_g" numeric(6, 1) NOT NULL,
	"calories_kcal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "food_presets" ADD CONSTRAINT "food_presets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "food_presets_user_idx" ON "food_presets" USING btree ("user_id");