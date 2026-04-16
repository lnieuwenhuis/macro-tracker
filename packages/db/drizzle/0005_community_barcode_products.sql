CREATE TABLE "barcode_products" (
  "id" uuid PRIMARY KEY NOT NULL,
  "barcode" text NOT NULL,
  "name" text NOT NULL,
  "brands" text DEFAULT '' NOT NULL,
  "protein_g" numeric(6, 1) NOT NULL,
  "carbs_g" numeric(6, 1) NOT NULL,
  "fat_g" numeric(6, 1) NOT NULL,
  "calories_kcal" integer NOT NULL,
  "serving_size_g" numeric(6, 1),
  "added_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "barcode_products_barcode_key" ON "barcode_products" USING btree ("barcode");
