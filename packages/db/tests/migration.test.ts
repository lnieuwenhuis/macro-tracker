import { sql } from "drizzle-orm";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabaseRuntime, type DatabaseRuntime } from "../src/client";
import { migrateDatabase } from "../src/migration";
import { resolveDestructiveTestDatabaseUrl } from "../src/testing";

const migrationFiles = [
  "0000_yielding_the_spike.sql",
  "0001_lucky_maelstrom.sql",
  "0002_parched_romulus.sql",
  "0003_clean_doctor_octopus.sql",
  "0004_amazing_betty_brant.sql",
  "0005_community_barcode_products.sql",
  "0006_preset_last_used_at.sql",
  "0007_admin_panel.sql",
  "0008_product_model_meal_planning.sql",
  "0009_sync_barcode_food_products.sql",
  "0010_templates_food_product_cleanup.sql",
  "0011_active_global_barcode_unique.sql",
  "0012_api_tokens.sql",
  "0013_deduplicate_default_meal_groups.sql",
  "0014_food_product_search_trigram.sql",
  "0015_admin_audit_events_actor_set_null.sql",
  "0016_enum_check_constraints.sql",
] as const;

/** Index of `0013_deduplicate_default_meal_groups.sql`, which several tests
 * apply by hand after seeding the state it is expected to repair. */
const DEDUPLICATE_DEFAULT_MEAL_GROUPS_INDEX = 13;

/**
 * Materialise a migrations folder holding only the first `count` migrations,
 * copying the real journal entries verbatim so a later run against the full
 * folder resumes from the correct point instead of replaying them.
 */
async function createPartialMigrationsFolder(count: number) {
  const folder = await mkdtemp(join(tmpdir(), "macro-tracker-partial-migrations-"));
  await mkdir(join(folder, "meta"));

  const journal = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
      "utf8",
    ),
  ) as { entries: { tag: string }[] };
  const entries = journal.entries.slice(0, count);

  await writeFile(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries) {
    await writeFile(
      join(folder, `${entry.tag}.sql`),
      await readFile(
        fileURLToPath(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url)),
        "utf8",
      ),
    );
  }

  return folder;
}

async function applyMigration(runtime: DatabaseRuntime, fileName: string) {
  const migrationUrl = new URL(`../drizzle/${fileName}`, import.meta.url);
  const migrationSql = await readFile(fileURLToPath(migrationUrl), "utf8");
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await runtime.db.execute(sql.raw(statement));
  }
}

