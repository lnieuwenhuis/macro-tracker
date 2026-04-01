ALTER TABLE "users" ADD COLUMN "goal_calories_kcal" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "goal_protein_g" numeric(6, 1);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "goal_carbs_g" numeric(6, 1);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "goal_fat_g" numeric(6, 1);