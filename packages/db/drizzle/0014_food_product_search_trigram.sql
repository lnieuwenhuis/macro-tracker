-- Food search matches with leading-wildcard ILIKE, which no btree index can
-- serve, so every query sequentially scanned the shared product catalog.
-- Trigram indexes let the planner prefilter with a bitmap OR across the three
-- searchable columns instead.
--
-- pg_trgm ships with PostgreSQL but is not available in the PGlite builds used
-- for local and test runs. Create it opportunistically: when the extension is
-- missing the indexes are simply skipped, and the search query stays correct
-- because the predicate that uses them is logically redundant -- it only ever
-- narrows work the surrounding condition already enforces.
DO $$
DECLARE
  pg_trgm_available boolean := true;
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION
    WHEN feature_not_supported OR undefined_file THEN
      pg_trgm_available := false;
      RAISE NOTICE 'pg_trgm is unavailable; food product search falls back to a sequential scan.';
  END;

  IF pg_trgm_available THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "food_products_name_trgm_idx" ON "food_products" USING gin ("name" gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "food_products_brand_trgm_idx" ON "food_products" USING gin ("brand" gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "food_products_barcode_trgm_idx" ON "food_products" USING gin ("barcode" gin_trgm_ops)';
  END IF;
END $$;