describe("database migrations", () => {
  let runtime: DatabaseRuntime | undefined;
  let tempDir: string | undefined;
  let partialMigrationsDir: string | undefined;

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
    if (partialMigrationsDir) {
      await rm(partialMigrationsDir, { recursive: true, force: true });
      partialMigrationsDir = undefined;
    }
  });

  it("collapses duplicate normalized legacy product labels during meal-planning migration", async () => {
    runtime = await createDatabaseRuntime("memory:");

    for (const fileName of migrationFiles.slice(0, 8)) {
      await applyMigration(runtime, fileName);
    }

    const userId = "11111111-1111-4111-8111-111111111111";
    const recipeId = "22222222-2222-4222-8222-222222222222";

    await runtime.db.execute(sql.raw(`
      INSERT INTO "users" ("id", "shoo_pairwise_sub", "email", "display_name")
      VALUES ('${userId}', 'duplicate_legacy_user', 'duplicate@example.com', 'Duplicate User')
    `));
    await runtime.db.execute(sql.raw(`
      INSERT INTO "meal_entries" (
        "id",
        "user_id",
        "entry_date",
        "label",
        "sort_order",
        "protein_g",
        "carbs_g",
        "fat_g",
        "calories_kcal"
      )
      VALUES
        ('33333333-3333-4333-8333-333333333333', '${userId}', '2026-06-01', 'Oats', 0, 5.0, 27.0, 3.0, 150),
        ('44444444-4444-4444-8444-444444444444', '${userId}', '2026-06-02', ' oats ', 0, 5.0, 27.0, 3.0, 150)
    `));
    await runtime.db.execute(sql.raw(`
      INSERT INTO "recipes" ("id", "user_id", "label", "portions")
      VALUES ('${recipeId}', '${userId}', 'Duplicate Ingredient Recipe', 1)
    `));
    await runtime.db.execute(sql.raw(`
      INSERT INTO "recipe_ingredients" (
        "id",
        "recipe_id",
        "sort_order",
        "label",
        "protein_g",
        "carbs_g",
        "fat_g",
        "calories_kcal"
      )
      VALUES
        ('55555555-5555-4555-8555-555555555555', '${recipeId}', 0, 'Rice', 4.0, 40.0, 1.0, 185),
        ('66666666-6666-4666-8666-666666666666', '${recipeId}', 1, ' rice ', 4.0, 40.0, 1.0, 185)
    `));

    await applyMigration(runtime, "0008_product_model_meal_planning.sql");

    const productResult = await runtime.db.execute<{
      id: string;
      name: string;
    }>(sql.raw(`
      SELECT "id", "name"
      FROM "food_products"
      WHERE "owner_user_id" = '${userId}'
    `));
    const products = productResult.rows;
    expect(products).toHaveLength(2);
    expect(products.map((product) => product.name.toLowerCase()).sort()).toEqual([
      "oats",
      "rice",
    ]);

    const migratedIngredientResult = await runtime.db.execute<{
      product_id: string | null;
    }>(sql.raw(`
      SELECT "product_id"
      FROM "recipe_ingredients"
    `));
    const migratedIngredients = migratedIngredientResult.rows;
    const ingredientProductIds = new Set(
      migratedIngredients.map((ingredient) => ingredient.product_id),
    );
    expect(ingredientProductIds.size).toBe(1);
    expect([...ingredientProductIds][0]).toBeTruthy();
  }, 30_000);

  it("syncs existing barcode products into global food products", async () => {
    runtime = await createDatabaseRuntime("memory:");

    for (const fileName of migrationFiles.slice(0, 9)) {
      await applyMigration(runtime, fileName);
    }

    await runtime.db.execute(sql.raw(`
      INSERT INTO "barcode_products" (
        "id",
        "barcode",
        "name",
        "brands",
        "protein_g",
        "carbs_g",
        "fat_g",
        "calories_kcal",
        "serving_size_g"
      )
      VALUES (
        '77777777-7777-4777-8777-777777777777',
        '8712345000001',
        'Community Protein Drink',
        'Macro Lab',
        20.0,
        8.0,
        2.0,
        130,
        250.0
      )
    `));

    await applyMigration(runtime, "0009_sync_barcode_food_products.sql");

    const productResult = await runtime.db.execute<{
      owner_user_id: string | null;
      scope: string;
      source: string;
      barcode: string;
      name: string;
      brand: string;
      calories_per_100: number;
    }>(sql.raw(`
      SELECT
        "owner_user_id",
        "scope",
        "source",
        "barcode",
        "name",
        "brand",
        "calories_per_100"
      FROM "food_products"
      WHERE "barcode" = '8712345000001'
    `));
    const products = productResult.rows;

    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      owner_user_id: null,
      scope: "global",
      source: "barcode",
      barcode: "8712345000001",
      name: "Community Protein Drink",
      brand: "Macro Lab",
      calories_per_100: 130,
    });
  });

  it("remaps legacy barcode audit events to migrated food products", async () => {
    runtime = await createDatabaseRuntime("memory:");

    for (const fileName of migrationFiles.slice(0, 9)) {
      await applyMigration(runtime, fileName);
    }

    const adminId = "11111111-1111-4111-8111-111111111111";
    const barcodeProductId = "77777777-7777-4777-8777-777777777777";
    const auditId = "88888888-8888-4888-8888-888888888888";

    await runtime.db.execute(sql.raw(`
      INSERT INTO "users" ("id", "shoo_pairwise_sub", "email", "display_name", "role")
      VALUES ('${adminId}', 'audit_admin', 'admin@example.com', 'Admin', 'admin')
    `));
    await runtime.db.execute(sql.raw(`
      INSERT INTO "barcode_products" (
        "id",
        "barcode",
        "name",
        "brands",
        "protein_g",
        "carbs_g",
        "fat_g",
        "calories_kcal",
        "serving_size_g",
        "added_by_user_id"
      )
      VALUES (
        '${barcodeProductId}',
        '8712345000099',
        'Audited Protein Drink',
        'Macro Lab',
        20.0,
        8.0,
        2.0,
        130,
        250.0,
        '${adminId}'
      )
    `));
    await runtime.db.execute(sql.raw(`
      INSERT INTO "admin_audit_events" (
        "id",
        "actor_user_id",
        "actor_role",
        "action",
        "target_type",
        "target_id",
        "details_json"
      )
      VALUES (
        '${auditId}',
        '${adminId}',
        'admin',
        'barcode.updated',
        'barcode_product',
        '${barcodeProductId}',
        '{"name":"Audited Protein Drink"}'::jsonb
      )
    `));

    await applyMigration(runtime, "0009_sync_barcode_food_products.sql");
    await applyMigration(runtime, "0010_templates_food_product_cleanup.sql");

    const productResult = await runtime.db.execute<{
      id: string;
    }>(sql.raw(`
      SELECT "id"
      FROM "food_products"
      WHERE "barcode" = '8712345000099'
    `));
    const productId = productResult.rows[0]?.id;
    expect(productId).toBeTruthy();

    const auditResult = await runtime.db.execute<{
      target_type: string;
      target_id: string;
      legacy_id: string;
    }>(sql.raw(`
      SELECT
        "target_type",
        "target_id",
        "details_json"->>'legacyBarcodeProductId' AS legacy_id
      FROM "admin_audit_events"
      WHERE "id" = '${auditId}'
    `));

    expect(auditResult.rows[0]).toEqual({
      target_type: "food_product",
      target_id: productId,
      legacy_id: barcodeProductId,
    });
  });

  it("deduplicates active global barcode products before the unique index migration", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "macro-tracker-bootstrap-"));
    const connectionString = `file:${tempDir}`;
    partialMigrationsDir = await createPartialMigrationsFolder(11);
    runtime = await createDatabaseRuntime(connectionString);

    // Migrate through 0010 with the real migrator so the follow-up run resumes
    // from recorded state, exercising the same path production upgrades take.
    await migrateDatabase(runtime, partialMigrationsDir);

    await runtime.db.execute(sql.raw(`
      INSERT INTO "food_products" (
        "id",
        "owner_user_id",
        "scope",
        "source",
        "barcode",
        "name",
        "brand",
        "default_serving_quantity",
        "default_serving_unit",
        "protein_per_100",
        "carbs_per_100",
        "fat_per_100",
        "calories_per_100",
        "serving_weight_g",
        "source_metadata",
        "created_at",
        "updated_at"
      )
      VALUES
        (
          '99999999-9999-4999-8999-999999999991',
          NULL,
          'global',
          'barcode',
          '8712345000777',
          'Older Duplicate Drink',
          'Macro Lab',
          '1.00',
          'serving',
          '20.00',
          '8.00',
          '2.00',
          130,
          '250.00',
          '{}'::jsonb,
          '2026-06-01T10:00:00Z',
          '2026-06-01T10:00:00Z'
        ),
        (
          '99999999-9999-4999-8999-999999999992',
          NULL,
          'global',
          'barcode',
          '8712345000777',
          'Newer Duplicate Drink',
          'Macro Lab',
          '1.00',
          'serving',
          '21.00',
          '9.00',
          '3.00',
          140,
          '250.00',
          '{}'::jsonb,
          '2026-06-02T10:00:00Z',
          '2026-06-02T10:00:00Z'
        )
    `));

    // 0011 adds the active-global-barcode unique index, so it must dedupe the
    // rows above before the index can be created.
    await migrateDatabase(runtime);

    const productResult = await runtime.db.execute<{
      id: string;
      deleted_at: Date | string | null;
      dedupe_marker: string | null;
    }>(sql.raw(`
      SELECT
        "id",
        "deleted_at",
        "source_metadata"->>'deduplicatedByMigration' AS "dedupe_marker"
      FROM "food_products"
      WHERE "barcode" = '8712345000777'
      ORDER BY "id"
    `));

    expect(productResult.rows).toHaveLength(2);
    expect(productResult.rows).toEqual([
      {
        id: "99999999-9999-4999-8999-999999999991",
        deleted_at: expect.anything(),
        dedupe_marker: "0011_active_global_barcode_unique",
      },
      {
        id: "99999999-9999-4999-8999-999999999992",
        deleted_at: null,
        dedupe_marker: null,
      },
    ]);
  });

  it("merges duplicate default meal groups without losing entry assignments", async () => {
    runtime = await createDatabaseRuntime("memory:");

    for (const fileName of migrationFiles.slice(
      0,
      DEDUPLICATE_DEFAULT_MEAL_GROUPS_INDEX,
    )) {
      await applyMigration(runtime, fileName);
    }

    const userId = "81111111-1111-4111-8111-111111111111";
    const olderGroupId = "82222222-2222-4222-8222-222222222222";
    const referencedGroupId = "83333333-3333-4333-8333-333333333333";
    const customGroupId = "84444444-4444-4444-8444-444444444444";
    const duplicateEntryId = "85555555-5555-4555-8555-555555555551";
    const firstKeeperEntryId = "85555555-5555-4555-8555-555555555552";
    const secondKeeperEntryId = "85555555-5555-4555-8555-555555555553";

    await runtime.db.execute(sql.raw(`
      INSERT INTO "users" ("id", "shoo_pairwise_sub", "email")
      VALUES ('${userId}', 'duplicate_group_user', 'duplicate-groups@example.com')
    `));
    await runtime.db.execute(sql.raw(`
      INSERT INTO "meal_groups" (
        "id", "user_id", "label", "sort_order", "is_default", "created_at", "updated_at"
      )
      VALUES
        ('${olderGroupId}', '${userId}', 'Breakfast', 0, true, '2026-07-20T10:00:00Z', '2026-07-20T10:00:00Z'),
        ('${referencedGroupId}', '${userId}', 'Breakfast', 0, true, '2026-07-21T10:00:00Z', '2026-07-21T10:00:00Z'),
        ('${customGroupId}', '${userId}', 'Breakfast', 4, false, '2026-07-21T11:00:00Z', '2026-07-21T11:00:00Z')
    `));
    await runtime.db.execute(sql.raw(`
      INSERT INTO "meal_entries" (
        "id", "user_id", "entry_date", "meal_group_id", "label", "sort_order",
        "protein_g", "carbs_g", "fat_g", "calories_kcal"
      )
      VALUES
        ('${duplicateEntryId}', '${userId}', '2026-07-22', '${olderGroupId}', 'Oats', 0, 10, 20, 5, 165),
        ('${firstKeeperEntryId}', '${userId}', '2026-07-22', '${referencedGroupId}', 'Yogurt', 1, 20, 15, 0, 140),
        ('${secondKeeperEntryId}', '${userId}', '2026-07-22', '${referencedGroupId}', 'Fruit', 2, 1, 25, 0, 104)
    `));

    await applyMigration(runtime, "0013_deduplicate_default_meal_groups.sql");

    const groupResult = await runtime.db.execute<{
      id: string;
      is_default: boolean;
      deleted_at: Date | string | null;
    }>(sql.raw(`
      SELECT "id", "is_default", "deleted_at"
      FROM "meal_groups"
      WHERE "user_id" = '${userId}' AND "label" = 'Breakfast'
      ORDER BY "id"
    `));
    expect(groupResult.rows).toEqual([
      { id: olderGroupId, is_default: true, deleted_at: expect.anything() },
      { id: referencedGroupId, is_default: true, deleted_at: null },
      { id: customGroupId, is_default: false, deleted_at: null },
    ]);

    const entryResult = await runtime.db.execute<{ meal_group_id: string }>(sql.raw(`
      SELECT "meal_group_id"
      FROM "meal_entries"
      WHERE "id" IN ('${duplicateEntryId}', '${firstKeeperEntryId}', '${secondKeeperEntryId}')
      ORDER BY "id"
    `));
    expect(entryResult.rows).toEqual([
      { meal_group_id: referencedGroupId },
      { meal_group_id: referencedGroupId },
      { meal_group_id: referencedGroupId },
    ]);

    await runtime.db.execute(sql.raw(`
      INSERT INTO "meal_groups" ("id", "user_id", "label", "sort_order", "is_default")
      VALUES ('86666666-6666-4666-8666-666666666666', '${userId}', 'Breakfast', 5, true)
    `));
    const activeDefaultGroups = await runtime.db.execute<{ id: string }>(sql.raw(`
      SELECT "id"
      FROM "meal_groups"
      WHERE "user_id" = '${userId}'
        AND "label" = 'Breakfast'
        AND "deleted_at" IS NULL
        AND "is_default" = true
    `));
    expect(activeDefaultGroups.rows).toEqual([{ id: referencedGroupId }]);
  });

  it("creates API token storage with a unique token hash index", async () => {
    runtime = await createDatabaseRuntime("memory:");

    for (const fileName of migrationFiles) {
      await applyMigration(runtime, fileName);
    }

    const tableResult = await runtime.db.execute<{ table_name: string }>(sql.raw(`
      SELECT "table_name"
      FROM information_schema.tables
      WHERE "table_schema" = 'public' AND "table_name" = 'api_tokens'
    `));
    expect(tableResult.rows).toEqual([{ table_name: "api_tokens" }]);

    const indexResult = await runtime.db.execute<{ indexname: string }>(sql.raw(`
      SELECT "indexname"
      FROM pg_indexes
      WHERE "schemaname" = 'public'
        AND "tablename" = 'api_tokens'
        AND "indexname" = 'api_tokens_token_hash_key'
    `));
    expect(indexResult.rows).toEqual([{ indexname: "api_tokens_token_hash_key" }]);
  });

  it("nulls out admin_audit_events.actor_user_id on actor deletion instead of blocking it (DB-05)", async () => {
    runtime = await createDatabaseRuntime("memory:");

    for (const fileName of migrationFiles) {
      await applyMigration(runtime, fileName);
    }

    const actorId = "b1111111-1111-4111-8111-111111111111";
    const auditId = "b2222222-2222-4222-8222-222222222222";

    await runtime.db.execute(sql.raw(`
      INSERT INTO "users" ("id", "shoo_pairwise_sub", "email")
      VALUES ('${actorId}', 'db05_actor', 'db05-actor@example.com')
    `));
    await runtime.db.execute(sql.raw(`
      INSERT INTO "admin_audit_events" (
        "id", "actor_user_id", "actor_role", "action", "target_type", "target_id"
      )
      VALUES ('${auditId}', '${actorId}', 'admin', 'user.role_changed', 'user', '${actorId}')
    `));

    await runtime.db.execute(sql.raw(`DELETE FROM "users" WHERE "id" = '${actorId}'`));

    const auditRow = await runtime.db.execute<{ actor_user_id: string | null }>(sql.raw(`
      SELECT "actor_user_id" FROM "admin_audit_events" WHERE "id" = '${auditId}'
    `));
    expect(auditRow.rows).toEqual([{ actor_user_id: null }]);
  });

  it("enforces the enum CHECK constraints for new writes without invalidating pre-existing rows (DB-09)", async () => {
    runtime = await createDatabaseRuntime("memory:");

    // Apply everything up to (not including) 0016 so an out-of-union row can
    // be seeded exactly the way it could already exist in a production
    // database the CHECK constraint migration runs against.
    for (const fileName of migrationFiles.slice(0, -1)) {
      await applyMigration(runtime, fileName);
    }

    const userId = "b3333333-3333-4333-8333-333333333333";
    const legacyTemplateId = "b4444444-4444-4444-8444-444444444444";

    await runtime.db.execute(sql.raw(`
      INSERT INTO "users" ("id", "shoo_pairwise_sub", "email")
      VALUES ('${userId}', 'db09_user', 'db09-user@example.com')
    `));
    await runtime.db.execute(sql.raw(`
      INSERT INTO "meal_templates" ("id", "user_id", "type", "label")
      VALUES ('${legacyTemplateId}', '${userId}', 'not_a_real_type', 'Legacy template')
    `));

    // Migration 0016 must apply cleanly even though the row above violates
    // the constraint it adds -- that's the point of NOT VALID.
    await applyMigration(runtime, "0016_enum_check_constraints.sql");

    const legacyRow = await runtime.db.execute<{ type: string }>(sql.raw(`
      SELECT "type" FROM "meal_templates" WHERE "id" = '${legacyTemplateId}'
    `));
    expect(legacyRow.rows).toEqual([{ type: "not_a_real_type" }]);

    await expect(
      runtime.db.execute(sql.raw(`
        INSERT INTO "meal_templates" ("id", "user_id", "type", "label")
        VALUES ('b5555555-5555-4555-8555-555555555555', '${userId}', 'still_not_real', 'Rejected')
      `)),
    ).rejects.toThrow();

    await runtime.db.execute(sql.raw(`
      INSERT INTO "meal_templates" ("id", "user_id", "type", "label")
      VALUES ('b6666666-6666-4666-8666-666666666666', '${userId}', 'day', 'Accepted')
    `));
    const acceptedRow = await runtime.db.execute<{ type: string }>(sql.raw(`
      SELECT "type" FROM "meal_templates" WHERE "id" = 'b6666666-6666-4666-8666-666666666666'
    `));
    expect(acceptedRow.rows).toEqual([{ type: "day" }]);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("PostgreSQL migration regressions", () => {
  it("accepts the previous backend default-group insert after migration 0013", async () => {
    const databaseUrl = resolveDestructiveTestDatabaseUrl(process.env, {
      explicitEnvNames: ["TEST_DATABASE_URL"],
      purpose: "default meal-group rollout regression test",
    });
    if (!databaseUrl) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    const postgresRuntime = await createDatabaseRuntime(databaseUrl);
    try {
      await postgresRuntime.db.execute(
        sql.raw(
          "DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public",
        ),
      );

      for (const fileName of migrationFiles.slice(0, 8)) {
        await applyMigration(postgresRuntime, fileName);
      }

      const userId = "91111111-1111-4111-8111-111111111111";
      const entryId = "92222222-2222-4222-8222-222222222222";
      const previousBackendGroupId = "34689180-08f1-5561-b87e-4e1d6d004914";

      await postgresRuntime.db.execute(sql.raw(`
        INSERT INTO "users" ("id", "shoo_pairwise_sub", "email")
        VALUES ('${userId}', 'rollout_compat_user', 'rollout-compat@example.com')
      `));

      for (const fileName of migrationFiles.slice(
        8,
        DEDUPLICATE_DEFAULT_MEAL_GROUPS_INDEX,
      )) {
        await applyMigration(postgresRuntime, fileName);
      }

      const historicalGroup = await postgresRuntime.db.execute<{ id: string }>(sql.raw(`
        SELECT "id"
        FROM "meal_groups"
        WHERE "user_id" = '${userId}' AND "label" = 'Breakfast'
      `));
      expect(historicalGroup.rows).toHaveLength(1);
      const historicalGroupId = historicalGroup.rows[0]?.id;
      expect(historicalGroupId).toBeTruthy();
      expect(historicalGroupId).not.toBe(previousBackendGroupId);

      await postgresRuntime.db.execute(sql.raw(`
        INSERT INTO "meal_entries" (
          "id", "user_id", "entry_date", "meal_group_id", "label", "sort_order",
          "protein_g", "carbs_g", "fat_g", "calories_kcal"
        )
        VALUES (
          '${entryId}', '${userId}', '2026-07-23', '${historicalGroupId}', 'Oats', 0,
          10, 20, 5, 165
        )
      `));

      await applyMigration(postgresRuntime, "0013_deduplicate_default_meal_groups.sql");

      const insertResult = await postgresRuntime.migrationPool?.query(
        `
        INSERT INTO meal_groups (id, user_id, label, sort_order, is_default)
        VALUES ($1, $2, $3, $4, true)
        ON CONFLICT (id) DO NOTHING
        `,
        [previousBackendGroupId, userId, "Breakfast", 0],
      );
      expect(insertResult?.rowCount).toBe(0);

      const activeGroups = await postgresRuntime.db.execute<{ id: string }>(sql.raw(`
        SELECT "id"
        FROM "meal_groups"
        WHERE "user_id" = '${userId}'
          AND "label" = 'Breakfast'
          AND "deleted_at" IS NULL
          AND "is_default" = true
      `));
      expect(activeGroups.rows).toEqual([{ id: historicalGroupId }]);

      const entryAssignment = await postgresRuntime.db.execute<{ meal_group_id: string }>(
        sql.raw(`SELECT "meal_group_id" FROM "meal_entries" WHERE "id" = '${entryId}'`),
      );
      expect(entryAssignment.rows).toEqual([{ meal_group_id: historicalGroupId }]);
    } finally {
      await postgresRuntime.close();
    }
  });

  it("keeps food search working when the migration role cannot install pg_trgm", async () => {
    const databaseUrl = resolveDestructiveTestDatabaseUrl(process.env, {
      explicitEnvNames: ["TEST_DATABASE_URL"],
      purpose: "restricted-role trigram migration regression test",
    });
    if (!databaseUrl) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    const roleName = "macro_tracker_no_trgm_migrator";
    const postgresRuntime = await createDatabaseRuntime(databaseUrl);
    const migrationPool = postgresRuntime.migrationPool;
    if (!migrationPool) {
      await postgresRuntime.close();
      throw new Error("PostgreSQL migration pool is required");
    }

    try {
      await migrationPool.query(
        "DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP EXTENSION IF EXISTS pg_trgm; CREATE SCHEMA public",
      );
      // Everything except 0014 (applied below, manually, under the
      // restricted role) and everything after it, which was added later and
      // is irrelevant to this trigram-specific regression.
      const trigramMigrationIndex = migrationFiles.indexOf(
        "0014_food_product_search_trigram.sql",
      );
      for (const fileName of migrationFiles.slice(0, trigramMigrationIndex)) {
        await applyMigration(postgresRuntime, fileName);
      }

      await migrationPool.query(`DROP ROLE IF EXISTS "${roleName}"`);
      await migrationPool.query(`CREATE ROLE "${roleName}" NOLOGIN`);
      await migrationPool.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);

      const restrictedClient = await migrationPool.connect();
      try {
        const migrationSql = await readFile(
          fileURLToPath(
            new URL("../drizzle/0014_food_product_search_trigram.sql", import.meta.url),
          ),
          "utf8",
        );
        await restrictedClient.query(`SET ROLE "${roleName}"`);
        await restrictedClient.query(migrationSql);
      } finally {
        await restrictedClient.query("RESET ROLE").catch(() => undefined);
        restrictedClient.release();
      }

      const trigramIndexes = await migrationPool.query<{ indexname: string }>(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'food_products_name_trgm_idx',
            'food_products_brand_trgm_idx',
            'food_products_barcode_trgm_idx'
          )
      `);
      expect(trigramIndexes.rows).toEqual([]);

      await migrationPool.query(`
        INSERT INTO food_products (
          id,
          owner_user_id,
          scope,
          source,
          barcode,
          name,
          brand,
          default_serving_quantity,
          default_serving_unit,
          protein_per_100,
          carbs_per_100,
          fat_per_100,
          calories_per_100
        )
        VALUES
          (
            'a1111111-1111-4111-8111-111111111111',
            NULL,
            'global',
            'manual',
            '8712345000101',
            'Plain Greek Yogurt',
            'Macro House',
            100,
            'g',
            10,
            4,
            0,
            56
          ),
          (
            'a2222222-2222-4222-8222-222222222222',
            NULL,
            'global',
            'manual',
            '8712345000102',
            'Apple',
            'Orchard',
            100,
            'g',
            0,
            14,
            0,
            52
          )
      `);
      const searchResult = await migrationPool.query<{ name: string }>(`
        SELECT name
        FROM food_products
        WHERE deleted_at IS NULL
          AND (
            name ILIKE '%greek%'
            OR brand ILIKE '%greek%'
            OR barcode ILIKE '%greek%'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(ARRAY['%greek%', '%macro%']::text[]) AS patterns(pattern)
            WHERE NOT coalesce(
              name ILIKE pattern
              OR brand ILIKE pattern
              OR barcode ILIKE pattern,
              false
            )
          )
        ORDER BY name
      `);
      expect(searchResult.rows).toEqual([{ name: "Plain Greek Yogurt" }]);
    } finally {
      await migrationPool.query(`DROP ROLE IF EXISTS "${roleName}"`).catch(() => undefined);
      await migrationPool.query(
        "DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP EXTENSION IF EXISTS pg_trgm; CREATE SCHEMA public",
      );
      await migrateDatabase(postgresRuntime);
      await postgresRuntime.close();
    }
  });

  it("serializes concurrent migration runners", async () => {
    const databaseUrl = resolveDestructiveTestDatabaseUrl(process.env, {
      explicitEnvNames: ["TEST_DATABASE_URL"],
      purpose: "concurrent migration regression test",
    });
    if (!databaseUrl) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    const migrationsFolder = await mkdtemp(join(tmpdir(), "macro-tracker-migrations-"));
    const setupRuntime = await createDatabaseRuntime(databaseUrl);
    try {
      await setupRuntime.db.execute(
        sql.raw(
          "DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public",
        ),
      );
      await mkdir(join(migrationsFolder, "meta"));
      await writeFile(
        join(migrationsFolder, "meta", "_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          entries: [
            {
              idx: 0,
              version: "7",
              when: 1_800_000_000_000,
              tag: "0000_concurrent_probe",
              breakpoints: true,
            },
          ],
        }),
      );
      await writeFile(
        join(migrationsFolder, "0000_concurrent_probe.sql"),
        [
          "CREATE TABLE migration_concurrency_probe (applications integer NOT NULL)",
          "INSERT INTO migration_concurrency_probe VALUES (0)",
          "SELECT pg_sleep(0.5)",
          "UPDATE migration_concurrency_probe SET applications = applications + 1",
        ].join("--> statement-breakpoint\n"),
      );

      const runtimes = await Promise.all([
        createDatabaseRuntime(databaseUrl),
        createDatabaseRuntime(databaseUrl),
      ]);
      try {
        await Promise.all(
          runtimes.map((migrationRuntime) =>
            migrateDatabase(migrationRuntime, migrationsFolder),
          ),
        );
      } finally {
        await Promise.all(runtimes.map((migrationRuntime) => migrationRuntime.close()));
      }

      const probe = await setupRuntime.db.execute<{ applications: number }>(
        sql.raw("SELECT applications FROM migration_concurrency_probe"),
      );
      expect(probe.rows).toEqual([{ applications: 1 }]);

      const journal = await setupRuntime.db.execute<{ count: string }>(
        sql.raw('SELECT count(*)::text AS count FROM drizzle."__drizzle_migrations"'),
      );
      expect(journal.rows).toEqual([{ count: "1" }]);
    } finally {
      await setupRuntime.db.execute(
        sql.raw(
          "DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public",
        ),
      );
      await migrateDatabase(setupRuntime);
      await setupRuntime.close();
      await rm(migrationsFolder, { recursive: true, force: true });
    }
  });

  it("sets lock_timeout and statement_timeout on the migration connection before migrating (DB-02)", async () => {
    const databaseUrl = resolveDestructiveTestDatabaseUrl(process.env, {
      explicitEnvNames: ["TEST_DATABASE_URL"],
      purpose: "migration connection timeout regression test",
    });
    if (!databaseUrl) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    const previousPoolMax = process.env.POSTGRES_POOL_MAX;
    // Force a single physical connection so the connection the migration ran
    // on is the same one we inspect afterwards.
    process.env.POSTGRES_POOL_MAX = "1";

    const postgresRuntime = await createDatabaseRuntime(databaseUrl);
    try {
      await postgresRuntime.db.execute(
        sql.raw(
          "DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public",
        ),
      );

      await migrateDatabase(postgresRuntime);

      // The pool has exactly one physical connection (POSTGRES_POOL_MAX=1),
      // and `SET` (not `SET LOCAL`) persists for the life of the session, so
      // this reconnect observes the settings the migration itself ran with.
      const lockTimeoutResult = await postgresRuntime.migrationPool?.query<{
        lock_timeout: string;
      }>("SHOW lock_timeout");
      const statementTimeoutResult = await postgresRuntime.migrationPool?.query<{
        statement_timeout: string;
      }>("SHOW statement_timeout");

      expect(lockTimeoutResult?.rows[0]?.lock_timeout).toBe("3s");
      expect(statementTimeoutResult?.rows[0]?.statement_timeout).toBe("5min");
    } finally {
      await postgresRuntime.db.execute(
        sql.raw(
          "DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public",
        ),
      );
      await migrateDatabase(postgresRuntime);
      await postgresRuntime.close();
      if (previousPoolMax === undefined) {
        delete process.env.POSTGRES_POOL_MAX;
      } else {
        process.env.POSTGRES_POOL_MAX = previousPoolMax;
      }
    }
  });

  it("gives up acquiring the migration advisory lock after a bounded timeout instead of hanging forever (DB-07)", async () => {
    const databaseUrl = resolveDestructiveTestDatabaseUrl(process.env, {
      explicitEnvNames: ["TEST_DATABASE_URL"],
      purpose: "migration advisory lock timeout regression test",
    });
    if (!databaseUrl) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    const previousAcquireTimeout = process.env.MIGRATION_LOCK_ACQUIRE_TIMEOUT_MS;
    process.env.MIGRATION_LOCK_ACQUIRE_TIMEOUT_MS = "1500";

    const lockHolderRuntime = await createDatabaseRuntime(databaseUrl);
    const contendingRuntime = await createDatabaseRuntime(databaseUrl);
    try {
      const holderClient = await lockHolderRuntime.migrationPool?.connect();
      if (!holderClient) {
        throw new Error("Expected a migration pool connection");
      }
      // Simulate a hung previous migration: it holds the advisory lock and
      // never releases it.
      await holderClient.query("SELECT pg_advisory_lock(1836027411)");

      try {
        const start = Date.now();
        await expect(migrateDatabase(contendingRuntime)).rejects.toThrow(
          /Timed out after 1500ms waiting for the database migration advisory lock/,
        );
        // Bounded: must not have hung anywhere near "forever". Generous
        // upper bound to absorb CI scheduling jitter around the 1s retry
        // interval.
        expect(Date.now() - start).toBeLessThan(10_000);
      } finally {
        await holderClient.query("SELECT pg_advisory_unlock(1836027411)");
        holderClient.release();
      }
    } finally {
      await contendingRuntime.close();
      await lockHolderRuntime.close();
      if (previousAcquireTimeout === undefined) {
        delete process.env.MIGRATION_LOCK_ACQUIRE_TIMEOUT_MS;
      } else {
        process.env.MIGRATION_LOCK_ACQUIRE_TIMEOUT_MS = previousAcquireTimeout;
      }
    }
  });
});

describe("test database safety", () => {
  it("refuses a remote test-named database without ALLOW_DESTRUCTIVE_REMOTE_DB (DB-08)", () => {
    expect(() =>
      resolveDestructiveTestDatabaseUrl(
        {
          TEST_DATABASE_URL:
            "postgres://user:pass@shared-staging.example.com:5432/app_test",
        },
        {
          explicitEnvNames: ["TEST_DATABASE_URL"],
          purpose: "database unit tests",
        },
      ),
    ).toThrow(/its host is not local/);
  });

  it("accepts a remote test-named database once ALLOW_DESTRUCTIVE_REMOTE_DB=true is set (DB-08)", () => {
    const remoteUrl = "postgres://user:pass@shared-staging.example.com:5432/app_test";

    expect(
      resolveDestructiveTestDatabaseUrl(
        {
          TEST_DATABASE_URL: remoteUrl,
          ALLOW_DESTRUCTIVE_REMOTE_DB: "true",
        },
        {
          explicitEnvNames: ["TEST_DATABASE_URL"],
          purpose: "database unit tests",
        },
      ),
    ).toBe(remoteUrl);
  });

  it("still refuses a remote non-test-named database even with ALLOW_DESTRUCTIVE_REMOTE_DB=true", () => {
    expect(() =>
      resolveDestructiveTestDatabaseUrl(
        {
          TEST_DATABASE_URL: "postgres://user:pass@shared-staging.example.com:5432/production",
          ALLOW_DESTRUCTIVE_REMOTE_DB: "true",
        },
        {
          explicitEnvNames: ["TEST_DATABASE_URL"],
          purpose: "database unit tests",
        },
      ),
    ).toThrow(/its host is not local/);
  });

  it("keeps working for the loopback TEST_DATABASE_URL this suite itself runs against", () => {
    const loopbackUrl = "postgres://postgres:postgres@127.0.0.1:55432/macro_tracker_db_test";

    expect(
      resolveDestructiveTestDatabaseUrl(
        { TEST_DATABASE_URL: loopbackUrl },
        {
          explicitEnvNames: ["TEST_DATABASE_URL"],
          purpose: "database unit tests",
        },
      ),
    ).toBe(loopbackUrl);
  });

  it("refuses to truncate a plain non-test DATABASE_URL", () => {
    expect(() =>
      resolveDestructiveTestDatabaseUrl(
        {
          DATABASE_URL:
            "postgres://macro:secret@db.internal.example.com:5432/macro_tracker",
        },
        {
          explicitEnvNames: ["TEST_DATABASE_URL"],
          purpose: "database unit tests",
        },
      ),
    ).toThrow(/Refusing to truncate plain DATABASE_URL/);
  });

  it("refuses to truncate an explicit local non-test TEST_DATABASE_URL by default", () => {
    expect(() =>
      resolveDestructiveTestDatabaseUrl(
        {
          TEST_DATABASE_URL: "postgres://postgres:***@localhost:5432/macro_tracker",
        },
        {
          explicitEnvNames: ["TEST_DATABASE_URL"],
          purpose: "database unit tests",
        },
      ),
    ).toThrow(/does not look like a test database/);
  });

  it("accepts explicit CI-style test and e2e database URLs", () => {
    const ciDatabaseUrl =
      "postgres://postgres:postgres@127.0.0.1:5432/macro_tracker_ci";

    expect(
      resolveDestructiveTestDatabaseUrl(
        {
          DATABASE_URL:
            "postgres://macro:password@db.internal.example.com:5432/macro_tracker",
          TEST_DATABASE_URL: ciDatabaseUrl,
        },
        {
          explicitEnvNames: ["TEST_DATABASE_URL"],
          purpose: "database unit tests",
        },
      ),
    ).toBe(ciDatabaseUrl);

    expect(
      resolveDestructiveTestDatabaseUrl(
        {
          DATABASE_URL: ciDatabaseUrl,
          TEST_DATABASE_URL: ciDatabaseUrl,
          E2E_DATABASE_URL: ciDatabaseUrl,
        },
        {
          explicitEnvNames: ["E2E_DATABASE_URL", "TEST_DATABASE_URL"],
          purpose: "Playwright global setup",
        },
      ),
    ).toBe(ciDatabaseUrl);
  });
});

describe("migration tooling invariants", () => {
  const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const migrationsFolderPath = fileURLToPath(new URL("../drizzle", import.meta.url));
  const journalPath = fileURLToPath(
    new URL("../drizzle/meta/_journal.json", import.meta.url),
  );

  it("does not offer db:generate now that migrations 0005+ are hand-authored (DB-01)", () => {
    // `meta/` only has snapshots for 0000-0004 while the journal has many
    // more entries; `drizzle-kit generate` would diff schema.ts against that
    // stale 0004 baseline and emit a destructive migration. See MIGRATIONS.md.
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts ?? {}).not.toHaveProperty("db:generate");
    expect(existsSync(fileURLToPath(new URL("../MIGRATIONS.md", import.meta.url)))).toBe(
      true,
    );
  });

  it("keeps the snapshot/journal divergence documented so it cannot silently return", () => {
    const migrationsGuide = readFileSync(
      fileURLToPath(new URL("../MIGRATIONS.md", import.meta.url)),
      "utf8",
    );

    expect(migrationsGuide).toMatch(/hand-authored/i);
    expect(migrationsGuide.toLowerCase()).toContain("db:generate");
  });

  it("has strictly increasing journal `when` values (DB-03)", () => {
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { idx: number; when: number; tag: string }[];
    };

    expect(journal.entries.length).toBeGreaterThan(0);

    for (let index = 1; index < journal.entries.length; index++) {
      const previous = journal.entries[index - 1]!;
      const current = journal.entries[index]!;

      expect(
        current.when,
        `journal entry "${current.tag}" (when=${current.when}) must be strictly ` +
          `greater than the previous entry "${previous.tag}" (when=${previous.when}); ` +
          "drizzle selects pending migrations by comparing `when`, not by hash, so a " +
          "non-increasing value is a silent permanent no-op.",
      ).toBeGreaterThan(previous.when);
    }
  });

  it("has a migration SQL file and matching journal tag for every journal entry", async () => {
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };

    for (const entry of journal.entries) {
      const sqlPath = join(migrationsFolderPath, `${entry.tag}.sql`);
      expect(existsSync(sqlPath), `missing migration file for journal tag "${entry.tag}"`).toBe(
        true,
      );
    }
  });
});
